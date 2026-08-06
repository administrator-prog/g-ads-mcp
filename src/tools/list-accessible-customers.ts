import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "../config.js";
import { READ_ONLY_ANNOTATIONS, jsonResult, toolHandler } from "./shared.js";

export function registerListAccessibleCustomers(server: McpServer, config: Config): void {
  server.registerTool(
    "list_accessible_customers",
    {
      title: "List accessible Google Ads customers",
      description:
        "Lists the Google Ads accounts the authorized credentials can reach directly. These are " +
        "top-level accounts (usually manager/MCC accounts) — use list_client_accounts to expand a " +
        "manager account into the client accounts beneath it. Start here when you do not yet know " +
        "which customer ID to query.",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    toolHandler("list_accessible_customers", config, async (client) => {
      const customerIds = await client.listAccessibleCustomerIds();

      return jsonResult({
        login_customer_id: client.defaultManagerId ?? null,
        count: customerIds.length,
        customers: customerIds.map((id) => ({
          customer_id: id,
          resource_name: `customers/${id}`,
        })),
        note:
          "Accessible accounts are those directly linked to the authorized Google account. " +
          "Accounts managed under an MCC appear via list_client_accounts.",
      });
    }),
  );
}
