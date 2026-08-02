import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseDataSource, parseEnv} from '../scripts/qa-screenshots.mjs';

test('parses the small dotenv subset used by CPAP QA', () => {
  assert.deepEqual(parseEnv(`
# comment
MYAIR_USERNAME="person@example.com"
export MYAIR_PASSWORD='secret value'
`), {
    MYAIR_USERNAME: 'person@example.com',
    MYAIR_PASSWORD: 'secret value'
  });
});

test('uses fake data when credentials are absent or placeholders', () => {
  assert.equal(chooseDataSource({}), 'fake');
  assert.equal(chooseDataSource({
    MYAIR_USERNAME: 'you@example.com',
    MYAIR_PASSWORD: 'your-password'
  }), 'fake');
});

test('uses live data only when both credentials are populated', () => {
  assert.equal(chooseDataSource({MYAIR_USERNAME: 'person@example.com', MYAIR_PASSWORD: 'secret'}),
    'live');
  assert.throws(() => chooseDataSource({MYAIR_USERNAME: 'person@example.com'}), /both/);
});

test('supports an explicit fake override without accepting unknown modes', () => {
  assert.equal(chooseDataSource({
    CPAP_QA_SOURCE: 'fake',
    MYAIR_USERNAME: 'person@example.com',
    MYAIR_PASSWORD: 'secret'
  }), 'fake');
  assert.throws(() => chooseDataSource({CPAP_QA_SOURCE: 'maybe'}), /fake or live/);
});
