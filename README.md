# Google Ads MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the Google Ads API, built with
Node.js + TypeScript and deployed to Railway. It serves seven reporting tools and twelve guarded write
tools over the MCP Streamable HTTP transport. `/mcp` is protected by the server's own OAuth 2.1
authorization server, which Claude's custom-connector UI supports.

**Writes are limited by the server itself, not by the caller:**
- Only accounts in `GOOGLE_ADS_WRITE_ACCOUNTS` can be changed. Every other account is read-only.
- Each writable account has a monthly cap. It is checked as (daily budgets of enabled campaigns) × 30.4,
  Google's monthly charging limit.
- New campaigns are always created paused. Switching one on needs `confirm_spend: true` and must pass
  the cap check.
- Nothing can be removed, and no tool touches billing or account access.
- Every change is validated by Google (`validate_only`) before it is applied, and logged afterwards.
  `dry_run: true` stops after validation.

---

## Endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | `/health` | none | Liveness, auth mode, and which config values are present |
| GET | `/auth` | `?token=<MCP_AUTH_TOKEN>` | Starts Google OAuth consent (mints the Google Ads refresh token) |
| GET | `/oauth2callback` | single-use `state` from `/auth` | Exchanges the code and displays the refresh token |
| GET | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` | none | OAuth discovery metadata |
| GET | `/authorize` | registered client + PKCE | Consent page for the MCP connector |
| POST | `/authorize/approve` | `MCP_AUTH_TOKEN` as the password, 10 tries per 15 min per IP | Approves the connector |
| POST | `/token` | client ID + secret, PKCE verifier | Issues access (1 h) and refresh (30 days) tokens |
| POST | `/mcp` | **OAuth bearer token** | MCP JSON-RPC endpoint |
| GET | `/` | none | Endpoint index |

There is no dynamic client registration (`/register` is not served): the only client is the one in
`MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET`. Tokens are HMAC-signed with
`MCP_OAUTH_SIGNING_SECRET`, so a redeploy does not log the connector out. Rotating that secret revokes
every token. If the `MCP_OAUTH_*` variables are unset, `/mcp` answers 503 to everything: it never falls
back to being open.

---

## Tools

| Tool | What it does |
| ---- | ------------ |
| `list_accessible_customers` | Accounts the authorized credentials can reach directly |
| `list_client_accounts` | Client accounts beneath a manager (MCC) |
| `get_account_summary` | Account settings + aggregate performance + campaign counts by status |
| `get_campaigns` | Campaign configuration: status, channel, bidding, budget, dates |
| `get_campaign_performance` | Campaign metrics over a date range, optionally segmented |
| `get_search_terms` | Actual search queries with metrics and the keyword each matched |
| `get_conversion_actions` | Conversion actions and whether each is a primary goal |
| `get_change_history` | Google's change log for the account (last 1-30 days) |
| `get_write_limits` | Whether an account is writable, its cap, and the headroom left |
| `create_search_campaign` | New Search campaign, **always paused**, with budget, bidding, locations and languages |
| `create_ad_group` | Standard Search ad group |
| `add_keywords` | Keywords (exact/phrase/broad), optional final URL and max CPC |
| `add_negative_keywords` | Negatives at campaign or ad group level |
| `create_responsive_search_ad` | Responsive search ad (3-15 headlines, 2-4 descriptions) |
| `set_status` | Pause/enable campaigns, ad groups, keywords or ads (enabling a campaign needs `confirm_spend`) |
| `update_campaign_budget` | Change a daily budget (cap-checked) |
| `update_campaign_bidding` | Maximise clicks (max CPC ceiling) or maximise conversions (optional target CPA) |
| `set_cpc_bid` | Ad group or keyword max CPC (manual bidding) |
| `set_conversion_action_goal` | Make conversion actions primary or secondary |

Shared conventions:

- **Customer IDs** may be passed with or without dashes (`123-456-7890` or `1234567890`).
- **Money** is in the account's currency, already converted from micros.
- Keyword and ad ids are composite: `<adGroupId>~<criterionId>` / `<adGroupId>~<adId>`.
- Reporting queries are assembled server-side from validated inputs. No caller-supplied GAQL is ever
  executed.

---

## Setup

### 1. Google Cloud OAuth client

1. Enable the **Google Ads API** in your Google Cloud project.
2. Create an OAuth 2.0 Client ID of type **Web application**.
3. Add this Authorized redirect URI, matching `GOOGLE_REDIRECT_URI` exactly:

   ```
   https://g-ads-production.up.railway.app/oauth2callback
   ```

4. Note the client ID and client secret.

If your OAuth consent screen is in *Testing* mode, add yourself as a test user — otherwise refresh
tokens expire after seven days.

### 2. Google Ads developer token

Google Ads → **Tools & Settings → API Center** (on a manager account). A *Basic Access* token is
enough for reporting; *Test Account* tokens only work against test accounts.

### 3. Deploy to Railway

Point a Railway service at this repository. `railway.json` sets the build command, start command,
and a `/health` healthcheck; Railway injects `PORT` automatically.

Nixpacks runs three phases, and `railway.json` must not duplicate any of them:

| Phase   | Command         | Comes from                                        |
| ------- | --------------- | ------------------------------------------------- |
| install | `npm ci`        | Nixpacks default, because `package-lock.json` exists |
| build   | `npm run build` | `railway.json` → `build.buildCommand`             |
| start   | `npm run start` | `railway.json` → `deploy.startCommand`            |

Do not put `npm ci` in `buildCommand`. Running it twice makes the second pass try to remove a
`node_modules/.cache` directory the first pass still holds open, and the build fails with
`EBUSY: resource busy or locked, rmdir '/app/node_modules/.cache'`.

Node is pinned to 20 by `engines.node` (`20.x`) in `package.json`, with `.nvmrc` matching. Nixpacks
reads `engines.node` first; an open range like `>=20.0.0` lets it select the newest available Node
instead. `@types/node` is held on `^20` so the types match the runtime.

Set these service variables:

| Variable                       | Required     | Notes                                                     |
| ------------------------------ | ------------ | ---------------------------------------------------------- |
| `GOOGLE_ADS_CLIENT_ID`         | at boot      | OAuth web client ID                                        |
| `GOOGLE_ADS_CLIENT_SECRET`     | at boot      | OAuth web client secret                                    |
| `GOOGLE_REDIRECT_URI`          | at boot      | Must exactly match the URI on the OAuth client             |
| `MCP_AUTH_TOKEN`               | at boot      | Guards `/auth` only, min 24 chars — `openssl rand -hex 32` |
| `GOOGLE_ADS_DEVELOPER_TOKEN`   | for tools    | From the Google Ads API Center                             |
| `GOOGLE_ADS_REFRESH_TOKEN`     | for tools    | Produced by step 4 below                                   |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | for MCC use  | Manager account ID, digits only                            |
| `MCP_RATE_LIMIT_PER_MINUTE`    | optional     | Per-IP cap on `/mcp`, default `120`, `0` disables          |

The server boots with only the four boot-critical variables set, so you can run the OAuth flow
before you have a refresh token. Tools return a clear configuration error until the rest are set,
and `/health` reports `status: "degraded"`.

Missing a boot-critical variable exits with a descriptive log line rather than serving traffic.

### 4. Mint the refresh token

Open in a browser:

```
https://g-ads-production.up.railway.app/auth?token=YOUR_MCP_AUTH_TOKEN
```

The flow requests scope `https://www.googleapis.com/auth/adwords` with `access_type=offline` and
`prompt=consent`. After you approve, the callback page displays the refresh token once. Copy it into
Railway as `GOOGLE_ADS_REFRESH_TOKEN` and redeploy.

The token is **displayed only** — this server never stores or logs it. Treat the page like a
password prompt and close it when you're done.

If no refresh token comes back, revoke the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and re-run `/auth`.

### 5. Verify

```bash
curl https://g-ads-production.up.railway.app/health
```

`status` should be `ok` and every entry under `configured` should be `true`.

---

## Connecting an MCP client

### Claude custom connector

**Settings → Connectors → Add custom connector**, then:

- URL: `https://g-ads-production.up.railway.app/mcp`
- Advanced settings → **OAuth Client ID**: the value of `MCP_OAUTH_CLIENT_ID`
- **OAuth Client Secret**: the value of `MCP_OAUTH_CLIENT_SECRET`

Claude then opens this server's consent page. Enter `MCP_AUTH_TOKEN` as the setup password to allow it.
The connector refreshes its own tokens after that, for 30 days at a time.

These are the connector's credentials *for this server*. They are unrelated to
`GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET`, which authenticate this server *to Google*.

### Config-file clients

```json
{
  "mcpServers": {
    "google-ads": {
      "type": "http",
      "url": "https://g-ads-production.up.railway.app/mcp"
    }
  }
}
```

For Claude Code:

```bash
claude mcp add --transport http google-ads \
  https://g-ads-production.up.railway.app/mcp
```

Quick manual check:

```bash
curl -s -X POST https://g-ads-production.up.railway.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Local development

```bash
npm install
cp .env.example .env      # fill it in; .env is gitignored
npm run dev               # tsx watch on http://localhost:8080
```

```bash
npm run typecheck         # tsc --noEmit
npm run build             # compile to dist/
npm start                 # run the compiled server
```

Use Node 20 locally to match production (`nvm use` picks it up from `.nvmrc`). Newer Node still
works, but npm will warn `EBADENGINE` against the pinned `engines.node`.

For local OAuth, add `http://localhost:8080/oauth2callback` as a second authorized redirect URI on
the OAuth client and set `GOOGLE_REDIRECT_URI` to match.

Set `LOG_LEVEL=debug` to log every generated GAQL query — the fastest way to diagnose an API
rejection.

---

## Architecture

```
src/
  index.ts               entry point, lifecycle, signal handling
  server.ts              Express app: routes, health, MCP transport wiring
  mcp.ts                 MCP server construction
  config.ts              environment loading and validation
  auth.ts                constant-time bearer-token checks
  oauth.ts               /auth and /oauth2callback, CSRF state store
  logger.ts              structured JSON logging
  google-ads/
    client.ts            Google Ads client, error normalisation, enum decoding
    gaql.ts              validated query assembly, date-range handling
    format.ts            micros/int64 conversion, metric derivation
  tools/
    shared.ts            schemas, handler wrapper, result helpers
    index.ts             tool registration
    <one file per tool>
```

**Stateless MCP transport.** Each POST to `/mcp` gets a fresh `McpServer` and
`StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`. No session affinity is needed,
so Railway can restart or scale the service without stranding in-flight sessions. `GET`/`DELETE` on
`/mcp` return `405` with an explanatory JSON-RPC error rather than a bare 404.

**Error handling.** Tool failures return MCP error *results* (`isError: true`) with an actionable
message, not transport exceptions. `GoogleAdsFailure` responses are unpacked into their individual
error messages and codes.

**Google Ads API version.** Pinned by `google-ads-api@24` (currently v24). All selected field paths
were validated against the v24 protobuf descriptors. When bumping the client major version, re-check
field names — v21, for example, replaced `campaign.start_date` with `campaign.start_date_time`.

---

## Security notes

- `/mcp` needs a bearer token from this server's OAuth flow. Approving a connection needs
  `MCP_AUTH_TOKEN`; wrong passwords are limited to 10 per 15 minutes per IP.
- Only one OAuth client exists (no dynamic registration), its redirect URIs are fixed
  (`MCP_OAUTH_REDIRECT_URIS`, default Claude's callbacks), PKCE (S256) is required, and codes are
  single use and expire in 5 minutes.
- The consent form's hidden fields are HMAC-signed, so the redirect URI cannot be swapped between the
  consent page and approval.
- Access tokens last 1 hour, refresh tokens 30 days. Both are HMAC-signed and typed, so neither can be
  used as the other. To revoke every token, rotate `MCP_OAUTH_SIGNING_SECRET`.
- Writes: see the rules at the top. Accounts not in `GOOGLE_ADS_WRITE_ACCOUNTS` are read-only, and
  raising a cap is a deliberate config change.
- `/auth` still requires `MCP_AUTH_TOKEN`, because `/oauth2callback` displays a refresh token. The
  refresh token is shown once and never persisted or logged by this server.
- No Google credential is ever returned by any endpoint. `/health` reports presence booleans only.
- Rate limiting on `/mcp` (default 120/min per IP) stays as a quota backstop.

---

## A note on the client library

Google does not publish an official Node.js client for the Google Ads API (its official libraries
cover Java, .NET, PHP, Python, Ruby and Perl). This server uses
[`google-ads-api`](https://www.npmjs.com/package/google-ads-api), the de-facto standard community
client, which wraps Google's own generated `google-ads-node` gRPC bindings. OAuth uses Google's
official [`google-auth-library`](https://www.npmjs.com/package/google-auth-library).

## License

MIT
