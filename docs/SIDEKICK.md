# Sidekick extension (Wholesale CRM data)

Sidekick, Shopify's admin assistant, can read Wholesale CRM data through the
`wholesale-crm-tools` extension. It is read-only. Sidekick links each answer to
the company page in Shopify admin.

## Tools

| Tool | Endpoint | Answers |
|---|---|---|
| `search_accounts` | `GET /api/sidekick/accounts?query&rep&status&limit` | Find accounts by name, email or phone; filter by rep or status |
| `get_account` | `GET /api/sidekick/accounts/:id` | Rep, last order, days since, usual order gap, contacts, sample box, latest 3 notes |
| `get_account_notes` | `GET /api/sidekick/accounts/:id/notes?limit` | Note history, newest first |
| `accounts_needing_follow_up` | `GET /api/sidekick/follow-ups?kind&rep&limit` | `dormant`, `at_risk`, `sample_follow_up`, `new_partner` |
| `account_buying_intel` | `GET /api/sidekick/accounts/:id/buying` | Revenue this year vs. same dates last year, top products |
| `wholesale_summary` | `GET /api/sidekick/analytics/summary?startDate&endDate` | Analytics page KPIs: revenue, orders, average order value, accounts that ordered, same dates last year, top product |
| `revenue_trend` | `GET /api/sidekick/analytics/trend?startDate&endDate&period` | Revenue and orders by day, week or month (max 60 points, newest kept) |
| `top_accounts` | `GET /api/sidekick/analytics/accounts?startDate&endDate&sortBy&limit` | Accounts ranked by revenue or orders for the range |
| `top_products` | `GET /api/sidekick/analytics/products?startDate&endDate&limit` | Products ranked by revenue, with units and average price |

Analytics tools default to year to date (the Analytics page default), compute
from the Neon rollup only, and answer `backfilling` until it is complete.

Status buckets match the Customers tab: `active` ≤30 days, `at_risk` 31–89,
`dormant` 90+, `never_ordered`.

**Never returned:** commission amounts or tiers, and revenue grouped by sales
rep (both live in the PIN-protected Commissions and Reports pages). A rep shows
up only as the assigned rep on an account and as a filter on account lists
(`rep=me` works). Revenue rankings (`top_accounts`) carry no rep field.
Every staff member with app access sees all accounts, same as the app.

## How it works

- `extensions/wholesale-crm-tools/` is an `admin.app.tools.data` extension.
  `tools.json` declares the tools; `src/index.js` calls the backend with a
  relative `fetch()`, which Shopify sends to `application_url` with a session
  token.
- `lib/sidekick.js` holds the routes. Auth decodes the session token, loads
  the stored offline session, and does **token exchange** if there is none
  (needed for Shopify-managed install).
- Shopify wants answers in under 1 second and under ~4,000 tokens. Lists read
  the Postgres company snapshot (`company_commission_snapshot`) plus one
  `company_metric_order` rollup query cached 5 minutes. They never page
  Shopify. A stale snapshot refreshes in the background. If none exists yet,
  list tools answer `warming_up` (search falls back to Shopify's company
  search by name). Lists cap at 25 rows; notes trim at 400 characters.
- The snapshot now also stores each company's `sampleBox`. Older snapshots
  pick it up on the next refresh (within ~5 minutes of use).
- `shopify.app.toml` has `[sidekick] extensions_summary` and
  `use_legacy_install_flow = false`.

## Deploy

1. Deploy the backend to Vercel as usual (`main` → production).
2. From a machine logged in to the org that owns the app (Dev Dashboard), with
   Shopify CLI **3.90+**: `shopify app deploy`. This releases the extension
   and the toml changes.
3. In Shopify admin, open Sidekick and ask, for example: "Which of my wholesale
   accounts haven't ordered in 90 days?" or "What are the latest CRM notes for
   Green Valley Market?"

Local dev: `shopify app dev` against a dev store, then ask Sidekick there.

## Tests

`npm test` runs `test/sidekick.test.js` (helpers and routes against fake
Shopify, Neon and staff stores).
