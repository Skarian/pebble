import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const createDiagnostics = require('../src/common/diagnostics.js');

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}

test('errors survive recreation and retain only replay-safe fields', () => {
  const saved = storage();
  createDiagnostics(saved, () => 123).record('refresh', {
    type: 'service', message: 'ResMed unavailable', step: 'sleep records', status: 503,
    transient: true, attempts: 2, replay: 'http:sleep-records:503',
    shape: 'items=undefined', password: 'secret', accessToken: 'token'
  });

  const report = createDiagnostics(saved).report();
  assert.match(report, /http:sleep-records:503/);
  assert.match(report, /items=undefined/);
  assert.doesNotMatch(report, /secret|token/);
});

test('diagnostics are capped to the latest twelve failures and can be replayed', () => {
  const saved = storage();
  const diagnostics = createDiagnostics(saved, () => 123);
  for (let index = 0; index < 15; index += 1) {
    diagnostics.record(`refresh-${index}`, {status: index});
  }
  const lines = [];
  createDiagnostics(saved).replay((line) => lines.push(line));
  assert.equal(lines.length, 12);
  assert.match(lines[0], /refresh-14/);
  assert.doesNotMatch(lines.join('\n'), /refresh-0/);
});
