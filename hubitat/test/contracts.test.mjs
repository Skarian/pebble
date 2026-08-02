import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const watch = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../src/pkjs/index.js', import.meta.url), 'utf8');
const qa = readFileSync(new URL('../scripts/qa-screenshots.mjs', import.meta.url), 'utf8');

test('watch keeps a bounded persistent last-good virtual list with stale response rejection', () => {
  assert.match(watch, /MAX_DEVICES 6/);
  assert.match(watch, /persist_write_data\(PERSIST_HEADER_KEY/);
  assert.match(watch, /response_id->value->uint16 != s_request_id/);
  assert.match(watch, /s_page_index \+ 1 < page_count\(\)/);
  assert.match(watch, /RESPONSE_TIMEOUT_MS 30000/);
  assert.match(watch, /if \(!s_has_cache\) request_refresh\(\)/);
});

test('phone owns secrets and permits only selected-device control actions', () => {
  assert.match(phone, /localStorage\.setItem\(SETTINGS_KEY/);
  assert.match(phone, /Device is not selected/);
  assert.doesNotMatch(watch, /access_token|baseUrl|token/);
});

test('QA owns the shared emulator lock and never issues global emulator kills', () => {
  assert.match(qa, /\/private\/tmp\/pebble-emulator-qa\.lock/);
  assert.match(qa, /HUBITAT_QA_PORT \|\| 8896/);
  assert.doesNotMatch(qa, /pebble[^\n]*kill|stopEmulators/);
});
