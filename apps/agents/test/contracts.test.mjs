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
  assert.match(qa, /runEmeryQa/);
  assert.doesNotMatch(qa, /pebble', \['kill/);
  assert.match(qa, /VoiceHarness|voice:/);
  assert.match(qa, /marquee did not visibly advance/);
});

test('turn recovery remains replayable across transport loss and relaunch', () => {
  assert.match(source, /TURN_UNKNOWN/);
  assert.match(source, /s_needs_terminal_replay/);
  assert.match(source, /chunk_timeout[\s\S]*start_turn_reconcile\(\)/);
  assert.match(source, /start_turn_reconcile[\s\S]*COMMAND_SEND, APP_MESSAGE_OPERATION_MUTATION,[\s\S]*s_request_id, APP_MESSAGE_SEND_RECONCILE/);
  assert.match(source, /s_turn_phase != TURN_IDLE && s_request_id\[0\][\s\S]*start_turn_reconcile\(\)/);
});

test('screen changes wake the backlight and final text is clipped above reply footer', () => {
  assert.match(source, /static void render\(void\)[\s\S]*light_enable_interaction\(\)/);
  assert.match(source, /viewport_height = has_footer \? 170 : 198/);
  assert.match(source, /GRect\(7, 204, 186, 22\)/);
  assert.match(source, /s_message_layer = make_text[\s\S]*FONT_KEY_GOTHIC_28/);
});

test('successful phone delivery advances sending to working before agent events arrive', () => {
  assert.match(source, /static void phone_state_changed[\s\S]*APP_MESSAGE_CLIENT_WAITING_RESPONSE[\s\S]*COMMAND_SEND[\s\S]*s_turn_phase = TURN_WORKING/);
  assert.match(source, /if \(s_screen == SCREEN_SENDING\) s_screen = SCREEN_STREAMING/);
});

test('accepted and commentary keep one mutation active until a terminal event', () => {
  const response = source.slice(source.indexOf('static AppMessageResponseAction receive_response'),
    source.indexOf('static void scroll_message'));
  assert.match(response, /kind == EVENT_ACCEPTED[\s\S]*APP_MESSAGE_RESPONSE_MORE/);
  assert.match(response, /complete && kind != EVENT_COMMENTARY[\s\S]*APP_MESSAGE_RESPONSE_DONE[\s\S]*APP_MESSAGE_RESPONSE_MORE/);
  assert.doesNotMatch(source, /s_response_timer|WORKING_TIMEOUT_MS/);
});

test('long select requests companion-owned history from its individual agent screen', () => {
  assert.match(source, /s_screen == SCREEN_BROWSE && s_page_index > 0[\s\S]*open_history\(\)/);
  assert.match(source, /COMMAND_HISTORY = 4/);
  assert.match(source, /static void open_history[\s\S]*COMMAND_HISTORY, APP_MESSAGE_OPERATION_READ,[\s\S]*s_history_request_id, APP_MESSAGE_SEND_PRIMARY/);
  assert.match(source, /request->operation == COMMAND_HISTORY[\s\S]*dict_write_cstring\(out, MESSAGE_KEY_AGENT_ID, s_history_agent_id\)/);
  assert.match(source, /request->operation == COMMAND_HISTORY[\s\S]*clear_history\(\)[\s\S]*clear_history_chunk_assembly\(\)/);
  assert.match(source, /sequence <= s_history\.last_sequence[\s\S]*return/);
  assert.match(source, /s_history_chunk_mask & bit[\s\S]*strcmp\(s_history_chunks\[index\], text\)/);
  assert.match(source, /s_history\.count == 0[\s\S]*render_state\("NO MESSAGES"/);
  assert.doesNotMatch(source, /append_history\(s_transcript/);
  assert.doesNotMatch(source, /kind == EVENT_COMMENTARY\) \{\s*append_history/);
});

test('Back from NOT SENT preserves a reachable same-ID retry', () => {
  assert.match(source, /static void view_active_turn[\s\S]*TURN_SENDING[\s\S]*app_message_client_is_active\(s_phone\)[\s\S]*ERROR_NOT_SENT/);
  assert.match(source, /static void send_transcript\(bool retry\)[\s\S]*if \(!retry\)[\s\S]*snprintf\(s_request_id[\s\S]*app_message_client_start\([\s\S]*s_request_id/);
  assert.match(source, /s_error == ERROR_NOT_SENT\) send_transcript\(true\)/);
});

test('turn-related delivery errors keep Messages reachable', () => {
  assert.match(source, /s_screen == SCREEN_ERROR[\s\S]*ERROR_NOT_SENT[\s\S]*ERROR_DELIVERY_UNKNOWN[\s\S]*ERROR_AGENT_FAILED[\s\S]*ERROR_STREAM_LOST[\s\S]*open_history\(\)/);
});

test('watch never logs the dictation transcript', () => {
  assert.doesNotMatch(source, /APP_LOG\([\s\S]{0,240}s_transcript/);
});

test('history rows open into a scrollable full-message reader and return to the list', () => {
  assert.match(source, /SCREEN_HISTORY_MESSAGE/);
  assert.match(source, /static void open_history_message[\s\S]*s_message_scroll = 0[\s\S]*SCREEN_HISTORY_MESSAGE/);
  assert.match(source, /s_screen == SCREEN_HISTORY_MESSAGE[\s\S]*scroll_message\(-SCROLL_STEP\)/);
  assert.match(source, /s_screen == SCREEN_HISTORY[\s\S]*open_history_message\(\)/);
  assert.match(source, /if \(s_screen == SCREEN_HISTORY_MESSAGE\)[\s\S]*s_screen = SCREEN_HISTORY/);
});
