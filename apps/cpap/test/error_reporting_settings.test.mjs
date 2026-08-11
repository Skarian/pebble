import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/pkjs/index.js', import.meta.url), 'utf8');
const settingsKey = 'cpap.errorReporting.v1';

function storageWith({writeFails = false, writeIgnored = false, removeFails = false} = {}) {
  const values = new Map([[settingsKey, JSON.stringify({
    enabled: true, key: 'diagnostic-key',
  })]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === settingsKey && writeFails && JSON.parse(value).enabled === false) {
        throw new Error('disabled marker write failed');
      }
      if (key === settingsKey && writeIgnored && JSON.parse(value).enabled === false) return;
      values.set(key, String(value));
    },
    removeItem(key) {
      if (key === settingsKey && removeFails) throw new Error('settings removal failed');
      values.delete(key);
    },
    value: (key) => values.get(key),
  };
}

function boot(storage) {
  const listeners = {};
  const configured = [];
  const reports = [];
  let openedUrl = '';
  let initialConfig;
  let sessionOptions;
  function createReporter(options) {
    initialConfig = options.config;
    return {
      report: (error) => reports.push(error),
      configure: (value) => configured.push(value),
      readyValue: () => 1,
      status: () => ({enabled: true, queued: 0, dropped: 0}),
      sendNow: () => true,
    };
  }
  const appMessages = {open() {}, announceReady() {}};
  const dependencies = {
    '../common/cpap_model': {sevenDaySlots: () => [], responseDictionary: () => ({})},
    '../common/xhr_json': () => () => {},
    '../common/resmed_client': () => ({clearSession() {}, fetchSleepRecords() {}}),
    '../common/settings_response': (value) => value,
    '../../../../shared/appmessage/pkjs/app_message_session': (options) => {
      sessionOptions = options;
      return appMessages;
    },
    '../../../../shared/errors/pkjs/error_reporter': createReporter,
  };
  vm.runInNewContext(source, {
    require: (name) => dependencies[name],
    localStorage: storage,
    XMLHttpRequest: function FakeXhr() {},
    Pebble: {
      addEventListener: (name, listener) => { listeners[name] = listener; },
      getActiveWatchInfo: () => ({model: 'real-watch'}),
      openURL: (url) => { openedUrl = url; },
    },
    console,
  });
  return {listeners, configured, reports, initialConfig, sessionOptions,
    openedUrl: () => openedUrl};
}

function disable(installation) {
  installation.listeners.webviewclosed({response: {
    email: 'person@example.com', password: 'account-password',
    errorReporting: {enabled: false},
  }});
}

test('a failed settings removal leaves a durable disabled marker across restart', () => {
  const storage = storageWith({removeFails: true});
  const first = boot(storage);
  disable(first);

  assert.equal(first.configured.at(-1).enabled, false);
  assert.equal(JSON.parse(storage.value(settingsKey)).enabled, false);
  assert.match(first.reports.at(-1).message, /removal failed/);
  assert.equal(boot(storage).initialConfig.enabled, false);
});

test('a failed marker write uses removal or refuses to claim durable disablement', () => {
  const removable = storageWith({writeFails: true});
  const recovered = boot(removable);
  disable(recovered);
  assert.equal(recovered.configured.at(-1).enabled, false);
  assert.equal(removable.value(settingsKey), undefined);
  assert.equal(boot(removable).initialConfig.enabled, undefined);

  const stuck = storageWith({writeFails: true, removeFails: true});
  const failed = boot(stuck);
  disable(failed);
  assert.equal(failed.configured.length, 0);
  assert.equal(boot(stuck).initialConfig.enabled, true);

  const silent = storageWith({writeIgnored: true, removeFails: true});
  const unverified = boot(silent);
  disable(unverified);
  assert.equal(unverified.configured.length, 0);
  assert.equal(boot(silent).initialConfig.enabled, true);
});

test('enabled settings store only the Diagnostic key and fixed-service opt in', () => {
  const storage = storageWith();
  const installation = boot(storage);

  installation.listeners.webviewclosed({response: {
    email: 'person@example.com', password: 'account-password',
    errorReporting: {enabled: true, key: 'replacement-key'},
  }});

  assert.deepEqual(JSON.parse(storage.value(settingsKey)), {
    enabled: true, key: 'replacement-key',
  });
  const configured = installation.configured.at(-1);
  assert.equal(configured.enabled, true);
  assert.equal(configured.key, 'replacement-key');
  assert.deepEqual(Object.keys(configured).sort(), ['enabled', 'key']);
});

test('missing ResMed account settings are expected setup state, not an error', () => {
  const installation = boot(storageWith());
  const replies = [];
  installation.sessionOptions.onMessage({COMMAND: 1, REQUEST_ID: 7}, {
    handleRead(requestId, operation, run) {
      assert.equal(requestId, 7);
      assert.equal(operation, 'fetch');
      run(requestId, (reply) => replies.push(reply));
    },
  });

  assert.equal(replies[0].STATUS, 1);
  assert.deepEqual(installation.reports, []);
});

test('settings present one Diagnostic key field and no endpoint input', () => {
  const installation = boot(storageWith());
  installation.listeners.showConfiguration();
  const page = decodeURIComponent(installation.openedUrl().split(',')[1]);

  assert.match(page, />Diagnostic key<\/label>/);
  assert.doesNotMatch(page, /type="url"/);
  assert.match(page, /https:\/\/pebble\.exe\.xyz/);
});
