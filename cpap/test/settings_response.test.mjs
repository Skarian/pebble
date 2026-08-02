import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const decode = require('../src/common/settings_response.js');

test('accepts the already-decoded response from the current Pebble mobile app', () => {
  assert.deepEqual(decode('{"email":"me@example.com","password":"50%better#now"}'), {
    email: 'me@example.com', password: '50%better#now'
  });
});

test('also accepts legacy encoded and hash-prefixed settings responses', () => {
  const value = {email: 'me@example.com', password: 'secret'};
  const encoded = encodeURIComponent(JSON.stringify(value));
  assert.deepEqual(decode(encoded), value);
  assert.deepEqual(decode('pebblejs://close#' + encoded), value);
});

test('rejects empty and malformed responses', () => {
  assert.equal(decode(''), null);
  assert.equal(decode('%not-valid-json'), null);
});
