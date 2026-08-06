import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { enumName, enums } from "../google-ads/client.js";
import { METRIC_FIELDS, compact, num, performanceMetrics, str, sumMetrics } from "../google-ads/format.js";
import {
  buildQuery,
  dateCondition,
  dateRangeShape,
  describeDateRange,
  enumInClause,
  type DateRangeInput,
} from "../google-ads/gaql.js";
import { READ_ONLY_ANNOTATIONS, customerIdSchema, jsonResult, limitSchema, toolHandler } from "./shared.js";

const CAMPAIGN_STATUSES = ["ENABLED", "PAUSED", "REMOVED"] as const;

/** Optional extra dimension. Each maps to a GAQL segment field. */
const SEGMENT_FIELDS = {
  none: undefined,
  date: "segments.date",
  week: "segments.week",
  month: "segments.month",
  device: "segments.device",
  network: "segments.ad_network_type",
} as const;

type SegmentKey = keyof typeof SEGMENT_FIELDS;

const ORDER_BY = {
  cost: "metrics.cost_micros DESC",
  clicks: "metrics.clicks DESC",
  impressions: "metrics.impressions DESC",
  conversions: "metrics.conversions DESC",
  conversions_value: "metrics.conversions_value DESC",
} as const;

type OrderKey = keyof typeof ORDER_BY;

const inputSchema = {
  customer_id: customerIdSchema,
  ...dateRangeShape,
  statuses: z
    .array(z.enum(CAMPAIGN_STATUSES))
    .default(["ENABLED", "PAUSED"])
    .describe("Campaign statuses to include. Defaults to ENABLED and PAUSED."),
  campaign_ids: z
    .array(z.string().regex(/^\d+$/, "campaign_ids must be numeric"))
    .max(200)
    .optional()
    .describe("Restrict the report to specific campaign IDs."),
  segment_by: z
    .enum(Object.keys(SEGMENT_FIELDS) as [SegmentKey, ...SegmentKey[]])
    .default("none")
    .describe(
      "Optional extra breakdown. 'none' returns one row per campaign; anything else multiplies rows " +
        "by that dimension, so raise the limit accordingly.",
    ),
  order_by: z
    .enum(Object.keys(ORDER_BY) as [OrderKey, ...OrderKey[]])
    .default("cost")
    .describe("Metric to sort by, descending."),
  limit: limitSchema(50, 2000),
};

type Args = DateRangeInput & {
  customer_id: string;
  statuses?: Array<(typeof CAMPAIGN_STATUSES)[number]>;
  campaign_ids?: string[];
  segment_by?: SegmentKey;
  order_by?: OrderKey;
  limit?: number;
};

export function registerGetCampaignPerformance(server: McpServer, config: Config): void {
  server.registerTool(
    "get_campaign_performance",
    {
      title: "Get campaign performance",
      description:
        "Reports campaign metrics over a date range — impressions, clicks, cost, conversions, " +
        "conversion value, plus derived CTR, average CPC, cost per conversion and ROAS. Optionally " +
        "segments by date, week, month, device or network. Totals across all returned rows are " +
        "included.",
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<Args>("get_campaign_performance", config, async (client, args) => {
      const statuses = args.statuses ?? ["ENABLED", "PAUSED"];
      const segmentKey: SegmentKey = args.segment_by ?? "none";
      const segmentField = SEGMENT_FIELDS[segmentKey];
      const orderKey: OrderKey = args.order_by ?? "cost";

      const campaignIdFilter =
        args.campaign_ids && args.campaign_ids.length > 0
          ? `campaign.id IN (${args.campaign_ids.map((id) => id.replace(/\D/g, "")).join(", ")})`
          : undefined;

      const gaql = buildQuery({
        select: [
          "campaign.id",
          "campaign.name",
          "campaign.status",
          "campaign.advertising_channel_type",
          ...(segmentField ? [segmentField] : []),
          ...METRIC_FIELDS,
        ],
        from: "campaign",
        where: [
          dateCondition(args),
          enumInClause("campaign.status", statuses, CAMPAIGN_STATUSES),
          campaignIdFilter,
        ],
        orderBy: ORDER_BY[orderKey],
        limit: args.limit ?? 50,
      });

      const rows = await client.query(args.customer_id, gaql);

      const results = rows.map((row) => {
        const campaign = (row.campaign ?? {}) as Record<string, unknown>;
        const segments = (row.segments ?? {}) as Record<string, unknown>;
        const id = num(campaign.id);

        return compact({
          campaign_id: id !== undefined ? String(id) : undefined,
          name: str(campaign.name),
          status: enumName(enums.CampaignStatus, campaign.status),
          channel_type: enumName(enums.AdvertisingChannelType, campaign.advertising_channel_type),
          segment: segmentLabel(segmentKey, segments),
          ...performanceMetrics(row.metrics),
        });
      });

      return jsonResult({
        customer_id: args.customer_id,
        date_range: describeDateRange(args),
        segment_by: segmentKey,
        order_by: orderKey,
        filters: compact({ statuses, campaign_ids: args.campaign_ids }),
        count: results.length,
        totals: sumMetrics(rows.map((row) => performanceMetrics(row.metrics))),
        campaigns: results,
        note:
          "Monetary values are in the account currency. Totals cover only the rows returned — if " +
          "count equals the limit, raise the limit for a complete picture.",
      });
    }),
  );
}

function segmentLabel(key: SegmentKey, segments: Record<string, unknown>): string | undefined {
  switch (key) {
    case "date":
      return str(segments.date);
    case "week":
      return str(segments.week);
    case "month":
      return str(segments.month);
    case "device":
      return enumName(enums.Device, segments.device);
    case "network":
      return enumName(enums.AdNetworkType, segments.ad_network_type);
    default:
      return undefined;
  }
}
