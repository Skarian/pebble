import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const model = require('../src/common/air_quality_model');

test('normalizes valid readings and rejects missing values', () => {
  assert.deepEqual(model.normalize({aqi: 42, pm25: 8.25, co2: 612, temperature: 22.4, humidity: 47.2}),
    {aqi: 42, pm25: 83, co2: 612, temperature: 224, humidity: 472});
  assert.equal(model.normalize({}).pm25, model.UNAVAILABLE);
});

test('builds seven newest-to-oldest calendar slots', () => {
  const slots = model.sevenDays([{date: '2026-08-01', aqi: 30}], new Date(2026, 7, 2, 12));
  assert.equal(slots.length, 7);
  assert.equal(slots[0].date, 20260802);
  assert.equal(slots[1].date, 20260801);
  assert.equal(slots[1].values.aqi, 30);
});

test('dictionary keeps canonical units and marks partial history', () => {
  const message = model.dictionary({location: 'Office', current: {aqi: 44}}, Date.UTC(2026, 7, 2), 9);
  assert.equal(message.STATUS, 8);
  assert.equal(message.LOCATION, 'Office');
  assert.equal(message.REQUEST_ID, 9);
  assert.equal(message.AQI, 44);
});
