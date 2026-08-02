import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const model = require('../src/common/air_quality_model');

test('normalizes the four real Aranet4 metrics', () => {
  assert.deepEqual(model.normalize({co2: 612, temperature: 22.4, humidity: 47.2, pressure: 1008.6}),
    {co2: 612, temperature: 224, humidity: 472, pressure: 10086});
  assert.equal(model.normalize({}).pressure, model.UNAVAILABLE);
  assert.equal(model.normalize({temperature: -5.2}).temperature, -52);
});

test('builds seven newest-to-oldest chart buckets for each scale', () => {
  const slots = model.sevenBuckets([{co2: 700}], new Date(2026, 7, 2, 12), 2);
  assert.equal(slots.length, 7);
  assert.equal(slots[0].values.co2, 700);
  assert.ok(slots[0].time > slots[1].time);
  assert.equal(slots[0].time - slots[1].time, 86400);
});

test('uses supplied Aranet state and default thresholds only as fallback', () => {
  assert.equal(model.co2State(600, 3), 3);
  assert.equal(model.co2State(600), 1);
  assert.equal(model.co2State(1200), 2);
  assert.equal(model.co2State(1600), 3);
});

test('dictionary marks incomplete history without adding provider credentials', () => {
  const message = model.dictionary({location: 'Home', current: {co2: 612}}, Date.UTC(2026, 7, 2), 9);
  assert.equal(message.STATUS, 8);
  assert.equal(message.LOCATION, 'Home');
  assert.equal(message.REQUEST_ID, 9);
  assert.equal(message.CO2, 612);
  assert.equal(message.DAY6_PRESSURE_X10, model.UNAVAILABLE);
  assert.equal(message.SCALE, 0);
});
