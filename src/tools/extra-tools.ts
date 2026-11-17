import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MutateOperation } from "google-ads-api";
import { z } from "zod";

import type { Config } from "../config.js";
import { GoogleAdsToolError, enums } from "../google-ads/client.js";
import { applyOperations, campaignResource, writableAccount } from "../google-ads/write.js";
import { READ_ONLY_ANNOTATIONS, customerIdSchema, jsonResult, toolHandler } from "./shared.js";

/**
 * Tools added after the first launch build (17 Nov 2026):
 *
 *  - run_query: read-only GAQL for analysis the fixed reports do not cover.
 *    The Google Ads search endpoint cannot change anything, and only SELECT
 *    statements are accepted.
 *  - set_conversion_goal_biddable: the account-level goal switch. Google-hosted
 *    and YouTube conversion actions refuse a primary/secondary change on the
 *    action itself; their goal (category + origin) can be made non-biddable.
 *  - add_sitelinks / add_callouts / add_call_asset: campaign assets.
 *
 * All writes go through applyOperations (allow-list, validate first, audit).
 * None of them affect spend.
 */

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const dryRun = z.boolean().default(false).describe("true = only validate the change with Google; nothing is applied.");

type Op = MutateOperation<Record<string, unknown>>;
const op = (entity: string, operation: "create" | "update", resource: Record<string, unknown>): Op =>
  ({ entity: entity as Op["entity"], operation, resource }) as Op;

const enumValue = (e: Record<string, unknown>, name: string, field: string): number => {
  const v = e[name];
  if (typeof v !== "number") throw new GoogleAdsToolError(`Unknown ${field} "${name}".`);
  return v;
};

export function registerExtraTools(server: McpServer, config: Config): void {
  // --- run_query (read-only) ---------------------------------------------------
  server.registerTool(
    "run_query",
    {
      title: "Run a read-only GAQL query",
      description:
        "Runs a Google Ads Query Language SELECT against one account and returns the rows (max 1000). " +
        "Read-only: the search endpoint cannot change anything. Money fields are in micros (divide by 1,000,000).",
      inputSchema: { customer_id: customerIdSchema, query: z.string().min(10).max(5000) },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; query: string }>("run_query", config, async (client, a) => {
      const q = a.query.trim();
      if (!/^select\s/i.test(q)) throw new GoogleAdsToolError("Only SELECT queries are allowed.");
      const rows = await client.query(a.customer_id, /\blimit\s+\d+\s*$/i.test(q) ? q : `${q} LIMIT 1000`);
      return jsonResult({ customer_id: a.customer_id, count: rows.length, rows: rows.slice(0, 1000) });
    }),
  );

  // --- set_conversion_goal_biddable ----------------------------------------------
  server.registerTool(
    "set_conversion_goal_biddable",
    {
      title: "Make an account conversion goal biddable or not",
      description:
        "Sets biddable on an account-level conversion goal, identified by category + origin (e.g. GET_DIRECTIONS + " +
        "GOOGLE_HOSTED, ENGAGEMENT + YOUTUBE_HOSTED). Non-biddable goals stop counting in 'conversions'. Use this for " +
        "Google-hosted and YouTube actions whose own primary/secondary setting cannot be changed.",
      inputSchema: {
        customer_id: customerIdSchema,
        goals: z.array(z.object({ category: z.string().min(1), origin: z.string().min(1) })).min(1).max(30),
        biddable: z.boolean(),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; goals: { category: string; origin: string }[]; biddable: boolean; dry_run?: boolean }>(
      "set_conversion_goal_biddable", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const ops = a.goals.map((g) => {
          enumValue(enums.ConversionActionCategory as unknown as Record<string, unknown>, g.category, "category");
          enumValue(enums.ConversionOrigin as unknown as Record<string, unknown>, g.origin, "origin");
          return op("customer_conversion_goal", "update", {
            resource_name: `customers/${t.customerId}/customerConversionGoals/${g.category}~${g.origin}`,
            biddable: a.biddable,
          });
        });
        const summary = `${a.biddable ? "biddable" : "not biddable"}: ${a.goals.map((g) => `${g.category}~${g.origin}`).join(", ")}`;
        return jsonResult(await applyOperations(client, t, "set_conversion_goal_biddable", summary, ops, a.dry_run ?? false));
      }),
  );

  // --- add_sitelinks ---------------------------------------------------------------
  server.registerTool(
    "add_sitelinks",
    {
      title: "Add sitelinks to a campaign",
      description: "Creates sitelink assets (text max 25, descriptions max 35 each, both or neither) and attaches them to a campaign.",
      inputSchema: {
        customer_id: customerIdSchema,
        campaign_id: z.string().min(1),
        sitelinks: z
          .array(z.object({
            text: z.string().min(1).max(25),
            final_url: z.string().url(),
            description1: z.string().max(35).optional(),
            description2: z.string().max(35).optional(),
          }))
          .min(1).max(20),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; campaign_id: string; sitelinks: { text: string; final_url: string; description1?: string; description2?: string }[]; dry_run?: boolean }>(
      "add_sitelinks", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const campaign = campaignResource(t.customerId, a.campaign_id);
        const ops: Op[] = [];
        a.sitelinks.forEach((s, i) => {
          if (Boolean(s.description1) !== Boolean(s.description2)) throw new GoogleAdsToolError(`Sitelink "${s.text}": give both descriptions or neither.`);
          const asset = `customers/${t.customerId}/assets/-${i + 1}`;
          ops.push(op("asset", "create", {
            resource_name: asset,
            final_urls: [s.final_url],
            sitelink_asset: { link_text: s.text, ...(s.description1 ? { description1: s.description1, description2: s.description2 } : {}) },
          }));
          ops.push(op("campaign_asset", "create", { campaign, asset, field_type: enums.AssetFieldType.SITELINK }));
        });
        return jsonResult(await applyOperations(client, t, "add_sitelinks", `${a.sitelinks.length} sitelinks on campaign ${a.campaign_id}`, ops, a.dry_run ?? false));
      }),
  );

  // --- add_callouts ----------------------------------------------------------------
  server.registerTool(
    "add_callouts",
    {
      title: "Add callouts to a campaign",
      description: "Creates callout assets (max 25 characters each) and attaches them to a campaign.",
      inputSchema: { customer_id: customerIdSchema, campaign_id: z.string().min(1), callouts: z.array(z.string().min(1).max(25)).min(1).max(20), dry_run: dryRun },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; campaign_id: string; callouts: string[]; dry_run?: boolean }>(
      "add_callouts", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const campaign = campaignResource(t.customerId, a.campaign_id);
        const ops = a.callouts.flatMap((text, i) => {
          const asset = `customers/${t.customerId}/assets/-${i + 1}`;
          return [
            op("asset", "create", { resource_name: asset, callout_asset: { callout_text: text } }),
            op("campaign_asset", "create", { campaign, asset, field_type: enums.AssetFieldType.CALLOUT }),
          ];
        });
        return jsonResult(await applyOperations(client, t, "add_callouts", `${a.callouts.length} callouts on campaign ${a.campaign_id}`, ops, a.dry_run ?? false));
      }),
  );

  // --- add_call_asset ----------------------------------------------------------------
  server.registerTool(
    "add_call_asset",
    {
      title: "Add a call asset to a campaign",
      description: "Creates a call asset (phone number shown with the ad) and attaches it to a campaign. country_code is two letters, e.g. ES.",
      inputSchema: {
        customer_id: customerIdSchema,
        campaign_id: z.string().min(1),
        country_code: z.string().length(2),
        phone_number: z.string().min(6).max(30),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; campaign_id: string; country_code: string; phone_number: string; dry_run?: boolean }>(
      "add_call_asset", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const asset = `customers/${t.customerId}/assets/-1`;
        const ops = [
          op("asset", "create", { resource_name: asset, call_asset: { country_code: a.country_code.toUpperCase(), phone_number: a.phone_number } }),
          op("campaign_asset", "create", { campaign: campaignResource(t.customerId, a.campaign_id), asset, field_type: enums.AssetFieldType.CALL }),
        ];
        return jsonResult(await applyOperations(client, t, "add_call_asset", `call asset ${a.phone_number} on campaign ${a.campaign_id}`, ops, a.dry_run ?? false));
      }),
  );
}
