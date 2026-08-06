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
  type DateRangeInput,
} from "../google-ads/gaql.js";
import { READ_ONLY_ANNOTATIONS, customerIdSchema, jsonResult, limitSchema, toolHandler } from "./shared.js";

const ORDER_BY = {
  impressions: "metrics.impressions DESC",
  clicks: "metrics.clicks DESC",
  cost: "metrics.cost_micros DESC",
  conversions: "metrics.conversions DESC",
} as const;

type OrderKey = keyof typeof ORDER_BY;

const inputSchema = {
  customer_id: customerIdSchema,
  ...dateRangeShape,
  campaign_id: z
    .string()
    .regex(/^\d+$/, "campaign_id must be numeric")
    .optional()
    .describe("Restrict results to a single campaign."),
  ad_group_id: z
    .string()
    .regex(/^\d+$/, "ad_group_id must be numeric")
    .optional()
    .describe("Restrict results to a single ad group."),
  min_impressions: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Drop search terms below this impression count — useful for cutting long-tail noise."),
  order_by: z
    .enum(Object.keys(ORDER_BY) as [OrderKey, ...OrderKey[]])
    .default("impressions")
    .describe("Metric to sort by, descending."),
  limit: limitSchema(100, 2000),
};

type Args = DateRangeInput & {
  customer_id: string;
  campaign_id?: string;
  ad_group_id?: string;
  min_impressions?: number;
  order_by?: OrderKey;
  limit?: number;
};

export function registerGetSearchTerms(server: McpServer, config: Config): void {
  server.registerTool(
    "get_search_terms",
    {
      title: "Get search terms report",
      description:
        "Returns the actual search queries that triggered ads, with performance metrics and the " +
        "match type and keyword they matched. Use this to find wasted spend, negative keyword " +
        "candidates and new keyword opportunities. Search terms are only available for Search and " +
        "Shopping traffic.",
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<Args>("get_search_terms", config, async (client, args) => {
      const minImpressions = args.min_impressions ?? 0;
      const orderKey: OrderKey = args.order_by ?? "impressions";

      const gaql = buildQuery({
        select: [
          "search_term_view.search_term",
          "search_term_view.status",
          "campaign.id",
          "campaign.name",
          "ad_group.id",
          "ad_group.name",
          "segments.search_term_match_type",
          "segments.keyword.info.text",
          "segments.keyword.info.match_type",
          ...METRIC_FIELDS,
        ],
        from: "search_term_view",
        where: [
          dateCondition(args),
          args.campaign_id ? `campaign.id = ${args.campaign_id.replace(/\D/g, "")}` : undefined,
          args.ad_group_id ? `ad_group.id = ${args.ad_group_id.replace(/\D/g, "")}` : undefined,
          minImpressions > 0 ? `metrics.impressions >= ${Math.trunc(minImpressions)}` : undefined,
        ],
        orderBy: ORDER_BY[orderKey],
        limit: args.limit ?? 100,
      });

      const rows = await client.query(args.customer_id, gaql);

      const terms = rows.map((row) => {
        const view = (row.search_term_view ?? {}) as Record<string, unknown>;
        const campaign = (row.campaign ?? {}) as Record<string, unknown>;
        const adGroup = (row.ad_group ?? {}) as Record<string, unknown>;
        const segments = (row.segments ?? {}) as Record<string, unknown>;
        const keyword = ((segments.keyword ?? {}) as Record<string, unknown>).info as
          | Record<string, unknown>
          | undefined;

        const campaignId = num(campaign.id);
        const adGroupId = num(adGroup.id);

        return compact({
          search_term: str(view.search_term),
          status: enumName(enums.SearchTermTargetingStatus, view.status),
          match_type: enumName(enums.SearchTermMatchType, segments.search_term_match_type),
          matched_keyword: keyword ? str(keyword.text) : undefined,
          matched_keyword_match_type: keyword
            ? enumName(enums.KeywordMatchType, keyword.match_type)
            : undefined,
          campaign_id: campaignId !== undefined ? String(campaignId) : undefined,
          campaign_name: str(campaign.name),
          ad_group_id: adGroupId !== undefined ? String(adGroupId) : undefined,
          ad_group_name: str(adGroup.name),
          ...performanceMetrics(row.metrics),
        });
      });

      return jsonResult({
        customer_id: args.customer_id,
        date_range: describeDateRange(args),
        order_by: orderKey,
        filters: compact({
          campaign_id: args.campaign_id,
          ad_group_id: args.ad_group_id,
          min_impressions: minImpressions || undefined,
        }),
        count: terms.length,
        totals: sumMetrics(rows.map((row) => performanceMetrics(row.metrics))),
        search_terms: terms,
        note:
          "status ADDED means the term already exists as a keyword; EXCLUDED means it is already " +
          "negated. Google withholds terms with too little traffic to report anonymously, so these " +
          "totals will not match campaign totals.",
      });
    }),
  );
}
