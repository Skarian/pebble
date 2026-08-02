import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QaController} from './qa_controller.mjs';

test('QA control requires a long private token and validates scenarios', () => {
  assert.throws(() => new QaController({token: 'short'}), /at least 16/);
  const controller = new QaController({token: '0123456789abcdef'});
  assert.equal(controller.authorized('Bearer 0123456789abcdef'), true);
  assert.equal(controller.authorized('Bearer wrong'), false);
  assert.throws(() => controller.setScenario({id: 'x', type: 'records'}), /require records/);
});

test('live QA caches private data and never calls ResMed twice in one run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cpap-qa-controller-'));
  const cache = join(directory, 'live.json');
  let calls = 0;
  const controller = new QaController({
    token: '0123456789abcdef',
    credentials: {username: 'person@example.com', password: 'secret'},
    liveCachePath: cache,
    fetchRecords: async () => {
      calls += 1;
      return {records: [{startDate: '2026-08-01', sleepScore: 95}]};
    }
  });
  try {
    const first = await controller.liveRecords(false);
    const second = await controller.liveRecords(false);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    assert.equal(controller.status().liveApiCalls, 1);
    assert.equal(controller.status().liveCacheUsed, true);
    assert.equal((await readFile(cache, 'utf8')).includes('secret'), false);
    await assert.rejects(() => controller.liveRecords(true), /one API call per run/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
