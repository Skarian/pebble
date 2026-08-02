#!/usr/bin/env node

import {timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {fakeRawDevices} from './qa-bridge.mjs';

const host = '127.0.0.1';
const port = Number(process.env.HUBITAT_QA_PORT || 8896);
const token = String(process.env.HUBITAT_QA_TOKEN || '');
if (token.length < 16) throw new Error('HUBITAT_QA_TOKEN must be at least 16 characters');

function equal(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(response, status, body) {
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  response.end(`${JSON.stringify(body)}\n`);
}

const matrix = {
  devices: fakeRawDevices,
  errors: [
    {name: 'auth', label: 'AUTH ERROR', status: 2, text: 'Maker API access denied'},
    {name: 'network', label: 'PHONE UNREACHABLE', status: 3, text: 'Phone cannot reach Hubitat'},
    {name: 'timeout', label: 'HUBITAT TIMEOUT', status: 5, text: 'Hubitat request timed out'},
    {name: 'service', label: 'HUBITAT UNAVAILABLE', status: 4, text: 'Hubitat returned HTTP 500'}
  ],
  command: {
    success: {status: 9, text: 'UNLOCK complete'},
    failure: {status: 10, text: 'Command failed'}
  }
};

createServer((request, response) => {
  if (request.url === '/health') { reply(response, 200, {ok: true, port}); return; }
  if (!equal(request.headers.authorization, `Bearer ${token}`)) {
    reply(response, 401, {error: 'QA access denied'}); return;
  }
  if (request.url === '/v1/matrix') { reply(response, 200, matrix); return; }
  reply(response, 404, {error: 'Not found'});
}).listen(port, host, () => console.log(`Hubitat QA bridge listening on http://${host}:${port}`));
