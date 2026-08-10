#!/usr/bin/env node

import {randomBytes} from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, rmSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {runEmeryQa} from '../../../tools/pebble-emulator-qa.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOT_TOOL = resolve(ROOT, '../../tools/pebble-screenshot-tool/pebble-screenshot.mjs');
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
  const source = String(env.CPAP_QA_SOURCE || 'fake').trim().toLowerCase();
  if (source !== 'fake' && source !== 'live') {
    throw new Error('CPAP_QA_SOURCE must be fake or live.');
  }
  if (source === 'fake') return 'fake';
  const username = String(env.MYAIR_USERNAME || '').trim();
  const password = String(env.MYAIR_PASSWORD || '').trim();
  const hasUsername = Boolean(username && username !== 'you@example.com');
  const hasPassword = Boolean(password && password !== 'your-password');
  if (!hasUsername || !hasPassword) {
    throw new Error('CPAP_QA_SOURCE=live requires MYAIR_USERNAME and MYAIR_PASSWORD.');
  }
  return 'live';
}

function loadQaEnv() {
  const path = join(ROOT, '.env');
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  return {...file, ...process.env};
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

function statusMessage(status, requestId, text) {
  return encodeAppMessage({PROTOCOL: 1, STATUS: status, REQUEST_ID: requestId,
    ...(text ? {ERROR_TEXT: text} : {})});
}

async function scenarioMessage(type, requestId, fetchedAt = Date.now()) {
  if (type === 'unconfigured') {
    const health = await fetch(`${BRIDGE_URL}/health`).then((response) => response.json());
    if (health.devEmulator) throw new Error('Unconfigured QA scenario reported configured');
    return statusMessage(1, requestId);
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
      return encodeAppMessage(CPAP.responseDictionary(slots, fetchedAt, requestId, 1));
    }
    return statusMessage(response.status === 401 ? 2 : 4, requestId, body.error);
  } catch {
    return statusMessage(7, requestId, 'Could not reach ResMed');
  }
}

async function triggerScenario(qa, scratch, type, requestId, fetchedAt) {
  await qa.captureRaw(join(scratch, `trigger-${++triggerSequence}.png`), {
    buttons: ['select']});
  return scenarioMessage(type, requestId, fetchedAt);
}

async function triggerRequest(qa, scratch) {
  await qa.captureRaw(join(scratch, `trigger-${++triggerSequence}.png`), {
    buttons: ['select']});
}

async function captureState(qa, name, label, buttons = [], message = null) {
  return qa.capture(label, {buttons, message}, {name, slug: name});
}

async function verifySameScreen(qa, scratch, name, expected, buttons = [], message = null) {
  const path = join(scratch, `verify-${name}.png`);
  await qa.captureRaw(path, {buttons, message});
  if (!readFileSync(path).equals(readFileSync(expected))) {
    throw new Error(`${name} did not match its no-cache screen`);
  }
  console.log(`Verified ${name} matches its no-cache screen`);
}

export async function main() {
  if (!existsSync(SCREENSHOT_TOOL)) throw new Error(`Screenshot tool not found at ${SCREENSHOT_TOOL}`);
  const requestedSource = String(process.env.CPAP_QA_SOURCE || 'fake').trim().toLowerCase();
  const env = requestedSource === 'live' ? loadQaEnv() : {...process.env};
  const dataSource = chooseDataSource(env);
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const outputDir = join(ROOT, 'qa-results', `all-screens-${stamp}-${dataSource}`);
  const scratch = mkdtempSync(join(tmpdir(), 'cpap-qa-'));
  const token = randomBytes(24).toString('hex');
  let sequence = 0;
  let watchRequestId = 1;
  const nextId = (name) => `${String(++sequence).padStart(2, '0')}-${name}`;
  const nextWatchRequestId = () => {
    watchRequestId = watchRequestId >= 65535 ? 1 : watchRequestId + 1;
    return watchRequestId;
  };
  const fullRecords = records([96, 100, 0, 74, 91, 67, 82]);
  const partialRecords = records([null, 88, 76, 91, 67, 82, 55]);

  console.log(`CPAP QA board source: deterministic scenarios${dataSource === 'live' ? ' + explicit live check' : ''}`);
  try {
    const completed = await runEmeryQa({
      app: 'cpap', cwd: ROOT, pbw: join(ROOT, 'build/cpap.pbw'),
      captureHelper: resolve(SCREENSHOT_TOOL, '../capture.py'), pebbleCli: PEBBLE_CLI,
      outputDir,
      prepare({run}) { run(env.CPAP_QA_BUILD_CLI || PEBBLE_CLI, ['build']); },
      board: {
        gapX: 12, gapY: 36, background: '#0d100e', foreground: '#f1f3ec', pointSize: 12,
      },
      manifest: ({result}) => ({
        productionPbw: join(ROOT, 'build/cpap.pbw'),
        liveIncluded: dataSource === 'live',
        liveApiCalls: result.finalStatus.liveApiCalls,
        liveCacheUsed: result.finalStatus.liveCacheUsed,
      }),
    }, async (qa) => {
    const bridge = startBridge(env, token, join(scratch, 'sessions.json'));
    qa.defer(() => stopChild(bridge));
    await waitForBridge(bridge, token);

    const loadingId = nextId('loading-empty');
    await setScenario(token, {id: loadingId, type: 'loading'});
    await captureState(qa, 'connecting-empty', 'CONNECTING TO PHONE');
    await scenarioMessage('loading', watchRequestId);
    const initialLoading = await captureState(
      qa, 'loading-empty', 'SYNCING - NO CACHE', [],
      encodeAppMessage({PROTOCOL: 1, COMMAND: 2}));

    const unconfiguredId = nextId('unconfigured');
    await setScenario(token, {id: unconfiguredId, type: 'unconfigured'});
    await captureState(qa, 'unconfigured', 'SETUP REQUIRED', [],
      await scenarioMessage('unconfigured', watchRequestId));
    const baselines = {loading: initialLoading.path};

    for (const [name, label, type] of [
      ['auth-empty', 'AUTH ERROR', 'auth_error'],
      ['network-empty', 'RESMED OFFLINE', 'network_error'],
      ['service-empty', 'RESMED UNAVAILABLE', 'service_error']
    ]) {
      const id = nextId(name);
      await setScenario(token, {id, type});
      const requestId = nextWatchRequestId();
      const message = await triggerScenario(qa, scratch, type, requestId);
      const state = await captureState(qa, name, label, [], message);
      baselines[type] = state.path;
    }

    const successId = nextId('success');
    await setScenario(token, {id: successId, type: 'records', records: fullRecords});
    const successRequestId = nextWatchRequestId();
    const successMessage = await triggerScenario(
      qa, scratch, 'records', successRequestId);
    await captureState(qa, 'day-1', 'DAY 1 - SCORE', [], successMessage);
    for (let day = 2; day <= 7; day += 1) {
      await captureState(qa, `day-${day}`, `DAY ${day} - SCORE`, ['up']);
    }

    for (const [name, label, buttons] of [
      ['graph-score', 'GRAPH - SCORE', ['down', 'down', 'down', 'down', 'down', 'down', 'down']],
      ['graph-usage', 'GRAPH - USAGE', ['down']],
      ['graph-events', 'GRAPH - EVENTS', ['down']],
      ['graph-mask-off', 'GRAPH - MASK OFF', ['down']],
      ['graph-leak', 'GRAPH - LEAK', ['down']]
    ]) {
      await captureState(qa, name, label, buttons);
    }

    for (const [name, label, ageMs, buttons] of [
      ['updated-10m', 'UPDATED 10 MINUTES AGO', 10 * 60 * 1000,
        ['up', 'up', 'up', 'up', 'up']],
      ['updated-3h', 'UPDATED 3 HOURS AGO', 3 * 60 * 60 * 1000, []],
      ['updated-2d', 'UPDATED 2 DAYS AGO', 2 * 24 * 60 * 60 * 1000, []]
    ]) {
      const requestId = nextWatchRequestId();
      await triggerRequest(qa, scratch);
      const message = encodeAppMessage(CPAP.responseDictionary(
        CPAP.sevenDaySlots(fullRecords, new Date()), Date.now() - ageMs, requestId, 1));
      await captureState(qa, name, label, buttons, message);
    }

    const partialId = nextId('partial');
    await setScenario(token, {id: partialId, type: 'records', records: partialRecords});
    const partialRequestId = nextWatchRequestId();
    const partialMessage = await triggerScenario(
      qa, scratch, 'records', partialRequestId);
    await captureState(qa, 'partial', 'NO SCORE', [], partialMessage);
    await captureState(qa, 'graph-partial', 'GRAPH - MISSING DAY', ['down']);

    const restoreId = nextId('restore-cache');
    await setScenario(token, {id: restoreId, type: 'records', records: fullRecords});
    const restoreRequestId = nextWatchRequestId();
    const restoreMessage = await triggerScenario(
      qa, scratch, 'records', restoreRequestId);
    await qa.captureRaw(join(scratch, `restore-${++triggerSequence}.png`), {
      buttons: ['up'], message: restoreMessage});

    const cachedLoadingId = nextId('loading-cached');
    await setScenario(token, {id: cachedLoadingId, type: 'loading'});
    const cachedLoadingRequestId = nextWatchRequestId();
    await triggerScenario(qa, scratch, 'loading', cachedLoadingRequestId);
    await verifySameScreen(qa, scratch, 'cached loading', baselines.loading);

    const cachedAuthId = nextId('cached-auth-error');
    await setScenario(token, {id: cachedAuthId, type: 'auth_error'});
    await verifySameScreen(qa, scratch, 'cached auth error',
      baselines.auth_error, [], await scenarioMessage('auth_error', cachedLoadingRequestId));

    for (const [name, type] of [
      ['cached network error', 'network_error'],
      ['cached service error', 'service_error']
    ]) {
      const id = nextId(name);
      await setScenario(token, {id, type});
      const requestId = nextWatchRequestId();
      const message = await triggerScenario(qa, scratch, type, requestId);
      await verifySameScreen(qa, scratch, name, baselines[type], [], message);
    }

    const timeoutId = nextId('phone-response-timeout');
    await setScenario(token, {id: timeoutId, type: 'loading'});
    const timeoutRequestId = nextWatchRequestId();
    await triggerRequest(qa, scratch);
    await captureState(qa, 'phone-timeout', 'PHONE RESPONSE TIMEOUT', [],
      statusMessage(8, timeoutRequestId));

    const recoveryId = nextId('recovery');
    await setScenario(token, {id: recoveryId, type: 'records', records: fullRecords});
    const recoveryRequestId = nextWatchRequestId();
    const recoveryMessage = await triggerScenario(
      qa, scratch, 'records', recoveryRequestId);
    await captureState(qa, 'recovered', 'RECOVERED DATA', [], recoveryMessage);

    let finalStatus = await qaFetch('/v1/dev/qa/status', token);
    if (dataSource === 'live') {
      const liveId = nextId('live');
      await setScenario(token, {
        id: liveId,
        type: 'live',
        refreshLive: env.CPAP_QA_REFRESH_LIVE === '1'
      });
      const liveRequestId = nextWatchRequestId();
      const liveMessage = await triggerScenario(
        qa, scratch, 'live', liveRequestId);
      finalStatus = await qaFetch('/v1/dev/qa/status', token);
      await captureState(qa, 'live', 'LIVE DATA', [], liveMessage);
    }

    return {finalStatus};
    });
    console.log(`Created ${completed.board}`);
    console.log(`ResMed API calls this run: ${completed.result.finalStatus.liveApiCalls}`);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`CPAP screenshot QA failed: ${error.message}`);
    process.exitCode = error.exitCode || 1;
  });
}
