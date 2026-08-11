import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {createDiagnosticsHandler} from '../http.mjs';
import {DiagnosticsStore} from '../store.mjs';

function record(id, source, message = 'boom', at = '2026-08-10T12:00:00.000Z') {
  return {
    id,
    at,
    source,
    while: 'performing the injected operation',
    error: {name: 'InjectedError', message, code: 17},
  };
}

function legacyWriteKey(store, source) {
  const token = `pdiag_w_legacy_${source}_test_value`;
  const hash = createHash('sha256').update(token).digest('hex');
  store.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?,NULL)')
    .run(hash.slice(0, 16), hash, 'write', source, 'legacy migration fixture', Date.now());
  return token;
}

function fixture(t, {maxBytes, password, sessionSecret, now} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pebble-diagnostics-test-'));
  const store = new DiagnosticsStore(join(directory, 'errors.sqlite3'), {maxBytes});
  if (password) store.setAdminPassword(password);
  const handler = createDiagnosticsHandler({store, sessionSecret, now, logger: {error() {}}});
  t.after(() => {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  });
  return {store, handler};
}

async function request(handler, path, {method = 'GET', key, body, rawBody, headers = {}} = {}) {
  const content = rawBody ?? (body ? JSON.stringify(body) : null);
  const request = Readable.from(content ? [Buffer.from(content)] : []);
  request.method = method;
  request.url = path;
  request.headers = {
    ...(key ? {'x-pebble-diagnostics-key': key} : {}),
    ...(body ? {'content-type': 'application/json'} : {}),
    ...headers,
  };
  let status;
  let responseHeaders = {};
  let responseBody = '';
  const response = {
    writeHead(value, values = {}) { status = value; responseHeaders = values; },
    end(value = '') { responseBody = String(value); },
  };
  await handler(request, response);
  return {status, headers: responseHeaders, text: responseBody};
}

async function api(handler, path, options) {
  const result = await request(handler, path, options);
  return {status: result.status, body: result.text ? JSON.parse(result.text) : null};
}

async function submitForm(handler, path, values, {cookie, origin = 'https://pebble.exe.xyz', headers = {}} = {}) {
  return request(handler, path, {
    method: 'POST', rawBody: new URLSearchParams(values).toString(),
    headers: {'content-type': 'application/x-www-form-urlencoded',
      ...(origin === null ? {} : {origin}), ...(cookie ? {cookie} : {}), ...headers},
  });
}

test('diagnostic-key ingestion is idempotent and queries expose only four fields', async (t) => {
  const {store, handler} = fixture(t);
  const writer = store.rotateDiagnosticsKey();
  const reader = store.issueReadKey({label: 'codex'});

  assert.deepEqual(await api(handler, '/healthz'), {status: 200, body: {ok: true}});
  assert.equal((await api(handler, '/v1/errors', {
    method: 'POST', body: {records: [record('missing-key', 'agents/watch@1')]},
  })).status, 401);

  const records = [
    record('watch-1', 'agents/watch@1.2.0', 'watch failed'),
    record('android-1', 'agents/android@1.2.0', 'phone failed'),
  ];
  const accepted = await api(handler, '/v1/errors', {
    method: 'POST', key: writer.token, body: {records},
  });
  assert.deepEqual(accepted, {status: 200, body: {accepted: ['watch-1', 'android-1']}});

  const duplicate = await api(handler, '/v1/errors', {
    method: 'POST', key: writer.token, body: {records},
  });
  assert.deepEqual(duplicate.body, {accepted: ['watch-1', 'android-1']});

  const conflict = await api(handler, '/v1/errors', {
    method: 'POST', key: writer.token,
    body: {records: [
      record('watch-1', 'agents/watch@1.2.0', 'changed'),
      record('must-not-partially-insert', 'agents/watch@1.2.0'),
    ]},
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'id_conflict');

  const queried = await api(handler, '/v1/errors?source=agents/watch', {key: reader.token});
  assert.equal(queried.status, 200);
  assert.deepEqual(queried.body.records, [{
    at: records[0].at,
    source: records[0].source,
    while: records[0].while,
    error: records[0].error,
  }]);
  assert.deepEqual(Object.keys(queried.body.records[0]), ['at', 'source', 'while', 'error']);
  assert.equal((await api(handler, '/v1/status', {key: reader.token})).body.records, 2);
  assert.equal((await api(handler, '/v1/status', {key: writer.token})).status, 403);
  assert.equal((await api(handler, '/v1/errors', {
    method: 'POST', key: writer.token,
    body: {records: [{...record('offset-time', 'agents/watch@1'), at: '2026-08-10T07:00:00.000-05:00'}]},
  })).status, 400);
});

test('search, source filters, and cursors find raw error content without leaking ids', async (t) => {
  const {store, handler} = fixture(t);
  const writer = store.rotateDiagnosticsKey();
  const reader = store.issueReadKey({label: 'codex'});
  store.ingest(store.authorize(writer.token, 'write'), [
    record('c1', 'cpap/pkjs@1', '400 invalid_grant', '2026-08-09T12:00:00.000Z'),
    record('c2', 'cpap/watch@1', 'delivery timeout', '2026-08-10T12:00:00.000Z'),
    record('a1', 'agents/android@1', 'router unavailable', '2026-08-10T13:00:00.000Z'),
  ]);

  const search = await api(handler, '/v1/errors/search?q=invalid_grant&source=cpap', {key: reader.token});
  assert.equal(search.status, 200);
  assert.equal(search.body.records.length, 1);
  assert.equal(search.body.records[0].error.message, '400 invalid_grant');
  assert.equal(Object.hasOwn(search.body.records[0], 'id'), false);

  const injection = await api(handler, `/v1/errors/search?q=${encodeURIComponent('" OR router OR "')}`, {key: reader.token});
  assert.deepEqual(injection.body.records, []);

  const first = await api(handler, '/v1/errors?limit=1', {key: reader.token});
  assert.equal(first.body.records.length, 1);
  assert.ok(Number.isSafeInteger(first.body.next));
  const second = await api(handler, `/v1/errors?limit=1&before=${first.body.next}`, {key: reader.token});
  assert.equal(second.body.records.length, 1);
  assert.notDeepEqual(first.body.records[0], second.body.records[0]);
  assert.equal((await api(handler, '/v1/errors?since=999999999999999999d', {key: reader.token})).status, 400);
});

test('capacity rejection is visible and leaves the service readable', async (t) => {
  const {store, handler} = fixture(t, {maxBytes: 128 * 1024});
  const writer = store.rotateDiagnosticsKey();
  const reader = store.issueReadKey({label: 'codex'});
  const oversized = record('large', 'agents/android@1', 'x'.repeat(10_000));

  const rejected = await api(handler, '/v1/errors', {
    method: 'POST', key: writer.token, body: {records: [oversized]},
  });
  assert.equal(rejected.status, 507);
  assert.equal(rejected.body.error.code, 'capacity_exceeded');
  store.databaseBytes = () => 0;
  const hardLimit = await api(handler, '/v1/errors', {
    method: 'POST', key: writer.token,
    body: {records: [record('sqlite-full', 'agents/android@1', 'x'.repeat(80_000))]},
  });
  assert.equal(hardLimit.status, 507);
  const status = (await api(handler, '/v1/status', {key: reader.token})).body;
  assert.equal(status.records, 0);
  assert.equal(status.rejectedAtCapacity, 2);
  assert.deepEqual(await api(handler, '/healthz'), {status: 200, body: {ok: true}});
});

test('rotated credentials and full storage still acknowledge a committed record', async (t) => {
  const {store, handler} = fixture(t);
  const first = store.rotateDiagnosticsKey();
  const value = record('stable', 'agents/watch@1');
  assert.equal((await api(handler, '/v1/errors', {
    method: 'POST', key: first.token, body: {records: [value]},
  })).status, 200);

  const rotated = store.rotateDiagnosticsKey(first.fingerprint);
  store.databaseBytes = () => store.maxBytes + 1;
  const duplicate = await api(handler, '/v1/errors', {
    method: 'POST', key: rotated.token, body: {records: [value]},
  });
  assert.deepEqual(duplicate, {status: 200, body: {accepted: ['stable']}});
  assert.equal(store.db.prepare('SELECT count(*) count FROM errors').get().count, 1);
});

test('authenticated ingestion rejects request bodies over 256 KiB', async (t) => {
  const {store, handler} = fixture(t);
  const writer = store.rotateDiagnosticsKey();
  const response = await api(handler, '/v1/errors', {
    method: 'POST', key: writer.token, rawBody: 'x'.repeat(256 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'body_too_large');
});

test('one diagnostic key accepts every app source and rotates atomically', async (t) => {
  const {store, handler} = fixture(t);
  const legacy = legacyWriteKey(store, 'agents');
  const first = store.rotateDiagnosticsKey();
  const values = [
    record('agents', 'agents/android@1'),
    record('cpap', 'cpap/pkjs@1'),
    record('air', 'air-quality/watch@1'),
  ];
  assert.deepEqual((await api(handler, '/v1/errors', {
    method: 'POST', key: first.token, body: {records: values},
  })).body.accepted, ['agents', 'cpap', 'air']);
  assert.equal(store.authorize(first.token, 'write').source_prefix, null);
  assert.equal((await api(handler, '/v1/errors', {
    method: 'POST', key: legacy, body: {records: [record('legacy-agent', 'agents/watch@1')]},
  })).status, 401);
  assert.throws(() => store.rotateDiagnosticsKey('stale'), /diagnostics key changed/);
  assert.doesNotThrow(() => store.authorize(first.token, 'write'));
  const second = store.rotateDiagnosticsKey(first.fingerprint);
  assert.throws(() => store.authorize(first.token, 'write'), /valid diagnostics key required/);
  assert.doesNotThrow(() => store.authorize(second.token, 'write'));
  assert.equal(store.activeDiagnosticsKey().fingerprint, second.fingerprint);
  assert.equal(store.db.prepare(`SELECT count(*) count FROM credentials
    WHERE role='write' AND revoked_at IS NULL`).get().count, 1);
});

test('password-protected page creates and replaces the diagnostic key once', async (t) => {
  let clock = Date.parse('2026-08-10T12:00:00.000Z');
  const password = 'ninechars';
  const {store, handler} = fixture(t, {
    password, sessionSecret: 'test-session-secret-that-is-long-enough', now: () => clock,
  });
  assert.notEqual(store.meta('admin_password_hash'), password);

  const redirected = await request(handler, '/diagnostics');
  assert.equal(redirected.status, 303);
  assert.equal(redirected.headers.location, '/login');
  const loginPage = await request(handler, '/login');
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(loginPage.headers['cache-control'], 'no-store');

  assert.equal((await submitForm(handler, '/login', {password: 'wrong'})).status, 401);
  const loggedIn = await submitForm(handler, '/login', {password});
  assert.equal(loggedIn.status, 303);
  assert.match(loggedIn.headers['set-cookie'], /Secure; HttpOnly; SameSite=Strict/);
  const cookie = loggedIn.headers['set-cookie'].split(';', 1)[0];

  const page = await request(handler, '/diagnostics', {headers: {cookie}});
  assert.equal(page.status, 200);
  assert.match(page.text, /Create diagnostic key/);
  const csrf = page.text.match(/name="csrf" value="([^"]+)"/)[1];
  assert.equal((await submitForm(handler, '/diagnostics/key', {csrf}, {
    cookie, origin: 'https://evil.example',
  })).status, 403);
  assert.equal((await submitForm(handler, '/diagnostics/key', {csrf: 'wrong'}, {cookie})).status, 403);

  const created = await submitForm(handler, '/diagnostics/key', {csrf}, {cookie});
  assert.equal(created.status, 200);
  assert.equal(created.headers['cache-control'], 'no-store');
  const token = created.text.match(/value="(pdiag_d_[^"]+)"/)[1];
  assert.doesNotThrow(() => store.authorize(token, 'write'));
  assert.equal(store.db.prepare('SELECT count(*) count FROM credentials WHERE token_hash=?')
    .get(token)?.count ?? 0, 0);

  const afterCreate = await request(handler, '/diagnostics', {headers: {cookie}});
  assert.doesNotMatch(afterCreate.text, new RegExp(token));
  const expected = afterCreate.text.match(/name="expected" value="([^"]+)"/)[1];
  assert.equal((await submitForm(handler, '/diagnostics/key', {csrf, expected: 'stale'}, {cookie})).status, 409);
  assert.doesNotThrow(() => store.authorize(token, 'write'));
  const replaced = await submitForm(handler, '/diagnostics/key', {csrf, expected}, {cookie});
  const replacement = replaced.text.match(/value="(pdiag_d_[^"]+)"/)[1];
  assert.throws(() => store.authorize(token, 'write'), /valid diagnostics key required/);
  assert.doesNotThrow(() => store.authorize(replacement, 'write'));

  store.setAdminPassword('a different secure password');
  assert.equal((await request(handler, '/diagnostics', {headers: {cookie}})).status, 303);
  const loggedInAgain = await submitForm(handler, '/login', {password: 'a different secure password'});
  const secondCookie = loggedInAgain.headers['set-cookie'].split(';', 1)[0];
  clock += 12 * 60 * 60 * 1000 + 1;
  assert.equal((await request(handler, '/diagnostics', {headers: {cookie: secondCookie}})).status, 303);
});

test('administrator password cannot be claimed over HTTP', async (t) => {
  const {handler} = fixture(t, {sessionSecret: 'test-session-secret-that-is-long-enough'});
  assert.equal((await request(handler, '/login')).status, 503);
  assert.equal((await submitForm(handler, '/login', {password: 'choose-me'})).status, 503);
});

test('same-site proxy form posts tolerate a missing or opaque browser origin', async (t) => {
  const {handler} = fixture(t, {
    password: 'correct horse battery staple',
    sessionSecret: 'test-session-secret-that-is-long-enough',
  });
  const proxyHeaders = {
    'sec-fetch-site': 'same-origin',
    'x-forwarded-host': 'untrusted.example, pebble.exe.xyz',
    'x-forwarded-proto': 'http, https',
  };
  assert.equal((await submitForm(handler, '/login', {
    password: 'correct horse battery staple',
  }, {origin: null, headers: proxyHeaders})).status, 303);
  assert.equal((await submitForm(handler, '/login', {
    password: 'correct horse battery staple',
  }, {origin: 'null', headers: proxyHeaders})).status, 303);
  assert.equal((await submitForm(handler, '/login', {
    password: 'correct horse battery staple',
  }, {origin: null, headers: {...proxyHeaders, 'sec-fetch-site': 'cross-site'}})).status, 403);
  assert.equal((await submitForm(handler, '/login', {
    password: 'correct horse battery staple',
  }, {origin: null, headers: {...proxyHeaders, 'x-forwarded-host': 'evil.example'}})).status, 403);
});

test('login throttling is bounded to the failing client', async (t) => {
  const {handler} = fixture(t, {
    password: 'correct horse battery staple',
    sessionSecret: 'test-session-secret-that-is-long-enough',
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await submitForm(handler, '/login', {password: 'wrong'}, {
      headers: {'x-forwarded-for': `spoof-${attempt}, 192.0.2.1`},
    })).status, 401);
  }
  assert.equal((await submitForm(handler, '/login', {password: 'wrong'}, {
    headers: {'x-forwarded-for': 'another-spoof, 192.0.2.1'},
  })).status, 429);
  assert.equal((await submitForm(handler, '/login', {password: 'correct horse battery staple'}, {
    headers: {'x-forwarded-for': '192.0.2.2'},
  })).status, 303);
});
