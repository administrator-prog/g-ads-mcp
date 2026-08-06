import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "./config.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "google-ads-mcp";
export const SERVER_VERSION = "1.0.0";

/**
 * Builds a fully-configured MCP server instance.
 *
 * A fresh instance is created per request: the HTTP transport runs stateless so
 * Railway can restart or scale the service without stranding sessions.
 */
export function createMcpServer(config: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Read-only access to Google Ads reporting. Typical flow: call list_accessible_customers to " +
        "find reachable accounts, list_client_accounts to expand a manager account, then use " +
        "get_account_summary, get_campaigns, get_campaign_performance, get_search_terms and " +
        "get_conversion_actions against a specific customer_id. Customer IDs may be passed with or " +
        "without dashes. Monetary values are returned in the account's currency (already converted " +
        "from micros). This server exposes no tools that create, update or delete anything.",
    },
  );

  registerTools(server, config);
  return server;
}
