'use strict';

var DIAGNOSTIC_ACK_TIMEOUT_MS = 500;

function createAppMessageSession(options) {
  options = options || {};
  var pebble = options.pebble;
  if (!pebble || typeof pebble.sendAppMessage !== 'function' ||
      typeof pebble.addEventListener !== 'function') throw new TypeError('pebble is required');

  var transport = function (dictionary, success, failure) { pebble.sendAppMessage(
    dictionary, success, failure); };
  var setTimer = options.setTimer || setTimeout;
  var clearTimer = options.clearTimer || (typeof clearTimeout === 'function' ?
    clearTimeout : function () {}), reporter = options.errorReporter;
  var responseIdKey = typeof options.requestIdKey === 'string' && options.requestIdKey ?
    options.requestIdKey : 'REQUEST_ID';
  var queue = [], sending = false, activeRead = null, completedRead = null;
  var delivering = {}, opened = false, api = null;

  function report(error, whileDoing) {
    try { if (reporter && typeof reporter.report === 'function') reporter.report(error, whileDoing); }
    catch (ignored) {}
  }

  function platformLog(code, error) {
    try {
      if (typeof options.log === 'function') options.log('pebble-appmessage ' + code, error);
      else if (typeof console !== 'undefined' && console.log)
        console.log('pebble-appmessage ' + code, error);
    } catch (ignored) {}
  }

  function failure(name, message, fields) {
    var error = new Error(message); error.name = name;
    Object.keys(fields || {}).forEach(function (key) { error[key] = fields[key]; });
    return error;
  }

  function token(value, limit) {
    try {
      value = String(value === undefined || value === null ? '' : value);
      return /^[A-Za-z0-9_.:-]+$/.test(value) ? value.slice(0, limit || 48) : '';
    } catch (error) { report(error, 'normalizing AppMessage metadata'); return ''; }
  }

  function validRequestRef(value) {
    if (typeof value === 'number') return isFinite(value) && value > 0 &&
      value <= 4294967295 && Math.floor(value) === value;
    return typeof value === 'string' && value.length > 0 && value.length <= 48 &&
      /^[A-Za-z0-9_.:-]+$/.test(value);
  }

  function requestKey(value) { return (typeof value === 'number' ? 'n:' : 's:') + value; }

  function deliveryContext(meta) {
    var operation = '';
    try { operation = token(meta && meta.operation, 24); }
    catch (error) { report(error, 'reading AppMessage operation metadata'); }
    return operation ? 'sending an AppMessage for ' + operation : 'sending an AppMessage';
  }

  function resultCode(value) {
    try {
      if (typeof value === 'number' && isFinite(value)) return String(value);
      if (!value) return '';
      if (typeof value.code === 'number' && isFinite(value.code)) return String(value.code);
      return token(value.code, 48);
    } catch (error) { report(error, 'reading an AppMessage failure code'); return ''; }
  }

  function copyDictionary(dictionary) {
    if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
      var invalid = failure('AppMessageDictionaryError', 'AppMessage dictionary is invalid',
        {code: 'invalid_dictionary'});
      report(invalid, 'copying an AppMessage dictionary');
      return null;
    }
    var copy = {}, keys;
    try { keys = Object.keys(dictionary); }
    catch (error) { report(error, 'reading an AppMessage dictionary'); return null; }
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      var value;
      try { value = dictionary[key]; }
      catch (error) { report(error, 'reading an AppMessage dictionary value'); return null; }
      if (typeof value === 'string') copy[key] = value;
      else if (typeof value === 'number' && isFinite(value) && Math.floor(value) === value &&
          Math.abs(value) <= 9007199254740991) copy[key] = value;
      else {
        report(failure('AppMessageDictionaryError', 'AppMessage value is unsupported',
          {code: 'invalid_dictionary_value', key: token(key, 48), valueType: typeof value}),
        'copying an AppMessage dictionary');
        return null;
      }
    }
    return copy;
  }

  function callback(done, outcome) {
    if (typeof done !== 'function') return;
    try { done(outcome); }
    catch (error) { report(error, 'running an AppMessage completion callback'); }
  }

  function schedule(task, delay, whileDoing) {
    try { return setTimer(task, delay); }
    catch (error) { report(error, whileDoing || 'scheduling AppMessage work'); task(); return null; }
  }

  function finish(series, outcome) {
    sending = false; queue.shift();
    try { callback(series.done, outcome); } finally { pump(); }
  }

  function sendCurrent(series) {
    var dictionary = series.items[series.index];
    series.attempt += 1;
    var attempt = series.attempt;
    var settled = false;
    var watchdog = null;

    function settle(ok, original, resultClass) {
      if (settled) return;
      settled = true;
      if (watchdog !== null) {
        try { clearTimer(watchdog); }
        catch (error) { report(error, 'cancelling an AppMessage watchdog'); }
      }
      if (ok) {
        series.totalAttempts += attempt;
        series.index += 1;
        series.attempt = 0;
        if (series.index === series.items.length) {
          finish(series, {ok: true, attempts: series.totalAttempts,
            resultClass: 'ack', resultCode: ''});
        } else sendCurrent(series);
        return;
      }
      report(original, series.whileDoing);
      if (attempt < 3) {
        schedule(function () { sendCurrent(series); }, [250, 1000][attempt - 1],
          'scheduling an AppMessage retry');
        return;
      }
      finish(series, {ok: false, attempts: series.totalAttempts + attempt,
        resultClass: resultClass, resultCode: resultCode(original), failedPart: series.index});
    }

    watchdog = schedule(function () {
      settle(false, failure('AppMessageTimeoutError', 'AppMessage callback timed out',
        {code: 'CALLBACK_TIMEOUT'}), 'callback_timeout');
    }, 5000, 'scheduling an AppMessage watchdog');
    if (settled) return;
    try {
      transport(dictionary,
        function () { settle(true, null, 'ack'); },
        function (error) { settle(false, error, 'callback_failure'); });
    } catch (error) { settle(false, error, 'exception'); }
  }

  function pump() { if (!sending && queue.length) { sending = true; sendCurrent(queue[0]); } }

  function rejectSend(done, resultClass) {
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
      if (!copy) return rejectSend(done, 'invalid_dictionary');
      items.push(copy);
    }
    if (queue.length >= 24) {
      report(failure('AppMessageQueueError', 'AppMessage queue is full',
        {code: 'queue_full'}), 'queueing an AppMessage');
      return rejectSend(done, 'queue_full');
    }
    queue.push({items: items, done: done, whileDoing: deliveryContext(metaValue),
      index: 0, attempt: 0, totalAttempts: 0});
    pump();
    return true;
  }

  function sendDiagnosticAck(dictionary) {
    if (sending || queue.length) return;
    var settled = false, watchdog = null;
    function release(error) {
      if (settled) return;
      settled = true;
      if (watchdog !== null) {
        try { clearTimer(watchdog); } catch (ignored) {}
      }
      if (error) platformLog('diagnostic_ack_failed', error);
      sending = false; pump();
    }
    sending = true;
    try {
      watchdog = setTimer(function () { release(failure('AppMessageTimeoutError',
        'Diagnostic ACK callback timed out', {code: 'CALLBACK_TIMEOUT'})); },
      DIAGNOSTIC_ACK_TIMEOUT_MS);
      transport(dictionary, function () { release(); }, release);
    } catch (error) { release(error); }
  }

  function receiveWatchError(payload) {
    if (!payload || Number(payload.ERROR_COMMAND) !== 1) return false;
    try {
      if (reporter && typeof reporter.importWatch === 'function' && reporter.importWatch(payload)) {
        sendDiagnosticAck({ERROR_COMMAND: 2, ERROR_GENERATION: Number(payload.ERROR_GENERATION),
          ERROR_SEQUENCE: Number(payload.ERROR_SEQUENCE)});
      }
    } catch (error) { platformLog('watch_error_import_failed', error); }
    return true;
  }

  function announceReady(dictionary) {
    var readyMeta = {operation: 'ready', requestId: 'session'};
    send(dictionary, readyMeta);
    schedule(function () { send(dictionary, readyMeta); }, 1000,
      'scheduling the repeated READY message');
  }

  function readyMessage() {
    try { return typeof options.readyMessage === 'function' ?
      options.readyMessage() : options.readyMessage; }
    catch (error) { report(error, 'building the phone READY message'); return null; }
  }

  function open() {
    if (opened) return false;
    opened = true;
    try {
      pebble.addEventListener('ready', function () {
        var message = readyMessage();
        if (message) announceReady(message);
      });
      pebble.addEventListener('appmessage', function (event) {
        var payload = (event && event.payload) || {};
        if (receiveWatchError(payload)) return;
        if (typeof options.onMessage !== 'function') return;
        try { options.onMessage(payload, api); }
        catch (error) { report(error, 'handling a watch AppMessage'); }
      });
    } catch (error) {
      report(error, 'registering Pebble AppMessage listeners');
      return false;
    }
    return true;
  }

  function readSignature(operation, fingerprint) {
    operation = token(operation, 24);
    if (!operation) return '';
    if (fingerprint === undefined || fingerprint === null) return operation;
    return validRequestRef(fingerprint) ? operation + '|' + requestKey(fingerprint) : '';
  }

  function hasReference(read, key) {
    return read && Object.prototype.hasOwnProperty.call(read.references, key);
  }

  function deliverRead(read, reference) {
    var key = requestKey(reference);
    if (delivering[key]) return;
    var dictionary = copyDictionary(read.response);
    if (!dictionary) return;
    dictionary[responseIdKey] = reference;
    delivering[key] = true;
    send(dictionary, {operation: read.operation, requestId: reference}, function () {
      delete delivering[key];
    });
  }

  function finishRead(read, response) {
    if (activeRead !== read) return;
    activeRead = null; read.response = response; completedRead = read;
    read.order.forEach(function (key) { deliverRead(read, read.references[key]); });
  }

  function domainFailure(read, configuration, error) {
    report(error, 'running a phone read operation');
    activeRead = null;
    var fallback = configuration.failureResponse;
    if (typeof fallback === 'function') {
      try { fallback = fallback(read.firstReference); }
      catch (fallbackError) {
        report(fallbackError, 'building a phone failure response');
        fallback = null;
      }
    }
    if (fallback !== undefined && fallback !== null) {
      activeRead = read;
      finishRead(read, fallback);
    }
  }

  function protocolError(code, operation, reference) {
    return failure('AppMessageProtocolError', 'AppMessage read request is invalid',
      {code: code, operation: token(operation, 24),
        requestId: validRequestRef(reference) ? reference : ''});
  }

  function handleRead(reference, operation, run, configuration) {
    configuration = configuration || {};
    var signature = readSignature(operation, configuration.fingerprint);
    if (!validRequestRef(reference) || !signature || typeof run !== 'function') {
      report(protocolError('read_invalid', operation, reference), 'admitting a phone read');
      return false;
    }
    operation = token(operation, 24);
    var key = requestKey(reference);
    if (hasReference(completedRead, key)) {
      if (completedRead.signature !== signature) {
        report(protocolError('read_conflict', operation, reference), 'replaying a phone read');
        return false;
      }
      deliverRead(completedRead, reference);
      return true;
    }
    if (hasReference(activeRead, key)) {
      if (activeRead.signature !== signature) {
        report(protocolError('read_conflict', operation, reference), 'coalescing a phone read');
        return false;
      }
      return true;
    }
    if (activeRead) {
      if (activeRead.signature !== signature) {
        report(protocolError('read_busy', operation, reference), 'admitting a phone read');
        return false;
      }
      activeRead.references[key] = reference;
      activeRead.order.push(key);
      return true;
    }
    var read = {operation: operation, signature: signature, firstReference: reference,
      references: {}, order: []};
    read.references[key] = reference;
    read.order.push(key);
    activeRead = read;
    try { run(reference, function (response) { finishRead(read, response); }); }
    catch (error) { if (activeRead === read) domainFailure(read, configuration, error); }
    return true;
  }

  api = {open: open, send: send, announceReady: announceReady, handleRead: handleRead};
  return api;
}

module.exports = createAppMessageSession;
