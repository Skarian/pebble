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
  const captured = [];
  assert.equal(decode(''), null);
  assert.equal(decode('%not-valid-json', (error, whileDoing) =>
    captured.push({error, whileDoing})), null);
  assert.equal(captured[0].error.name, 'SettingsResponseError');
  assert.equal(captured[0].error.rawCause.name, 'SyntaxError');
  assert.match(captured[0].error.message, /URI malformed/);
});
