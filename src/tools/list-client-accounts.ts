import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { GoogleAdsToolError, enumName, enums } from "../google-ads/client.js";
import { buildQuery } from "../google-ads/gaql.js";
import { bool, compact, num, str } from "../google-ads/format.js";
import { READ_ONLY_ANNOTATIONS, customerIdSchema, jsonResult, limitSchema, toolHandler } from "./shared.js";

const inputSchema = {
  manager_customer_id: customerIdSchema
    .optional()
    .describe(
      "Manager (MCC) account to expand. Defaults to GOOGLE_ADS_LOGIN_CUSTOMER_ID when configured.",
    ),
  include_hidden: z
    .boolean()
    .default(false)
    .describe("Include accounts hidden in the Google Ads UI."),
  include_disabled: z
    .boolean()
    .default(false)
    .describe("Include cancelled/suspended/closed accounts alongside enabled ones."),
  include_managers: z
    .boolean()
    .default(true)
    .describe("Include sub-manager accounts in the results, not just leaf advertising accounts."),
  limit: limitSchema(200, 1000),
};

export function registerListClientAccounts(server: McpServer, config: Config): void {
  server.registerTool(
    "list_client_accounts",
    {
      title: "List client accounts under a manager",
      description:
        "Expands a Google Ads manager (MCC) account into every client account beneath it, including " +
        "nested sub-managers, with name, currency, time zone and status. Use this to resolve an " +
        "advertiser name to the customer ID required by the reporting tools.",
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler<{
      manager_customer_id?: string;
      include_hidden?: boolean;
      include_disabled?: boolean;
      include_managers?: boolean;
      limit?: number;
    }>("list_client_accounts", config, async (client, args) => {
      const managerId = args.manager_customer_id ?? client.defaultManagerId;

      if (!managerId) {
        throw new GoogleAdsToolError(
          "No manager account specified.",
          [
            "Pass manager_customer_id explicitly, or set GOOGLE_ADS_LOGIN_CUSTOMER_ID.",
            "Run list_accessible_customers to find candidate manager account IDs.",
          ],
        );
      }

      const gaql = buildQuery({
        select: [
          "customer_client.client_customer",
          "customer_client.id",
          "customer_client.descriptive_name",
          "customer_client.currency_code",
          "customer_client.time_zone",
          "customer_client.manager",
          "customer_client.test_account",
          "customer_client.level",
          "customer_client.status",
          "customer_client.hidden",
        ],
        from: "customer_client",
        // `hidden` filters reliably server-side; status/manager are filtered in
        // code below so a single query serves every combination of flags.
        where: [args.include_hidden ? undefined : "customer_client.hidden = FALSE"],
        orderBy: "customer_client.level ASC, customer_client.id ASC",
        limit: args.limit ?? 200,
      });

      const rows = await client.query(managerId, gaql);

      const accounts = rows
        .map((row) => {
          const entry = (row.customer_client ?? {}) as Record<string, unknown>;
          const id = num(entry.id);
          return {
            customer_id: id !== undefined ? String(id) : undefined,
            resource_name: str(entry.client_customer),
            name: str(entry.descriptive_name),
            currency_code: str(entry.currency_code),
            time_zone: str(entry.time_zone),
            status: enumName(enums.CustomerStatus, entry.status),
            level: num(entry.level),
            is_manager: bool(entry.manager) ?? false,
            is_test_account: bool(entry.test_account) ?? false,
            is_hidden: bool(entry.hidden) ?? false,
          };
        })
        .filter((account) => account.customer_id !== undefined)
        .filter((account) => (args.include_managers === false ? !account.is_manager : true))
        .filter((account) =>
          args.include_disabled ? true : account.status === undefined || account.status === "ENABLED",
        )
        .map((account) => compact(account));

      return jsonResult({
        manager_customer_id: managerId,
        count: accounts.length,
        accounts,
        note:
          "level 0 is the manager account itself; level 1+ are accounts beneath it. " +
          "Accounts with is_manager=true are sub-managers and hold no campaigns of their own.",
      });
    }),
  );
}
