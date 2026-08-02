#!/usr/bin/env node

import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, {cwd: ROOT, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function stopEmulator() {
  run('pebble', ['kill', '--force']);
}

function startBridge() {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolveValue, rejectValue) => {
    resolveReady = resolveValue;
    rejectReady = rejectValue;
  });
  const child = spawn(process.execPath, ['--env-file=.env', 'bridge/server.mjs'], {
    cwd: ROOT,
    env: {...process.env, CPAP_DEV_EMULATOR: '1', CPAP_DEV_LOG_REQUESTS: '1'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => {
    const output = chunk.toString();
    process.stdout.write(`[bridge] ${output}`);
    if (output.includes('CPAP bridge listening on')) resolveReady();
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`));
  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => {
    rejectReady(new Error(`Bridge exited before startup (${signal || code})`));
    resolveExit({code, signal});
  }));
  return {child, ready, exited};
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function waitForStop() {
  return new Promise((resolveStop) => {
    let stopping = false;
    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      resolveStop(signal);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  });
}

async function main() {
  if (!existsSync(resolve(ROOT, '.env'))) {
    throw new Error('Missing .env. Copy .env.example and add MYAIR_USERNAME and MYAIR_PASSWORD.');
  }
  let bridge;
  try {
    stopEmulator();
    run('pebble', ['build']);
    bridge = startBridge();
    await bridge.ready;
    run('pebble', ['install', '--emulator', 'emery', '-v']);
    console.log('CPAP is open with the real development bridge. Press Ctrl+C to stop.');
    const outcome = await Promise.race([
      waitForStop().then(() => null),
      bridge.exited.then(({code, signal}) => new Error(`Bridge stopped (${signal || code})`))
    ]);
    if (outcome) throw outcome;
  } finally {
    await stopChild(bridge?.child);
    stopEmulator();
  }
}

main().catch((error) => {
  console.error(`CPAP development emulator failed: ${error.message}`);
  process.exitCode = 1;
});
