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
 * MCP_AUTH_TOKEN no longer guards /mcp — the Claude custom-connector UI cannot
 * send a custom Authorization header. It is still required, because it guards
 * /auth, which displays a Google refresh token.
 */

export interface Config {
  port: number;
  logLevel: LogLevel;
  nodeEnv: string;
  /** Guards the OAuth setup flow only. Not used by the MCP endpoint. */
  mcpAuthToken: string;
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

  return {
    port,
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
