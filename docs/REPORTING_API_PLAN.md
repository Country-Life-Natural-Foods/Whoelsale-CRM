# Reporting API (read-only, for an agent) — plan & notes

Status: **PLAN — awaiting Isaac's approval. No code written yet.** (2026-11-17)

## Ask
One read-only API an external reporting agent can call with full visibility into
everything the Wholesale CRM collects: all companies (one endpoint), commissions,
and the Neon rollup data. Reporting only — no writes.

## Where the data actually lives (from code review)

| Data | Store | Notes |
|---|---|---|
| Orders (id, company, date, revenue, checkout_channel) | Neon `company_metric_order` | Lifetime once backfill `complete` |
| Order line items (product, title, qty, revenue) | Neon `company_metric_line` | Needs product backfill |
| Product daily totals | Neon `company_metric_product_day` | |
| Refunds | Neon `company_metric_refund` | Already netted into order revenue |
| Customer → company map | Neon `company_metric_contact` | |
| Backfill status/meta | Neon `company_metric_meta` | Exposed as data freshness |
| Company snapshot (name, contacts, assigned rep, sample box) | Neon `company_commission_snapshot` (jsonb) | Refreshed every 5 min on use |
| Staff (name, email, role, commission tier) | Neon `staff_members` | **Never expose `pin_hash`, `pin_failed_attempts`** |
| Shopify sessions | Neon `shopify_sessions` | **Never expose — holds access tokens** |
| CRM notes | Shopify Company metafield `clnf.crm_notes` | Not in Neon; needs a Shopify read |
| Sample box | Shopify metafield `clnf.sample_box` (+ snapshot) | |
| Rep assignment | Shopify metafield `clnf.assigned_staff` (+ snapshot) | |
| Contacts, addresses, phones | Shopify Companies API | `companyContactInfo()` in api/index.js |
| Commissions | Computed: assignment × rollup revenue × staff tier | `buildCommissionReport()` / `aggregateCommissionsFromJobs()` |

The live CRM database was not visible through the Neon MCP connection (checked
Country Life, Isaac, and Vercel orgs). It's probably a Vercel-managed Neon
integration. The schema is fully defined in `lib/company-metrics.js` and
`lib/staff-store.js`.

## Proposed design

- New router `lib/reporting-api.js`, mounted at `/api/reporting/v1` in
  `api/index.js` (same pattern as `/api/sidekick`). **GET only**; any other
  method → 405.
- Auth: `Authorization: Bearer <REPORTING_API_KEY>` env var, timing-safe
  compare. Endpoint is disabled (404/503) when the env var is unset.
- Shop: single-store app → `REPORTING_SHOP` env (fallback: the one shop with an
  offline session). Shopify reads use the stored offline session (same as
  `getOfflineGraphqlClient` in index.js) — no user/browser session or PIN.
- Commissions: refactor `buildCommissionReport` so the math lives in a pure
  `computeCommissionReport(client, month)` used by both the Reports page (still
  manager + PIN gated) and this API. No behavior change for the UI.

### Endpoints
- `GET /` — self-describing index of endpoints + params (helps the agent)
- `GET /status` — rollup/backfill status, data coverage (oldest/newest order), snapshot age
- `GET /companies` — ALL companies in one response: profile, contacts, address,
  assigned rep, sample box, notes, lifetime + YTD revenue/orders, last order,
  status (active / at_risk / dormant / never_ordered)
- `GET /companies/:id` — one company + its orders, top products, notes
- `GET /orders?start&end&company_id&cursor&limit` — raw rollup orders (paged)
- `GET /order-lines?start&end&company_id&product_id&cursor&limit` — line items (paged)
- `GET /products?start&end` — product mix
- `GET /analytics/summary?start&end`, `GET /analytics/trend?start&end&period`
- `GET /staff` — roster (id, name, email, role, tier, claimed) — no PIN fields
- `GET /commissions?month=YYYY-MM` — per rep: tier, companies, month revenue/commission
- `GET /commissions/monthly?months=12` — trailing months per rep

### Decisions to confirm
1. Commissions visible to the agent (reverses the 2026-11-11 Sidekick rule for
   *this* API only; Sidekick stays unchanged).
2. Static bearer key OK (vs per-agent keys/rotation).
3. Contact PII (emails/phones/addresses) included.
4. Notes read live from Shopify (adds ~seconds to /companies) vs cached.

### Alternative considered
Give the agent a read-only Postgres role on Neon. Rejected as the only path:
notes, contacts and commissions need Shopify reads plus the app's math, and the
DB also holds session tokens and PIN hashes.
