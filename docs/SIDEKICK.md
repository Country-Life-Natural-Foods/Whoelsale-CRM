# Sidekick extension (Wholesale CRM data)

Sidekick, Shopify's admin assistant, can read Wholesale CRM data through the
`wholesale-crm-tools` extension, and can prepare changes (notes, sample boxes,
self-assignment) that the user confirms in the app. Sidekick never saves
anything itself. Account results link into the app (`app://crm?company=…`).

## Tools

| Tool | Endpoint | Answers |
|---|---|---|
| `search_accounts` | `GET /api/sidekick/accounts?query&rep&status&limit` | Find accounts by name, email or phone; filter by rep or status |
| `get_account` | `GET /api/sidekick/accounts/:id` | Rep, last order, days since, usual order gap, contacts, sample box, latest 3 notes |
| `get_account_notes` | `GET /api/sidekick/accounts/:id/notes?limit` | Note history, newest first |
| `accounts_needing_follow_up` | `GET /api/sidekick/follow-ups?kind&rep&limit` | `dormant`, `at_risk`, `sample_follow_up`, `new_partner` |
| `account_buying_intel` | `GET /api/sidekick/accounts/:id/buying` | Revenue this year vs. same dates last year, top products |
| `prepare_account_update` | `POST /api/sidekick/drafts` `{id, action, note, followUpDate}` | Builds a link that opens the account with a draft: `add_note`, `sample_sent`, `sample_received`, `assign_to_me`. Saves nothing |
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

## Drafts: Sidekick prepares, the rep saves

Shopify only lets the read tools fetch data. Its built-in action types have
no CRM or note type (an unknown type is rejected at deploy). So writes work
like this:

1. Rep: "Log a note on Green Valley: called Sarah, wants the spring catalog."
2. `prepare_account_update` checks the account and the rep's staff record,
   then returns `app://crm?company=…&action=add_note&note=…`.
3. The link opens `/crm` (same page as `/`). `public/index.html`
   (`applySidekickDraft`) opens the account, fills the field, shows a
   "Drafted by Sidekick" banner and removes the draft from the URL.
4. The rep clicks Save Note / Mark sent / Mark received / Assign to me. That
   uses the normal endpoints and permission checks.

`assign_to_me` follows the app's rules: a rep can claim an unassigned account
but not one that has another rep (managers can reassign).

**Who can write:** saving or deleting notes and updating sample boxes needs a
claimed staff record (`requireStaffWriter` in `api/index.js`), in the app and
from Sidekick alike. The note author and sample "sent by" come from that
record, not from the request.

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
