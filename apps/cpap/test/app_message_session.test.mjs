import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const createAppMessageSession =
  require('../../../shared/appmessage/pkjs/app_message_session.js');

function timers() {
  const pending = [];
  let nextId = 1;
  return {
    setTimer(callback, delay) {
      const timer = {id: nextId++, callback, delay, cancelled: false};
      pending.push(timer);
      return timer.id;
    },
    clearTimer(id) {
      const timer = pending.find((candidate) => candidate.id === id);
      if (timer) timer.cancelled = true;
    },
    runNext() {
      while (pending.length) {
        const timer = pending.shift();
        if (!timer.cancelled) {
          timer.callback();
          return true;
        }
      }
      return false;
    },
    flush() {
      let count = 0;
      while (this.runNext()) {
        count += 1;
        if (count > 100) throw new Error('timer loop did not settle');
      }
    },
    size() { return pending.filter((timer) => !timer.cancelled).length; },
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function fakePebble(send) {
  const listeners = new Map();
  return {
    sendAppMessage: send,
    addEventListener(name, listener) {
      const registered = listeners.get(name) || [];
      registered.push(listener);
      listeners.set(name, registered);
    },
    emit(name, event = {}) {
      (listeners.get(name) || []).forEach((listener) => listener(event));
    },
    listenerCount(name) { return (listeners.get(name) || []).length; },
  };
}

function session(send, options = {}) {
  const pebble = options.pebble || fakePebble(send);
  const appMessages = createAppMessageSession({
    app: 'cpap', pebble, log: () => {}, ...options,
  });
  appMessages.open();
  return appMessages;
}

test('immediate and asynchronous failures retry the unchanged dictionary', () => {
  const clock = timers();
  const message = {PROTOCOL: 1, REQUEST_ID: 41, STATUS: 0};
  const seen = [];
  let attempt = 0;
  let outcome;
  const appMessages = session((dictionary, ok, fail) => {
    seen.push(dictionary);
    attempt += 1;
    if (attempt === 1) throw new TypeError('private detail');
    if (attempt === 2) fail({code: 'SEND_TIMEOUT', payload: 'secret'});
    else ok();
  }, {setTimer: clock.setTimer, clearTimer: clock.clearTimer});

  appMessages.send(message, {operation: 'fetch', requestId: 41},
    (result) => { outcome = result; });
  clock.flush();

  assert.deepEqual(seen, [message, message, message]);
  assert.deepEqual(outcome, {ok: true, attempts: 3,
    resultClass: 'ack', resultCode: ''});
  const incidents = JSON.parse(appMessages.report()).events;
  assert.equal(incidents.filter((entry) => entry.event === 'delivery_retry').length, 2);
  assert.equal(incidents.some((entry) => entry.event === 'delivery_success'), false);
  assert.ok(incidents.every((entry) => entry.part === 0));
  assert.doesNotMatch(appMessages.report(), /private detail|payload|secret/);
});

test('a failed batch item retries in place and another send cannot interleave', () => {
  const clock = timers();
  const order = [];
  let failed = false;
  let releaseThird;
  const appMessages = session((dictionary, ok, fail) => {
    order.push(dictionary.PART);
    if (dictionary.PART === 2 && !failed) {
      failed = true;
      fail({code: 8});
    } else if (dictionary.PART === 3) {
      releaseThird = ok;
    } else {
      ok();
    }
  }, {setTimer: clock.setTimer, clearTimer: clock.clearTimer});

  appMessages.send([{PART: 1}, {PART: 2}, {PART: 3}],
    {operation: 'batch', requestId: 'first'});
  appMessages.send({PART: 4}, {operation: 'batch', requestId: 'second'});

  clock.runNext();
  assert.deepEqual(order, [1, 2, 2, 3]);
  releaseThird();
  assert.deepEqual(order, [1, 2, 2, 3, 4]);
});

test('a missing callback times out, ignores its late callback, and releases the queue', () => {
  const clock = timers();
  const order = [];
  let lateSuccess;
  let outcome;
  const appMessages = session((message, ok) => {
    order.push(message.PART);
    if (message.PART === 1) {
      if (!lateSuccess) lateSuccess = ok;
      return;
    }
    ok();
  }, {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  appMessages.send({PART: 1}, {operation: 'fetch', requestId: 51},
    (result) => { outcome = result; });
  appMessages.send({PART: 2}, {operation: 'ready', requestId: 52});

  clock.runNext();
  lateSuccess();
  clock.flush();

  assert.deepEqual(order, [1, 1, 1, 2]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.resultClass, 'callback_timeout');
  assert.equal(JSON.parse(appMessages.report()).events
    .filter((entry) => entry.event === 'delivery_retry').length, 2);
});

test('unsupported dictionary values fail without transport and callbacks cannot wedge sends', () => {
  const sent = [];
  let finishFirst;
  let rejected;
  const appMessages = session((message, ok) => {
    sent.push(message.PART);
    if (message.PART === 1) finishFirst = ok;
    else ok();
  });

  assert.equal(appMessages.send({VALUE: true}, {operation: 'invalid'},
    (outcome) => { rejected = outcome; }), false);
  appMessages.send({PART: 1}, {operation: 'fetch'},
    () => { throw new Error('consumer callback failed'); });
  appMessages.send({PART: 2}, {operation: 'ready'});
  finishFirst();

  assert.equal(rejected.resultClass, 'invalid_dictionary');
  assert.deepEqual(sent, [1, 2]);
});

test('READY is repeatable and both announcements use the serialized sender', () => {
  const clock = timers();
  const sent = [];
  const pebble = fakePebble((message, ok) => { sent.push(message); ok(); });
  const appMessages = session(pebble.sendAppMessage, {
    pebble,
    readyMessage: {PROTOCOL: 1, COMMAND: 2},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  assert.equal(appMessages.open(), false);
  assert.equal(pebble.listenerCount('ready'), 1);
  assert.equal(pebble.listenerCount('appmessage'), 1);
  pebble.emit('ready');
  assert.deepEqual(sent, [{PROTOCOL: 1, COMMAND: 2}]);
  assert.equal(clock.size(), 1);
  clock.flush();
  assert.deepEqual(sent, [
    {PROTOCOL: 1, COMMAND: 2},
    {PROTOCOL: 1, COMMAND: 2},
  ]);
});

test('open routes raw AppMessage payloads without owning app commands', () => {
  const pebble = fakePebble((message, ok) => ok());
  const received = [];
  session(pebble.sendAppMessage, {
    pebble,
    onMessage(payload, appMessages) {
      received.push([payload, typeof appMessages.handleRead]);
    },
  });

  pebble.emit('appmessage', {payload: {COMMAND: 7, REQUEST_ID: 22}});

  assert.deepEqual(received, [[{COMMAND: 7, REQUEST_ID: 22}, 'function']]);
});

test('one read coalesces, fans out IDs, rejects conflicts, and replays exact IDs', () => {
  const replies = [];
  let finish;
  let runs = 0;
  const appMessages = session((message, ok) => { replies.push(message); ok(); });
  function run(requestId, done) {
    assert.equal(requestId, 10);
    runs += 1;
    finish = done;
  }
  const scores = {fingerprint: 'scores'};

  assert.equal(appMessages.handleRead(-1, 'fetch', run, scores), false);
  assert.equal(appMessages.handleRead(0, 'fetch', run, scores), false);
  assert.equal(appMessages.handleRead(10, 'fetch', run, scores), true);
  assert.equal(appMessages.handleRead(10, 'fetch', run, scores), true);
  assert.equal(appMessages.handleRead(11, 'fetch', run, scores), true);
  assert.equal(appMessages.handleRead(10, 'fetch', run, {fingerprint: 'other'}), false);
  assert.equal(runs, 1);

  finish({PROTOCOL: 1, STATUS: 4});
  appMessages.handleRead(10, 'fetch', run, scores);

  assert.equal(runs, 1);
  assert.deepEqual(replies, [
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 10},
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 11},
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 10},
  ]);
  const eventNames = JSON.parse(appMessages.report()).events.map((entry) => entry.event);
  assert.ok(eventNames.includes('read_conflict'));
  assert.equal(eventNames.includes('read_coalesced'), false);
  assert.equal(eventNames.includes('read_joined'), false);
  assert.equal(eventNames.includes('response_replayed'), false);
});

test('only bounded fault incidents survive restart and reveal no sensitive values', () => {
  const storage = memoryStorage();
  storage.setItem('pebble.appmessage.cpap.v1', JSON.stringify([
    {operation: 'ready', event: 'lifecycle_ready', finalCategory: ''},
    {operation: 'fetch', requestId: 7, event: 'delivery_failure',
      resultClass: 'callback_failure', finalCategory: 'delivery'},
    {operation: 'fetch', requestId: 7, event: 'delivery_success', finalCategory: 'ok'},
  ]));
  const replies = [];
  const first = session((message, ok) => { replies.push(message); ok(); },
    {storage, now: () => 123});

  for (let index = 0; index < 35; index += 1) {
    first.record({operation: 'probe', event: 'domain_failure', requestId: index + 1,
      status: index, finalCategory: 'probe_failure'});
  }
  first.record({operation: 'probe', event: 'probe_succeeded', finalCategory: 'ok'});
  first.record({operation: 'refresh', event: 'domain_terminal', requestId: 'request-1',
    step: 'sleep records', status: 503, resultCode: 'HTTP_503',
    finalCategory: 'resmed_service', password: 'secret', responseBody: 'private'});
  first.handleRead('request-2', 'fetch', () => {
    throw new Error('token must stay private');
  }, {failureResponse: () => ({PROTOCOL: 1, STATUS: 4})});
  first.handleRead('request-2', 'fetch', () => {}, {});

  const second = session((message, ok) => ok(), {storage, now: () => 456});
  const report = second.report();
  const logged = [];
  second.replayLog((line) => logged.push(line));

  assert.deepEqual(replies, [
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 'request-2'},
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 'request-2'},
  ]);
  assert.equal(JSON.parse(report).events.length, 32);
  assert.match(report, /phone_runtime|request-2/);
  assert.match(logged[0], /^CPAP_APPMESSAGE /);
  assert.doesNotMatch(report, /lifecycle_ready|delivery_success|probe_succeeded/);
  assert.doesNotMatch(report, /secret|private|password|responseBody|token must stay private/);
});
