# MCP connector (use the CRM from Claude)

The app serves a remote MCP server at `/mcp`, so the Wholesale CRM can be added
to Claude as a **custom connector** (claude.ai, Claude Desktop, mobile) or to
Claude Code. It is read only and gives Claude the same data as the
[Reporting API](REPORTING_API.md).

- Code: `lib/mcp-server.js` (tools, `/mcp` endpoint), `lib/mcp-oauth.js` (sign-in).
- Tests: `test/mcp.test.js` (`npm test`).
- Connector URL: `https://shopify-staff-assignment-app-pi.vercel.app/mcp`
  (or whatever host the app is deployed on, plus `/mcp`).

## Setup (Vercel → Project → Settings → Environment Variables)

| Variable | Required | Value |
|---|---|---|
| `REPORTING_API_KEY` | yes | Already set for the Reporting API. The connector is off (`503`) until it is set. The same key is what you type on the connector's sign-in page. |
| `DATABASE_URL` / `POSTGRES_URL` | yes in production | Already set (Neon). Connector sign-ins live in the `mcp_oauth_clients` and `mcp_oauth_tokens` tables, created automatically. Without Postgres they are kept in memory and lost on every cold start. |
| `MCP_PUBLIC_URL` | no | Pin the public origin (e.g. `https://crm.example.com`) if a proxy rewrites the Host header. Normally leave it unset: the origin comes from the request. |
| `MCP_OAUTH_REDIRECT_HOSTS` | no | Extra hosts allowed as OAuth redirect targets, comma-separated (e.g. `chatgpt.com`). By default only `claude.ai`, `claude.com` and loopback addresses (Claude Code) are allowed. |

No new secrets are needed. Redeploy after changing any of these.

## Add it to Claude

### claude.ai / Claude Desktop / mobile

1. **Settings → Connectors → Add custom connector** (on Team/Enterprise an
   owner adds it under Organization settings first).
2. Name: `Wholesale CRM`. URL: `https://<app-host>/mcp`.
3. Authentication: **Sign in when needed** (or Sign in now). OAuth client:
   **Register automatically**. Leave everything under Advanced at its default.
4. Click **Connect**. A page titled *Connect Wholesale CRM* opens on the app's
   own domain. Paste the **Reporting API key** (managers can copy it from the
   app's **API** page) and click **Approve**. You land back in Claude.
5. In a chat, enable the connector from the tools menu and ask things like
   "Which accounts haven't ordered in 90 days?" or "Commission report for October".

Claude refreshes the token by itself. If you rotate `REPORTING_API_KEY`, the
connection stops working once the old key is removed; click **Connect** again
and paste the new key.

### Claude Code

Either sign in with OAuth (same consent page, opens in your browser):

```bash
claude mcp add --transport http wholesale-crm https://<app-host>/mcp
# then run /mcp in Claude Code and choose "Authenticate"
```

or skip OAuth and send the reporting key as a header (keep it out of shared
config files):

```bash
claude mcp add --transport http wholesale-crm https://<app-host>/mcp \
  --header "Authorization: Bearer $REPORTING_API_KEY"
```

The header form also works for any MCP client that supports static headers
(including the claude.ai *Request headers* beta, where available).

## Tools

All tools are read only (`readOnlyHint`). Dates are `YYYY-MM-DD` UTC days,
inclusive; ranges default to year to date. Money is USD, net of refunds.

| Tool | What it returns |
|---|---|
| `crm_status` | Order sync status, oldest/newest order, company list age. |
| `search_companies` | Companies with rep, status, last order, lifetime and range revenue. Filters: `query` (name/email/phone/rep), `status`, `rep` (`unassigned` works), `sample_status`; `sort`; `limit` (default 25, max 100) + `offset`. |
| `get_company` | One company by `company_id` or `company_name`: contacts, locations, rep, sample box, totals, monthly revenue, top products. Ambiguous names return candidates. |
| `list_orders` | Raw orders, oldest first; filter by company/dates; `limit` (default 50, max 200) + `cursor`. |
| `list_order_lines` | Raw line items; filter by company/product/dates; same paging. |
| `top_products` | Products by revenue for a range; `limit` (default 25, max 100). |
| `sales_summary` | Revenue, orders, active companies, AOV vs the same dates last year. |
| `revenue_trend` | Revenue/orders by day, week or month. |
| `list_staff` | Reps and managers with commission tiers. |
| `commission_report` | Per-rep payout for a month (same numbers as the Reports page). |
| `monthly_commissions` | Per-rep revenue and commission for the last N months. |

Not available: rep-written CRM notes, sample-box note text, Shopify sessions,
staff PIN data. Nothing can be changed through the connector.

## How sign-in works

claude.ai custom connectors sign in with OAuth 2.1 (they can't be given a
static API key, except in the limited *Request headers* beta). The app runs a
small authorization server of its own:

1. Claude calls `/mcp`, gets `401` with
   `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
2. Claude reads `/.well-known/oauth-protected-resource/mcp` and
   `/.well-known/oauth-authorization-server`, then registers itself at
   `/oauth/register` (dynamic client registration, RFC 7591).
3. The browser opens `/oauth/authorize` (PKCE S256 required). The person
   connecting pastes the Reporting API key. Ten wrong keys from one address
   lock that address out for 15 minutes.
4. Claude exchanges the one-time code at `/oauth/token` for an access token
   (1 hour) and a refresh token (30 days, rotated on every use).

Security notes:

- Only SHA-256 hashes of codes and tokens are stored.
- Each grant records a fingerprint of the key that approved it. Removing that
  key from `REPORTING_API_KEY` revokes every connector token it approved.
- Redirects are limited to Claude and loopback by default, so nobody can
  register their own redirect and phish the key through the real consent page.
- Tokens are bound to the `/mcp` resource (RFC 8707) and only accepted in the
  `Authorization` header.
- `/oauth/revoke` (RFC 7009) revokes a whole grant.
- Rate limits are per serverless instance: 120 MCP requests/min per token,
  30 registrations/hour and 60 token requests/min per IP.
- The endpoint is stateless Streamable HTTP with JSON responses; `GET` and
  `DELETE /mcp` return `405`. Tool calls get the same 55 s budget as the
  reporting routes.

To revoke everyone at once, rotate `REPORTING_API_KEY` (see
[REPORTING_API.md](REPORTING_API.md)). To clear stale registrations:
`DELETE FROM mcp_oauth_clients WHERE created_at < now() - interval '90 days';`

## Troubleshooting

- **"Couldn't reach the MCP server"** — check the URL ends in `/mcp` and the
  deployment is live; `curl -i -X POST https://<app-host>/mcp` should return `401`
  with a `WWW-Authenticate` header.
- **503 "not configured"** — `REPORTING_API_KEY` isn't set on that deployment.
- **Tools say `NO_SHOPIFY_SESSION`** — open the app once in Shopify admin so it
  has a stored offline session.
- **Order numbers look short** — `crm_status` shows whether the order backfill
  is complete.
- Logs: `vercel logs` and search for `[mcp]`.
