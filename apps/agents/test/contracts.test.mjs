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

test('screen changes wake the backlight and final text is clipped above reply footer', () => {
  assert.match(source, /static void render\(void\)[\s\S]*light_enable_interaction\(\)/);
  assert.match(source, /viewport_height = has_footer \? 170 : 198/);
  assert.match(source, /GRect\(7, 204, 186, 22\)/);
  assert.match(source, /s_message_layer = make_text[\s\S]*FONT_KEY_GOTHIC_28/);
});

test('successful phone delivery advances sending to working before agent events arrive', () => {
  assert.match(source, /static void outbox_sent[\s\S]*kind != COMMAND_SEND[\s\S]*s_turn_phase = TURN_WORKING/);
  assert.match(source, /if \(s_screen == SCREEN_SENDING\) s_screen = SCREEN_STREAMING/);
  assert.match(source, /app_message_register_outbox_sent\(outbox_sent\)/);
});

test('long select requests companion-owned history from its individual agent screen', () => {
  assert.match(source, /s_screen == SCREEN_BROWSE && s_page_index > 0[\s\S]*open_history\(\)/);
  assert.match(source, /COMMAND_HISTORY = 4/);
  assert.match(source, /dict_write_uint8\(out, MESSAGE_KEY_KIND, COMMAND_HISTORY\)/);
  assert.match(source, /dict_write_cstring\(out, MESSAGE_KEY_AGENT_ID, s_history_agent_id\)/);
  assert.match(source, /EVENT_HISTORY_ITEM = 17/);
  assert.match(source, /EVENT_HISTORY_END = 18/);
  assert.match(source, /s_history_count == 0[\s\S]*render_state\("NO MESSAGES"/);
  assert.doesNotMatch(source, /append_history\(s_transcript/);
  assert.doesNotMatch(source, /kind == EVENT_COMMENTARY\) \{\s*append_history/);
});

test('history rows open into a scrollable full-message reader and return to the list', () => {
  assert.match(source, /SCREEN_HISTORY_MESSAGE/);
  assert.match(source, /static void open_history_message[\s\S]*s_message_scroll = 0[\s\S]*SCREEN_HISTORY_MESSAGE/);
  assert.match(source, /s_screen == SCREEN_HISTORY_MESSAGE[\s\S]*scroll_message\(-SCROLL_STEP\)/);
  assert.match(source, /s_screen == SCREEN_HISTORY[\s\S]*open_history_message\(\)/);
  assert.match(source, /if \(s_screen == SCREEN_HISTORY_MESSAGE\)[\s\S]*s_screen = SCREEN_HISTORY/);
});
