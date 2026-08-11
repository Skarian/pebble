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

test('reports the exact synchronous XHR source error with token redaction context', () => {
  const source = new Error('XHR construction failed');
  const reports = [];
  let result;
  const maker = MakerClient(() => { throw source; }, {
    reportError: (error, whileDoing, secrets) => reports.push({error, whileDoing, secrets}),
  });

  maker.devices({baseUrl: 'https://example.test/apps/api/1', token: 'private-token'},
    (error) => { result = error; });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].error, source);
  assert.equal(reports[0].whileDoing, 'starting a Hubitat request');
  assert.deepEqual(reports[0].secrets, ['private-token']);
  assert.equal(result, source);
});

test('HTTP failures preserve status, headers, body, method, and redacted URL context', () => {
  const reports = [];
  let result;
  const maker = MakerClient(() => ({
    open() {},
    getAllResponseHeaders: () => 'content-type: application/json\r\nx-request-id: abc',
    send() {
      this.readyState = 4; this.status = 503; this.statusText = 'Unavailable';
      this.responseText = '{"error":"hub offline"}'; this.onreadystatechange();
    },
  }), {reportError: (error, whileDoing, secrets) => reports.push({error, whileDoing, secrets})});

  maker.devices({baseUrl: 'https://example.test/apps/api/1', token: 'private-token'},
    (error) => { result = error; });

  assert.equal(reports.length, 1);
  assert.equal(reports[0].error, result);
  assert.equal(result.name, 'HubitatHttpError');
  assert.equal(result.status, 503);
  assert.equal(result.statusText, 'Unavailable');
  assert.match(result.headers, /x-request-id: abc/);
  assert.equal(result.body, '{"error":"hub offline"}');
  assert.equal(result.method, 'GET');
  assert.match(result.url, /access_token=private-token/);
  assert.deepEqual(reports[0].secrets, ['private-token']);
});

test('invalid JSON reports the original SyntaxError with the bounded source body', () => {
  const reports = [];
  let result;
  const response = '{"id":"42","label":"Kitchen"';
  const maker = MakerClient(() => ({
    open() {}, getAllResponseHeaders: () => 'content-type: application/json',
    send() {
      this.readyState = 4; this.status = 200; this.statusText = 'OK';
      this.responseText = response; this.onreadystatechange();
    },
  }), {reportError: (error) => reports.push(error)});

  maker.devices({baseUrl: 'https://example.test/apps/api/1', token: 'private-token'},
    (error) => { result = error; });

  assert.equal(reports.length, 1);
  assert.equal(reports[0], result);
  assert.equal(result.name, 'SyntaxError');
  assert.equal(result.status, 200);
  assert.equal(result.responseBytes, response.length);
  assert.equal(result.body, response);
});

test('timeout reports one enriched source error with the original event context', () => {
  const reports = [];
  const prototype = {type: 'timeout', loaded: 0, total: 10, lengthComputable: true};
  const event = Object.create(prototype);
  let result;
  const maker = MakerClient(() => ({
    open() {},
    send() { this.status = 0; this.ontimeout(event); this.onloadend(event); },
  }), {reportError: (error) => reports.push(error)});

  maker.devices({baseUrl: 'https://example.test/apps/api/1', token: 'private-token'},
    (error) => { result = error; });

  assert.deepEqual(reports, [result]);
  assert.equal(result.name, 'HubitatTimeoutError');
  assert.equal(result.type, 'timeout');
  assert.equal(result.original, event);
  assert.deepEqual(result.event, prototype);
});
