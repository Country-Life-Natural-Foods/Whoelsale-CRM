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
    { id: 'gid://m/6', handle: 'b2b-new-name-main-3' },      // current
  ];
  const current = new Set(['b2b-acme-main-1', 'b2b-new-name-main-3', 'b2b-new-name-main-4']);
  const pinned = new Set(existing.map((p) => p.handle));
  const stale = selectStalePins(existing, current, pinned).map((p) => p.handle);
  assert.deepEqual(stale.sort(), ['b2b-gone-co-main-2', 'b2b-old-name-main-3']);
});

function fakeShopify({ companies, pins }) {
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
      deleted.push(variables.id);
      data = { metaobjectDelete: { deletedId: variables.id, userErrors: [] } };
    } else {
      throw new Error('Unexpected query: ' + query.slice(0, 60));
    }
    return { ok: true, json: async () => ({ data }) };
  };
  return { fetchImpl, deleted, upserted };
}

function company(id, name, locs) {
  return {
    id: `gid://shopify/Company/${id}`,
    name,
    locations: {
      pageInfo: { hasNextPage: false },
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

function pin(n, handle) {
  return { id: `gid://m/${n}`, handle, fields: [{ key: 'latitude', value: '42' }, { key: 'longitude', value: '-86' }] };
}

async function withFetch(fetchImpl, env, fn) {
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
  const stats = await withFetch(fake.fetchImpl, { MAPBOX_ACCESS_TOKEN: 'pk.test', B2B_SYNC_PRUNE_MAX_RATIO: '0.9' }, () => runSync(OPTS));
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
  const stats = await withFetch(failingGeocode, { MAPBOX_ACCESS_TOKEN: 'pk.test', B2B_SYNC_PRUNE_MAX_RATIO: '0.9' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.equal(stats.skipped, 1);
});

test('runSync deletes nothing when too many pins look stale', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']])],
    pins: [pin(1, 'b2b-acme-main-11'), pin(2, 'b2b-a-main-2'), pin(3, 'b2b-b-main-3')],
  });
  const stats = await withFetch(fake.fetchImpl, { MAPBOX_ACCESS_TOKEN: 'pk.test' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.equal(stats.deleted, 0);
  assert.match(stats.errors.join(' '), /Skipped removing 2 of 3/);
});

test('runSync deletes nothing when B2B_SYNC_PRUNE=false', async () => {
  const fake = fakeShopify({
    companies: [company(1, 'Acme', [[11, 'Main']]), company(2, 'Beta', [[22, 'Main']])],
    pins: [pin(1, 'b2b-acme-main-11'), pin(2, 'b2b-beta-main-22'), pin(3, 'b2b-gone-main-33')],
  });
  const stats = await withFetch(fake.fetchImpl, { MAPBOX_ACCESS_TOKEN: 'pk.test', B2B_SYNC_PRUNE: 'false' }, () => runSync(OPTS));
  assert.deepEqual(fake.deleted, []);
  assert.equal(stats.deleted, 0);
});
