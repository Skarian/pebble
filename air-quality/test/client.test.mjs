import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const Client = require('../src/common/aranet_client');

function FakeXHR() { this.headers = {}; FakeXHR.last = this; }
FakeXHR.prototype.open = function (method, url) { this.method = method; this.url = url; };
FakeXHR.prototype.setRequestHeader = function (name, value) { this.headers[name] = value; };
FakeXHR.prototype.send = function () {};

test('uses one direct Aranet seven-day HTTPS request', () => {
  Client(FakeXHR).fetchSnapshot({sharingId: 'sensor 1', apiCredential: 'secret', location: 'Office'}, () => {});
  assert.match(FakeXHR.last.url, /^https:\/\/aranet\.cloud\/api\/v1\/measurements\/history/);
  assert.match(FakeXHR.last.url, /days=7/);
  assert.equal(FakeXHR.last.headers.ApiKey, 'secret');
  assert.equal(FakeXHR.last.timeout, 12000);
});

test('normalizes newest readings and daily averages', () => {
  const snapshot = Client.normalizeHistory([
    {metric: 'PM2.5', unit: 'ug/m3', value: 5, time: '2026-08-01T10:00:00Z'},
    {metric: 'PM2.5', unit: 'ug/m3', value: 9, time: '2026-08-01T11:00:00Z'},
    {metric: 'CO2', unit: 'ppm', value: 612, time: '2026-08-01T11:00:00Z'}
  ], 'Office');
  assert.equal(snapshot.current.pm25, 9);
  assert.equal(snapshot.current.co2, 612);
  assert.equal(snapshot.daily[0].pm25, 7);
  assert.equal(snapshot.current.aqi, 50);
});

test('uses related metric names when readings contain opaque IDs', () => {
  const snapshot = Client.normalizeHistory([
    {metric: '17', unit: 'ugm3', value: 8, time: '2026-08-01T11:00:00Z'}
  ], 'Office', {metric: [{href: '/api/v1/metrics/17', name: 'PM2.5'}]});
  assert.equal(snapshot.current.pm25, 8);
});

test('uses current EPA PM2.5 breakpoints', () => {
  assert.equal(Client.pm25Aqi(9), 50);
  assert.equal(Client.pm25Aqi(35.4), 100);
  assert.equal(Client.pm25Aqi(55.4), 150);
});
