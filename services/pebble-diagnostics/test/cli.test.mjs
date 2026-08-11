import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {DiagnosticsStore} from '../store.mjs';
import {createApiClient, fetchRecords} from '../../../tools/pebble-errors';
import {
  collectEvidence, collectLogDump, decodeLogFrame, encodeLogRequest, filterTargetBlocks,
} from '../../../tools/lib/collect-evidence.mjs';

const run = promisify(execFile);
const admin = new URL('../admin.mjs', import.meta.url).pathname;
const query = new URL('../../../tools/pebble-errors', import.meta.url).pathname;

function testRecord(id, at, message = 'needle in raw error') {
  return {
    id, at, source: 'agents/android@1.0.0', while: 'testing command tools',
    error: {name: 'ToolError', message},
  };
}

function terminalFrame(command, cookie) {
  const frame = Buffer.alloc(10);
  frame[0] = 0;
  frame.writeUInt16BE(5, 1);
  frame.writeUInt16BE(2002, 3);
  frame[5] = command;
  frame.writeUInt32BE(cookie, 6);
  return frame;
}

function lineFrame(cookie, message = 'boom') {
  const body = Buffer.from(message);
  const payload = Buffer.alloc(29 + body.length);
  payload[0] = 0x80;
  payload.writeUInt32BE(cookie, 1);
  payload.writeUInt32BE(0x65f01234, 5);
  payload[9] = 1;
  payload[10] = body.length;
  payload.writeUInt16BE(107, 11);
  Buffer.from('fault_handling.c').copy(payload, 13);
  body.copy(payload, 29);
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt16BE(payload.length, 1);
  frame.writeUInt16BE(2002, 3);
  payload.copy(frame, 5);
  return frame;
}

function fakeWebSocket(responder) {
  return class {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.dispatch('open', {}));
    }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) {
      this.listeners.get(type)?.delete(callback);
    }
    dispatch(type, event) {
      for (const callback of this.listeners.get(type) || []) callback(event);
    }
    send(value) {
      responder(this, Buffer.from(value));
    }
    close() {
      this.readyState = 3;
      this.dispatch('close', {});
    }
  };
}

test('admin issues and revokes keys, purges records, and creates a consistent backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pebble-diagnostics-admin-'));
  const database = join(directory, 'errors.sqlite3');
  const env = {...process.env, PEBBLE_DIAGNOSTICS_DB: database};
  try {
    const password = spawnSync(process.execPath, [admin, 'admin', 'set-password'], {
      env, input: 'a locally supplied administrator password\n', encoding: 'utf8',
    });
    assert.equal(password.status, 0, password.stderr);
    assert.deepEqual(JSON.parse(password.stdout), {adminPasswordUpdated: true});
    const configured = new DiagnosticsStore(database);
    assert.equal(configured.verifyAdminPassword('a locally supplied administrator password'), true);
    configured.close();

    const issued = JSON.parse((await run(process.execPath, [
      admin, 'key', 'issue', '--role', 'read', '--label', 'test',
    ], {env})).stdout);
    assert.match(issued.token, /^pdiag_r_/);

    const store = new DiagnosticsStore(database);
    const writer = store.rotateDiagnosticsKey();
    store.ingest(store.authorize(writer.token, 'write'), [
      testRecord('old', '2020-01-01T00:00:00.000Z'),
      testRecord('new', new Date().toISOString()),
    ]);
    store.close();

    const recipient = join(directory, 'recipient.txt');
    const failedOutput = join(directory, 'failed.sqlite3.age');
    writeFileSync(recipient, 'age1example-public-recipient\n');
    await assert.rejects(run(process.execPath, [
      admin, 'backup', '--output', failedOutput, '--age-recipient-file', recipient,
    ], {env: {...env, PATH: '/nonexistent'}}), /age/);
    assert.equal(existsSync(failedOutput), false);
    const afterFailure = new DiagnosticsStore(database);
    assert.equal(afterFailure.status().lastBackupAt, null);
    afterFailure.close();

    const output = join(directory, 'snapshot.sqlite3');
    const backedUp = JSON.parse((await run(process.execPath, [
      admin, 'backup', '--output', output,
    ], {env})).stdout);
    assert.equal(backedUp.backup, output);
    const snapshot = new DatabaseSync(output, {readOnly: true});
    assert.equal(snapshot.prepare('SELECT count(*) AS count FROM errors').get().count, 2);
    snapshot.close();

    const backups = join(directory, 'backups');
    const oldBackup = join(backups, 'pebble-diagnostics-20200101T000000.000Z.sqlite3.age');
    const unrelated = join(backups, 'keep.txt');
    mkdirSync(backups);
    writeFileSync(oldBackup, 'expired');
    writeFileSync(unrelated, 'unrelated');
    const expired = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(oldBackup, expired, expired);
    utimesSync(unrelated, expired, expired);
    await run(process.execPath, [admin, 'backup', '--output-dir', backups], {env});
    assert.equal(existsSync(oldBackup), false);
    assert.equal(existsSync(unrelated), true);

    const purged = JSON.parse((await run(process.execPath, [
      admin, 'purge', '--before', '1d',
    ], {env})).stdout);
    assert.equal(purged.purged, 1);
    await run(process.execPath, [
      admin, 'key', 'revoke', '--fingerprint', issued.fingerprint,
    ], {env});

    const reopened = new DiagnosticsStore(database);
    assert.throws(() => reopened.authorize(issued.token, 'read'), /valid diagnostics key required/);
    assert.equal(reopened.status().records, 1);
    assert.ok(reopened.status().lastBackupAt);
    reopened.close();
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('pebble-errors uses authenticated GET requests and follows page cursors', async () => {
  const records = [
    {at: '2026-08-10T13:00:00.000Z', source: 'agents/android@1', while: 'testing', error: {message: 'one'}},
    {at: '2026-08-10T12:00:00.000Z', source: 'agents/watch@1', while: 'testing', error: {message: 'two'}},
  ];
  const calls = [];
  const client = createApiClient({
    base: 'https://pebble.example/',
    key: 'read-secret',
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      const before = url.searchParams.get('before');
      const body = before ? {records: [records[1]], next: null} : {records: [records[0]], next: 7};
      return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
    },
  });
  const result = await fetchRecords(client, '/v1/errors', {since: '30d', limit: '2'});
  assert.deepEqual(result, records);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers['X-Pebble-Diagnostics-Key'], 'read-secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].url.searchParams.get('before'), '7');
  assert.equal(Object.hasOwn(result[0], 'id'), false);
});

test('LOG_DUMP framing validates lengths and preserves source fault bytes', () => {
  assert.equal(encodeLogRequest(2, 0x01020304).toString('hex'), '01000607d2100201020304');
  const decoded = decodeLogFrame(lineFrame(0x01020304), 0x01020304, 7);
  assert.equal(decoded.kind, 'line');
  assert.deepEqual({...decoded.record, raw: undefined}, {
    generation: 7,
    timestamp: 0x65f01234,
    at: '2024-03-12T08:28:36.000Z',
    level: 1,
    line: 107,
    file: 'fault_handling.c',
    message: 'boom',
    raw: undefined,
  });
  assert.match(decoded.record.raw, /^8001020304/);
  assert.equal(decodeLogFrame(lineFrame(0x01020305), 0x01020304, 7).kind, 'ignore');
  const malformed = lineFrame(0x01020304);
  malformed.writeUInt16BE(malformed.readUInt16BE(1) + 1, 1);
  assert.equal(decodeLogFrame(malformed, 0x01020304, 7).kind, 'invalid');
});

test('LOG_DUMP serializes generations, ignores unrelated frames, and reports partial data', async () => {
  const sent = [];
  const CompleteSocket = fakeWebSocket((socket, request) => {
    sent.push(request[6]);
    const cookie = request.readUInt32BE(7);
    queueMicrotask(() => {
      socket.dispatch('message', {data: Buffer.from('0700ff', 'hex')});
      socket.dispatch('message', {data: lineFrame(cookie + 1)});
      if (request[6] === 0) {
        socket.dispatch('message', {data: lineFrame(cookie, 'App fault! {uuid}')});
        socket.dispatch('message', {data: terminalFrame(0x81, cookie)});
      } else {
        socket.dispatch('message', {data: terminalFrame(0x82, cookie)});
      }
    });
  });
  const complete = await collectLogDump('ws://test/', {
    WebSocketImpl: CompleteSocket, cookieFactory: () => 0x01020304,
  });
  assert.deepEqual(sent, [0, 1]);
  assert.equal(complete.complete, true);
  assert.equal(complete.records.length, 1);
  assert.equal(complete.records[0].message, 'App fault! {uuid}');

  const PartialSocket = fakeWebSocket((socket, request) => {
    const cookie = request.readUInt32BE(7);
    queueMicrotask(() => {
      socket.dispatch('message', {data: lineFrame(cookie)});
      socket.dispatch('message', {data: terminalFrame(0x82, cookie)});
    });
  });
  const partial = await collectLogDump('ws://test/', {
    WebSocketImpl: PartialSocket, cookieFactory: () => 0x01020304,
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.records.length, 1);
  assert.equal(partial.generations[0].terminal, 'incomplete');
});

test('collector keeps sources independent and always removes its ADB forward', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pebble-evidence-'));
  const directory = join(parent, 'bundle');
  const calls = [];
  let coredumpFails = false;
  const signalListeners = {
    interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM'),
  };
  const serial = 'adb-test-device';
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(' ');
    if (joined === 'devices -l') return {ok: true, status: 0, stdout: `List of devices attached\n${serial}\tdevice model:Phone\n`, stderr: ''};
    if (joined.includes('pm path --user 0 coredevices.coreapp')) return {ok: true, status: 0, stdout: 'package:/data/app/core/base.apk\n', stderr: ''};
    if (joined.includes('forward tcp:0 tcp:9000')) return {ok: true, status: 0, stdout: '19000\n', stderr: ''};
    if (joined.includes('forward --remove tcp:19000')) return {ok: true, status: 0, stdout: '', stderr: ''};
    if (joined.includes('dumpsys activity exit-info')) return {ok: true, status: 0, stdout: 'retained exit evidence\n', stderr: ''};
    if (joined.includes('dumpsys dropbox') && joined.includes('data_app_native_crash')) {
      return {ok: false, status: 1, stdout: '', stderr: 'DropBox temporarily unavailable'};
    }
    if (joined.includes('dumpsys dropbox')) return {ok: true, status: 0, stdout: 'unrelated.package only\n', stderr: ''};
    if (joined.includes('run-as com.skarian.agentscompanion')) {
      return {ok: true, status: 0, stdout: '{"version":1,"records":[{"error":{"message":"No such file"}}]}', stderr: ''};
    }
    if (joined.includes('run-as')) {
      return {ok: true, status: 0, stdout: 'cat: no_backup/pebble-errors-v1.json: No such file or directory\n', stderr: ''};
    }
    if (command === 'pebble' && joined.includes('coredump --fresh')) {
      writeFileSync(args.at(-1), Buffer.from('test coredump'));
      return coredumpFails
        ? {ok: false, status: 1, stdout: '', stderr: 'host write failed'}
        : {ok: true, status: 0, stdout: 'Coredump downloaded\n', stderr: ''};
    }
    return {ok: false, status: 1, stdout: '', stderr: `unexpected command: ${joined}`};
  };
  const EmptySocket = fakeWebSocket((socket, request) => {
    const cookie = request.readUInt32BE(7);
    queueMicrotask(() => socket.dispatch('message', {data: terminalFrame(0x82, cookie)}));
  });
  try {
    const result = await collectEvidence({
      out: directory, adbSerial: serial, server: {error: 'read key unavailable'},
      coredump: true, run: runCommand, WebSocketImpl: EmptySocket,
    });
    assert.equal(result.root, directory);
    assert.equal(result.manifest.artifacts.find(({path}) => path === 'server/errors.json').status, 'unavailable');
    assert.equal(result.manifest.artifacts.find(({path}) => path === 'watch/log-dump.jsonl').status, 'empty');
    const agentsPending = result.manifest.artifacts.find(({path}) => path.includes('agentscompanion-pending'));
    assert.equal(agentsPending.status, 'collected');
    assert.match(readFileSync(join(directory, agentsPending.path), 'utf8'), /No such file/);
    assert.equal(result.manifest.artifacts.find(({path}) => path.includes('airquality-pending')).status, 'empty');
    assert.equal(result.manifest.artifacts.find(({path}) => path === 'android/target-dropbox.txt').status, 'failed');
    assert.equal(result.manifest.artifacts.find(({path}) => path === 'android/core-private-log.txt').status, 'unavailable');
    assert.equal(result.manifest.artifacts.find(({path}) => path === 'android/cpap-pkjs-pending.json').status, 'unavailable');
    const coredump = result.manifest.artifacts.find(({path}) => path === 'watch/latest-coredump.core');
    assert.equal(coredump.status, 'collected');
    assert.equal(coredump.sideEffect, 'marked-read');
    assert.equal(statSync(join(directory, coredump.path)).mode & 0o777, 0o600);
    assert.equal(result.hasEvidence, true);
    await assert.rejects(collectEvidence({out: directory}), /output already exists/);

    coredumpFails = true;
    const failedDirectory = join(parent, 'failed-coredump-bundle');
    const failed = await collectEvidence({
      out: failedDirectory, adbSerial: serial, server: {records: []},
      coredump: true, run: runCommand, WebSocketImpl: EmptySocket,
    });
    const partial = failed.manifest.artifacts.find(({path}) => path === 'watch/latest-coredump.partial.core');
    assert.equal(partial.status, 'collected');
    assert.equal(partial.complete, false);
    assert.equal(partial.sideEffect, 'possibly-marked-read');
    assert.equal(readFileSync(join(failedDirectory, partial.path), 'utf8'), 'test coredump');
    assert.equal(failed.manifest.artifacts.find(({path}) => path === 'watch/latest-coredump.core').status, 'failed');
    assert.ok(calls.some((call) => call.join(' ').includes('forward --remove tcp:19000')));
    assert.equal(process.listenerCount('SIGINT'), signalListeners.interrupt);
    assert.equal(process.listenerCount('SIGTERM'), signalListeners.terminate);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, 'manifest.json')).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(join(directory, 'manifest.json'), 'utf8'), /pdiag_/);
  } finally {
    rmSync(parent, {recursive: true, force: true});
  }
});

test('pebble-errors rejects options that a command would otherwise ignore', () => {
  const rejected = spawnSync(process.execPath, [query, 'collect', '--json'], {encoding: 'utf8'});
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /unsupported option for collect: --json/);
});

test('DropBox filtering retains only exact target-containing blocks', () => {
  const value = `Drop box contents:\n==========\nProcess: unrelated.app\nsecret\n==========\nProcess: coredevices.coreapp\nraw crash\n`;
  const filtered = filterTargetBlocks(value);
  assert.doesNotMatch(filtered, /unrelated\.app|secret/);
  assert.match(filtered, /coredevices\.coreapp\nraw crash/);
});

test('encrypted backup decrypts to a valid, restorable SQLite snapshot when age is installed', async (t) => {
  try {
    await run('age', ['--version']);
    await run('age-keygen', ['--version']);
  } catch {
    t.skip('age is not installed');
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), 'pebble-diagnostics-age-'));
  const database = join(directory, 'errors.sqlite3');
  const identity = join(directory, 'identity.txt');
  const recipient = join(directory, 'recipient.txt');
  const encrypted = join(directory, 'snapshot.sqlite3.age');
  const restored = join(directory, 'restored.sqlite3');
  const env = {...process.env, PEBBLE_DIAGNOSTICS_DB: database};
  try {
    const issued = new DiagnosticsStore(database);
    const key = issued.rotateDiagnosticsKey();
    issued.ingest(issued.authorize(key.token, 'write'), [
      testRecord('restore-me', '2026-08-10T12:00:00.000Z'),
    ]);
    issued.close();

    await run('age-keygen', ['--output', identity]);
    writeFileSync(recipient, (await run('age-keygen', ['-y', identity])).stdout);
    await run(process.execPath, [
      admin, 'backup', '--output', encrypted, '--age-recipient-file', recipient,
    ], {env});
    await run('age', ['--decrypt', '--identity', identity, '--output', restored, encrypted]);
    const snapshot = new DatabaseSync(restored, {readOnly: true});
    assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(snapshot.prepare('SELECT count(*) count FROM errors').get().count, 1);
    snapshot.close();
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
