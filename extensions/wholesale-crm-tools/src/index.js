// Sidekick data tools for the Wholesale CRM app.
// Runs headlessly in Shopify's extension sandbox. Relative fetch() calls go to
// the app's backend (application_url) with a session token attached; the
// backend routes live in lib/sidekick.js under /api/sidekick.

function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// Send the numeric part of gid://shopify/Company/123 so the path never holds
// encoded slashes; the backend turns it back into a GID.
function accountPath(id) {
  const value = String(id || '').trim();
  const digits = value.match(/(\d+)$/);
  return encodeURIComponent(digits ? digits[1] : value);
}

async function getJson(path) {
  const response = await fetch(path);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return { error: body?.error || `Wholesale CRM returned ${response.status}` };
  }
  return body;
}

export default () => {
  shopify.tools.register('search_accounts', async ({ query, rep, status, limit } = {}) =>
    getJson(`/api/sidekick/accounts${qs({ query, rep, status, limit })}`));

  shopify.tools.register('get_account', async ({ id } = {}) =>
    getJson(`/api/sidekick/accounts/${accountPath(id)}`));

  shopify.tools.register('get_account_notes', async ({ id, limit } = {}) =>
    getJson(`/api/sidekick/accounts/${accountPath(id)}/notes${qs({ limit })}`));

  shopify.tools.register('get_account_contacts', async ({ id } = {}) =>
    getJson(`/api/sidekick/accounts/${accountPath(id)}/contacts`));

  shopify.tools.register('accounts_needing_follow_up', async ({ kind, rep, limit } = {}) =>
    getJson(`/api/sidekick/follow-ups${qs({ kind, rep, limit })}`));

  shopify.tools.register('account_buying_intel', async ({ id } = {}) =>
    getJson(`/api/sidekick/accounts/${accountPath(id)}/buying`));

  shopify.tools.register('wholesale_summary', async ({ startDate, endDate } = {}) =>
    getJson(`/api/sidekick/analytics/summary${qs({ startDate, endDate })}`));

  shopify.tools.register('revenue_trend', async ({ startDate, endDate, period } = {}) =>
    getJson(`/api/sidekick/analytics/trend${qs({ startDate, endDate, period })}`));

  shopify.tools.register('top_accounts', async ({ startDate, endDate, sortBy, limit } = {}) =>
    getJson(`/api/sidekick/analytics/accounts${qs({ startDate, endDate, sortBy, limit })}`));

  shopify.tools.register('top_products', async ({ startDate, endDate, limit } = {}) =>
    getJson(`/api/sidekick/analytics/products${qs({ startDate, endDate, limit })}`));
};
