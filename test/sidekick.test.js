'use strict';

// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const sidekick = require('../lib/sidekick');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-11T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

test('orderStatus matches the Customers tab badge buckets', () => {
  assert.equal(sidekick.orderStatus(null), 'never_ordered');
  assert.equal(sidekick.orderStatus(0), 'active');
  assert.equal(sidekick.orderStatus(30), 'active');
  assert.equal(sidekick.orderStatus(31), 'at_risk');
  assert.equal(sidekick.orderStatus(89), 'at_risk');
  assert.equal(sidekick.orderStatus(90), 'dormant');
});

test('companyAdminUri and numericId handle GIDs and bare ids', () => {
  assert.equal(sidekick.numericId('gid://shopify/Company/42'), '42');
  assert.equal(sidekick.companyAdminUri('gid://shopify/Company/42'), 'shopify://admin/companies/42');
  assert.equal(sidekick.companyAdminUri(null), null);
});

test('clampLimit caps at 25 and falls back on junk', () => {
  assert.equal(sidekick.clampLimit('100'), 25);
  assert.equal(sidekick.clampLimit('abc'), 10);
  assert.equal(sidekick.clampLimit('0', 15), 15);
  assert.equal(sidekick.clampLimit('7'), 7);
});

test('parseNotes sorts newest first, drops empties, survives bad JSON', () => {
  const value = JSON.stringify([
    { id: 'a', body: 'old', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', body: '', createdAt: '2026-12-01T00:00:00Z' },
    { id: 'c', body: 'new', createdAt: '2026-10-01T00:00:00Z' },
  ]);
  assert.deepEqual(sidekick.parseNotes(value).map((n) => n.id), ['c', 'a']);
  assert.deepEqual(sidekick.parseNotes('{not json'), []);
  assert.deepEqual(sidekick.parseNotes(null), []);
});

test('formatNote trims long bodies', () => {
  const note = sidekick.formatNote({ body: 'x'.repeat(1000), author: 'Jess', createdAt: '2026-10-01T10:00:00Z' });
  assert.equal(note.date, '2026-10-01');
  assert.equal(note.body.length, 400);
  assert.ok(note.body.endsWith('…'));
});

test('matchesRep: name, email, unassigned, and no filter', () => {
  const staff = { staffId: 's1', name: 'Jessica Smith', email: 'jess@example.com' };
  assert.equal(sidekick.matchesRep(staff, 'jessica'), true);
  assert.equal(sidekick.matchesRep(staff, 'JESS@'), true);
  assert.equal(sidekick.matchesRep(staff, 's1'), true);
  assert.equal(sidekick.matchesRep(staff, 'michael'), false);
  assert.equal(sidekick.matchesRep(null, 'unassigned'), true);
  assert.equal(sidekick.matchesRep(staff, 'unassigned'), false);
  assert.equal(sidekick.matchesRep(null, null), true);
});

test('matchesQuery: every word must match; phone digits ignore formatting', () => {
  const company = { name: 'Green Valley Market', email: 'buyer@gvm.com', phone: '(555) 123-4567' };
  assert.equal(sidekick.matchesQuery(company, 'green market'), true);
  assert.equal(sidekick.matchesQuery(company, 'green bakery'), false);
  assert.equal(sidekick.matchesQuery(company, '555-123'), true);
  assert.equal(sidekick.matchesQuery(company, 'gvm.com'), true);
  assert.equal(sidekick.matchesQuery(company, ''), true);
});

test('averageGapDays uses distinct order days', () => {
  assert.equal(sidekick.averageGapDays(['2026-01-01']), null);
  assert.equal(sidekick.averageGapDays(['2026-01-01', '2026-01-31', '2026-03-02']), 30);
  assert.equal(sidekick.averageGapDays(['2026-01-01', '2026-01-01', '2026-01-11']), 10);
});

const COMPANIES = [
  { id: 'gid://shopify/Company/1', name: 'Active Co', assignedStaff: { staffId: 's1', name: 'Jessica' } },
  { id: 'gid://shopify/Company/2', name: 'Quiet Co', assignedStaff: { staffId: 's1', name: 'Jessica' } },
  { id: 'gid://shopify/Company/3', name: 'Middle Co', assignedStaff: { staffId: 's2', name: 'Michael' } },
  { id: 'gid://shopify/Company/4', name: 'Prospect Co', assignedStaff: null,
    sampleBox: { status: 'sent', sentAt: ago(10), followUpDueAt: ago(-3) } },
  { id: 'gid://shopify/Company/5', name: 'Sample Late Co', assignedStaff: null,
    sampleBox: { status: 'sent', sentAt: ago(20), followUpDueAt: ago(5) } },
];
const ROLLUPS = new Map([
  ['gid://shopify/Company/1', { lastOrderDate: ago(5), orderCount: 40, totalSpend: 5000 }],
  ['gid://shopify/Company/2', { lastOrderDate: ago(120), orderCount: 2, totalSpend: 300 }],
  ['gid://shopify/Company/3', { lastOrderDate: ago(45), orderCount: 9, totalSpend: 1200 }],
]);

test('followUpRows: dormant, at_risk, new_partner, sample_follow_up', () => {
  const dormant = sidekick.followUpRows(COMPANIES, ROLLUPS, { kind: 'dormant', now: NOW });
  assert.deepEqual(dormant.accounts.map((a) => a.name), ['Quiet Co']);

  const atRisk = sidekick.followUpRows(COMPANIES, ROLLUPS, { kind: 'at_risk', now: NOW });
  assert.deepEqual(atRisk.accounts.map((a) => a.name), ['Middle Co']);

  const fresh = sidekick.followUpRows(COMPANIES, ROLLUPS, { kind: 'new_partner', now: NOW });
  assert.deepEqual(fresh.accounts.map((a) => a.name), ['Quiet Co']);

  const samples = sidekick.followUpRows(COMPANIES, ROLLUPS, { kind: 'sample_follow_up', now: NOW });
  assert.deepEqual(samples.accounts.map((a) => a.name), ['Sample Late Co', 'Prospect Co']);
  assert.equal(samples.accounts[0].sampleBox.status, 'sent');

  const mine = sidekick.followUpRows(COMPANIES, ROLLUPS, { kind: 'dormant', rep: 'michael', now: NOW });
  assert.equal(mine.total, 0);
});

// ---------------------------------------------------------------------------
// Router, with fake Shopify / Neon / staff dependencies
// ---------------------------------------------------------------------------

function fakeDeps({ storedSession = { accessToken: 'stored' }, companies = COMPANIES } = {}) {
  const calls = { tokenExchange: 0, graphql: [] };
  const company2 = {
    id: 'gid://shopify/Company/2',
    name: 'Quiet Co',
    contacts: { edges: [{ node: { isMainContact: true, title: 'Buyer', customer: {
      displayName: 'Pat Buyer',
      defaultEmailAddress: { emailAddress: 'pat@quiet.co' },
      defaultPhoneNumber: { phoneNumber: '+15551234567' },
    } } }] },
    locations: { edges: [{ node: { phone: '+15550000000', shippingAddress: { city: 'Albany', zoneCode: 'NY', country: 'United States' } } }] },
    notes: { value: JSON.stringify([
      { id: 'n1', body: 'Called, wants spring catalog', author: 'Jessica', createdAt: '2026-10-02T15:00:00Z' },
      { id: 'n2', body: 'Intro call', author: 'Jessica', createdAt: '2026-06-01T15:00:00Z' },
    ]) },
    sampleBox: { value: JSON.stringify({ status: 'received', receivedAt: '2026-09-01T00:00:00Z' }) },
    assignedStaff: { value: JSON.stringify({ staffId: 's1', name: 'Jessica', assignedAt: '2026-08-31T00:00:00Z' }) },
  };
  const shopify = {
    session: {
      decodeSessionToken: async (token) => {
        if (token !== 'good-token') throw new Error('bad token');
        return { dest: 'https://clnf.myshopify.com', sub: 'user-1' };
      },
      getOfflineId: (shop) => `offline_${shop}`,
    },
    auth: {
      tokenExchange: async () => {
        calls.tokenExchange += 1;
        return { session: { id: 'offline_clnf.myshopify.com', accessToken: 'exchanged' } };
      },
    },
    clients: {
      Graphql: class {
        constructor({ session }) { this.session = session; }
        async request(query, { variables } = {}) {
          calls.graphql.push({ query, variables });
          if (query.includes('SidekickCompany(')) {
            return { data: { company: variables.id === company2.id ? company2 : null } };
          }
          return { data: { companies: { edges: [] } } };
        }
      },
    },
  };
  const stored = new Map();
  if (storedSession) stored.set('offline_clnf.myshopify.com', storedSession);
  const sessionStorage = {
    loadSession: async (id) => stored.get(id),
    storeSession: async (s) => { stored.set(s.id, s); return true; },
  };
  const companyMetrics = {
    enabled: true,
    companiesRange: async () => ROLLUPS,
    companyRange: async (shop, id, start) => {
      if (start) return { revenue: start.startsWith('2026') ? 300 : 200, orderCount: 1, contactCheckoutOrderCount: 0 };
      return {
        lastOrderDate: ago(120),
        orderCount: 2,
        days: [{ date: '2026-06-01', orders: 1 }, { date: '2026-07-01', orders: 1 }],
      };
    },
    companyProductsRange: async () => [{ title: 'Vitamin C', orderCount: 2, unitsSold: 24, revenue: 240 }],
    shopRangeTotals: async (shop, start) => (start.startsWith('2026')
      ? { revenue: 15000, orderCount: 50, activeCompanies: 3 }
      : { revenue: 10000, orderCount: 40, activeCompanies: 2 }),
    revenueByDay: async (shop, start, end) => {
      const out = [];
      for (let t = Date.parse(start); t <= Date.parse(end); t += 7 * DAY) {
        out.push({ date: new Date(t).toISOString().slice(0, 10), orders: 1, revenue: 100 });
      }
      return out;
    },
    productsRange: async () => [
      { title: 'Vitamin C', unitsSold: 500, revenue: 5000, avgUnitPrice: 10 },
      { title: 'Zinc', unitsSold: 100, revenue: 900, avgUnitPrice: 9 },
    ],
    isComplete: async () => true,
    isProductsReady: async () => true,
  };
  const staffStore = {
    findByShopifyUserId: async (id) => (id === 'user-1' ? { id: 's1', name: 'Jessica' } : null),
  };
  const deps = {
    shopify,
    sessionStorage,
    companyMetrics,
    staffStore,
    getCompanyList: async () => companies,
    intelligenceRanges: () => ({
      current: { startDate: '2026-01-01', endDate: '2026-11-11' },
      previous: { startDate: '2025-01-01', endDate: '2025-11-11' },
    }),
  };
  return { deps, calls, stored };
}

async function withServer(deps, fn) {
  const app = express();
  app.use('/api/sidekick', sidekick.createSidekickRouter(deps));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, token = 'good-token') => {
    const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };
  try {
    await fn(get);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('router rejects missing or bad session tokens', async () => {
  const { deps } = fakeDeps();
  await withServer(deps, async (get) => {
    assert.equal((await get('/api/sidekick/accounts', null)).status, 401);
    assert.equal((await get('/api/sidekick/accounts', 'nope')).status, 401);
  });
});

test('router uses token exchange only when no offline session is stored', async () => {
  const withSession = fakeDeps();
  await withServer(withSession.deps, async (get) => {
    assert.equal((await get('/api/sidekick/accounts')).status, 200);
  });
  assert.equal(withSession.calls.tokenExchange, 0);

  const without = fakeDeps({ storedSession: null });
  await withServer(without.deps, async (get) => {
    assert.equal((await get('/api/sidekick/accounts')).status, 200);
  });
  assert.equal(without.calls.tokenExchange, 1);
  assert.equal(without.stored.get('offline_clnf.myshopify.com').accessToken, 'exchanged');
});

test('search_accounts filters by query, rep "me" and status', async () => {
  const { deps } = fakeDeps();
  await withServer(deps, async (get) => {
    const byName = await get('/api/sidekick/accounts?query=quiet');
    assert.deepEqual(byName.body.accounts.map((a) => a.name), ['Quiet Co']);
    assert.equal(byName.body.accounts[0].status, 'dormant');
    assert.equal(byName.body.results[0].type, 'resource_link');

    const mine = await get('/api/sidekick/accounts?rep=me');
    assert.deepEqual(mine.body.accounts.map((a) => a.name).sort(), ['Active Co', 'Quiet Co']);

    const never = await get('/api/sidekick/accounts?status=never_ordered');
    assert.deepEqual(never.body.accounts.map((a) => a.name).sort(), ['Prospect Co', 'Sample Late Co']);
  });
});

test('search_accounts falls back to Shopify search while the list warms up', async () => {
  const { deps, calls } = fakeDeps({ companies: null });
  await withServer(deps, async (get) => {
    const noQuery = await get('/api/sidekick/accounts');
    assert.equal(noQuery.body.status, 'warming_up');
    const withQuery = await get('/api/sidekick/accounts?query=quiet');
    assert.equal(withQuery.status, 200);
    assert.equal(calls.graphql.at(-1).variables.query, 'quiet');
  });
});

test('get_account returns rep, cadence, sample box, notes and no commission data', async () => {
  const { deps } = fakeDeps();
  await withServer(deps, async (get) => {
    const res = await get('/api/sidekick/accounts/2');
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Quiet Co');
    assert.equal(res.body.rep, 'Jessica');
    assert.equal(res.body.repAssignedSince, '2026-08-31');
    assert.equal(res.body.typicalDaysBetweenOrders, 30);
    assert.equal(res.body.sampleBox.status, 'received');
    assert.equal(res.body.latestNotes[0].body, 'Called, wants spring catalog');
    assert.equal(res.body.contacts[0].email, 'pat@quiet.co');
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('commission'));

    assert.equal((await get('/api/sidekick/accounts/999')).status, 404);
  });
});

test('get_account_notes, follow-ups, buying intel; no rep_book route', async () => {
  const { deps } = fakeDeps();
  await withServer(deps, async (get) => {
    const notes = await get('/api/sidekick/accounts/2/notes?limit=1');
    assert.equal(notes.body.total, 2);
    assert.equal(notes.body.notes.length, 1);

    const follow = await get('/api/sidekick/follow-ups?kind=sample_follow_up');
    assert.deepEqual(follow.body.accounts.map((a) => a.name), ['Sample Late Co', 'Prospect Co']);

    const buying = await get('/api/sidekick/accounts/2/buying');
    assert.equal(buying.body.status, 'ready');
    assert.equal(buying.body.changePercent, 50);
    assert.equal(buying.body.topProducts[0].title, 'Vitamin C');

    assert.equal((await get('/api/sidekick/reps/book')).status, 404);
  });
});

test('every list response stays small (well under ~4,000 tokens)', async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({
    id: `gid://shopify/Company/${1000 + i}`,
    name: `Wholesale Account Number ${i}`,
    assignedStaff: { staffId: 's1', name: 'Jessica' },
  }));
  const { deps } = fakeDeps({ companies: many });
  await withServer(deps, async (get) => {
    for (const path of [
      '/api/sidekick/accounts?limit=25',
      '/api/sidekick/follow-ups?kind=dormant&limit=25',
      '/api/sidekick/analytics/accounts?limit=25',
      '/api/sidekick/analytics/trend?period=day&startDate=2025-01-01&endDate=2026-11-11',
    ]) {
      const res = await get(path);
      // ~4 characters per token is a conservative rule of thumb.
      assert.ok(JSON.stringify(res.body).length < 12000, `${path} too large`);
    }
  });
});

test('parseRange defaults to year to date and rejects bad input', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const ytd = sidekick.parseRange(null, null, now);
  assert.deepEqual([ytd.startDate, ytd.endDate], ['2026-01-01', '2026-11-11']);
  assert.equal(sidekick.parseRange('2026-02-30', null, now).error, 'Dates must be YYYY-MM-DD.');
  assert.ok(sidekick.parseRange('2026-05-01', '2026-04-01', now).error);
  const prior = sidekick.priorYearRange(sidekick.parseRange('2024-02-29', '2024-03-31', now));
  assert.equal(prior.startDate, '2023-02-28');
  assert.equal(prior.endIso, '2023-03-31T23:59:59.999Z');
});

test('bucketTrend groups by Monday week and by month', () => {
  const days = [
    { date: '2026-11-02', orders: 1, revenue: 10.1 }, // Monday
    { date: '2026-11-08', orders: 2, revenue: 20.2 }, // Sunday, same week
    { date: '2026-11-09', orders: 1, revenue: 5 },
  ];
  assert.deepEqual(sidekick.bucketTrend(days, 'week').map((p) => [p.period, p.orders, p.revenue]),
    [['2026-11-02', 3, 30.3], ['2026-11-09', 1, 5]]);
  assert.deepEqual(sidekick.bucketTrend(days, 'month').map((p) => p.period), ['2026-11']);
});

test('analytics tools: summary, trend, top accounts, top products', async () => {
  const { deps } = fakeDeps();
  await withServer(deps, async (get) => {
    const summary = await get('/api/sidekick/analytics/summary?startDate=2026-01-01&endDate=2026-11-11');
    assert.equal(summary.body.revenue, 15000);
    assert.equal(summary.body.averageOrderValue, 300);
    assert.equal(summary.body.sameDatesLastYear.startDate, '2025-01-01');
    assert.equal(summary.body.revenueChangePercent, 50);
    assert.equal(summary.body.topProduct.title, 'Vitamin C');

    const trend = await get('/api/sidekick/analytics/trend?startDate=2026-01-01&endDate=2026-03-31');
    assert.equal(trend.body.period, 'month');
    assert.deepEqual(trend.body.points.map((p) => p.period), ['2026-01', '2026-02', '2026-03']);

    const accounts = await get('/api/sidekick/analytics/accounts?sortBy=orders');
    assert.deepEqual(accounts.body.accounts.map((a) => a.name), ['Active Co', 'Middle Co', 'Quiet Co']);
    assert.ok(accounts.body.accounts.every((a) => !('rep' in a)), 'no rep on revenue rankings');

    const products = await get('/api/sidekick/analytics/products?limit=1');
    assert.equal(products.body.productsSold, 2);
    assert.equal(products.body.products[0].title, 'Vitamin C');

    assert.equal((await get('/api/sidekick/analytics/summary?startDate=nope')).status, 400);
  });
});

test('analytics tools say backfilling until the rollup is complete', async () => {
  const { deps } = fakeDeps();
  deps.companyMetrics.isComplete = async () => false;
  await withServer(deps, async (get) => {
    for (const path of ['summary', 'trend', 'accounts', 'products']) {
      assert.equal((await get(`/api/sidekick/analytics/${path}`)).body.status, 'backfilling');
    }
  });
});
