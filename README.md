# Google Ads MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the Google Ads API,
built with Node.js + TypeScript and deployable to Railway as a standard HTTP service.

It exposes seven reporting tools over the MCP Streamable HTTP transport, plus a built-in OAuth flow
for minting the Google Ads refresh token during setup.

**This server contains no write tools.** Every tool reads; nothing creates, updates, or deletes.

---

## Endpoints

| Method | Path              | Auth                        | Purpose                                           |
| ------ | ----------------- | --------------------------- | ------------------------------------------------- |
| GET    | `/health`         | none                        | Liveness + which config values are present        |
| GET    | `/auth`           | `?token=<MCP_AUTH_TOKEN>`   | Starts Google OAuth consent                       |
| GET    | `/oauth2callback` | single-use `state` from `/auth` | Exchanges the code and displays the refresh token |
| POST   | `/mcp`            | **none**                    | MCP JSON-RPC endpoint                             |
| GET    | `/`               | none                        | Endpoint index                                    |

`/health` never returns secret values — only booleans indicating whether each variable is set.

> ### ⚠️ The MCP endpoint is unauthenticated
>
> `POST /mcp` requires no credentials. **Anyone who knows this server's URL can read every Google
> Ads account the configured refresh token can reach** — spend, search terms, conversion actions.
>
> This is deliberate. The Claude custom connector UI accepts only an OAuth client ID and secret and
> provides no way to attach a custom `Authorization` header, so a bearer-token gate made the server
> impossible to add as a connector.
>
> `MCP_AUTH_TOKEN` still exists and is still required — it guards `/auth`, which displays a Google
> refresh token. It no longer has any effect on `/mcp`.
>
> See [Hardening a public endpoint](#hardening-a-public-endpoint) for ways to reduce the exposure
> without breaking connector support.

---

## Tools

| Tool                       | What it returns                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `list_accessible_customers` | Accounts the authorized credentials can reach directly                                            |
| `list_client_accounts`      | Client accounts beneath a manager (MCC), with name, currency, time zone, status, level             |
| `get_account_summary`       | Account settings + aggregate performance for a date range + campaign counts by status              |
| `get_campaigns`             | Campaign configuration: status, channel type, bidding strategy, budget, flight dates               |
| `get_campaign_performance`  | Campaign metrics over a date range, optionally segmented by date/week/month/device/network         |
| `get_search_terms`          | Actual search queries with metrics, match type, and the keyword each one matched                   |
| `get_conversion_actions`    | Conversion actions with type, category, counting method, lookback windows, default value           |

Shared conventions:

- **Customer IDs** may be passed with or without dashes (`123-456-7890` or `1234567890`).
- **Date ranges** accept either a `date_range` constant (`LAST_30_DAYS`, `THIS_MONTH`, …) or an
  explicit `start_date` + `end_date` pair in `YYYY-MM-DD`.
- **Money** is returned in the account's currency, already converted from micros.
- **Derived metrics** (CTR, average CPC, cost per conversion, ROAS, conversion rate) are computed
  from the raw counters in the same response, so they always agree with them.
- Every tool is annotated `readOnlyHint: true`.

Queries are assembled server-side from validated, allow-listed inputs — no caller-supplied GAQL is
ever executed.

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

No credentials are needed — just the URL.

### Claude custom connector

**Settings → Connectors → Add custom connector**, then enter:

```
https://g-ads-production.up.railway.app/mcp
```

Leave the OAuth **Client ID** and **Client Secret** fields blank. The server does not advertise an
OAuth authorization server, so the connector attaches directly over Streamable HTTP.

Those fields are for authenticating the connector *to this server*. They are unrelated to
`GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET`, which authenticate this server *to Google* and
belong in Railway's variables. Do not paste your Google credentials into the connector UI.

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

- **`POST /mcp` is unauthenticated.** Anyone with the URL can read the authorized Google Ads
  accounts. See the warning under [Endpoints](#endpoints) and the hardening options below.
- `/auth` still requires `MCP_AUTH_TOKEN`, compared in constant time, because `/oauth2callback`
  displays a refresh token.
- OAuth uses single-use, 10-minute, cryptographically random `state` values. Because they live in
  process memory, a redeploy between `/auth` and `/oauth2callback` invalidates the flow — just start
  over. The same applies if you run more than one replica.
- The refresh token is displayed once and never persisted or logged by this server.
- No Google credential — client secret, developer token, or refresh token — is ever returned by any
  endpoint. `/health` reports presence booleans only. Tool errors carry Google's own message text
  and the *names* of missing variables, never their values.
- Every tool is read-only, which bounds the damage from the open endpoint to disclosure. **Do not
  add write tools while `/mcp` is unauthenticated** — that would let anonymous callers change live
  ad spend.
- No secrets are committed; `.env` is gitignored and `.env.example` contains placeholders only.

### Hardening a public endpoint

All of these keep Claude connector compatibility:

1. **Secret URL.** Move the endpoint to an unguessable path (`/mcp/<random>`) and treat the URL as
   the credential. Connectors accept any URL, so this costs nothing at the client. It is bearer-token
   security with the token in the path — keep it out of screenshots and logs.
2. **Rate limiting.** On by default: 120 requests/minute per IP, tunable with
   `MCP_RATE_LIMIT_PER_MINUTE` (`0` disables). This is a quota and cost backstop, not access control.
3. **Network restrictions.** Put the service behind Cloudflare Access or a similar reverse proxy that
   can allow-list by IP or identity ahead of Railway.
4. **Proper OAuth.** The spec-correct fix is to implement the
   [MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization)
   so the server acts as an OAuth 2.0 resource server — that is exactly what the connector's Client
   ID and Client Secret fields are for. It is a real piece of work (metadata discovery, client
   registration, authorize/token endpoints, PKCE, token validation) and is not implemented here.
5. **Scope the credentials.** Authorize the refresh token against only the accounts this server
   needs, rather than a top-level MCC, so an exposed endpoint reveals less.

---

## A note on the client library

Google does not publish an official Node.js client for the Google Ads API (its official libraries
cover Java, .NET, PHP, Python, Ruby and Perl). This server uses
[`google-ads-api`](https://www.npmjs.com/package/google-ads-api), the de-facto standard community
client, which wraps Google's own generated `google-ads-node` gRPC bindings. OAuth uses Google's
official [`google-auth-library`](https://www.npmjs.com/package/google-auth-library).

## License

MIT
