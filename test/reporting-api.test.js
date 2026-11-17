'use strict';

// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const reporting = require('../lib/reporting-api');

const KEY = 'k'.repeat(40);
const NOW = new Date('2026-11-17T12:00:00Z');
const SHOP = 'clnf.myshopify.com';
const C1 = 'gid://shopify/Company/1';
const C2 = 'gid://shopify/Company/2';

function fakeMetrics(overrides = {}) {
  return {
    enabled: true,
    async status() { return { ready: true, productsReady: true, status: 'complete', lastBackfillAt: null }; },
    async isComplete() { return true; },
    async orderCoverage() { return { oldest: '2024-01-01T00:00:00.000Z', newest: '2026-11-16T00:00:00.000Z', orderCount: 3 }; },
    async getCompanySnapshot() { return { companies: [{}, {}], updatedAt: new Date('2026-11-17T11:50:00Z') }; },
    async companiesRange(shop, start) {
      if (start) return new Map([[C1, { totalSpend: 100, orderCount: 2 }]]);
      return new Map([[C1, { totalSpend: 1000, orderCount: 10, lastOrderDate: '2026-11-10T00:00:00.000Z' }]]);
    },
    async listOrders(shop, opts) {
      this.lastListOrders = opts;
      return {
        rows: [{ orderId: 'o1', companyId: C1, createdAt: '2026-01-01T00:00:00.000000Z', revenue: 10 }],
        nextCursor: ['2026-01-01T00:00:00.000000Z', 'o1'],
      };
    },
    async monthlyRevenueByCompany() {
      return new Map([[C1, new Map([['2026-10', 200], ['2026-11', 100]])]]);
    },
    async revenueByDay() { return []; },
    ...overrides,
  };
}

const staff = [
  { id: 's1', name: 'Jess', email: 'jess@example.com', role: 'rep', commissionTier: 5, shopifyUserId: 'u1', createdAt: '2026-01-01', hasPin: true, pinHash: 'secret' },
  { id: 's2', name: 'Sam', email: 'sam@example.com', role: 'manager', commissionTier: 0, shopifyUserId: null, createdAt: '2026-01-02' },
];

const companies = [
  {
    id: C2, name: 'Beta', email: null, phone: null, assignedStaff: null, sampleBox: { status: 'none' },
  },
  {
    id: C1,
    name: 'Acme',
    email: 'buyer@acme.test',
    phone: '555',
    assignedStaff: { staffId: 's1', assignedAt: '2026-01-01T00:00:00Z' },
    sampleBox: { status: 'sent', sentAt: '2026-11-01', note: 'rep-written text', sentBy: 'Jess' },
    notes: [{ body: 'should never appear' }],
  },
];

async function withServer(options, fn) {
  const app = express();
  app.set('trust proxy', 1);
  const metrics = options.metrics || fakeMetrics();
  app.use('/r', reporting.createReportingRouter({
    companyMetrics: metrics,
    staffStore: { async list() { return staff; } },
    resolveShop: async () => SHOP,
    getShopifyClient: async () => ({ fake: true }),
    getCompanies: async () => companies,
    getCommissionReport: async (client, month) => ({
      period: { month: month || '2026-10' },
      totals: { totalRevenue: 100.005, totalCommission: 5 },
      reps: [{ staffId: 's1', name: 'Jess', email: 'j', commissionTier: 5, totalRevenue: 100, totalCommission: 5,
        companies: [{ companyId: C1, companyName: 'Acme', revenue: 100, commission: 5, assignedAt: null }] }],
      source: 'rollup',
      rollup: { ready: true, status: 'complete' },
    }),
    env: options.env || { REPORTING_API_KEY: KEY },
    now: () => NOW,
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/r`;
  try {
    await fn(base, metrics);
  } finally {
    server.close();
  }
}

const auth = { Authorization: `Bearer ${KEY}` };

test('keys: short keys ignored, rotation list, constant-time match', () => {
  assert.deepEqual(reporting.configuredKeys({ REPORTING_API_KEY: 'short' }), []);
  assert.deepEqual(reporting.configuredKeys({ REPORTING_API_KEY: ` ${KEY} , ${'b'.repeat(32)}` }), [KEY, 'b'.repeat(32)]);
  assert.equal(reporting.keyMatches(KEY, [KEY]), true);
  assert.equal(reporting.keyMatches('b'.repeat(32), [KEY, 'b'.repeat(32)]), true);
  assert.equal(reporting.keyMatches('nope', [KEY]), false);
  assert.equal(reporting.keyMatches(null, [KEY]), false);
  assert.equal(reporting.bearerToken(`bearer ${KEY}`), KEY);
  assert.equal(reporting.bearerToken(`Basic ${KEY}`), null);
});

test('cursors round-trip and reject junk', () => {
  const c = reporting.encodeCursor(['2026-01-01T00:00:00.000000Z', 'o1']);
  assert.deepEqual(reporting.decodeCursor(c, 2), ['2026-01-01T00:00:00.000000Z', 'o1']);
  assert.equal(reporting.decodeCursor(c, 3), false);
  assert.equal(reporting.decodeCursor('!!!', 2), false);
  assert.equal(reporting.decodeCursor(reporting.encodeCursor(['not a date', 'x']), 2), false);
  assert.equal(reporting.decodeCursor('', 2), null);
});

test('trailingMonths ends with the current UTC month', () => {
  const months = reporting.trailingMonths(3, NOW).map((m) => m.month);
  assert.deepEqual(months, ['2026-09', '2026-10', '2026-11']);
  const jan = reporting.trailingMonths(2, new Date('2026-01-15T00:00:00Z')).map((m) => m.month);
  assert.deepEqual(jan, ['2025-12', '2026-01']);
});

test('API is off until a key is configured', async () => {
  await withServer({ env: {} }, async (base) => {
    const res = await fetch(`${base}/status`, { headers: auth });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'NOT_CONFIGURED');
  });
});

test('auth: missing/wrong key 401, key in URL 400, writes 405, no-store', async () => {
  await withServer({}, async (base) => {
    let res = await fetch(`${base}/status`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /Bearer/);
    res = await fetch(`${base}/status`, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(res.status, 401);
    res = await fetch(`${base}/status?api_key=${KEY}`, { headers: auth });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/status`, { method: 'POST', headers: auth });
    assert.equal(res.status, 405);
    res = await fetch(`${base}/status`, { method: 'DELETE', headers: auth });
    assert.equal(res.status, 405);
    res = await fetch(`${base}/status`, { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(res.headers.get('x-request-id'));
  });
});

test('auth: repeated failures lock the caller out', async () => {
  await withServer({}, async (base) => {
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${base}/status`, { headers: { Authorization: 'Bearer wrong' } });
      assert.equal(res.status, 401);
    }
    const res = await fetch(`${base}/status`, { headers: auth });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  });
});

test('CORS closed to browsers unless the origin is listed', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/status`, { headers: { ...auth, Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
  await withServer({ env: { REPORTING_API_KEY: KEY, REPORTING_API_CORS_ORIGINS: 'https://reports.example/' } }, async (base) => {
    const res = await fetch(`${base}/status`, { headers: { ...auth, Origin: 'https://reports.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://reports.example');
  });
});

test('/companies returns every company with numbers, rep and no notes', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/companies`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.count, 2);
    assert.deepEqual(body.meta.range, { start: '2026-01-01', end: '2026-11-17' });
    const [acme, beta] = body.data;
    assert.equal(acme.name, 'Acme'); // sorted by lifetime revenue
    assert.equal(acme.lifetime.revenue, 1000);
    assert.equal(acme.lifetime.avgOrderValue, 100);
    assert.equal(acme.range.revenue, 100);
    assert.equal(acme.status, 'active');
    assert.equal(acme.daysSinceLastOrder, 7);
    assert.equal(acme.assignedRep.name, 'Jess');
    assert.equal(acme.assignedRep.commissionTier, 5);
    assert.deepEqual(acme.sampleBox, { status: 'sent', sentAt: '2026-11-01', sentBy: 'Jess' });
    assert.equal(beta.status, 'never_ordered');
    assert.equal(beta.assignedRep, null);
    const text = JSON.stringify(body);
    assert.ok(!text.includes('should never appear'));
    assert.ok(!text.includes('rep-written text'));
  });
});

test('/companies rejects bad dates', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/companies?start=2026-13-01`, { headers: auth });
    assert.equal(res.status, 400);
  });
});

test('/orders pages with an opaque cursor and validates filters', async () => {
  await withServer({}, async (base, metrics) => {
    let res = await fetch(`${base}/orders?company_id=1&limit=5000`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(metrics.lastListOrders.companyId, C1);
    assert.equal(metrics.lastListOrders.limit, 1000);
    assert.equal(metrics.lastListOrders.startIso, null);
    assert.ok(body.meta.nextCursor);
    res = await fetch(`${base}/orders?cursor=${body.meta.nextCursor}`, { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(metrics.lastListOrders.cursor, ['2026-01-01T00:00:00.000000Z', 'o1']);
    res = await fetch(`${base}/orders?cursor=garbage`, { headers: auth });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/orders?company_id=abc`, { headers: auth });
    assert.equal(res.status, 400);
  });
});

test('/staff never returns PIN data', async () => {
  await withServer({}, async (base) => {
    const body = await (await fetch(`${base}/staff`, { headers: auth })).json();
    assert.equal(body.data.length, 2);
    assert.deepEqual(Object.keys(body.data[0]).sort(), ['claimed', 'commissionTier', 'createdAt', 'email', 'id', 'name', 'role']);
    assert.ok(!JSON.stringify(body).includes('secret'));
  });
});

test('/commissions passes the month through and validates it', async () => {
  await withServer({}, async (base) => {
    let res = await fetch(`${base}/commissions?month=2026-09`, { headers: auth });
    const body = await res.json();
    assert.equal(body.data.period.month, '2026-09');
    assert.equal(body.data.totals.revenue, 100.01);
    assert.equal(body.data.reps[0].companies[0].commission, 5);
    res = await fetch(`${base}/commissions?month=2026-13`, { headers: auth });
    assert.equal(res.status, 400);
  });
});

test('/commissions/monthly builds a rep × month grid from current tiers', async () => {
  await withServer({}, async (base) => {
    const body = await (await fetch(`${base}/commissions/monthly?months=3`, { headers: auth })).json();
    assert.deepEqual(body.data.months, ['2026-09', '2026-10', '2026-11']);
    const jess = body.data.reps.find((r) => r.staffId === 's1');
    assert.deepEqual(jess.months.map((m) => m.commission), [0, 10, 5]);
    assert.equal(jess.totalRevenue, 300);
    const sam = body.data.reps.find((r) => r.staffId === 's2');
    assert.equal(sam.totalCommission, 0);
    assert.deepEqual(body.data.totals.map((t) => t.revenue), [0, 200, 100]);
  });
  await withServer({ metrics: fakeMetrics({ async isComplete() { return false; } }) }, async (base) => {
    const res = await fetch(`${base}/commissions/monthly`, { headers: auth });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'ROLLUP_NOT_READY');
  });
});

test('unknown routes 404 and bad trend period 400', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/nope`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/analytics/trend?period=year`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/analytics/trend?period=week`, { headers: auth })).status, 200);
  });
});
