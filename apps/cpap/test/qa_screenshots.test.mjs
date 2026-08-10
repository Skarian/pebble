import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chooseDataSource, parseEnv} from '../scripts/qa-screenshots.mjs';
import {runEmeryQa} from '../../../tools/pebble-emulator-qa.mjs';

test('parses the small dotenv subset used by CPAP QA', () => {
  assert.deepEqual(parseEnv(`
# comment
MYAIR_USERNAME="person@example.com"
export MYAIR_PASSWORD='secret value'
`), {
    MYAIR_USERNAME: 'person@example.com',
    MYAIR_PASSWORD: 'secret value'
  });
});

test('uses fake data by default even when credentials exist', () => {
  assert.equal(chooseDataSource({}), 'fake');
  assert.equal(chooseDataSource({
    MYAIR_USERNAME: 'person@example.com',
    MYAIR_PASSWORD: 'secret'
  }), 'fake');
});

test('uses live data only after an explicit opt-in with both credentials', () => {
  assert.equal(chooseDataSource({
    CPAP_QA_SOURCE: 'live',
    MYAIR_USERNAME: 'person@example.com',
    MYAIR_PASSWORD: 'secret'
  }), 'live');
  assert.throws(() => chooseDataSource({CPAP_QA_SOURCE: 'live'}), /requires/);
  assert.throws(() => chooseDataSource({
    CPAP_QA_SOURCE: 'live', MYAIR_USERNAME: 'person@example.com'
  }), /requires/);
});

test('supports an explicit fake override without accepting unknown modes', () => {
  assert.equal(chooseDataSource({
    CPAP_QA_SOURCE: 'fake',
    MYAIR_USERNAME: 'person@example.com',
    MYAIR_PASSWORD: 'secret'
  }), 'fake');
  assert.throws(() => chooseDataSource({CPAP_QA_SOURCE: 'maybe'}), /fake or live/);
});

test('shared Emery runner closes its session and restores state before releasing the lock', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'pebble-emery-runner-test-'));
  const events = [];
  const listeners = process.listenerCount('SIGINT');
  try {
    await assert.rejects(runEmeryQa({
      app: 'test', cwd: outputDir, pbw: 'test.pbw', captureHelper: 'capture.py', outputDir,
    }, async ({defer}) => {
      events.push('scenario');
      defer(async () => { events.push('deferred'); });
      throw new Error('injected scenario failure');
    }, {
      acquireLock: async () => {
        events.push('lock');
        return () => { events.push('release'); };
      },
      isolateState: () => {
        events.push('isolate');
        return () => { events.push('restore'); };
      },
      startSession: () => ({
        ready: Promise.resolve(),
        capture: async () => {},
        close: async () => { events.push('close'); },
      }),
      assertNative: () => {},
      createBoard: () => { events.push('board'); },
    }), /injected scenario failure/);
    assert.deepEqual(events, [
      'lock', 'isolate', 'scenario', 'close', 'deferred', 'restore', 'release'
    ]);
    assert.equal(process.listenerCount('SIGINT'), listeners);
  } finally {
    rmSync(outputDir, {recursive: true, force: true});
  }
});
