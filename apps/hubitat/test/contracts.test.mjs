import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const watch = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../src/pkjs/index.js', import.meta.url), 'utf8');
const qa = readFileSync(new URL('../scripts/qa-screenshots.mjs', import.meta.url), 'utf8');
const build = readFileSync(new URL('../wscript', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('app packages a dedicated one-bit menu icon', () => {
  assert.deepEqual(pkg.pebble.resources.media, [{
    type: 'bitmap',
    name: 'IMAGE_MENU_ICON',
    file: 'images/menu_icon.png',
    menuIcon: true,
    memoryFormat: '1Bit'
  }]);
});

test('watch keeps the bounded last-good list behind the shared transport', () => {
  assert.match(watch, /MAX_DEVICES 32/);
  assert.match(watch, /persist_write_data\(PERSIST_HEADER_KEY/);
  assert.match(watch, /AppMessageClient \*s_phone/);
  assert.match(watch, /AppMessageResponseAction receive_response/);
  assert.match(watch, /s_staging_received != expected/);
  assert.match(watch, /memcmp\(&s_staging\[index\], &candidate/);
  assert.match(watch, /s_page_index \+ 1 < page_count\(\)/);
  assert.match(watch, /return 1 \+ s_header\.count/);
  assert.doesNotMatch(watch, /PAGE_DETAIL|PAGE_CONTROL|control_page_for|status_page_for/);
  assert.match(watch, /window_stack_push\(s_window, true\);/);
  assert.match(watch, /if \(open_result == APP_MSG_OK\) request_refresh\(\);/);
  assert.match(watch, /if \(s_page_index == 0\) \{ request_refresh\(\); return; \}/);
  assert.doesNotMatch(watch, /tick_timer_service_subscribe|STALE/);
  assert.match(watch, /set_text\("HOME", "DEVICES", primary, secondary, meta, "UPDATED NOW"\)/);
  assert.match(watch, /s_page_index = device_page_for\(s_command_device_index\)/);
  assert.match(watch, /status == STATUS_COMMAND_PENDING[\s\S]+APP_MESSAGE_RESPONSE_MORE/);
  assert.match(watch, /SELECT: TURN OFF/);
  assert.match(watch, /KIND_LOCK && !s_confirming/);
  assert.match(watch, /primary\[0\] = secondary\[0\] = meta\[0\] = footer\[0\] = '\\0'/);
  assert.match(watch, /configure_data_layout\(has_battery, false, true\)/);
  assert.doesNotMatch(watch, /BATTERY --/);
});

test('phone owns secrets and permits controls only after an authorized refresh', () => {
  assert.match(phone, /writeJson\(SETTINGS_KEY/);
  assert.match(phone, /writeJson\(AUTHORIZED_IDS_KEY/);
  assert.match(phone, /readAuthorizedIds\(\)\.indexOf\(deviceId\) === -1/);
  assert.match(phone, /Refresh devices first/);
  assert.doesNotMatch(watch, /access_token|baseUrl|token/);
  assert.match(phone, /After saving, press Select on the watch to sync/);
  assert.doesNotMatch(phone, /Save and refresh/);
  assert.match(phone, /<label for="token">Access token<\/label>/);
  assert.doesNotMatch(phone, /<label for="url">|<label for="ids">/);
  assert.match(phone, /Model\.normalizeDevices\(response, \[\]\)/);
  assert.match(phone, /session\.handleRead\(requestId, 'refresh'/);
  assert.match(phone, /session\.handleRead\(requestId, 'control'/);
});

test('Hubitat uses the shared opt-in reporter on both phone and watch', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(pkg.pebble.messageKeys)
    .filter(([, value]) => value >= 120 && value <= 126)), {
    ERROR_COMMAND: 120, ERROR_GENERATION: 121, ERROR_SEQUENCE: 122,
    ERROR_AT: 123, ERROR_DATA: 124, ERROR_DROPPED: 125, ERROR_ENABLED: 126,
  });
  assert.match(build, /shared\/appmessage\/watch/);
  assert.match(build, /shared\/errors\/watch/);
  assert.match(build, /shared\/appmessage\/pkjs/);
  assert.match(build, /shared\/errors\/pkjs/);
  assert.match(watch, /PERSIST_ERRORS_KEY 7400/);
  assert.match(watch, /ERROR_STORAGE_BYTES 1024/);
  assert.match(watch, /exceed Pebble persistent storage/);
  assert.match(phone, /source: 'hubitat\/pkjs@0\.1\.0'/);
  assert.match(phone, /watchSource: 'hubitat\/watch@0\.1\.0'/);
  assert.match(phone, /ERROR_ENABLED: errorReporter\.readyValue\(\)/);
  assert.doesNotMatch(phone, /require\(['"]\.\.\/common\/diagnostics|HUBITAT_DIAGNOSTIC|diagnostics\.(record|report|replay)/i);
  assert.match(phone, /removeItem\(LEGACY_DIAGNOSTICS_KEY\)/);
});

test('QA owns the shared emulator lock and never issues global emulator kills', () => {
  assert.match(qa, /\/private\/tmp\/pebble-emulator-qa\.lock/);
  assert.match(qa, /HUBITAT_QA_PORT \|\| 8896/);
  assert.doesNotMatch(qa, /pebble[^\n]*kill|stopEmulators/);
  assert.match(qa, /old timestamp must render exactly like the normal overview/i);
  assert.doesNotMatch(qa, /STALE LAST-GOOD DATA/);
  assert.doesNotMatch(qa, /SWITCH CONTROL|DEVICE DETAIL|LOCK CONTROL/);
});
