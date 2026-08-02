#!/usr/bin/env node

import {timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fetchSleepRecords, ResMedError} from './resmed.mjs';
import {
  isAllowedDevRequest,
  jsonHeaders,
  publicResMedError,
  validateConfiguration
} from './security.mjs';
import {SessionStore} from './store.mjs';
import {QaController} from './qa_controller.mjs';

const host = process.env.CPAP_BRIDGE_HOST || '127.0.0.1';
const port = Number(process.env.CPAP_BRIDGE_PORT || 8787);
const setupToken = process.env.CPAP_BRIDGE_SETUP_TOKEN || '';
const secret = process.env.CPAP_BRIDGE_SECRET || '';
const storePath = resolve(process.env.CPAP_BRIDGE_STORE || './data/sessions.json');
const devEmulator = process.env.CPAP_DEV_EMULATOR === '1';
const devLogRequests = process.env.CPAP_DEV_LOG_REQUESTS === '1';
const devUsername = process.env.MYAIR_USERNAME || '';
const devPassword = process.env.MYAIR_PASSWORD || '';
const qaToken = devEmulator ? process.env.CPAP_QA_TOKEN || '' : '';
const qa = qaToken ? new QaController({
  token: qaToken,
  credentials: {username: devUsername, password: devPassword},
  liveCachePath: resolve(process.env.CPAP_QA_LIVE_CACHE || './data/qa-live-cache.json'),
  fetchRecords: fetchSleepRecords
}) : null;

validateConfiguration({
  devEmulator,
  host,
  username: devUsername,
  password: devPassword,
  qaEnabled: Boolean(qa),
  setupToken,
  secret
});

const store = new SessionStore(storePath, secret);
await store.load();

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request) {
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function reply(response, status, body, cors = true) {
  response.writeHead(status, jsonHeaders(cors));
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16 * 1024) {
      throw new Error('Request body too large');
    }
  }
  return JSON.parse(raw || '{}');
}

async function handle(request, response) {
  if (devLogRequests && request.url === '/v1/dev/scores') {
    response.once('finish', () => console.log(`CPAP dev scores response ${response.statusCode}`));
  }
  if (request.method === 'OPTIONS') {
    reply(response, 204, {});
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    reply(response, 200, {ok: true, devEmulator: qa ? qa.healthDevEmulator() : devEmulator});
    return;
  }
  if (qa && request.url === '/v1/dev/qa/scenario' && request.method === 'POST') {
    if (!qa.authorized(request.headers.authorization)) {
      reply(response, 401, {error: 'QA access denied'}, false);
      return;
    }
    qa.setScenario(await readJson(request));
    reply(response, 200, {ok: true}, false);
    return;
  }
  if (qa && request.url === '/v1/dev/qa/status' && request.method === 'GET') {
    if (!qa.authorized(request.headers.authorization)) {
      reply(response, 401, {error: 'QA access denied'}, false);
      return;
    }
    reply(response, 200, qa.status(), false);
    return;
  }
  if (devEmulator && request.method === 'GET' && request.url === '/v1/dev/scores') {
    if (!isAllowedDevRequest(request.headers)) {
      reply(response, 403, {error: 'Development access denied'}, false);
      return;
    }
    if (qa) {
      await qa.handleScores(response, reply);
    } else {
      const result = await fetchSleepRecords({username: devUsername, password: devPassword});
      reply(response, 200, {records: result.records}, false);
    }
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/login') {
    if (setupToken.length < 16 || !constantTimeEqual(bearer(request), setupToken)) {
      reply(response, 401, {error: 'Invalid bridge setup token'});
      return;
    }
    const body = await readJson(request);
    if (typeof body.username !== 'string' || typeof body.password !== 'string' ||
        !body.username || !body.password) {
      reply(response, 400, {error: 'ResMed email and password are required'});
      return;
    }
    const result = await fetchSleepRecords({username: body.username, password: body.password});
    const sessionToken = await store.create({
      username: body.username,
      password: body.password,
      deviceToken: result.deviceToken
    });
    reply(response, 200, {sessionToken, records: result.records});
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/scores') {
    const sessionToken = bearer(request);
    const credentials = store.get(sessionToken);
    if (!credentials) {
      reply(response, 401, {error: 'Bridge session expired'});
      return;
    }
    const result = await fetchSleepRecords(credentials);
    if (result.deviceToken && result.deviceToken !== credentials.deviceToken) {
      await store.update(sessionToken, {...credentials, deviceToken: result.deviceToken});
    }
    reply(response, 200, {records: result.records});
    return;
  }
  if (request.method === 'DELETE' && request.url === '/v1/session') {
    const revoked = await store.revoke(bearer(request));
    reply(response, revoked ? 200 : 404, {revoked});
    return;
  }
  reply(response, 404, {error: 'Not found'});
}

const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
    if (error instanceof ResMedError) {
      const safe = publicResMedError(error.code);
      reply(response, error.status, {error: safe.message, code: safe.code});
      return;
    }
    console.error(`CPAP bridge request failed: ${error.name}`);
    reply(response, 500, {error: 'Bridge request failed'});
  });
});

server.listen(port, host, () => {
  console.log(`CPAP bridge listening on http://${host}:${port}`);
});
