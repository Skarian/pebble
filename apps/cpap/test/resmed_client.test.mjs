import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const sha256 = require('../src/common/sha256.js');
const createClient = require('../src/common/resmed_client.js');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function fakeXhr(scenarios, requests) {
  return class FakeXhr {
    constructor() {
      this.headers = {};
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.responseHeaders = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    getAllResponseHeaders() { return this.responseHeaders; }
    send(body) {
      requests.push({method: this.method, url: this.url, headers: this.headers, body});
      const scenario = scenarios.shift();
      assert.ok(scenario, `unexpected request ${this.method} ${this.url}`);
      scenario(this);
    }
    abort() {}
  };
}

function complete(status, body, metadata = {}) {
  return (xhr) => {
    xhr.status = status;
    xhr.statusText = metadata.statusText || '';
    xhr.responseHeaders = metadata.headers || '';
    xhr.responseText = typeof body === 'function' ? body(xhr) : body;
    xhr.onload();
    if (xhr.onloadend) xhr.onloadend();
  };
}

function successFlow(records = []) {
  return [
    complete(200, JSON.stringify({status: 'SUCCESS', sessionToken: 'session'})),
    complete(200, (xhr) => {
      const state = new URL(xhr.url).searchParams.get('state');
      return `<script>data.code = 'auth-code'; data.state = '${state}';</script>`;
    }),
    complete(200, JSON.stringify({access_token: 'access', id_token: 'id', expires_in: 3600})),
    complete(200, JSON.stringify({data: {getPatientWrapper: {sleepRecords: {items: records}}}}))
  ];
}

function fetchRecords(client) {
  return new Promise((resolve) => {
    client.fetchSleepRecords({username: 'person@example.com', password: 'secret'},
      (error, records) => resolve({error, records}));
  });
}

test('SHA-256 implementation matches the standard abc vector', () => {
  const hex = sha256('abc').map((value) => value.toString(16).padStart(2, '0')).join('');
  assert.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('direct USA flow uses Okta post-message PKCE and ResMed GraphQL', async () => {
  const requests = [];
  const record = {
    startDate: '2026-08-01T00:00:00Z', sleepScore: 94, totalUsage: 455,
    ahi: 0.7, maskPairCount: 1, leakPercentile: 8.2
  };
  const scenarios = successFlow([record]);
  const Xhr = fakeXhr(scenarios, requests);
  const client = createClient(Xhr, memoryStorage(), {requestTimeoutMs: 0});
  const result = await fetchRecords(client);

  assert.equal(result.error, null);
  assert.deepEqual(result.records, [{
    startDate: '2026-08-01', sleepScore: 94, totalUsage: 455,
    ahi: 0.7, maskPairCount: 1, leakPercentile: 8.2
  }]);
  assert.equal(requests.length, 4);
  assert.match(requests[0].url, /\/api\/v1\/authn$/);
  assert.equal(JSON.parse(requests[0].body).username, 'person@example.com');
  assert.equal(new URL(requests[1].url).searchParams.get('response_mode'), 'okta_post_message');
  assert.equal(new URL(requests[1].url).searchParams.get('code_challenge_method'), 'S256');
  assert.match(requests[2].body, /code=auth-code/);
  assert.match(requests[2].body, /code_verifier=/);
  assert.equal(requests[3].headers.rmdcountry, 'US');
  assert.match(JSON.parse(requests[3].body).query, /patient \{ firstName \}/);
});

test('valid cached token skips repeated credential login', async () => {
  const requests = [];
  const scenarios = successFlow([]);
  const Xhr = fakeXhr(scenarios, requests);
  const storage = memoryStorage();
  const client = createClient(Xhr, storage, {requestTimeoutMs: 0});
  assert.equal((await fetchRecords(client)).error, null);

  scenarios.push(complete(200, JSON.stringify({
    data: {getPatientWrapper: {sleepRecords: {items: []}}}
  })));
  assert.equal((await fetchRecords(client)).error, null);
  assert.equal(requests.length, 5);
  assert.equal(requests[4].url, createClient.CONFIG.graphqlUrl);
});

test('authentication failures are controlled and are not retried', async () => {
  const requests = [];
  const captured = [];
  const Xhr = fakeXhr([
    complete(401, JSON.stringify({errorCode: 'E0000004', errorSummary: 'do not expose me'}))
  ], requests);
  const client = createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 0,
    reportError: (error, whileDoing, secrets) => captured.push({
      name: error.name, body: error.body, stack: error.stack, whileDoing, secrets,
    }),
    retryDelay: () => assert.fail('auth failure must not retry')
  });
  const result = await fetchRecords(client);
  assert.equal(result.error.type, 'auth');
  assert.equal(result.error.message, 'ResMed sign-in failed');
  assert.equal(JSON.stringify(result).includes('do not expose me'), false);
  assert.equal(requests.length, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].name, 'ResMedHttpError');
  assert.match(captured[0].body, /do not expose me/);
  assert.match(captured[0].stack, /ResMedHttpError/);
  assert.ok(captured[0].secrets.includes('secret'));
});

test('one transient network failure retries the whole operation once', async () => {
  const requests = [];
  let delays = 0;
  const scenarios = [
    (xhr) => { xhr.onerror(); if (xhr.onloadend) xhr.onloadend(); },
    ...successFlow([])
  ];
  const Xhr = fakeXhr(scenarios, requests);
  const client = createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 0,
    retryDelay: (callback) => { delays += 1; callback(); }
  });
  const result = await fetchRecords(client);
  assert.equal(result.error, null);
  assert.equal(delays, 1);
  assert.equal(requests.length, 5);
});

test('the fallback watchdog bounds a silent XHR without reporting timer cleanup noise', async () => {
  const requests = [], pending = [], captured = [];
  const Xhr = fakeXhr([() => {}, () => {}], requests);
  const client = createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 12000,
    setTimer(callback) { pending.push(callback); return pending.length; },
    clearTimer() {},
    retryDelay: (callback) => callback(),
    reportError: (error) => captured.push(error),
  });
  const resultPromise = fetchRecords(client);
  assert.equal(pending.length, 1);
  pending.shift()();
  assert.equal(pending.length, 1);
  pending.shift()();
  const result = await resultPromise;

  assert.equal(result.error.event, 'timeout');
  assert.equal(result.error.attempts, 2);
  assert.equal(captured.length, 2);
  assert.ok(captured.every((error) => error.name === 'ResMedTransportError'));
});

test('a fallback watchdog scheduling exception is reported without blocking the request', async () => {
  const requests = [], captured = [];
  const timerError = new Error('native timer scheduling failed');
  let firstTimer = true;
  const client = createClient(fakeXhr(successFlow([]), requests), memoryStorage(), {
    requestTimeoutMs: 12000,
    setTimer() {
      if (firstTimer) { firstTimer = false; throw timerError; }
      return 1;
    },
    clearTimer() {},
    reportError: (error, whileDoing, secrets) => captured.push({error, whileDoing, secrets}),
  });
  const result = await fetchRecords(client);

  assert.equal(result.error, null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].error, timerError);
  assert.equal(captured[0].whileDoing, 'scheduling the ResMed request timer');
  assert.ok(captured[0].secrets.includes('secret'));
});

test('rejected one-time authorization code restarts the full flow once', async () => {
  const requests = [];
  const captured = [];
  let delays = 0;
  const Xhr = fakeXhr([
    ...successFlow([]).slice(0, 2),
    complete(400, JSON.stringify({
      error: 'invalid_grant', error_description: 'private upstream detail'
    }), {statusText: 'Bad Request', headers: 'x-request-id: token-exchange-17'}),
    ...successFlow([])
  ], requests);
  const client = createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 0,
    reportError: (error) => captured.push({
      name: error.name, status: error.status, statusText: error.statusText,
      headers: error.headers, code: error.code, body: error.body,
    }),
    retryDelay: (callback) => { delays += 1; callback(); }
  });
  const result = await fetchRecords(client);
  assert.equal(result.error, null);
  assert.equal(delays, 1);
  assert.equal(requests.length, 7);
  assert.deepEqual(captured, [{
    name: 'ResMedHttpError', status: 400, code: 'invalid_grant',
    statusText: 'Bad Request', headers: 'x-request-id: token-exchange-17',
    body: '{"error":"invalid_grant","error_description":"private upstream detail"}',
  }]);
});

test('OAuth state mismatch is rejected before token exchange', async () => {
  const requests = [];
  const Xhr = fakeXhr([
    complete(200, JSON.stringify({status: 'SUCCESS', sessionToken: 'session'})),
    complete(200, "<script>data.code = 'code'; data.state = 'wrong';</script>")
  ], requests);
  const client = createClient(Xhr, memoryStorage(), {requestTimeoutMs: 0});
  const result = await fetchRecords(client);
  assert.equal(result.error.type, 'auth');
  assert.equal(result.error.message, 'ResMed authorization failed');
  assert.equal(requests.length, 2);
});

test('service failures retain the source error envelope without health data', async () => {
  const requests = [];
  const captured = [];
  const Xhr = fakeXhr([
    ...successFlow([]).slice(0, 3),
    complete(503, JSON.stringify({data: {sleepScore: 92},
      code: 'UPSTREAM_UNAVAILABLE', error: 'private upstream detail'}),
      {statusText: 'Service Unavailable', headers: 'retry-after: 4'}),
    complete(503, JSON.stringify({data: {sleepScore: 92},
      code: 'UPSTREAM_UNAVAILABLE', error: 'private upstream detail'}),
      {statusText: 'Service Unavailable', headers: 'retry-after: 4'})
  ], requests);
  const client = createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 0,
    reportError: (error, whileDoing) => captured.push({
      name: error.name, body: error.body, code: error.code,
      statusText: error.statusText, headers: error.headers, whileDoing,
    }),
    retryDelay: (callback) => callback()
  });
  const result = await fetchRecords(client);
  assert.equal(result.error.step, 'sleep records');
  assert.equal(result.error.status, 503);
  assert.equal(result.error.attempts, 2);
  assert.equal(result.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result.error), /private upstream detail/);
  assert.equal(captured.length, 2);
  assert.ok(captured.every(({name}) => name === 'ResMedHttpError'));
  assert.ok(captured.every(({body}) => body ===
    '{"code":"UPSTREAM_UNAVAILABLE","error":"private upstream detail"}'));
  assert.doesNotMatch(JSON.stringify(captured), /sleepScore|92/);
  assert.ok(captured.every(({code}) => code === 'UPSTREAM_UNAVAILABLE'));
  assert.ok(captured.every(({statusText}) => statusText === 'Service Unavailable'));
  assert.ok(captured.every(({headers}) => headers === 'retry-after: 4'));
});

test('invalid sleep payload removes only the health-bearing data field', async () => {
  const requests = [];
  const captured = [];
  const Xhr = fakeXhr([
    ...successFlow([]).slice(0, 3),
    complete(200, JSON.stringify({data: {getPatientWrapper: {sleepRecords: {items: null}}}}))
  ], requests);
  const result = await fetchRecords(createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 0,
    reportError: (error) => captured.push({name: error.name, body: error.body}),
  }));
  assert.equal(result.error.type, 'service');
  assert.equal(captured[0].name, 'ResMedResponseError');
  assert.equal(captured[0].body, '{}');
});

test('malformed sleep JSON retains source metadata but never ambiguous health bytes', async () => {
  const requests = [];
  const captured = [];
  const privateBody = '{"data":{"sleepScore":92,"ahi":3.2,"totalUsage":456';
  const Xhr = fakeXhr([
    ...successFlow([]).slice(0, 3),
    complete(200, privateBody)
  ], requests);
  const result = await fetchRecords(createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 0,
    reportError: (error, whileDoing) => captured.push({
      name: error.name, message: error.message, status: error.status,
      step: error.step, body: error.body, whileDoing,
    }),
  }));

  assert.equal(result.error.type, 'service');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].name, 'SyntaxError');
  assert.match(captured[0].message, /JSON/);
  assert.equal(captured[0].status, 200);
  assert.equal(captured[0].step, 'sleep records');
  assert.equal(captured[0].whileDoing, 'parsing the ResMed sleep records response');
  assert.match(captured[0].body,
    new RegExp('^\\[unparseable sleep response; bytes=' + privateBody.length + '\\]$'));
  assert.doesNotMatch(JSON.stringify(captured), /sleepScore|totalUsage|92|456/);
});
