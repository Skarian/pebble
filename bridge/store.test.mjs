import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {decryptJson, encryptJson, SessionStore, tokenHash} from './store.mjs';

const secret = 'test-only-secret-that-is-long-enough';

test('encrypts and decrypts credentials', () => {
  const encrypted = encryptJson({username: 'person@example.com', password: 'secret'}, secret);
  assert.equal(JSON.stringify(encrypted).includes('person@example.com'), false);
  assert.deepEqual(decryptJson(encrypted, secret), {
    username: 'person@example.com',
    password: 'secret'
  });
});

test('stores only hashed opaque tokens and encrypted credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cpap-bridge-'));
  const path = join(directory, 'sessions.json');
  const store = new SessionStore(path, secret);
  const token = await store.create({username: 'person@example.com', password: 'secret'});
  const raw = await readFile(path, 'utf8');

  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes('person@example.com'), false);
  assert.equal(raw.includes('secret'), false);
  assert.equal(raw.includes(tokenHash(token)), true);
  assert.equal(store.get(token).username, 'person@example.com');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
