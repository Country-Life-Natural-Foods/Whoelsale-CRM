# Reporting API

Read-only access to everything the Wholesale CRM collects, for an external
reporting agent or app. Code: `lib/reporting-api.js`. Tests:
`test/reporting-api.test.js`.

Base URL: `https://<SHOPIFY_APP_URL>/api/reporting/v1`

## Setup (Vercel → Project → Settings → Environment Variables)

| Variable | Required | Value |
|---|---|---|
| `REPORTING_API_KEY` | yes | A random secret, 32+ characters. Generate with `openssl rand -base64 48`. To rotate, set `old,new`, switch the client to `new`, then remove `old`. |
| `REPORTING_SHOP` | no | `your-store.myshopify.com`. Not needed when only one store has synced orders. |
| `REPORTING_API_CORS_ORIGINS` | no | Comma-separated browser origins allowed to call the API. Leave empty (recommended) so only servers can call it. |

Redeploy after changing these. Until a key is set, every route answers `503 NOT_CONFIGURED`.

## Calling it

```bash
curl -H "Authorization: Bearer $REPORTING_API_KEY" \
  https://<app-host>/api/reporting/v1/companies
```

- Key **only** in the `Authorization: Bearer` header. A key in the URL is refused (`400 KEY_IN_URL`), because URLs end up in logs.
- Keep the key on a server (agent backend, scheduled job). Don't ship it in browser code.
- Every response has a `data` and a `meta` section. `meta.generatedAt` is the time of the response. `meta.rollup.complete` says whether the order history sync has finished; until it has, order numbers are partial.
- Money is USD, net of refunds. Dates are `YYYY-MM-DD` UTC days, inclusive.
- Company ids accept `gid://shopify/Company/123` or `123`.

## Endpoints (all GET)

| Path | Params | Returns |
|---|---|---|
| `/` | | Self-describing index of endpoints (good first call for an agent) |
| `/status` | | Order sync status, oldest/newest order, company snapshot age |
| `/companies` | `start`, `end` (default year to date) | **Every company**: main contact email/phone, assigned rep (with tier), sample box status/dates, last order, days since, status, `lifetime` and `range` revenue / orders / AOV / orders placed outside wholesale checkout |
| `/companies/{id}` | `start`, `end` | One company: all contacts, all locations with addresses, lifetime + range totals, monthly revenue, top 20 products |
| `/orders` | `start`, `end` (default all time), `company_id`, `cursor`, `limit` (≤1000) | Raw orders, oldest first |
| `/order-lines` | same + `product_id` | Raw line items, oldest first |
| `/products` | `start`, `end` | Units and revenue per product |
| `/analytics/summary` | `start`, `end` | Revenue, orders, active companies, AOV, same dates last year, % change |
| `/analytics/trend` | `start`, `end`, `period=day\|week\|month` | Revenue and orders per bucket |
| `/staff` | | Reps/managers: name, email, role, commission tier |
| `/commissions` | `month=YYYY-MM` (default last closed month) | Per rep: tier, each company's revenue + commission, totals. Same numbers as the Reports page. |
| `/commissions/monthly` | `months` (default 12, max 36) | Per rep revenue + commission per trailing month (current month in progress) |

Paging: when `meta.nextCursor` is not null, call again with `?cursor=<value>` (and the same filters). It's `null` on the last page.

## Errors

| Status | `code` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST`, `KEY_IN_URL` | Bad parameter / key sent in URL |
| 401 | `UNAUTHORIZED` | Missing or wrong key |
| 405 | `METHOD_NOT_ALLOWED` | Anything other than GET/HEAD |
| 429 | `RATE_LIMITED` | Over 120 requests/min, or 10 failed keys in 15 min (see `Retry-After`) |
| 503 | `NOT_CONFIGURED`, `NO_SHOP`, `NO_SHOPIFY_SESSION`, `ROLLUP_NOT_READY` | Setup not finished |
| 500 | `INTERNAL` | Includes `requestId`; search Vercel logs for `[reporting] <requestId>` |

## What's in and out

- **In:** all companies, contacts, addresses, rep assignments, sample-box status, all order and line-item numbers, product mix, staff roster with tiers, commission amounts.
- **Out (by design):** rep-written CRM notes and the free-text note on sample boxes; Shopify session tokens; staff PIN hashes.
- **Commission caveat:** tiers are each rep's *current* tier; tier history isn't tracked (same as the Reports page).

## Security notes

- Constant-time key comparison (SHA-256 of both sides), `Cache-Control: no-store`, `X-Request-Id` on every response.
- Rate limits are kept in memory **per serverless instance**, so they slow down guessing but aren't a global quota. The real protection is the long random key.
- The app-wide `cors()` skips `/api/reporting/`, so browsers are refused unless their origin is listed in `REPORTING_API_CORS_ORIGINS`.
- Reads use the store's stored offline Shopify session. If the app is uninstalled or the session disappears, Shopify-backed routes return `503 NO_SHOPIFY_SESSION` until someone opens the app in Shopify admin again.
