#!/usr/bin/env node

import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const LOCK = '/private/tmp/pebble-emulator-qa.lock';
const CAPTURE = resolve(REPO, 'pebble-screenshot-tool/capture.py');
const PBW = resolve(ROOT, 'build/air-quality.pbw');
const require = createRequire(import.meta.url);
const Model = require('../src/common/air_quality_model');
const Aranet = require('../src/common/aranet_client');
const MESSAGE_KEYS = require('../package.json').pebble.messageKeys;

export function parseEnv(text) {
  const values = {};
  for (const source of String(text || '').split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split < 1) continue;
    let value = line.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, split).replace(/^export\s+/, '').trim()] = value;
  }
  return values;
}

export function chooseSource(env) {
  const mode = String(env.AIRQUALITY_QA_SOURCE || '').toLowerCase();
  if (mode && mode !== 'fake' && mode !== 'live') throw new Error('AIRQUALITY_QA_SOURCE must be fake or live');
  const complete = Boolean(env.ARANET_API_KEY && env.ARANET_SENSOR_ID && env.ARANET_LOCATION);
  if (mode === 'live' && !complete) throw new Error('Live QA requires all three ARANET fields');
  return mode === 'fake' || !complete ? 'fake' : 'live';
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
  const result = spawnSync(command, args, {cwd: options.cwd || ROOT, encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit', env: options.env || process.env});
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
  const child = spawn(pebblePython(), [CAPTURE, '--emulator', 'emery', '--serve', '--pbw', PBW, '--platform', 'emery', '--timeout', '120'],
    {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const lines = createInterface({input: child.stdout});
  const pending = [];
  let readyResolve, readyReject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  lines.on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'ready') readyResolve(message);
    else { const next = pending.shift(); if (next) message.event === 'error' ? next.reject(new Error(message.message)) : next.resolve(message); }
  });
  child.once('exit', (code) => { const error = new Error(`capture session exited with ${code}`); readyReject(error); while (pending.length) pending.shift().reject(error); });
  return {child, ready, capture(output, buttons = [], message = null) {
    return new Promise((resolveCapture, reject) => { pending.push({resolve: resolveCapture, reject}); child.stdin.write(JSON.stringify({command: 'capture', output, buttons, message}) + '\n'); });
  }, async close() {
    if (child.exitCode !== null) return;
    child.stdin.write(JSON.stringify({command: 'close'}) + '\n');
    await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), wait(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }};
}

function encode(dictionary) {
  const encoded = {};
  for (const [name, value] of Object.entries(dictionary)) {
    if (MESSAGE_KEYS[name] === undefined) continue;
    let type = 'uint16';
    if (name === 'LOCATION' || name === 'ERROR_TEXT') type = 'cstring';
    else if (name === 'FETCHED_AT' || name.endsWith('_DATE')) type = 'uint32';
    else if (['PROTOCOL', 'COMMAND', 'STATUS', 'FLAGS'].includes(name)) type = 'uint8';
    encoded[MESSAGE_KEYS[name]] = {type, value};
  }
  return encoded;
}

function status(statusCode, text) { return encode({PROTOCOL: 1, STATUS: statusCode, ERROR_TEXT: text || ''}); }

function dateOffset(days) {
  const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function snapshot(aqi, options = {}) {
  const base = {aqi, pm25: options.pm25 ?? Math.max(2, aqi / 4), co2: options.co2 ?? 612,
    temperature: options.temperature ?? 22.4, humidity: options.humidity ?? 46.2};
  const daily = Array.from({length: 7}, (_, index) => ({date: dateOffset(index + (options.ageDays || 0)), aqi: Math.max(4, aqi - index * 3),
    pm25: Math.max(1, base.pm25 - index), co2: base.co2 - index * 9,
    temperature: base.temperature - index * 0.2, humidity: base.humidity + index * 0.4}));
  if (options.missingMetric) { delete base.co2; daily.forEach((row) => delete row.co2); }
  if (options.missingHistory) daily.splice(0, 7);
  return {location: 'HOME', current: base, daily, stale: Boolean(options.stale)};
}

async function liveSnapshot(env) {
  const cachePath = resolve(ROOT, 'data/qa-live-cache.json');
  if (existsSync(cachePath) && env.AIRQUALITY_QA_REFRESH_LIVE !== '1') {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000) return cached.snapshot;
  }
  const url = 'https://aranet.cloud/api/v1/measurements/history?sensor=' +
    encodeURIComponent(env.ARANET_SENSOR_ID) + '&days=7&limit=10000';
  const response = await fetch(url, {headers: {ApiKey: env.ARANET_API_KEY}, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Aranet live QA returned HTTP ${response.status}`);
  const body = await response.json();
  const normalized = Aranet.normalizeHistory(body.readings || [], env.ARANET_LOCATION, body.links || {});
  mkdirSync(dirname(cachePath), {recursive: true});
  writeFileSync(cachePath, JSON.stringify({cachedAt: Date.now(), snapshot: normalized}), {mode: 0o600});
  chmodSync(cachePath, 0o600);
  return normalized;
}

function createBoard(states, output) {
  const labels = states.flatMap((state, index) => [
    '(', state.path, '-set', 'label', `${index + 1}. ${state.label}`, ')'
  ]);
  run('magick', ['montage', ...labels, '-filter', 'point', '-resize', '400x456',
    '-tile', '4x', '-geometry', '400x456+24+64', '-background', '#0d100e',
    '-fill', '#f1f3ec', '-stroke', 'none', '-pointsize', '24', '-depth', '8', output]);
}

async function main() {
  const fileEnv = existsSync(resolve(ROOT, '.env')) ? parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8')) : {};
  const env = {...fileEnv, ...process.env};
  const source = chooseSource(env);
  const live = source === 'live' ? await liveSnapshot(env) : null;
  const releaseLock = await acquireLock();
  let restoreFlash, session;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const output = resolve(ROOT, 'qa-results', `all-screens-${stamp}-${source}`);
  const states = join(output, 'states'); mkdirSync(states, {recursive: true});
  const manifest = [];
  try {
    run('npm', ['test']);
    run('pebble', ['build']);
    restoreFlash = isolateFlash();
    session = startSession(); await session.ready;
    let number = 0;
    async function capture(label, message, buttons = []) {
      number += 1;
      const filename = `${String(number).padStart(2, '0')}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
      const raw = join(states, filename);
      await session.capture(raw, buttons, message);
      manifest.push({number, label, file: `states/${filename}`, path: raw});
    }
    await capture('SETUP REQUIRED', status(1));
    await capture('LOADING', null, ['select']);
    await capture('AUTH FAILURE', status(2, 'Aranet API access denied'));
    await capture('RATE LIMIT', status(3, 'Refresh limit reached'));
    await capture('PHONE OFFLINE', status(4, 'Pebble phone unavailable'));
    await capture('NETWORK FAILURE', status(5, 'Phone network unavailable'));
    await capture('TIMEOUT', status(6, 'Aranet request timed out'));
    await capture('SERVICE FAILURE', status(7, 'Aranet Cloud unavailable'));
    await capture('HEALTHY', encode(Model.dictionary(snapshot(34), Date.now(), 0)));
    await capture('ELEVATED', encode(Model.dictionary(snapshot(128, {pm25: 46}), Date.now(), 0)));
    await capture('HAZARDOUS', encode(Model.dictionary(snapshot(322, {pm25: 235}), Date.now(), 0)));
    await capture('MISSING METRIC', encode(Model.dictionary(snapshot(58, {missingMetric: true}), Date.now(), 0)));
    await capture('STALE DATA', encode(Model.dictionary(snapshot(72, {stale: true, ageDays: 3}), Date.now() - 3 * 86400000, 0)));
    await capture('MISSING HISTORY', encode(Model.dictionary(snapshot(48, {missingHistory: true}), Date.now(), 0)));
    await capture('CURRENT READING', encode(Model.dictionary(snapshot(44), Date.now(), 0)));
    for (const label of ['AQI CHART', 'PM2.5 CHART', 'CO2 CHART', 'TEMP CHART', 'HUMIDITY CHART']) {
      await capture(label, null, ['down']);
    }
    if (live) {
      await capture('LIVE CURRENT', encode(Model.dictionary(live, Date.now(), 0)), ['up', 'up', 'up', 'up', 'up']);
    }
    const board = join(output, 'all-states.png');
    createBoard(manifest, board);
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({source, pbw: PBW, screens: manifest.map(({path, ...item}) => item)}, null, 2));
    console.log(`AIRQUALITY_QA_BOARD=${board}`);
    console.log(`AIRQUALITY_PBW=${PBW}`);
  } finally {
    if (session) await session.close();
    if (restoreFlash) restoreFlash();
    releaseLock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`AirQuality QA failed: ${error.message}`); process.exitCode = 1; });
}
