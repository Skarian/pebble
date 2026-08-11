import {createDiagnosticsServer} from './http.mjs';
import {DEFAULT_MAX_BYTES, DiagnosticsStore} from './store.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function integerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const host = process.env.PEBBLE_DIAGNOSTICS_HOST || '127.0.0.1';
const port = integerEnv('PEBBLE_DIAGNOSTICS_PORT', 8000);
const dbPath = process.env.PEBBLE_DIAGNOSTICS_DB || new URL('./data/errors.sqlite3', import.meta.url).pathname;
const maxBytes = integerEnv('PEBBLE_DIAGNOSTICS_MAX_BYTES', DEFAULT_MAX_BYTES);
const credentialPath = process.env.CREDENTIALS_DIRECTORY
  ? join(process.env.CREDENTIALS_DIRECTORY, 'pebble-session') : null;
const sessionSecret = (process.env.PEBBLE_DIAGNOSTICS_SESSION_SECRET
  || (credentialPath ? readFileSync(credentialPath, 'utf8') : '')).trim();
if (sessionSecret && sessionSecret.length < 32) throw new Error('diagnostics session secret must contain at least 32 characters');
const store = new DiagnosticsStore(dbPath, {maxBytes});
const server = createDiagnosticsServer({
  store, sessionSecret,
  publicUrl: process.env.PEBBLE_DIAGNOSTICS_PUBLIC_URL || 'https://pebble.exe.xyz',
});

server.on('error', (error) => {
  console.error('Pebble Diagnostics server failed', error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Pebble Diagnostics listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit();
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
