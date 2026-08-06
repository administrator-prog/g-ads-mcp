import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "../config.js";

import { registerGetAccountSummary } from "./get-account-summary.js";
import { registerGetCampaignPerformance } from "./get-campaign-performance.js";
import { registerGetCampaigns } from "./get-campaigns.js";
import { registerGetConversionActions } from "./get-conversion-actions.js";
import { registerGetSearchTerms } from "./get-search-terms.js";
import { registerListAccessibleCustomers } from "./list-accessible-customers.js";
import { registerListClientAccounts } from "./list-client-accounts.js";

/**
 * Registers the full tool set.
 *
 * Every tool here is read-only. There are deliberately no mutate/create/update
 * tools — adding one would also require revisiting the auth model, since a
 * single shared bearer token is a thin guard for write access.
 */
export function registerTools(server: McpServer, config: Config): void {
  registerListAccessibleCustomers(server, config);
  registerListClientAccounts(server, config);
  registerGetAccountSummary(server, config);
  registerGetCampaigns(server, config);
  registerGetCampaignPerformance(server, config);
  registerGetSearchTerms(server, config);
  registerGetConversionActions(server, config);
}
