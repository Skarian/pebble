#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseArgs} from 'node:util';
import {DEFAULT_MAX_BYTES, DiagnosticsStore, StoreError} from './store.mjs';

const USAGE = `Usage:
  admin.mjs admin set-password < password-file
  admin.mjs key issue --role read [--label TEXT]
  admin.mjs key revoke --fingerprint HEX
  admin.mjs purge --before 90d|TIMESTAMP
  admin.mjs backup (--output FILE | --output-dir DIR) [--age-recipient-file FILE]`;

const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_NAME = /^pebble-diagnostics-\d{8}T\d{6}\.\d{3}Z\.sqlite3(?:\.age)?$/;

function need(options, name) {
  if (!options[name]) throw new Error(`--${name} is required`);
  return options[name];
}

function pruneBackups(directory, now = Date.now()) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    if (!entry.isFile() || !BACKUP_NAME.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (statSync(path).mtimeMs < now - BACKUP_RETENTION_MS) unlinkSync(path);
  }
}

async function makeBackup(store, options) {
  if (options.output && options['output-dir']) throw new Error('use either --output or --output-dir');
  const recipientFile = options['age-recipient-file'] ? resolve(options['age-recipient-file']) : null;
  if (recipientFile && !readFileSync(recipientFile, 'utf8').trim()) throw new Error('age recipient file is empty');
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '');
  const output = resolve(options.output || join(need(options, 'output-dir'), `pebble-diagnostics-${stamp}.sqlite3${recipientFile ? '.age' : ''}`));
  if (existsSync(output)) throw new Error(`backup already exists: ${output}`);
  mkdirSync(dirname(output), {recursive: true, mode: 0o700});
  const scratch = mkdtempSync(join(process.env.PEBBLE_DIAGNOSTICS_BACKUP_TMP || tmpdir(), 'pebble-diagnostics-'));
  const plain = join(scratch, 'backup.sqlite3');
  const staged = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
  try {
    await store.backupTo(plain);
    const snapshot = new DatabaseSync(plain, {readOnly: true});
    try {
      if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite backup integrity check failed');
    } finally { snapshot.close(); }
    if (recipientFile) {
      const age = spawnSync('age', ['--encrypt', '--recipients-file', recipientFile, '--output', staged, plain], {encoding: 'utf8'});
      if (age.error) throw age.error;
      if (age.status !== 0) throw new Error(`age failed: ${age.stderr.trim()}`);
    } else copyFileSync(plain, staged);
    if (!statSync(staged).size) throw new Error('backup output is empty');
    chmodSync(staged, 0o600);
    renameSync(staged, output);
    if (options['output-dir']) pruneBackups(dirname(output));
    store.markBackupComplete();
    return output;
  } finally {
    rmSync(staged, {force: true});
    rmSync(scratch, {recursive: true, force: true});
  }
}

async function main() {
  const parsed = parseArgs({args: process.argv.slice(2), allowPositionals: true, options: {
    role: {type: 'string'}, label: {type: 'string'}, fingerprint: {type: 'string'},
    before: {type: 'string'}, output: {type: 'string'}, 'output-dir': {type: 'string'},
    'age-recipient-file': {type: 'string'},
  }});
  const command = parsed.positionals.join(' '), options = parsed.values;
  const database = process.env.PEBBLE_DIAGNOSTICS_DB || new URL('./data/errors.sqlite3', import.meta.url).pathname;
  const maxBytes = Number(process.env.PEBBLE_DIAGNOSTICS_MAX_BYTES || DEFAULT_MAX_BYTES);
  const store = new DiagnosticsStore(database, {maxBytes});
  try {
    if (command === 'admin set-password') {
      const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      store.setAdminPassword(password);
      console.log(JSON.stringify({adminPasswordUpdated: true}));
    } else if (command === 'key issue') {
      if (need(options, 'role') !== 'read') throw new Error('only read keys are issued from the command line');
      console.log(JSON.stringify(store.issueReadKey({label: options.label || ''})));
    } else if (command === 'key revoke') {
      const fingerprint = need(options, 'fingerprint');
      store.revokeKey(fingerprint);
      console.log(JSON.stringify({revoked: fingerprint}));
    } else if (command === 'purge') {
      console.log(JSON.stringify({purged: store.purgeBefore(need(options, 'before'))}));
    } else if (command === 'backup') {
      console.log(JSON.stringify({backup: await makeBackup(store, options)}));
    } else throw new Error(USAGE);
  } finally { store.close(); }
}

main().catch((error) => {
  console.error(error instanceof StoreError ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
});
