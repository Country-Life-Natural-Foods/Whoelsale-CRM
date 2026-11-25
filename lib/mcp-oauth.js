'use strict';

// Minimal OAuth 2.1 authorization server for the MCP connector (/mcp).
// Full guide: docs/MCP.md.
//
// Why it exists: claude.ai custom connectors sign in with OAuth (dynamic client
// registration + authorization code + PKCE); they can't be handed a static
// API key. This server's only "login" is the existing REPORTING_API_KEY: the
// person connecting pastes it once on the consent page, and Claude gets its
// own short-lived token instead of the key.
//
// Design rules:
//   - Same data and same gate as the Reporting API: whoever holds the
//     reporting key can connect, and a connection sees what the Reporting API
//     sees (read only).
//   - Public clients only (PKCE S256, no client secrets). Codes are single use
//     and live 5 minutes; access tokens 1 hour; refresh tokens 30 days and
//     rotate on every use.
//   - Only SHA-256 hashes of codes and tokens are stored (Postgres when a
//     database URL is set, memory otherwise — memory is for tests/local dev).
//   - Every grant remembers a fingerprint of the reporting key that approved
//     it. Removing that key from REPORTING_API_KEY (rotation) kills every
//     connector token it approved.
//   - Redirect URIs must point at Claude (claude.ai / claude.com) or a
//     loopback address (Claude Code), unless more hosts are listed in
//     MCP_OAUTH_REDIRECT_HOSTS. That stops someone registering their own
//     redirect and phishing the key holder through the real consent page.

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { configuredKeys, keyMatches, createRateLimiter } = require('./reporting-api');

const SCOPE = 'crm:read';
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const ACCESS_PREFIX = 'mcp_at_';
const REFRESH_PREFIX = 'mcp_rt_';
const CODE_PREFIX = 'mcp_code_';
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

// Short fingerprint of a reporting key; stored with each grant so rotating
// the key out revokes everything it approved.
function keyFingerprint(key) {
  return sha256(`mcp-grant:${key}`).slice(0, 32);
}

function fingerprintStillValid(fp, env = process.env) {
  return Boolean(fp) && configuredKeys(env).some((k) => keyFingerprint(k) === fp);
}

function pkceS256(verifier) {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64url');
}

// RFC 7636: 43–128 chars from the unreserved set.
function validVerifier(verifier) {
  return typeof verifier === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

function allowedRedirectHosts(env = process.env) {
  const extra = String(env.MCP_OAUTH_REDIRECT_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_REDIRECT_HOSTS, ...extra];
}

function isLoopback(url) {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname.toLowerCase());
}

// Returns null when fine, else a reason string.
function redirectUriProblem(raw, env = process.env) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URI_LENGTH) return 'redirect_uri is missing or too long';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'redirect_uri is not a valid URL';
  }
  if (url.hash) return 'redirect_uri must not contain a fragment';
  if (url.username || url.password) return 'redirect_uri must not contain credentials';
  if (isLoopback(url)) return null;
  if (url.protocol !== 'https:') return 'redirect_uri must use https (or http on a loopback address)';
  const host = url.hostname.toLowerCase();
  const allowed = allowedRedirectHosts(env);
  if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) {
    return `redirect_uri host ${host} is not allowed (set MCP_OAUTH_REDIRECT_HOSTS to add it)`;
  }
  return null;
}

// Exact match, except loopback redirects may use any port (RFC 8252 §7.3;
// Claude Code listens on an ephemeral port).
function redirectMatches(registered, presented) {
  if (registered === presented) return true;
  let a;
  let b;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }
  if (!isLoopback(a) || !isLoopback(b)) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The public origin the app is reached at. MCP_PUBLIC_URL pins it (use when a
// proxy rewrites Host); otherwise it comes from the request (trust proxy is on,
// so Vercel's https and host are honoured).
function publicBaseUrl(req, env = process.env) {
  const pinned = String(env.MCP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (pinned) return /^https?:\/\//i.test(pinned) ? pinned : `https://${pinned}`;
  return `${req.protocol}://${req.get('host')}`;
}

function resourceUrl(base) {
  return `${base}/mcp`;
}

function protectedResourceMetadataUrl(base) {
  return `${base}/.well-known/oauth-protected-resource/mcp`;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

// Grant records: { kind: 'code'|'access'|'refresh', grantId, clientId, scope,
// resource, keyFp, expiresAt: Date, redirectUri?, codeChallenge? }

function createMemoryOAuthStore() {
  const clients = new Map();
  const tokens = new Map();
  return {
    kind: 'memory',
    async saveClient(client) { clients.set(client.clientId, { ...client }); },
    async getClient(clientId) { return clients.get(clientId) || null; },
    async saveToken(hash, record) { tokens.set(hash, { ...record }); },
    async getToken(hash, kind) {
      const r = tokens.get(hash);
      return r && r.kind === kind ? { ...r } : null;
    },
    async consumeToken(hash, kind) {
      const r = tokens.get(hash);
      if (!r || r.kind !== kind) return null;
      tokens.delete(hash);
      return r;
    },
    async revokeGrant(grantId) {
      for (const [h, r] of tokens) if (r.grantId === grantId) tokens.delete(h);
    },
    async prune(now = new Date()) {
      for (const [h, r] of tokens) if (r.expiresAt <= now) tokens.delete(h);
    },
    _tokens: tokens,
  };
}

const CLIENT_TABLE = 'mcp_oauth_clients';
const TOKEN_TABLE = 'mcp_oauth_tokens';

function createPostgresOAuthStore(connectionString, { isProduction = true } = {}) {
  const pool = new Pool({
    connectionString,
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
    max: 1,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 10000,
    query_timeout: 10000,
  });
  pool.on('error', (err) => console.error('[postgres] mcp oauth pool', err));

  let readyPromise = null;
  function ready() {
    if (!readyPromise) {
      readyPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS ${CLIENT_TABLE} (
          client_id TEXT PRIMARY KEY,
          client_name TEXT,
          redirect_uris JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS ${TOKEN_TABLE} (
          token_hash TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          grant_id TEXT NOT NULL,
          client_id TEXT NOT NULL,
          scope TEXT,
          resource TEXT,
          key_fp TEXT NOT NULL,
          redirect_uri TEXT,
          code_challenge TEXT,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS ${TOKEN_TABLE}_grant_idx ON ${TOKEN_TABLE} (grant_id);
        CREATE INDEX IF NOT EXISTS ${TOKEN_TABLE}_expires_idx ON ${TOKEN_TABLE} (expires_at);
      `).catch((err) => {
        readyPromise = null;
        throw err;
      });
    }
    return readyPromise;
  }

  const fromRow = (row) => (row ? {
    kind: row.kind,
    grantId: row.grant_id,
    clientId: row.client_id,
    scope: row.scope,
    resource: row.resource,
    keyFp: row.key_fp,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    expiresAt: new Date(row.expires_at),
  } : null);

  return {
    kind: 'postgres',
    async saveClient(client) {
      await ready();
      await pool.query(
        `INSERT INTO ${CLIENT_TABLE} (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)`,
        [client.clientId, client.clientName || null, JSON.stringify(client.redirectUris)],
      );
    },
    async getClient(clientId) {
      await ready();
      const { rows } = await pool.query(
        `SELECT client_id, client_name, redirect_uris, created_at FROM ${CLIENT_TABLE} WHERE client_id = $1`,
        [clientId],
      );
      if (!rows[0]) return null;
      return {
        clientId: rows[0].client_id,
        clientName: rows[0].client_name,
        redirectUris: rows[0].redirect_uris,
        createdAt: rows[0].created_at,
      };
    },
    async saveToken(hash, r) {
      await ready();
      await pool.query(
        `INSERT INTO ${TOKEN_TABLE}
           (token_hash, kind, grant_id, client_id, scope, resource, key_fp, redirect_uri, code_challenge, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [hash, r.kind, r.grantId, r.clientId, r.scope || null, r.resource || null, r.keyFp,
          r.redirectUri || null, r.codeChallenge || null, r.expiresAt],
      );
    },
    async getToken(hash, kind) {
      await ready();
      const { rows } = await pool.query(
        `SELECT * FROM ${TOKEN_TABLE} WHERE token_hash = $1 AND kind = $2`,
        [hash, kind],
      );
      return fromRow(rows[0]);
    },
    // DELETE … RETURNING makes codes and refresh tokens single use even when
    // two requests race on different serverless instances.
    async consumeToken(hash, kind) {
      await ready();
      const { rows } = await pool.query(
        `DELETE FROM ${TOKEN_TABLE} WHERE token_hash = $1 AND kind = $2 RETURNING *`,
        [hash, kind],
      );
      return fromRow(rows[0]);
    },
    async revokeGrant(grantId) {
      await ready();
      await pool.query(`DELETE FROM ${TOKEN_TABLE} WHERE grant_id = $1`, [grantId]);
    },
    async prune(now = new Date()) {
      await ready();
      await pool.query(`DELETE FROM ${TOKEN_TABLE} WHERE expires_at < $1`, [now]);
    },
  };
}

function resolvePostgresUrl(env = process.env) {
  for (const raw of [env.POSTGRES_URL, env.DATABASE_URL, env.POSTGRES_URL_NON_POOLING, env.DATABASE_URL_UNPOOLED]) {
    const url = String(raw || '').trim();
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return url;
  }
  return '';
}

function configureOAuthStore({ isProduction, env = process.env } = {}) {
  const url = resolvePostgresUrl(env);
  if (url) return createPostgresOAuthStore(url, { isProduction });
  if (isProduction) {
    console.warn('[mcp] No Postgres URL: connector sign-ins are kept in memory and will not survive cold starts.');
  }
  return createMemoryOAuthStore();
}

// ---------------------------------------------------------------------------
// Token issuing / checking
// ---------------------------------------------------------------------------

function createTokenService({ store, env = process.env, now = () => new Date() }) {
  async function issuePair({ grantId, clientId, scope, resource, keyFp }) {
    const accessToken = randomToken(ACCESS_PREFIX);
    const refreshToken = randomToken(REFRESH_PREFIX);
    const t = now().getTime();
    const base = { grantId, clientId, scope, resource, keyFp };
    await store.saveToken(sha256(accessToken), { ...base, kind: 'access', expiresAt: new Date(t + ACCESS_TTL_MS) });
    await store.saveToken(sha256(refreshToken), { ...base, kind: 'refresh', expiresAt: new Date(t + REFRESH_TTL_MS) });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope,
    };
  }

  // Returns the grant for a valid access token bound to `resource`, else null.
  async function verifyAccessToken(token, resource) {
    if (typeof token !== 'string' || !token.startsWith(ACCESS_PREFIX)) return null;
    const record = await store.getToken(sha256(token), 'access');
    if (!record) return null;
    if (record.expiresAt <= now()) return null;
    if (record.resource && resource && record.resource !== resource) return null;
    if (!fingerprintStillValid(record.keyFp, env)) return null;
    return record;
  }

  return { issuePair, verifyAccessToken };
}

// ---------------------------------------------------------------------------
// Consent page
// ---------------------------------------------------------------------------

function consentPage({ params, clientName, redirectHost, error }) {
  const hidden = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect Wholesale CRM</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f7; --card:#fff; --text:#1a1a1a; --muted:#616161; --border:#d4d4d8; --accent:#1a1a1a; --accent-text:#fff; --err:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111113; --card:#1c1c1f; --text:#ededed; --muted:#a1a1aa; --border:#3f3f46; --accent:#ededed; --accent-text:#111; --err:#f97066; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 14px; color:var(--muted); }
  strong { color:var(--text); }
  ul { margin:0 0 18px; padding-left:20px; color:var(--muted); }
  label { display:block; font-weight:600; margin-bottom:6px; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--text); font:inherit; }
  .row { display:flex; gap:10px; margin-top:18px; }
  button { flex:1; padding:10px 14px; border-radius:8px; font:inherit; font-weight:600; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--text); }
  button.primary { background:var(--accent); color:var(--accent-text); border-color:var(--accent); }
  .error { color:var(--err); font-weight:600; }
</style>
</head>
<body>
<main>
  <h1>Connect Wholesale CRM</h1>
  <p><strong>${escapeHtml(clientName || 'An MCP client')}</strong> wants read-only access to the Wholesale CRM. After you approve, you'll be sent to <strong>${escapeHtml(redirectHost)}</strong>.</p>
  <ul>
    <li>Companies, contacts, orders, products and sales numbers</li>
    <li>Sales reps, commission tiers and commission amounts</li>
    <li>Not included: CRM notes. Nothing can be changed.</li>
  </ul>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/oauth/authorize" autocomplete="off">
      ${hidden}
    <label for="key">Reporting API key</label>
    <input id="key" name="reporting_key" type="password" required autofocus spellcheck="false">
    <div class="row">
      <button type="submit" name="decision" value="deny">Cancel</button>
      <button type="submit" name="decision" value="approve" class="primary">Approve</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

function errorPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connection error</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:32px 16px;background:#f6f6f7;color:#1a1a1a}main{max-width:440px;margin:0 auto}@media (prefers-color-scheme: dark){body{background:#111113;color:#ededed}}</style>
</head><body><main><h1>Can't connect</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const AUTHORIZE_PARAMS = [
  'response_type', 'client_id', 'redirect_uri', 'state', 'scope',
  'code_challenge', 'code_challenge_method', 'resource',
];

function createOAuthRouter({ store, tokens, env = process.env, now = () => new Date() }) {
  const router = express.Router();
  const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
  const tokenLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
  const keyFailLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  const enabled = () => configuredKeys(env).length > 0;

  // Discovery and token endpoints are called by browsers in some clients.
  const openCors = cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'] });

  function asMetadata(base) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    };
  }

  function prMetadata(base) {
    return {
      resource: resourceUrl(base),
      authorization_servers: [base],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Wholesale CRM',
    };
  }

  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], openCors, (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(prMetadata(publicBaseUrl(req, env)));
  });

  router.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], openCors, (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(asMetadata(publicBaseUrl(req, env)));
  });

  const oauthError = (res, status, error, description) => {
    res.set('Cache-Control', 'no-store');
    return res.status(status).json({ error, error_description: description });
  };

  // --- Dynamic client registration (RFC 7591) ------------------------------

  router.options('/oauth/register', openCors);
  router.post('/oauth/register', openCors, async (req, res) => {
    if (!enabled()) return oauthError(res, 503, 'temporarily_unavailable', 'The connector is not configured.');
    const wait = registerLimiter.take(req.ip || 'unknown');
    if (wait) {
      res.set('Retry-After', String(wait));
      return oauthError(res, 429, 'slow_down', 'Too many registrations.');
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS) {
      return oauthError(res, 400, 'invalid_redirect_uri', `redirect_uris must list 1–${MAX_REDIRECT_URIS} URIs.`);
    }
    for (const uri of uris) {
      const problem = redirectUriProblem(uri, env);
      if (problem) return oauthError(res, 400, 'invalid_redirect_uri', problem);
    }
    const grantTypes = body.grant_types || ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grantTypes) || grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
      return oauthError(res, 400, 'invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
    }
    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : null;
    const client = { clientId: `mcp_client_${crypto.randomUUID()}`, clientName, redirectUris: uris };
    try {
      await store.saveClient(client);
    } catch (err) {
      console.error('[mcp] client registration failed', err);
      return oauthError(res, 500, 'server_error', 'Registration failed.');
    }
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(now().getTime() / 1000),
      client_name: clientName || undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    });
  });

  // --- Authorization endpoint ------------------------------------------------

  function htmlHeaders(res) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  }

  function redirectWith(res, redirectUri, values) {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(values)) if (v != null) url.searchParams.set(k, v);
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, url.toString());
  }

  // Validates an authorize request. Problems we can't safely redirect (bad
  // client or redirect URI) come back as { page }; the rest as { redirect }.
  async function checkAuthorize(params, base) {
    if (!enabled()) return { page: 'The Wholesale CRM connector is not configured yet (REPORTING_API_KEY is not set).' };
    if (!params.client_id) return { page: 'Missing client_id.' };
    const client = await store.getClient(String(params.client_id));
    if (!client) return { page: 'Unknown client. Remove the connector in Claude and add it again.' };
    const redirectUri = String(params.redirect_uri || '');
    const registered = client.redirectUris || [];
    const matched = redirectUri
      ? registered.find((r) => redirectMatches(r, redirectUri))
      : (registered.length === 1 ? registered[0] : null);
    if (!matched) return { page: 'The redirect address does not match this client.' };
    const target = redirectUri || matched;
    if (redirectUriProblem(target, env)) return { page: 'The redirect address is not allowed.' };
    const fail = (error, description) => ({ redirect: target, error, description });
    if (params.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (!params.code_challenge || params.code_challenge_method !== 'S256') {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(String(params.code_challenge))) {
      return fail('invalid_request', 'Malformed code_challenge.');
    }
    if (params.resource && String(params.resource).replace(/\/$/, '') !== resourceUrl(base)) {
      return fail('invalid_target', 'Unknown resource.');
    }
    return { client, redirectUri: target };
  }

  function pickParams(source) {
    const out = {};
    for (const k of AUTHORIZE_PARAMS) {
      if (source[k] != null && source[k] !== '') out[k] = String(source[k]).slice(0, MAX_URI_LENGTH);
    }
    return out;
  }

  router.get('/oauth/authorize', async (req, res) => {
    htmlHeaders(res);
    const base = publicBaseUrl(req, env);
    const params = pickParams(req.query || {});
    try {
      const check = await checkAuthorize(params, base);
      if (check.page) return res.status(400).type('html').send(errorPage(check.page));
      if (check.redirect) {
        return redirectWith(res, check.redirect, {
          error: check.error, error_description: check.description, state: params.state, iss: base,
        });
      }
      return res.type('html').send(consentPage({
        params,
        clientName: check.client.clientName,
        redirectHost: new URL(check.redirectUri).host,
      }));
    } catch (err) {
      console.error('[mcp] authorize failed', err);
      return res.status(500).type('html').send(errorPage('Something went wrong. Try again.'));
    }
  });

  router.post('/oauth/authorize', async (req, res) => {
    htmlHeaders(res);
    const base = publicBaseUrl(req, env);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const params = pickParams(body);
    try {
      const check = await checkAuthorize(params, base);
      if (check.page) return res.status(400).type('html').send(errorPage(check.page));
      if (check.redirect) {
        return redirectWith(res, check.redirect, {
          error: check.error, error_description: check.description, state: params.state, iss: base,
        });
      }
      if (body.decision !== 'approve') {
        return redirectWith(res, check.redirectUri, {
          error: 'access_denied', error_description: 'The request was cancelled.', state: params.state, iss: base,
        });
      }
      const ip = req.ip || 'unknown';
      const page = (error, status = 401) => res.status(status).type('html').send(consentPage({
        params, clientName: check.client.clientName, redirectHost: new URL(check.redirectUri).host, error,
      }));
      if (keyFailLimiter.blocked(ip)) return page('Too many wrong keys. Wait 15 minutes and try again.', 429);
      const presented = typeof body.reporting_key === 'string' ? body.reporting_key.trim() : '';
      const keys = configuredKeys(env);
      const matchedKey = keys.find((k) => keyMatches(presented, [k]));
      if (!matchedKey) {
        keyFailLimiter.take(ip);
        return page('That key is not right. Use the Reporting API key (shown on the API page in the app).');
      }

      const code = randomToken(CODE_PREFIX);
      await store.saveToken(sha256(code), {
        kind: 'code',
        grantId: crypto.randomUUID(),
        clientId: check.client.clientId,
        scope: SCOPE,
        resource: resourceUrl(base),
        keyFp: keyFingerprint(matchedKey),
        redirectUri: check.redirectUri,
        codeChallenge: params.code_challenge,
        expiresAt: new Date(now().getTime() + CODE_TTL_MS),
      });
      store.prune(now()).catch((err) => console.error('[mcp] prune failed', err));
      console.log(`[mcp] grant approved for client ${check.client.clientId} (${check.client.clientName || 'unnamed'})`);
      return redirectWith(res, check.redirectUri, { code, state: params.state, iss: base });
    } catch (err) {
      console.error('[mcp] authorize failed', err);
      return res.status(500).type('html').send(errorPage('Something went wrong. Try again.'));
    }
  });

  // --- Token endpoint --------------------------------------------------------

  router.options('/oauth/token', openCors);
  router.post('/oauth/token', openCors, async (req, res) => {
    if (!enabled()) return oauthError(res, 503, 'temporarily_unavailable', 'The connector is not configured.');
    const wait = tokenLimiter.take(req.ip || 'unknown');
    if (wait) {
      res.set('Retry-After', String(wait));
      return oauthError(res, 429, 'slow_down', 'Too many token requests.');
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const clientId = String(body.client_id || '');
    try {
      if (body.grant_type === 'authorization_code') {
        if (!body.code || !clientId) return oauthError(res, 400, 'invalid_request', 'code and client_id are required.');
        const record = await store.consumeToken(sha256(body.code), 'code');
        if (!record || record.expiresAt <= now()) return oauthError(res, 400, 'invalid_grant', 'The code is invalid or expired.');
        if (record.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'The code was issued to another client.');
        if (body.redirect_uri && body.redirect_uri !== record.redirectUri) {
          return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match.');
        }
        if (!validVerifier(body.code_verifier) || pkceS256(body.code_verifier) !== record.codeChallenge) {
          return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
        }
        if (body.resource && String(body.resource).replace(/\/$/, '') !== record.resource) {
          return oauthError(res, 400, 'invalid_target', 'Unknown resource.');
        }
        if (!fingerprintStillValid(record.keyFp, env)) return oauthError(res, 400, 'invalid_grant', 'The approving key was rotated.');
        const pair = await tokens.issuePair(record);
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        return res.json(pair);
      }

      if (body.grant_type === 'refresh_token') {
        if (!body.refresh_token) return oauthError(res, 400, 'invalid_request', 'refresh_token is required.');
        const record = await store.consumeToken(sha256(body.refresh_token), 'refresh');
        if (!record || record.expiresAt <= now()) return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or expired.');
        if (clientId && record.clientId !== clientId) {
          await store.revokeGrant(record.grantId);
          return oauthError(res, 400, 'invalid_grant', 'The refresh token was issued to another client.');
        }
        if (!fingerprintStillValid(record.keyFp, env)) {
          await store.revokeGrant(record.grantId);
          return oauthError(res, 400, 'invalid_grant', 'The approving key was rotated. Reconnect.');
        }
        const pair = await tokens.issuePair(record);
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        return res.json(pair);
      }

      return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    } catch (err) {
      console.error('[mcp] token endpoint failed', err);
      return oauthError(res, 500, 'server_error', 'Token request failed.');
    }
  });

  // --- Revocation (RFC 7009): always 200 --------------------------------------

  router.options('/oauth/revoke', openCors);
  router.post('/oauth/revoke', openCors, async (req, res) => {
    const token = String(req.body?.token || '');
    try {
      const hash = sha256(token);
      const record = (await store.getToken(hash, 'access')) || (await store.getToken(hash, 'refresh'));
      if (record) await store.revokeGrant(record.grantId);
    } catch (err) {
      console.error('[mcp] revoke failed', err);
    }
    res.set('Cache-Control', 'no-store');
    return res.status(200).end();
  });

  return router;
}

module.exports = {
  createOAuthRouter,
  createTokenService,
  createMemoryOAuthStore,
  createPostgresOAuthStore,
  configureOAuthStore,
  publicBaseUrl,
  resourceUrl,
  protectedResourceMetadataUrl,
  // exported for tests
  sha256,
  pkceS256,
  keyFingerprint,
  fingerprintStillValid,
  redirectUriProblem,
  redirectMatches,
  escapeHtml,
  SCOPE,
  ACCESS_PREFIX,
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
};
