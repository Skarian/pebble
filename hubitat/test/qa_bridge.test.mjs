import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chooseDataSource, fakeRawDevices, liveSnapshot, snapshotMessages} from '../qa/qa-bridge.mjs';

test('fake data is always the default and snapshots are terminally framed', () => {
  assert.equal(chooseDataSource({}), 'fake');
  const messages = snapshotMessages(fakeRawDevices, {requestId: 7, fetchedAt: 10});
  assert.equal(messages[0].COMMAND, 3);
  assert.equal(messages.at(-1).COMMAND, 5);
  assert.ok(messages.slice(1, -1).every((message) => message.REQUEST_ID === 7));
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
