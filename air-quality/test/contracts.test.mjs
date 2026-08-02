import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const watch = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../src/pkjs/index.js', import.meta.url), 'utf8');
const qa = readFileSync(new URL('../scripts/qa.mjs', import.meta.url), 'utf8');

test('watch keeps a versioned last-good cache and rejects stale request IDs', () => {
  assert.match(watch, /CACHE_VERSION 1/);
  assert.match(watch, /PERSIST_KEY_CACHE 4101/);
  assert.match(watch, /request->value->uint16 != s_request_id/);
  assert.match(watch, /persist_write_data\(PERSIST_KEY_CACHE/);
});

test('navigation is bounded and manual refresh blocks duplicates', () => {
  assert.match(watch, /if \(s_loading\) return/);
  assert.match(watch, /if \(s_page > 0\)/);
  assert.match(watch, /s_page \+ 1 < PAGE_COUNT/);
  assert.match(watch, /RESPONSE_TIMEOUT_MS 30000/);
});

test('phone-ready handshake retries launch delivery and outbox failures surface', () => {
  assert.match(watch, /COMMAND_PHONE_READY[\s\S]*if \(s_loading\)[\s\S]*request_refresh\(\)/);
  assert.match(watch, /dict_write_uint8\(iter, MESSAGE_KEY_PROTOCOL, 1\)/);
  assert.match(watch, /app_message_register_outbox_failed\(outbox_failed\)/);
});

test('typography follows CPAP large system-font hierarchy', () => {
  assert.match(watch, /FONT_KEY_BITHAM_42_BOLD/);
  assert.match(watch, /METRIC_NAMES\[metric\], fonts_get_system_font\(FONT_KEY_GOTHIC_24_BOLD\)/);
  assert.match(watch, /title, fonts_get_system_font\(FONT_KEY_GOTHIC_28_BOLD\)/);
  assert.match(watch, /body, fonts_get_system_font\(FONT_KEY_GOTHIC_18_BOLD\)/);
  assert.match(watch, /footer, fonts_get_system_font\(FONT_KEY_GOTHIC_18_BOLD\)/);
});

test('headers and update footer follow the plain CPAP layout', () => {
  assert.match(watch, /draw_header\(ctx, bounds, s_cache\.location, "AQI"\)/);
  assert.match(watch, /draw_header\(ctx, bounds, s_cache\.location, title\)/);
  assert.doesNotMatch(watch, /graphics_fill_rect\(ctx, GRect\(0, 0, bounds\.size\.w, 30\)/);
  assert.doesNotMatch(watch, /bounds\.size\.h - 19/);
  assert.doesNotMatch(watch, /Partial - %s/);
  assert.match(watch, /Updated just now/);
  assert.match(watch, /Updated %lum ago/);
  assert.match(watch, /Updated %lud ago/);
});

test('current AQI uses one label and native watch-safe faces', () => {
  assert.match(watch, /draw_header\(ctx, bounds, s_cache\.location, "AQI"\)/);
  assert.match(watch, /draw_face\(ctx, s_cache\.current\[0\]\)/);
  assert.match(watch, /aqi <= 50/);
  assert.match(watch, /aqi == UNAVAILABLE \|\| aqi <= 150/);
  assert.doesNotMatch(watch, /"HEALTHY"|"MODERATE"|"ELEVATED"|"UNHEALTHY"|"HAZARDOUS"/);
  assert.doesNotMatch(watch, /draw_text\(ctx, "AQI"/);
});

test('secrets remain phone-only and production has no QA or loopback route', () => {
  assert.match(phone, /airquality\.settings\.v1/);
  assert.match(phone, /API key stays on your phone/);
  assert.doesNotMatch(watch, /ARANET_API_KEY|sharingId|127\.0\.0\.1|QA_/);
  assert.doesNotMatch(phone, /127\.0\.0\.1|qa-results|fake/i);
  assert.match(phone, /readJson\(DIAGNOSTICS_KEY, \[\]\)\.forEach/);
});

test('QA uses the shared lock, isolated flash, and no global emulator kill', () => {
  assert.match(qa, /pebble-emulator-qa\.lock/);
  assert.match(qa, /airquality-qa-backup/);
  assert.doesNotMatch(qa, /pebble', \['kill/);
  assert.match(qa, /all-states\.png/);
  assert.match(qa, /-background', '#0d100e'/);
  assert.match(qa, /-set', 'label'/);
});
