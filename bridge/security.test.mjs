import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedDevRequest,
  jsonHeaders,
  publicResMedError,
  validateConfiguration
} from './security.mjs';

test('development scores require the local marker and reject browser origins', () => {
  assert.equal(isAllowedDevRequest({'x-cpap-dev': '1'}), true);
  assert.equal(isAllowedDevRequest({}), false);
  assert.equal(isAllowedDevRequest({origin: 'https://attacker.example', 'x-cpap-dev': '1'}), false);
  assert.equal('Access-Control-Allow-Origin' in jsonHeaders(false), false);
  assert.equal(jsonHeaders(true)['Access-Control-Allow-Headers'].includes('x-cpap-dev'), false);
});

test('production validates both setup and encryption secrets before startup', () => {
  assert.throws(() => validateConfiguration({
    devEmulator: false, host: '127.0.0.1', username: '', password: '',
    setupToken: 'long-enough-setup', secret: ''
  }), /CPAP_BRIDGE_SECRET/);
  assert.doesNotThrow(() => validateConfiguration({
    devEmulator: false, host: '127.0.0.1', username: '', password: '',
    setupToken: 'long-enough-setup', secret: 'long-enough-secret'
  }));
});

test('development mode remains loopback-only and requires credentials', () => {
  assert.throws(() => validateConfiguration({
    devEmulator: true, host: '0.0.0.0', username: 'u', password: 'p',
    setupToken: '', secret: ''
  }), /127\.0\.0\.1/);
  assert.throws(() => validateConfiguration({
    devEmulator: true, host: '127.0.0.1', username: '', password: '',
    setupToken: '', secret: ''
  }), /MYAIR_USERNAME/);
  assert.doesNotThrow(() => validateConfiguration({
    devEmulator: true, qaEnabled: true, host: '127.0.0.1', username: '', password: '',
    setupToken: '', secret: ''
  }));
});

test('upstream error text is replaced with controlled public messages', () => {
  const sentinel = 'secret-upstream-details';
  const auth = publicResMedError('authentication_failed');
  const service = publicResMedError(sentinel);
  assert.deepEqual(auth, {code: 'authentication_failed', message: 'ResMed sign-in failed'});
  assert.deepEqual(service, {code: 'service_error', message: 'ResMed is unavailable'});
  assert.equal(JSON.stringify({auth, service}).includes(sentinel), false);
});
