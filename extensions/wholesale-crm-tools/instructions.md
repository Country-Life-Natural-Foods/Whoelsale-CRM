# Wholesale CRM tools

These tools read Country Life's Wholesale CRM: B2B company accounts, the sales rep assigned to each account, CRM notes, sample boxes, contacts and wholesale order history. Amounts are in USD. Dates are YYYY-MM-DD.

## How the tools fit together

- `search_accounts` returns account ids (`gid://shopify/Company/...`). `get_account`, `get_account_notes`, `get_account_contacts`, `get_last_contact` and `account_buying_intel` take one of those ids.
- `prepare_account_update` returns a link that opens an account in the Wholesale CRM app with a note, sample-box change or self-assignment filled in. The change is confirmed in the app; the tool changes nothing on its own.
- `get_account` includes `lastContact`, the most recent CRM note with its date, author and days since. `get_last_contact` returns that note on its own, with the last order date for context.
- `list_open_tasks` returns open follow-up tasks: sample boxes sent and not yet received, dormant accounts and at-risk accounts. The CRM holds no separate task records; each task is a view of one of those follow-up states, with a due date where the sample box has one.
- The `rep` filter accepts a rep's name or email, `me` for the signed-in user's own accounts, or `unassigned`.
- Order status follows the CRM badges: `active` is 30 days or less since the last order, `at_risk` is 31 to 89 days, `dormant` is 90 days or more, `never_ordered` has no orders.
- `accounts_needing_follow_up` lists dormant, at-risk or new-partner accounts (1 to 3 lifetime orders), or sample boxes that were sent and not yet received.
- `wholesale_summary`, `revenue_trend`, `top_accounts` and `top_products` cover a date range, year to date by default. The summary also includes the same dates last year.

## Response fields

- `status: "warming_up"` or `"backfilling"` means that data is still loading on the Wholesale CRM side.
- `results` holds links that open each account in the Wholesale CRM app. `adminUrl` opens the company in Shopify admin.
- The tools cover CRM and order data. Commission figures and revenue grouped by sales rep are outside their scope.
