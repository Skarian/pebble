import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../src/common/cpap_model.js');

test('builds seven yesterday-first local calendar slots', () => {
  const slots = model.sevenDaySlots([
    {startDate: '2026-08-01', sleepScore: 77},
    {startDate: '2026-07-31', sleepScore: 95, totalUsage: 452, ahi: 0.84,
      maskPairCount: 1, leakPercentile: 8},
    {startDate: '2026-07-30', sleepScore: 82, totalUsage: 398, ahi: 2.26,
      maskPairCount: 2, leakPercentile: 12.44}
  ], new Date(2026, 7, 1, 8, 0, 0));

  assert.equal(slots.length, 7);
  assert.deepEqual(slots.slice(0, 3), [
    {date: 20260731, score: 95, usage: 452, ahiX10: 8, maskOff: 1, leakX10: 80},
    {date: 20260730, score: 82, usage: 398, ahiX10: 23, maskOff: 2, leakX10: 124},
    {date: 20260729, score: 255, usage: 65535, ahiX10: 65535,
      maskOff: 255, leakX10: 65535}
  ]);
  assert.equal(slots[6].date, 20260725);
});

test('preserves zero and rejects invalid scores', () => {
  assert.equal(model.normalizeScore(0), 0);
  assert.equal(model.normalizeScore(100), 100);
  assert.equal(model.normalizeScore(101), 255);
  assert.equal(model.normalizeScore('bad'), 255);
});

test('normalizes nightly metrics without turning missing values into zero', () => {
  assert.equal(model.normalizeMetric(7.26, 10), 73);
  assert.equal(model.normalizeMetric(null, 10), 65535);
  assert.equal(model.normalizeMetric(-1, 1), 65535);
  assert.equal(model.normalizeCount(2), 2);
  assert.equal(model.normalizeCount(undefined), 255);
});

test('serializes all seven AppMessage fields', () => {
  const slots = model.sevenDaySlots([], new Date(2026, 7, 1, 8, 0, 0));
  const message = model.responseDictionary(slots, 10000, 7, 1);
  assert.equal(message.REQUEST_ID, 7);
  assert.equal(message.FETCHED_AT, 10);
  assert.equal(message.STATUS, 5);
  assert.equal(message.DAY0_DATE, 20260731);
  assert.equal(message.DAY6_SCORE, 255);
  assert.equal(message.DAY0_USAGE, 65535);
  assert.equal(message.DAY6_LEAK_X10, 65535);
});

test('base responses omit zero so the request session can attach the real identity', () => {
  const slots = model.sevenDaySlots([], new Date(2026, 7, 1, 8, 0, 0));
  const message = model.responseDictionary(slots, 10000, 0, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(message, 'REQUEST_ID'), false);
});

test('serializes the response source', () => {
  const slots = model.sevenDaySlots([], new Date(2026, 7, 1, 8, 0, 0));
  assert.equal(model.responseDictionary(slots, 10000, 0, 0).SOURCE, 0);
  assert.equal(model.responseDictionary(slots, 10000, 0, 1).SOURCE, 1);
});
