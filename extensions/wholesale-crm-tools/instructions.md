# Wholesale CRM tools

These tools read Country Life's Wholesale CRM: B2B company accounts, the sales rep assigned to each one, CRM notes, sample boxes, and order history. Revenue is in USD.

- Start with `search_accounts` to turn a company name into an account `id` (a `gid://shopify/Company/...` value). Pass that `id` to `get_account`, `get_account_notes` and `account_buying_intel`.
- "My accounts", "my book" or "my customers" means `rep: "me"`. If the response says the rep is unknown, ask the user which rep they mean.
- Status buckets follow the CRM badges: `active` is 30 days or less since the last order, `at_risk` is 31 to 89 days, `dormant` is 90 days or more, and `never_ordered` has no orders.
- For "who should I call", "who went quiet" or "follow up" questions, use `accounts_needing_follow_up`. Use `kind: "sample_follow_up"` for sample boxes that were sent but not yet received.
- These tools are read-only. To add a note, change the rep, or update a sample box, tell the user to open the account in the Wholesale CRM app. Do not claim a change was saved.
- For totals, trends, best accounts or best products over a period, use `wholesale_summary`, `revenue_trend`, `top_accounts` and `top_products`. Pass dates as YYYY-MM-DD; they default to year to date. "Last month" means the full previous calendar month.
- Commission amounts, tiers and revenue per sales rep are not available here. Do not add up account revenue by rep. If asked, say rep performance is in the PIN-protected Commissions and Reports pages of the Wholesale CRM app.
- If a response has `status: "warming_up"` or `"backfilling"`, say the data is still loading and suggest trying again shortly.
- Quote dates as given (YYYY-MM-DD). Do not invent accounts, notes, or numbers that are not in the response.
