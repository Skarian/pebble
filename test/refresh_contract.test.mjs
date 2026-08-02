import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const watch = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../src/pkjs/index.js', import.meta.url), 'utf8');
const dev = readFileSync(new URL('../scripts/dev-emulator.mjs', import.meta.url), 'utf8');

test('launch refreshes only when yesterday is not already cached', () => {
  assert.match(watch, /bool refresh_on_launch = !cache_has_yesterday\(\);/);
  assert.match(watch, /if \(refresh_on_launch\) request_scores\(\);/);
  assert.match(watch, /s_cache\.dates\[0\] == packed_yesterday\(\)/);
  assert.match(watch, /s_cache\.scores\[0\] <= 100/);
});

test('refresh is blocking, explicit, and has no half-hour poll', () => {
  assert.match(watch, /#define RESPONSE_TIMEOUT_MS 30000/);
  assert.match(watch, /if \(!s_loading\) request_scores\(\);/);
  const tick = watch.slice(watch.indexOf('static void tick_handler'), watch.indexOf('static void init'));
  assert.doesNotMatch(tick, /request_scores/);
});

test('phone sends only the final ResMed result and dev does not wait for a request', () => {
  assert.doesNotMatch(phone, /SCORES_KEY|sendCached/);
  assert.doesNotMatch(phone, /addEventListener\('ready'[\s\S]*fetchScores/);
  assert.doesNotMatch(dev, /scoresReady/);
});

test('physical-watch settings and refresh use direct ResMed, not a production bridge', () => {
  assert.match(phone, /require\('\.\.\/common\/resmed_client'\)/);
  assert.match(phone, /resMed\.fetchSleepRecords/);
  assert.doesNotMatch(phone, /Bridge URL|Bridge setup token|\/v1\/login|\/v1\/scores/);
  assert.match(phone, /Credentials stay in this app on your phone/);
  assert.match(phone, /sendStatus\(STATUS_SYNCING, lastRequestId\)/);
  assert.match(phone, /writeJson\(SETTINGS_KEY, candidate\)/);
});
