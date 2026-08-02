import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const Model = require('../src/common/hubitat_model.js');

test('normalizes representative Hubitat sensor and control data', () => {
  const values = Model.normalizeDevices([
    {id: '1', label: 'Motion', capabilities: ['MotionSensor'], attributes: {motion: 'active', battery: 77}},
    {id: '2', label: 'Lamp', capabilities: ['Switch'], attributes: {switch: 'off'}, commands: [{command: 'on'}, {command: 'off'}]},
    {id: '3', label: 'Lock', attributes: {lock: 'locked'}, commands: [{command: 'lock'}, {command: 'unlock'}]}
  ], ['1', '2', '3']);
  assert.deepEqual(values.map((value) => [value.kindName, value.primary, value.controlFlags]), [
    ['motion', 'active', 0], ['switch', 'off', 3], ['lock', 'locked', 12]
  ]);
  assert.equal(values[0].battery, 77);
  assert.equal(Model.actionFor(values[1]), 'on');
  assert.equal(Model.actionFor(values[2]), 'unlock');
});

test('selection is bounded and missing values remain explicit', () => {
  const devices = Array.from({length: 40}, (_, index) => ({id: String(index), label: `D${index}`, attributes: {}}));
  const values = Model.normalizeDevices(devices, []);
  assert.equal(values.length, 32);
  assert.equal(values.at(-1).id, '31');
  assert.equal(values[0].primary, 'no state');
  assert.equal(values[0].battery, 255);
  assert.ok(1 + Model.MAX_DEVICES < 256, 'one-page-per-device list must fit uint8 page indexes');
});

test('generic safety sensors prefer their useful state over battery telemetry', () => {
  const values = Model.normalizeDevices([
    {id: '3', label: 'Smoke', attributes: {battery: 100, smoke: 'clear', carbonMonoxide: 'clear'}},
    {id: '4', label: 'Moisture', attributes: {battery: 100, water: 'dry'}}
  ], []);
  assert.deepEqual(values.map((value) => [value.primary, value.battery]), [
    ['clear', 100], ['dry', 100]
  ]);
});
