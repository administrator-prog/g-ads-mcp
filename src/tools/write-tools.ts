import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MutateOperation } from "google-ads-api";
import { z } from "zod";

import type { Config } from "../config.js";
import { GoogleAdsToolError, enumName, enums } from "../google-ads/client.js";
import { compact, num, str } from "../google-ads/format.js";
import {
  MONTHLY_MULTIPLIER,
  adGroupResource,
  applyOperations,
  assertDailyFits,
  assertWithinCap,
  campaignBudgets,
  campaignResource,
  compositeResource,
  digits,
  round2,
  toMicros,
  writableAccount,
} from "../google-ads/write.js";
import { READ_ONLY_ANNOTATIONS, customerIdSchema, jsonResult, toolHandler } from "./shared.js";

/**
 * Write tools. All of them go through src/google-ads/write.ts: allow-listed
 * accounts only, a monthly spend cap, campaigns created paused, validation
 * before every change, and an audit log line for every applied change. None of
 * them can remove anything, touch billing or change account access.
 */

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const dryRun = z
  .boolean()
  .default(false)
  .describe("true = only validate the change with Google and report what would happen; nothing is applied.");

const matchType = z.enum(["EXACT", "PHRASE", "BROAD"]);
const keywordList = z
  .array(z.object({ text: z.string().min(1).max(80), match_type: matchType }))
  .min(1)
  .max(200);

const MATCH = {
  EXACT: enums.KeywordMatchType.EXACT,
  PHRASE: enums.KeywordMatchType.PHRASE,
  BROAD: enums.KeywordMatchType.BROAD,
};

type Op = MutateOperation<Record<string, unknown>>;

function op(entity: string, operation: "create" | "update", resource: Record<string, unknown>): Op {
  return { entity: entity as Op["entity"], operation, resource } as Op;
}

export function registerWriteTools(server: McpServer, config: Config): void {
  // --- create_search_campaign ---------------------------------------------
  server.registerTool(
    "create_search_campaign",
    {
      title: "Create a Search campaign (always paused)",
      description:
        "Creates a Google Search campaign with its own daily budget, location and language targeting. " +
        "It is ALWAYS created PAUSED, on Google Search only (no search partners, no Display), with " +
        "'presence' location targeting and the EU political ads declaration set to 'does not contain'. " +
        "Common ids: locations United Kingdom 2826, Spain 2724, Denmark 2208, Ireland 2372; languages " +
        "English 1000, Spanish 1003, Danish 1009, Dutch 1010. Only allow-listed accounts can be changed.",
      inputSchema: {
        customer_id: customerIdSchema,
        name: z.string().min(1).max(255),
        daily_budget: z.number().positive().describe("Daily budget in the account currency."),
        bidding: z
          .enum(["MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS"])
          .describe("MAXIMIZE_CLICKS for a new campaign without conversion data; MAXIMIZE_CONVERSIONS once it has some."),
        max_cpc: z.number().positive().optional().describe("MAXIMIZE_CLICKS only: highest price per click, in the account currency."),
        target_cpa: z.number().positive().optional().describe("MAXIMIZE_CONVERSIONS only: optional target cost per conversion."),
        location_ids: z.array(z.number().int().positive()).min(1).max(50),
        language_ids: z.array(z.number().int().positive()).min(1).max(20),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{
      customer_id: string; name: string; daily_budget: number; bidding: "MAXIMIZE_CLICKS" | "MAXIMIZE_CONVERSIONS";
      max_cpc?: number; target_cpa?: number; location_ids: number[]; language_ids: number[]; dry_run?: boolean;
    }>("create_search_campaign", config, async (client, a) => {
      const t = writableAccount(config, a.customer_id);
      assertDailyFits(t, a.daily_budget);
      const budget = `customers/${t.customerId}/campaignBudgets/-1`;
      const campaign = `customers/${t.customerId}/campaigns/-2`;
      const bidding =
        a.bidding === "MAXIMIZE_CLICKS"
          ? { target_spend: a.max_cpc ? { cpc_bid_ceiling_micros: toMicros(a.max_cpc) } : {} }
          : { maximize_conversions: a.target_cpa ? { target_cpa_micros: toMicros(a.target_cpa) } : {} };
      const ops: Op[] = [
        op("campaign_budget", "create", {
          resource_name: budget,
          name: `${a.name} budget ${Date.now()}`,
          amount_micros: toMicros(a.daily_budget),
          delivery_method: enums.BudgetDeliveryMethod.STANDARD,
          explicitly_shared: false,
        }),
        op("campaign", "create", {
          resource_name: campaign,
          name: a.name,
          status: enums.CampaignStatus.PAUSED,
          advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
          campaign_budget: budget,
          network_settings: {
            target_google_search: true,
            target_search_network: false,
            target_content_network: false,
            target_partner_search_network: false,
          },
          geo_target_type_setting: {
            positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE,
            negative_geo_target_type: enums.NegativeGeoTargetType.PRESENCE,
          },
          contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
          ...bidding,
        }),
        ...a.location_ids.map((id) =>
          op("campaign_criterion", "create", { campaign, location: { geo_target_constant: `geoTargetConstants/${id}` } }),
        ),
        ...a.language_ids.map((id) =>
          op("campaign_criterion", "create", { campaign, language: { language_constant: `languageConstants/${id}` } }),
        ),
      ];
      const result = await applyOperations(client, t, "create_search_campaign", `create paused campaign "${a.name}" at ${a.daily_budget}/day`, ops, a.dry_run ?? false);
      return jsonResult({
        ...result,
        status: "PAUSED",
        campaign_id: result.resources.find((r) => r.includes("/campaigns/"))?.split("/").pop(),
        daily_budget: a.daily_budget,
        max_monthly_if_enabled: round2(a.daily_budget * MONTHLY_MULTIPLIER),
        note: "Created paused. Nothing spends until set_status enables it with confirm_spend: true.",
      });
    }),
  );

  // --- create_ad_group ------------------------------------------------------
  server.registerTool(
    "create_ad_group",
    {
      title: "Create a Search ad group",
      description: "Creates a standard Search ad group in a campaign. Optional default max CPC (manual-bid campaigns only).",
      inputSchema: {
        customer_id: customerIdSchema,
        campaign_id: z.string().min(1),
        name: z.string().min(1).max(255),
        cpc_bid: z.number().positive().optional(),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; campaign_id: string; name: string; cpc_bid?: number; dry_run?: boolean }>(
      "create_ad_group", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const result = await applyOperations(client, t, "create_ad_group", `create ad group "${a.name}" in campaign ${a.campaign_id}`, [
          op("ad_group", "create", {
            name: a.name,
            campaign: campaignResource(t.customerId, a.campaign_id),
            status: enums.AdGroupStatus.ENABLED,
            type: enums.AdGroupType.SEARCH_STANDARD,
            ...(a.cpc_bid ? { cpc_bid_micros: toMicros(a.cpc_bid) } : {}),
          }),
        ], a.dry_run ?? false);
        return jsonResult({ ...result, ad_group_id: result.resources[0]?.split("/").pop() });
      }),
  );

  // --- add_keywords ---------------------------------------------------------
  server.registerTool(
    "add_keywords",
    {
      title: "Add keywords to an ad group",
      description: "Adds positive keywords (EXACT, PHRASE or BROAD) to an ad group, optionally with a final URL and a keyword-level max CPC.",
      inputSchema: {
        customer_id: customerIdSchema,
        ad_group_id: z.string().min(1),
        keywords: keywordList,
        final_url: z.string().url().optional(),
        cpc_bid: z.number().positive().optional(),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; ad_group_id: string; keywords: Array<{ text: string; match_type: keyof typeof MATCH }>; final_url?: string; cpc_bid?: number; dry_run?: boolean }>(
      "add_keywords", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const adGroup = adGroupResource(t.customerId, a.ad_group_id);
        const ops = a.keywords.map((k) =>
          op("ad_group_criterion", "create", {
            ad_group: adGroup,
            status: enums.AdGroupCriterionStatus.ENABLED,
            keyword: { text: k.text, match_type: MATCH[k.match_type] },
            ...(a.final_url ? { final_urls: [a.final_url] } : {}),
            ...(a.cpc_bid ? { cpc_bid_micros: toMicros(a.cpc_bid) } : {}),
          }),
        );
        const result = await applyOperations(client, t, "add_keywords", `add ${ops.length} keywords to ad group ${a.ad_group_id}`, ops, a.dry_run ?? false);
        return jsonResult({ ...result, added: a.dry_run ? 0 : result.resources.length });
      }),
  );

  // --- add_negative_keywords --------------------------------------------------
  server.registerTool(
    "add_negative_keywords",
    {
      title: "Add negative keywords",
      description: "Adds negative keywords to a campaign (campaign_id) or to one ad group (ad_group_id). Pass exactly one of the two.",
      inputSchema: {
        customer_id: customerIdSchema,
        campaign_id: z.string().optional(),
        ad_group_id: z.string().optional(),
        keywords: keywordList,
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; campaign_id?: string; ad_group_id?: string; keywords: Array<{ text: string; match_type: keyof typeof MATCH }>; dry_run?: boolean }>(
      "add_negative_keywords", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        if (Boolean(a.campaign_id) === Boolean(a.ad_group_id)) throw new GoogleAdsToolError("Pass exactly one of campaign_id or ad_group_id.");
        const ops = a.keywords.map((k) =>
          a.campaign_id
            ? op("campaign_criterion", "create", { campaign: campaignResource(t.customerId, a.campaign_id), negative: true, keyword: { text: k.text, match_type: MATCH[k.match_type] } })
            : op("ad_group_criterion", "create", { ad_group: adGroupResource(t.customerId, a.ad_group_id!), negative: true, keyword: { text: k.text, match_type: MATCH[k.match_type] } }),
        );
        const where = a.campaign_id ? `campaign ${a.campaign_id}` : `ad group ${a.ad_group_id}`;
        const result = await applyOperations(client, t, "add_negative_keywords", `add ${ops.length} negatives to ${where}`, ops, a.dry_run ?? false);
        return jsonResult({ ...result, added: a.dry_run ? 0 : result.resources.length });
      }),
  );

  // --- create_responsive_search_ad ---------------------------------------------
  server.registerTool(
    "create_responsive_search_ad",
    {
      title: "Create a responsive search ad",
      description: "Creates a responsive search ad: 3-15 headlines (max 30 characters each), 2-4 descriptions (max 90), a final URL and optional display paths (max 15).",
      inputSchema: {
        customer_id: customerIdSchema,
        ad_group_id: z.string().min(1),
        headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
        descriptions: z.array(z.string().min(1).max(90)).min(2).max(4),
        final_url: z.string().url(),
        path1: z.string().max(15).optional(),
        path2: z.string().max(15).optional(),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; ad_group_id: string; headlines: string[]; descriptions: string[]; final_url: string; path1?: string; path2?: string; dry_run?: boolean }>(
      "create_responsive_search_ad", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const result = await applyOperations(client, t, "create_responsive_search_ad", `create RSA in ad group ${a.ad_group_id}`, [
          op("ad_group_ad", "create", {
            ad_group: adGroupResource(t.customerId, a.ad_group_id),
            status: enums.AdGroupAdStatus.ENABLED,
            ad: {
              final_urls: [a.final_url],
              responsive_search_ad: {
                headlines: a.headlines.map((text) => ({ text })),
                descriptions: a.descriptions.map((text) => ({ text })),
                ...(a.path1 ? { path1: a.path1 } : {}),
                ...(a.path2 ? { path2: a.path2 } : {}),
              },
            },
          }),
        ], a.dry_run ?? false);
        return jsonResult(result);
      }),
  );

  // --- set_status ------------------------------------------------------------
  server.registerTool(
    "set_status",
    {
      title: "Pause or enable campaigns, ad groups, keywords or ads",
      description:
        "Sets ENABLED or PAUSED. Ids: campaign and ad_group are numeric; keyword and ad are '<adGroupId>~<id>'. " +
        "Enabling a campaign starts spend, so it needs confirm_spend: true and is refused if the account's " +
        "enabled campaigns would then exceed the monthly cap. Nothing can be removed with this server.",
      inputSchema: {
        customer_id: customerIdSchema,
        level: z.enum(["campaign", "ad_group", "keyword", "ad"]),
        ids: z.array(z.string().min(1)).min(1).max(100),
        status: z.enum(["ENABLED", "PAUSED"]),
        confirm_spend: z.boolean().default(false).describe("Must be true to enable a campaign."),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; level: "campaign" | "ad_group" | "keyword" | "ad"; ids: string[]; status: "ENABLED" | "PAUSED"; confirm_spend?: boolean; dry_run?: boolean }>(
      "set_status", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        let capCheck: Awaited<ReturnType<typeof assertWithinCap>> | undefined;
        if (a.level === "campaign" && a.status === "ENABLED") {
          if (!a.confirm_spend) {
            throw new GoogleAdsToolError("Refused: enabling a campaign starts spending. Call again with confirm_spend: true once that is intended.");
          }
          capCheck = await assertWithinCap(client, t, { enable: a.ids.map((id) => digits(id, "campaign_id")) });
        }
        const ops = a.ids.map((id) => {
          switch (a.level) {
            case "campaign":
              return op("campaign", "update", { resource_name: campaignResource(t.customerId, id), status: enums.CampaignStatus[a.status] });
            case "ad_group":
              return op("ad_group", "update", { resource_name: adGroupResource(t.customerId, id), status: enums.AdGroupStatus[a.status] });
            case "keyword":
              return op("ad_group_criterion", "update", { resource_name: compositeResource(t.customerId, "adGroupCriteria", id), status: enums.AdGroupCriterionStatus[a.status] });
            case "ad":
              return op("ad_group_ad", "update", { resource_name: compositeResource(t.customerId, "adGroupAds", id), status: enums.AdGroupAdStatus[a.status] });
          }
        });
        const result = await applyOperations(client, t, "set_status", `${a.status} ${a.level} ${a.ids.join(", ")}`, ops, a.dry_run ?? false);
        return jsonResult({ ...result, ...(capCheck ? { spend_check: capCheck } : {}) });
      }),
  );

  // --- update_campaign_budget ---------------------------------------------------
  server.registerTool(
    "update_campaign_budget",
    {
      title: "Change a campaign's daily budget",
      description: "Sets a campaign's daily budget. Refused if the account's enabled campaigns would then exceed the monthly cap.",
      inputSchema: { customer_id: customerIdSchema, campaign_id: z.string().min(1), daily_budget: z.number().positive(), dry_run: dryRun },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; campaign_id: string; daily_budget: number; dry_run?: boolean }>(
      "update_campaign_budget", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const id = digits(a.campaign_id, "campaign_id");
        assertDailyFits(t, a.daily_budget);
        const { rows } = await campaignBudgets(client, t.customerId);
        const row = rows.find((r) => r.campaignId === id);
        if (!row?.budgetResource) throw new GoogleAdsToolError(`Campaign ${id} was not found in account ${t.customerId}.`);
        const shared = rows.filter((r) => r.budgetResource === row.budgetResource).length > 1;
        if (shared) throw new GoogleAdsToolError(`Campaign ${id} uses a shared budget; change it in the Google Ads interface.`);
        const capCheck = await assertWithinCap(client, t, { budgets: { [id]: a.daily_budget } });
        const result = await applyOperations(client, t, "update_campaign_budget", `campaign ${id} budget ${row.dailyBudget} -> ${a.daily_budget}/day`, [
          op("campaign_budget", "update", { resource_name: row.budgetResource, amount_micros: toMicros(a.daily_budget) }),
        ], a.dry_run ?? false);
        return jsonResult({ ...result, previous_daily_budget: row.dailyBudget, daily_budget: a.daily_budget, spend_check: capCheck });
      }),
  );

  // --- update_campaign_bidding --------------------------------------------------
  server.registerTool(
    "update_campaign_bidding",
    {
      title: "Change a campaign's bid strategy",
      description:
        "Switches a campaign between MAXIMIZE_CLICKS (optional max_cpc ceiling) and MAXIMIZE_CONVERSIONS (optional target_cpa). " +
        "Use it to raise or lower the max CPC ceiling, or to move to conversion bidding once the campaign has 20-30 real conversions.",
      inputSchema: {
        customer_id: customerIdSchema,
        campaign_id: z.string().min(1),
        bidding: z.enum(["MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS"]),
        max_cpc: z.number().positive().optional(),
        target_cpa: z.number().positive().optional(),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; campaign_id: string; bidding: "MAXIMIZE_CLICKS" | "MAXIMIZE_CONVERSIONS"; max_cpc?: number; target_cpa?: number; dry_run?: boolean }>(
      "update_campaign_bidding", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const resource =
          a.bidding === "MAXIMIZE_CLICKS"
            ? { target_spend: { cpc_bid_ceiling_micros: a.max_cpc ? toMicros(a.max_cpc) : 0 } }
            : { maximize_conversions: { target_cpa_micros: a.target_cpa ? toMicros(a.target_cpa) : 0 } };
        const result = await applyOperations(client, t, "update_campaign_bidding", `campaign ${a.campaign_id} bidding ${a.bidding} ${a.max_cpc ?? a.target_cpa ?? ""}`.trim(), [
          op("campaign", "update", { resource_name: campaignResource(t.customerId, a.campaign_id), ...resource }),
        ], a.dry_run ?? false);
        return jsonResult(result);
      }),
  );

  // --- set_cpc_bid ---------------------------------------------------------------
  server.registerTool(
    "set_cpc_bid",
    {
      title: "Set an ad group or keyword max CPC",
      description: "Sets the max CPC on an ad group (numeric id) or a keyword ('<adGroupId>~<criterionId>'). Applies to manual-CPC bidding; automated strategies ignore it.",
      inputSchema: { customer_id: customerIdSchema, level: z.enum(["ad_group", "keyword"]), id: z.string().min(1), cpc_bid: z.number().positive(), dry_run: dryRun },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; level: "ad_group" | "keyword"; id: string; cpc_bid: number; dry_run?: boolean }>(
      "set_cpc_bid", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const operation =
          a.level === "ad_group"
            ? op("ad_group", "update", { resource_name: adGroupResource(t.customerId, a.id), cpc_bid_micros: toMicros(a.cpc_bid) })
            : op("ad_group_criterion", "update", { resource_name: compositeResource(t.customerId, "adGroupCriteria", a.id), cpc_bid_micros: toMicros(a.cpc_bid) });
        const result = await applyOperations(client, t, "set_cpc_bid", `${a.level} ${a.id} max CPC ${a.cpc_bid}`, [operation], a.dry_run ?? false);
        return jsonResult(result);
      }),
  );

  // --- set_conversion_action_goal ------------------------------------------------
  server.registerTool(
    "set_conversion_action_goal",
    {
      title: "Make conversion actions primary or secondary",
      description:
        "Sets primary_for_goal on conversion actions. Primary actions count in 'conversions' and are what " +
        "Smart Bidding optimises for; secondary ones are reported under 'all conversions' only.",
      inputSchema: {
        customer_id: customerIdSchema,
        conversion_action_ids: z.array(z.string().min(1)).min(1).max(50),
        primary: z.boolean(),
        dry_run: dryRun,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; conversion_action_ids: string[]; primary: boolean; dry_run?: boolean }>(
      "set_conversion_action_goal", config, async (client, a) => {
        const t = writableAccount(config, a.customer_id);
        const ops = a.conversion_action_ids.map((id) =>
          op("conversion_action", "update", { resource_name: `customers/${t.customerId}/conversionActions/${digits(id, "conversion_action_id")}`, primary_for_goal: a.primary }),
        );
        const result = await applyOperations(client, t, "set_conversion_action_goal", `${a.primary ? "primary" : "secondary"}: ${a.conversion_action_ids.join(", ")}`, ops, a.dry_run ?? false);
        return jsonResult(result);
      }),
  );

  // --- get_change_history (read-only) -------------------------------------------
  server.registerTool(
    "get_change_history",
    {
      title: "Get change history",
      description: "Google's own record of changes to the account in the last 1-30 days: what changed, when, and through which tool (API, web interface, Editor).",
      inputSchema: { customer_id: customerIdSchema, days: z.number().int().min(1).max(30).default(7), limit: z.number().int().min(1).max(1000).default(200) },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string; days?: number; limit?: number }>("get_change_history", config, async (client, a) => {
      const days = a.days ?? 7;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const rows = await client.query(
        a.customer_id,
        "SELECT change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name, " +
          "change_event.client_type, change_event.resource_change_operation, change_event.changed_fields " +
          `FROM change_event WHERE change_event.change_date_time >= '${since}' ORDER BY change_event.change_date_time DESC LIMIT ${a.limit ?? 200}`,
      );
      const changes = rows.map((row) => {
        const e = (row.change_event ?? {}) as Record<string, unknown>;
        const fields = e.changed_fields as { paths?: string[] } | string | undefined;
        return compact({
          at: str(e.change_date_time),
          resource_type: enumName(enums.ChangeEventResourceType, e.change_resource_type),
          resource: str(e.change_resource_name),
          operation: enumName(enums.ResourceChangeOperation, e.resource_change_operation),
          via: enumName(enums.ChangeClientType, e.client_type),
          changed_fields: typeof fields === "string" ? fields : fields?.paths?.join(", "),
        });
      });
      return jsonResult({ customer_id: a.customer_id, days, count: changes.length, changes });
    }),
  );

  // --- get_write_limits (read-only) -----------------------------------------------
  server.registerTool(
    "get_write_limits",
    {
      title: "Get write limits",
      description: "Shows whether an account can be changed through this server, its monthly spend cap, and how much of the cap its enabled campaigns already allow.",
      inputSchema: { customer_id: customerIdSchema },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<{ customer_id: string }>("get_write_limits", config, async (client, a) => {
      const t = writableAccount(config, a.customer_id);
      const { currency, rows } = await campaignBudgets(client, t.customerId);
      const enabled = rows.filter((r) => r.status === "ENABLED");
      const daily = enabled.reduce((s, r) => s + r.dailyBudget, 0);
      return jsonResult({
        customer_id: t.customerId,
        writable: true,
        currency,
        monthly_cap: t.monthlyCap,
        enabled_campaigns: enabled.map((r) => ({ campaign_id: r.campaignId, name: r.name, daily_budget: r.dailyBudget })),
        enabled_daily_total: round2(daily),
        max_monthly_now: round2(daily * MONTHLY_MULTIPLIER),
        headroom_daily: round2(t.monthlyCap / MONTHLY_MULTIPLIER - daily),
        paused_campaigns: rows.filter((r) => r.status === "PAUSED").length,
        note: `Google can charge up to ${MONTHLY_MULTIPLIER} x the daily budget in a month; the cap is checked on that basis.`,
      });
    }),
  );
}

// Keep tree-shaking honest for helpers used only in some paths.
void num;
