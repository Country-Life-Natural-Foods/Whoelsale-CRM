'use strict';

// Reporting API (`/api/reporting/v1/*`): read-only access to the numbers the
// Wholesale CRM collects, for an external reporting agent or app.
// Full guide: docs/REPORTING_API.md.
//
// Design rules (Isaac, 2026-11-17):
//   - Read only. Every route is GET; any other method gets 405. Nothing here
//     writes to Neon or Shopify (the one side effect is the shared company
//     snapshot refreshing itself, exactly as it does for the app's own pages).
//   - One shared secret key, handled like a public API key even though the
//     data is sensitive: `Authorization: Bearer <REPORTING_API_KEY>` only (never
//     a query-string key, which ends up in logs), constant-time compare,
//     per-IP rate limits, `Cache-Control: no-store`, no browser CORS unless
//     origins are listed in REPORTING_API_CORS_ORIGINS. The API is off (503)
//     until a key of at least 32 characters is set.
//   - Full visibility for reporting: every company, contact details, rep
//     assignments, commission amounts and tiers. This is deliberately broader
//     than Sidekick, which never sees commissions.
//   - Numbers and data only. Rep-written CRM notes (and the free-text note on
//     a sample box) are not returned.
//   - Never returned: Shopify sessions/access tokens, staff PIN hashes or
//     PIN attempt counters.

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { shopifyGraphql } = require('./shopify-gql');
const { normalizeCompanyId } = require('./order-attribution');
const {
  numericId,
  daysSince,
  orderStatus,
  parseRange,
  priorYearRange,
  bucketTrend,
  percentChange,
} = require('./sidekick');

const API_VERSION = 'v1';
const MIN_KEY_LENGTH = 32;
const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGE_SIZE = 1000;
const MAX_MONTHS = 36;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 120;
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAIL_MAX = 10;
const TREND_PERIODS = ['day', 'week', 'month'];
const SAMPLE_BOX_FIELDS = ['status', 'sentAt', 'receivedAt', 'sentBy', 'followUpDueAt'];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// REPORTING_API_KEY may hold one key, or two comma-separated keys while you
// rotate (old and new both work until the old one is removed). Keys shorter
// than 32 characters are ignored so a placeholder can't open the API.
function configuredKeys(env = process.env) {
  return String(env.REPORTING_API_KEY || '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length >= MIN_KEY_LENGTH);
}

function bearerToken(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ''));
  return match ? match[1] : null;
}

// Hash both sides first so timingSafeEqual always compares equal-length
// buffers and the key length isn't leaked through timing.
function keyMatches(presented, keys) {
  if (!presented || !keys.length) return false;
  const p = crypto.createHash('sha256').update(presented).digest();
  let ok = false;
  for (const key of keys) {
    const k = crypto.createHash('sha256').update(key).digest();
    if (crypto.timingSafeEqual(p, k)) ok = true;
  }
  return ok;
}

function corsOrigins(env = process.env) {
  return String(env.REPORTING_API_CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function clampPageSize(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

function encodeCursor(parts) {
  if (!parts) return null;
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

// Returns the decoded array, null for "no cursor", or false for a bad one.
function decodeCursor(raw, expectedLength) {
  if (raw == null || raw === '') return null;
  try {
    const parts = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!Array.isArray(parts) || parts.length !== expectedLength) return false;
    if (!parts.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 512)) return false;
    if (Number.isNaN(new Date(parts[0]).getTime())) return false;
    return parts;
  } catch {
    return false;
  }
}

// Optional date range for raw rows: no dates means all of history.
function parseOptionalRange(startRaw, endRaw) {
  if (!startRaw && !endRaw) return { startDate: null, endDate: null, startIso: null, endIso: null };
  return parseRange(startRaw || '1970-01-01', endRaw || null);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function monthPeriod(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return {
    month: `${year}-${String(month).padStart(2, '0')}`,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

// Trailing UTC calendar months ending with the current (still open) month,
// oldest first. Same window rule as the Commissions tab.
function trailingMonths(count, now = new Date()) {
  const months = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.push(monthPeriod(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  return months;
}

function sampleBoxData(box) {
  const out = { status: 'none' };
  if (!box || typeof box !== 'object') return out;
  for (const key of SAMPLE_BOX_FIELDS) {
    if (box[key] != null && box[key] !== '') out[key] = box[key];
  }
  return out;
}

function staffData(record) {
  return {
    id: record.id,
    name: record.name,
    email: record.email || null,
    role: record.role,
    commissionTier: Number(record.commissionTier) || 0,
    claimed: Boolean(record.shopifyUserId),
    createdAt: record.createdAt || null,
  };
}

function repData(assignedStaff, staffById) {
  if (!assignedStaff?.staffId) return null;
  const staff = staffById.get(assignedStaff.staffId);
  return {
    staffId: assignedStaff.staffId,
    name: staff?.name || assignedStaff.name || null,
    email: staff?.email || assignedStaff.email || null,
    commissionTier: staff ? Number(staff.commissionTier) || 0 : null,
    assignedAt: assignedStaff.assignedAt || null,
    inStaffRoster: Boolean(staff),
  };
}

function rollupTotals(r) {
  const orders = r?.orderCount || 0;
  const revenue = round2(r?.totalSpend);
  return {
    revenue,
    orders,
    avgOrderValue: orders > 0 ? round2(revenue / orders) : 0,
    contactCheckoutOrders: r?.contactCheckoutOrderCount || 0,
    contactCheckoutRevenue: round2(r?.contactCheckoutRevenue),
  };
}

function companyRow(company, lifetime, inRange, staffById, now = Date.now()) {
  const lastOrderDate = lifetime?.lastOrderDate || null;
  const days = daysSince(lastOrderDate, now);
  return {
    id: company.id,
    numericId: numericId(company.id),
    name: company.name,
    email: company.email || null,
    phone: company.phone || null,
    assignedRep: repData(company.assignedStaff, staffById),
    sampleBox: sampleBoxData(company.sampleBox),
    lastOrderDate,
    daysSinceLastOrder: days,
    status: orderStatus(days),
    lifetime: rollupTotals(lifetime),
    range: rollupTotals(inRange),
  };
}

// One rep × month grid. `revenueByCompany` is Map<companyId, Map<'YYYY-MM', revenue>>
// (company-metrics monthlyRevenueByCompany), already limited to orders on or
// after each company's assignment date.
function monthlyCommissionGrid(jobs, revenueByCompany, months, staffList) {
  const byStaff = new Map(staffList.map((s) => [s.id, new Map()]));
  for (const job of jobs) {
    const perMonth = revenueByCompany.get(job.companyId);
    if (!perMonth) continue;
    const staffMonths = byStaff.get(job.staffId);
    if (!staffMonths) continue;
    for (const [month, revenue] of perMonth) {
      const entry = staffMonths.get(month) || { revenue: 0, commission: 0 };
      entry.revenue += revenue;
      entry.commission += (revenue * job.commissionTier) / 100;
      staffMonths.set(month, entry);
    }
  }
  return staffList
    .map((s) => {
      const staffMonths = byStaff.get(s.id);
      const rows = months.map((m) => {
        const e = staffMonths.get(m.month) || { revenue: 0, commission: 0 };
        return { month: m.month, revenue: round2(e.revenue), commission: round2(e.commission) };
      });
      return {
        staffId: s.id,
        name: s.name,
        email: s.email || null,
        commissionTier: Number(s.commissionTier) || 0,
        months: rows,
        totalRevenue: round2(rows.reduce((sum, r) => sum + r.revenue, 0)),
        totalCommission: round2(rows.reduce((sum, r) => sum + r.commission, 0)),
      };
    })
    .sort((a, b) => b.totalCommission - a.totalCommission);
}

// Fixed-window counter per key. Serverless instances each keep their own
// copy, so this is a per-instance brake, not a global quota.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return {
    // Returns seconds to wait, or 0 when allowed.
    take(key, now = Date.now()) {
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      }
      const entry = hits.get(key);
      if (!entry || now - entry.start >= windowMs) {
        hits.set(key, { start: now, count: 1 });
        return 0;
      }
      entry.count += 1;
      if (entry.count > max) return Math.ceil((entry.start + windowMs - now) / 1000);
      return 0;
    },
    blocked(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || now - entry.start >= windowMs) return 0;
      return entry.count >= max ? Math.ceil((entry.start + windowMs - now) / 1000) : 0;
    },
  };
}

const COMPANY_DETAIL_QUERY = `
  query ReportingCompany($id: ID!) {
    company(id: $id) {
      id
      name
      externalId
      createdAt
      updatedAt
      customerSince
      contacts(first: 50) {
        edges {
          node {
            id
            isMainContact
            title
            customer {
              id
              firstName
              lastName
              displayName
              defaultEmailAddress { emailAddress }
              defaultPhoneNumber { phoneNumber }
            }
          }
        }
      }
      locations(first: 25) {
        edges {
          node {
            id
            name
            phone
            shippingAddress { address1 address2 city zoneCode zip countryCode phone }
            billingAddress { address1 address2 city zoneCode zip countryCode phone }
          }
        }
      }
      sampleBox: metafield(namespace: "clnf", key: "sample_box") { value }
      assignedStaff: metafield(namespace: "clnf", key: "assigned_staff") { value updatedAt }
    }
  }
`;

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function addressData(a) {
  if (!a) return null;
  return {
    address1: a.address1 || null,
    address2: a.address2 || null,
    city: a.city || null,
    province: a.zoneCode || null,
    zip: a.zip || null,
    country: a.countryCode || null,
    phone: a.phone || null,
  };
}

// ---------------------------------------------------------------------------
// Service: the data behind every endpoint, as plain async functions that
// return { data, meta } or throw ReportingError. The HTTP router below and the
// MCP server (lib/mcp-server.js) both call these, so the numbers always match.
// ---------------------------------------------------------------------------

class ReportingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new ReportingError(400, 'BAD_REQUEST', message);

function createReportingService({
  companyMetrics,
  staffStore,
  resolveShop, // async () => shop domain or null
  getShopifyClient, // async (shop) => GraphQL client from the stored offline session, or null
  getCompanies, // async (client, shop) => company list (snapshot-backed, commissions mode)
  getCommissionReport, // async (client, monthParam) => { period, reps, totals, source, rollup }
  now = () => new Date(),
}) {
  async function requireShop() {
    const shop = await resolveShop();
    if (!shop) throw new ReportingError(503, 'NO_SHOP', 'No store is connected to the CRM yet.');
    return shop;
  }

  async function requireClient(shop) {
    const client = await getShopifyClient(shop);
    if (!client) {
      throw new ReportingError(
        503,
        'NO_SHOPIFY_SESSION',
        'The CRM has no stored Shopify session. Open the app in Shopify admin once.',
      );
    }
    return client;
  }

  function requireRange(start, end) {
    const range = parseRange(start, end, now());
    if (range.error) throw badRequest(range.error);
    return range;
  }

  async function rollupMeta(shop) {
    if (!companyMetrics.enabled) return { enabled: false, complete: false, productsComplete: false };
    const s = await companyMetrics.status(shop);
    return {
      enabled: true,
      complete: Boolean(s.ready),
      productsComplete: Boolean(s.productsReady),
      status: s.status || null,
      lastBackfillAt: s.lastBackfillAt || null,
    };
  }

  function meta(extra = {}) {
    return { apiVersion: API_VERSION, generatedAt: now().toISOString(), currencyCode: 'USD', ...extra };
  }

  async function status() {
    const shop = await requireShop();
    const [rollup, coverage, snapshot] = await Promise.all([
      rollupMeta(shop),
      companyMetrics.orderCoverage(shop),
      companyMetrics.getCompanySnapshot(shop),
    ]);
    return {
      data: {
        shop,
        orders: {
          ...rollup,
          oldestOrderAt: coverage.oldest,
          newestOrderAt: coverage.newest,
          orderCount: coverage.orderCount,
        },
        companySnapshot: snapshot
          ? {
            companyCount: snapshot.companies.length,
            updatedAt: snapshot.updatedAt.toISOString(),
            ageMinutes: Math.round((now().getTime() - snapshot.updatedAt.getTime()) / 60000),
          }
          : null,
      },
      meta: meta(),
    };
  }

  async function companies({ start, end } = {}) {
    const range = requireRange(start, end);
    const shop = await requireShop();
    const client = await requireClient(shop);
    const [list, staff, lifetime, inRange, rollup] = await Promise.all([
      getCompanies(client, shop),
      staffStore.list(),
      companyMetrics.companiesRange(shop, null, null),
      companyMetrics.companiesRange(shop, range.startIso, range.endIso),
      rollupMeta(shop),
    ]);
    const staffById = new Map(staff.map((s) => [s.id, s]));
    const nowMs = now().getTime();
    const rows = (list || [])
      .map((c) => companyRow(c, lifetime.get(c.id), inRange.get(c.id), staffById, nowMs))
      .sort((a, b) => b.lifetime.revenue - a.lifetime.revenue || a.name.localeCompare(b.name));
    return {
      data: rows,
      meta: meta({
        count: rows.length,
        range: { start: range.startDate, end: range.endDate },
        rollup,
      }),
    };
  }

  async function company({ id, start, end } = {}) {
    const companyId = normalizeCompanyId(id);
    if (!companyId) throw badRequest('Unknown company id.');
    const range = requireRange(start, end);
    const shop = await requireShop();
    const client = await requireClient(shop);

    const result = await shopifyGraphql(client, COMPANY_DETAIL_QUERY, { id: companyId }, 'reporting company');
    const c = result?.company;
    if (!c) throw new ReportingError(404, 'NOT_FOUND', 'Company not found.');

    const [staff, lifetime, inRange, topProducts, rollup] = await Promise.all([
      staffStore.list(),
      companyMetrics.companyRange(shop, companyId, null, null),
      companyMetrics.companyRange(shop, companyId, range.startIso, range.endIso),
      companyMetrics.companyProductsRange(shop, companyId, range.startIso, range.endIso, 20),
      rollupMeta(shop),
    ]);
    const staffById = new Map(staff.map((s) => [s.id, s]));
    const assigned = parseJson(c.assignedStaff?.value);
    if (assigned && !assigned.assignedAt) assigned.assignedAt = c.assignedStaff?.updatedAt || null;
    const toTotals = (r) => ({
      revenue: round2(r.revenue),
      orders: r.orderCount || 0,
      avgOrderValue: r.orderCount ? round2(r.revenue / r.orderCount) : 0,
      contactCheckoutOrders: r.contactCheckoutOrderCount || 0,
      contactCheckoutRevenue: round2(r.contactCheckoutRevenue),
    });
    const lastOrderDate = lifetime.lastOrderDate || null;
    const days = daysSince(lastOrderDate, now().getTime());

    return {
      data: {
        id: c.id,
        numericId: numericId(c.id),
        name: c.name,
        externalId: c.externalId || null,
        createdAt: c.createdAt || null,
        updatedAt: c.updatedAt || null,
        customerSince: c.customerSince || null,
        assignedRep: repData(assigned, staffById),
        sampleBox: sampleBoxData(parseJson(c.sampleBox?.value)),
        contacts: (c.contacts?.edges || []).map(({ node }) => ({
          id: node.id,
          customerId: node.customer?.id || null,
          name: node.customer?.displayName
            || [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(' ')
            || null,
          title: node.title || null,
          email: node.customer?.defaultEmailAddress?.emailAddress || null,
          phone: node.customer?.defaultPhoneNumber?.phoneNumber || null,
          isMainContact: Boolean(node.isMainContact),
        })),
        locations: (c.locations?.edges || []).map(({ node }) => ({
          id: node.id,
          name: node.name || null,
          phone: node.phone || null,
          shippingAddress: addressData(node.shippingAddress),
          billingAddress: addressData(node.billingAddress),
        })),
        lastOrderDate,
        daysSinceLastOrder: days,
        status: orderStatus(days),
        lifetime: toTotals(lifetime),
        range: toTotals(inRange),
        monthly: bucketTrend(inRange.days, 'month'),
        topProducts: (topProducts || []).map((p) => ({
          productId: p.id,
          title: p.title,
          orders: p.orderCount,
          units: p.unitsSold,
          revenue: round2(p.revenue),
        })),
      },
      meta: meta({ range: { start: range.startDate, end: range.endDate }, rollup }),
    };
  }

  function rawRowParams({ start, end, companyId: rawCompanyId, cursor: rawCursor, limit }, cursorLength) {
    const range = parseOptionalRange(start, end);
    if (range.error) throw badRequest(range.error);
    let companyId = null;
    if (rawCompanyId) {
      companyId = normalizeCompanyId(rawCompanyId);
      if (!companyId) throw badRequest('Unknown company_id.');
    }
    const cursor = decodeCursor(rawCursor, cursorLength);
    if (cursor === false) throw badRequest('Invalid cursor.');
    return { range, companyId, cursor, limit: clampPageSize(limit) };
  }

  async function orders(params = {}) {
    const p = rawRowParams(params, 2);
    const shop = await requireShop();
    const [page, rollup] = await Promise.all([
      companyMetrics.listOrders(shop, {
        startIso: p.range.startIso,
        endIso: p.range.endIso,
        companyId: p.companyId,
        cursor: p.cursor,
        limit: p.limit,
      }),
      rollupMeta(shop),
    ]);
    return {
      data: page.rows,
      meta: meta({
        count: page.rows.length,
        nextCursor: encodeCursor(page.nextCursor),
        range: { start: p.range.startDate, end: p.range.endDate },
        rollup,
      }),
    };
  }

  async function orderLines(params = {}) {
    const p = rawRowParams(params, 3);
    const productId = params.productId ? String(params.productId).slice(0, 512) : null;
    const shop = await requireShop();
    const [page, rollup] = await Promise.all([
      companyMetrics.listOrderLines(shop, {
        startIso: p.range.startIso,
        endIso: p.range.endIso,
        companyId: p.companyId,
        productId,
        cursor: p.cursor,
        limit: p.limit,
      }),
      rollupMeta(shop),
    ]);
    return {
      data: page.rows,
      meta: meta({
        count: page.rows.length,
        nextCursor: encodeCursor(page.nextCursor),
        range: { start: p.range.startDate, end: p.range.endDate },
        rollup,
      }),
    };
  }

  async function products({ start, end } = {}) {
    const range = requireRange(start, end);
    const shop = await requireShop();
    const [rows, rollup] = await Promise.all([
      companyMetrics.productsRange(shop, range.startIso, range.endIso),
      rollupMeta(shop),
    ]);
    return {
      data: rows.map((p) => ({
        productId: p.id,
        title: p.title,
        units: p.unitsSold,
        revenue: round2(p.revenue),
        avgUnitPrice: round2(p.avgUnitPrice),
      })),
      meta: meta({ count: rows.length, range: { start: range.startDate, end: range.endDate }, rollup }),
    };
  }

  async function summary({ start, end } = {}) {
    const range = requireRange(start, end);
    const prior = priorYearRange(range);
    const shop = await requireShop();
    const [current, previous, rollup] = await Promise.all([
      companyMetrics.shopRangeTotals(shop, range.startIso, range.endIso),
      companyMetrics.shopRangeTotals(shop, prior.startIso, prior.endIso),
      rollupMeta(shop),
    ]);
    const shape = (t) => ({
      revenue: round2(t.revenue),
      orders: t.orderCount,
      activeCompanies: t.activeCompanies,
      avgOrderValue: t.orderCount ? round2(t.revenue / t.orderCount) : 0,
    });
    return {
      data: {
        current: { start: range.startDate, end: range.endDate, ...shape(current) },
        sameDatesLastYear: { start: prior.startDate, end: prior.endDate, ...shape(previous) },
        revenueChangePercent: percentChange(current.revenue, previous.revenue),
        ordersChangePercent: percentChange(current.orderCount, previous.orderCount),
      },
      meta: meta({ rollup }),
    };
  }

  async function trend({ start, end, period: rawPeriod } = {}) {
    const range = requireRange(start, end);
    const period = rawPeriod || 'month';
    if (!TREND_PERIODS.includes(period)) throw badRequest('period must be day, week or month.');
    const shop = await requireShop();
    const [days, rollup] = await Promise.all([
      companyMetrics.revenueByDay(shop, range.startDate, range.endDate),
      rollupMeta(shop),
    ]);
    return {
      data: bucketTrend(days, period),
      meta: meta({ period, range: { start: range.startDate, end: range.endDate }, rollup }),
    };
  }

  async function staff() {
    const list = await staffStore.list();
    return { data: list.map(staffData), meta: meta({ count: list.length }) };
  }

  async function commissions({ month: rawMonth } = {}) {
    const month = rawMonth ? String(rawMonth) : null;
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('month must be YYYY-MM.');
    const shop = await requireShop();
    const client = await requireClient(shop);
    const report = await getCommissionReport(client, month);
    return {
      data: {
        period: report.period,
        totals: {
          revenue: round2(report.totals.totalRevenue),
          commission: round2(report.totals.totalCommission),
        },
        reps: report.reps.map((r) => ({
          staffId: r.staffId,
          name: r.name,
          email: r.email || null,
          commissionTier: Number(r.commissionTier) || 0,
          revenue: round2(r.totalRevenue),
          commission: round2(r.totalCommission),
          companies: r.companies.map((c) => ({
            companyId: c.companyId,
            companyName: c.companyName,
            assignedAt: c.assignedAt || null,
            revenue: round2(c.revenue),
            commission: round2(c.commission),
          })),
        })),
      },
      meta: meta({
        source: report.source,
        tierNote: 'Uses each rep\'s current commission tier; tier history is not tracked.',
        rollup: report.rollup
          ? { complete: Boolean(report.rollup.ready), status: report.rollup.status || null }
          : null,
      }),
    };
  }

  async function commissionsMonthly({ months: rawMonths } = {}) {
    const count = rawMonths == null || rawMonths === '' ? 12 : parseInt(rawMonths, 10);
    if (!Number.isFinite(count) || count < 1 || count > MAX_MONTHS) {
      throw badRequest(`months must be 1–${MAX_MONTHS}.`);
    }
    const shop = await requireShop();
    if (!companyMetrics.enabled || !(await companyMetrics.isComplete(shop))) {
      throw new ReportingError(
        503,
        'ROLLUP_NOT_READY',
        'Monthly commission history needs the order sync to finish first.',
      );
    }
    const client = await requireClient(shop);
    const [list, staffList] = await Promise.all([getCompanies(client, shop), staffStore.list()]);
    const staffById = new Map(staffList.map((s) => [s.id, s]));
    const jobs = [];
    for (const c of list || []) {
      const assigned = c.assignedStaff;
      const record = assigned?.staffId ? staffById.get(assigned.staffId) : null;
      if (!record) continue;
      jobs.push({
        companyId: c.id,
        staffId: record.id,
        commissionTier: Number(record.commissionTier) || 0,
        sinceIso: assigned.assignedAt || null,
      });
    }
    const months = trailingMonths(count, now());
    const revenueByCompany = await companyMetrics.monthlyRevenueByCompany(
      shop,
      jobs.map((j) => ({ companyId: j.companyId, sinceIso: j.sinceIso })),
      months[0].start,
    );
    const reps = monthlyCommissionGrid(jobs, revenueByCompany, months, staffList);
    const totals = months.map((m, i) => ({
      month: m.month,
      revenue: round2(reps.reduce((sum, r) => sum + r.months[i].revenue, 0)),
      commission: round2(reps.reduce((sum, r) => sum + r.months[i].commission, 0)),
    }));
    return {
      data: { months: months.map((m) => m.month), currentMonthInProgress: true, totals, reps },
      meta: meta({ tierNote: 'Uses each rep\'s current commission tier; tier history is not tracked.' }),
    };
  }

  return {
    meta,
    status,
    companies,
    company,
    orders,
    orderLines,
    products,
    summary,
    trend,
    staff,
    commissions,
    commissionsMonthly,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function createReportingRouter({
  companyMetrics,
  staffStore,
  resolveShop,
  getShopifyClient,
  getCompanies,
  getCommissionReport,
  env = process.env,
  now = () => new Date(),
}) {
  const router = express.Router();
  const service = createReportingService({
    companyMetrics, staffStore, resolveShop, getShopifyClient, getCompanies, getCommissionReport, now,
  });
  const requestLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_MAX_REQUESTS });
  const authFailLimiter = createRateLimiter({ windowMs: AUTH_FAIL_WINDOW_MS, max: AUTH_FAIL_MAX });

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.locals.requestId = crypto.randomUUID();
    res.set('X-Request-Id', res.locals.requestId);
    next();
  });

  // Browsers are refused by default: the key belongs on a server. To call
  // from a browser app anyway, list its origin in REPORTING_API_CORS_ORIGINS.
  router.use(cors({
    origin: (origin, callback) => callback(null, Boolean(origin) && corsOrigins(env).includes(origin)),
    methods: ['GET', 'HEAD'],
    allowedHeaders: ['Authorization'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  }));

  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.set('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'This API is read-only.', code: 'METHOD_NOT_ALLOWED' });
  });

  router.use((req, res, next) => {
    const keys = configuredKeys(env);
    if (!keys.length) {
      return res.status(503).json({ error: 'The reporting API is not configured.', code: 'NOT_CONFIGURED' });
    }
    const ip = req.ip || 'unknown';
    const lockedFor = authFailLimiter.blocked(ip);
    if (lockedFor) {
      res.set('Retry-After', String(lockedFor));
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.', code: 'RATE_LIMITED' });
    }
    if (req.query && Object.keys(req.query).some((k) => /^(key|api_?key|token|access_token)$/i.test(k))) {
      return res.status(400).json({
        error: 'Send the key in the Authorization header (Bearer), not the URL.',
        code: 'KEY_IN_URL',
      });
    }
    if (!keyMatches(bearerToken(req.headers.authorization), keys)) {
      authFailLimiter.take(ip);
      res.set('WWW-Authenticate', 'Bearer realm="reporting"');
      return res.status(401).json({ error: 'Missing or invalid API key.', code: 'UNAUTHORIZED' });
    }
    const wait = requestLimiter.take(ip);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: 'Rate limit exceeded.', code: 'RATE_LIMITED' });
    }
    return next();
  });

  // Run a service call and send its { data, meta } (or its error) as JSON.
  const send = (call) => async (req, res) => {
    try {
      res.json(await call(req));
    } catch (err) {
      if (err instanceof ReportingError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error(`[reporting] ${res.locals.requestId} ${req.method} ${req.path}`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error.', code: 'INTERNAL', requestId: res.locals.requestId });
      }
    }
  };

  // --- Index -------------------------------------------------------------

  router.get('/', (req, res) => {
    res.json({
      data: {
        name: 'Wholesale CRM reporting API',
        version: API_VERSION,
        readOnly: true,
        auth: 'Authorization: Bearer <REPORTING_API_KEY>',
        conventions: {
          dates: 'YYYY-MM-DD, UTC calendar days, inclusive.',
          money: 'USD, net of refunds, rounded to cents.',
          ids: 'Company ids accept the Shopify GID (gid://shopify/Company/123) or the number (123).',
          paging: `Lists with a cursor return meta.nextCursor; pass it back as ?cursor=. limit defaults to ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}.`,
          status: 'Account status from days since last order: active ≤30, at_risk 31–89, dormant 90+, never_ordered.',
        },
        endpoints: [
          { path: '/status', about: 'Data freshness: order sync status, oldest/newest order, company snapshot age.' },
          { path: '/companies', params: 'start, end (default year to date)', about: 'Every company: contact, assigned rep, sample box, lifetime and date-range revenue/orders, last order, status.' },
          { path: '/companies/{id}', params: 'start, end (default year to date)', about: 'One company: all contacts and locations, lifetime and range totals, monthly revenue, top products.' },
          { path: '/orders', params: 'start, end (default all time), company_id, cursor, limit', about: 'Raw wholesale orders, oldest first.' },
          { path: '/order-lines', params: 'start, end (default all time), company_id, product_id, cursor, limit', about: 'Raw order line items, oldest first.' },
          { path: '/products', params: 'start, end (default year to date)', about: 'Units and revenue per product.' },
          { path: '/analytics/summary', params: 'start, end (default year to date)', about: 'Revenue, orders, active companies, average order value, same dates last year.' },
          { path: '/analytics/trend', params: 'start, end (default year to date), period=day|week|month', about: 'Revenue and orders over time.' },
          { path: '/staff', about: 'Sales reps and managers with commission tiers.' },
          { path: '/commissions', params: 'month=YYYY-MM (default last closed month)', about: 'Per rep: companies, revenue and commission for the month (same numbers as the Reports page).' },
          { path: '/commissions/monthly', params: `months (default 12, max ${MAX_MONTHS})`, about: 'Per rep revenue and commission for each trailing month.' },
        ],
        notIncluded: 'Rep-written CRM notes and sample-box notes are not exposed.',
      },
      meta: service.meta(),
    });
  });

  const q = (req) => req.query || {};

  router.get('/status', send(() => service.status()));
  router.get('/companies', send((req) => service.companies({ start: q(req).start, end: q(req).end })));
  router.get('/companies/:companyId', send((req) => service.company({
    id: req.params.companyId, start: q(req).start, end: q(req).end,
  })));
  router.get('/orders', send((req) => service.orders({
    start: q(req).start, end: q(req).end, companyId: q(req).company_id, cursor: q(req).cursor, limit: q(req).limit,
  })));
  router.get('/order-lines', send((req) => service.orderLines({
    start: q(req).start,
    end: q(req).end,
    companyId: q(req).company_id,
    productId: q(req).product_id,
    cursor: q(req).cursor,
    limit: q(req).limit,
  })));
  router.get('/products', send((req) => service.products({ start: q(req).start, end: q(req).end })));
  router.get('/analytics/summary', send((req) => service.summary({ start: q(req).start, end: q(req).end })));
  router.get('/analytics/trend', send((req) => service.trend({
    start: q(req).start, end: q(req).end, period: q(req).period,
  })));
  router.get('/staff', send(() => service.staff()));
  router.get('/commissions', send((req) => service.commissions({ month: q(req).month })));
  router.get('/commissions/monthly', send((req) => service.commissionsMonthly({ months: q(req).months })));

  router.use((req, res) => {
    res.status(404).json({ error: 'Not found. GET / lists the endpoints.', code: 'NOT_FOUND' });
  });

  return router;
}

module.exports = {
  createReportingRouter,
  createReportingService,
  ReportingError,
  // exported for tests
  configuredKeys,
  bearerToken,
  keyMatches,
  corsOrigins,
  clampPageSize,
  encodeCursor,
  decodeCursor,
  parseOptionalRange,
  trailingMonths,
  sampleBoxData,
  staffData,
  repData,
  companyRow,
  monthlyCommissionGrid,
  createRateLimiter,
  MIN_KEY_LENGTH,
};
