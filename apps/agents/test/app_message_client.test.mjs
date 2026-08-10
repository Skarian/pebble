import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const watch = resolve(import.meta.dirname, '../../../shared/appmessage/watch');

test('AppMessage client preserves identity and recovers from transport faults', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pebble-app-message-client-'));
  const binary = join(scratch, 'app-message-client-test');
  try {
    const compile = spawnSync('cc', [
      '-std=c11', '-Wall', '-Wextra', '-Werror',
      '-I', join(watch, 'test'),
      '-I', watch,
      join(watch, 'app_message_client.c'),
      join(watch, 'test/app_message_client_harness.c'),
      '-o', binary,
    ], {encoding: 'utf8'});
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(binary, [], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /behavioral scenarios passed/);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});
