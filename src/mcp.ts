import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "./config.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "google-ads-mcp";
export const SERVER_VERSION = "2.0.0";

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
        "Google Ads reporting, plus guarded changes on allow-listed accounts. Typical flow: call list_accessible_customers to " +
        "find reachable accounts, list_client_accounts to expand a manager account, then use " +
        "get_account_summary, get_campaigns, get_campaign_performance, get_search_terms and " +
        "get_conversion_actions against a specific customer_id. Customer IDs may be passed with or " +
        "without dashes. Monetary values are returned in the account's currency (already converted " +
        "from micros). Write tools (create_search_campaign, create_ad_group, add_keywords, add_negative_keywords, " +
        "create_responsive_search_ad, set_status, update_campaign_budget, update_campaign_bidding, set_cpc_bid, " +
        "set_conversion_action_goal) only work on accounts in the server's allow-list, never remove anything, create " +
        "campaigns paused, refuse anything that would let enabled campaigns exceed the account's monthly cap, and " +
        "validate every change with Google first; pass dry_run: true to validate without applying. Call " +
        "get_write_limits before changing budgets, and get_change_history to review what changed.",
    },
  );

  registerTools(server, config);
  return server;
}
