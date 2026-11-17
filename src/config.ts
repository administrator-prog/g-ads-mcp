import "dotenv/config";

/**
 * Centralised environment handling.
 *
 * Two tiers of configuration:
 *   - Boot-critical: without these the server cannot serve anything safely, so
 *     we fail fast with a clear message rather than come up half-working.
 *   - Ads-critical: only needed once tools are actually invoked. These are
 *     deliberately optional at boot so a fresh deploy can still run the OAuth
 *     flow at /auth to mint the refresh token (chicken-and-egg on first setup).
 *
 * /mcp is protected by this server's own OAuth 2.1 authorization server
 * (src/mcp-oauth.ts): Claude's custom-connector UI takes an OAuth client ID and
 * secret, and the owner approves the connection once with MCP_AUTH_TOKEN. With
 * the OAuth variables unset, /mcp refuses every request (fails closed).
 * MCP_AUTH_TOKEN also still guards /auth, which displays a Google refresh token.
 */

export interface Config {
  port: number;
  logLevel: LogLevel;
  nodeEnv: string;
  /** Guards /auth (Google consent) and is the password on the MCP consent page. */
  mcpAuthToken: string;
  /** Public origin of this server, e.g. https://g-ads-production.up.railway.app */
  publicBaseUrl: string;
  /** OAuth for /mcp. Undefined when not configured: /mcp then refuses everything. */
  mcpOAuth:
    | {
        clientId: string;
        clientSecret: string;
        signingSecret: string;
        redirectUris: string[];
        accessTokenTtlSeconds: number;
        refreshTokenTtlSeconds: number;
      }
    | undefined;
  /**
   * Accounts write tools may change, with each account's monthly spend cap in
   * the account's own currency. Any account not listed is read-only.
   */
  writeAccounts: Map<string, { monthlyCap: number }>;
  /** Requests per minute per IP allowed on /mcp. 0 disables the limiter. */
  mcpRateLimitPerMinute: number;
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    developerToken: string | undefined;
    loginCustomerId: string | undefined;
    refreshToken: string | undefined;
  };
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** OAuth scope required for every Google Ads API call. */
export const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords";

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Customer IDs are stored digits-only; users routinely paste the dashed form. */
export function normalizeCustomerId(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value && (LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }
  return "info";
}

export function loadConfig(): Config {
  const missing: string[] = [];

  const clientId = readEnv("GOOGLE_ADS_CLIENT_ID");
  const clientSecret = readEnv("GOOGLE_ADS_CLIENT_SECRET");
  const redirectUri = readEnv("GOOGLE_REDIRECT_URI");
  const mcpAuthToken = readEnv("MCP_AUTH_TOKEN");

  if (!clientId) missing.push("GOOGLE_ADS_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_ADS_CLIENT_SECRET");
  if (!redirectUri) missing.push("GOOGLE_REDIRECT_URI");
  if (!mcpAuthToken) missing.push("MCP_AUTH_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `See .env.example for the full list.`,
    );
  }

  // A guessable shared secret is worse than an obvious misconfiguration.
  if (mcpAuthToken!.length < 24) {
    throw new Error(
      "MCP_AUTH_TOKEN must be at least 24 characters. Generate one with: openssl rand -hex 32",
    );
  }

  const loginCustomerId = readEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
  const port = Number.parseInt(readEnv("PORT") ?? "8080", 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const rateLimit = Number.parseInt(readEnv("MCP_RATE_LIMIT_PER_MINUTE") ?? "120", 10);

  if (!Number.isInteger(rateLimit) || rateLimit < 0) {
    throw new Error(
      `Invalid MCP_RATE_LIMIT_PER_MINUTE: ${process.env.MCP_RATE_LIMIT_PER_MINUTE}. ` +
        `Expected a non-negative integer (0 disables the limiter).`,
    );
  }

  const publicBaseUrl = (readEnv("PUBLIC_BASE_URL") ?? new URL(redirectUri!).origin).replace(/\/$/, "");

  const oauthClientId = readEnv("MCP_OAUTH_CLIENT_ID");
  const oauthClientSecret = readEnv("MCP_OAUTH_CLIENT_SECRET");
  const oauthSigningSecret = readEnv("MCP_OAUTH_SIGNING_SECRET");
  let mcpOAuth: Config["mcpOAuth"];
  if (oauthClientId || oauthClientSecret || oauthSigningSecret) {
    const missingOAuth = [
      ["MCP_OAUTH_CLIENT_ID", oauthClientId],
      ["MCP_OAUTH_CLIENT_SECRET", oauthClientSecret],
      ["MCP_OAUTH_SIGNING_SECRET", oauthSigningSecret],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missingOAuth.length > 0) {
      throw new Error(`Incomplete MCP OAuth configuration. Missing: ${missingOAuth.join(", ")}.`);
    }
    for (const [name, value] of [["MCP_OAUTH_CLIENT_SECRET", oauthClientSecret], ["MCP_OAUTH_SIGNING_SECRET", oauthSigningSecret]] as const) {
      if (value!.length < 32) {
        throw new Error(`${name} must be at least 32 characters. Generate one with: openssl rand -hex 32`);
      }
    }
    mcpOAuth = {
      clientId: oauthClientId!,
      clientSecret: oauthClientSecret!,
      signingSecret: oauthSigningSecret!,
      redirectUris: (readEnv("MCP_OAUTH_REDIRECT_URIS") ??
        "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback")
        .split(",").map((u) => u.trim()).filter(Boolean),
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 3600,
    };
  }

  return {
    port,
    publicBaseUrl,
    mcpOAuth,
    writeAccounts: parseWriteAccounts(readEnv("GOOGLE_ADS_WRITE_ACCOUNTS")),
    logLevel: parseLogLevel(readEnv("LOG_LEVEL")),
    nodeEnv: readEnv("NODE_ENV") ?? "production",
    mcpAuthToken: mcpAuthToken!,
    mcpRateLimitPerMinute: rateLimit,
    google: {
      clientId: clientId!,
      clientSecret: clientSecret!,
      redirectUri: redirectUri!,
      developerToken: readEnv("GOOGLE_ADS_DEVELOPER_TOKEN"),
      loginCustomerId: loginCustomerId
        ? normalizeCustomerId(loginCustomerId)
        : undefined,
      refreshToken: readEnv("GOOGLE_ADS_REFRESH_TOKEN"),
    },
  };
}

/**
 * GOOGLE_ADS_WRITE_ACCOUNTS: comma-separated "customerId:monthlyCap" pairs, the
 * cap in the account's own currency, e.g. "937-504-8103:400". Every account not
 * listed stays read-only, whatever the caller asks.
 */
export function parseWriteAccounts(raw: string | undefined): Map<string, { monthlyCap: number }> {
  const accounts = new Map<string, { monthlyCap: number }>();
  if (!raw) return accounts;
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [idPart, capPart] = entry.split(":");
    const id = normalizeCustomerId(idPart ?? "");
    const cap = Number(capPart);
    if (id.length < 7 || !Number.isFinite(cap) || cap <= 0) {
      throw new Error(
        `Invalid GOOGLE_ADS_WRITE_ACCOUNTS entry "${entry}". Expected customerId:monthlyCap, e.g. 937-504-8103:400.`,
      );
    }
    accounts.set(id, { monthlyCap: cap });
  }
  return accounts;
}
