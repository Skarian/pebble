#!/usr/bin/env node

import {randomBytes} from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOT_TOOL = resolve(ROOT, '../pebble-screenshot-tool/pebble-screenshot.mjs');
const BRIDGE_URL = 'http://127.0.0.1:8787';
const DEADLINE_MS = 30000;
const PEBBLE_CLI = process.env.CPAP_QA_PEBBLE_CLI || 'pebble';
const require = createRequire(import.meta.url);
const CPAP = require('../src/common/cpap_model');
const MESSAGE_KEYS = {
  PROTOCOL: 0, COMMAND: 1, REQUEST_ID: 2, STATUS: 3, SOURCE: 4,
  FETCHED_AT: 5, COUNT: 6, ERROR_TEXT: 7,
  DAY0_DATE: 10, DAY0_SCORE: 11, DAY1_DATE: 12, DAY1_SCORE: 13,
  DAY2_DATE: 14, DAY2_SCORE: 15, DAY3_DATE: 16, DAY3_SCORE: 17,
  DAY4_DATE: 18, DAY4_SCORE: 19, DAY5_DATE: 20, DAY5_SCORE: 21,
  DAY6_DATE: 22, DAY6_SCORE: 23,
  DAY0_USAGE: 24, DAY0_AHI_X10: 25, DAY0_MASK_OFF: 26, DAY0_LEAK_X10: 27,
  DAY1_USAGE: 28, DAY1_AHI_X10: 29, DAY1_MASK_OFF: 30, DAY1_LEAK_X10: 31,
  DAY2_USAGE: 32, DAY2_AHI_X10: 33, DAY2_MASK_OFF: 34, DAY2_LEAK_X10: 35,
  DAY3_USAGE: 36, DAY3_AHI_X10: 37, DAY3_MASK_OFF: 38, DAY3_LEAK_X10: 39,
  DAY4_USAGE: 40, DAY4_AHI_X10: 41, DAY4_MASK_OFF: 42, DAY4_LEAK_X10: 43,
  DAY5_USAGE: 44, DAY5_AHI_X10: 45, DAY5_MASK_OFF: 46, DAY5_LEAK_X10: 47,
  DAY6_USAGE: 48, DAY6_AHI_X10: 49, DAY6_MASK_OFF: 50, DAY6_LEAK_X10: 51
};
let triggerSequence = 0;

export function parseEnv(text) {
  const values = {};
  for (const sourceLine of String(text || '').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export function chooseDataSource(env) {
  const override = String(env.CPAP_QA_SOURCE || '').trim().toLowerCase();
  if (override && override !== 'fake' && override !== 'live') {
    throw new Error('CPAP_QA_SOURCE must be fake or live.');
  }
  const username = String(env.MYAIR_USERNAME || '').trim();
  const password = String(env.MYAIR_PASSWORD || '').trim();
  const hasUsername = Boolean(username && username !== 'you@example.com');
  const hasPassword = Boolean(password && password !== 'your-password');
  if (override === 'fake') return 'fake';
  if (hasUsername !== hasPassword) {
    throw new Error('Set both MYAIR_USERNAME and MYAIR_PASSWORD, or remove both to use fake data.');
  }
  if (override === 'live' && !hasUsername) {
    throw new Error('CPAP_QA_SOURCE=live requires MYAIR_USERNAME and MYAIR_PASSWORD.');
  }
  return hasUsername ? 'live' : 'fake';
}

function loadQaEnv() {
  const path = join(ROOT, '.env');
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  return {...file, ...process.env};
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : options.quiet ? 'ignore' : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return options.capture ? result.stdout.trim() : '';
}

function stopEmulators() {
  spawnSync(PEBBLE_CLI, ['kill', '--force'], {cwd: ROOT, stdio: 'ignore'});
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

function localDateOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function records(scores) {
  return scores.flatMap((score, index) => score === null ? [] : [{
    startDate: localDateOffset(index + 1),
    sleepScore: score,
    totalUsage: [452, 481, 0, 376, 438, 287, 414][index],
    ahi: [0.8, 1.1, 0, 1.3, 0.4, 1.2, 0.9][index],
    maskPairCount: [1, 0, 0, 2, 1, 4, 1][index],
    leakPercentile: [8, 4.5, 0, 12.4, 6, 24.8, 9.2][index]
  }]);
}

function pebblePython() {
  const pebble = realpathSync(run('which', [PEBBLE_CLI], {capture: true}));
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
  const prefix = `${basename(persist)}.cpap-qa-backup-`;
  const stale = readdirSync(parent).filter((name) => name.startsWith(prefix));
  if (stale.length > 1) throw new Error(`Multiple stale CPAP QA backups exist beside ${persist}`);
  if (stale.length === 1) {
    rmSync(persist, {recursive: true, force: true});
    renameSync(join(parent, stale[0]), persist);
  }
  const backup = join(parent, `${prefix}${process.pid}-${Date.now()}`);
  renameSync(persist, backup);
  mkdirSync(persist, {recursive: true});
  return () => {
    stopEmulators();
    rmSync(persist, {recursive: true, force: true});
    renameSync(backup, persist);
  };
}

function startBridge(env, token, storePath) {
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: {
      ...env,
      CPAP_DEV_EMULATOR: '1',
      CPAP_BRIDGE_HOST: '127.0.0.1',
      CPAP_BRIDGE_PORT: '8787',
      CPAP_BRIDGE_STORE: storePath,
      CPAP_QA_TOKEN: token,
      CPAP_QA_LIVE_CACHE: join(ROOT, 'data/qa-live-cache.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[bridge] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`));
  return child;
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

async function qaFetch(path, token, options = {}) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: options.body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? {'Content-Type': 'application/json'} : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(2000)
  });
  if (!response.ok) throw new Error(`QA bridge ${path} returned ${response.status}`);
  return response.json();
}

async function waitForBridge(child, token) {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CPAP bridge exited with status ${child.exitCode}`);
    try {
      await qaFetch('/v1/dev/qa/status', token);
      return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Timed out waiting for the CPAP QA bridge');
}

async function setScenario(token, scenario) {
  await qaFetch('/v1/dev/qa/scenario', token, {body: scenario});
}

function startCaptureSession() {
  const helper = resolve(SCREENSHOT_TOOL, '../capture.py');
  const child = spawn(pebblePython(), [
    helper,
    '--emulator', 'emery', '--serve',
    '--pbw', join(ROOT, 'build/cpap.pbw'),
    '--platform', 'emery'
  ], {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']});
  const lines = createInterface({input: child.stdout});
  const pending = [];
  let startup;
  const ready = new Promise((resolveReady, rejectReady) => { startup = {resolveReady, rejectReady}; });
  child.stderr.on('data', (chunk) => process.stderr.write(`[capture] ${chunk}`));
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'ready') {
      session.qemuPid = message.qemuPid;
      startup.resolveReady();
    } else {
      const request = pending.shift();
      if (!request) return;
      if (message.event === 'error') request.reject(new Error(message.message));
      else request.resolve(message);
    }
  });
  child.once('exit', (code) => {
    const error = new Error(`Capture session exited with status ${code}`);
    startup.rejectReady(error);
    while (pending.length) pending.shift().reject(error);
  });
  const session = {
    child,
    ready,
    qemuPid: null,
    capture(output, buttons = [], message = null) {
      return new Promise((resolveCapture, rejectCapture) => {
        pending.push({resolve: resolveCapture, reject: rejectCapture});
        child.stdin.write(`${JSON.stringify({command: 'capture', output, buttons, message})}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.write(`${JSON.stringify({command: 'close'})}\n`);
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 2000))
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (this.qemuPid) {
        try { process.kill(this.qemuPid, 'SIGKILL'); } catch {}
      }
    }
  };
  return session;
}

function encodeAppMessage(dictionary) {
  const encoded = {};
  for (const [name, value] of Object.entries(dictionary)) {
    const key = MESSAGE_KEYS[name];
    if (key === undefined) continue;
    let type = 'uint8';
    if (name === 'ERROR_TEXT') type = 'cstring';
    else if (name === 'REQUEST_ID') type = 'uint16';
    else if (name === 'FETCHED_AT' || name.endsWith('_DATE') || name.endsWith('_SCORE') ||
             name.endsWith('_USAGE') || name.endsWith('_AHI_X10') ||
             name.endsWith('_MASK_OFF') || name.endsWith('_LEAK_X10')) {
      type = 'uint32';
    }
    encoded[key] = {type, value};
  }
  return encoded;
}

function statusMessage(status, text) {
  return encodeAppMessage({PROTOCOL: 1, STATUS: status, ...(text ? {ERROR_TEXT: text} : {})});
}

async function scenarioMessage(type, fetchedAt = Date.now()) {
  if (type === 'unconfigured') {
    const health = await fetch(`${BRIDGE_URL}/health`).then((response) => response.json());
    if (health.devEmulator) throw new Error('Unconfigured QA scenario reported configured');
    return statusMessage(1);
  }
  if (type === 'loading') {
    const health = await fetch(`${BRIDGE_URL}/health`).then((response) => response.json());
    if (!health.devEmulator) throw new Error('Configured QA scenario reported unconfigured');
    return null;
  }
  try {
    const response = await fetch(`${BRIDGE_URL}/v1/dev/scores`, {
      headers: {'X-CPAP-Dev': '1'}, signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    if (response.ok) {
      const slots = CPAP.sevenDaySlots(body.records || [], new Date());
      return encodeAppMessage(CPAP.responseDictionary(slots, fetchedAt, 0, 1));
    }
    return statusMessage(response.status === 401 ? 2 : 4, body.error);
  } catch {
    return statusMessage(3, 'Phone or bridge offline');
  }
}

async function triggerScenario(captureSession, scratch, type, fetchedAt) {
  await captureSession.capture(join(scratch, `trigger-${++triggerSequence}.png`), ['select']);
  return scenarioMessage(type, fetchedAt);
}

async function captureState(outputDir, captureSession, name, label, buttons = [], message = null) {
  const path = join(outputDir, 'states', `${name}.png`);
  await captureSession.capture(path, buttons, message);
  console.log(`Captured ${label}`);
  return {path, label, name};
}

async function verifySameScreen(captureSession, scratch, name, expected, buttons = [], message = null) {
  const path = join(scratch, `verify-${name}.png`);
  await captureSession.capture(path, buttons, message);
  if (!readFileSync(path).equals(readFileSync(expected))) {
    throw new Error(`${name} did not match its no-cache screen`);
  }
  console.log(`Verified ${name} matches its no-cache screen`);
}

function createBoard(states, output) {
  const labels = states.flatMap((state, index) => [
    '(', state.path, '-set', 'label', `${index + 1}. ${state.label}`, ')'
  ]);
  const common = [
    ...labels, '-filter', 'point', '-resize', '400x456', '-tile', '4x',
    '-geometry', '400x456+24+64', '-background', '#0d100e', '-fill', '#f1f3ec',
    '-stroke', 'none', '-pointsize', '24', '-depth', '8', output
  ];
  const magick = spawnSync('magick', ['-version'], {stdio: 'ignore'}).status === 0;
  run(magick ? 'magick' : 'montage', magick ? ['montage', ...common] : common);
}

export async function main() {
  if (!existsSync(SCREENSHOT_TOOL)) throw new Error(`Screenshot tool not found at ${SCREENSHOT_TOOL}`);
  const env = loadQaEnv();
  const dataSource = chooseDataSource(env);
  const outputDir = join(ROOT, 'qa-results', `all-screens-${timestamp()}-${dataSource}`);
  const scratch = mkdtempSync(join(tmpdir(), 'cpap-qa-'));
  const token = randomBytes(24).toString('hex');
  let bridge = null;
  let captureSession = null;
  let restoreEmulator = null;
  let primaryError = null;
  const captured = [];
  let sequence = 0;
  const nextId = (name) => `${String(++sequence).padStart(2, '0')}-${name}`;
  const fullRecords = records([96, 100, 0, 74, 91, 67, 82]);
  const partialRecords = records([null, 88, 76, 91, 67, 82, 55]);

  mkdirSync(join(outputDir, 'states'), {recursive: true});
  console.log(`CPAP QA board source: deterministic scenarios${dataSource === 'live' ? ' + cached live check' : ''}`);
  try {
    stopEmulators();
    run(env.CPAP_QA_BUILD_CLI || PEBBLE_CLI, ['build']);
    restoreEmulator = isolateEmulatorState();
    bridge = startBridge(env, token, join(scratch, 'sessions.json'));
    await waitForBridge(bridge, token);

    const loadingId = nextId('loading-empty');
    await setScenario(token, {id: loadingId, type: 'loading'});
    captureSession = startCaptureSession();
    await captureSession.ready;
    await scenarioMessage('loading');
    const initialLoading = await captureState(
      outputDir, captureSession, 'loading-empty', 'SYNCING - NO CACHE');

    const unconfiguredId = nextId('unconfigured');
    await setScenario(token, {id: unconfiguredId, type: 'unconfigured'});
    const setup = await captureState(outputDir, captureSession, 'unconfigured', 'SETUP REQUIRED', [],
      await scenarioMessage('unconfigured'));
    captured.push(setup, initialLoading);
    const baselines = {loading: initialLoading.path};

    for (const [name, label, type] of [
      ['auth-empty', 'AUTH ERROR', 'auth_error'],
      ['network-empty', 'PHONE UNREACHABLE', 'network_error'],
      ['service-empty', 'RESMED UNAVAILABLE', 'service_error']
    ]) {
      const id = nextId(name);
      await setScenario(token, {id, type});
      const message = await triggerScenario(captureSession, scratch, type);
      const state = await captureState(outputDir, captureSession, name, label, [], message);
      baselines[type] = state.path;
      captured.push(state);
    }

    const successId = nextId('success');
    await setScenario(token, {id: successId, type: 'records', records: fullRecords});
    const successMessage = await triggerScenario(captureSession, scratch, 'records');
    captured.push(await captureState(outputDir, captureSession, 'day-1', 'DAY 1 - SCORE', [],
      successMessage));
    for (let day = 2; day <= 7; day += 1) {
      captured.push(await captureState(outputDir, captureSession, `day-${day}`, `DAY ${day} - SCORE`, ['up']));
    }

    for (const [name, label, buttons] of [
      ['graph-score', 'GRAPH - SCORE', ['down', 'down', 'down', 'down', 'down', 'down', 'down']],
      ['graph-usage', 'GRAPH - USAGE', ['down']],
      ['graph-events', 'GRAPH - EVENTS', ['down']],
      ['graph-mask-off', 'GRAPH - MASK OFF', ['down']],
      ['graph-leak', 'GRAPH - LEAK', ['down']]
    ]) {
      captured.push(await captureState(outputDir, captureSession, name, label, buttons));
    }

    for (const [name, label, ageMs, buttons] of [
      ['updated-10m', 'UPDATED 10 MINUTES AGO', 10 * 60 * 1000,
        ['up', 'up', 'up', 'up', 'up']],
      ['updated-3h', 'UPDATED 3 HOURS AGO', 3 * 60 * 60 * 1000, []],
      ['updated-2d', 'UPDATED 2 DAYS AGO', 2 * 24 * 60 * 60 * 1000, []]
    ]) {
      const message = encodeAppMessage(CPAP.responseDictionary(
        CPAP.sevenDaySlots(fullRecords, new Date()), Date.now() - ageMs, 0, 1));
      captured.push(await captureState(outputDir, captureSession, name, label, buttons, message));
    }

    const partialId = nextId('partial');
    await setScenario(token, {id: partialId, type: 'records', records: partialRecords});
    const partialMessage = await triggerScenario(captureSession, scratch, 'records');
    captured.push(await captureState(outputDir, captureSession, 'partial', 'NO SCORE', [], partialMessage));
    captured.push(await captureState(outputDir, captureSession, 'graph-partial',
      'GRAPH - MISSING DAY', ['down'], partialMessage));

    const restoreId = nextId('restore-cache');
    await setScenario(token, {id: restoreId, type: 'records', records: fullRecords});
    const restoreMessage = await triggerScenario(captureSession, scratch, 'records');
    await captureSession.capture(join(scratch, `restore-${++triggerSequence}.png`), ['up'], restoreMessage);

    const cachedLoadingId = nextId('loading-cached');
    await setScenario(token, {id: cachedLoadingId, type: 'loading'});
    await triggerScenario(captureSession, scratch, 'loading');
    await verifySameScreen(captureSession, scratch, 'cached loading', baselines.loading);

    for (const [name, type] of [
      ['cached auth error', 'auth_error'],
      ['cached network error', 'network_error'],
      ['cached service error', 'service_error']
    ]) {
      const id = nextId(name);
      await setScenario(token, {id, type});
      const message = await triggerScenario(captureSession, scratch, type);
      await verifySameScreen(captureSession, scratch, name, baselines[type], [], message);
    }

    let finalStatus = await qaFetch('/v1/dev/qa/status', token);
    if (dataSource === 'live') {
      const liveId = nextId('live');
      await setScenario(token, {
        id: liveId,
        type: 'live',
        refreshLive: env.CPAP_QA_REFRESH_LIVE === '1'
      });
      const liveMessage = await triggerScenario(captureSession, scratch, 'live');
      finalStatus = await qaFetch('/v1/dev/qa/status', token);
      captured.push(await captureState(outputDir, captureSession, 'live', 'LIVE DATA', [], liveMessage));
    }

    const board = join(outputDir, 'all-states.png');
    createBoard(captured, board);
    writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      productionPbw: true,
      states: captured.map(({name, label}, index) => ({number: index + 1, name, label})),
      liveIncluded: dataSource === 'live',
      liveApiCalls: finalStatus.liveApiCalls,
      liveCacheUsed: finalStatus.liveCacheUsed
    }, null, 2)}\n`);
    console.log(`Created ${board}`);
    console.log(`ResMed API calls this run: ${finalStatus.liveApiCalls}`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (captureSession) await captureSession.close();
    stopEmulators();
    await stopChild(bridge);
    if (restoreEmulator) {
      try {
        restoreEmulator();
      } catch (restoreError) {
        if (!primaryError) primaryError = restoreError;
        else console.error(`Emulator-state restore also failed: ${restoreError.message}`);
      }
    }
    rmSync(scratch, {recursive: true, force: true});
  }
  if (primaryError) throw primaryError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`CPAP screenshot QA failed: ${error.message}`);
    process.exitCode = 1;
  });
}
