import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('changed whole-history replays replace the old projection without duplicates', () => {
  const root = resolve(import.meta.dirname, '..');
  const scratch = mkdtempSync(join(tmpdir(), 'agents-history-projection-'));
  const binary = join(scratch, 'history-projection-test');
  try {
    const compile = spawnSync('cc', [
      '-std=c11', '-Wall', '-Wextra', '-Werror',
      join(root, 'src/c/history_projection.c'),
      join(root, 'test/history_projection_harness.c'),
      '-o', binary,
    ], {encoding: 'utf8'});
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync(binary, [], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /history snapshot replay scenarios passed/);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});
