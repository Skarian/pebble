import {createHash, randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {mkdirSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {backup, DatabaseSync} from 'node:sqlite';

export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const SQLITE_FULL = 13;

export class StoreError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, {name: 'StoreError', status, code});
  }
}

function passwordHash(password, salt = randomBytes(16)) {
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

function passwordMatches(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!/^[0-9a-f]{32}$/.test(salt || '') || !/^[0-9a-f]{64}$/.test(expected || '')) return false;
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function text(value, name, max = 128) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) {
    throw new StoreError(400, 'invalid_record', `${name} must be a non-empty string of at most ${max} characters`);
  }
}

function validSource(value) {
  return /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?:@[a-zA-Z0-9][a-zA-Z0-9._+-]*)?$/.test(value);
}

function parseInteger(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new StoreError(400, 'invalid_query', `${name} must be a positive integer`);
  }
  return parsed;
}

export function parseSince(value, now = Date.now()) {
  if (!value) return null;
  const duration = /^(\d+)(m|h|d|w)$/.exec(value);
  const time = duration
    ? now - Number(duration[1]) * {m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000}[duration[2]]
    : Date.parse(value);
  if (!Number.isFinite(time) || Number.isNaN(new Date(time).getTime())) {
    throw new StoreError(400, 'invalid_query', 'timestamp must be ISO-8601 or a duration such as 30d');
  }
  return new Date(time).toISOString();
}

function validate(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join() !== 'at,error,id,source,while') {
    throw new StoreError(400, 'invalid_record', 'record must contain only id, at, source, while, and error');
  }
  text(record.id, 'id');
  text(record.at, 'at', 48);
  const time = Date.parse(record.at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at)
      || !Number.isFinite(time) || new Date(time).toISOString() !== record.at) {
    throw new StoreError(400, 'invalid_record', 'at must be a canonical UTC ISO-8601 timestamp');
  }
  text(record.source, 'source');
  if (!validSource(record.source)) throw new StoreError(400, 'invalid_record', 'source has an invalid format');
  text(record.while, 'while', 256);
  const publicRecord = {at: record.at, source: record.source, while: record.while, error: record.error};
  const json = JSON.stringify(publicRecord);
  return {id: record.id, publicRecord, json, hash: createHash('sha256').update(json).digest('hex')};
}

export class DiagnosticsStore {
  constructor(path, {maxBytes = DEFAULT_MAX_BYTES} = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 * 1024) throw new Error('maxBytes must be at least 128 KiB');
    this.path = resolve(path);
    this.maxBytes = maxBytes;
    mkdirSync(dirname(this.path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS credentials(
        fingerprint TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('read','write')), source_prefix TEXT,
        label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS errors(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_fingerprint TEXT NOT NULL REFERENCES credentials(fingerprint),
        record_id TEXT NOT NULL, record_hash TEXT NOT NULL, at TEXT NOT NULL,
        source TEXT NOT NULL, record_json TEXT NOT NULL, received_at INTEGER NOT NULL,
        UNIQUE(source, record_id)
      );
      CREATE INDEX IF NOT EXISTS errors_at ON errors(at);
      CREATE INDEX IF NOT EXISTS errors_source ON errors(source);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_diagnostics_key
        ON credentials(role) WHERE role='write' AND source_prefix IS NULL AND revoked_at IS NULL;
      CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(
        record_json, content='errors', content_rowid='seq'
      );
      CREATE TRIGGER IF NOT EXISTS errors_fts_insert AFTER INSERT ON errors BEGIN
        INSERT INTO errors_fts(rowid,record_json) VALUES(new.seq,new.record_json);
      END;
      CREATE TRIGGER IF NOT EXISTS errors_fts_delete AFTER DELETE ON errors BEGIN
        INSERT INTO errors_fts(errors_fts,rowid,record_json) VALUES('delete',old.seq,old.record_json);
      END;
      INSERT OR IGNORE INTO metadata VALUES('rejected_capacity','0');
    `);
    const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
    this.db.exec(`PRAGMA max_page_count=${Math.floor(maxBytes / pageSize)}`);
  }

  close() { this.db.close(); }

  setAdminPassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 256 || password.includes('\0')) {
      throw new StoreError(400, 'invalid_password', 'administrator password must contain 8 to 256 characters');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setMeta('admin_password_hash', passwordHash(password));
      this.setMeta('admin_auth_version', Number(this.meta('admin_auth_version') || 0) + 1);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  adminConfigured() { return Boolean(this.meta('admin_password_hash')); }
  adminAuthVersion() { return Number(this.meta('admin_auth_version') || 0); }
  verifyAdminPassword(password) {
    return typeof password === 'string' && password.length <= 256
      && passwordMatches(password, this.meta('admin_password_hash'));
  }

  issueReadKey({label = ''} = {}) {
    if (typeof label !== 'string' || label.length > 96 || label.includes('\0')) throw new StoreError(400, 'invalid_label', 'label is too long');
    const token = `pdiag_r_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    const fingerprint = hash.slice(0, 16);
    this.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?,NULL)')
      .run(fingerprint, hash, 'read', null, label, Date.now());
    return {token, fingerprint, role: 'read', source: null, label};
  }

  activeDiagnosticsKey() {
    const row = this.db.prepare(`SELECT fingerprint,created_at FROM credentials
      WHERE role='write' AND source_prefix IS NULL AND revoked_at IS NULL`).get();
    return row ? {fingerprint: row.fingerprint, createdAt: new Date(row.created_at).toISOString()} : null;
  }

  rotateDiagnosticsKey(expectedFingerprint = null) {
    const token = `pdiag_d_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    const fingerprint = hash.slice(0, 16);
    const createdAt = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(`SELECT fingerprint FROM credentials
        WHERE role='write' AND source_prefix IS NULL AND revoked_at IS NULL`).get();
      if ((active?.fingerprint ?? null) !== (expectedFingerprint || null)) {
        throw new StoreError(409, 'key_changed', 'diagnostics key changed; reload before replacing it');
      }
      // A newly issued shared key replaces every older write credential. This
      // keeps the website's "one Diagnostic key" promise true even while a
      // database is migrating from the former per-app keys.
      this.db.prepare(`UPDATE credentials SET revoked_at=?
        WHERE role='write' AND revoked_at IS NULL`).run(createdAt);
      this.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?,NULL)')
        .run(fingerprint, hash, 'write', null, 'shared diagnostics', createdAt);
      this.db.exec('COMMIT');
      return {token, fingerprint, createdAt: new Date(createdAt).toISOString()};
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  revokeKey(fingerprint) {
    text(fingerprint, 'fingerprint', 64);
    const result = this.db.prepare('UPDATE credentials SET revoked_at=? WHERE fingerprint=? AND revoked_at IS NULL')
      .run(Date.now(), fingerprint);
    if (Number(result.changes) !== 1) throw new StoreError(404, 'key_not_found', 'active key not found');
  }

  authorize(token, role) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256) throw new StoreError(401, 'unauthorized', 'valid diagnostics key required');
    const hash = createHash('sha256').update(token).digest('hex');
    const key = this.db.prepare('SELECT fingerprint,role,source_prefix,revoked_at FROM credentials WHERE token_hash=?').get(hash);
    if (!key || key.revoked_at) throw new StoreError(401, 'unauthorized', 'valid diagnostics key required');
    if (key.role !== role) throw new StoreError(403, 'forbidden', `${role} key required`);
    return key;
  }

  ingest(key, records) {
    if (!Array.isArray(records) || !records.length || records.length > 50) throw new StoreError(400, 'invalid_batch', 'records must contain 1 to 50 items');
    const ids = new Set();
    const items = records.map((record) => {
      const item = validate(record);
      if (ids.has(item.id)) throw new StoreError(400, 'invalid_batch', 'record ids must be unique within a batch');
      ids.add(item.id);
      if (key.source_prefix !== null && !(item.publicRecord.source === key.source_prefix
          || item.publicRecord.source.startsWith(`${key.source_prefix}/`)
          || item.publicRecord.source.startsWith(`${key.source_prefix}@`))) {
        throw new StoreError(403, 'source_forbidden', 'record source is outside this key prefix');
      }
      return item;
    });
    const lookup = this.db.prepare('SELECT record_hash FROM errors WHERE source=? AND record_id=?');
    const fresh = items.filter((item) => {
      const prior = lookup.get(item.publicRecord.source, item.id);
      if (prior && prior.record_hash !== item.hash) throw new StoreError(409, 'id_conflict', 'record id already has different content');
      return !prior;
    });
    const estimate = fresh.reduce((sum, item) => sum + Math.max(4096, Buffer.byteLength(item.json) * 4), 0);
    if (fresh.length && this.databaseBytes() + estimate > this.maxBytes) {
      this.bumpRejected(items.length);
      throw new StoreError(507, 'capacity_exceeded', 'diagnostics storage capacity reached');
    }
    const insert = this.db.prepare('INSERT INTO errors(credential_fingerprint,record_id,record_hash,at,source,record_json,received_at) VALUES(?,?,?,?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of fresh) insert.run(key.fingerprint, item.id, item.hash, item.publicRecord.at, item.publicRecord.source, item.json, Date.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.errcode !== SQLITE_FULL) throw error;
      this.bumpRejected(items.length);
      throw new StoreError(507, 'capacity_exceeded', 'diagnostics storage capacity reached');
    }
    return items.map(({id}) => id);
  }

  list(options = {}) { return this.read(options); }
  search({q, ...options} = {}) { text(q, 'q', 256); return this.read(options, q); }

  read({since, source, limit, before} = {}, query = null) {
    const where = [], params = [];
    const start = parseSince(since);
    if (start) { where.push('at>=?'); params.push(start); }
    if (source) {
      text(source, 'source');
      if (!validSource(source)) throw new StoreError(400, 'invalid_query', 'source has an invalid format');
      where.push('(source=? OR source GLOB ? OR source GLOB ?)');
      params.push(source, `${source}@*`, `${source}/*`);
    }
    const cursor = parseInteger(before, 'before', null);
    if (cursor) { where.push('seq<?'); params.push(cursor); }
    if (query) {
      where.push('seq IN(SELECT rowid FROM errors_fts WHERE errors_fts MATCH ?)');
      params.push(`"${query.replaceAll('"', '""')}"`);
    }
    const count = parseInteger(limit, 'limit', 100);
    if (count > 500) throw new StoreError(400, 'invalid_query', 'limit cannot exceed 500');
    const rows = this.db.prepare(`SELECT seq,record_json FROM errors ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`).all(...params, count);
    return {records: rows.map(({record_json}) => JSON.parse(record_json)), next: rows.length === count ? Number(rows.at(-1).seq) : null};
  }

  status() {
    const row = this.db.prepare('SELECT count(*) records,min(at) oldest,max(at) newest FROM errors').get();
    const databaseBytes = this.databaseBytes();
    const lastBackupAt = this.meta('last_backup_at');
    return {
      records: Number(row.records), oldestAt: row.oldest, newestAt: row.newest,
      databaseBytes, maxBytes: this.maxBytes, capacityFull: databaseBytes >= this.maxBytes,
      rejectedAtCapacity: Number(this.meta('rejected_capacity') || 0), lastBackupAt,
      backupAgeSeconds: lastBackupAt
        ? Math.max(0, Math.floor((Date.now() - Date.parse(lastBackupAt)) / 1000)) : null,
    };
  }

  health() { return this.db.prepare('SELECT 1 ok').get().ok === 1; }

  purgeBefore(value) {
    const result = this.db.prepare('DELETE FROM errors WHERE at<?').run(parseSince(value));
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    return Number(result.changes);
  }

  backupTo(path) { return backup(this.db, path); }
  markBackupComplete() { this.setMeta('last_backup_at', new Date().toISOString()); }

  databaseBytes() {
    return [this.path, `${this.path}-wal`, `${this.path}-shm`].reduce((sum, path) => {
      try { return sum + statSync(path).size; } catch (error) { if (error.code === 'ENOENT') return sum; throw error; }
    }, 0);
  }

  meta(key) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value ?? null; }
  setMeta(key, value) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  bumpRejected(count) { this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+? WHERE key='rejected_capacity'").run(count); }
}
