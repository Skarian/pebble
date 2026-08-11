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
    nextDelay() {
      return pending.find((timer) => !timer.cancelled)?.delay ?? null;
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
  const errors = [];
  const thrown = new TypeError('private detail');
  const callbackFailure = {code: 'SEND_TIMEOUT', payload: 'secret'};
  const appMessages = session((dictionary, ok, fail) => {
    seen.push(dictionary);
    attempt += 1;
    if (attempt === 1) throw thrown;
    if (attempt === 2) fail(callbackFailure);
    else ok();
  }, {setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    errorReporter: {report: (error, whileDoing) => errors.push({error, whileDoing})}});

  appMessages.send(message, {operation: 'fetch', requestId: 41},
    (result) => { outcome = result; });
  clock.flush();

  assert.deepEqual(seen, [message, message, message]);
  assert.deepEqual(outcome, {ok: true, attempts: 3,
    resultClass: 'ack', resultCode: ''});
  assert.equal(errors.length, 2);
  assert.equal(errors[0].error, thrown);
  assert.equal(errors[1].error, callbackFailure);
  assert.ok(errors.every((entry) =>
    entry.whileDoing === 'sending an AppMessage for fetch'));
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

test('a multipart read stamps and replays every dictionary without rerunning work', () => {
  const seen = [];
  const appMessages = session((dictionary, ok) => { seen.push(dictionary); ok(); });
  let runs = 0;
  function run(_requestId, done) {
    runs += 1;
    done([{PROTOCOL: 1, COMMAND: 3}, {PROTOCOL: 1, COMMAND: 5}]);
  }

  assert.equal(appMessages.handleRead(17, 'devices', run), true);
  assert.equal(appMessages.handleRead(17, 'devices', run), true);

  assert.equal(runs, 1);
  assert.deepEqual(seen, [
    {PROTOCOL: 1, COMMAND: 3, REQUEST_ID: 17},
    {PROTOCOL: 1, COMMAND: 5, REQUEST_ID: 17},
    {PROTOCOL: 1, COMMAND: 3, REQUEST_ID: 17},
    {PROTOCOL: 1, COMMAND: 5, REQUEST_ID: 17},
  ]);
});

test('empty or invalid multipart reads send one valid fallback and never become empty replays', () => {
  const replies = [];
  const errors = [];
  const appMessages = session((dictionary, ok) => { replies.push(dictionary); ok(); }, {
    errorReporter: {report: (error) => errors.push(error)},
  });
  const fallback = {PROTOCOL: 1, STATUS: 4};
  let emptyRuns = 0;

  appMessages.handleRead(21, 'empty', (_requestId, done) => {
    emptyRuns += 1; done([]);
  }, {failureResponse: fallback});
  appMessages.handleRead(21, 'empty', () => { emptyRuns += 1; }, {failureResponse: fallback});
  appMessages.handleRead(22, 'invalid', (_requestId, done) => {
    done([{PROTOCOL: 1}, {VALUE: true}]);
  }, {failureResponse: fallback});

  assert.equal(emptyRuns, 1);
  assert.deepEqual(replies, [
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 21},
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 21},
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 22},
  ]);
  assert.ok(errors.some((error) => error.code === 'empty_read_response'));
  assert.ok(errors.some((error) => error.code === 'invalid_dictionary_value'));
});

test('a missing callback times out, ignores its late callback, and releases the queue', () => {
  const clock = timers();
  const order = [];
  let lateSuccess;
  let outcome;
  const errors = [];
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
    errorReporter: {report: (error) => errors.push(error)},
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
  assert.equal(errors.filter((error) => error.name === 'AppMessageTimeoutError').length, 3);
  assert.ok(errors.every((error) => error.code === 'CALLBACK_TIMEOUT'));
});

test('watch errors import durably before a private idle-only ACK', () => {
  const clock = timers();
  const sent = [];
  const events = [];
  const routed = [];
  let releaseBusiness;
  const pebble = fakePebble((message, ok) => {
    sent.push(message);
    if (message.PART === 1) releaseBusiness = ok;
    else {
      if (message.ERROR_COMMAND === 2) events.push(`ack:${message.ERROR_SEQUENCE}`);
      ok();
    }
  });
  const appMessages = session(pebble.sendAppMessage, {
    pebble,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    errorReporter: {
      report() {},
      importWatch(payload) {
        events.push(`import:${payload.ERROR_SEQUENCE}`);
        return payload.ERROR_SEQUENCE === 9;
      },
    },
    onMessage: (payload) => routed.push(payload),
  });

  appMessages.send({PART: 1}, {operation: 'fetch', requestId: 5});
  pebble.emit('appmessage', {payload: {ERROR_COMMAND: 1, ERROR_SEQUENCE: 9,
    ERROR_GENERATION: 7}});
  assert.deepEqual(sent, [{PART: 1}]);

  releaseBusiness();
  pebble.emit('appmessage', {payload: {ERROR_COMMAND: 1, ERROR_SEQUENCE: 8,
    ERROR_GENERATION: 7}});
  pebble.emit('appmessage', {payload: {ERROR_COMMAND: 1, ERROR_SEQUENCE: 9,
    ERROR_GENERATION: 7}});
  pebble.emit('appmessage', {payload: {COMMAND: 7}});

  assert.deepEqual(events, ['import:9', 'import:8', 'import:9', 'ack:9']);
  assert.deepEqual(sent, [{PART: 1},
    {ERROR_COMMAND: 2, ERROR_GENERATION: 7, ERROR_SEQUENCE: 9}]);
  assert.deepEqual(routed, [{COMMAND: 7}]);
});

test('diagnostic ACK callback failure, timeout, and throw release queued business', () => {
  const clock = timers();
  const sent = [], errors = [], logs = [];
  const callbackFailure = {code: 'APP_MSG_BUSY'};
  const thrown = new Error('diagnostic transport threw');
  let pendingAck, lateSuccess;
  const pebble = fakePebble((message, ok, fail) => {
    sent.push(message);
    if (message.ERROR_SEQUENCE === 1) pendingAck = {ok, fail};
    else if (message.ERROR_SEQUENCE === 2) lateSuccess = ok;
    else if (message.ERROR_SEQUENCE === 3) throw thrown;
    else ok();
  });
  const appMessages = session(pebble.sendAppMessage, {pebble,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    errorReporter: {report: (error) => errors.push(error), importWatch: () => true},
    log: (...args) => logs.push(args)});

  pebble.emit('appmessage', {payload: {ERROR_COMMAND: 1, ERROR_GENERATION: 1,
    ERROR_SEQUENCE: 1}});
  appMessages.send({PART: 1}, {operation: 'fetch'});
  pendingAck.fail(callbackFailure);

  pebble.emit('appmessage', {payload: {ERROR_COMMAND: 1, ERROR_GENERATION: 1,
    ERROR_SEQUENCE: 2}});
  appMessages.send({PART: 2}, {operation: 'fetch'});
  assert.equal(clock.nextDelay(), 500);
  clock.runNext();
  lateSuccess();

  pebble.emit('appmessage', {payload: {ERROR_COMMAND: 1, ERROR_GENERATION: 1,
    ERROR_SEQUENCE: 3}});
  appMessages.send({PART: 3}, {operation: 'fetch'});

  assert.deepEqual(sent.map((message) => message.ERROR_SEQUENCE || message.PART),
    [1, 1, 2, 2, 3, 3]);
  assert.deepEqual(errors, []);
  assert.equal(logs.length, 3);
  assert.equal(logs[0][1], callbackFailure);
  assert.equal(logs[1][1].code, 'CALLBACK_TIMEOUT');
  assert.equal(logs[2][1], thrown);
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
  const errors = [];
  const appMessages = session((message, ok) => { replies.push(message); ok(); }, {
    errorReporter: {report: (error) => errors.push(error)},
  });
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
  assert.deepEqual(errors.map((error) => error.code),
    ['read_invalid', 'read_invalid', 'read_conflict']);
});

test('AppMessage reports source failures but owns no diagnostic journal', () => {
  const errors = [];
  const replies = [];
  const appMessages = session((message, ok) => { replies.push(message); ok(); }, {
    errorReporter: {report: (error, whileDoing) => errors.push({error, whileDoing})},
  });

  assert.equal(appMessages.send({VALUE: true}, {operation: 'invalid'}), false);
  appMessages.handleRead('request-2', 'fetch', () => {
    throw new Error('upstream callback failed');
  }, {failureResponse: () => ({PROTOCOL: 1, STATUS: 4})});
  appMessages.handleRead('request-2', 'fetch', () => {}, {});

  assert.deepEqual(replies, [
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 'request-2'},
    {PROTOCOL: 1, STATUS: 4, REQUEST_ID: 'request-2'},
  ]);
  assert.deepEqual(Object.keys(appMessages).sort(),
    ['announceReady', 'handleRead', 'open', 'send']);
  assert.ok(errors.some((entry) => entry.error.code === 'invalid_dictionary_value'));
  assert.ok(errors.some((entry) => entry.error.message === 'upstream callback failed'));
});
