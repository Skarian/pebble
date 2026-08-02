'use strict';

var STORAGE_KEY = 'cpap.diagnostics.v1';
var LIMIT = 12;

function createDiagnostics(storage, now) {
  now = now || Date.now;

  function read() {
    try {
      var value = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (error) {
      return [];
    }
  }

  function summary(error) {
    if (!error) return null;
    return {
      type: error.type || 'unknown',
      step: error.step || 'unknown',
      status: Number(error.status || 0),
      elapsedMs: Number(error.elapsedMs || 0),
      code: error.code || '',
      replay: error.replay || 'unknown'
    };
  }

  function record(context, error) {
    error = error || {};
    var entry = {
      version: 1,
      at: now(),
      context: context,
      type: error.type || 'unknown',
      message: error.message || '',
      step: error.step || 'unknown',
      status: Number(error.status || 0),
      elapsedMs: Number(error.elapsedMs || 0),
      code: error.code || '',
      transient: Boolean(error.transient),
      attempts: Number(error.attempts || 1),
      replay: error.replay || 'unknown',
      shape: error.shape || '',
      previous: summary(error.previous)
    };
    var entries = read();
    entries.unshift(entry);
    storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, LIMIT)));
    return entry;
  }

  function report() {
    return JSON.stringify({version: 1, errors: read()}, null, 2);
  }

  function replay(log) {
    read().forEach(function (entry) {
      log('CPAP_DIAGNOSTIC ' + JSON.stringify(entry));
    });
  }

  return {record: record, report: report, replay: replay, read: read};
}

module.exports = createDiagnostics;
module.exports.STORAGE_KEY = STORAGE_KEY;
