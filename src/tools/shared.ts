import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { GoogleAdsClient, type GoogleAdsToolError, toToolError } from "../google-ads/client.js";
import { errorFields, logger } from "../logger.js";

/**
 * Helpers shared by every tool module.
 *
 * Kept separate from ./index.ts, which imports the tool modules: putting these
 * there too would create an import cycle whose module-level schema constants
 * evaluate before initialisation.
 */

/** Every tool in this server is read-only; these annotations say so. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const customerIdSchema = z
  .string()
  .min(1)
  .describe("Google Ads customer ID, with or without dashes (e.g. 123-456-7890 or 1234567890).");

export function limitSchema(fallback: number, max: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(fallback)
    .describe(`Maximum rows to return (1-${max}).`);
}

export function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error: GoogleAdsToolError): CallToolResult {
  const lines = [error.message, ...error.details.map((detail) => `- ${detail}`)];
  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

/**
 * Wraps a tool handler so any failure becomes a structured MCP error result
 * rather than a transport-level exception, and so every call is logged.
 */
export function toolHandler<Args>(
  name: string,
  config: Config,
  run: (client: GoogleAdsClient, args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    const startedAt = Date.now();
    try {
      const client = GoogleAdsClient.fromConfig(config);
      const result = await run(client, args);
      logger.info("Tool call succeeded", { tool: name, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      const toolError = toToolError(error);
      logger.warn("Tool call failed", {
        tool: name,
        durationMs: Date.now() - startedAt,
        ...errorFields(toolError),
        details: toolError.details,
      });
      return errorResult(toolError);
    }
  };
}
