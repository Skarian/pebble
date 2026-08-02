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
      this.responseText = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      requests.push({method: this.method, url: this.url, headers: this.headers, body});
      const scenario = scenarios.shift();
      assert.ok(scenario, `unexpected request ${this.method} ${this.url}`);
      scenario(this);
    }
    abort() {}
  };
}

function complete(status, body) {
  return (xhr) => {
    xhr.status = status;
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
  const Xhr = fakeXhr([
    complete(401, JSON.stringify({errorCode: 'E0000004', errorSummary: 'do not expose me'}))
  ], requests);
  const client = createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 0,
    retryDelay: () => assert.fail('auth failure must not retry')
  });
  const result = await fetchRecords(client);
  assert.equal(result.error.type, 'auth');
  assert.equal(result.error.message, 'ResMed sign-in failed');
  assert.equal(JSON.stringify(result).includes('do not expose me'), false);
  assert.equal(requests.length, 1);
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
  assert.equal(result.error.replay, 'parse:authorization:missing-or-mismatched-code');
  assert.equal(requests.length, 2);
});

test('service failures carry a durable replay recipe without response contents', async () => {
  const requests = [];
  const Xhr = fakeXhr([
    ...successFlow([]).slice(0, 3),
    complete(503, JSON.stringify({code: 'UPSTREAM_UNAVAILABLE', error: 'private upstream detail'})),
    complete(503, JSON.stringify({code: 'UPSTREAM_UNAVAILABLE', error: 'private upstream detail'}))
  ], requests);
  const client = createClient(Xhr, memoryStorage(), {
    requestTimeoutMs: 0,
    retryDelay: (callback) => callback()
  });
  const result = await fetchRecords(client);
  assert.equal(result.error.step, 'sleep records');
  assert.equal(result.error.status, 503);
  assert.equal(result.error.attempts, 2);
  assert.equal(result.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(result.error.replay, 'http:sleep-records:503');
  assert.equal(result.error.previous.replay, 'http:sleep-records:503');
  assert.match(result.error.shape, /error:string/);
  assert.doesNotMatch(JSON.stringify(result.error), /private upstream detail/);
});

test('invalid sleep payload records its safe structural fingerprint', async () => {
  const requests = [];
  const Xhr = fakeXhr([
    ...successFlow([]).slice(0, 3),
    complete(200, JSON.stringify({data: {getPatientWrapper: {sleepRecords: {items: null}}}}))
  ], requests);
  const result = await fetchRecords(createClient(Xhr, memoryStorage(), {requestTimeoutMs: 0}));
  assert.equal(result.error.replay, 'parse:sleep-records:missing-items');
  assert.match(result.error.shape, /items=object/);
});
