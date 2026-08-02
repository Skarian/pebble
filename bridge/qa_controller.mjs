import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const SCENARIOS = new Set([
  'unconfigured', 'loading', 'records', 'auth_error', 'service_error', 'network_error', 'live'
]);

export class QaController {
  constructor({token, credentials, liveCachePath, fetchRecords, cacheMaxAgeMs = 24 * 60 * 60 * 1000}) {
    if (String(token || '').length < 16) {
      throw new Error('CPAP_QA_TOKEN must be at least 16 characters');
    }
    this.token = token;
    this.credentials = credentials;
    this.liveCachePath = liveCachePath;
    this.fetchRecords = fetchRecords;
    this.cacheMaxAgeMs = cacheMaxAgeMs;
    this.scenario = {id: 'boot', type: 'unconfigured'};
    this.healthSeenId = '';
    this.lastRequestedId = '';
    this.lastCompletedId = '';
    this.liveApiCalls = 0;
    this.liveCacheUsed = false;
    this.pending = new Set();
  }

  authorized(header) {
    return header === `Bearer ${this.token}`;
  }

  setScenario(value) {
    if (!value || typeof value.id !== 'string' || !value.id || !SCENARIOS.has(value.type)) {
      throw new Error('Invalid QA scenario');
    }
    if (value.type === 'records' && !Array.isArray(value.records)) {
      throw new Error('Record scenarios require records');
    }
    for (const response of this.pending) {
      if (!response.writableEnded) {
        response.writeHead(409, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end('{"error":"QA scenario changed"}\n');
      }
    }
    this.pending.clear();
    this.scenario = {
      id: value.id,
      type: value.type,
      ...(value.records ? {records: value.records} : {}),
      ...(value.refreshLive ? {refreshLive: true} : {})
    };
  }

  healthDevEmulator() {
    this.healthSeenId = this.scenario.id;
    return this.scenario.type !== 'unconfigured';
  }

  status() {
    return {
      scenarioId: this.scenario.id,
      healthSeenId: this.healthSeenId,
      lastRequestedId: this.lastRequestedId,
      lastCompletedId: this.lastCompletedId,
      liveApiCalls: this.liveApiCalls,
      liveCacheUsed: this.liveCacheUsed
    };
  }

  async handleScores(response, reply) {
    const scenario = this.scenario;
    this.lastRequestedId = scenario.id;

    if (scenario.type === 'loading') {
      this.pending.add(response);
      response.once('close', () => this.pending.delete(response));
      return;
    }
    if (scenario.type === 'network_error') {
      this.lastCompletedId = scenario.id;
      response.destroy();
      return;
    }
    if (scenario.type === 'auth_error') {
      this.lastCompletedId = scenario.id;
      reply(response, 401, {error: 'ResMed sign-in failed', code: 'authentication_failed'}, false);
      return;
    }
    if (scenario.type === 'service_error' || scenario.type === 'unconfigured') {
      this.lastCompletedId = scenario.id;
      reply(response, 502, {error: 'ResMed is unavailable', code: 'service_error'}, false);
      return;
    }

    const records = scenario.type === 'live'
      ? await this.liveRecords(Boolean(scenario.refreshLive))
      : scenario.records;
    this.lastCompletedId = scenario.id;
    reply(response, 200, {records}, false);
  }

  async liveRecords(refresh) {
    if (!refresh) {
      try {
        const cached = JSON.parse(await readFile(this.liveCachePath, 'utf8'));
        if (Array.isArray(cached.records) && Date.now() - cached.fetchedAt < this.cacheMaxAgeMs) {
          this.liveCacheUsed = true;
          return cached.records;
        }
      } catch {}
    }
    if (this.liveApiCalls >= 1) {
      throw new Error('Live ResMed QA is limited to one API call per run');
    }
    if (!this.credentials.username || !this.credentials.password) {
      throw new Error('Live QA requires MYAIR_USERNAME and MYAIR_PASSWORD');
    }
    this.liveApiCalls += 1;
    const result = await this.fetchRecords(this.credentials);
    await mkdir(dirname(this.liveCachePath), {recursive: true});
    await writeFile(this.liveCachePath, `${JSON.stringify({
      fetchedAt: Date.now(),
      records: result.records
    })}\n`, {mode: 0o600});
    await chmod(this.liveCachePath, 0o600);
    return result.records;
  }
}
