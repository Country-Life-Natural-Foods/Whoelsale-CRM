# Sidekick extension (Wholesale CRM data)

Sidekick, Shopify's admin assistant, can read Wholesale CRM data through the
`wholesale-crm-tools` extension. It is strictly read-only. Account results
link into the app (`app://crm?company=…`), where reps add notes, update sample
boxes or claim accounts as usual.

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
| `prepare_account_update` | `GET /api/sidekick/drafts?id&action&note&followUpDate` | Link only: opens the account with a note, sample-box change or self-assignment filled in for the merchant to confirm in the app |
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

**Writes go through a link plus human accept, not a Sidekick write.** The
write actions merchants ask for after a search are adding a CRM note,
updating a sample box and claiming an account. That is Shopify's
`admin.app.intent.link` pattern (search, open, edit): Sidekick returns a link
that opens the account page in the Wholesale CRM app with the draft filled
in, and the merchant hits Accept / Confirm on that page for the write to go
live. No declared intent extension exists, because Shopify's supported
intent types (`application/*`, `shopify/*`) have no CRM, note or task type,
and the docs say not to pick an unrelated type as a placeholder: an
unsupported type fails deploy. The link itself is the valid link type for
deploy: an `app://` URL, the embedded-app link shape the Sidekick docs bless
for linking into an app. If Shopify adds a fitting intent type, declare an
`admin.app.intent.link` extension with that type then; until that point, the
plain `app://` link is the mechanism. `prepare_account_update` is the tool
that builds that link (GET `/api/sidekick/drafts`); the app side
(`applySidekickDraft` in `public/index.html`) shows the draft in a "Drafted
by Sidekick" banner for review, and nothing saves until the merchant clicks
Save Note / Mark sent / Mark received / Assign to me. The draft params are
cleared from the address on open, so a reload does not fill the draft in
again.

**Never returned:** commission amounts or tiers, and revenue grouped by sales
rep (both live in the PIN-protected Commissions and Reports pages). A rep shows
up only as the assigned rep on an account and as a filter on account lists
(`rep=me` works). Revenue rankings (`top_accounts`) carry no rep field.
Every staff member with app access sees all accounts, same as the app.

## Shopify's content and safety policy (how the write link stays inside it)

The first deploy (2026-11-11) was **blocked by Shopify's Sidekick safety
scan**. Shopify checks descriptions, instructions and input schemas at
deploy, and tool responses at runtime. The rules that matter here:

- **Data tools fetch only.** Every tool except `prepare_account_update`
  reads data. `prepare_account_update` is the single exception, and it is
  link-only: it returns a prefilled `app://` link over GET
  (`/api/sidekick/drafts`), changes nothing server-side, and the extension
  sends no POST, PUT, PATCH or DELETE. The write itself happens in the app,
  after a person reviews the draft and confirms it. That is the correction
  Isaac made on 2026-11-11: the draft-link workaround stays, as a plain
  navigation link with human accept, not a direct Sidekick write.
- **No steering.** `instructions.md` may explain how the tools fit together,
  but must not tell Sidekick how to behave ("never say…", "do not…",
  "tell the user…"). Keep it factual.
- **No unrequested customer data.** Contact emails and phones come only from
  `get_account_contacts`.
- Runtime `message` fields are factual status text, not directions.

`test/sidekick.test.js` checks the extension files for GET-only requests,
mutation wording outside the draft-link tool, and steering phrases, so a
regression fails `npm test` before deploy.

**Residual scan risk, stated plainly:** the scan blocked the Nov 11 deploy
when the draft tool existed as a POST. The tool is now GET-only and
link-only, which is the closest reading of the docs' link pattern without a
fitting intent type, but the scan could still flag a data-extension tool
that builds write links. If `shopify app deploy` rejects it, the fallback is
to move the same link-builder into a declared `admin.app.intent.link`
extension once Shopify offers a fitting intent type, and keep the data tools
read-only in the meantime. Do not work around a rejection by declaring an
unrelated intent type.

**Who can write:** saving or deleting notes and updating sample boxes needs a
claimed staff record (`requireStaffWriter` in `api/index.js`), in the app and
from Sidekick alike. The note author and sample "sent by" come from that
record, not from the request. `prepare_account_update` also checks the
caller's staff record first and answers `staff_required` without a link when
there is none.

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
