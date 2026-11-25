'use strict';

// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const reporting = require('../lib/reporting-api');
const oauth = require('../lib/mcp-oauth');
const mcp = require('../lib/mcp-server');

const KEY = 'k'.repeat(40);
const NEW_KEY = 'n'.repeat(40);
const NOW = new Date('2026-11-17T12:00:00Z');
const SHOP = 'clnf.myshopify.com';
const C1 = 'gid://shopify/Company/1';
const C2 = 'gid://shopify/Company/2';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const staff = [
  { id: 's1', name: 'Jess', email: 'jess@example.com', role: 'rep', commissionTier: 5, shopifyUserId: 'u1', pinHash: 'secret-hash' },
];

const companies = [
  { id: C2, name: 'Beta Foods', email: null, phone: '(555) 010-2000', assignedStaff: null, sampleBox: { status: 'none' } },
  {
    id: C1,
    name: 'Acme Market',
    email: 'buyer@acme.test',
    phone: '555',
    assignedStaff: { staffId: 's1', assignedAt: '2026-01-01T00:00:00Z' },
    sampleBox: { status: 'sent', sentAt: '2026-11-01', note: 'rep-written text' },
    notes: [{ body: 'should never appear' }],
  },
];

const metrics = {
  enabled: true,
  async status() { return { ready: true, productsReady: true, status: 'complete' }; },
  async isComplete() { return true; },
  async orderCoverage() { return { oldest: '2024-01-01T00:00:00.000Z', newest: '2026-11-16T00:00:00.000Z', orderCount: 3 }; },
  async getCompanySnapshot() { return { companies: [{}, {}], updatedAt: new Date('2026-11-17T11:50:00Z') }; },
  async companiesRange(shop, start) {
    if (start) return new Map([[C1, { totalSpend: 100, orderCount: 2 }]]);
    return new Map([[C1, { totalSpend: 1000, orderCount: 10, lastOrderDate: '2026-11-10T00:00:00.000Z' }]]);
  },
  async listOrders(shop, opts) {
    this.lastListOrders = opts;
    return { rows: [{ orderId: 'o1', companyId: C1, revenue: 10 }], nextCursor: ['2026-01-01T00:00:00.000000Z', 'o1'] };
  },
  async productsRange() {
    return Array.from({ length: 40 }, (_, i) => ({ id: `title:p${i}`, title: `P${i}`, unitsSold: 1, revenue: 40 - i, avgUnitPrice: 1 }));
  },
  async revenueByDay() { return []; },
  async shopRangeTotals() { return { revenue: 10, orderCount: 1, activeCompanies: 1 }; },
};

function deps() {
  return {
    companyMetrics: metrics,
    staffStore: { async list() { return staff; } },
    resolveShop: async () => SHOP,
    getShopifyClient: async () => ({ fake: true }),
    getCompanies: async () => companies,
    getCommissionReport: async (client, month) => ({
      period: { month: month || '2026-10' },
      totals: { totalRevenue: 100, totalCommission: 5 },
      reps: [{ staffId: 's1', name: 'Jess', commissionTier: 5, totalRevenue: 100, totalCommission: 5,
        companies: [{ companyId: C1, companyName: 'Acme Market', revenue: 100, commission: 5 }] }],
      source: 'rollup',
      rollup: { ready: true },
    }),
    now: () => NOW,
  };
}

async function withApp(env, fn) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const store = oauth.createMemoryOAuthStore();
  const tokens = oauth.createTokenService({ store, env });
  app.use(oauth.createOAuthRouter({ store, tokens, env }));
  app.use('/mcp', mcp.createMcpRouter({ service: reporting.createReportingService(deps()), tokens, env }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    server.close();
  }
}

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = oauth.pkceS256(verifier);

async function register(base, redirect = CLAUDE_CALLBACK) {
  return fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }),
  });
}

function authorizeParams(clientId, extra = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    state: 'st4te',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  };
}

async function approve(base, clientId, key = KEY, extra = {}) {
  return fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...authorizeParams(clientId, extra), reporting_key: key, decision: 'approve' }),
  });
}

async function tokenRequest(base, body) {
  return fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

// Register, approve and exchange the code: returns the token response.
async function connect(base) {
  const client = await (await register(base)).json();
  const res = await approve(base, client.client_id, KEY, { resource: `${base}/mcp` });
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  const tokens = await (await tokenRequest(base, {
    grant_type: 'authorization_code', code, client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier, resource: `${base}/mcp`,
  })).json();
  return { client, tokens };
}

async function rpc(base, token, method, params = {}, id = 1) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

async function callTool(base, token, name, args = {}) {
  const { body } = await rpc(base, token, 'tools/call', { name, arguments: args });
  const result = body.result;
  return { isError: Boolean(result.isError), text: result.content[0].text, json: result.isError ? null : JSON.parse(result.content[0].text) };
}

// ---------------------------------------------------------------------------

test('redirect URIs: Claude and loopback only by default; loopback ignores port', () => {
  assert.equal(oauth.redirectUriProblem(CLAUDE_CALLBACK, {}), null);
  assert.equal(oauth.redirectUriProblem('https://claude.com/api/mcp/auth_callback', {}), null);
  assert.equal(oauth.redirectUriProblem('http://localhost:53682/callback', {}), null);
  assert.equal(oauth.redirectUriProblem('http://127.0.0.1/callback', {}), null);
  assert.match(oauth.redirectUriProblem('https://evil.example/cb', {}), /not allowed/);
  assert.match(oauth.redirectUriProblem('http://claude.ai/cb', {}), /https/);
  assert.match(oauth.redirectUriProblem('https://claude.ai.evil.example/cb', {}), /not allowed/);
  assert.equal(oauth.redirectUriProblem('https://chatgpt.com/cb', { MCP_OAUTH_REDIRECT_HOSTS: 'chatgpt.com' }), null);
  assert.ok(oauth.redirectMatches('http://localhost/callback', 'http://localhost:4567/callback'));
  assert.ok(!oauth.redirectMatches('http://localhost/callback', 'http://localhost:4567/other'));
  assert.ok(!oauth.redirectMatches(CLAUDE_CALLBACK, 'https://claude.ai/api/mcp/auth_callback2'));
});

test('discovery metadata points at /mcp and advertises PKCE + DCR', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(pr.resource, `${base}/mcp`);
    assert.deepEqual(pr.authorization_servers, [base]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, base);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.ok(as.registration_endpoint.endsWith('/oauth/register'));
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  });
});

test('/mcp without a token: 401 with resource_metadata challenge; GET is 405', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const { res } = await rpc(base, null, 'tools/list');
    assert.equal(res.status, 401);
    const challengeHeader = res.headers.get('www-authenticate');
    assert.match(challengeHeader, /^Bearer /);
    assert.ok(challengeHeader.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
  });
});

test('connector is off until REPORTING_API_KEY is set', async () => {
  await withApp({}, async (base) => {
    assert.equal((await rpc(base, KEY, 'tools/list')).res.status, 503);
    assert.equal((await register(base)).status, 503);
  });
});

test('registration rejects foreign redirect hosts', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const res = await register(base, 'https://evil.example/cb');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_redirect_uri');
  });
});

test('consent page escapes input and refuses unknown clients / mismatched redirects', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    let res = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authorizeParams('nope'))}`);
    assert.equal(res.status, 400);
    const client = await (await register(base)).json();
    res = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, { redirect_uri: 'https://claude.ai/other' }))}`);
    assert.equal(res.status, 400);
    res = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, { state: '"><script>x</script>' }))}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const html = await res.text();
    assert.ok(html.includes('Reporting API key'));
    assert.ok(!html.includes('<script>x'));
    // Missing PKCE redirects back with an error.
    res = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, { code_challenge_method: 'plain' }))}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('location')).searchParams.get('error'), 'invalid_request');
  });
});

test('wrong key re-shows consent; repeated failures lock out', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const client = await (await register(base)).json();
    for (let i = 0; i < 10; i += 1) {
      const res = await approve(base, client.client_id, 'wrong-key');
      assert.equal(res.status, 401);
    }
    assert.equal((await approve(base, client.client_id, KEY)).status, 429);
  });
});

test('cancel sends access_denied back with state', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const client = await (await register(base)).json();
    const res = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...authorizeParams(client.client_id), decision: 'deny' }),
    });
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, CLAUDE_CALLBACK);
    assert.equal(loc.searchParams.get('error'), 'access_denied');
    assert.equal(loc.searchParams.get('state'), 'st4te');
  });
});

test('full OAuth flow: code is single use, PKCE enforced, refresh rotates', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base, store) => {
    const client = await (await register(base)).json();
    const res = await approve(base, client.client_id);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.searchParams.get('state'), 'st4te');
    assert.equal(loc.searchParams.get('iss'), base);
    const code = loc.searchParams.get('code');

    // Wrong verifier fails and burns the code.
    let r = await tokenRequest(base, { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: 'x'.repeat(43) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_grant');
    r = await tokenRequest(base, { grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier });
    assert.equal(r.status, 400);

    const { tokens } = await connect(base);
    assert.ok(tokens.access_token.startsWith('mcp_at_'));
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 3600);
    // Only hashes are stored.
    for (const hash of store._tokens.keys()) assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(![...store._tokens.keys()].includes(tokens.access_token));

    const { res: ok } = await rpc(base, tokens.access_token, 'tools/list');
    assert.equal(ok.status, 200);

    r = await tokenRequest(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(r.status, 200);
    const next = await r.json();
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    r = await tokenRequest(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_grant');
    assert.equal((await rpc(base, next.access_token, 'tools/list')).res.status, 200);

    // Revocation kills the whole grant.
    await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: next.refresh_token }),
    });
    assert.equal((await rpc(base, next.access_token, 'tools/list')).res.status, 401);
  });
});

test('rotating the reporting key out revokes connector tokens it approved', async () => {
  const env = { REPORTING_API_KEY: KEY };
  await withApp(env, async (base) => {
    const { tokens } = await connect(base);
    assert.equal((await rpc(base, tokens.access_token, 'tools/list')).res.status, 200);
    env.REPORTING_API_KEY = `${KEY},${NEW_KEY}`;
    assert.equal((await rpc(base, tokens.access_token, 'tools/list')).res.status, 200);
    env.REPORTING_API_KEY = NEW_KEY;
    assert.equal((await rpc(base, tokens.access_token, 'tools/list')).res.status, 401);
    const r = await tokenRequest(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(r.status, 400);
  });
});

test('reporting key works directly as a bearer token; bad keys lock out', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    assert.equal((await rpc(base, KEY, 'tools/list')).res.status, 200);
    for (let i = 0; i < 10; i += 1) assert.equal((await rpc(base, 'guess', 'tools/list')).res.status, 401);
    assert.equal((await rpc(base, KEY, 'tools/list')).res.status, 429);
  });
});

test('tools/list exposes read-only tools only', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const { body } = await rpc(base, KEY, 'tools/list');
    const names = body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'commission_report', 'crm_status', 'get_company', 'list_order_lines', 'list_orders', 'list_staff',
      'monthly_commissions', 'revenue_trend', 'sales_summary', 'search_companies', 'top_products',
    ]);
    for (const t of body.result.tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
  });
});

test('initialize returns server info and instructions', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const { body } = await rpc(base, KEY, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(body.result.serverInfo.name, 'wholesale-crm');
    assert.match(body.result.instructions, /Read-only/);
  });
});

test('search_companies filters, sorts, pages and never leaks notes', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    let out = await callTool(base, KEY, 'search_companies');
    assert.equal(out.json.total, 2);
    assert.equal(out.json.companies[0].name, 'Acme Market');
    assert.equal(out.json.companies[0].rep, 'Jess');
    assert.equal(out.json.companies[0].lifetimeRevenue, 1000);
    assert.equal(out.json.companies[0].status, 'active');
    assert.ok(!out.text.includes('should never appear'));
    assert.ok(!out.text.includes('rep-written text'));

    out = await callTool(base, KEY, 'search_companies', { status: 'never_ordered' });
    assert.deepEqual(out.json.companies.map((c) => c.name), ['Beta Foods']);
    out = await callTool(base, KEY, 'search_companies', { query: '010-2000' });
    assert.deepEqual(out.json.companies.map((c) => c.name), ['Beta Foods']);
    out = await callTool(base, KEY, 'search_companies', { rep: 'unassigned' });
    assert.deepEqual(out.json.companies.map((c) => c.name), ['Beta Foods']);
    out = await callTool(base, KEY, 'search_companies', { limit: 1 });
    assert.equal(out.json.companies.length, 1);
    assert.equal(out.json.nextOffset, 1);
    out = await callTool(base, KEY, 'search_companies', { limit: 1000 });
    assert.equal(out.isError, true); // over the schema max
  });
});

test('get_company by name returns candidates when ambiguous', async () => {
  const rows = [
    { name: 'Acme Market', numericId: '1', status: 'active', lifetime: { revenue: 1 } },
    { name: 'Acme Wholesale', numericId: '2', status: 'active', lifetime: { revenue: 1 } },
  ];
  assert.equal(mcp.resolveCompanyByName(rows, 'acme market').match.numericId, '1');
  assert.equal(mcp.resolveCompanyByName(rows, 'acme').candidates.length, 2);
  assert.equal(mcp.resolveCompanyByName(rows, 'zzz').candidates.length, 0);
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const out = await callTool(base, KEY, 'get_company', {});
    assert.equal(out.isError, true);
    assert.match(out.text, /company_id or company_name/);
  });
});

test('list_orders caps the page size and returns a cursor', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    const out = await callTool(base, KEY, 'list_orders', { company_id: '1', limit: 200 });
    assert.equal(metrics.lastListOrders.limit, 200);
    assert.equal(metrics.lastListOrders.companyId, C1);
    assert.ok(out.json.next_cursor);
    const bad = await callTool(base, KEY, 'list_orders', { cursor: 'garbage' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Invalid cursor/);
  });
});

test('top_products trims to the limit; staff and commissions match the reporting API', async () => {
  await withApp({ REPORTING_API_KEY: KEY }, async (base) => {
    let out = await callTool(base, KEY, 'top_products', { limit: 5 });
    assert.equal(out.json.products.length, 5);
    assert.equal(out.json.totalProducts, 40);
    out = await callTool(base, KEY, 'list_staff');
    assert.ok(!out.text.includes('secret-hash'));
    assert.deepEqual(Object.keys(out.json[0]).sort(), ['claimed', 'commissionTier', 'createdAt', 'email', 'id', 'name', 'role']);
    out = await callTool(base, KEY, 'commission_report', { month: '2026-09' });
    assert.equal(out.json.period.month, '2026-09');
    assert.equal(out.json.reps[0].commission, 5);
    out = await callTool(base, KEY, 'sales_summary');
    assert.equal(out.json.current.revenue, 10);
    out = await callTool(base, KEY, 'crm_status');
    assert.equal(out.json.shop, SHOP);
  });
});

test('filterCompanies helper sorts by days since order', () => {
  const rows = [
    { name: 'A', status: 'active', daysSinceLastOrder: 3, lifetime: { revenue: 5, orders: 1 }, range: { revenue: 0, orders: 0 } },
    { name: 'B', status: 'dormant', daysSinceLastOrder: 200, lifetime: { revenue: 1, orders: 1 }, range: { revenue: 0, orders: 0 } },
  ];
  assert.deepEqual(mcp.filterCompanies(rows, { sort: 'days_since_order' }).companies.map((c) => c.name), ['B', 'A']);
  assert.equal(mcp.clampInt('500', 25, 100), 100);
  assert.equal(mcp.clampInt(undefined, 25, 100), 25);
});
