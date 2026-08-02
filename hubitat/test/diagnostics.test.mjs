import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const Diagnostics = require('../src/common/diagnostics.js');

function storage() {
  const values = new Map();
  return {getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))};
}

test('durable diagnostics retain only sanitized fields', () => {
  const saved = storage();
  Diagnostics(saved, () => 123).record('refresh', {type: 'auth', status: 401,
    message: 'Maker API access denied', token: 'secret', url: 'http://hub', deviceId: '42'});
  const report = Diagnostics(saved).report();
  assert.match(report, /access denied/);
  assert.doesNotMatch(report, /secret|http:\/\/hub|deviceId|"42"/);
});

test('diagnostics cap at twelve and survive recreation', () => {
  const saved = storage();
  const diagnostics = Diagnostics(saved);
  for (let index = 0; index < 15; index++) diagnostics.record(`r${index}`, {status: index});
  assert.equal(Diagnostics(saved).read().length, 12);
});
