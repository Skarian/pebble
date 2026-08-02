'use strict';

var KEY = 'hubitat.diagnostics.v1';
var LIMIT = 12;

function createDiagnostics(storage, now) {
  now = now || Date.now;
  function read() {
    try { var value = JSON.parse(storage.getItem(KEY) || '[]'); return Array.isArray(value) ? value : []; }
    catch (error) { return []; }
  }
  function record(context, error) {
    error = error || {};
    var entries = read();
    entries.unshift({version: 1, at: now(), context: String(context || 'unknown'),
      type: String(error.type || 'unknown'), status: Number(error.status || 0),
      code: String(error.code || ''), message: String(error.message || '').slice(0, 80)});
    storage.setItem(KEY, JSON.stringify(entries.slice(0, LIMIT)));
    return entries[0];
  }
  function report() { return JSON.stringify({version: 1, errors: read()}, null, 2); }
  function replay(log) { read().forEach(function (entry) { log('HUBITAT_DIAGNOSTIC ' + JSON.stringify(entry)); }); }
  return {read: read, record: record, report: report, replay: replay};
}

module.exports = createDiagnostics;
module.exports.STORAGE_KEY = KEY;
