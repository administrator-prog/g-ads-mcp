import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { requireBearerToken } from "./auth.js";
import type { Config } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { SERVER_NAME, SERVER_VERSION, createMcpServer } from "./mcp.js";
import { createOAuthRouter } from "./oauth.js";

/** Request bodies are small JSON-RPC envelopes; cap them well below any abuse. */
const JSON_BODY_LIMIT = "1mb";

export function createApp(config: Config): Express {
  const app = express();

  // Railway terminates TLS at its edge, so trust its forwarding headers for
  // correct req.ip / req.protocol values in logs and redirects.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use((req, res, next) => {
    const requestId = req.get("x-request-id") ?? randomUUID();
    res.setHeader("x-request-id", requestId);
    const startedAt = Date.now();

    res.on("finish", () => {
      logger.debug("Request completed", {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  });

  // --- Health -------------------------------------------------------------
  // Unauthenticated on purpose so Railway's healthcheck can reach it. Reports
  // only whether each secret is present, never its value.
  app.get("/health", (_req, res) => {
    const google = config.google;
    const ready = Boolean(google.developerToken && google.refreshToken);

    res.status(200).json({
      status: ready ? "ok" : "degraded",
      service: SERVER_NAME,
      version: SERVER_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      configured: {
        clientId: Boolean(google.clientId),
        clientSecret: Boolean(google.clientSecret),
        developerToken: Boolean(google.developerToken),
        loginCustomerId: Boolean(google.loginCustomerId),
        refreshToken: Boolean(google.refreshToken),
        redirectUri: Boolean(google.redirectUri),
        mcpAuthToken: Boolean(config.mcpAuthToken),
      },
      ...(ready
        ? {}
        : {
            hint:
              "Set GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_REFRESH_TOKEN. " +
              "Visit /auth?token=<MCP_AUTH_TOKEN> to mint a refresh token.",
          }),
    });
  });

  // --- OAuth setup flow ---------------------------------------------------
  app.use(createOAuthRouter(config));

  // --- MCP ----------------------------------------------------------------
  const mcpGuard = requireBearerToken(config);

  app.post("/mcp", mcpGuard, async (req: Request, res: Response) => {
    // Stateless mode: a new server + transport per request means no session
    // affinity is required and a redeploy cannot orphan in-flight sessions.
    const server = createMcpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("MCP request failed", errorFields(error));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal server error" },
        });
      }
    }
  });

  // Stateless transports cannot serve a standalone SSE stream or a session
  // teardown, so answer both explicitly instead of falling through to 404.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "This MCP endpoint is stateless; use POST for all JSON-RPC requests.",
      },
    });
  };

  app.get("/mcp", mcpGuard, methodNotAllowed);
  app.delete("/mcp", mcpGuard, methodNotAllowed);

  // --- Root ---------------------------------------------------------------
  app.get("/", (_req, res) => {
    res.json({
      service: SERVER_NAME,
      version: SERVER_VERSION,
      description: "Read-only Google Ads MCP server.",
      endpoints: {
        health: "GET /health",
        auth: "GET /auth?token=<MCP_AUTH_TOKEN>",
        oauthCallback: "GET /oauth2callback",
        mcp: "POST /mcp (Authorization: Bearer <MCP_AUTH_TOKEN>)",
      },
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled request error", errorFields(error));
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
