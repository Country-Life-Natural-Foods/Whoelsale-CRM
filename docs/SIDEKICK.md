# Sidekick extension (Wholesale CRM data)

Sidekick, Shopify's admin assistant, can read Wholesale CRM data through the
`wholesale-crm-tools` extension. It is strictly read-only. Account results
link into the app, where reps add notes, update sample boxes or claim accounts.

## Tools

| Tool | Endpoint | Answers |
|---|---|---|
| `search_accounts` | `GET /api/sidekick/accounts?query&rep&status&limit` | Find accounts by name, email or phone; filter by rep or status |
| `get_account` | `GET /api/sidekick/accounts/:id` | Rep, last order, days since, usual order gap, contact count, sample box, latest 3 notes |
| `get_account_contacts` | `GET /api/sidekick/accounts/:id/contacts` | Contacts (name, title, email, phone, main) and business phone. The only tool that returns contact details |
| `get_account_notes` | `GET /api/sidekick/accounts/:id/notes?limit` | Note history, newest first |
| `accounts_needing_follow_up` | `GET /api/sidekick/follow-ups?kind&rep&limit` | `dormant`, `at_risk`, `sample_follow_up`, `new_partner` |
| `list_open_tasks` | `GET /api/sidekick/tasks?kind&rep&limit` | Open follow-up tasks: `sample_follow_up`, `dormant_follow_up`, `at_risk_follow_up` |
| `get_last_contact` | `GET /api/sidekick/accounts/:id/last-contact` | Most recent CRM note (date, author, text, days since) plus last order date |
| `account_buying_intel` | `GET /api/sidekick/accounts/:id/buying` | Revenue this year vs. same dates last year, top products |
| `wholesale_summary` | `GET /api/sidekick/analytics/summary?startDate&endDate` | Analytics page KPIs: revenue, orders, average order value, accounts that ordered, same dates last year, top product |
| `revenue_trend` | `GET /api/sidekick/analytics/trend?startDate&endDate&period` | Revenue and orders by day, week or month (max 60 points, newest kept) |
| `top_accounts` | `GET /api/sidekick/analytics/accounts?startDate&endDate&sortBy&limit` | Accounts ranked by revenue or orders for the range |
| `top_products` | `GET /api/sidekick/analytics/products?startDate&endDate&limit` | Products ranked by revenue, with units and average price |

Analytics tools default to year to date (the Analytics page default), compute
from the Neon rollup only, and answer `backfilling` until it is complete.

Status buckets match the Customers tab: `active` ≤30 days, `at_risk` 31–89,
`dormant` 90+, `never_ordered`.

**Open tasks and last contact are derived, not stored.** The CRM has no
standalone task records, so `list_open_tasks` builds its list from data the
CRM already holds: sample boxes sent and not yet received (due on the
follow-up date, or the sent date when none is set), dormant accounts and
at-risk accounts. `get_last_contact` is the most recent CRM note on the
account (`get_account` also carries it as `lastContact`); with no notes it
answers `lastContact: null` and still gives the last order date. Neither tool
creates, edits or closes anything.

**No writes from Sidekick (yet).** Shopify's policy says data extensions stay
read-only and mutations belong in *action* extensions
(`admin.app.intent.link` / `.render`) where the merchant confirms the change.
Action extensions need a supported `application/*` or `shopify/*` intent type
(23 `application/*` types exist: email, ticket, quote, etc.; none is a CRM note
or sample box), and an unsupported type fails `shopify app deploy`. So notes,
sample boxes and claiming accounts stay in the app. The earlier
`prepare_account_update` draft-link tool was removed on 2026-11-12 after three
safety-scan blocks. The backend `/api/sidekick/drafts` route and the app-side
`applySidekickDraft` banner are left in place but unused. To get Sidekick
writes: propose a CRM type in Shopify's app intent types repository, or
declare the closest honest existing type once Shopify approves it.

**Never returned:** commission amounts or tiers, and revenue grouped by sales
rep (both live in the PIN-protected Commissions and Reports pages). A rep shows
up only as the assigned rep on an account and as a filter on account lists
(`rep=me` works). Revenue rankings (`top_accounts`) carry no rep field.
Every staff member with app access sees all accounts, same as the app.

## Shopify's content and safety policy

Blocked 2026-11-11 (twice) and 2026-11-12 (versions 1204437090305,
1204443611137, 1204743143425). Emails give no reason, only "didn't pass our
safety scan". Deploy scans descriptions, instructions and input schemas;
runtime scans tool responses. Rules:

- **Data extensions are read-only.** Every tool fetches; none builds a write
  link or draft.
- **No steering** in `instructions.md` or tool text ("never", "do not",
  "tell the user"). Keep it factual.
- **No unrequested customer data.** Contact details only from
  `get_account_contacts`.
- **No promotion or upsell**; tools must match what the app does (2.2.8, 2.2.9).
- Limits: tool description 512 chars, instructions 2,048 tokens, extension
  description 256 tokens, 20 tools, responses < 4,000 tokens and < 1s.

`test/sidekick.test.js` enforces read-only, no draft wording and no steering.
Check results in the Dev Dashboard under the app's logs ("Sidekick event",
OK/Error) while running `shopify app dev`; after `shopify app deploy`, an
email arrives only if the version is blocked.

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
  (needed for Shopify-managed install). The router also carries an explicit
  CORS allowlist for `https://extensions.shopifycdn.com`, the Sidekick
  sandbox origin, as the Sidekick docs require.
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
