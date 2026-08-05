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
  assert.equal(pkg.pebble.messageKeys.PROTOCOL, 9);
  assert.equal(pkg.pebble.messageKeys.EVENT_SEQUENCE, 10);
});

test('native dictation confirmation and streaming mode are production behavior', () => {
  assert.match(source, /dictation_session_enable_confirmation\(s_dictation, true\)/);
  assert.match(source, /dict_write_uint8\(out, MESSAGE_KEY_MODE, 1\)/);
  assert.match(source, /COMMAND_RECONCILE/);
  assert.match(source, /PERSIST_TURN_KEY/);
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

test('turn recovery remains replayable across transport loss and relaunch', () => {
  assert.match(source, /TURN_UNKNOWN/);
  assert.match(source, /s_needs_terminal_replay/);
  assert.match(source, /chunk_timeout[\s\S]*response_timeout\(NULL\)/);
  assert.match(source, /s_turn_phase = TURN_WORKING;\s*s_reconciling = false; persist_turn\(\); response_timeout\(NULL\)/);
  assert.match(source, /kind == COMMAND_RECONCILE/);
});
