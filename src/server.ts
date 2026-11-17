import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";

import type { Config } from "./config.js";
import { errorFields, logger } from "./logger.js";
import { SERVER_NAME, SERVER_VERSION, createMcpServer } from "./mcp.js";
import { createConsentRouter, McpOAuthProvider } from "./mcp-oauth.js";
import { createOAuthRouter } from "./oauth.js";

/** Request bodies are small JSON-RPC envelopes; cap them well below any abuse. */
const JSON_BODY_LIMIT = "1mb";

export function createApp(config: Config): Express {
  const app = express();

  // Railway terminates TLS at its edge, so trust its forwarding headers for
  // correct req.ip / req.protocol values in logs and redirects. The rate
  // limiter depends on this to key on the real client IP rather than the proxy.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Browser-hosted MCP clients (claude.ai connectors) are subject to CORS.
  // Nothing here is origin-gated — the MCP endpoint is public either way — so
  // this only removes a failure mode rather than granting any new access.
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Accept",
        "Authorization",
        "Mcp-Session-Id",
        "MCP-Protocol-Version",
        "Last-Event-ID",
      ],
      exposedHeaders: ["Mcp-Session-Id", "MCP-Protocol-Version"],
      maxAge: 86400,
    }),
  );

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
      // Stated plainly so the auth state is visible from outside.
      mcpAuth: config.mcpOAuth ? "oauth" : "not-configured (all /mcp requests refused)",
      writeAccounts: config.writeAccounts.size,
      mcpRateLimitPerMinute: config.mcpRateLimitPerMinute,
      configured: {
        clientId: Boolean(google.clientId),
        clientSecret: Boolean(google.clientSecret),
        developerToken: Boolean(google.developerToken),
        loginCustomerId: Boolean(google.loginCustomerId),
        refreshToken: Boolean(google.refreshToken),
        redirectUri: Boolean(google.redirectUri),
        // Guards /auth and is the MCP consent password.
        setupToken: Boolean(config.mcpAuthToken),
        mcpOAuth: Boolean(config.mcpOAuth),
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

  // --- MCP authorization -------------------------------------------------
  // /mcp needs a bearer token issued by this server's own OAuth server
  // (src/mcp-oauth.ts). Without the MCP_OAUTH_* variables it refuses every
  // request: the endpoint never falls back to being open.
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  let mcpAuth: RequestHandler;
  if (config.mcpOAuth) {
    const provider = new McpOAuthProvider(config.mcpOAuth, config.mcpAuthToken);
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(config.publicBaseUrl),
        resourceServerUrl: mcpUrl,
        resourceName: "Google Ads MCP",
      }),
    );
    app.use(createConsentRouter(provider));
    mcpAuth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  } else {
    logger.warn("MCP OAuth is not configured: /mcp will refuse every request");
    mcpAuth = (_req, res) => {
      res.status(503).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "MCP authorization is not configured on this server." } });
    };
  }

  // --- MCP ----------------------------------------------------------------
  // The rate limiter is a quota backstop for a paid API, not access control.
  const mcpMiddleware =
    config.mcpRateLimitPerMinute > 0
      ? [
          rateLimit({
            windowMs: 60_000,
            limit: config.mcpRateLimitPerMinute,
            standardHeaders: "draft-7",
            legacyHeaders: false,
            message: {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32029, message: "Rate limit exceeded. Try again shortly." },
            },
          }),
        ]
      : [];

  app.post("/mcp", ...mcpMiddleware, mcpAuth, async (req: Request, res: Response) => {
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

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // --- Root ---------------------------------------------------------------
  app.get("/", (_req, res) => {
    res.json({
      service: SERVER_NAME,
      version: SERVER_VERSION,
      description: "Google Ads MCP server (OAuth-protected; writes limited to allow-listed accounts).",
      endpoints: {
        health: "GET /health",
        auth: "GET /auth?token=<MCP_AUTH_TOKEN>",
        oauthCallback: "GET /oauth2callback",
        mcp: "POST /mcp (OAuth bearer token)",
        oauthMetadata: "GET /.well-known/oauth-authorization-server",
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
