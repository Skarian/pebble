import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSource} from '../scripts/qa.mjs';

test('fake data is always the safe default', () => {
  assert.equal(chooseSource({}), 'fake');
  assert.equal(chooseSource({AIRQUALITY_QA_SOURCE: 'fake'}), 'fake');
  assert.equal(chooseSource({AIRQUALITY_QA_SOURCE: 'live'}), 'live');
  assert.throws(() => chooseSource({AIRQUALITY_QA_SOURCE: 'cloud'}), /fake or live/);
});
