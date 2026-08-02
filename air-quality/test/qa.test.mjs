import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSource, parseEnv} from '../scripts/qa.mjs';

test('fake data is default and live needs all Aranet fields', () => {
  assert.equal(chooseSource({}), 'fake');
  assert.equal(chooseSource({AIRQUALITY_QA_SOURCE: 'fake', ARANET_API_KEY: 'x'}), 'fake');
  assert.equal(chooseSource({ARANET_API_KEY: 'x', ARANET_SENSOR_ID: 'y', ARANET_LOCATION: 'Office'}), 'live');
  assert.throws(() => chooseSource({AIRQUALITY_QA_SOURCE: 'live'}), /all three/);
});

test('dotenv parser does not expose values in output', () => {
  assert.deepEqual(parseEnv('ARANET_SENSOR_ID="123"\nARANET_LOCATION=Office'), {ARANET_SENSOR_ID: '123', ARANET_LOCATION: 'Office'});
});
