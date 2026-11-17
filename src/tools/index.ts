import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "../config.js";

import { registerGetAccountSummary } from "./get-account-summary.js";
import { registerGetCampaignPerformance } from "./get-campaign-performance.js";
import { registerGetCampaigns } from "./get-campaigns.js";
import { registerGetConversionActions } from "./get-conversion-actions.js";
import { registerGetSearchTerms } from "./get-search-terms.js";
import { registerListAccessibleCustomers } from "./list-accessible-customers.js";
import { registerListClientAccounts } from "./list-client-accounts.js";
import { registerWriteTools } from "./write-tools.js";

/**
 * Registers the full tool set: the read-only reporting tools, plus the write
 * tools (src/tools/write-tools.ts). Writes are only possible because /mcp is
 * now behind OAuth, and only on accounts in GOOGLE_ADS_WRITE_ACCOUNTS.
 */
export function registerTools(server: McpServer, config: Config): void {
  registerListAccessibleCustomers(server, config);
  registerListClientAccounts(server, config);
  registerGetAccountSummary(server, config);
  registerGetCampaigns(server, config);
  registerGetCampaignPerformance(server, config);
  registerGetSearchTerms(server, config);
  registerGetConversionActions(server, config);
  registerWriteTools(server, config);
}
