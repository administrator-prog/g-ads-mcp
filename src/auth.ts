import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

import type { Config } from "./config.js";

/**
 * Authorization for the Google OAuth setup flow (/auth), which displays a
 * Google Ads refresh token. /mcp has its own OAuth server: src/mcp-oauth.ts.
 */

/** Constant-time comparison that does not leak length via early return. */
export function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not trivially reveal length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extracts the presented secret from either an `Authorization: Bearer <token>`
 * header or an `X-MCP-Auth` header.
 */
function presentedToken(req: Request): string | undefined {
  const authorization = req.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  const custom = req.get("x-mcp-auth");
  return custom ? custom.trim() : undefined;
}

/**
 * Gate for the human-facing OAuth entry point. The token may be supplied as a
 * header or as a `?token=` query parameter, because this URL is opened in a
 * browser where headers cannot be set.
 */
export function isSetupRequestAuthorized(req: Request, config: Config): boolean {
  const header = presentedToken(req);
  if (header && secretEquals(header, config.mcpAuthToken)) return true;

  const query = req.query.token;
  if (typeof query === "string" && secretEquals(query, config.mcpAuthToken)) return true;

  return false;
}
