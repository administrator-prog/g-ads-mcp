import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "../config.js";
import { enumName, enums } from "../google-ads/client.js";
import { METRIC_FIELDS, bool, compact, num, performanceMetrics, str } from "../google-ads/format.js";
import { buildQuery, dateCondition, dateRangeShape, describeDateRange, type DateRangeInput } from "../google-ads/gaql.js";
import { READ_ONLY_ANNOTATIONS, customerIdSchema, jsonResult, toolHandler } from "./shared.js";

const inputSchema = {
  customer_id: customerIdSchema,
  ...dateRangeShape,
};

type Args = DateRangeInput & { customer_id: string };

export function registerGetAccountSummary(server: McpServer, config: Config): void {
  server.registerTool(
    "get_account_summary",
    {
      title: "Get account summary",
      description:
        "Returns account settings (name, currency, time zone, status) together with aggregate " +
        "performance for a date range and a breakdown of campaign counts by status. Use this as the " +
        "first call when investigating an account, before drilling into individual campaigns.",
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<Args>("get_account_summary", config, async (client, args) => {
      const period = dateCondition(args);

      // Selecting metrics FROM customer without any segment fields returns a
      // single row aggregated across the whole window.
      const summaryQuery = buildQuery({
        select: [
          "customer.id",
          "customer.descriptive_name",
          "customer.currency_code",
          "customer.time_zone",
          "customer.manager",
          "customer.test_account",
          "customer.status",
          "customer.auto_tagging_enabled",
          ...METRIC_FIELDS,
        ],
        from: "customer",
        where: [period],
      });

      const campaignCountQuery = buildQuery({
        select: ["campaign.id", "campaign.status"],
        from: "campaign",
        where: ["campaign.status != 'REMOVED'"],
        limit: 10000,
      });

      const [summaryRows, campaignRows] = await Promise.all([
        client.query(args.customer_id, summaryQuery),
        client.query(args.customer_id, campaignCountQuery),
      ]);

      const first = summaryRows[0] ?? {};
      const customer = (first.customer ?? {}) as Record<string, unknown>;

      const campaignsByStatus: Record<string, number> = {};
      for (const row of campaignRows) {
        const campaign = (row.campaign ?? {}) as Record<string, unknown>;
        const status = enumName(enums.CampaignStatus, campaign.status) ?? "UNKNOWN";
        campaignsByStatus[status] = (campaignsByStatus[status] ?? 0) + 1;
      }

      const customerId = num(customer.id);

      return jsonResult({
        account: compact({
          customer_id: customerId !== undefined ? String(customerId) : args.customer_id,
          name: str(customer.descriptive_name),
          currency_code: str(customer.currency_code),
          time_zone: str(customer.time_zone),
          status: enumName(enums.CustomerStatus, customer.status),
          is_manager: bool(customer.manager) ?? false,
          is_test_account: bool(customer.test_account) ?? false,
          auto_tagging_enabled: bool(customer.auto_tagging_enabled),
        }),
        date_range: describeDateRange(args),
        performance: performanceMetrics(first.metrics),
        campaign_counts: {
          total: campaignRows.length,
          by_status: campaignsByStatus,
        },
        note:
          "Monetary values are in the account currency shown above. Campaign counts exclude removed " +
          "campaigns and are current as of now, not scoped to the reporting date range.",
      });
    }),
  );
}
