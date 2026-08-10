'use strict';

function createAppMessageSession(options) {
  options = options || {};
  var pebble = options.pebble;
  if (!pebble || typeof pebble.sendAppMessage !== 'function' ||
      typeof pebble.addEventListener !== 'function') {
    throw new TypeError('pebble is required');
  }

  var transport = function (dictionary, success, failure) {
    pebble.sendAppMessage(dictionary, success, failure);
  };
  var setTimer = options.setTimer || setTimeout;
  var clearTimer = options.clearTimer ||
    (typeof clearTimeout === 'function' ? clearTimeout : function () {});
  var now = options.now || Date.now;
  var storage = options.storage;
  var app = token(options.app, 24) || 'app';
  var logPrefix = app.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_APPMESSAGE';
  var storageKey = 'pebble.appmessage.' + app + '.v1';
  var responseIdKey = typeof options.requestIdKey === 'string' && options.requestIdKey ?
    options.requestIdKey : 'REQUEST_ID';
  var queue = [];
  var sending = false;
  var activeRead = null;
  var completedRead = null;
  var delivering = {};
  var events = loadEvents();
  var opened = false;
  var api = null;

  function safeText(value, pattern, limit) {
    try { value = String(value === undefined || value === null ? '' : value); }
    catch (ignored) { return ''; }
    return pattern.test(value) ? value.slice(0, limit) : '';
  }

  function token(value, limit) {
    return safeText(value, /^[A-Za-z0-9_.:-]+$/, limit || 48);
  }

  function label(value) { return safeText(value, /^[A-Za-z0-9_.: -]*$/, 48); }
  function shape(value) { return safeText(value, /^[A-Za-z0-9_{}()[\],=:. -]*$/, 500); }

  function boundedNumber(value, maximum) {
    value = Number(value || 0);
    if (!isFinite(value) || value < 0) return 0;
    return Math.min(maximum, Math.floor(value));
  }

  function validRequestRef(value) {
    if (typeof value === 'number') {
      return isFinite(value) && value > 0 && value <= 4294967295 &&
        Math.floor(value) === value;
    }
    return typeof value === 'string' && value.length > 0 && value.length <= 48 &&
      /^[A-Za-z0-9_.:-]+$/.test(value);
  }

  function requestKey(value) { return (typeof value === 'number' ? 'n:' : 's:') + value; }

  function resultCode(error) {
    try {
      if (typeof error === 'number' && isFinite(error)) return String(error);
      if (!error) return '';
      if (typeof error.code === 'number' && isFinite(error.code)) return String(error.code);
      return token(error.code, 48);
    } catch (ignored) {
      return '';
    }
  }

  function sanitize(entry) {
    entry = entry || {};
    var timestamp = Number(entry.at || now());
    if (!isFinite(timestamp) || timestamp < 0) timestamp = 0;
    return {
      at: timestamp,
      operation: token(entry.operation, 24),
      requestId: validRequestRef(entry.requestId) ? entry.requestId : '',
      event: token(entry.event, 32) || 'event',
      lifecycle: token(entry.lifecycle, 24),
      ready: Boolean(entry.ready),
      attempts: boundedNumber(entry.attempts || entry.attempt, 99),
      part: boundedNumber(entry.part, 999),
      resultClass: token(entry.resultClass, 48),
      resultCode: token(entry.resultCode || entry.code, 64),
      finalCategory: token(entry.finalCategory, 48),
      step: label(entry.step),
      status: boundedNumber(entry.status, 9999),
      elapsedMs: boundedNumber(entry.elapsedMs, 86400000),
      replay: token(entry.replay, 96),
      shape: shape(entry.shape)
    };
  }

  function loadEvents() {
    try {
      var saved = storage ? JSON.parse(storage.getItem(storageKey) || '[]') : [];
      var incidents = Array.isArray(saved) ? saved.map(sanitize)
        .filter(isIncident).slice(0, 32) : [];
      if (storage && JSON.stringify(saved) !== JSON.stringify(incidents)) {
        storage.setItem(storageKey, JSON.stringify(incidents));
      }
      return incidents;
    } catch (ignored) { return []; }
  }

  function isIncident(entry) {
    if (entry.event === 'domain_terminal') return entry.finalCategory !== 'ok';
    return entry.event === 'delivery_retry' || entry.event === 'delivery_failure' ||
      entry.event === 'domain_failure' || entry.event === 'read_invalid' ||
      entry.event === 'read_conflict' || entry.event === 'read_busy';
  }

  function record(entry) {
    var safe = sanitize(entry);
    output(logPrefix + ' ' + JSON.stringify(safe));
    if (isIncident(safe)) {
      events.unshift(safe);
      events = events.slice(0, 32);
      try { if (storage) storage.setItem(storageKey, JSON.stringify(events)); }
      catch (ignored) {}
    }
    return safe;
  }

  function report() { return JSON.stringify({version: 1, app: app, events: events}, null, 2); }

  function replayLog(log) {
    if (typeof log !== 'function') return;
    events.forEach(function (entry) {
      try { log(logPrefix + ' ' + JSON.stringify(entry)); }
      catch (ignored) {}
    });
  }

  function meta(value) {
    value = value || {};
    return {
      operation: token(value.operation, 24),
      requestId: validRequestRef(value.requestId) ? value.requestId : '',
      lifecycle: token(value.lifecycle, 24),
      ready: Boolean(value.ready)
    };
  }

  function copyDictionary(dictionary) {
    if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) return null;
    var copy = {};
    var keys;
    try { keys = Object.keys(dictionary); } catch (ignored) { return null; }
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      var value;
      try { value = dictionary[key]; } catch (ignoredValue) { return null; }
      if (typeof value === 'string') copy[key] = value;
      else if (typeof value === 'number' && isFinite(value) &&
          Math.floor(value) === value && Math.abs(value) <= 9007199254740991) {
        copy[key] = value;
      } else {
        return null;
      }
    }
    return copy;
  }

  function callback(done, outcome) {
    try { if (typeof done === 'function') done(outcome); } catch (ignored) {}
  }

  function finish(series, outcome) {
    sending = false;
    queue.shift();
    try { callback(series.done, outcome); } finally { pump(); }
  }

  function logDelivery(series, event, attempts, resultClass, code, part) {
    record({
      operation: series.meta.operation,
      requestId: series.meta.requestId,
      event: event,
      lifecycle: series.meta.lifecycle,
      ready: series.meta.ready,
      attempts: attempts,
      part: part === undefined ? series.index : part,
      resultClass: resultClass,
      resultCode: code,
      finalCategory: event === 'delivery_success' ? 'ok' :
        event === 'delivery_retry' ? 'pending' : 'delivery'
    });
  }

  function schedule(task, delay) {
    try { return setTimer(task, delay); }
    catch (ignored) { task(); return null; }
  }

  function sendCurrent(series) {
    var dictionary = series.items[series.index];
    series.attempt += 1;
    var attempt = series.attempt;
    var settled = false;
    var watchdog = null;

    function settle(ok, error, resultClass) {
      if (settled) return;
      settled = true;
      if (watchdog !== null) {
        try { clearTimer(watchdog); } catch (ignored) {}
      }
      var code = resultCode(error);
      if (ok) {
        var completedPart = series.index;
        series.totalAttempts += attempt;
        series.index += 1;
        series.attempt = 0;
        if (series.index === series.items.length) {
          logDelivery(series, 'delivery_success', series.totalAttempts,
            'ack', '', completedPart);
          finish(series, {ok: true, attempts: series.totalAttempts,
            resultClass: 'ack', resultCode: ''});
        } else {
          sendCurrent(series);
        }
        return;
      }
      if (attempt < 3) {
        logDelivery(series, 'delivery_retry', attempt, resultClass, code);
        schedule(function () { sendCurrent(series); }, [250, 1000][attempt - 1]);
        return;
      }
      logDelivery(series, 'delivery_failure', attempt, resultClass, code);
      finish(series, {ok: false, attempts: series.totalAttempts + attempt,
        resultClass: resultClass, resultCode: code, failedPart: series.index});
    }

    watchdog = schedule(function () {
      settle(false, {code: 'CALLBACK_TIMEOUT'}, 'callback_timeout');
    }, 5000);
    if (settled) return;
    try {
      transport(dictionary,
        function () { settle(true, null, 'ack'); },
        function (error) { settle(false, error, 'callback_failure'); });
    } catch (ignored) {
      settle(false, null, 'exception');
    }
  }

  function pump() {
    if (sending || !queue.length) return;
    sending = true; sendCurrent(queue[0]);
  }

  function rejectSend(metaValue, done, resultClass) {
    var rejected = {meta: meta(metaValue), index: 0};
    logDelivery(rejected, 'delivery_failure', 0, resultClass, '');
    callback(done, {ok: false, attempts: 0, resultClass: resultClass, resultCode: ''});
    return false;
  }

  function send(dictionaries, metaValue, done) {
    var source = Array.isArray(dictionaries) ? dictionaries : [dictionaries];
    if (!source.length) {
      callback(done, {ok: true, attempts: 0, resultClass: 'ack', resultCode: ''});
      return true;
    }
    var items = [];
    for (var index = 0; index < source.length; index += 1) {
      var copy = copyDictionary(source[index]);
      if (!copy) return rejectSend(metaValue, done, 'invalid_dictionary');
      items.push(copy);
    }
    if (queue.length >= 24) return rejectSend(metaValue, done, 'queue_full');
    queue.push({items: items, meta: meta(metaValue), done: done,
      index: 0, attempt: 0, totalAttempts: 0});
    pump();
    return true;
  }

  function announceReady(dictionary) {
    var readyMeta = {
      operation: 'ready', requestId: 'session',
      lifecycle: 'ready',
      ready: true
    };
    send(dictionary, readyMeta);
    schedule(function () { send(dictionary, readyMeta); }, 1000);
  }

  function output(line) {
    try {
      if (typeof options.log === 'function') options.log(line);
      else if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(line);
    } catch (ignored) {}
  }

  function readyMessage() {
    try {
      return typeof options.readyMessage === 'function' ? options.readyMessage() :
        options.readyMessage;
    } catch (ignored) { return null; }
  }

  /** Registers the raw Pebble boundary once; app callbacks own only protocol routing. */
  function open() {
    if (opened) return false;
    opened = true;
    pebble.addEventListener('ready', function () {
      record({operation: 'ready', event: 'lifecycle_ready',
        lifecycle: 'ready', ready: true});
      replayLog(output);
      var message = readyMessage();
      if (message) announceReady(message);
    });
    pebble.addEventListener('appmessage', function (event) {
      if (typeof options.onMessage !== 'function') return;
      try { options.onMessage((event && event.payload) || {}, api); }
      catch (ignored) {
        record({operation: 'message', event: 'domain_terminal',
          lifecycle: 'active', ready: true, finalCategory: 'phone_runtime'});
      }
    });
    return true;
  }

  function readSignature(operation, fingerprint) {
    operation = token(operation, 24);
    if (!operation) return '';
    if (fingerprint === undefined || fingerprint === null) return operation;
    return validRequestRef(fingerprint) ? operation + '|' + requestKey(fingerprint) : '';
  }

  function readEvent(operation, reference, event, category, resultClass) {
    record({operation: operation, requestId: reference, event: event,
      lifecycle: 'active', ready: true, resultClass: resultClass,
      finalCategory: category || 'pending'});
  }

  function hasReference(read, key) {
    return read && Object.prototype.hasOwnProperty.call(read.references, key);
  }

  function deliverRead(read, reference, replay) {
    var key = requestKey(reference);
    if (delivering[key]) {
      readEvent(read.operation, reference, 'read_coalesced');
      return;
    }
    var dictionary = copyDictionary(read.response);
    if (dictionary) dictionary[responseIdKey] = reference;
    delivering[key] = true;
    readEvent(read.operation, reference, replay ? 'response_replayed' : 'response_ready');
    send(dictionary, {operation: read.operation, requestId: reference,
      lifecycle: 'active', ready: true}, function () {
      delete delivering[key];
    });
  }

  function finishRead(read, response) {
    if (activeRead !== read) return;
    activeRead = null; read.response = response; completedRead = read;
    read.order.forEach(function (key) {
      deliverRead(read, read.references[key], false);
    });
  }

  function domainFailure(read, configuration) {
    readEvent(read.operation, read.firstReference, 'domain_terminal',
      'phone_runtime', 'exception');
    activeRead = null;
    var fallback = configuration.failureResponse;
    if (typeof fallback === 'function') {
      try { fallback = fallback(read.firstReference); } catch (ignored) { fallback = null; }
    }
    if (fallback !== undefined && fallback !== null) {
      activeRead = read;
      finishRead(read, fallback);
    }
  }

  function handleRead(reference, operation, run, configuration) {
    configuration = configuration || {};
    var signature = readSignature(operation, configuration.fingerprint);
    if (!validRequestRef(reference) || !signature || typeof run !== 'function') {
      readEvent(operation, reference, 'read_invalid', 'protocol');
      return false;
    }
    operation = token(operation, 24);
    var key = requestKey(reference);
    readEvent(operation, reference, 'read_received');

    if (hasReference(completedRead, key)) {
      if (completedRead.signature !== signature) {
        readEvent(operation, reference, 'read_conflict', 'protocol');
        return false;
      }
      deliverRead(completedRead, reference, true);
      return true;
    }
    if (hasReference(activeRead, key)) {
      if (activeRead.signature !== signature) {
        readEvent(operation, reference, 'read_conflict', 'protocol');
        return false;
      }
      readEvent(operation, reference, 'read_coalesced');
      return true;
    }
    if (activeRead) {
      if (activeRead.signature !== signature) {
        readEvent(operation, reference, 'read_busy', 'protocol');
        return false;
      }
      activeRead.references[key] = reference;
      activeRead.order.push(key);
      readEvent(operation, reference, 'read_joined');
      return true;
    }

    var read = {
      operation: operation,
      signature: signature,
      firstReference: reference,
      references: {},
      order: []
    };
    read.references[key] = reference;
    read.order.push(key);
    activeRead = read;
    try {
      run(reference, function (response) { finishRead(read, response); });
    } catch (ignored) {
      if (activeRead === read) domainFailure(read, configuration);
    }
    return true;
  }

  api = {
    open: open,
    send: send,
    announceReady: announceReady,
    handleRead: handleRead,
    record: record,
    report: report,
    replayLog: replayLog
  };
  return api;
}

module.exports = createAppMessageSession;
