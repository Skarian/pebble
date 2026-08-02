import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

const watch = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const wscript = readFileSync(new URL('../wscript', import.meta.url), 'utf8');
const companion = readFileSync(new URL('../../../companion_apps/air-quality-android/app/src/main/java/com/skarian/airquality/AirQualityPebbleService.kt', import.meta.url), 'utf8');
const scanner = readFileSync(new URL('../../../companion_apps/air-quality-android/app/src/main/java/com/skarian/airquality/AranetScanner.kt', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../../../companion_apps/air-quality-android/app/src/main/java/com/skarian/airquality/PebbleProtocol.kt', import.meta.url), 'utf8');
const qa = readFileSync(new URL('../scripts/qa.mjs', import.meta.url), 'utf8');

test('app packages a dedicated one-bit menu icon', () => {
  assert.deepEqual(packageJson.pebble.resources.media, [{
    type: 'bitmap',
    name: 'IMAGE_MENU_ICON',
    file: 'images/menu_icon.png',
    menuIcon: true,
    memoryFormat: '1Bit'
  }]);
  assert.equal(existsSync(new URL('../resources/images/menu_icon.png', import.meta.url)), true);
});

test('watch keeps a new versioned last-good cache and rejects stale responses', () => {
  assert.match(watch, /CACHE_VERSION 5/);
  assert.match(watch, /PROTOCOL_VERSION 2/);
  assert.match(watch, /PERSIST_KEY_CACHE 4102/);
  assert.match(watch, /!request \|\| request->value->uint16 != s_request_id/);
  assert.match(watch, /observed->value->uint32 < s_cache\.observed_at/);
  assert.match(watch, /persist_write_data\(PERSIST_KEY_CACHE/);
});

test('navigation is one bounded current page plus four charts', () => {
  assert.match(watch, /PAGE_COUNT 5/);
  assert.match(watch, /if \(s_loading \|\| s_scale_loading\) return/);
  assert.match(watch, /if \(s_page > 0\)/);
  assert.match(watch, /s_page \+ 1 < PAGE_COUNT/);
  assert.deepEqual(packageJson.pebble.messageKeys.CO2, 10);
  assert.deepEqual(packageJson.pebble.messageKeys.SCALE, 14);
  assert.deepEqual(packageJson.pebble.messageKeys.SERIES_CO2, 60);
  assert.deepEqual(packageJson.pebble.messageKeys.AVG_PRESSURE_X10, 67);
});

test('production routes through Android companion and bundles no PebbleKit JS', () => {
  assert.equal(packageJson.pebble.companionApp.android.apps[0].package, 'com.skarian.airquality');
  assert.doesNotMatch(wscript, /js_entry_file|src\/pkjs/);
  assert.equal(existsSync(new URL('../src/pkjs/index.js', import.meta.url)), false);
  assert.match(companion, /BasePebbleListenerService/);
  assert.match(companion, /latestRequest\.get\(\) != requestId/);
  assert.match(companion, /PROTOCOL_VERSION/);
  assert.match(companion, /DefaultPebbleSender/);
});

test('Aranet4 metrics and services replace all cloud AQI assumptions', () => {
  assert.match(scanner, /MANUFACTURER_ID/);
  assert.match(protocol, /PRESSURE_X10 = 13/);
  assert.match(watch, /\{"CO2", "TEMP", "RH", "PRESSURE"\}/);
  assert.match(watch, /\{"CO2", "TEMP", "HUMIDITY", "PRESSURE"\}/);
  assert.match(watch, /strcmp\(right, "PRESSURE"\) == 0/);
  assert.match(watch, /metric == 3 \? 104 : 78/);
  assert.doesNotMatch(watch + companion + protocol, /AQI|PM2\.5|apiCredential|ApiKey|aranet\.cloud/i);
});

test('typography and plain headers keep the CPAP hierarchy', () => {
  assert.match(watch, /FONT_KEY_BITHAM_42_BOLD/);
  assert.match(watch, /FONT_KEY_GOTHIC_24_BOLD/);
  assert.match(watch, /FONT_KEY_GOTHIC_28_BOLD/);
  assert.match(watch, /footer, fonts_get_system_font\(FONT_KEY_GOTHIC_18\)/);
  assert.match(watch, /draw_header\(ctx, bounds, s_cache\.location, "CO2"\)/);
  assert.doesNotMatch(watch, /graphics_fill_rect\(ctx, GRect\(0, 0, bounds\.size\.w, 30\)/);
});

test('current refresh blocks while chart scale changes stay nonblocking', () => {
  assert.match(watch, /if \(s_loading\) draw_state/);
  assert.match(watch, /s_pending_scale = \(s_scale \+ 1\) % SCALE_COUNT/);
  assert.match(watch, /request_data\(COMMAND_SCALE\)/);
  assert.match(watch, /if \(command == COMMAND_SCALE\) s_scale_loading = true/);
  assert.doesNotMatch(watch, /if \(s_scale_loading\) draw_state/);
  assert.match(companion, /command == PebbleProtocol\.COMMAND_FETCH/);
  assert.match(companion, /if \(refreshSensor\)/);
  assert.match(watch, /SCALE_NAMES\[\] = \{"1 HOUR", "1 DAY", "1 WEEK"\}/);
  assert.match(watch, /AXIS_LEFT\[\] = \{"-1 HR", "-1 DAY", "-1 WEEK"\}/);
  assert.match(watch, /AXIS_MIDDLE\[\] = \{"-30 MIN", "-12 HR", "-3 DAYS"\}/);
  assert.match(watch, /draw_text\(ctx, "LAST"/);
  assert.doesNotMatch(watch, /if \(s_scale == SCALE_WEEK\)/);
  assert.match(watch, /GRAPH_COLUMNS 56/);
  assert.match(watch, /AXIS_LEVELS 5/);
  assert.match(watch, /const int left = 36, right = bounds\.size\.w - 2, top = 66, bottom = 174/);
  assert.match(watch, /level \* \(bottom - top\)\) \/ \(AXIS_LEVELS - 1\)/);
  assert.match(watch, /axis_font = fonts_get_system_font\(FONT_KEY_GOTHIC_18_BOLD\)/);
  assert.match(watch, /GRect\(0, y - 10, 36, 22\)/);
  assert.match(watch, /GColorLightGray/);
  assert.match(watch, /graph_display_value\(metric, value\)/);
  assert.match(watch, /int16_t value = s_cache\.series/);
  assert.match(watch, /series->length != GRAPH_COLUMNS \* 2/);
  assert.doesNotMatch(watch, /connect_gap|previous_column/);
  assert.doesNotMatch(watch, /graphics_fill_circle\(ctx, point/);
  assert.doesNotMatch(watch, /high_y|low_y|last_y/);
  assert.match(watch, /left \+ \(4 \* \(right - left\)\) \/ 7/);
  assert.match(watch, /graphics_draw_line\(ctx, previous, point\)/);
  assert.match(watch, /!connects_next/);
  assert.match(watch, /GPoint\(tick_left, point\.y\), GPoint\(tick_right, point\.y\)/);
  assert.match(watch, /snprintf\(stat, sizeof\(stat\), "AVG %s", avg\)/);
  assert.match(watch, /GRect\(8, 198, bounds\.size\.w - 16, 28\)/);
  const chartSource = watch.slice(watch.indexOf('static void draw_chart'),
    watch.indexOf('static void canvas_update'));
  const currentSource = watch.slice(watch.indexOf('static void draw_current'),
    watch.indexOf('static int32_t graph_display_value'));
  assert.doesNotMatch(chartSource, /draw_footer/);
  assert.match(currentSource, /draw_footer\(ctx, bounds\)/);
});

test('current state uses the three Aranet display states and concise stale copy', () => {
  assert.match(watch, /if \(state == 1\)/);
  assert.match(watch, /if \(state == 3\)/);
  assert.match(watch, /Updated %lud ago/);
  assert.doesNotMatch(watch, /"PARTIAL|"STALE|medical|ventilat/i);
  for (const [label, value] of [['GOOD', 720], ['AVERAGE', 1180], ['UNHEALTHY', 1650]]) {
    assert.match(qa, new RegExp(`capture\\('${label}'.*snapshot\\(${value}`));
  }
});

test('QA owns fake states, shared lock, isolated flash, and no global emulator kill', () => {
  assert.match(qa, /pebble-emulator-qa\.lock/);
  assert.match(qa, /airquality-qa-backup/);
  assert.doesNotMatch(qa, /pebble', \['kill/);
  assert.match(qa, /all-states\.png/);
  assert.match(qa, /-background', '#0d100e'/);
  assert.match(qa, /COMPANION OFFLINE/);
  assert.match(qa, /BLUETOOTH OFF/);
  assert.match(qa, /PERMISSION NEEDED/);
});
