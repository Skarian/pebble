import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const createErrorReporter = require('../../../shared/errors/pkjs/error_reporter.js');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    value: (key) => values.get(key),
  };
}

function timers() {
  const pending = [];
  let next = 1;
  return {
    setTimer(callback, delay) {
      const item = {id: next++, callback, delay, cancelled: false};
      pending.push(item);
      return item.id;
    },
    clearTimer(id) {
      const item = pending.find((candidate) => candidate.id === id);
      if (item) item.cancelled = true;
    },
    runNext() {
      while (pending.length) {
        const item = pending.shift();
        if (!item.cancelled) {
          item.callback();
          return item;
        }
      }
      return null;
    },
  };
}

function reporter(overrides = {}) {
  const storage = overrides.storage || memoryStorage();
  const clock = overrides.clock || timers();
  const instance = createErrorReporter({
    source: 'cpap/pkjs@test',
    watchSource: 'cpap/watch@test',
    storage,
    storageKey: 'errors',
    Xhr: overrides.Xhr || function NeverCalled() {
      throw new Error('unexpected upload');
    },
    config: overrides.config || {enabled: true, key: 'diagnostic-secret'},
    now: overrides.now || (() => 1750000000000),
    random: overrides.random || (() => 0.25),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isIdle: overrides.isIdle,
    secrets: overrides.secrets,
    log: overrides.log || (() => {}),
    maxBytes: overrides.maxBytes,
    maxRecords: overrides.maxRecords,
  });
  return {instance, storage, clock};
}

test('disabled reporting and watch import are strict no-ops', () => {
  const touched = () => { throw new Error('disabled reporter touched a dependency'); };
  const errors = createErrorReporter({
    source: 'cpap/pkjs@test',
    storage: {getItem: touched, setItem: touched, removeItem: touched},
    Xhr: touched,
    config: {enabled: false, key: 'key'},
    setTimer: touched,
    secrets: touched,
  });

  assert.equal(errors.report(new Error('ignored'), 'testing'), null);
  assert.deepEqual(errors.status(), {enabled: false, queued: 0, dropped: 0});
  assert.equal(errors.sendNow(), false);
  assert.equal(errors.readyValue(), 0);
  assert.equal(errors.importWatch({
    ERROR_COMMAND: 1, ERROR_GENERATION: 2, ERROR_SEQUENCE: 3,
    ERROR_DATA: 'v1\tFault\tfn\t4\tEIO\tmessage\tfile.c\t8\tworking',
  }), false);
});

test('the durable outbox keeps stable IDs, the newest 50 errors, and at most 64 KiB', () => {
  const storage = memoryStorage();
  const first = reporter({storage});
  const firstId = first.instance.report(new Error('first'), 'starting a refresh');
  for (let index = 0; index < 55; index += 1) {
    const error = new Error(`failure ${index}`);
    error.index = index;
    first.instance.report(error, 'refreshing CPAP');
  }
  assert.equal(first.instance.status().queued, 50);
  assert.equal(first.instance.status().dropped, 6);

  const second = reporter({storage});
  const nextId = second.instance.report(new Error('after restart'), 'refreshing CPAP');
  assert.notEqual(nextId, firstId);
  assert.equal(second.instance.status().queued, 50);

  for (let index = 0; index < 20; index += 1) {
    const error = new Error(`large ${index}`);
    error.detail = 'x'.repeat(9000);
    second.instance.report(error, 'capturing a bounded error');
  }
  assert.ok(Buffer.byteLength(storage.value('errors'), 'utf8') <= 64 * 1024);
  assert.ok(second.instance.status().queued < 50);
  assert.ok(second.instance.status().dropped > 6);
  const beforeReplacement = second.instance.status();
  assert.equal(second.instance.configure({enabled: true, key: 'replacement-key'}), true);
  assert.deepEqual(second.instance.status(), beforeReplacement);
  assert.equal(second.instance.configure({enabled: false}), false);
  assert.equal(storage.value('errors'), undefined);
});

test('source errors retain useful context while secrets, hostile getters, and cycles are safe', () => {
  const {instance, storage} = reporter({
    secrets: () => ['dictated private words', 'person@example.com'],
  });
  const error = new Error('HTTP 503 for person@example.com: upstream overloaded');
  error.stack = 'HttpError: dictated private words\n    at /Users/neil/project/client.js:42:1';
  error.status = 503;
  error.url = 'https://api.example/path?access_token=abc&search=private';
  error.headers = {Authorization: 'Bearer abcdefghijk', 'X-Request-ID': 'safe-request'};
  error.body = JSON.stringify({
    password: 'hunter2', access_token: 'token-value', detail: 'upstream overloaded',
  });
  error.cause = new TypeError('socket closed unexpectedly');
  error.cause.stack = 'TypeError: socket closed unexpectedly\n    at transport.js:9:2';
  error.diagnosticKey = 'diagnostic-secret';
  error.payload = {detail: 'safe payload context', password: 'payload-password'};
  error.dictionary = {STATUS: 503, access_token: 'dictionary-token'};
  error.genericSecrets = {token: 'generic-token', api_key: 'generic-api-key',
    credential: 'generic-credential', secret: 'generic-secret'};
  error.self = error;
  Object.defineProperty(error, 'hostile', {get() { throw new Error('getter ran'); }});

  instance.report(error, 'sending dictated private words to ResMed');
  const serialized = storage.value('errors');
  const record = JSON.parse(serialized).records[0];

  assert.equal(record.error.status, 503);
  assert.equal(record.error.headers['X-Request-ID'], 'safe-request');
  assert.equal(record.error.headers.Authorization, '[REDACTED]');
  assert.match(record.error.message, /upstream overloaded/);
  assert.match(record.error.body, /upstream overloaded/);
  assert.match(record.error.stack, /client\.js:42/);
  assert.equal(record.error.cause.name, 'TypeError');
  assert.match(record.error.cause.stack, /transport\.js:9/);
  assert.match(record.error.stack, /\/Users\/neil\/project/);
  assert.equal(record.error.self, '[circular]');
  assert.equal(record.error.payload.detail, 'safe payload context');
  assert.equal(record.error.payload.password, '[REDACTED]');
  assert.equal(record.error.dictionary.STATUS, 503);
  assert.equal(record.error.dictionary.access_token, '[REDACTED]');
  assert.equal(Object.hasOwn(record.error, '_capture'), false);
  assert.doesNotMatch(serialized,
    /dictated private words|person@example\.com|hunter2|token-value|diagnostic-secret|abcdefghijk|payload-password|dictionary-token|generic-token|generic-api-key|generic-credential|generic-secret/);
});

test('configured secrets redact exact short values and only long substrings', () => {
  const {instance, storage} = reporter({
    config: {enabled: true, key: 'xy'},
    secrets: () => ['four', 'long-private-value'],
  });
  const error = new Error('prefix xy suffix; prefix four suffix; prefix long-private-value suffix');
  error.exactShort = 'xy';
  error.shortContext = 'prefix xy suffix';
  instance.report(error, 'capturing source context');
  const captured = JSON.parse(storage.value('errors')).records[0].error;

  assert.equal(captured.exactShort, '[REDACTED]');
  assert.equal(captured.shortContext, 'prefix xy suffix');
  assert.doesNotMatch(captured.message, /long-private-value/);
  assert.doesNotMatch(captured.message, /four/);
  assert.match(captured.message, /prefix xy suffix/);
});

test('disable surfaces an outbox deletion failure instead of claiming it was cleared', () => {
  const durable = memoryStorage();
  const removalError = new Error('localStorage removal failed');
  const logs = [];
  let removalFails = true;
  const storage = {
    getItem: durable.getItem,
    setItem: durable.setItem,
    removeItem: (key) => {
      if (removalFails) throw removalError;
      durable.removeItem(key);
    },
  };
  const {instance} = reporter({storage, log: (...args) => logs.push(args)});
  instance.report(new Error('queued source error'), 'testing disable');

  assert.throws(() => instance.configure({enabled: false}), removalError);
  assert.deepEqual(instance.status(), {enabled: false, queued: 0, dropped: 0});
  assert.notEqual(durable.value('errors'), undefined);
  assert.equal(logs.at(-1)[0], 'pebble-errors outbox_delete_failed');
  assert.equal(logs.at(-1)[1], removalError);

  assert.throws(() => instance.configure({enabled: true, key: 'new-key'}), removalError);
  assert.equal(instance.status().enabled, false);
  removalFails = false;
  assert.equal(instance.configure({enabled: true, key: 'new-key'}), true);
  assert.deepEqual(instance.status(), {enabled: true, queued: 0, dropped: 0});
  assert.equal(durable.value('errors'), undefined);
});

test('dropped errors become one stable QueueOverflow record until explicitly ACKed', () => {
  const requests = [];
  class FakeXhr {
    constructor() { this.headers = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; }
  }
  const {instance, clock} = reporter({Xhr: FakeXhr});
  for (let index = 0; index < 56; index += 1) {
    instance.report(new Error(`failure ${index}`), 'refreshing CPAP');
  }
  assert.deepEqual(instance.status(), {enabled: true, queued: 50, dropped: 6});

  clock.runNext();
  const first = JSON.parse(requests[0].body).records;
  const overflow = first.filter((record) => record.error.name === 'QueueOverflow');
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].error.dropped, 6);
  requests[0].status = 200;
  requests[0].responseText = JSON.stringify({accepted: []});
  requests[0].onload();
  assert.equal(instance.status().dropped, 6);

  assert.equal(clock.runNext().delay, 5000);
  const second = JSON.parse(requests[1].body).records;
  assert.deepEqual(second[0], overflow[0]);
  requests[1].status = 200;
  requests[1].responseText = JSON.stringify({accepted: second.map((record) => record.id)});
  requests[1].onload();
  assert.deepEqual(instance.status(), {enabled: true, queued: 31, dropped: 0});
});

test('upload uses the exact HTTPS contract and clears only a complete explicit ACK', () => {
  const requests = [];
  class FakeXhr {
    constructor() { this.headers = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; }
  }
  const {instance, clock} = reporter({Xhr: FakeXhr});
  const id = instance.report(new Error('network failed'), 'refreshing CPAP');
  clock.runNext();

  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, 'https://pebble.exe.xyz/v1/errors');
  assert.equal(requests[0].headers['X-Pebble-Diagnostics-Key'], 'diagnostic-secret');
  assert.equal(Object.hasOwn(requests[0].headers, 'Authorization'), false);
  const posted = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(posted), ['records']);
  assert.match(posted.records[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  requests[0].status = 200;
  requests[0].responseText = JSON.stringify({accepted: []});
  requests[0].onload();
  assert.equal(instance.status().queued, 1);

  const retry = clock.runNext();
  assert.equal(retry.delay, 5000);
  requests[1].status = 200;
  requests[1].responseText = JSON.stringify({accepted: [id]});
  requests[1].onload();
  assert.equal(instance.status().queued, 0);

  const redirectedId = instance.report(new Error('redirected'), 'uploading an error');
  clock.runNext();
  requests[2].status = 200;
  requests[2].responseURL = 'https://other.example/v1/errors';
  requests[2].responseText = JSON.stringify({accepted: [redirectedId]});
  requests[2].onload();
  assert.equal(instance.status().queued, 1);
});

test('rotating the key immediately reopens an exhausted queue without changing identity or order', () => {
  const requests = [];
  class FakeXhr {
    constructor() { this.headers = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; }
  }
  const {instance, clock} = reporter({
    Xhr: FakeXhr, config: {enabled: true, key: 'old-key'},
  });
  const ids = [
    instance.report(new Error('first'), 'refreshing CPAP'),
    instance.report(new Error('second'), 'refreshing CPAP'),
  ];

  [1000, 5000, 30000].forEach((delay, index) => {
    assert.equal(clock.runNext().delay, delay);
    const request = requests[index];
    assert.equal(request.headers['X-Pebble-Diagnostics-Key'], 'old-key');
    assert.deepEqual(JSON.parse(request.body).records.map((record) => record.id), ids);
    request.status = 401;
    request.responseText = JSON.stringify({error: {code: 'unauthorized'}});
    request.onload();
  });
  assert.equal(clock.runNext(), null);

  assert.equal(instance.configure({enabled: true, key: '  replacement-key  '}), true);
  assert.equal(clock.runNext().delay, 0);
  const replacement = requests[3];
  assert.equal(replacement.headers['X-Pebble-Diagnostics-Key'], 'replacement-key');
  assert.deepEqual(JSON.parse(replacement.body).records.map((record) => record.id), ids);
  replacement.status = 200;
  replacement.responseText = JSON.stringify({accepted: ids});
  replacement.onload();
  assert.equal(instance.status().queued, 0);
});

test('network, idle-check, and storage failures retain errors without escaping', () => {
  class BrokenXhr {
    open() {}
    setRequestHeader() {}
    send() { throw new Error('offline'); }
  }
  const offline = reporter({Xhr: BrokenXhr});
  offline.instance.report(new Error('source failure'), 'refreshing CPAP');
  assert.doesNotThrow(() => offline.clock.runNext());
  assert.equal(offline.instance.status().queued, 1);

  const busy = reporter({Xhr: BrokenXhr, isIdle: () => false});
  busy.instance.report(new Error('source failure'), 'refreshing CPAP');
  busy.clock.runNext();
  assert.equal(busy.instance.status().queued, 1);
  assert.equal(busy.clock.runNext().delay, 5000);

  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  };
  const failed = reporter({storage});
  assert.doesNotThrow(() => failed.instance.report(new Error('source'), 'saving'));
  assert.equal(failed.instance.status().queued, 0);
});

test('watch errors require a valid uint32 envelope and import only after durable storage', () => {
  const {instance, storage} = reporter();
  const message = {
    ERROR_COMMAND: 1,
    ERROR_GENERATION: 7,
    ERROR_SEQUENCE: 9,
    ERROR_AT: 1750000000,
    ERROR_DATA: 'v1\tAppMessageError\trequest_scores\t4\tAPP_MSG_BUSY\tSend failed\tmain.c\t88\tsending scores',
    ERROR_DROPPED: 2,
  };
  assert.equal(instance.importWatch(message), true);
  assert.equal(instance.importWatch(message), true);
  const records = JSON.parse(storage.value('errors')).records;
  assert.equal(records.length, 1);
  assert.match(records[0].id, /:watch:7:9$/);
  assert.equal(records[0].source, 'cpap/watch@test');
  assert.equal(records[0].error.message, 'Send failed');
  assert.equal(records[0].error.function, 'request_scores');
  assert.equal(records[0].error.watchDropped, 2);
  const invalidStorage = memoryStorage();
  const invalid = reporter({storage: invalidStorage});
  [
    {...message, ERROR_GENERATION: 0},
    {...message, ERROR_GENERATION: 1.5},
    {...message, ERROR_SEQUENCE: 4294967296},
    {...message, ERROR_AT: -1},
    {...message, ERROR_AT: Infinity},
  ].forEach((payload) => assert.equal(invalid.instance.importWatch(payload), false));
  assert.equal(invalidStorage.value('errors'), undefined);

  const writeError = new Error('quota');
  const writeLogs = [];
  const noWrite = reporter({storage: {
    getItem: () => null,
    setItem: () => { throw writeError; },
    removeItem: () => {},
  }, log: (...args) => writeLogs.push(args)});
  assert.equal(noWrite.instance.importWatch(message), false);
  assert.ok(writeLogs.some((entry) => entry[1] === writeError));

  const ignoredWrite = reporter({storage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }});
  assert.equal(ignoredWrite.instance.importWatch(message), false);
});
