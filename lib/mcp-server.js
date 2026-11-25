'use strict';

// Remote MCP server (`/mcp`) so the Wholesale CRM can be added to Claude as a
// custom connector. Full guide: docs/MCP.md.
//
//   - Streamable HTTP, stateless: every POST builds a fresh server + transport
//     and answers with plain JSON, so nothing has to survive between Vercel
//     instances. GET/DELETE (SSE streams, session teardown) return 405.
//   - Read only. Every tool calls the Reporting API service
//     (lib/reporting-api.js createReportingService) in-process, so the numbers
//     match /api/reporting/v1 and the Reports page. Same visibility rules:
//     commissions and contact details yes, CRM notes and PIN data never.
//   - Auth: an OAuth access token from lib/mcp-oauth.js (claude.ai, Desktop,
//     Claude Code with OAuth), or `Authorization: Bearer <REPORTING_API_KEY>`
//     directly (Claude Code / API clients with a static header).
//   - Responses are kept small for an LLM context: lists cap at 100 rows and
//     page with offsets or opaque cursors.

const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  ReportingError,
  configuredKeys,
  bearerToken,
  keyMatches,
  createRateLimiter,
} = require('./reporting-api');
const {
  publicBaseUrl,
  resourceUrl,
  protectedResourceMetadataUrl,
  SCOPE,
  ACCESS_PREFIX,
} = require('./mcp-oauth');

const SERVER_NAME = 'wholesale-crm';
const SERVER_VERSION = '1.0.0';
const COMPANY_PAGE_DEFAULT = 25;
const COMPANY_PAGE_MAX = 100;
const ROW_PAGE_DEFAULT = 50;
const ROW_PAGE_MAX = 200;
const PRODUCT_PAGE_DEFAULT = 25;
const PRODUCT_PAGE_MAX = 100;

const INSTRUCTIONS = [
  'Read-only access to the Country Life wholesale (B2B) CRM: companies, contacts, orders, products, revenue, sales reps and commissions.',
  'Money is USD, net of refunds. Dates are YYYY-MM-DD UTC calendar days, inclusive; date ranges default to year to date.',
  'Account status comes from days since the last order: active ≤30, at_risk 31–89, dormant 90+, never_ordered.',
  'Company ids accept the number (123) or the Shopify GID (gid://shopify/Company/123).',
  'Order data comes from a nightly-backfilled rollup plus live webhooks; crm_status shows how fresh it is.',
  'Commissions use each rep\'s current tier; tier history is not tracked.',
  'Rep-written CRM notes are not available through this connector.',
].join('\n');

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function clampInt(raw, def, max, min = 1) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function digits(value) {
  return String(value || '').replace(/\D+/g, '');
}

// Every word must match the company name, email, phone or rep name.
function companyMatches(row, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [row.name, row.email, row.assignedRep?.name].filter(Boolean).join(' ').toLowerCase();
  const phone = digits(row.phone);
  return words.every((w) => hay.includes(w) || (digits(w).length >= 3 && phone.includes(digits(w))));
}

function repMatches(row, rep) {
  if (!rep) return true;
  const want = String(rep).toLowerCase().trim();
  if (want === 'unassigned' || want === 'none') return !row.assignedRep;
  const r = row.assignedRep;
  if (!r) return false;
  return r.staffId === rep || String(r.name || '').toLowerCase().includes(want)
    || String(r.email || '').toLowerCase() === want;
}

const COMPANY_SORTS = {
  lifetime_revenue: (a, b) => b.lifetime.revenue - a.lifetime.revenue,
  range_revenue: (a, b) => b.range.revenue - a.range.revenue,
  last_order: (a, b) => String(b.lastOrderDate || '').localeCompare(String(a.lastOrderDate || '')),
  days_since_order: (a, b) => (b.daysSinceLastOrder ?? -1) - (a.daysSinceLastOrder ?? -1),
  name: (a, b) => a.name.localeCompare(b.name),
};

function compactCompany(row) {
  return {
    id: row.numericId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    rep: row.assignedRep ? row.assignedRep.name : null,
    status: row.status,
    lastOrderDate: row.lastOrderDate ? String(row.lastOrderDate).slice(0, 10) : null,
    daysSinceLastOrder: row.daysSinceLastOrder,
    lifetimeRevenue: row.lifetime.revenue,
    lifetimeOrders: row.lifetime.orders,
    rangeRevenue: row.range.revenue,
    rangeOrders: row.range.orders,
    sampleBox: row.sampleBox?.status && row.sampleBox.status !== 'none' ? row.sampleBox : undefined,
  };
}

function filterCompanies(rows, { query, status, rep, sampleStatus, sort, limit, offset } = {}) {
  let out = rows.filter((r) => companyMatches(r, query) && repMatches(r, rep));
  if (status) out = out.filter((r) => r.status === status);
  if (sampleStatus) out = out.filter((r) => (r.sampleBox?.status || 'none') === sampleStatus);
  const cmp = COMPANY_SORTS[sort] || COMPANY_SORTS.lifetime_revenue;
  out = [...out].sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
  const size = clampInt(limit, COMPANY_PAGE_DEFAULT, COMPANY_PAGE_MAX);
  const start = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const page = out.slice(start, start + size);
  return {
    total: out.length,
    offset: start,
    nextOffset: start + page.length < out.length ? start + page.length : null,
    companies: page.map(compactCompany),
  };
}

// Find one company by name: exact (case-insensitive) match wins, then a
// single partial match; otherwise return candidates.
function resolveCompanyByName(rows, name) {
  const want = String(name || '').toLowerCase().trim();
  if (!want) return { candidates: [] };
  const exact = rows.filter((r) => r.name.toLowerCase() === want);
  if (exact.length === 1) return { match: exact[0] };
  const partial = rows.filter((r) => companyMatches(r, want));
  if (partial.length === 1) return { match: partial[0] };
  return {
    candidates: (exact.length ? exact : partial)
      .slice(0, 10)
      .map((r) => ({ id: r.numericId, name: r.name, status: r.status, lifetimeRevenue: r.lifetime.revenue })),
  };
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Wrap a handler so expected errors come back as tool errors the model can read.
function guarded(name, handler) {
  return async (args) => {
    try {
      return toolResult(await handler(args || {}));
    } catch (err) {
      if (err instanceof ReportingError) return toolError(`${err.code}: ${err.message}`);
      console.error(`[mcp] tool ${name} failed`, err);
      return toolError('Internal error while reading CRM data. Try again shortly.');
    }
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const dateArg = (what) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(what);
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function registerTools(server, service) {
  const tool = (name, title, description, inputSchema, handler) => {
    server.registerTool(name, {
      title,
      description,
      inputSchema,
      annotations: { title, ...READ_ONLY },
    }, guarded(name, handler));
  };

  tool(
    'crm_status',
    'Data freshness',
    'Shows how current the CRM data is: order sync status, oldest and newest order, order count, and age of the company list.',
    {},
    async () => (await service.status()).data,
  );

  tool(
    'search_companies',
    'Search companies',
    'Lists wholesale companies (accounts) with assigned rep, status, last order, lifetime revenue and revenue for a date range. Filter by text, status, rep or sample box; sort; page with offset.',
    {
      query: z.string().max(200).optional().describe('Words to match in company name, email, phone or rep name.'),
      status: z.enum(['active', 'at_risk', 'dormant', 'never_ordered']).optional(),
      rep: z.string().max(100).optional().describe('Rep name, email or staff id; "unassigned" for companies without a rep.'),
      sample_status: z.enum(['none', 'sent', 'received']).optional(),
      start: dateArg('Range start for rangeRevenue (default Jan 1 this year).'),
      end: dateArg('Range end (default today).'),
      sort: z.enum(Object.keys(COMPANY_SORTS)).optional().describe('Default lifetime_revenue.'),
      limit: z.number().int().min(1).max(COMPANY_PAGE_MAX).optional().describe(`Default ${COMPANY_PAGE_DEFAULT}.`),
      offset: z.number().int().min(0).optional(),
    },
    async (a) => {
      const { data, meta } = await service.companies({ start: a.start, end: a.end });
      return {
        ...filterCompanies(data, {
          query: a.query, status: a.status, rep: a.rep, sampleStatus: a.sample_status,
          sort: a.sort, limit: a.limit, offset: a.offset,
        }),
        range: meta.range,
        orderSyncComplete: meta.rollup?.complete ?? null,
      };
    },
  );

  tool(
    'get_company',
    'Company details',
    'One company in full: contacts (name, title, email, phone), locations and addresses, assigned rep, sample box, lifetime and date-range totals, monthly revenue and top products. Give company_id, or company_name to look it up.',
    {
      company_id: z.string().max(100).optional().describe('Number (123) or gid://shopify/Company/123.'),
      company_name: z.string().max(200).optional(),
      start: dateArg('Range start (default Jan 1 this year).'),
      end: dateArg('Range end (default today).'),
    },
    async (a) => {
      let id = a.company_id;
      if (!id) {
        if (!a.company_name) throw new ReportingError(400, 'BAD_REQUEST', 'Give company_id or company_name.');
        const { data } = await service.companies({});
        const found = resolveCompanyByName(data, a.company_name);
        if (!found.match) {
          return {
            matched: false,
            message: found.candidates.length ? 'Several companies match; call again with company_id.' : 'No company matches that name.',
            candidates: found.candidates,
          };
        }
        id = found.match.id;
      }
      const { data, meta } = await service.company({ id, start: a.start, end: a.end });
      return { ...data, range: { ...data.range, ...meta.range } };
    },
  );

  tool(
    'list_orders',
    'List orders',
    'Raw wholesale orders, oldest first, optionally for one company and/or date range. Pages with next_cursor.',
    {
      company_id: z.string().max(100).optional(),
      start: dateArg('Start date (default: all history).'),
      end: dateArg('End date.'),
      limit: z.number().int().min(1).max(ROW_PAGE_MAX).optional().describe(`Default ${ROW_PAGE_DEFAULT}.`),
      cursor: z.string().max(2000).optional().describe('next_cursor from the previous page.'),
    },
    async (a) => {
      const { data, meta } = await service.orders({
        start: a.start, end: a.end, companyId: a.company_id, cursor: a.cursor,
        limit: clampInt(a.limit, ROW_PAGE_DEFAULT, ROW_PAGE_MAX),
      });
      return { orders: data, count: data.length, next_cursor: meta.nextCursor, range: meta.range };
    },
  );

  tool(
    'list_order_lines',
    'List order lines',
    'Raw order line items (product, quantity, revenue), oldest first, filtered by company, product and/or date range. Pages with next_cursor.',
    {
      company_id: z.string().max(100).optional(),
      product_id: z.string().max(512).optional().describe('productId from top_products.'),
      start: dateArg('Start date (default: all history).'),
      end: dateArg('End date.'),
      limit: z.number().int().min(1).max(ROW_PAGE_MAX).optional().describe(`Default ${ROW_PAGE_DEFAULT}.`),
      cursor: z.string().max(2000).optional(),
    },
    async (a) => {
      const { data, meta } = await service.orderLines({
        start: a.start, end: a.end, companyId: a.company_id, productId: a.product_id, cursor: a.cursor,
        limit: clampInt(a.limit, ROW_PAGE_DEFAULT, ROW_PAGE_MAX),
      });
      return { lines: data, count: data.length, next_cursor: meta.nextCursor, range: meta.range };
    },
  );

  tool(
    'top_products',
    'Top products',
    'Products ranked by wholesale revenue for a date range, with units and average unit price.',
    {
      start: dateArg('Default Jan 1 this year.'),
      end: dateArg('Default today.'),
      limit: z.number().int().min(1).max(PRODUCT_PAGE_MAX).optional().describe(`Default ${PRODUCT_PAGE_DEFAULT}.`),
    },
    async (a) => {
      const { data, meta } = await service.products({ start: a.start, end: a.end });
      const size = clampInt(a.limit, PRODUCT_PAGE_DEFAULT, PRODUCT_PAGE_MAX);
      return {
        products: data.slice(0, size),
        totalProducts: data.length,
        range: meta.range,
        productDataComplete: meta.rollup?.productsComplete ?? null,
      };
    },
  );

  tool(
    'sales_summary',
    'Sales summary',
    'Wholesale revenue, orders, active companies and average order value for a date range, compared with the same dates last year.',
    { start: dateArg('Default Jan 1 this year.'), end: dateArg('Default today.') },
    async (a) => (await service.summary({ start: a.start, end: a.end })).data,
  );

  tool(
    'revenue_trend',
    'Revenue trend',
    'Revenue and order counts bucketed by day, week or month over a date range.',
    {
      start: dateArg('Default Jan 1 this year.'),
      end: dateArg('Default today.'),
      period: z.enum(['day', 'week', 'month']).optional().describe('Default month.'),
    },
    async (a) => {
      const { data, meta } = await service.trend({ start: a.start, end: a.end, period: a.period });
      return { period: meta.period, range: meta.range, points: data };
    },
  );

  tool(
    'list_staff',
    'Sales team',
    'Sales reps and managers with role, email and commission tier (percent).',
    {},
    async () => (await service.staff()).data,
  );

  tool(
    'commission_report',
    'Commission report',
    'Monthly commission payout: per rep, the companies, revenue and commission owed for one calendar month (same numbers as the Reports page). Defaults to last closed month.',
    { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe('YYYY-MM.') },
    async (a) => {
      const { data, meta } = await service.commissions({ month: a.month });
      return { ...data, source: meta.source, note: meta.tierNote };
    },
  );

  tool(
    'monthly_commissions',
    'Commission history',
    'Revenue and commission per rep for each of the last N calendar months (current month in progress).',
    { months: z.number().int().min(1).max(36).optional().describe('Default 12.') },
    async (a) => {
      const { data, meta } = await service.commissionsMonthly({ months: a.months });
      return { ...data, note: meta.tierNote };
    },
  );
}

function createMcpServer(service) {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Wholesale CRM', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  registerTools(server, service);
  return server;
}

// ---------------------------------------------------------------------------
// HTTP endpoint
// ---------------------------------------------------------------------------

function createMcpRouter({ service, tokens, env = process.env }) {
  const router = express.Router();
  const requestLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });
  const keyFailLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

  const rpcError = (res, status, code, message, headers = {}) => {
    res.set({ 'Cache-Control': 'no-store', ...headers });
    return res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  };

  async function authenticate(req, res) {
    const base = publicBaseUrl(req, env);
    const keys = configuredKeys(env);
    if (!keys.length) {
      rpcError(res, 503, -32000, 'The Wholesale CRM connector is not configured (REPORTING_API_KEY is not set).');
      return null;
    }
    const challenge = `Bearer resource_metadata="${protectedResourceMetadataUrl(base)}", scope="${SCOPE}"`;
    const ip = req.ip || 'unknown';
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      rpcError(res, 401, -32001, 'Authentication required.', { 'WWW-Authenticate': challenge });
      return null;
    }
    if (token.startsWith(ACCESS_PREFIX)) {
      const grant = await tokens.verifyAccessToken(token, resourceUrl(base));
      if (!grant) {
        rpcError(res, 401, -32001, 'The access token is invalid or expired.', {
          'WWW-Authenticate': `${challenge}, error="invalid_token"`,
        });
        return null;
      }
      return { kind: 'oauth', id: grant.grantId, clientId: grant.clientId };
    }
    // Anything else must be the reporting key itself. Lock out guessers.
    const lockedFor = keyFailLimiter.blocked(ip);
    if (lockedFor) {
      rpcError(res, 429, -32000, 'Too many failed attempts. Try again later.', { 'Retry-After': String(lockedFor) });
      return null;
    }
    if (!keyMatches(token, keys)) {
      keyFailLimiter.take(ip);
      rpcError(res, 401, -32001, 'Invalid token.', { 'WWW-Authenticate': `${challenge}, error="invalid_token"` });
      return null;
    }
    return { kind: 'api_key', id: `key:${ip}` };
  }

  router.post('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    let caller;
    try {
      caller = await authenticate(req, res);
    } catch (err) {
      console.error('[mcp] auth failed', err);
      return rpcError(res, 500, -32603, 'Internal error.');
    }
    if (!caller) return undefined;
    const wait = requestLimiter.take(caller.id);
    if (wait) return rpcError(res, 429, -32000, 'Rate limit exceeded.', { 'Retry-After': String(wait) });

    const server = createMcpServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const requestId = crypto.randomUUID();
      console.error(`[mcp] ${requestId} request failed`, err);
      if (!res.headersSent) return rpcError(res, 500, -32603, `Internal error (${requestId}).`);
    }
    return undefined;
  });

  // Stateless server: no standalone SSE stream and no sessions to delete.
  router.all('/', (req, res) => {
    res.set('Allow', 'POST');
    return rpcError(res, 405, -32000, 'Method not allowed. This server is stateless; use POST.');
  });

  return router;
}

module.exports = {
  createMcpRouter,
  createMcpServer,
  // exported for tests
  filterCompanies,
  resolveCompanyByName,
  companyMatches,
  compactCompany,
  clampInt,
  INSTRUCTIONS,
};
