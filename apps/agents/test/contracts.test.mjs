import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/c/main.c', import.meta.url), 'utf8');
const qa = readFileSync(new URL('../scripts/qa-screenshots.mjs', import.meta.url), 'utf8');

test('watchapp and companion contract are fixed', () => {
  assert.equal(pkg.pebble.uuid, 'bba3f38f-53e5-458b-9d5f-0bcdb68ffd47');
  assert.equal(pkg.pebble.companionApp.android.apps[0].package, 'com.skarian.agentscompanion');
  assert.deepEqual(pkg.pebble.targetPlatforms, ['emery']);
});

test('native dictation confirmation and streaming mode are production behavior', () => {
  assert.match(source, /dictation_session_enable_confirmation\(s_dictation, true\)/);
  assert.match(source, /dict_write_uint8\(out, MESSAGE_KEY_MODE, 1\)/);
  assert.doesNotMatch(source, /Check the deployment status/);
});

test('approved watch copy and shared working layout remain in source', () => {
  assert.match(source, /SAVED AGENTS/);
  assert.doesNotMatch(source, /CACHED ON PHONE|Phone delivery failed|DELIVERY UNKNOWN/);
  assert.match(source, /render_state\("WORKING\.\.\."/);
});

test('QA is deterministic, isolated, and phone independent', () => {
  assert.match(qa, /pebble-emulator-qa\.lock/);
  assert.match(qa, /isolateEmulatorState/);
  assert.match(qa, /VoiceHarness|voice:/);
  assert.match(qa, /marquee did not visibly advance/);
});
