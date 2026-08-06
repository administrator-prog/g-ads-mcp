import { randomBytes } from "node:crypto";
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";

import { isSetupRequestAuthorized } from "./auth.js";
import { ADWORDS_SCOPE, type Config } from "./config.js";
import { errorFields, logger } from "./logger.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 100;

/**
 * Single-use, expiring CSRF state values for the OAuth handshake.
 *
 * Kept in process memory on purpose: the consent flow is a one-off setup step
 * completed in a single browser session, so there is nothing worth persisting.
 * The trade-off is that a redeploy (or a second Railway replica) between /auth
 * and /oauth2callback invalidates the state — just re-run /auth.
 */
class StateStore {
  private readonly states = new Map<string, number>();

  issue(): string {
    this.prune();
    if (this.states.size >= MAX_PENDING_STATES) {
      // Drop the oldest entry rather than let an attacker exhaust memory.
      const oldest = this.states.keys().next();
      if (!oldest.done) this.states.delete(oldest.value);
    }
    const state = randomBytes(32).toString("base64url");
    this.states.set(state, Date.now() + STATE_TTL_MS);
    return state;
  }

  /** Returns true only the first time a valid, unexpired state is presented. */
  consume(state: string): boolean {
    this.prune();
    const expiresAt = this.states.get(state);
    if (expiresAt === undefined) return false;
    this.states.delete(state);
    return expiresAt > Date.now();
  }

  private prune(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.states) {
      if (expiresAt <= now) this.states.delete(state);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 0; padding: 3rem 1.25rem; display: flex; justify-content: center; }
  main { max-width: 46rem; width: 100%; }
  h1 { font-size: 1.4rem; margin-top: 0; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; }
  pre { padding: 1rem; border-radius: 8px; overflow-x: auto;
        background: rgba(127,127,127,0.14); word-break: break-all; white-space: pre-wrap; }
  .warn { border-left: 4px solid #d97706; padding: 0.75rem 1rem; background: rgba(217,119,6,0.1);
          border-radius: 0 8px 8px 0; }
  .err { border-left: 4px solid #dc2626; padding: 0.75rem 1rem; background: rgba(220,38,38,0.1);
         border-radius: 0 8px 8px 0; }
  ol { padding-left: 1.25rem; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function createOAuthClient(config: Config): OAuth2Client {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.redirectUri,
  });
}

/**
 * Routes for the one-time consent flow that mints a Google Ads refresh token.
 *
 * Both routes are gated on MCP_AUTH_TOKEN: the deployment is publicly
 * reachable, and an ungated /auth would let anyone burn this OAuth client's
 * quota or land on a page that prints credentials.
 */
export function createOAuthRouter(config: Config): Router {
  const router = Router();
  const states = new StateStore();

  router.get("/auth", (req, res) => {
    if (!isSetupRequestAuthorized(req, config)) {
      logger.warn("Rejected unauthorized /auth request", { ip: req.ip });
      res.status(401).type("html").send(
        page(
          "Unauthorized",
          `<h1>Unauthorized</h1>
           <p class="err">This endpoint requires the setup token.</p>
           <p>Open <code>/auth?token=YOUR_MCP_AUTH_TOKEN</code> instead.</p>`,
        ),
      );
      return;
    }

    const authUrl = createOAuthClient(config).generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [ADWORDS_SCOPE],
      include_granted_scopes: true,
      state: states.issue(),
    });

    logger.info("Starting Google OAuth consent flow");
    res.redirect(authUrl);
  });

  router.get("/oauth2callback", async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (typeof oauthError === "string") {
      logger.warn("Google returned an OAuth error", { oauthError });
      res.status(400).type("html").send(
        page(
          "Authorization failed",
          `<h1>Authorization failed</h1>
           <p class="err">Google returned: <code>${escapeHtml(oauthError)}</code></p>
           <p>Re-run <code>/auth?token=YOUR_MCP_AUTH_TOKEN</code> to try again.</p>`,
        ),
      );
      return;
    }

    if (typeof state !== "string" || !states.consume(state)) {
      logger.warn("Rejected OAuth callback with invalid or expired state", { ip: req.ip });
      res.status(400).type("html").send(
        page(
          "Invalid state",
          `<h1>Invalid or expired state</h1>
           <p class="err">This callback did not originate from a recent <code>/auth</code> request,
              or the server restarted while consent was in progress.</p>
           <p>Start again at <code>/auth?token=YOUR_MCP_AUTH_TOKEN</code>.</p>`,
        ),
      );
      return;
    }

    if (typeof code !== "string" || code.length === 0) {
      res.status(400).type("html").send(
        page(
          "Missing code",
          `<h1>Missing authorization code</h1>
           <p class="err">Google did not return a <code>code</code> parameter.</p>`,
        ),
      );
      return;
    }

    try {
      const { tokens } = await createOAuthClient(config).getToken(code);

      if (!tokens.refresh_token) {
        logger.warn("Token exchange succeeded but returned no refresh token");
        res.status(400).type("html").send(
          page(
            "No refresh token returned",
            `<h1>No refresh token returned</h1>
             <p class="warn">Google only issues a refresh token when the app requests offline
                access <em>and</em> the user re-consents. This server already sends
                <code>access_type=offline</code> and <code>prompt=consent</code>, so this usually
                means the grant was intercepted by an existing session.</p>
             <p>Remove this app at
                <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>,
                then re-run <code>/auth?token=YOUR_MCP_AUTH_TOKEN</code>.</p>`,
          ),
        );
        return;
      }

      logger.info("OAuth consent completed; refresh token issued");

      res.type("html").send(
        page(
          "Refresh token issued",
          `<h1>Refresh token issued</h1>
           <p>Copy this value into your Railway service variables as
              <code>GOOGLE_ADS_REFRESH_TOKEN</code>, then redeploy.</p>
           <pre>${escapeHtml(tokens.refresh_token)}</pre>
           <p class="warn"><strong>Treat this like a password.</strong> It grants ongoing access to
              the Google Ads accounts you just authorized. Do not commit it, paste it into a chat,
              or leave this page open. It is shown once and is not stored by this server.</p>
           <ol>
             <li>Railway → your service → <strong>Variables</strong></li>
             <li>Set <code>GOOGLE_ADS_REFRESH_TOKEN</code> to the value above</li>
             <li>Redeploy, then check <code>GET /health</code> — <code>refreshToken</code> should read <code>true</code></li>
           </ol>`,
        ),
      );
    } catch (error) {
      logger.error("OAuth token exchange failed", errorFields(error));
      res.status(502).type("html").send(
        page(
          "Token exchange failed",
          `<h1>Token exchange failed</h1>
           <p class="err">Google rejected the authorization code.</p>
           <p>Most often this means <code>GOOGLE_REDIRECT_URI</code> does not exactly match an
              Authorized redirect URI on the OAuth client, or the code was already used.
              Check the server logs, then retry from <code>/auth?token=YOUR_MCP_AUTH_TOKEN</code>.</p>`,
        ),
      );
    }
  });

  return router;
}
