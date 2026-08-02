import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../src/common/hubitat_model.js');

export const fakeRawDevices = [
  {id: '101', label: 'Hall Motion', capabilities: ['MotionSensor', 'Battery'],
    attributes: {motion: 'active', battery: 82}, commands: []},
  {id: '102', label: 'Front Door', capabilities: ['ContactSensor', 'Battery'],
    attributes: {contact: 'open', battery: 67}, commands: []},
  {id: '103', label: 'Bedroom', capabilities: ['TemperatureSensor', 'Battery'],
    attributes: {temperature: 72.4, humidity: 41, battery: 94}, commands: []},
  {id: '104', label: 'Desk Lamp', capabilities: ['Switch'],
    attributes: {switch: 'on'}, commands: [{command: 'on'}, {command: 'off'}]},
  {id: '105', label: 'Front Lock', capabilities: ['Lock', 'Battery'],
    attributes: {lock: 'locked', battery: 19}, commands: [{command: 'lock'}, {command: 'unlock'}]}
];

export function snapshotMessages(devices, {requestId = 1, fetchedAt = Math.floor(Date.now() / 1000), partial = false} = {}) {
  const normalized = Model.normalizeDevices(devices, []);
  const truncated = devices.length > normalized.length;
  return [
    {PROTOCOL: 1, COMMAND: 3, REQUEST_ID: requestId, FETCHED_AT: fetchedAt, COUNT: normalized.length},
    ...normalized.map((device, index) => ({
      PROTOCOL: 1, COMMAND: 4, REQUEST_ID: requestId, DEVICE_INDEX: index,
      DEVICE_ID: device.id, DEVICE_LABEL: device.label, DEVICE_KIND: device.kind,
      PRIMARY_VALUE: device.primary, SECONDARY_VALUE: device.secondary,
      BATTERY: device.battery, CONTROL_FLAGS: device.controlFlags
    })),
    {PROTOCOL: 1, COMMAND: 5, REQUEST_ID: requestId, STATUS: partial || truncated ? 7 : 0,
      PARTIAL: partial || truncated ? 1 : 0}
  ];
}

export function statusMessage(status, text, requestId = 1) {
  return {PROTOCOL: 1, COMMAND: 0, REQUEST_ID: requestId, STATUS: status, ERROR_TEXT: text};
}

export function commandResult(status, text, requestId = 2) {
  return {PROTOCOL: 1, COMMAND: 7, REQUEST_ID: requestId, STATUS: status, ERROR_TEXT: text};
}

export function chooseDataSource(env) {
  const source = String(env.HUBITAT_QA_SOURCE || 'fake').trim().toLowerCase();
  if (source !== 'fake' && source !== 'live') throw new Error('HUBITAT_QA_SOURCE must be fake or live');
  if (source === 'live' && (!env.HUBITAT_MAKER_BASE_URL || !env.HUBITAT_MAKER_ACCESS_TOKEN)) {
    throw new Error('Live QA requires HUBITAT_MAKER_BASE_URL and HUBITAT_MAKER_ACCESS_TOKEN');
  }
  return source;
}

export async function liveSnapshot({env, cachePath, fetchImpl = fetch, now = Date.now}) {
  const refresh = env.HUBITAT_QA_REFRESH_LIVE === '1';
  const selectedIds = String(env.HUBITAT_DEVICE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const selection = selectedIds.join(',');
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      if (Array.isArray(cached.devices) && cached.selection === selection &&
          now() - cached.fetchedAt < 24 * 60 * 60 * 1000) {
        return {devices: cached.devices, upstreamRequests: 0, cacheUsed: true};
      }
    } catch {}
  }
  const base = String(env.HUBITAT_MAKER_BASE_URL).replace(/\/+$/, '');
  const token = encodeURIComponent(env.HUBITAT_MAKER_ACCESS_TOKEN);
  let response;
  try {
    response = await fetchImpl(`${base}/devices/all?access_token=${token}`, {signal: AbortSignal.timeout(12000)});
  } catch {
    throw new Error('Maker API live QA network failure');
  }
  if (!response.ok) throw new Error(`Maker API live QA returned ${response.status}`);
  let devices;
  try { devices = await response.json(); }
  catch { throw new Error('Maker API live QA returned invalid JSON'); }
  if (selectedIds.length) devices = devices.filter((device) => selectedIds.includes(String(device.id)));
  await mkdir(dirname(cachePath), {recursive: true});
  await writeFile(cachePath, `${JSON.stringify({fetchedAt: now(), selection, devices})}\n`, {mode: 0o600});
  await chmod(cachePath, 0o600);
  return {devices, upstreamRequests: 1, cacheUsed: false};
}
