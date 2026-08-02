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

test('packs screen-resolution min max and last values without averaging peaks', () => {
  const points = Array.from({length: model.GRAPH_COLUMNS}, () => ({co2: 700}));
  points[0] = {co2: 700, co2Min: 500, co2Max: 1200};
  const columns = model.chartColumns(points);
  assert.equal(columns.length, 56);
  assert.deepEqual(columns[0][0], [500, 1200, 700]);
  const bytes = model.packSeries(columns, 0);
  assert.equal(bytes.length, 336);
  assert.deepEqual(bytes.slice(0, 6), [244, 1, 176, 4, 188, 2]);
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
  assert.equal(message.AVG_PRESSURE_X10, model.UNAVAILABLE);
  assert.equal(message.POINT_COUNT, 56);
  assert.equal(message.SERIES_CO2.length, 336);
  assert.equal(message.SCALE, 0);
});
