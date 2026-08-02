import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ResMedError,
  isRetryableStatus,
  isTransientResMedError,
  retryTransient
} from './resmed.mjs';

test('retries one transient failure after one delay', async () => {
  let attempts = 0;
  let waits = 0;
  const result = await retryTransient(async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('slow'), {name: 'TimeoutError'});
    return 'ok';
  }, async () => { waits += 1; });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test('retries only network failures and upstream gateway errors', () => {
  assert.deepEqual([429, 500, 501, 502, 503, 504].filter(isRetryableStatus), [502, 503, 504]);
  assert.equal(isTransientResMedError(Object.assign(new TypeError('network'), {
    cause: {code: 'ECONNRESET'}
  })), true);
  assert.equal(isTransientResMedError(new ResMedError('service_error', 'bad gateway', 502, 502)), true);
  assert.equal(isTransientResMedError(new ResMedError('service_error', 'unavailable', 502, 503)), true);
  assert.equal(isTransientResMedError(new ResMedError('service_error', 'timeout', 502, 504)), true);
  assert.equal(isTransientResMedError(new ResMedError('authentication_failed', 'no', 401, 401)), false);
  assert.equal(isTransientResMedError(new ResMedError('service_error', 'limited', 502, 429)), false);
  assert.equal(isTransientResMedError(new ResMedError('service_error', 'server', 502, 500)), false);
  assert.equal(isTransientResMedError(new ResMedError('invalid_token', 'bad token')), false);
  assert.equal(isTransientResMedError(new TypeError('programming error')), false);
});

test('does not retry a second failure', async () => {
  let attempts = 0;
  await assert.rejects(retryTransient(async () => {
    attempts += 1;
    throw new ResMedError('service_error', 'unavailable', 502, 503);
  }, async () => {}), /unavailable/);
  assert.equal(attempts, 2);
});
