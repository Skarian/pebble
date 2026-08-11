import {createServer} from 'node:http';
import {StoreError} from './store.mjs';
import {
  clearSessionCookie, escapeHtml, newSession, readSession, sameSecret, setSessionCookie,
} from './security.mjs';

const ADMIN_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function send(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function html(response, status, title, content, headers = {}) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:light dark}body{margin:0;background:#eef1f4;color:#17202a;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{box-sizing:border-box;max-width:560px;margin:48px auto;padding:28px;background:#fff;border:1px solid #d7dde3;border-radius:12px;box-shadow:0 8px 24px #25313d18}h1{margin:0 0 8px;color:#173f67}p{line-height:1.45}.muted{color:#596773}.warning{padding:12px;border-left:4px solid #b45418;background:#fff3e8}.secret{box-sizing:border-box;width:100%;padding:12px;font:15px ui-monospace,SFMono-Regular,monospace}label{display:block;font-weight:650;margin:18px 0 6px}input[type=password]{box-sizing:border-box;width:100%;padding:11px;font-size:16px}button{padding:11px 16px;border:0;border-radius:6px;background:#1769aa;color:#fff;font-weight:700;font-size:15px;cursor:pointer}.danger{background:#a8362b}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.meta{padding:12px;background:#f4f6f8;border-radius:7px}code{font-family:ui-monospace,SFMono-Regular,monospace}@media(max-width:620px){main{margin:0;min-height:100vh;border:0;border-radius:0;padding:24px 18px}}@media(prefers-color-scheme:dark){body{background:#111820;color:#ecf1f5}main{background:#19232d;border-color:#33414d;box-shadow:none}h1{color:#8cc8f6}.muted{color:#aab6c0}.warning{background:#3b291b}.meta{background:#25313c}}
  </style></head><body><main>${content}</main></body></html>`;
  response.writeHead(status, {
    ...ADMIN_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, {...ADMIN_HEADERS, location, 'content-length': 0, ...headers});
  response.end();
}

async function body(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    if ((size += chunk.length) > limit) throw new StoreError(413, 'body_too_large', `request body exceeds ${limit / 1024} KiB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

async function json(request) {
  try { return JSON.parse(await body(request, 256 * 1024)); }
  catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(400, 'invalid_json', 'request body must be valid JSON');
  }
}

async function form(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new StoreError(415, 'invalid_form', 'form content type required');
  }
  return Object.fromEntries(new URLSearchParams(await body(request, 8 * 1024)));
}

function options(url) {
  return Object.fromEntries(['since', 'source', 'limit', 'before'].map((key) => [key, url.searchParams.get(key)]));
}

function adminPage(store, session) {
  const active = store.activeDiagnosticsKey();
  const action = active
    ? `<p class="warning"><strong>Recreating the key invalidates the current key immediately.</strong> Errors remain queued in each app until you paste the replacement there.</p><form method="post" action="/diagnostics/key"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><input type="hidden" name="expected" value="${escapeHtml(active.fingerprint)}"><button class="danger">Recreate diagnostic key</button></form>`
    : `<form method="post" action="/diagnostics/key"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><button>Create diagnostic key</button></form>`;
  return `<h1>Pebble Diagnostics</h1><p>One write-only key works in Agents, CPAP, Air Quality, and Hubitat. It cannot read stored errors.</p>${active
    ? `<div class="meta"><strong>Current key</strong><br><code>${escapeHtml(active.fingerprint)}</code><br><span class="muted">Created ${escapeHtml(active.createdAt)}</span></div>`
    : '<p class="meta">No shared diagnostic key exists yet.</p>'}${action}<form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><p><button>Log out</button></p></form>`;
}

export function createDiagnosticsHandler({
  store, logger = console, sessionSecret = '', publicUrl = 'https://pebble.exe.xyz', now = () => Date.now(),
}) {
  const failedLogins = new Map();
  const publicAddress = new URL(publicUrl);
  const origin = publicAddress.origin;

  function forwardedHeader(request, name) {
    const value = request.headers[name];
    return String(Array.isArray(value) ? value.at(-1) : value || '')
      .split(',').at(-1).trim().toLowerCase();
  }

  function session(request) {
    return sessionSecret ? readSession(request.headers.cookie, sessionSecret, store.adminAuthVersion(), now()) : null;
  }

  function requireOrigin(request) {
    if (request.headers.origin === origin) return;
    const supplied = String(request.headers.origin || '').toLowerCase();
    const site = forwardedHeader(request, 'sec-fetch-site');
    const host = forwardedHeader(request, 'x-forwarded-host') || forwardedHeader(request, 'host');
    const protocol = forwardedHeader(request, 'x-forwarded-proto')
      || (request.socket?.encrypted ? 'https' : 'http');
    if ((supplied === '' || supplied === 'null') && site === 'same-origin'
        && host === publicAddress.host.toLowerCase()
        && protocol === publicAddress.protocol.slice(0, -1)) return;
    throw new StoreError(403, 'invalid_origin', 'invalid request origin');
  }

  function loginBucket(request) {
    const forwarded = request.headers['x-forwarded-for'];
    return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || request.socket?.remoteAddress || 'unknown')
      .split(',').at(-1).trim().slice(0, 96);
  }

  function requireSession(request, response) {
    const current = session(request);
    if (!current) redirect(response, '/login');
    return current;
  }

  return async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      const key = request.headers['x-pebble-diagnostics-key'];
      if (request.method === 'GET' && url.pathname === '/healthz') {
        const ok = store.health();
        return send(response, ok ? 200 : 503, {ok});
      }
      if (request.method === 'POST' && url.pathname === '/v1/errors') {
        const credential = store.authorize(Array.isArray(key) ? key[0] : key, 'write');
        const value = await json(request);
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).join() !== 'records') {
          throw new StoreError(400, 'invalid_batch', 'body must contain only records');
        }
        return send(response, 200, {accepted: store.ingest(credential, value.records)});
      }
      if (request.method === 'GET' && ['/v1/errors', '/v1/errors/search', '/v1/status'].includes(url.pathname)) {
        store.authorize(Array.isArray(key) ? key[0] : key, 'read');
        if (url.pathname === '/v1/status') return send(response, 200, store.status());
        const query = options(url);
        return send(response, 200, url.pathname.endsWith('/search')
          ? store.search({...query, q: url.searchParams.get('q')}) : store.list(query));
      }

      if (request.method === 'GET' && url.pathname === '/') return redirect(response, '/diagnostics');
      if (request.method === 'GET' && url.pathname === '/login') {
        if (!sessionSecret || !store.adminConfigured()) {
          return html(response, 503, 'Pebble Diagnostics', '<h1>Pebble Diagnostics</h1><p>Administrator access has not been configured.</p>');
        }
        if (session(request)) return redirect(response, '/diagnostics');
        return html(response, 200, 'Log in', '<h1>Pebble Diagnostics</h1><form method="post" action="/login"><label for="password">Administrator password</label><input id="password" name="password" type="password" autocomplete="current-password" required><p><button>Log in</button></p></form>');
      }
      if (request.method === 'POST' && url.pathname === '/login') {
        requireOrigin(request);
        if (!sessionSecret || !store.adminConfigured()) throw new StoreError(503, 'admin_unavailable', 'administrator access has not been configured');
        for (const [id, entry] of failedLogins) if (entry.until <= now()) failedLogins.delete(id);
        const id = loginBucket(request);
        const entry = failedLogins.get(id) || {count: 0, until: now() + 5 * 60 * 1000};
        if (entry.count >= 10) throw new StoreError(429, 'login_limited', 'too many login attempts; try again later');
        const values = await form(request);
        if (!store.verifyAdminPassword(values.password)) {
          if (!failedLogins.has(id) && failedLogins.size >= 1024) failedLogins.delete(failedLogins.keys().next().value);
          failedLogins.set(id, {...entry, count: entry.count + 1});
          return html(response, 401, 'Login failed', '<h1>Login failed</h1><p>The administrator password was not accepted.</p><p><a href="/login">Try again</a></p>');
        }
        failedLogins.delete(id);
        const created = newSession(sessionSecret, store.adminAuthVersion(), now());
        return redirect(response, '/diagnostics', {'set-cookie': setSessionCookie(created.value)});
      }
      if (request.method === 'GET' && url.pathname === '/diagnostics') {
        const current = requireSession(request, response);
        if (!current) return;
        return html(response, 200, 'Pebble Diagnostics', adminPage(store, current));
      }
      if (request.method === 'POST' && url.pathname === '/diagnostics/key') {
        requireOrigin(request);
        const current = requireSession(request, response);
        if (!current) return;
        const values = await form(request);
        if (!sameSecret(values.csrf, current.csrf)) throw new StoreError(403, 'invalid_csrf', 'invalid form token');
        let created;
        try { created = store.rotateDiagnosticsKey(values.expected || null); }
        catch (error) {
          if (error instanceof StoreError && error.code === 'key_changed') {
            return html(response, 409, 'Diagnostic key changed', '<h1>Diagnostic key changed</h1><p>Another page already created or replaced it. No additional key was created.</p><p><a href="/diagnostics">Reload diagnostics</a></p>');
          }
          throw error;
        }
        return html(response, 200, 'Diagnostic key created', `<h1>Diagnostic key created</h1><p>Copy this key now. It will not be shown again.</p><label for="diagnostic-key">Diagnostic key</label><input id="diagnostic-key" class="secret" readonly value="${escapeHtml(created.token)}"><p class="muted">Paste the same key into Agents, CPAP, Air Quality, and Hubitat.</p><p><a href="/diagnostics">Return to diagnostics</a></p>`);
      }
      if (request.method === 'POST' && url.pathname === '/logout') {
        requireOrigin(request);
        const current = requireSession(request, response);
        if (!current) return;
        const values = await form(request);
        if (!sameSecret(values.csrf, current.csrf)) throw new StoreError(403, 'invalid_csrf', 'invalid form token');
        return redirect(response, '/login', {'set-cookie': clearSessionCookie()});
      }
      return send(response, 404, {error: {code: 'not_found', message: 'not found'}});
    } catch (error) {
      if (error instanceof StoreError) return send(response, error.status, {error: {code: error.code, message: error.message}});
      logger.error('Pebble Diagnostics request failed', error);
      return send(response, 500, {error: {code: 'internal_error', message: 'internal server error'}});
    }
  };
}

export function createDiagnosticsServer(options) {
  return createServer(createDiagnosticsHandler(options));
}
