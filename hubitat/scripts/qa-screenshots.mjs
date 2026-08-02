#!/usr/bin/env node

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync,
  renameSync, rmSync, writeFileSync
} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {chooseDataSource, commandResult, liveSnapshot, snapshotMessages, statusMessage} from '../qa/qa-bridge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE_HELPER = resolve(ROOT, '../pebble-screenshot-tool/capture.py');
const LOCK_PATH = '/private/tmp/pebble-emulator-qa.lock';
const PEBBLE = process.env.HUBITAT_QA_PEBBLE_CLI || 'pebble';
const QA_PORT = Number(process.env.HUBITAT_QA_PORT || 8896);
const KEYS = {
  PROTOCOL: 0, COMMAND: 1, REQUEST_ID: 2, STATUS: 3, FETCHED_AT: 4, COUNT: 5,
  ERROR_TEXT: 6, DEVICE_INDEX: 7, DEVICE_ID: 8, DEVICE_LABEL: 9, DEVICE_KIND: 10,
  PRIMARY_VALUE: 11, SECONDARY_VALUE: 12, BATTERY: 13, CONTROL_FLAGS: 14,
  ACTION: 15, RESULT_TEXT: 16, PARTIAL: 17
};

export function parseEnv(text) {
  const result = {};
  for (const source of String(text || '').split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const at = normalized.indexOf('=');
    if (at < 1) continue;
    const key = normalized.slice(0, at).trim();
    let value = normalized.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT, encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : options.quiet ? 'ignore' : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return options.capture ? result.stdout.trim() : '';
}

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function startBridge(token) {
  const child = spawn(process.execPath, ['qa/server.mjs'], {
    cwd: ROOT, env: {...process.env, HUBITAT_QA_PORT: String(QA_PORT), HUBITAT_QA_TOKEN: token},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[bridge] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`));
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function bridgeMatrix(child, token) {
  while (true) {
    if (child.exitCode !== null) throw new Error(`QA bridge exited with status ${child.exitCode}`);
    try {
      const health = await fetch(`http://127.0.0.1:${QA_PORT}/health`, {signal: AbortSignal.timeout(1000)});
      if (health.ok) break;
    } catch {}
    await delay(100);
  }
  const response = await fetch(`http://127.0.0.1:${QA_PORT}/v1/matrix`, {
    headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(2000)
  });
  if (!response.ok) throw new Error(`QA bridge matrix returned ${response.status}`);
  return response.json();
}

async function acquireEmulatorLock() {
  while (true) {
    try {
      mkdirSync(LOCK_PATH);
      writeFileSync(join(LOCK_PATH, 'owner.json'), `${JSON.stringify({pid: process.pid, app: 'hubitat', at: new Date().toISOString()})}\n`);
      return () => rmSync(LOCK_PATH, {recursive: true, force: true});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log('Waiting for the shared Pebble emulator QA lock...');
      await delay(1000);
    }
  }
}

function pebblePython() {
  const pebble = realpathSync(run('which', [PEBBLE], {capture: true}));
  return join(dirname(pebble), 'python');
}

function emulatorPersistPath() {
  return run(pebblePython(), ['-c',
    'from pebble_tool.sdk import get_sdk_persist_dir; print(get_sdk_persist_dir("emery"))'
  ], {capture: true});
}

function isolateEmulatorState() {
  const persist = emulatorPersistPath();
  const parent = dirname(persist);
  const backup = join(parent, `${basename(persist)}.hubitat-qa-backup-${process.pid}-${Date.now()}`);
  const existed = existsSync(persist);
  if (existed) renameSync(persist, backup);
  mkdirSync(persist, {recursive: true});
  return () => {
    rmSync(persist, {recursive: true, force: true});
    if (existed) renameSync(backup, persist);
  };
}

function startCaptureSession() {
  const child = spawn(pebblePython(), [CAPTURE_HELPER, '--emulator', 'emery', '--serve',
    '--pbw', join(ROOT, 'build/hubitat.pbw'), '--platform', 'emery'],
  {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']});
  const lines = createInterface({input: child.stdout});
  const pending = [];
  let startup;
  const ready = new Promise((resolveReady, rejectReady) => { startup = {resolveReady, rejectReady}; });
  const session = {
    child, ready, qemuPid: null,
    capture(output, buttons = [], message = null) {
      return new Promise((resolveCapture, rejectCapture) => {
        pending.push({resolve: resolveCapture, reject: rejectCapture});
        child.stdin.write(`${JSON.stringify({command: 'capture', output, buttons, message})}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.write('{"command":"close"}\n');
      await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(2500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (session.qemuPid) { try { process.kill(session.qemuPid, 'SIGKILL'); } catch {} }
    }
  };
  child.stderr.on('data', (chunk) => process.stderr.write(`[capture] ${chunk}`));
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'ready') {
      session.qemuPid = message.qemuPid;
      startup.resolveReady();
      return;
    }
    const request = pending.shift();
    if (!request) return;
    if (message.event === 'error') request.reject(new Error(message.message));
    else request.resolve(message);
  });
  child.once('exit', (code) => {
    const error = new Error(`Hubitat capture session exited with status ${code}`);
    startup.rejectReady(error);
    while (pending.length) pending.shift().reject(error);
  });
  return session;
}

function encode(dictionary) {
  const result = {};
  for (const [name, value] of Object.entries(dictionary)) {
    if (KEYS[name] === undefined) continue;
    let type = 'uint8';
    if (['ERROR_TEXT', 'DEVICE_ID', 'DEVICE_LABEL', 'PRIMARY_VALUE', 'SECONDARY_VALUE', 'ACTION', 'RESULT_TEXT'].includes(name)) type = 'cstring';
    else if (name === 'REQUEST_ID') type = 'uint16';
    else if (name === 'FETCHED_AT') type = 'uint32';
    result[KEYS[name]] = {type, value};
  }
  return result;
}

async function inject(session, scratch, messages, prefix) {
  let index = 0;
  for (const message of messages) {
    await session.capture(join(scratch, `${prefix}-${index++}.png`), [], encode(message));
  }
}

async function captureState(outputDir, session, name, label, buttons = [], message = null) {
  const path = join(outputDir, 'states', `${name}.png`);
  await session.capture(path, buttons, message ? encode(message) : null);
  console.log(`Captured ${label}`);
  return {name, label, path};
}

function createBoard(states, output) {
  const inputs = states.flatMap((state, index) => ['(', state.path, '-set', 'label', `${index + 1}. ${state.label}`, ')']);
  const common = [...inputs, '-filter', 'point', '-resize', '400x456', '-tile', '4x',
    '-geometry', '400x456+24+64', '-background', '#101010', '-fill', '#f5f5ef',
    '-stroke', 'none', '-pointsize', '24', '-depth', '8', output];
  const hasMagick = spawnSync('magick', ['-version'], {stdio: 'ignore'}).status === 0;
  run(hasMagick ? 'magick' : 'montage', hasMagick ? ['montage', ...common] : common);
}

function timestamp() { return new Date().toISOString().replace(/[-:.]/g, ''); }

export async function main() {
  if (!existsSync(CAPTURE_HELPER)) throw new Error(`Capture helper not found: ${CAPTURE_HELPER}`);
  const fileEnv = existsSync(join(ROOT, '.env')) ? parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')) : {};
  const env = {...fileEnv, ...process.env};
  const source = chooseDataSource(env);
  const outputDir = join(ROOT, 'qa-results', `all-screens-${timestamp()}-${source}`);
  const scratch = mkdtempSync(join(tmpdir(), 'hubitat-qa-'));
  const captured = [];
  let releaseLock = null;
  let restoreState = null;
  let session = null;
  let bridge = null;
  let primaryError = null;
  let liveInfo = {upstreamRequests: 0, cacheUsed: false};
  mkdirSync(join(outputDir, 'states'), {recursive: true});

  try {
    run(env.HUBITAT_QA_BUILD_CLI || PEBBLE, ['build']);
    const qaToken = randomBytes(24).toString('hex');
    bridge = startBridge(qaToken);
    const matrix = await bridgeMatrix(bridge, qaToken);
    releaseLock = await acquireEmulatorLock();
    restoreState = isolateEmulatorState();
    session = startCaptureSession();
    await session.ready;

    captured.push(await captureState(outputDir, session, 'loading-empty', 'SYNCING - NO CACHE'));
    captured.push(await captureState(outputDir, session, 'setup', 'SETUP REQUIRED', [],
      statusMessage(1, 'Open Hubitat settings')));
    await inject(session, scratch, snapshotMessages([], {partial: true}), 'empty');
    captured.push(await captureState(outputDir, session, 'empty', 'EMPTY DEVICE SELECTION'));

    for (const item of matrix.errors) captured.push(await captureState(
      outputDir, session, item.name, item.label, [], statusMessage(item.status, item.text)));

    const fakeRawDevices = matrix.devices;
    await inject(session, scratch, snapshotMessages(fakeRawDevices), 'full');
    const overview = await captureState(outputDir, session, 'overview', 'OVERVIEW');
    captured.push(overview);
    captured.push(await captureState(outputDir, session, 'motion', 'MOTION SENSOR', ['down']));
    captured.push(await captureState(outputDir, session, 'contact', 'CONTACT SENSOR', ['down', 'down']));
    captured.push(await captureState(outputDir, session, 'temperature', 'TEMPERATURE SENSOR', ['down', 'down']));
    captured.push(await captureState(outputDir, session, 'switch', 'SWITCH DEVICE', ['down', 'down']));
    captured.push(await captureState(outputDir, session, 'switch-control', 'SWITCH CONTROL', ['down', 'down']));
    captured.push(await captureState(outputDir, session, 'lock', 'LOCK AND LOW BATTERY', ['down']));
    captured.push(await captureState(outputDir, session, 'lock-detail', 'DEVICE DETAIL', ['down']));
    captured.push(await captureState(outputDir, session, 'lock-control', 'LOCK CONTROL', ['down']));
    captured.push(await captureState(outputDir, session, 'lock-confirm', 'LOCK CONFIRMATION', ['select']));
    captured.push(await captureState(outputDir, session, 'command-pending', 'COMMAND PENDING', ['select']));
    captured.push(await captureState(outputDir, session, 'command-success', 'SUCCESS - DEVICE UPDATED', [],
      commandResult(matrix.command.success.status, matrix.command.success.text, 2)));

    await session.capture(join(scratch, 'next-command.png'), ['select', 'select', 'select']);
    captured.push(await captureState(outputDir, session, 'command-failure', 'FAILURE - SELECT RETRIES', [],
      commandResult(matrix.command.failure.status, matrix.command.failure.text, 3)));

    const missing = fakeRawDevices.map((device) => ({...device, attributes: {...device.attributes}}));
    missing[1].attributes = {battery: 67};
    await inject(session, scratch, snapshotMessages(missing, {requestId: 3, partial: true}), 'missing');
    captured.push(await captureState(outputDir, session, 'partial-overview', 'PARTIAL DATA'));
    captured.push(await captureState(outputDir, session, 'missing-value', 'MISSING DEVICE VALUE', ['down', 'down', 'down']));

    await inject(session, scratch, snapshotMessages(fakeRawDevices, {
      requestId: 3, fetchedAt: Math.floor(Date.now() / 1000) - 2 * 86400
    }), 'old-timestamp');
    const oldTimestampPath = join(scratch, 'old-timestamp.png');
    await session.capture(oldTimestampPath);
    if (!readFileSync(oldTimestampPath).equals(readFileSync(overview.path))) {
      throw new Error('An old timestamp must render exactly like the normal overview');
    }
    captured.push(await captureState(outputDir, session, 'cached-network', 'PHONE UNREACHABLE - CACHED', [],
      statusMessage(3, 'Phone cannot reach Hubitat', 3)));
    captured.push(await captureState(outputDir, session, 'cached-loading', 'SYNCING - CACHED', [],
      statusMessage(6, '', 3)));

    if (source === 'live') {
      liveInfo = await liveSnapshot({env, cachePath: join(ROOT, 'data/qa-live-cache.json')});
      await inject(session, scratch, snapshotMessages(liveInfo.devices, {requestId: 3}), 'live');
      captured.push(await captureState(outputDir, session, 'live', 'LIVE DATA'));
    }

    const board = join(outputDir, 'all-states.png');
    createBoard(captured, board);
    writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
      generatedAt: new Date().toISOString(), source, productionPbw: true,
      sharedLock: LOCK_PATH, liveUpstreamRequests: liveInfo.upstreamRequests,
      liveCacheUsed: liveInfo.cacheUsed,
      states: captured.map(({name, label}, index) => ({number: index + 1, name, label}))
    }, null, 2)}\n`);
    console.log(`Created ${board}`);
    console.log(`Live Maker API requests this run: ${liveInfo.upstreamRequests}`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (session) await session.close();
    await stopChild(bridge);
    if (restoreState) {
      try { restoreState(); } catch (error) { if (!primaryError) primaryError = error; }
    }
    if (releaseLock) releaseLock();
    rmSync(scratch, {recursive: true, force: true});
  }
  if (primaryError) throw primaryError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Hubitat QA failed: ${error.message}`); process.exitCode = 1; });
}
