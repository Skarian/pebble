import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const MakerClient = require('../src/common/maker_client.js');

test('builds official Maker API status and command endpoints', () => {
  const settings = {baseUrl: 'http://192.168.1.5/apps/api/42/', token: 'a token'};
  assert.equal(MakerClient.endpoint(settings, 'devices/all'),
    'http://192.168.1.5/apps/api/42/devices/all?access_token=a%20token');
  assert.equal(MakerClient.endpoint(settings, 'devices/12/off'),
    'http://192.168.1.5/apps/api/42/devices/12/off?access_token=a%20token');
});

test('requires an HTTP(S) endpoint and token', () => {
  assert.throws(() => MakerClient.validateSettings({baseUrl: 'file:///tmp/x', token: 'x'}), /http/);
  assert.throws(() => MakerClient.validateSettings({baseUrl: 'https://example.test', token: ''}), /token/);
});

function fakeXhr(trigger) {
  return function Fake() {
    this.open = () => {};
    this.send = () => trigger(this);
  };
}

test('network completion is one-shot and command allowlist is narrow', () => {
  const calls = [];
  const maker = MakerClient(() => new (fakeXhr((xhr) => { xhr.status = 0; xhr.onerror(); xhr.onloadend(); }))());
  maker.devices({baseUrl: 'https://example.test/apps/api/1', token: 'x'}, (...args) => calls.push(args));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].type, 'network');
  maker.command({baseUrl: 'https://example.test/apps/api/1', token: 'x'}, '1', 'setCode', (error) => {
    assert.equal(error.message, 'Command is not allowed');
  });
});
