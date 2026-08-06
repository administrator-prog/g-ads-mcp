import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import type { Config } from "./config.js";

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
 * header (preferred, and what MCP clients send) or an `X-MCP-Auth` header.
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
 * Bearer-token gate for the MCP endpoint. Responds with a JSON-RPC shaped error
 * so MCP clients surface something intelligible rather than raw HTML.
 */
export function requireBearerToken(config: Config) {
  return function bearerGuard(req: Request, res: Response, next: NextFunction): void {
    const token = presentedToken(req);

    if (!token || !secretEquals(token, config.mcpAuthToken)) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="google-ads-mcp"')
        .json({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32001,
            message: "Unauthorized: a valid Authorization: Bearer <MCP_AUTH_TOKEN> header is required.",
          },
        });
      return;
    }

    next();
  };
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
