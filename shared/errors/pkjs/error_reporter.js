'use strict';
var RETRY_MS = [5000, 30000, 120000];
var ENDPOINT = 'https://pebble.exe.xyz/v1/errors';
var SECRET_KEY = /^(?:password|passcode|authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|sessiontoken|api[_-]?key|credential|credentials|secret|code[_-]?verifier|client[_-]?secret|transcript|user[_-]?message|message[_-]?body)$/i;
function createErrorReporter(options) {
  options = options || {};
  var storage = options.storage, Xhr = options.Xhr;
  var now = options.now || Date.now, random = options.random || Math.random;
  var setTimer = options.setTimer || setTimeout;
  var clearTimer = options.clearTimer ||
    (typeof clearTimeout === 'function' ? clearTimeout : function () {});
  var isIdle = options.isIdle || function () { return true; };
  var getSecrets = options.secrets || function () { return []; };
  var platformLog = options.log || function (message, error) {
    if (typeof console !== 'undefined' && console.log) console.log(message, error);
  };
  var source = String(options.source || 'app/pkjs@unknown').slice(0, 80), watchSource = String(options.watchSource || 'app/watch@unknown').slice(0, 80);
  var storageKey = String(options.storageKey || 'pebble.errors.v1'), config = normalizeConfig(options.config || {});
  var state = null, timer = null, uploading = false, attempts = 0;
  function normalizeConfig(value) {
    var key = typeof value.key === 'string' ? value.key.trim().slice(0, 512) : '';
    return {enabled: Boolean(value.enabled && key), key: key};
  }
  function live(code, error) {
    try { platformLog('pebble-errors ' + code, error); }
    catch (ignored) {}
  }
  function fresh(corrupt) {
    var installation = Number(now()).toString(36) +
      Math.floor(Number(random()) * 0x100000000).toString(36) +
      Math.floor(Number(random()) * 0x100000000).toString(36);
    return {version: 1, installation: installation.slice(0, 32), next: 1,
      records: [], dropped: corrupt ? 1 : 0, overflow: null};
  }
  function load() {
    if (state) return state;
    try {
      state = JSON.parse(storage.getItem(storageKey) || 'null');
      if (!state || state.version !== 1 || typeof state.installation !== 'string' ||
          !Array.isArray(state.records)) state = fresh(Boolean(state));
      else {
        state.records = state.records.filter(function (record) {
          return record && typeof record.id === 'string';
        }).slice(-50);
        state.next = Math.max(1, Number(state.next) || 1);
        state.dropped = Math.max(0, Number(state.dropped) || 0);
        if (!state.overflow || typeof state.overflow.id !== 'string' ||
            typeof state.overflow.at !== 'string' || !(state.overflow.count > 0) ||
            state.overflow.count > state.dropped) state.overflow = null;
      }
    } catch (error) { state = fresh(true); live('outbox_read_failed'); }
    return state;
  }
  function size(value) {
    try { return unescape(encodeURIComponent(value)).length; }
    catch (ignored) { return value.length * 2; }
  }
  function save() {
    var current = load();
    while (current.records.length > 50) { current.records.shift(); current.dropped += 1; }
    while (true) {
      var serialized;
      try { serialized = JSON.stringify(current); }
      catch (error) { live('outbox_serialize_failed'); return false; }
      if (size(serialized) <= 65536) {
        try {
          storage.setItem(storageKey, serialized);
          if (storage.getItem(storageKey) === serialized) return true;
          live('outbox_write_verify_failed', new Error('Stored error queue did not match the write'));
        } catch (error) { live('outbox_write_failed', error); }
      }
      if (!current.records.length) { live('outbox_write_failed'); return false; }
      current.records.shift(); current.dropped += 1;
    }
  }
  function secretValues(additional) {
    var values;
    try { values = getSecrets(); } catch (error) { values = []; }
    if (!Array.isArray(values)) values = [];
    if (config.key) values = values.concat([config.key]);
    if (Array.isArray(additional)) values = values.concat(additional);
    return values.filter(function (value) {
      return typeof value === 'string' && value.length;
    }).slice(0, 32);
  }
  function cleanText(value, limit, secrets) {
    var text;
    try { text = String(value === undefined || value === null ? '' : value); }
    catch (error) { return '[unprintable]'; }
    var candidates = [];
    secrets.forEach(function (secret) {
      candidates.push(secret);
      try { candidates.push(encodeURIComponent(secret)); } catch (ignored) {}
    });
    if (candidates.indexOf(text) >= 0) return '[REDACTED]';
    candidates.forEach(function (candidate) {
      if (candidate.length >= 4) text = text.split(candidate).join('[REDACTED]');
    });
    text = text.replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/ig, '$1[REDACTED]')
      .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{8,}/ig, '$1[REDACTED]')
      .replace(/((?:password|token|access[_-]?token|refresh[_-]?token|id[_-]?token|sessiontoken|session[_-]?token|api[_-]?key|credentials?|secret|code[_-]?verifier|client[_-]?secret)["']?\s*[:=]\s*["']?)[^&\s,"'}]+/ig, '$1[REDACTED]')
      .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/ig, '$1[REDACTED]');
    return text.length > limit ? text.slice(0, limit - 11) + '[TRUNCATED]' : text;
  }
  function read(value, key) {
    try { return value[key]; } catch (error) { return undefined; }
  }
  function clean(value, key, depth, seen, secrets) {
    if (SECRET_KEY.test(key || '')) return '[REDACTED]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return isFinite(value) ? value : String(value);
    if (typeof value === 'string') return cleanText(value, key === 'stack' ? 8192 : 4096, secrets);
    if (typeof value !== 'object') return '[' + typeof value + ' omitted]';
    if (depth >= 5) return '[depth truncated]';
    if (seen.indexOf(value) >= 0) return '[circular]';
    seen.push(value);
    var result = Array.isArray(value) ? [] : {}, names;
    if (!Array.isArray(value)) {
      ['name', 'message', 'stack'].forEach(function (name) {
        var standard = read(value, name);
        if (standard) result[name] = cleanText(standard, name === 'stack' ? 8192 : 4096, secrets);
      });
    }
    try { names = Array.isArray(value) ? value.slice(0, 32).map(function (_, i) { return i; }) :
      Object.getOwnPropertyNames(value).slice(0, 32); }
    catch (error) { names = []; }
    names.forEach(function (name) {
      if (name === 'name' || name === 'message' || name === 'stack') return;
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, name); }
      catch (error) { descriptor = null; }
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        result[name] = clean(descriptor.value, String(name), depth + 1, seen, secrets);
      }
    });
    seen.pop();
    return result;
  }
  function iso(value) {
    try { return new Date(value === undefined ? now() : value).toISOString(); }
    catch (error) { return '1970-01-01T00:00:00.000Z'; }
  }
  function uint32(value, positive) { return isFinite(value) && Math.floor(value) === value &&
    value <= 4294967295 && value >= (positive ? 1 : 0); }
  function enqueue(record, fixedId) {
    var current = load();
    var id = fixedId || current.installation + ':pkjs:' + current.next++;
    if (current.records.some(function (item) { return item.id === id; })) return id;
    record.id = id;
    current.records.push(record);
    if (!save() || !current.records.some(function (item) { return item.id === id; })) return null;
    if (!uploading && timer === null && attempts >= RETRY_MS.length) attempts = 0;
    schedule(1000);
    return id;
  }
  function report(error, whileDoing, additionalSecrets) {
    if (!config.enabled) return null;
    try {
      var secrets = secretValues(additionalSecrets);
      return enqueue({at: iso(), source: source, while: cleanText(whileDoing, 160, secrets),
        error: clean(error instanceof Error || error && typeof error === 'object' ? error :
          new Error(cleanText(error, 4096, secrets)), '', 0, [], secrets)});
    } catch (captureError) { live('capture_failed'); return null; }
  }
  function importWatch(payload) {
    if (!config.enabled) return false;
    var generation = Number(payload.ERROR_GENERATION), sequence = Number(payload.ERROR_SEQUENCE),
      at = Number(payload.ERROR_AT), parts = typeof payload.ERROR_DATA === 'string' ?
        payload.ERROR_DATA.split('\t') : [];
    if (!uint32(generation, true) || !uint32(sequence, true) || !uint32(at, false) ||
        parts.length !== 9 || parts[0] !== 'v1') return false;
    var error = new Error(parts[5] || parts[2] || parts[1] || 'Watch error');
    error.name = parts[1] || 'CError'; error.function = parts[2]; error.symbol = parts[4];
    error.code = /^-?\d+$/.test(parts[3]) ? Number(parts[3]) : parts[3];
    error.file = parts[6]; error.line = /^\d+$/.test(parts[7]) ? Number(parts[7]) : parts[7];
    error.watchDropped = Math.max(0, Number(payload.ERROR_DROPPED) || 0);
    var secrets = secretValues([]), id = load().installation + ':watch:' + generation + ':' + sequence;
    return Boolean(enqueue({at: iso(at * 1000), source: watchSource,
      while: cleanText(parts[8] || 'handling a watch error', 160, secrets),
      error: clean(error, '', 0, [], secrets)}, id));
  }
  function failed(code) {
    uploading = false; live(code);
    if (attempts === 0) attempts = 1;
    if (attempts < RETRY_MS.length) schedule(RETRY_MS[attempts - 1]);
  }
  function upload() {
    timer = null;
    if (!config.enabled || uploading || (!load().records.length && !load().dropped) ||
        attempts >= RETRY_MS.length) return;
    try { if (!isIdle()) { schedule(5000); return; } }
    catch (error) { failed('idle_check_failed'); return; }
    var current = load(), overflow = current.overflow;
    if (current.dropped && !overflow) {
      overflow = current.overflow = {id: current.installation + ':pkjs:' + current.next++,
        at: iso(), count: current.dropped};
      if (!save()) { current.overflow = null; failed('outbox_write_failed'); return; }
    }
    var records = overflow ? [{id: overflow.id, at: overflow.at, source: source,
      while: 'retaining the local error queue', error: {name: 'QueueOverflow',
        message: 'Local error queue dropped ' + overflow.count + ' errors',
        dropped: overflow.count}}] : [];
    records = records.concat(current.records.slice(0, 20 - records.length));
    var endpoint = ENDPOINT, requestKey = config.key;
    var xhr, settled = false;
    uploading = true; attempts += 1;
    function reject(code) {
      if (requestKey === config.key) { failed(code); return; }
      uploading = false; attempts = 0; live(code); schedule(0);
    }
    function finish(ok, code, accepted) {
      if (settled) return;
      settled = true;
      if (!config.enabled) { uploading = false; return; }
      if (!ok) { reject(code); return; }
      var ids = {}, valid = accepted.length === records.length;
      accepted.forEach(function (id) { if (typeof id !== 'string' || ids[id]) valid = false; ids[id] = true; });
      records.forEach(function (record) { if (!ids[record.id]) valid = false; });
      if (!valid) { reject('invalid_ack'); return; }
      state.records = state.records.filter(function (record) { return !ids[record.id]; });
      if (state.overflow && ids[state.overflow.id]) {
        state.dropped = Math.max(0, state.dropped - state.overflow.count);
        state.overflow = null;
      }
      uploading = false; attempts = 0; save();
      if (state.records.length || state.dropped) schedule(1000);
    }
    try {
      xhr = new Xhr(); xhr.timeout = 10000; xhr.open('POST', endpoint, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-Pebble-Diagnostics-Key', requestKey);
      xhr.onload = function () {
        var response;
        try { response = JSON.parse(xhr.responseText || '{}'); }
        catch (error) { finish(false, 'invalid_ack'); return; }
        if (xhr.responseURL && xhr.responseURL !== endpoint) { finish(false, 'redirect'); return; }
        var ok = xhr.status >= 200 && xhr.status < 300 && Array.isArray(response.accepted);
        finish(ok, ok ? '' : 'http_' + Number(xhr.status || 0), response.accepted || []);
      };
      xhr.onerror = function () { finish(false, 'network'); };
      xhr.ontimeout = function () { finish(false, 'timeout'); };
      xhr.onloadend = function () { if (!settled && (!xhr.status || xhr.status === 0)) finish(false, 'network'); };
      xhr.send(JSON.stringify({records: records}));
    } catch (error) { finish(false, 'exception'); }
  }
  function schedule(delay) {
    if (!config.enabled || uploading || timer !== null || attempts >= RETRY_MS.length) return;
    try { timer = setTimer(upload, Math.max(0, Number(delay) || 0)); }
    catch (error) { live('upload_timer_failed'); }
  }
  function cancel() {
    if (timer === null) return;
    try { clearTimer(timer); } catch (error) { live('upload_timer_cancel_failed'); }
    timer = null;
  }
  function clearOutbox() {
    storage.removeItem(storageKey);
    if (storage.getItem(storageKey) !== null) {
      throw new Error('Stored error queue remained after removal');
    }
    state = null;
  }
  function configure(value) {
    var next = normalizeConfig(value || {});
    var keyChanged = config.enabled && next.enabled && config.key !== next.key;
    if (!next.enabled) {
      config = next; cancel(); uploading = false; attempts = 0;
      try {
        if (storage) clearOutbox();
      } catch (error) {
        live('outbox_delete_failed', error);
        throw error;
      }
      return false;
    }
    if (!config.enabled) {
      try { if (storage) clearOutbox(); }
      catch (error) { live('outbox_delete_failed', error); throw error; }
    }
    config = next;
    if (keyChanged) { cancel(); attempts = 0; }
    load(); if (state.records.length || state.dropped) schedule(0); return true;
  }
  function status() {
    if (!config.enabled) return {enabled: false, queued: 0, dropped: 0};
    return {enabled: true, queued: load().records.length, dropped: load().dropped};
  }
  function sendNow() {
    if (!config.enabled) return false;
    cancel(); attempts = 0; schedule(0); return true;
  }
  if (config.enabled) { load(); if (state.records.length || state.dropped) schedule(1000); }
  return {report: report, configure: configure, status: status, sendNow: sendNow,
    readyValue: function () { return config.enabled ? 1 : 0; },
    importWatch: importWatch};
}
module.exports = createErrorReporter;
