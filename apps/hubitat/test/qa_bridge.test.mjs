import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  chooseDataSource, commandResult, fakeRawDevices, liveSnapshot,
  snapshotMessages, statusMessage,
} from '../qa/qa-bridge.mjs';

test('fake data is always the default and snapshots are terminally framed', () => {
  assert.equal(chooseDataSource({}), 'fake');
  const messages = snapshotMessages(fakeRawDevices, {requestId: 7, fetchedAt: 10});
  assert.equal(messages[0].COMMAND, 3);
  assert.equal(messages.at(-1).COMMAND, 5);
  assert.ok(messages.slice(1, -1).every((message) => message.REQUEST_ID === 7));
  assert.throws(() => snapshotMessages(fakeRawDevices), /nonzero uint16/);
  assert.throws(() => statusMessage(2, 'bad', 0), /nonzero uint16/);
  assert.throws(() => commandResult(9, 'bad', 65536), /nonzero uint16/);
});

test('snapshots cap oversized Maker API responses at 32 and mark them partial', () => {
  const devices = Array.from({length: 40}, (_, index) => ({
    id: String(index), label: `Device ${index}`, attributes: {switch: 'off'}
  }));
  const messages = snapshotMessages(devices, {requestId: 9, fetchedAt: 10});
  assert.equal(messages[0].COUNT, 32);
  const deviceMessages = messages.filter((message) => message.COMMAND === 4);
  assert.equal(deviceMessages.length, 32);
  assert.deepEqual(deviceMessages.map((message) => message.DEVICE_INDEX),
    Array.from({length: 32}, (_, index) => index));
  assert.deepEqual(messages.at(-1), {
    PROTOCOL: 1, COMMAND: 5, REQUEST_ID: 9, STATUS: 7, PARTIAL: 1
  });
});

test('live QA requires explicit credentials', () => {
  assert.throws(() => chooseDataSource({HUBITAT_QA_SOURCE: 'live'}), /requires/);
  assert.equal(chooseDataSource({HUBITAT_QA_SOURCE: 'live', HUBITAT_MAKER_BASE_URL: 'http://hub',
    HUBITAT_MAKER_ACCESS_TOKEN: 'token'}), 'live');
});

test('live QA performs one request then reuses owner-only cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hubitat-live-test-'));
  const cachePath = join(directory, 'cache.json');
  let calls = 0;
  const env = {HUBITAT_MAKER_BASE_URL: 'http://hub/apps/api/1', HUBITAT_MAKER_ACCESS_TOKEN: 'token',
    HUBITAT_DEVICE_IDS: '101,103'};
  const fetchImpl = async () => { calls += 1; return {ok: true, json: async () => fakeRawDevices}; };
  const first = await liveSnapshot({env, cachePath, fetchImpl});
  const second = await liveSnapshot({env, cachePath, fetchImpl});
  assert.equal(first.upstreamRequests, 1);
  assert.equal(second.upstreamRequests, 0);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).devices.length, 2);
});
