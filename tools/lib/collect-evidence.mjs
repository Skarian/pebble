import {createHash, randomBytes} from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const CORE = 'coredevices.coreapp';
const TARGETS = [CORE, 'com.skarian.agentscompanion', 'com.skarian.airquality'];
const JOURNAL = 'no_backup/pebble-errors-v1.json';
const LOG_DUMP_ENDPOINT = 2002;
const MAX_OUTPUT = 8 * 1024 * 1024;

function safeEnvironment() {
  const env = {...process.env};
  delete env.PEBBLE_DIAGNOSTICS_READ_KEY;
  delete env.PEBBLE_DIAGNOSTICS_KEYCHAIN_ACCOUNT;
  return env;
}

function systemRun(command, args, {timeout = 20_000, encoding = 'utf8'} = {}) {
  const result = spawnSync(command, args, {
    encoding, env: safeEnvironment(), timeout, maxBuffer: MAX_OUTPUT,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout ?? (encoding ? '' : Buffer.alloc(0)),
    stderr: result.stderr ?? (encoding ? '' : Buffer.alloc(0)),
    error: result.error,
  };
}

function detail(result) {
  const text = result.error?.message || String(result.stderr || '').trim()
    || `command exited ${result.status ?? 'without a status'}`;
  return text.replaceAll(/pdiag_[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 500);
}

function isoTimestamp() {
  return new Date().toISOString();
}

function defaultOutputDirectory() {
  const stamp = isoTimestamp().replaceAll(':', '-').replaceAll('.', '-');
  return join(homedir(), 'Library', 'Logs', 'Pebble Diagnostics', 'collections', stamp);
}

function atomicWrite(path, bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const temporary = `${path}.${process.pid}.partial`;
  writeFileSync(temporary, value, {mode: 0o600});
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return value;
}

function artifact(path, bytes, persistence, status = 'collected', extra = {}) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    path, status, persistence, bytes: value.length,
    sha256: createHash('sha256').update(value).digest('hex'), ...extra,
  };
}

function outputArtifact(root, relative, bytes, persistence, extra) {
  const path = join(root, relative);
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const value = atomicWrite(path, bytes);
  return artifact(relative, value, persistence, 'collected', extra);
}

function emptyArtifact(path, persistence, detailText) {
  return {path, status: 'empty', persistence, bytes: 0, detail: detailText};
}

function failedArtifact(path, persistence, error, extra = {}) {
  return {path, status: 'failed', persistence, bytes: 0, detail: String(error).slice(0, 500), ...extra};
}

function unavailableArtifact(path, persistence, reason, extra = {}) {
  return {path, status: 'unavailable', persistence, bytes: 0, detail: String(reason).slice(0, 500), ...extra};
}

export function encodeLogRequest(generation, cookie) {
  if (!Number.isInteger(generation) || generation < 0 || generation > 255) {
    throw new Error('invalid LOG_DUMP generation');
  }
  const frame = Buffer.alloc(11);
  frame[0] = 0x01; // WebSocket relay-to-watch
  frame.writeUInt16BE(6, 1);
  frame.writeUInt16BE(LOG_DUMP_ENDPOINT, 3);
  frame[5] = 0x10;
  frame[6] = generation;
  frame.writeUInt32BE(cookie >>> 0, 7);
  return frame;
}

function terminatedText(bytes) {
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
}

export function decodeLogFrame(value, cookie, generation) {
  const frame = Buffer.from(value);
  if (frame.length < 5 || frame[0] !== 0x00) return {kind: 'ignore'};
  const length = frame.readUInt16BE(1);
  if (length + 5 !== frame.length) return {kind: 'invalid', reason: 'Pebble Protocol length mismatch'};
  if (frame.readUInt16BE(3) !== LOG_DUMP_ENDPOINT) return {kind: 'ignore'};
  const payload = frame.subarray(5);
  if (payload.length < 5) return {kind: 'invalid', reason: 'short LOG_DUMP payload'};
  const command = payload[0];
  if (payload.readUInt32BE(1) !== (cookie >>> 0)) return {kind: 'ignore'};
  if (command === 0x81 || command === 0x82) {
    if (payload.length !== 5) return {kind: 'invalid', reason: 'terminal LOG_DUMP length mismatch'};
    return {kind: command === 0x81 ? 'done' : 'no_logs'};
  }
  if (command !== 0x80) return {kind: 'ignore'};
  if (payload.length < 29) return {kind: 'invalid', reason: 'short LOG_DUMP line'};
  const messageLength = payload[10];
  if (payload.length !== 29 + messageLength) {
    return {kind: 'invalid', reason: 'LOG_DUMP message length mismatch'};
  }
  const timestamp = payload.readUInt32BE(5);
  return {kind: 'line', record: {
    generation, timestamp, at: new Date(timestamp * 1000).toISOString(),
    level: payload[9], line: payload.readUInt16BE(11),
    file: terminatedText(payload.subarray(13, 29)),
    message: terminatedText(payload.subarray(29)),
    raw: payload.toString('hex'),
  }};
}

function waitForOpen(ws, timeoutMillis) {
  return new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('Developer Connection timed out')), timeoutMillis);
    ws.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, {once: true});
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Developer Connection failed')); }, {once: true});
  });
}

function closeWebSocket(ws, timeoutMillis = 1_000) {
  if (ws.readyState === 3) return Promise.resolve(true);
  return new Promise((resolveClosed) => {
    let settled = false;
    let timer;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClosed(closed);
    };
    ws.addEventListener('close', () => finish(true), {once: true});
    timer = setTimeout(() => finish(false), timeoutMillis);
    try { ws.close(); } catch { finish(false); }
  });
}

function requestGeneration(ws, generation, cookie, {inactivityMillis, hardMillis}) {
  return new Promise((resolveGeneration) => {
    const records = [];
    let inactivity;
    let settled = false;
    const finish = (terminal, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivity);
      clearTimeout(hard);
      ws.removeEventListener('message', receive);
      resolveGeneration({generation, records, terminal, reason});
    };
    const arm = () => {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => finish('timeout', 'LOG_DUMP inactivity timeout'), inactivityMillis);
    };
    const receive = (event) => {
      const decoded = decodeLogFrame(event.data, cookie, generation);
      if (decoded.kind === 'ignore') return;
      if (decoded.kind === 'invalid') return finish('invalid', decoded.reason);
      arm();
      if (decoded.kind === 'line') records.push(decoded.record);
      else if (decoded.kind === 'done') finish('done');
      else if (decoded.kind === 'no_logs') {
        finish(records.length ? 'incomplete' : 'no_logs', records.length ? 'NoLogs followed partial data' : undefined);
      }
    };
    const hard = setTimeout(() => finish('timeout', 'LOG_DUMP hard timeout'), hardMillis);
    ws.addEventListener('message', receive);
    arm();
    ws.send(encodeLogRequest(generation, cookie));
  });
}

export async function collectLogDump(url, {
  WebSocketImpl = WebSocket, generationLimit = 64, inactivityMillis = 5_000,
  hardMillis = 30_000, cookieFactory = () => randomBytes(4).readUInt32BE(0) || 1,
} = {}) {
  const ws = new WebSocketImpl(url);
  ws.binaryType = 'arraybuffer';
  try {
    await waitForOpen(ws, inactivityMillis);
  } catch (error) {
    ws.close();
    throw error;
  }
  const generations = [];
  const records = [];
  let complete = true;
  let terminated = false;
  let connectionClosed = false;
  try {
    for (let generation = 0; generation < generationLimit; generation += 1) {
      const result = await requestGeneration(ws, generation, cookieFactory(), {inactivityMillis, hardMillis});
      generations.push({generation, records: result.records.length, terminal: result.terminal, reason: result.reason});
      records.push(...result.records);
      if (result.terminal === 'no_logs' || (generation > 0 && result.terminal === 'done' && result.records.length === 0)) {
        terminated = true;
        break;
      }
      if (result.terminal !== 'done') { complete = false; break; }
    }
  } finally {
    connectionClosed = await closeWebSocket(ws);
  }
  if (!terminated || !connectionClosed) complete = false;
  return {complete, connectionClosed, generations, records};
}

export function filterTargetBlocks(value, targets = TARGETS) {
  const text = String(value || '');
  const parts = text.split(/(?=^={10,}\s*$)/m);
  return parts.filter((part) => targets.some((target) => part.includes(target))).join('').trim();
}

function authorizedDevices(run) {
  const listed = run('adb', ['devices', '-l']);
  if (!listed.ok) throw new Error(detail(listed));
  return String(listed.stdout).split(/\r?\n/).slice(1).map((line) => line.trim())
    .filter(Boolean).map((line) => ({serial: line.split(/\s+/)[0], state: line.split(/\s+/)[1]}))
    .filter(({state}) => state === 'device');
}

function hasCore(run, serial) {
  return run('adb', ['-s', serial, 'shell', 'pm', 'path', '--user', '0', CORE]).ok;
}

export function selectDevice(run, requested) {
  const devices = authorizedDevices(run);
  if (requested) {
    const selected = devices.find(({serial}) => serial === requested);
    if (!selected) throw new Error(`ADB device is not authorized: ${requested}`);
    if (!hasCore(run, requested)) throw new Error(`Core is not installed for Android user 0 on ${requested}`);
    return requested;
  }
  const phones = devices.filter(({serial}) => hasCore(run, serial));
  if (phones.length !== 1) {
    throw new Error(`expected exactly one authorized Core phone; found ${phones.map(({serial}) => serial).join(', ') || 'none'}`);
  }
  return phones[0].serial;
}

function adb(run, serial, args, options) {
  return run('adb', ['-s', serial, ...args], options);
}

function collectCommand(root, manifest, relative, persistence, result, transform = (value) => value) {
  if (!result.ok) {
    manifest.artifacts.push(failedArtifact(relative, persistence, detail(result)));
    return;
  }
  const output = transform(result.stdout);
  if (!output || output.length === 0) {
    manifest.artifacts.push(emptyArtifact(relative, persistence, 'No retained matching evidence.'));
    return;
  }
  manifest.artifacts.push(outputArtifact(root, relative, output, persistence));
}

function pullPendingJournal(root, manifest, run, serial, packageName) {
  const relative = `android/${packageName}-pending.json`;
  const result = adb(run, serial, ['exec-out', 'run-as', packageName, 'cat', JOURNAL]);
  const output = String(result.stdout || '');
  const diagnostic = `${output}\n${result.stderr || ''}`.trim();
  if (result.ok && output.trim()) {
    try { JSON.parse(output); }
    catch {
      if (/^cat: .*: (?:No such file or directory|.*does not exist)$/i.test(diagnostic)) {
        manifest.artifacts.push(emptyArtifact(relative, 'local-outbox', 'No queued error journal.'));
        return;
      }
      manifest.warnings.push(`${packageName}: queued journal is not valid JSON`);
    }
    manifest.artifacts.push(outputArtifact(root, relative, output, 'local-outbox'));
  } else if (/No such file|does not exist/i.test(diagnostic)) {
    manifest.artifacts.push(emptyArtifact(relative, 'local-outbox', 'No queued error journal.'));
  } else if (/not debuggable|run-as:/i.test(diagnostic)) {
    manifest.artifacts.push(unavailableArtifact(
      relative, 'local-outbox', 'The installed companion does not permit run-as access.',
    ));
  } else {
    collectCommand(root, manifest, relative, 'local-outbox', result);
  }
}

export async function collectEvidence({
  adbSerial, out, since = '30d', limit = 5000, server, coredump = false,
  run = systemRun, WebSocketImpl = WebSocket,
} = {}) {
  const root = resolve(out || defaultOutputDirectory());
  if (existsSync(root)) throw new Error(`collection output already exists: ${root}`);
  mkdirSync(root, {recursive: true, mode: 0o700});
  chmodSync(root, 0o700);
  const manifest = {
    schema: 1, collectedAt: isoTimestamp(), requested: {since, limit, coredump},
    artifacts: [], warnings: [],
  };

  if (server?.records) {
    manifest.artifacts.push(outputArtifact(root, 'server/errors.json', `${JSON.stringify(server.records, null, 2)}\n`, 'server'));
  } else {
    manifest.artifacts.push(unavailableArtifact('server/errors.json', 'server', server?.error || 'Server evidence unavailable.'));
  }
  manifest.artifacts.push(unavailableArtifact(
    'android/core-private-log.txt', 'private-app-storage',
    'Release Core does not expose its private rolling log through stock ADB.',
  ));
  manifest.artifacts.push(unavailableArtifact(
    'android/cpap-pkjs-pending.json', 'private-app-storage',
    'Release Core does not expose CPAP per-app PKJS localStorage through stock ADB.',
  ));
  manifest.artifacts.push(unavailableArtifact(
    'android/hubitat-pkjs-pending.json', 'private-app-storage',
    'Release Core does not expose Hubitat per-app PKJS localStorage through stock ADB.',
  ));

  let serial;
  let forwardedPort;
  const removeForward = () => {
    if (!serial || !forwardedPort) return;
    const port = forwardedPort;
    forwardedPort = undefined;
    const removed = adb(run, serial, ['forward', '--remove', `tcp:${port}`]);
    if (!removed.ok) manifest.warnings.push(`Could not remove ADB forward: ${detail(removed)}`);
  };
  const interrupt = (code) => () => {
    removeForward();
    process.exit(code);
  };
  const onInterrupt = interrupt(130);
  const onTerminate = interrupt(143);
  let signalCleanupInstalled = false;
  try {
    serial = selectDevice(run, adbSerial);
    manifest.adb = {serial};
    for (const packageName of TARGETS) {
      collectCommand(root, manifest, `android/${packageName}-exit-info.txt`, 'postmortem-ring',
        adb(run, serial, ['shell', 'dumpsys', 'activity', 'exit-info', packageName]));
    }
    const dropbox = [];
    let dropboxSuccesses = 0;
    const dropboxFailures = [];
    for (const category of ['data_app_crash', 'data_app_native_crash', 'data_app_anr', 'data_app_wtf']) {
      const result = adb(run, serial, ['shell', 'dumpsys', 'dropbox', '--print', category]);
      if (result.ok) {
        dropboxSuccesses += 1;
        dropbox.push(filterTargetBlocks(result.stdout));
      } else {
        dropboxFailures.push(category);
        manifest.warnings.push(`${category}: ${detail(result)}`);
      }
    }
    const matchingDropBox = dropbox.filter(Boolean).join('\n');
    if (matchingDropBox) {
      manifest.artifacts.push(outputArtifact(
        root, 'android/target-dropbox.txt', matchingDropBox, 'postmortem-ring',
        dropboxFailures.length ? {partial: true, detail: `Unavailable categories: ${dropboxFailures.join(', ')}`} : undefined,
      ));
    } else if (dropboxFailures.length) {
      manifest.artifacts.push(failedArtifact(
        'android/target-dropbox.txt', 'postmortem-ring',
        `Only ${dropboxSuccesses} of 4 DropBox categories were readable; absence cannot be established.`,
      ));
    } else {
      manifest.artifacts.push(emptyArtifact('android/target-dropbox.txt', 'postmortem-ring', 'No retained matching crash or ANR entries.'));
    }
    pullPendingJournal(root, manifest, run, serial, TARGETS[1]);
    pullPendingJournal(root, manifest, run, serial, TARGETS[2]);

    const forward = adb(run, serial, ['forward', 'tcp:0', 'tcp:9000']);
    if (!forward.ok || !/^\d+$/.test(String(forward.stdout).trim())) throw new Error(`ADB forward failed: ${detail(forward)}`);
    forwardedPort = String(forward.stdout).trim();
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    signalCleanupInstalled = true;
    const dump = await collectLogDump(`ws://127.0.0.1:${forwardedPort}/`, {WebSocketImpl});
    const dumpText = dump.records.map((record) => JSON.stringify(record)).join('\n') + (dump.records.length ? '\n' : '');
    if (dump.records.length) {
      manifest.artifacts.push(outputArtifact(root, 'watch/log-dump.jsonl', dumpText, 'postmortem-ring', {complete: dump.complete}));
    } else if (dump.complete) {
      manifest.artifacts.push(emptyArtifact('watch/log-dump.jsonl', 'postmortem-ring', 'No retained watch logs.'));
    } else {
      manifest.artifacts.push(failedArtifact(
        'watch/log-dump.jsonl', 'postmortem-ring', 'LOG_DUMP ended before a complete result was received.',
      ));
    }
    manifest.watch = {
      generations: dump.generations, complete: dump.complete,
      connectionClosed: dump.connectionClosed,
    };

    if (coredump && dump.complete) {
      const relative = 'watch/latest-coredump.core';
      const partial = join(root, `${relative}.${process.pid}.partial`);
      mkdirSync(dirname(partial), {recursive: true, mode: 0o700});
      const result = run('pebble', ['fw', '--phone', `127.0.0.1:${forwardedPort}`, 'coredump', '--fresh', partial], {timeout: 120_000});
      if (result.ok) {
        chmodSync(partial, 0o600);
        const final = join(root, relative);
        renameSync(partial, final);
        const bytes = readFileSync(final);
        manifest.artifacts.push(artifact(relative, bytes, 'latest-only', 'collected', {sideEffect: 'marked-read'}));
      } else {
        if (/No coredump on device/i.test(`${result.stdout}\n${result.stderr}`)) {
          rmSync(partial, {force: true});
          manifest.artifacts.push(emptyArtifact(relative, 'latest-only', 'No unread coredump on device.'));
        } else {
          if (existsSync(partial) && readFileSync(partial).length) {
            chmodSync(partial, 0o600);
            const preservedRelative = 'watch/latest-coredump.partial.core';
            const preserved = join(root, preservedRelative);
            renameSync(partial, preserved);
            manifest.artifacts.push(artifact(
              preservedRelative, readFileSync(preserved), 'latest-only', 'collected',
              {complete: false, sideEffect: 'possibly-marked-read', detail: 'Coredump command failed after producing host bytes.'},
            ));
          } else rmSync(partial, {force: true});
          manifest.artifacts.push(failedArtifact(
            relative, 'latest-only', detail(result), {sideEffect: 'possibly-marked-read'},
          ));
        }
      }
    } else if (coredump) {
      manifest.artifacts.push(unavailableArtifact(
        'watch/latest-coredump.core', 'latest-only',
        'Skipped because LOG_DUMP did not terminate cleanly.',
      ));
    }
  } catch (error) {
    manifest.warnings.push(String(error.message || error).slice(0, 500));
  } finally {
    removeForward();
    if (signalCleanupInstalled) {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    }
  }

  const expected = [
    ...TARGETS.map((packageName) => [`android/${packageName}-exit-info.txt`, 'postmortem-ring']),
    ['android/target-dropbox.txt', 'postmortem-ring'],
    [`android/${TARGETS[1]}-pending.json`, 'local-outbox'],
    [`android/${TARGETS[2]}-pending.json`, 'local-outbox'],
    ['watch/log-dump.jsonl', 'postmortem-ring'],
    ...(coredump ? [['watch/latest-coredump.core', 'latest-only']] : []),
  ];
  for (const [path, persistence] of expected) {
    if (!manifest.artifacts.some((entry) => entry.path === path)) {
      manifest.artifacts.push(unavailableArtifact(path, persistence, 'Collection did not reach this source; see warnings.'));
    }
  }

  const manifestPath = join(root, 'manifest.json');
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const hasEvidence = manifest.artifacts.some(({status}) => status === 'collected' || status === 'empty');
  return {root, manifest, hasEvidence};
}
