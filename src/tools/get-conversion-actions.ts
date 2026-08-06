import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { enumName, enums } from "../google-ads/client.js";
import { bool, compact, num, str } from "../google-ads/format.js";
import { buildQuery, enumInClause } from "../google-ads/gaql.js";
import { READ_ONLY_ANNOTATIONS, customerIdSchema, jsonResult, limitSchema, toolHandler } from "./shared.js";

const CONVERSION_ACTION_STATUSES = ["ENABLED", "REMOVED", "HIDDEN"] as const;

const inputSchema = {
  customer_id: customerIdSchema,
  statuses: z
    .array(z.enum(CONVERSION_ACTION_STATUSES))
    .default(["ENABLED"])
    .describe("Conversion action statuses to include. Defaults to ENABLED only."),
  limit: limitSchema(200, 1000),
};

type Args = {
  customer_id: string;
  statuses?: Array<(typeof CONVERSION_ACTION_STATUSES)[number]>;
  limit?: number;
};

export function registerGetConversionActions(server: McpServer, config: Config): void {
  server.registerTool(
    "get_conversion_actions",
    {
      title: "Get conversion actions",
      description:
        "Lists the conversion actions configured in an account: type, category, counting method, " +
        "attribution lookback windows, default value, and whether each one is a primary goal that " +
        "feeds the 'conversions' metric. Use this to interpret conversion numbers from the other " +
        "reporting tools.",
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<Args>("get_conversion_actions", config, async (client, args) => {
      const statuses = args.statuses ?? ["ENABLED"];

      const gaql = buildQuery({
        select: [
          "conversion_action.id",
          "conversion_action.name",
          "conversion_action.status",
          "conversion_action.type",
          "conversion_action.category",
          "conversion_action.counting_type",
          "conversion_action.primary_for_goal",
          "conversion_action.click_through_lookback_window_days",
          "conversion_action.view_through_lookback_window_days",
          "conversion_action.value_settings.default_value",
          "conversion_action.value_settings.always_use_default_value",
          "conversion_action.attribution_model_settings.attribution_model",
          "conversion_action.origin",
        ],
        from: "conversion_action",
        where: [enumInClause("conversion_action.status", statuses, CONVERSION_ACTION_STATUSES)],
        orderBy: "conversion_action.name ASC",
        limit: args.limit ?? 200,
      });

      const rows = await client.query(args.customer_id, gaql);

      const actions = rows.map((row) => {
        const action = (row.conversion_action ?? {}) as Record<string, unknown>;
        const valueSettings = (action.value_settings ?? {}) as Record<string, unknown>;
        const attribution = (action.attribution_model_settings ?? {}) as Record<string, unknown>;
        const id = num(action.id);

        return compact({
          conversion_action_id: id !== undefined ? String(id) : undefined,
          name: str(action.name),
          status: enumName(enums.ConversionActionStatus, action.status),
          type: enumName(enums.ConversionActionType, action.type),
          category: enumName(enums.ConversionActionCategory, action.category),
          counting_type: enumName(enums.ConversionActionCountingType, action.counting_type),
          origin: enumName(enums.ConversionOrigin, action.origin),
          primary_for_goal: bool(action.primary_for_goal),
          click_through_lookback_days: num(action.click_through_lookback_window_days),
          view_through_lookback_days: num(action.view_through_lookback_window_days),
          // default_value is a plain double in account currency, not micros.
          default_value: num(valueSettings.default_value),
          always_use_default_value: bool(valueSettings.always_use_default_value),
          attribution_model: enumName(enums.AttributionModel, attribution.attribution_model),
        });
      });

      return jsonResult({
        customer_id: args.customer_id,
        filters: { statuses },
        count: actions.length,
        conversion_actions: actions,
        note:
          "Only actions with primary_for_goal=true are counted in the 'conversions' metric reported " +
          "by the other tools; secondary actions appear in 'all conversions' only. " +
          "default_value is expressed in the account currency, not micros.",
      });
    }),
  );
}
