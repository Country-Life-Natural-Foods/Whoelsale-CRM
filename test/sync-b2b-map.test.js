'use strict';

// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const { runSync, selectStalePins, locationIdFromHandle } = require('../lib/sync-b2b-map');

test('locationIdFromHandle reads the trailing Shopify id', () => {
  assert.equal(locationIdFromHandle('b2b-acme-main-st-12345'), '12345');
  assert.equal(locationIdFromHandle('custom-pin'), null);
  assert.equal(locationIdFromHandle(undefined), null);
});

test('selectStalePins keeps current pins and drops gone or renamed ones', () => {
  const existing = [
    { id: 'gid://m/1', handle: 'b2b-acme-main-1' },          // current
    { id: 'gid://m/2', handle: 'b2b-gone-co-main-2' },       // location deleted
    { id: 'gid://m/3', handle: 'b2b-old-name-main-3' },      // renamed, new pin exists
    { id: 'gid://m/4', handle: 'b2b-old-name-main-4' },      // renamed, new pin not made yet
    { id: 'gid://m/5', handle: 'hand-made-pin' },            // not made by the sync
    { id: 'gid://m/7', handle: 'b2b-partners-list' },        // hand-made, no location id
    { id: 'gid://m/6', handle: 'b2b-new-name-main-3' },      // current
  ];
  const current = new Set(['b2b-acme-main-1', 'b2b-new-name-main-3', 'b2b-new-name-main-4']);
  const pinned = new Set(existing.map((p) => p.handle));
  const stale = selectStalePins(existing, current, pinned).map((p) => p.handle);
  assert.deepEqual(stale.sort(), ['b2b-gone-co-main-2', 'b2b-old-name-main-3']);
});

test('selectStalePins keeps pins changed at or after the cutoff', () => {
  const cutoff = Date.parse('2026-11-25T21:00:00Z');
  const existing = [
    { id: 'gid://m/1', handle: 'b2b-gone-main-1', updatedAt: '2026-02-04T00:00:00Z' },
    { id: 'gid://m/2', handle: 'b2b-new-elsewhere-main-2', updatedAt: '2026-11-25T21:00:05Z' },
    { id: 'gid://m/3', handle: 'b2b-no-date-main-3' },
  ];
  const stale = selectStalePins(existing, new Set(), new Set(), { notUpdatedSince: cutoff }).map((p) => p.handle);
  assert.deepEqual(stale, ['b2b-gone-main-1']);
});

function fakeShopify({ companies, pins, failDeletes = [] }) {
  const deleted = [];
  const upserted = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('mapbox.com')) {
      return { ok: true, json: async () => ({ features: [{ geometry: { coordinates: [-86, 42] } }] }) };
    }
    const { query, variables } = JSON.parse(init.body);
    let data;
    if (query.includes('getCompanies')) {
      data = { companies: { edges: companies.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } };
    } else if (query.includes('getB2bMapDef')) {
      data = { metaobjectDefinitionByType: { id: 'gid://def/1' } };
    } else if (query.includes('getMetaobjects')) {
      data = { metaobjects: { edges: pins.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } };
    } else if (query.includes('metaobjectUpsert')) {
      upserted.push(variables.handle.handle);
      data = { metaobjectUpsert: { metaobject: { id: 'gid://m/new' }, userErrors: [] } };
    } else if (query.includes('metaobjectDelete')) {
      if (failDeletes.includes(variables.id)) {
        data = { metaobjectDelete: { deletedId: null, userErrors: [{ field: ['id'], message: 'not found' }] } };
      } else {
        deleted.push(variables.id);
        data = { metaobjectDelete: { deletedId: variables.id, userErrors: [] } };
      }
    } else {
      throw new Error('Unexpected query: ' + query.slice(0, 60));
    }
    return { ok: true, json: async () => ({ data }) };
  };
  return { fetchImpl, deleted, upserted };
}

function company(id, name, locs, { moreLocations = false } = {}) {
  return {
    id: `gid://shopify/Company/${id}`,
    name,
    locations: {
      pageInfo: { hasNextPage: moreLocations },
      edges: locs.map(([locId, locName]) => ({
        node: {
          id: `gid://shopify/CompanyLocation/${locId}`,
          name: locName,
          phone: null,
          shippingAddress: { address1: '1 Main St', city: 'Holland', province: 'MI', zip: '49423', country: 'US' },
          billingAddress: null,
        },
      })),
    },
  };
}

function pin(n, handle, updatedAt = '2026-02-04T00:00:00Z') {
  return { id: `gid://m/${n}`, handle, updatedAt, fields: [{ key: 'latitude', value: '42' }, { key: 'longitude', value: '-86' }] };
}

// Every test sets these so a developer's shell settings can't change results.
const BASE_ENV = {
  MAPBOX_ACCESS_TOKEN: 'pk.test',
  B2B_SYNC_PRUNE: '',
  B2B_SYNC_PRUNE_MAX_RATIO: '',
  B2B_SYNC_BUDGET_MS: '',
  B2B_SYNC_LIMIT: '',
  B2B_SYNC_CONCURRENCY: '',
};

async function withFetch(fetchImpl, extraEnv, fn) {
  const env = { ...BASE_ENV, ...extraEnv };
  const prevFetch = global.fetch;
  const prevEnv = {};
  for (const k of Object.keys(env)) { prevEnv[k] = process.env[k]; process.env[k] = env[k]; }
  global.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    global.fetch = prevFetch;
    for (const k of Object.keys(env)) {
      if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
    }
  }
}

const OPTS = { shop: 'clnf.myshopify.com', accessToken: 'test' };

test('runSync deletes pins for removed and renamed locations', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']]), company(2, 'New Name', [[22, 'Main']])],
    pins: [
      pin(1, 'b2b-acme-main-11'),
      pin(2, 'b2b-new-name-main-22'),
      pin(3, 'b2b-old-name-main-22'),
      pin(4, 'b2b-closed-shop-main-33'),
    ],
  });
  const stats = await withFetch(fake.fetchImpl, { B2B_SYNC_PRUNE_MAX_RATIO: '0.9' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted.sort(), ['gid://m/3', 'gid://m/4']);
  assert.equal(stats.deleted, 2);
  assert.equal(stats.updated, 2);
  assert.deepEqual(fake.upserted, []);
});

test('runSync keeps an old pin until the renamed location has its new pin', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']]), company(2, 'New Name', [[22, 'Main']])],
    pins: [pin(1, 'b2b-acme-main-11'), pin(3, 'b2b-old-name-main-22')],
  });
  const failingGeocode = async (url, init) => {
    if (String(url).includes('mapbox.com')) return { ok: false, status: 500, text: async () => 'down' };
    return fake.fetchImpl(url, init);
  };
  const stats = await withFetch(failingGeocode, { B2B_SYNC_PRUNE_MAX_RATIO: '0.9' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.equal(stats.skipped, 1);
});

test('runSync deletes nothing when too many pins look stale', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']])],
    pins: [pin(1, 'b2b-acme-main-11'), pin(2, 'b2b-a-main-2'), pin(3, 'b2b-b-main-3')],
  });
  const stats = await withFetch(fake.fetchImpl, {}, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.equal(stats.deleted, 0);
  assert.match(stats.pruneNote, /2 of 3 looked stale/);
});

test('runSync deletes nothing when B2B_SYNC_PRUNE=false', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']]), company(2, 'Beta', [[22, 'Main']])],
    pins: [pin(1, 'b2b-acme-main-11'), pin(2, 'b2b-beta-main-22'), pin(3, 'b2b-gone-main-33')],
  });
  const stats = await withFetch(fake.fetchImpl, { B2B_SYNC_PRUNE: 'false' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.equal(stats.deleted, 0);
});

test('runSync keeps a pin another sync just made', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']]), company(2, 'Beta', [[22, 'Main']])],
    pins: [
      pin(1, 'b2b-acme-main-11'),
      pin(2, 'b2b-beta-main-22'),
      pin(3, 'b2b-brand-new-main-33', new Date().toISOString()),
    ],
  });
  const stats = await withFetch(fake.fetchImpl, { B2B_SYNC_PRUNE_MAX_RATIO: '0.9' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.equal(stats.deleted, 0);
});

test('runSync falls back to the 50% limit when the setting is not a fraction', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']])],
    pins: [pin(1, 'b2b-acme-main-11'), pin(2, 'b2b-a-main-2'), pin(3, 'b2b-b-main-3')],
  });
  const stats = await withFetch(fake.fetchImpl, { B2B_SYNC_PRUNE_MAX_RATIO: '50' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.match(stats.pruneNote, /2 of 3 looked stale \(over 50%\)/);
});

test('runSync removes nothing when a company has more than 50 locations', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']], { moreLocations: true }), company(2, 'Beta', [[22, 'Main']])],
    pins: [pin(1, 'b2b-acme-main-11'), pin(2, 'b2b-beta-main-22'), pin(3, 'b2b-gone-main-33')],
  });
  const stats = await withFetch(fake.fetchImpl, { B2B_SYNC_PRUNE_MAX_RATIO: '0.9' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.match(stats.pruneNote, /more than 50 locations/);
});

test('runSync keeps going when one delete fails and reports it', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']]), company(2, 'Beta', [[22, 'Main']])],
    pins: [
      pin(1, 'b2b-acme-main-11'),
      pin(2, 'b2b-beta-main-22'),
      pin(3, 'b2b-gone-main-33'),
      pin(4, 'b2b-gone-main-44'),
    ],
    failDeletes: ['gid://m/3'],
  });
  const stats = await withFetch(fake.fetchImpl, { B2B_SYNC_PRUNE_MAX_RATIO: '0.9' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, ['gid://m/4']);
  assert.equal(stats.deleted, 1);
  assert.match(stats.pruneNote, /1 old pin could not be removed/);
});

test('runSync pauses removal near the time limit', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']]), company(2, 'Beta', [[22, 'Main']])],
    pins: [pin(1, 'b2b-acme-main-11'), pin(2, 'b2b-beta-main-22'), pin(3, 'b2b-gone-main-33')],
  });
  const stats = await withFetch(fake.fetchImpl, { B2B_SYNC_PRUNE_MAX_RATIO: '0.9', B2B_SYNC_BUDGET_MS: '1000' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.equal(stats.incomplete, true);
  assert.match(stats.pruneNote, /1 old pin left for the next run/);
});
