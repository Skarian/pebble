#!/usr/bin/env node

import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const LOCK = '/private/tmp/pebble-emulator-qa.lock';
const CAPTURE = resolve(ROOT, 'scripts/qa-capture.py');
const PBW = resolve(ROOT, 'build/air-quality.pbw');
const require = createRequire(import.meta.url);
const Model = require('../src/common/air_quality_model');
const MESSAGE_KEYS = require('../package.json').pebble.messageKeys;

export function chooseSource(env) {
  const mode = String(env.AIRQUALITY_QA_SOURCE || 'fake').toLowerCase();
  if (mode !== 'fake' && mode !== 'live') throw new Error('AIRQUALITY_QA_SOURCE must be fake or live');
  return mode;
}

function wait(ms) { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }

async function acquireLock() {
  while (true) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'owner.json'), JSON.stringify({pid: process.pid, app: 'AirQuality'}));
      return () => rmSync(LOCK, {recursive: true, force: true});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      process.stdout.write('Waiting for shared Pebble emulator QA lock...\r');
      await wait(1000);
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return options.capture ? result.stdout.trim() : '';
}

function pebblePython() {
  const pebble = realpathSync(run('which', ['pebble'], {capture: true}));
  return join(dirname(pebble), 'python');
}

function isolateFlash() {
  const python = pebblePython();
  const persist = run(python, ['-c', 'from pebble_tool.sdk import get_sdk_persist_dir; print(get_sdk_persist_dir("emery"))'], {capture: true});
  const backup = `${persist}.airquality-qa-backup-${process.pid}-${Date.now()}`;
  const existed = existsSync(persist);
  if (existed) renameSync(persist, backup);
  mkdirSync(persist, {recursive: true});
  return () => {
    rmSync(persist, {recursive: true, force: true});
    if (existed) renameSync(backup, persist);
  };
}

function startSession() {
  const child = spawn(pebblePython(), [CAPTURE, '--emulator', 'emery', '--serve',
    '--pbw', PBW, '--platform', 'emery', '--timeout', '120'],
  {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const lines = createInterface({input: child.stdout});
  const pending = [];
  let readyResolve, readyReject;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady; readyReject = rejectReady;
  });
  lines.on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'ready') readyResolve(message);
    else {
      const next = pending.shift();
      if (next) message.event === 'error' ? next.reject(new Error(message.message)) : next.resolve(message);
    }
  });
  child.once('exit', (code) => {
    const error = new Error(`capture session exited with ${code}`);
    readyReject(error);
    while (pending.length) pending.shift().reject(error);
  });
  return {
    child, ready,
    capture(output, buttons = [], message = null) {
      return new Promise((resolveCapture, reject) => {
        pending.push({resolve: resolveCapture, reject});
        child.stdin.write(JSON.stringify({command: 'capture', output, buttons, message}) + '\n');
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.write(JSON.stringify({command: 'close'}) + '\n');
      await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), wait(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

function encode(dictionary) {
  const encoded = {};
  for (const [name, value] of Object.entries(dictionary)) {
    if (MESSAGE_KEYS[name] === undefined) continue;
    let type = 'int32';
    if (name === 'LOCATION' || name === 'ERROR_TEXT') type = 'cstring';
    else if (name.startsWith('SERIES_')) type = 'bytes';
    else if (name === 'OBSERVED_AT' || name === 'WINDOW_START') type = 'uint32';
    else if (name === 'REQUEST_ID') type = 'uint16';
    else if (['PROTOCOL', 'COMMAND', 'STATUS', 'FLAGS', 'CO2_STATE', 'SCALE', 'POINT_COUNT'].includes(name)) type = 'uint8';
    encoded[MESSAGE_KEYS[name]] = {type, value};
  }
  return encoded;
}

function status(statusCode, requestId, text) {
  return encode({PROTOCOL: 1, STATUS: statusCode, REQUEST_ID: requestId, ERROR_TEXT: text || ''});
}

function snapshot(co2, options = {}) {
  const base = {
    co2,
    co2State: options.co2State ?? (co2 < 1000 ? 1 : co2 <= 1400 ? 2 : 3),
    temperature: options.temperature ?? 22.4,
    humidity: options.humidity ?? 46.2,
    pressure: options.pressure ?? 1008.6,
    battery: options.battery ?? 87,
  };
  const scale = options.scale || 0;
  const points = Array.from({length: Model.GRAPH_COLUMNS}, (_, index) => {
    if (scale === 0 && index % 5 !== 0 && index !== Model.GRAPH_COLUMNS - 1) return {};
    if (scale === 1 && index >= 31 && index <= 33) return {};
    if (scale === 2 && index >= 27 && index <= 29) return {};
    const progress = index / (Model.GRAPH_COLUMNS - 1);
    const wave = scale === 0 ? Math.sin(index / 7) * 0.45
      : scale === 1 ? Math.sin((progress - 0.25) * Math.PI * 2)
        : Math.sin(progress * Math.PI * 6) * 0.75 + (progress - 0.5) * 0.4;
    const occupied = scale === 1 && index >= 15 && index <= 42 ? 95 : 0;
    const weekend = scale === 2 && index < 16 ? -65 : 0;
    const spike = (scale === 0 && index === 40) || (scale === 1 && index === 39) ||
      (scale === 2 && index === 45) ? 120 : 0;
    const offset = wave * 80 + occupied + weekend;
    return {
      co2: Math.max(420, Math.round(co2 - 45 + offset + spike)),
      co2Min: Math.max(400, Math.round(co2 - 58 + offset)),
      co2Max: Math.round(co2 - 32 + offset + spike),
      temperature: base.temperature - 0.7 + wave * 0.8,
      temperatureMin: base.temperature - 0.9 + wave * 0.8,
      temperatureMax: base.temperature - 0.5 + wave * 0.8,
      humidity: base.humidity + 1.4 - wave * 2.1,
      humidityMin: base.humidity + 0.8 - wave * 2.1,
      humidityMax: base.humidity + 2.0 - wave * 2.1,
      pressure: base.pressure + wave * 2.3,
      pressureMin: base.pressure - 0.4 + wave * 2.3,
      pressureMax: base.pressure + 0.4 + wave * 2.3,
    };
  });
  if (options.missingMetric) {
    delete base.pressure;
    points.forEach((row) => {
      delete row.pressure; delete row.pressureMin; delete row.pressureMax;
    });
  }
  if (options.missingHistory) points.splice(0, points.length);
  return {location: 'HOME', current: base, points, scale,
    stale: Boolean(options.stale)};
}

function liveSnapshot(env) {
  if (env.AIRQUALITY_QA_REFRESH_LIVE === '1') {
    throw new Error('Live refresh requires the installed Android companion and Aranet4');
  }
  const cachePath = resolve(ROOT, 'data/android-live-cache.json');
  if (!existsSync(cachePath)) {
    throw new Error('Live QA requires data/android-live-cache.json from one Android companion refresh');
  }
  return JSON.parse(readFileSync(cachePath, 'utf8')).snapshot;
}

function createBoard(states, output) {
  const labels = states.flatMap((state, index) => [
    '(', state.path, '-set', 'label', `${index + 1}. ${state.label}`, ')',
  ]);
  run('magick', ['montage', ...labels, '-filter', 'point', '-resize', '400x456',
    '-tile', '4x', '-geometry', '400x456+24+64', '-background', '#0d100e',
    '-fill', '#f1f3ec', '-stroke', 'none', '-pointsize', '24', '-depth', '8', output]);
}

async function main() {
  const env = process.env;
  const source = chooseSource(env);
  const live = source === 'live' ? liveSnapshot(env) : null;
  const releaseLock = await acquireLock();
  let restoreFlash, session;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const output = resolve(ROOT, 'qa-results', `all-screens-${stamp}-${source}`);
  const states = join(output, 'states');
  mkdirSync(states, {recursive: true});
  const manifest = [];
  try {
    run('npm', ['test']);
    run('pebble', ['build']);
    restoreFlash = isolateFlash();
    session = startSession();
    await session.ready;
    let number = 0;
    async function capture(label, message, buttons = []) {
      number += 1;
      const filename = `${String(number).padStart(2, '0')}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
      const raw = join(states, filename);
      await session.capture(raw, buttons, message);
      manifest.push({number, label, file: `states/${filename}`, path: raw});
    }

    await capture('SETUP REQUIRED', status(1, 1));
    await capture('LOADING', null, ['select']);
    await capture('COMPANION OFFLINE', status(2, 2));
    await capture('BLUETOOTH OFF', status(3, 2));
    await capture('PERMISSION NEEDED', status(4, 2));
    await capture('SENSOR UNAVAILABLE', status(5, 2));
    await capture('TIMEOUT', status(6, 2));
    await capture('SERVICE FAILURE', status(7, 2));
    await capture('GOOD', encode(Model.dictionary(snapshot(720, {co2State: 1}), Date.now(), 2)));
    await capture('AVERAGE', encode(Model.dictionary(snapshot(1180, {co2State: 2}), Date.now(), 2)));
    await capture('UNHEALTHY', encode(Model.dictionary(snapshot(1650, {co2State: 3}), Date.now(), 2)));
    await capture('MISSING METRIC', encode(Model.dictionary(snapshot(820, {missingMetric: true}), Date.now(), 2)));
    await capture('STALE DATA', encode(Model.dictionary(snapshot(1120, {stale: true, ageDays: 3}), Date.now() - 3 * 86400000, 2)));
    await capture('MISSING HISTORY',
      encode(Model.dictionary(snapshot(760, {missingHistory: true}), Date.now(), 2)), ['down']);
    await capture('CURRENT READING', encode(Model.dictionary(snapshot(612), Date.now(), 2)), ['up']);
    let chartRequest = 2;
    const chartMetrics = ['CO2', 'TEMP', 'HUMIDITY', 'PRESSURE'];
    for (const metric of chartMetrics) {
      if (metric === 'CO2') {
        await capture(`${metric} 1 HOUR`, null, ['down']);
      } else {
        chartRequest += 1;
        await capture(`${metric} 1 HOUR`,
          encode(Model.dictionary(snapshot(612, {scale: 0}), Date.now(), chartRequest, 0)),
          ['select', 'down']);
      }
      chartRequest += 1;
      await capture(`${metric} 1 DAY`,
        encode(Model.dictionary(snapshot(612, {scale: 1}), Date.now(), chartRequest, 1)), ['select']);
      chartRequest += 1;
      await capture(`${metric} 1 WEEK`,
        encode(Model.dictionary(snapshot(612, {scale: 2}), Date.now(), chartRequest, 2)), ['select']);
    }
    if (live) {
      await capture('LIVE CURRENT', encode(Model.dictionary(live, Date.now(), 2)), ['up', 'up', 'up', 'up']);
    }
    const board = join(output, 'all-states.png');
    createBoard(manifest, board);
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({
      source, pbw: PBW, screens: manifest.map(({path, ...item}) => item),
    }, null, 2));
    console.log(`AIRQUALITY_QA_BOARD=${board}`);
    console.log(`AIRQUALITY_PBW=${PBW}`);
  } finally {
    if (session) await session.close();
    if (restoreFlash) restoreFlash();
    releaseLock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`AirQuality QA failed: ${error.message}`);
    process.exitCode = 1;
  });
}
