import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { enumName, enums } from "../google-ads/client.js";
import { compact, fromMicros, num, round, str } from "../google-ads/format.js";
import { buildQuery, enumInClause } from "../google-ads/gaql.js";
import { READ_ONLY_ANNOTATIONS, customerIdSchema, jsonResult, limitSchema, toolHandler } from "./shared.js";

const CAMPAIGN_STATUSES = ["ENABLED", "PAUSED", "REMOVED"] as const;

const inputSchema = {
  customer_id: customerIdSchema,
  statuses: z
    .array(z.enum(CAMPAIGN_STATUSES))
    .default(["ENABLED", "PAUSED"])
    .describe("Campaign statuses to include. Defaults to ENABLED and PAUSED."),
  name_contains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Case-insensitive substring filter on the campaign name."),
  limit: limitSchema(100, 1000),
};

type Args = {
  customer_id: string;
  statuses?: Array<(typeof CAMPAIGN_STATUSES)[number]>;
  name_contains?: string;
  limit?: number;
};

/** GAQL string literals are single-quoted; escape anything that would break out. */
function gaqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function registerGetCampaigns(server: McpServer, config: Config): void {
  server.registerTool(
    "get_campaigns",
    {
      title: "Get campaigns",
      description:
        "Lists campaigns in an account with their configuration: status, channel type, bidding " +
        "strategy, budget, serving status, optimization score and flight dates. This returns setup " +
        "data only — use get_campaign_performance for metrics over a date range.",
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<Args>("get_campaigns", config, async (client, args) => {
      const statuses = args.statuses ?? ["ENABLED", "PAUSED"];

      const gaql = buildQuery({
        select: [
          "campaign.id",
          "campaign.name",
          "campaign.status",
          "campaign.serving_status",
          "campaign.advertising_channel_type",
          "campaign.advertising_channel_sub_type",
          "campaign.bidding_strategy_type",
          // v21+ replaced start_date/end_date with the *_date_time variants.
          "campaign.start_date_time",
          "campaign.end_date_time",
          "campaign.optimization_score",
          "campaign_budget.amount_micros",
          "campaign_budget.delivery_method",
        ],
        from: "campaign",
        where: [
          enumInClause("campaign.status", statuses, CAMPAIGN_STATUSES),
          args.name_contains
            ? `campaign.name LIKE ${gaqlString(`%${args.name_contains}%`)}`
            : undefined,
        ],
        orderBy: "campaign.name ASC",
        limit: args.limit ?? 100,
      });

      const rows = await client.query(args.customer_id, gaql);

      const campaigns = rows.map((row) => {
        const campaign = (row.campaign ?? {}) as Record<string, unknown>;
        const budget = (row.campaign_budget ?? {}) as Record<string, unknown>;
        const id = num(campaign.id);
        const optimizationScore = num(campaign.optimization_score);

        return compact({
          campaign_id: id !== undefined ? String(id) : undefined,
          name: str(campaign.name),
          status: enumName(enums.CampaignStatus, campaign.status),
          serving_status: enumName(enums.CampaignServingStatus, campaign.serving_status),
          channel_type: enumName(enums.AdvertisingChannelType, campaign.advertising_channel_type),
          channel_sub_type: enumName(
            enums.AdvertisingChannelSubType,
            campaign.advertising_channel_sub_type,
          ),
          bidding_strategy_type: enumName(enums.BiddingStrategyType, campaign.bidding_strategy_type),
          start_date_time: str(campaign.start_date_time),
          end_date_time: str(campaign.end_date_time),
          optimization_score_percent:
            optimizationScore !== undefined ? round(optimizationScore * 100, 1) : undefined,
          daily_budget: fromMicros(budget.amount_micros),
          budget_delivery_method: enumName(enums.BudgetDeliveryMethod, budget.delivery_method),
        });
      });

      return jsonResult({
        customer_id: args.customer_id,
        filters: compact({ statuses, name_contains: args.name_contains }),
        count: campaigns.length,
        campaigns,
        note:
          "daily_budget is in the account currency. Flight dates are reported in the account time " +
          "zone; an end_date_time in 2037 means no end date is set.",
      });
    }),
  );
}
