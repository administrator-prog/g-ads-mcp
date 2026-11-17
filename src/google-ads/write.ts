import type { MutateOperation } from "google-ads-api";

import { normalizeCustomerId, type Config } from "../config.js";
import { logger } from "../logger.js";
import { GoogleAdsClient, GoogleAdsToolError, assertCustomerId, enums, toToolError } from "./client.js";
import { fromMicros, num, str } from "./format.js";

/**
 * Every write goes through here. The rules are enforced in code, not left to
 * the caller:
 *
 *  1. Allow-list. Only accounts in GOOGLE_ADS_WRITE_ACCOUNTS can be changed.
 *  2. Spend cap. Google can charge up to 30.4 x the daily budget in a month, so
 *     the cap is checked as (sum of the daily budgets of every ENABLED campaign)
 *     x 30.4. It is checked whenever a change could raise that figure: enabling
 *     a campaign, or raising an enabled campaign's budget. Paused campaigns
 *     cannot spend, so they are counted when they are switched on.
 *  3. New campaigns are always created PAUSED. Switching one on is a separate
 *     call that must pass confirm_spend: true.
 *  4. No removals, billing or user-access changes: no tool builds those
 *     operations.
 *  5. Validate first. Each change is sent with validate_only, and only applied
 *     if Google accepts it. dry_run stops after validation.
 *  6. Audit. Every applied change is logged (Railway logs) with the account,
 *     tool, summary and the resource names Google returned; Google's own change
 *     history is readable with get_change_history.
 */

export const MONTHLY_MULTIPLIER = 30.4;

export interface WriteTarget {
  customerId: string;
  monthlyCap: number;
}

export function writableAccount(config: Config, customerId: string): WriteTarget {
  const id = assertCustomerId(customerId);
  const entry = config.writeAccounts.get(id);
  if (!entry) {
    throw new GoogleAdsToolError(`Account ${id} is read-only on this server.`, [
      "Writes are limited to the accounts in GOOGLE_ADS_WRITE_ACCOUNTS (customerId:monthlyCap).",
    ]);
  }
  return { customerId: id, monthlyCap: entry.monthlyCap };
}

export interface CampaignBudgetRow {
  campaignId: string;
  name?: string;
  status?: string;
  budgetResource?: string;
  dailyBudget: number;
}

export async function campaignBudgets(client: GoogleAdsClient, customerId: string): Promise<{ currency?: string; rows: CampaignBudgetRow[] }> {
  const rows = await client.query(
    customerId,
    "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros, customer.currency_code " +
      "FROM campaign WHERE campaign.status != 'REMOVED'",
  );
  let currency: string | undefined;
  const out = rows.map((row) => {
    const c = (row.campaign ?? {}) as Record<string, unknown>;
    const b = (row.campaign_budget ?? {}) as Record<string, unknown>;
    currency ??= str(((row.customer ?? {}) as Record<string, unknown>).currency_code);
    return {
      campaignId: String(num(c.id) ?? c.id),
      name: str(c.name),
      status: statusName(c.status),
      budgetResource: str(b.resource_name),
      dailyBudget: fromMicros(b.amount_micros) ?? 0,
    };
  });
  return { currency, rows: out };
}

function statusName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const name = (enums.CampaignStatus as unknown as Record<number, string>)[value as number];
  return typeof name === "string" ? name : undefined;
}

/**
 * Projected monthly maximum once a change is made. `enable` adds campaigns to
 * the enabled set; `budgets` overrides daily budgets by campaign id. Shared
 * budgets are counted once.
 */
export async function assertWithinCap(
  client: GoogleAdsClient,
  target: WriteTarget,
  change: { enable?: string[]; budgets?: Record<string, number> },
): Promise<{ projectedMonthly: number; cap: number; currency?: string }> {
  const { currency, rows } = await campaignBudgets(client, target.customerId);
  const enabled = new Set(rows.filter((r) => r.status === "ENABLED").map((r) => r.campaignId));
  for (const id of change.enable ?? []) enabled.add(id);

  const perBudget = new Map<string, number>();
  for (const r of rows) {
    if (!enabled.has(r.campaignId)) continue;
    const daily = change.budgets?.[r.campaignId] ?? r.dailyBudget;
    perBudget.set(r.budgetResource ?? `campaign:${r.campaignId}`, daily);
  }
  const projectedMonthly = round2([...perBudget.values()].reduce((a, b) => a + b, 0) * MONTHLY_MULTIPLIER);
  if (projectedMonthly > target.monthlyCap + 1e-9) {
    throw new GoogleAdsToolError(
      `Refused: this would allow up to ${projectedMonthly} ${currency ?? ""} a month, over the ${target.monthlyCap} cap for account ${target.customerId}.`.replace("  ", " "),
      [
        `Enabled campaigns after the change: ${[...enabled].join(", ") || "none"}.`,
        `Google can charge up to ${MONTHLY_MULTIPLIER} x the daily budget in a month, so the daily total must stay at or below ${round2(target.monthlyCap / MONTHLY_MULTIPLIER)}.`,
        "Raising the cap needs a change to GOOGLE_ADS_WRITE_ACCOUNTS (and the client's written OK).",
      ],
    );
  }
  return { projectedMonthly, cap: target.monthlyCap, ...(currency ? { currency } : {}) };
}

/** A single budget on its own can never exceed the cap either. */
export function assertDailyFits(target: WriteTarget, daily: number): void {
  if (daily * MONTHLY_MULTIPLIER > target.monthlyCap + 1e-9) {
    throw new GoogleAdsToolError(
      `Refused: a daily budget of ${daily} allows up to ${round2(daily * MONTHLY_MULTIPLIER)} a month, over the ${target.monthlyCap} cap.`,
    );
  }
}

/**
 * Validates with Google, then applies unless dryRun. Returns the resource names
 * Google created or changed.
 */
export async function applyOperations<T>(
  client: GoogleAdsClient,
  target: WriteTarget,
  tool: string,
  summary: string,
  operations: MutateOperation<T>[],
  dryRun: boolean,
): Promise<{ applied: boolean; validated: true; resources: string[] }> {
  const customer = client.customer(target.customerId);
  try {
    await customer.mutateResources(operations, { validate_only: true });
  } catch (error) {
    logger.warn("Ads write failed validation", { customerId: target.customerId, tool, summary });
    throw toToolError(error);
  }
  if (dryRun) {
    logger.info("Ads write validated (dry run)", { customerId: target.customerId, tool, summary, operations: operations.length });
    return { applied: false, validated: true, resources: [] };
  }
  try {
    const response = await customer.mutateResources(operations);
    const resources = (response.mutate_operation_responses ?? [])
      .map((r) => {
        const inner = Object.values(r as Record<string, unknown>).find((v) => v && typeof v === "object") as
          | { resource_name?: string }
          | undefined;
        return inner?.resource_name;
      })
      .filter((x): x is string => Boolean(x));
    logger.info("Ads write applied", { customerId: target.customerId, tool, summary, resources });
    return { applied: true, validated: true, resources };
  } catch (error) {
    logger.error("Ads write failed", { customerId: target.customerId, tool, summary });
    throw toToolError(error);
  }
}

export const toMicros = (value: number) => Math.round(value * 1_000_000);
export const round2 = (n: number) => Math.round(n * 100) / 100;

export function campaignResource(customerId: string, campaignId: string): string {
  return `customers/${customerId}/campaigns/${digits(campaignId, "campaign_id")}`;
}
export function adGroupResource(customerId: string, adGroupId: string): string {
  return `customers/${customerId}/adGroups/${digits(adGroupId, "ad_group_id")}`;
}
/** Keyword and ad ids are composite: "<adGroupId>~<criterionId or adId>". */
export function compositeResource(customerId: string, kind: "adGroupCriteria" | "adGroupAds", id: string): string {
  const m = /^(\d+)~(\d+)$/.exec(id.trim());
  if (!m) throw new GoogleAdsToolError(`Invalid id "${id}". Expected "<adGroupId>~<id>", e.g. 1234567890~987654321.`);
  return `customers/${customerId}/${kind}/${m[1]}~${m[2]}`;
}
export function digits(value: string, field: string): string {
  const v = normalizeCustomerId(String(value));
  if (!v) throw new GoogleAdsToolError(`Invalid ${field} "${value}". Expected a numeric id.`);
  return v;
}
