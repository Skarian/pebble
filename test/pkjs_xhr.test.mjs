import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const createXhrJson = require('../src/common/xhr_json.js');

test('bridge URLs require HTTPS except literal emulator loopback', () => {
  assert.equal(createXhrJson.isAllowedBridgeUrl('https://cpap.example.com', false), true);
  assert.equal(createXhrJson.isAllowedBridgeUrl('http://cpap.example.com', false), false);
  assert.equal(createXhrJson.isAllowedBridgeUrl('http://127.0.0.1:8787', true), true);
  assert.equal(createXhrJson.isAllowedBridgeUrl('http://localhost:8787', true), false);
});

function fakeXhr(scenario) {
  function Fake() {
    this.headers = {};
    this.status = null;
    Fake.instance = this;
  }
  Fake.prototype.open = function () {};
  Fake.prototype.setRequestHeader = function (name, value) {
    this.headers[name] = value;
  };
  Fake.prototype.send = function () {
    scenario(this);
  };
  return Fake;
}

function invoke(scenario, callback, extraHeaders) {
  const Fake = fakeXhr(scenario);
  createXhrJson(Fake)('GET', 'http://127.0.0.1/test', '', null, callback, extraHeaders);
  return Fake.instance;
}

test('successful load followed by loadend completes once', () => {
  const calls = [];
  const xhr = invoke((xhr) => {
    xhr.status = 200;
    xhr.responseText = '{"ok":true}';
    xhr.onload();
    xhr.onloadend();
  }, (...args) => calls.push(args), {'X-CPAP-Dev': '1'});
  assert.deepEqual(calls, [[null, {ok: true}]]);
  assert.equal(xhr.headers['X-CPAP-Dev'], '1');
  assert.equal(xhr.timeout, 30000);
});

test('pypkjs status-zero loadend becomes one network error', () => {
  const calls = [];
  invoke((xhr) => {
    xhr.status = 0;
    xhr.onloadend();
  }, (...args) => calls.push(args));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].type, 'network');
});

test('timeout and error remain one-shot when loadend follows', () => {
  for (const event of ['ontimeout', 'onerror']) {
    const calls = [];
    invoke((xhr) => {
      xhr[event]();
      xhr.onloadend();
    }, (...args) => calls.push(args));
    assert.equal(calls.length, 1);
  }
});

test('invalid and hostile bridge responses use controlled messages', () => {
  const invalid = [];
  invoke((xhr) => {
    xhr.status = 200;
    xhr.responseText = 'not json';
    xhr.onload();
  }, (...args) => invalid.push(args));
  assert.equal(invalid[0][0].message, 'Invalid bridge response');

  const hostile = [];
  invoke((xhr) => {
    xhr.status = 401;
    xhr.responseText = '{"error":"secret-upstream-details","code":"authentication_failed"}';
    xhr.onload();
  }, (...args) => hostile.push(args));
  assert.equal(hostile[0][0].message, 'ResMed sign-in failed');
  assert.equal(JSON.stringify(hostile).includes('secret-upstream-details'), false);
});
