import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const watch = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../src/pkjs/index.js', import.meta.url), 'utf8');
const dev = readFileSync(new URL('../scripts/dev-emulator.mjs', import.meta.url), 'utf8');

test('launch refreshes only when yesterday is not already cached', () => {
  assert.match(watch, /bool refresh_on_launch = automatic_launch \|\| !cache_has_yesterday\(\);/);
  assert.match(watch, /else if \(refresh_on_launch\) request_scores\(false\);/);
  assert.match(watch, /s_cache\.dates\[0\] == packed_yesterday\(\)/);
  assert.match(watch, /s_cache\.scores\[0\] <= 100/);
});

test('manual refresh remains blocking and explicit', () => {
  assert.match(watch, /if \(!s_loading\) request_scores\(false\);/);
  const tick = watch.slice(watch.indexOf('static void tick_handler'), watch.indexOf('static void init'));
  assert.doesNotMatch(tick.slice(0, tick.indexOf('static void wakeup_handler')), /request_scores/);
});

test('an active refresh keeps one stable syncing screen', () => {
  assert.match(watch, /if \(s_loading\) \{\s*render_state\("SYNCING\.\.\."/);
  assert.doesNotMatch(watch, /LOAD_PHASE_|CONNECTING\.\.\.|RETRYING\.\.\./);
});

test('automatic checks run every two hours from 10 AM and only reveal a newer record', () => {
  assert.match(watch, /#define WAKEUP_START_HOUR 10/);
  assert.match(watch, /#define WAKEUP_LAST_HOUR 22/);
  assert.match(watch, /#define WAKEUP_INTERVAL_HOURS 2/);
  assert.match(watch, /launch_reason\(\) == APP_LAUNCH_WAKEUP/);
  assert.match(watch, /schedule_next_wakeup\(false\);[\s\S]*start_automatic_check\(\);/);
  assert.match(watch, /schedule_next_wakeup\(true\);[\s\S]*s_selected_day = 0/);
  assert.match(watch, /if \(!automatic && s_window_visible\) render\(\);/);
  assert.match(watch, /latest_available_date\(&s_cache\) > previous_latest_date/);
  assert.match(watch, /finish_automatic_check\(received_records && has_new_record, result_status\)/);
  assert.match(watch, /if \(!s_window_visible\) \{[\s\S]*window_stack_pop_all\(false\);/);
  assert.match(watch, /if \(!s_window_visible\) \{[\s\S]*window_stack_push\(s_window, true\);/);
});

test('phone sends only the final ResMed result and dev does not wait for a request', () => {
  assert.doesNotMatch(phone, /SCORES_KEY|sendCached/);
  assert.match(phone, /function readyMessage\(\)[\s\S]*ERROR_ENABLED: errorReporter\.readyValue\(\)/);
  assert.match(phone, /readyMessage: readyMessage/);
  assert.doesNotMatch(phone, /handleWatchMessage|sendOnceIfIdle/);
  assert.match(phone, /appMessages\.open\(\)/);
  assert.doesNotMatch(phone, /Pebble\.sendAppMessage|Pebble\.addEventListener\('ready'|Pebble\.addEventListener\('appmessage'/);
  assert.doesNotMatch(dev, /scoresReady/);
});

test('physical-watch settings and refresh use direct ResMed, not a production bridge', () => {
  assert.match(phone, /require\('\.\.\/common\/resmed_client'\)/);
  assert.match(phone, /resMed\.fetchSleepRecords/);
  assert.doesNotMatch(phone, /Bridge URL|Bridge setup token|\/v1\/login|\/v1\/scores/);
  const saveAccount = phone.slice(phone.indexOf('function saveAccount'),
    phone.indexOf('appMessages.open();'));
  assert.doesNotMatch(saveAccount, /fetchSleepRecords|handleRead/);
});
