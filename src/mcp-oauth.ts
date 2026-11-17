import { createHmac, randomBytes } from "node:crypto";
import express, { Router, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { secretEquals } from "./auth.js";
import type { Config } from "./config.js";
import { logger } from "./logger.js";

/**
 * This server's own OAuth 2.1 authorization server for /mcp.
 *
 * Why: Claude's custom-connector UI cannot send a custom Authorization header,
 * but it does speak OAuth (client ID + secret, PKCE). So the server issues its
 * own tokens:
 *
 *  - One pre-registered client (MCP_OAUTH_CLIENT_ID / _SECRET), the values
 *    pasted into the connector's advanced settings. No dynamic registration,
 *    so nobody else can register a client.
 *  - /authorize shows a consent page; the owner approves with MCP_AUTH_TOKEN.
 *    Wrong passwords are rate limited.
 *  - Access tokens (1 h) and refresh tokens (30 days, rotated on use) are
 *    HMAC-signed with MCP_OAUTH_SIGNING_SECRET, so a redeploy does not log the
 *    connector out. Rotating that secret revokes every token at once.
 *  - Authorization codes live in memory for 5 minutes, single use, PKCE checked
 *    by the SDK. A redeploy mid-consent just means approving again.
 */

type OAuth = NonNullable<Config["mcpOAuth"]>;
const CODE_TTL_MS = 5 * 60 * 1000;

interface PendingCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface TokenClaims {
  typ: "access" | "refresh";
  cid: string;
  scp: string[];
  res?: string;
  exp: number;
  jti: string;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export class McpTokenSigner {
  constructor(private readonly secret: string) {}

  sign(claims: TokenClaims): string {
    const body = b64(JSON.stringify(claims));
    return `${body}.${this.mac(body)}`;
  }

  verify(token: string, typ: TokenClaims["typ"]): TokenClaims | null {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) return null;
    if (!secretEquals(mac, this.mac(body))) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenClaims;
      if (claims.typ !== typ || typeof claims.exp !== "number") return null;
      if (claims.exp < Math.floor(Date.now() / 1000)) return null;
      return claims;
    } catch {
      return null;
    }
  }

  /** Signs consent-page fields so the form cannot be tampered with between GET and POST. */
  macOf(value: string): string {
    return this.mac(`consent:${value}`);
  }

  private mac(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

export class McpOAuthProvider implements OAuthServerProvider {
  private readonly codes = new Map<string, PendingCode>();
  readonly signer: McpTokenSigner;

  constructor(private readonly oauth: OAuth, private readonly mcpAuthToken: string) {
    this.signer = new McpTokenSigner(oauth.signingSecret);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const client: OAuthClientInformationFull = {
      client_id: this.oauth.clientId,
      client_secret: this.oauth.clientSecret,
      redirect_uris: this.oauth.redirectUris,
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Claude",
    };
    return {
      getClient: (id: string) => (secretEquals(id, this.oauth.clientId) ? client : undefined),
      // No registerClient: dynamic registration is off, so /register is not served.
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request = b64(
      JSON.stringify({
        cid: client.client_id,
        ru: params.redirectUri,
        cc: params.codeChallenge,
        st: params.state ?? null,
        sc: params.scopes ?? [],
        rs: params.resource?.href ?? null,
        exp: Date.now() + 10 * 60 * 1000,
      }),
    );
    res.status(200).type("html").set("Cache-Control", "no-store").send(consentPage(request, this.signer.macOf(request)));
  }

  /** Called by the consent form's POST once the password matched. */
  approve(request: string, mac: string, password: string): { redirect: string } | { error: string } {
    if (!secretEquals(mac, this.signer.macOf(request))) return { error: "This approval link is invalid. Start the connection again from Claude." };
    let r: { cid: string; ru: string; cc: string; st: string | null; sc: string[]; rs: string | null; exp: number };
    try {
      r = JSON.parse(Buffer.from(request, "base64url").toString("utf8"));
    } catch {
      return { error: "This approval link is invalid. Start the connection again from Claude." };
    }
    if (r.exp < Date.now()) return { error: "This approval page has expired. Start the connection again from Claude." };
    if (!secretEquals(password, this.mcpAuthToken)) return { error: "Wrong password." };

    this.prune();
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      clientId: r.cid,
      codeChallenge: r.cc,
      redirectUri: r.ru,
      scopes: r.sc,
      ...(r.rs ? { resource: r.rs } : {}),
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(r.ru);
    target.searchParams.set("code", code);
    if (r.st) target.searchParams.set("state", r.st);
    logger.info("MCP connector approved", { clientId: r.cid });
    return { redirect: target.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const pending = this.liveCode(client, code);
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const pending = this.liveCode(client, code);
    if (redirectUri && redirectUri !== pending.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    this.codes.delete(code);
    return this.issue(client.client_id, pending.scopes, pending.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const claims = this.signer.verify(refreshToken, "refresh");
    if (!claims || claims.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
    return this.issue(client.client_id, claims.scp, claims.res);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = this.signer.verify(token, "access");
    if (!claims) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: claims.cid,
      scopes: claims.scp,
      expiresAt: claims.exp,
      ...(claims.res ? { resource: new URL(claims.res) } : {}),
    };
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const common = { cid: clientId, scp: scopes, ...(resource ? { res: resource } : {}) };
    return {
      access_token: this.signer.sign({ typ: "access", ...common, exp: now + this.oauth.accessTokenTtlSeconds, jti: randomBytes(9).toString("base64url") }),
      refresh_token: this.signer.sign({ typ: "refresh", ...common, exp: now + this.oauth.refreshTokenTtlSeconds, jti: randomBytes(9).toString("base64url") }),
      token_type: "bearer",
      expires_in: this.oauth.accessTokenTtlSeconds,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    };
  }

  private liveCode(client: OAuthClientInformationFull, code: string): PendingCode {
    const pending = this.codes.get(code);
    if (!pending || pending.expiresAt < Date.now() || pending.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return pending;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, p] of this.codes) if (p.expiresAt < now) this.codes.delete(code);
    while (this.codes.size > 100) this.codes.delete(this.codes.keys().next().value!);
  }
}

/** POST /authorize/approve: the consent form. Brute force is capped per IP. */
export function createConsentRouter(provider: McpOAuthProvider): Router {
  const router = Router();
  router.post(
    "/authorize/approve",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: "Too many attempts. Try again in 15 minutes." }),
    express.urlencoded({ extended: false, limit: "16kb" }),
    (req, res) => {
      const { request, mac, password } = req.body as Record<string, string | undefined>;
      const result = provider.approve(String(request ?? ""), String(mac ?? ""), String(password ?? ""));
      if ("redirect" in result) {
        res.redirect(302, result.redirect);
        return;
      }
      logger.warn("MCP connector approval refused", { reason: result.error, ip: req.ip });
      res.status(result.error === "Wrong password." ? 401 : 400).type("html").set("Cache-Control", "no-store")
        .send(consentPage(String(request ?? ""), String(mac ?? ""), result.error));
    },
  );
  return router;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function consentPage(request: string, mac: string, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Connect Google Ads</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f5fb;color:#1d1d1f;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:#fff;border:1px solid #e6e1f3;border-radius:14px;padding:28px;max-width:420px;width:100%}h1{font-size:20px;margin:0 0 8px}
p{margin:0 0 16px;color:#55555f}label{display:block;font-weight:600;margin-bottom:6px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cfc9e3;border-radius:8px;font:inherit}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:#6844ff;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer}.err{color:#c2334a;font-weight:600}</style></head>
<body><main><h1>Connect Claude to Google Ads</h1>
<p>Claude is asking for access to the Google Ads accounts this server manages. Enter the server's setup password (MCP_AUTH_TOKEN) to allow it.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize/approve"><input type="hidden" name="request" value="${esc(request)}"><input type="hidden" name="mac" value="${esc(mac)}">
<label for="password">Setup password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Allow access</button></form></main></body></html>`;
}
