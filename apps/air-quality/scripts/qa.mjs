#!/usr/bin/env node

import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runEmeryQa} from '../../../tools/pebble-emulator-qa.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  return encode({PROTOCOL: 2, STATUS: statusCode, REQUEST_ID: requestId, ERROR_TEXT: text || ''});
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
      temperature: base.temperature - 0.7 + wave * 0.8,
      humidity: base.humidity + 1.4 - wave * 2.1,
      pressure: base.pressure + wave * 2.3,
    };
  });
  if (options.missingMetric) {
    delete base.pressure;
    points.forEach((row) => delete row.pressure);
  }
  if (options.missingHistory) points.splice(0, points.length);
  return {location: 'HOME', current: base, points, scale,
    stale: Boolean(options.stale), cached: Boolean(options.cached)};
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

async function main() {
  const env = process.env;
  const source = chooseSource(env);
  const live = source === 'live' ? liveSnapshot(env) : null;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const output = resolve(ROOT, 'qa-results', `all-screens-${stamp}-${source}`);
  const qa = await runEmeryQa({
    app: 'air-quality', cwd: ROOT, pbw: PBW, captureHelper: CAPTURE,
    outputDir: output, timeoutSeconds: 120,
    prepare({run}) {
      run('npm', ['test']);
      run('pebble', ['build']);
    },
    board: {gapX: 18, gapY: 48, background: '#0d100e', foreground: '#f1f3ec'},
    manifest: {source, productionPbw: PBW},
  }, async ({capture: captureScreen}) => {
    const capture = (label, message, buttons = [], options = {}) => captureScreen(label, {
      buttons, message, skipStable: Boolean(options.skipStable), waitMs: options.waitMs || 0,
    });

    let requestId = 1;
    await capture('CONNECTING', null, [], {skipStable: true, waitMs: 80});
    const staleObservedAt = Date.now() - 3 * 86400000;
    await capture('CACHED RESPONSE - SYNCING', encode(Model.dictionary(
      snapshot(1120, {stale: true, cached: true}), staleObservedAt, requestId)));
    await capture('SYNC TIMED OUT AFTER CACHE', status(10, requestId));

    requestId += 1;
    await capture('PHONE OFFLINE AFTER CACHE', status(2, requestId), ['select']);
    requestId += 1;
    await capture('SETUP REQUIRED AFTER CACHE', status(1, requestId), ['select']);
    requestId += 1;
    await capture('BLUETOOTH OFF AFTER CACHE', status(3, requestId), ['select']);
    requestId += 1;
    await capture('PERMISSION NEEDED AFTER CACHE', status(4, requestId), ['select']);
    requestId += 1;
    await capture('SENSOR NOT FOUND AFTER CACHE', status(5, requestId), ['select']);
    requestId += 1;
    await capture('SENSOR TIMED OUT AFTER CACHE', status(6, requestId), ['select']);
    requestId += 1;
    await capture('SERVICE ERROR AFTER CACHE', status(7, requestId), ['select']);

    requestId += 1;
    await capture('RECOVERED LIVE', encode(Model.dictionary(
      snapshot(720, {co2State: 1}), Date.now(), requestId)), ['select']);

    for (const [label, value, state] of [
      ['AVERAGE', 1180, 2], ['UNHEALTHY', 1650, 3],
    ]) {
      requestId += 1;
      await capture(label, encode(Model.dictionary(
        snapshot(value, {co2State: state}), Date.now(), requestId)), ['select']);
    }
    requestId += 1;
    await capture('MISSING METRIC', encode(Model.dictionary(
      snapshot(820, {missingMetric: true}), Date.now(), requestId)), ['select']);
    requestId += 1;
    await capture('MISSING HISTORY', encode(Model.dictionary(
      snapshot(760, {missingHistory: true}), Date.now(), requestId)), ['select', 'down']);
    requestId += 1;
    await capture('CURRENT READING', encode(Model.dictionary(
      snapshot(612), Date.now(), requestId)), ['up', 'select']);

    await capture('CO2 1 HOUR', null, ['down']);
    requestId += 1;
    await capture('CO2 1 DAY',
      encode(Model.dictionary(snapshot(612, {scale: 1}), Date.now(), requestId, 1)), ['select']);
    requestId += 1;
    await capture('CO2 1 WEEK',
      encode(Model.dictionary(snapshot(612, {scale: 2}), Date.now(), requestId, 2)), ['select']);
    await capture('TEMPERATURE 1 WEEK', null, ['down']);
    if (live) {
      requestId += 1;
      await capture('LIVE CURRENT', encode(Model.dictionary(live, Date.now(), requestId)),
        ['up', 'up', 'select']);
    }
  });
  console.log(`AIRQUALITY_QA_BOARD=${qa.board}`);
  console.log(`AIRQUALITY_PBW=${PBW}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`AirQuality QA failed: ${error.message}`);
    process.exitCode = error.exitCode || 1;
  });
}
