'use strict';

// Sidekick data endpoints (`/api/sidekick/*`).
//
// The `wholesale-crm-tools` extension (extensions/wholesale-crm-tools) runs in
// Shopify's sandbox and calls these with a session token. Shopify asks for
// answers in under 1 second and under ~4,000 tokens, so:
//   - lists come from the cached company snapshot (Neon) plus one GROUP BY
//     over company_metric_order, never from paging Shopify;
//   - single-company calls make one small Shopify query plus Neon rollups;
//   - every list is capped and every note is trimmed.
// Read-only. Never returned (Isaac, 2026-11-11): commission amounts or tiers,
// and revenue grouped by sales rep. Reps appear only as the assigned rep on an
// account and as a filter on account lists.

const express = require('express');
const { RequestedTokenType } = require('@shopify/shopify-api');
const { shopifyGraphql } = require('./shopify-gql');
const { normalizeCompanyId } = require('./order-attribution');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 25;
const DEFAULT_RESULTS = 10;
const NOTE_BODY_MAX = 400;
const ROLLUP_TTL_MS = 5 * 60 * 1000;
const STATUSES = ['active', 'at_risk', 'dormant', 'never_ordered'];
const FOLLOW_UP_KINDS = ['dormant', 'at_risk', 'sample_follow_up', 'new_partner'];
const DRAFT_ACTIONS = ['add_note', 'sample_sent', 'sample_received', 'assign_to_me'];
const DRAFT_NOTE_MAX = 500;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function numericId(gid) {
  if (!gid) return null;
  const match = String(gid).match(/(\d+)$/);
  return match ? match[1] : null;
}

function companyAdminUri(gid) {
  const id = numericId(gid);
  return id ? `shopify:admin/companies/${id}` : null;
}

// Embedded app link Sidekick resolves against the app's base URL
// (`app://` protocol). `/crm` serves the app home, which reads these params,
// opens the account and pre-fills any draft. Nothing is saved until the
// user clicks Save in the app.
function crmAppUrl(gid, params = {}) {
  const id = numericId(gid);
  if (!id) return null;
  const search = new URLSearchParams({ company: id });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  return `app://crm?${search.toString()}`;
}

function clampLimit(raw, fallback = DEFAULT_RESULTS) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_RESULTS);
}

function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

// Same buckets as the Customers tab badges: green ≤30, amber 31–89, red 90+.
function orderStatus(days) {
  if (days == null) return 'never_ordered';
  if (days <= 30) return 'active';
  if (days <= 89) return 'at_risk';
  return 'dormant';
}

function trimText(text, max = NOTE_BODY_MAX) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function parseJsonValue(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function parseNotes(value) {
  const notes = parseJsonValue(value, []);
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((n) => n && n.body)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function formatNote(note) {
  return {
    date: note.createdAt ? String(note.createdAt).slice(0, 10) : null,
    author: note.author || null,
    body: trimText(note.body),
  };
}

function parseSampleBox(value) {
  const parsed = parseJsonValue(value, null);
  if (!parsed || !['none', 'sent', 'received'].includes(parsed.status)) return { status: 'none' };
  return parsed;
}

function formatSampleBox(box) {
  if (!box || box.status === 'none') return { status: 'none' };
  return {
    status: box.status,
    sentAt: box.sentAt ? String(box.sentAt).slice(0, 10) : null,
    receivedAt: box.receivedAt ? String(box.receivedAt).slice(0, 10) : null,
    sentBy: box.sentBy || null,
    followUpDue: box.followUpDueAt ? String(box.followUpDueAt).slice(0, 10) : null,
    note: box.note ? trimText(box.note, 200) : null,
  };
}

function repName(assignedStaff) {
  return assignedStaff?.name || assignedStaff?.email || null;
}

function matchesRep(assignedStaff, rep) {
  if (!rep) return true;
  const wanted = String(rep).trim().toLowerCase();
  if (wanted === 'unassigned' || wanted === 'none') return !assignedStaff;
  if (!assignedStaff) return false;
  return [assignedStaff.name, assignedStaff.email, assignedStaff.staffId]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(wanted));
}

// Every word of the query must appear somewhere (name, email, phone digits),
// matching how the Customers tab search behaves.
function matchesQuery(company, query) {
  if (!query) return true;
  const haystack = [company.name, company.email, company.assignedStaff?.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const digits = String(company.phone || '').replace(/\D/g, '');
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => {
      if (haystack.includes(word)) return true;
      const wordDigits = word.replace(/\D/g, '');
      return wordDigits.length >= 3 && digits.includes(wordDigits);
    });
}

// Average gap in days between distinct order days (newest 25 order days).
function averageGapDays(orderDays) {
  const days = [...new Set((orderDays || []).filter(Boolean))].sort().slice(-25);
  if (days.length < 2) return null;
  let total = 0;
  for (let i = 1; i < days.length; i += 1) {
    total += (new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / DAY_MS;
  }
  return Math.round(total / (days.length - 1));
}

// One compact row per account for list answers.
function accountRow(company, rollup, now = Date.now()) {
  const lastOrderDate = rollup?.lastOrderDate || null;
  const days = daysSince(lastOrderDate, now);
  return {
    id: company.id,
    name: company.name,
    rep: repName(company.assignedStaff),
    lastOrderDate: lastOrderDate ? lastOrderDate.slice(0, 10) : null,
    daysSinceLastOrder: days,
    status: orderStatus(days),
    lifetimeOrders: rollup?.orderCount || 0,
    adminUrl: companyAdminUri(company.id),
  };
}

function sortByDaysSince(rows, direction = 'desc') {
  const sign = direction === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const da = a.daysSinceLastOrder == null ? Infinity : a.daysSinceLastOrder;
    const db = b.daysSinceLastOrder == null ? Infinity : b.daysSinceLastOrder;
    if (da === db) return String(a.name).localeCompare(String(b.name));
    return sign * (da - db);
  });
}

function followUpRows(companies, rollups, { kind, rep, now = Date.now(), limit = DEFAULT_RESULTS }) {
  const rows = [];
  for (const company of companies) {
    if (!matchesRep(company.assignedStaff, rep)) continue;
    const rollup = rollups.get(company.id);
    const row = accountRow(company, rollup, now);
    if (kind === 'dormant' && row.status !== 'dormant') continue;
    if (kind === 'at_risk' && row.status !== 'at_risk') continue;
    if (kind === 'new_partner' && !(row.lifetimeOrders > 0 && row.lifetimeOrders <= 3)) continue;
    if (kind === 'sample_follow_up') {
      const box = company.sampleBox;
      if (!box || box.status !== 'sent') continue;
      row.sampleBox = formatSampleBox(box);
    }
    rows.push(row);
  }
  if (kind === 'sample_follow_up') {
    rows.sort((a, b) => String(a.sampleBox.followUpDue || '9999').localeCompare(String(b.sampleBox.followUpDue || '9999')));
  } else if (kind === 'new_partner') {
    sortByDaysSince(rows, 'asc');
  } else {
    sortByDaysSince(rows, 'desc');
  }
  return { total: rows.length, accounts: rows.slice(0, limit) };
}

// ---- date ranges for analytics tools (UTC, inclusive) ----
const MAX_TREND_POINTS = 60;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function percentChange(current, previous) {
  if (!previous) return null;
  return parseFloat((((current - previous) / previous) * 100).toFixed(1));
}

function isValidDay(value) {
  if (!ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Default is year to date, the Analytics page default.
function parseRange(startRaw, endRaw, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const startDate = startRaw ? String(startRaw).slice(0, 10) : `${today.slice(0, 4)}-01-01`;
  const endDate = endRaw ? String(endRaw).slice(0, 10) : today;
  if (!isValidDay(startDate) || !isValidDay(endDate)) {
    return { error: 'Dates must be YYYY-MM-DD.' };
  }
  if (startDate > endDate) return { error: 'startDate must be on or before endDate.' };
  return {
    startDate,
    endDate,
    startIso: `${startDate}T00:00:00.000Z`,
    endIso: `${endDate}T23:59:59.999Z`,
  };
}

function shiftYear(day) {
  const [y, m, d] = day.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

function priorYearRange(range) {
  return parseRange(shiftYear(range.startDate), shiftYear(range.endDate));
}

// Monday-start weeks, calendar months.
function bucketKey(day, period) {
  if (period === 'month') return day.slice(0, 7);
  if (period === 'week') {
    const d = new Date(`${day}T00:00:00Z`);
    const offset = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  }
  return day;
}

function bucketTrend(days, period) {
  const map = new Map();
  for (const row of days || []) {
    if (!row?.date) continue;
    const key = bucketKey(row.date, period);
    const entry = map.get(key) || { period: key, revenue: 0, orders: 0 };
    entry.revenue += Number(row.revenue) || 0;
    entry.orders += Number(row.orders) || 0;
    map.set(key, entry);
  }
  return [...map.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((e) => ({ ...e, revenue: round2(e.revenue) }));
}

// Builds the prefilled link for prepare_account_update. Pure, so the rules
// (what each action needs, what gets dropped) are testable without Shopify.
function buildDraft({ company, action, note, followUpDate, staff, assignedStaff }) {
  if (!DRAFT_ACTIONS.includes(action)) {
    return { error: `action must be one of ${DRAFT_ACTIONS.join(', ')}` };
  }
  const text = String(note || '').trim();
  if (text.length > DRAFT_NOTE_MAX) {
    return { error: `note must be ${DRAFT_NOTE_MAX} characters or fewer` };
  }
  if (action === 'add_note' && !text) return { error: 'add_note needs the note text' };
  let followUp = null;
  if (followUpDate) {
    followUp = String(followUpDate).slice(0, 10);
    if (!isValidDay(followUp)) return { error: 'followUpDate must be YYYY-MM-DD' };
  }

  const base = {
    account: { id: company.id, name: company.name },
    action,
    savedYet: false,
  };
  if (!staff) {
    return {
      ...base,
      status: 'staff_required',
      message: 'Only Wholesale CRM staff can save changes. Link your account in the Wholesale CRM app (Link My Account) or ask a manager to add you as staff.',
    };
  }

  if (action === 'assign_to_me') {
    if (assignedStaff?.staffId === staff.id) {
      return { ...base, status: 'already_yours', message: `${company.name} is already assigned to you.` };
    }
    if (assignedStaff?.staffId && staff.role !== 'manager') {
      return {
        ...base,
        status: 'assigned_to_someone_else',
        currentRep: repName(assignedStaff),
        message: `${company.name} is already assigned to ${repName(assignedStaff)}. Ask a manager to reassign it.`,
      };
    }
  }

  const params = { action };
  if (action === 'add_note') params.note = text;
  if (action === 'sample_sent') {
    if (text) params.sampleNote = text;
    if (followUp) params.followUp = followUp;
  }
  const url = crmAppUrl(company.id, params);
  const what = {
    add_note: 'the note filled in',
    sample_sent: 'the sample box ready to mark as sent',
    sample_received: 'the sample box ready to mark as received',
    assign_to_me: 'an "Assign to me" button',
  }[action];
  return {
    ...base,
    status: 'draft_ready',
    draft: {
      ...(text ? { note: text } : {}),
      ...(followUp ? { followUpDate: followUp } : {}),
      ...(action === 'assign_to_me' && assignedStaff ? { replacesRep: repName(assignedStaff) } : {}),
    },
    message: `Nothing is saved yet. Open ${company.name} in Wholesale CRM: it opens with ${what}. Review it and click Save to confirm.`,
    results: [{ url }],
  };
}

// Sidekick shows these as links that open each account in the Wholesale CRM app.
function resourceLinks(rows) {
  return rows
    .map((r) => crmAppUrl(r.id))
    .filter(Boolean)
    .map((url) => ({ url }));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const SINGLE_COMPANY_QUERY = `
  query SidekickCompany($id: ID!) {
    company(id: $id) {
      id
      name
      note
      contacts(first: 10) {
        edges {
          node {
            isMainContact
            title
            customer {
              displayName
              defaultEmailAddress { emailAddress }
              defaultPhoneNumber { phoneNumber }
            }
          }
        }
      }
      locations(first: 1) {
        edges {
          node {
            phone
            shippingAddress { city zoneCode country }
          }
        }
      }
      notes: metafield(namespace: "clnf", key: "crm_notes") { value }
      sampleBox: metafield(namespace: "clnf", key: "sample_box") { value }
      assignedStaff: metafield(namespace: "clnf", key: "assigned_staff") { value updatedAt }
    }
  }
`;

const SEARCH_COMPANIES_QUERY = `
  query SidekickCompanySearch($query: String!, $first: Int!) {
    companies(first: $first, query: $query) {
      edges {
        node {
          id
          name
          assignedStaff: metafield(namespace: "clnf", key: "assigned_staff") { value }
        }
      }
    }
  }
`;

function createSidekickRouter({
  shopify,
  sessionStorage,
  companyMetrics,
  staffStore,
  getCompanyList,
  intelligenceRanges,
}) {
  const router = express.Router();
  const rollupCache = new Map();

  // Session token → offline Admin API session. Uses the stored offline session
  // when there is one (the app is already installed), otherwise performs token
  // exchange so a Shopify-managed install works without the OAuth redirect.
  async function sidekickAuth(req, res, next) {
    const match = req.headers.authorization?.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: 'Missing session token' });
    const sessionToken = match[1];
    let payload;
    try {
      payload = await shopify.session.decodeSessionToken(sessionToken);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid session token' });
    }
    let shop;
    try {
      shop = new URL(payload.dest).hostname;
    } catch {
      return res.status(401).json({ error: 'Invalid session token destination' });
    }
    try {
      let session = await sessionStorage.loadSession(shopify.session.getOfflineId(shop));
      if (!session?.accessToken || (session.expires && session.expires.getTime() < Date.now())) {
        const exchanged = await shopify.auth.tokenExchange({
          shop,
          sessionToken,
          requestedTokenType: RequestedTokenType.OfflineAccessToken,
        });
        session = exchanged.session;
        await sessionStorage.storeSession(session);
      }
      res.locals.sidekick = {
        shop,
        userId: payload.sub || null,
        client: new shopify.clients.Graphql({ session }),
      };
      return next();
    } catch (err) {
      console.error('[sidekick] auth failed', err.message);
      return res.status(401).json({ error: 'Could not authenticate with Shopify' });
    }
  }

  async function lifetimeRollups(shop) {
    if (!companyMetrics.enabled) return new Map();
    const cached = rollupCache.get(shop);
    if (cached && Date.now() - cached.at < ROLLUP_TTL_MS) return cached.map;
    const map = await companyMetrics.companiesRange(shop, null, null);
    rollupCache.set(shop, { at: Date.now(), map });
    return map;
  }

  async function companiesOrWarming(req, res) {
    const { shop, client } = res.locals.sidekick;
    const companies = await getCompanyList(client, shop);
    if (!companies) {
      res.json({
        status: 'warming_up',
        message: 'The Wholesale CRM account list is still loading. Try again in a minute, or open the Wholesale CRM app.',
      });
      return null;
    }
    return companies;
  }

  async function resolveRep(rep, userId) {
    if (!rep || !['me', 'mine', 'my'].includes(String(rep).toLowerCase())) return rep || null;
    if (!userId || !staffStore) return null;
    const staff = await staffStore.findByShopifyUserId(userId);
    return staff ? staff.id : '__no_staff_record__';
  }

  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[sidekick] ${req.method} ${req.originalUrl}`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Wholesale CRM could not answer that right now.' });
    }
  };

  router.use(sidekickAuth);

  // search_accounts
  router.get('/accounts', wrap(async (req, res) => {
    const { shop, client, userId } = res.locals.sidekick;
    const limit = clampLimit(req.query.limit);
    const query = String(req.query.query || '').trim();
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const rep = await resolveRep(req.query.rep, userId);

    const [companies, rollups] = await Promise.all([
      getCompanyList(client, shop),
      lifetimeRollups(shop),
    ]);

    let candidates = companies;
    let source = 'snapshot';
    if (!candidates) {
      // No cached list yet: fall back to Shopify's own company search by name.
      if (!query) {
        return res.json({
          status: 'warming_up',
          message: 'The Wholesale CRM account list is still loading. Search by name, or try again in a minute.',
        });
      }
      const data = await shopifyGraphql(client, SEARCH_COMPANIES_QUERY, { query, first: MAX_RESULTS }, 'sidekick company search');
      candidates = (data?.companies?.edges || []).map(({ node }) => ({
        id: node.id,
        name: node.name,
        assignedStaff: parseJsonValue(node.assignedStaff?.value, null),
      }));
      source = 'shopify_search';
    }

    const now = Date.now();
    const rows = [];
    for (const company of candidates) {
      if (source === 'snapshot' && !matchesQuery(company, query)) continue;
      if (!matchesRep(company.assignedStaff, rep)) continue;
      const row = accountRow(company, rollups.get(company.id), now);
      if (status && row.status !== status) continue;
      rows.push(row);
    }
    if (!query) sortByDaysSince(rows, 'asc');
    res.json({
      total: rows.length,
      showing: Math.min(rows.length, limit),
      accounts: rows.slice(0, limit),
      results: resourceLinks(rows.slice(0, limit)),
    });
  }));

  // accounts_needing_follow_up
  router.get('/follow-ups', wrap(async (req, res) => {
    const { shop, userId } = res.locals.sidekick;
    const kind = FOLLOW_UP_KINDS.includes(req.query.kind) ? req.query.kind : 'dormant';
    const rep = await resolveRep(req.query.rep, userId);
    const companies = await companiesOrWarming(req, res);
    if (!companies) return;
    const rollups = await lifetimeRollups(shop);
    const result = followUpRows(companies, rollups, { kind, rep, limit: clampLimit(req.query.limit) });
    const sampleDataMissing = kind === 'sample_follow_up' && companies.every((c) => c.sampleBox === undefined);
    res.json({
      kind,
      ...result,
      ...(sampleDataMissing
        ? { note: 'Sample-box status is still syncing into the account list. Open the Wholesale CRM app once to refresh it.' }
        : {}),
      results: resourceLinks(result.accounts),
    });
  }));

  // get_account
  router.get('/accounts/:companyId', wrap(async (req, res) => {
    const { shop, client } = res.locals.sidekick;
    const companyId = normalizeCompanyId(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: 'Unknown company id' });

    const [data, rollup] = await Promise.all([
      shopifyGraphql(client, SINGLE_COMPANY_QUERY, { id: companyId }, 'sidekick company'),
      companyMetrics.enabled ? companyMetrics.companyRange(shop, companyId, null, null) : null,
    ]);
    const company = data?.company;
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const notes = parseNotes(company.notes?.value);
    const assignedStaff = parseJsonValue(company.assignedStaff?.value, null);
    const lastOrderDate = rollup?.lastOrderDate || null;
    const days = daysSince(lastOrderDate);
    const location = company.locations?.edges?.[0]?.node;
    const addr = location?.shippingAddress;

    res.json({
      id: company.id,
      name: company.name,
      rep: repName(assignedStaff),
      repAssignedSince: assignedStaff?.assignedAt ? String(assignedStaff.assignedAt).slice(0, 10) : null,
      lastOrderDate: lastOrderDate ? lastOrderDate.slice(0, 10) : null,
      daysSinceLastOrder: days,
      status: orderStatus(days),
      lifetimeOrders: rollup?.orderCount || 0,
      typicalDaysBetweenOrders: averageGapDays((rollup?.days || []).filter((d) => d.orders > 0).map((d) => d.date)),
      location: addr ? [addr.city, addr.zoneCode, addr.country].filter(Boolean).join(', ') : null,
      phone: location?.phone || null,
      contacts: (company.contacts?.edges || []).slice(0, 5).map(({ node }) => ({
        name: node.customer?.displayName || null,
        title: node.title || null,
        email: node.customer?.defaultEmailAddress?.emailAddress || null,
        phone: node.customer?.defaultPhoneNumber?.phoneNumber || null,
        main: Boolean(node.isMainContact),
      })),
      sampleBox: formatSampleBox(parseSampleBox(company.sampleBox?.value)),
      noteCount: notes.length,
      latestNotes: notes.slice(0, 3).map(formatNote),
      adminUrl: companyAdminUri(company.id),
      results: [{ url: crmAppUrl(company.id) }],
    });
  }));

  // get_account_notes
  router.get('/accounts/:companyId/notes', wrap(async (req, res) => {
    const { client } = res.locals.sidekick;
    const companyId = normalizeCompanyId(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: 'Unknown company id' });
    const data = await shopifyGraphql(client, SINGLE_COMPANY_QUERY, { id: companyId }, 'sidekick company notes');
    const company = data?.company;
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const notes = parseNotes(company.notes?.value);
    const limit = clampLimit(req.query.limit, 15);
    res.json({
      id: company.id,
      name: company.name,
      total: notes.length,
      notes: notes.slice(0, limit).map(formatNote),
      adminUrl: companyAdminUri(company.id),
    });
  }));

  // account_buying_intel
  router.get('/accounts/:companyId/buying', wrap(async (req, res) => {
    const { shop } = res.locals.sidekick;
    const companyId = normalizeCompanyId(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: 'Unknown company id' });
    if (!companyMetrics.enabled) {
      return res.json({ status: 'unavailable', message: 'Order analytics are not set up for this store.' });
    }
    const [complete, productsReady] = await Promise.all([
      companyMetrics.isComplete(shop),
      companyMetrics.isProductsReady(shop),
    ]);
    if (!complete || !productsReady) {
      return res.json({ status: 'backfilling', message: 'Order analytics are still backfilling.' });
    }
    const ranges = intelligenceRanges();
    const [current, previous, topProducts] = await Promise.all([
      companyMetrics.companyRange(shop, companyId, ranges.current.startDate, ranges.current.endDate),
      companyMetrics.companyRange(shop, companyId, ranges.previous.startDate, ranges.previous.endDate),
      companyMetrics.companyProductsRange(shop, companyId, ranges.current.startDate, ranges.current.endDate, 8),
    ]);
    res.json({
      status: 'ready',
      currencyCode: 'USD',
      yearToDate: { ...ranges.current, revenue: current.revenue, orders: current.orderCount },
      sameDatesLastYear: { ...ranges.previous, revenue: previous.revenue, orders: previous.orderCount },
      changePercent: previous.revenue > 0
        ? parseFloat((((current.revenue - previous.revenue) / previous.revenue) * 100).toFixed(1))
        : null,
      orderedOutsideWholesaleCheckout: current.contactCheckoutOrderCount || 0,
      topProducts: (topProducts || []).slice(0, 8).map((p) => ({
        title: p.title,
        orders: p.orderCount,
        units: p.unitsSold ?? p.quantitySold,
        revenue: p.revenue,
      })),
      adminUrl: companyAdminUri(companyId),
    });
  }));

  // prepare_account_update — read-only: checks the account and the caller's
  // staff record, then returns a link that opens the app with the change
  // pre-filled. The user saves it in the app (same endpoints and permission
  // checks as typing it by hand).
  router.post('/drafts', wrap(async (req, res) => {
    const { client, userId } = res.locals.sidekick;
    const body = req.body || {};
    const companyId = normalizeCompanyId(body.id);
    if (!companyId) return res.status(400).json({ error: 'Unknown company id' });
    const [data, staff] = await Promise.all([
      shopifyGraphql(client, SINGLE_COMPANY_QUERY, { id: companyId }, 'sidekick draft company'),
      userId && staffStore ? staffStore.findByShopifyUserId(userId) : null,
    ]);
    const company = data?.company;
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const result = buildDraft({
      company,
      action: body.action,
      note: body.note,
      followUpDate: body.followUpDate,
      staff,
      assignedStaff: parseJsonValue(company.assignedStaff?.value, null),
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  }));

  // ---- Analytics page equivalents (rollup only, no rep data) ----

  async function analyticsReady(res) {
    const { shop } = res.locals.sidekick;
    if (!companyMetrics.enabled) {
      res.json({ status: 'unavailable', message: 'Order analytics are not set up for this store.' });
      return false;
    }
    if (!(await companyMetrics.isComplete(shop))) {
      res.json({ status: 'backfilling', message: 'Order analytics are still backfilling.' });
      return false;
    }
    return true;
  }

  function rangeOrError(req, res) {
    const range = parseRange(req.query.startDate, req.query.endDate);
    if (range.error) {
      res.status(400).json({ error: range.error });
      return null;
    }
    return range;
  }

  // wholesale_summary
  router.get('/analytics/summary', wrap(async (req, res) => {
    const { shop } = res.locals.sidekick;
    const range = rangeOrError(req, res);
    if (!range || !(await analyticsReady(res))) return;
    const prior = priorYearRange(range);
    const productsReady = await companyMetrics.isProductsReady(shop);
    const [current, previous, products] = await Promise.all([
      companyMetrics.shopRangeTotals(shop, range.startIso, range.endIso),
      companyMetrics.shopRangeTotals(shop, prior.startIso, prior.endIso),
      productsReady ? companyMetrics.productsRange(shop, range.startDate, range.endDate) : [],
    ]);
    const top = products[0] || null;
    res.json({
      status: 'ready',
      currencyCode: 'USD',
      range: { startDate: range.startDate, endDate: range.endDate },
      revenue: current.revenue,
      orders: current.orderCount,
      averageOrderValue: current.orderCount ? round2(current.revenue / current.orderCount) : 0,
      accountsThatOrdered: current.activeCompanies,
      sameDatesLastYear: {
        startDate: prior.startDate,
        endDate: prior.endDate,
        revenue: previous.revenue,
        orders: previous.orderCount,
        accountsThatOrdered: previous.activeCompanies,
      },
      revenueChangePercent: percentChange(current.revenue, previous.revenue),
      topProduct: top ? { title: top.title, units: top.unitsSold, revenue: top.revenue } : null,
    });
  }));

  // revenue_trend
  router.get('/analytics/trend', wrap(async (req, res) => {
    const { shop } = res.locals.sidekick;
    const range = rangeOrError(req, res);
    if (!range || !(await analyticsReady(res))) return;
    const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'month';
    const days = await companyMetrics.revenueByDay(shop, range.startDate, range.endDate);
    const points = bucketTrend(days, period);
    res.json({
      status: 'ready',
      currencyCode: 'USD',
      range: { startDate: range.startDate, endDate: range.endDate },
      period,
      totalRevenue: round2(points.reduce((sum, p) => sum + p.revenue, 0)),
      totalOrders: points.reduce((sum, p) => sum + p.orders, 0),
      // Keep the newest points if a long daily range would blow the size limit.
      truncated: points.length > MAX_TREND_POINTS,
      points: points.slice(-MAX_TREND_POINTS),
    });
  }));

  // top_accounts
  router.get('/analytics/accounts', wrap(async (req, res) => {
    const { shop, client } = res.locals.sidekick;
    const range = rangeOrError(req, res);
    if (!range || !(await analyticsReady(res))) return;
    const sortBy = req.query.sortBy === 'orders' ? 'orders' : 'revenue';
    const [rangeMap, companies] = await Promise.all([
      companyMetrics.companiesRange(shop, range.startIso, range.endIso),
      getCompanyList(client, shop),
    ]);
    const names = new Map((companies || []).map((c) => [c.id, c.name]));
    const rows = [];
    for (const [id, m] of rangeMap) {
      if (!m.orderCount) continue;
      rows.push({
        id,
        name: names.get(id) || null,
        revenue: m.totalSpend,
        orders: m.orderCount,
        averageOrderValue: m.orderCount ? round2(m.totalSpend / m.orderCount) : 0,
        adminUrl: companyAdminUri(id),
      });
    }
    rows.sort((a, b) => (sortBy === 'orders' ? b.orders - a.orders : b.revenue - a.revenue));
    const limit = clampLimit(req.query.limit);
    const shown = rows.slice(0, limit);
    res.json({
      status: 'ready',
      currencyCode: 'USD',
      range: { startDate: range.startDate, endDate: range.endDate },
      sortBy,
      accountsThatOrdered: rows.length,
      showing: shown.length,
      accounts: shown,
      ...(companies ? {} : { note: 'Account names are still loading; ids are shown.' }),
      results: resourceLinks(shown.filter((r) => r.name)),
    });
  }));

  // top_products
  router.get('/analytics/products', wrap(async (req, res) => {
    const { shop } = res.locals.sidekick;
    const range = rangeOrError(req, res);
    if (!range || !(await analyticsReady(res))) return;
    if (!(await companyMetrics.isProductsReady(shop))) {
      return res.json({ status: 'backfilling', message: 'Product analytics are still backfilling.' });
    }
    const products = await companyMetrics.productsRange(shop, range.startDate, range.endDate);
    const limit = clampLimit(req.query.limit);
    res.json({
      status: 'ready',
      currencyCode: 'USD',
      range: { startDate: range.startDate, endDate: range.endDate },
      productsSold: products.length,
      showing: Math.min(products.length, limit),
      products: products.slice(0, limit).map((p) => ({
        title: p.title,
        units: p.unitsSold,
        revenue: p.revenue,
        averageUnitPrice: p.avgUnitPrice,
      })),
    });
  }));

  return router;
}

module.exports = {
  createSidekickRouter,
  // exported for tests
  numericId,
  companyAdminUri,
  clampLimit,
  daysSince,
  orderStatus,
  trimText,
  parseNotes,
  formatNote,
  parseSampleBox,
  formatSampleBox,
  matchesRep,
  matchesQuery,
  averageGapDays,
  accountRow,
  followUpRows,
  parseRange,
  priorYearRange,
  crmAppUrl,
  buildDraft,
  bucketTrend,
  percentChange,
};
