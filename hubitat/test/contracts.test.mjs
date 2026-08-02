import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const watch = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../src/pkjs/index.js', import.meta.url), 'utf8');
const qa = readFileSync(new URL('../scripts/qa-screenshots.mjs', import.meta.url), 'utf8');

test('watch keeps a bounded persistent last-good virtual list with stale response rejection', () => {
  assert.match(watch, /MAX_DEVICES 32/);
  assert.match(watch, /persist_write_data\(PERSIST_HEADER_KEY/);
  assert.match(watch, /response_id->value->uint16 != s_request_id/);
  assert.match(watch, /s_page_index \+ 1 < page_count\(\)/);
  assert.match(watch, /return 1 \+ s_header\.count/);
  assert.doesNotMatch(watch, /PAGE_DETAIL|PAGE_CONTROL|control_page_for|status_page_for/);
  assert.match(watch, /RESPONSE_TIMEOUT_MS 30000/);
  assert.match(watch, /if \(!s_has_cache\) request_refresh\(\)/);
  assert.match(watch, /if \(s_page_index == 0\) \{ request_refresh\(\); return; \}/);
  assert.doesNotMatch(watch, /tick_timer_service_subscribe|STALE/);
  assert.match(watch, /set_text\("HOME", "DEVICES", primary, secondary, meta, "UPDATED NOW"\)/);
  assert.match(watch, /s_page_index = device_page_for\(s_command_device_index\)/);
  assert.match(watch, /persist_cache\(\);\n      s_status = STATUS_OK/);
  assert.match(watch, /SELECT: TURN OFF/);
  assert.match(watch, /KIND_LOCK && !s_confirming/);
});

test('phone owns the one secret and permits controls only after an authorized refresh', () => {
  assert.match(phone, /localStorage\.setItem\(SETTINGS_KEY/);
  assert.match(phone, /localStorage\.setItem\(AUTHORIZED_IDS_KEY/);
  assert.match(phone, /readAuthorizedIds\(\)\.indexOf\(deviceId\) === -1/);
  assert.match(phone, /Refresh devices first/);
  assert.doesNotMatch(watch, /access_token|baseUrl|token/);
  assert.match(phone, /After saving, press Select on the watch to sync/);
  assert.doesNotMatch(phone, /Save and refresh|localStorage\.setItem\(SETTINGS_KEY[^}]+refresh\(1\)/s);
  assert.match(phone, /<label for="token">Access token<\/label>/);
  assert.doesNotMatch(phone, /<label for="url">|<label for="ids">/);
  assert.match(phone, /Model\.normalizeDevices\(response, \[\]\)/);
});

test('QA owns the shared emulator lock and never issues global emulator kills', () => {
  assert.match(qa, /\/private\/tmp\/pebble-emulator-qa\.lock/);
  assert.match(qa, /HUBITAT_QA_PORT \|\| 8896/);
  assert.doesNotMatch(qa, /pebble[^\n]*kill|stopEmulators/);
  assert.match(qa, /old timestamp must render exactly like the normal overview/i);
  assert.doesNotMatch(qa, /STALE LAST-GOOD DATA/);
  assert.doesNotMatch(qa, /SWITCH CONTROL|DEVICE DETAIL|LOCK CONTROL/);
});
