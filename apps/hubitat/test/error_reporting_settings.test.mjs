import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/pkjs/index.js', import.meta.url), 'utf8');
const settingsKey = 'hubitat.errorReporting.v1';

function storageWith({enabled = true, writeFails = false, writeIgnored = false,
  removeFails = false, authorizedWriteFails = false, token = 'maker-token'} = {}) {
  const values = new Map([['hubitat.settings.v1', JSON.stringify({token})]]);
  values.set('hubitat.authorized.v1', JSON.stringify(['7']));
  values.set('hubitat.diagnostics.v1', JSON.stringify({records: [{event: 'old'}]}));
  if (enabled) values.set(settingsKey, JSON.stringify({enabled: true, key: 'diagnostic-key'}));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === 'hubitat.authorized.v1' && authorizedWriteFails) {
        throw new Error('authorized device write failed');
      }
      if (key === settingsKey && JSON.parse(value).enabled === false) {
        if (writeFails) throw new Error('disabled marker write failed');
        if (writeIgnored) return;
      }
      values.set(key, String(value));
    },
    removeItem(key) {
      if (key === settingsKey && removeFails) throw new Error('settings removal failed');
      values.delete(key);
    },
    value: (key) => values.get(key),
  };
}

function boot(storage, {devices, normalizedDevices = []} = {}) {
  const listeners = {}, configured = [], reports = [], ready = [];
  let openedUrl = '', sessionOptions, reporterOptions;
  let reporterEnabled = false;
  function createReporter(options) {
    reporterOptions = options;
    reporterEnabled = Boolean(options.config && options.config.enabled && options.config.key);
    return {
      report: (error, whileDoing) => reports.push({error, whileDoing}),
      configure(value) { configured.push(value); reporterEnabled = Boolean(value.enabled && value.key); },
      readyValue: () => reporterEnabled ? 1 : 0,
      status: () => ({enabled: reporterEnabled, queued: 0, dropped: 0}),
      sendNow: () => true,
    };
  }
  function MakerClient() { return {
    devices(_settings, callback) { if (devices !== undefined) callback(null, devices); },
    command() {},
  }; }
  MakerClient.validateSettings = (settings) => {
    if (!settings.token) throw new Error('Maker API access token is required');
    return settings;
  };
  const appMessages = {
    open() {}, send() {},
    announceReady(message) { ready.push(message); },
  };
  const dependencies = {
    '../common/hubitat_model': {MAX_DEVICES: 32, normalizeDevices: () => normalizedDevices},
    '../common/maker_client': MakerClient,
    '../../../../shared/appmessage/pkjs/app_message_session': (options) => {
      sessionOptions = options; return appMessages;
    },
    '../../../../shared/errors/pkjs/error_reporter': createReporter,
  };
  vm.runInNewContext(source, {
    require: (name) => dependencies[name],
    localStorage: storage,
    XMLHttpRequest: function FakeXhr() {},
    Pebble: {
      addEventListener: (name, listener) => { listeners[name] = listener; },
      openURL: (url) => { openedUrl = url; },
    },
    console,
  });
  return {listeners, configured, reports, ready, sessionOptions, reporterOptions,
    openedUrl: () => openedUrl};
}

function closeWith(installation, errorReporting) {
  installation.listeners.webviewclosed({response: {
    token: 'maker-token', errorReporting,
  }});
}

test('reporting is off without a saved key and READY carries the disabled bit', () => {
  const installation = boot(storageWith({enabled: false}));
  assert.equal(installation.reporterOptions.config.enabled, undefined);
  assert.equal(installation.sessionOptions.readyMessage().ERROR_ENABLED, 0);
  assert.equal(installation.reporterOptions.source, 'hubitat/pkjs@0.1.0');
  assert.equal(installation.reporterOptions.watchSource, 'hubitat/watch@0.1.0');
});

test('enabled settings store only the Diagnostic key and announce watch opt in', () => {
  const storage = storageWith({enabled: false});
  const installation = boot(storage);
  closeWith(installation, {enabled: true, key: ' replacement-key ', sendNow: true});

  assert.deepEqual(JSON.parse(storage.value(settingsKey)), {
    enabled: true, key: 'replacement-key',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(installation.configured.at(-1))), {
    enabled: true, key: 'replacement-key',
  });
  assert.equal(installation.ready.at(-1).ERROR_ENABLED, 1);
  assert.equal(storage.value('hubitat.diagnostics.v1'), undefined);
});

test('durable disable survives removal failure and clears the watch bit', () => {
  const storage = storageWith({removeFails: true});
  const installation = boot(storage);
  closeWith(installation, {enabled: false});

  assert.equal(installation.configured.at(-1).enabled, false);
  assert.equal(JSON.parse(storage.value(settingsKey)).enabled, false);
  assert.equal(installation.ready.at(-1).ERROR_ENABLED, 0);
  assert.equal(boot(storage).sessionOptions.readyMessage().ERROR_ENABLED, 0);
});

test('failed marker write falls back to removal or refuses to claim disablement', () => {
  const removable = storageWith({writeFails: true});
  const recovered = boot(removable);
  closeWith(recovered, {enabled: false});
  assert.equal(recovered.configured.at(-1).enabled, false);
  assert.equal(removable.value(settingsKey), undefined);

  const stuck = storageWith({writeFails: true, removeFails: true});
  const failed = boot(stuck);
  closeWith(failed, {enabled: false});
  assert.equal(failed.configured.length, 0);
  assert.equal(failed.ready.at(-1).ERROR_ENABLED, 1);

  const silent = storageWith({writeIgnored: true, removeFails: true});
  const unverified = boot(silent);
  closeWith(unverified, {enabled: false});
  assert.equal(unverified.configured.length, 0);
});

test('settings show one Diagnostic key, fixed service, and no old local log', () => {
  const installation = boot(storageWith());
  installation.listeners.showConfiguration();
  const page = decodeURIComponent(installation.openedUrl().split(',')[1]);

  assert.match(page, />Diagnostic key<\/label>/);
  assert.match(page, /https:\/\/pebble\.exe\.xyz\/diagnostics/);
  assert.doesNotMatch(page, /type="url"|textarea|HUBITAT_DIAGNOSTIC/);
});

test('a failed authorized-device write blocks the snapshot and token replacement', () => {
  const storage = storageWith({authorizedWriteFails: true});
  const installation = boot(storage, {
    devices: [{id: '7'}],
    normalizedDevices: [{id: '7', label: 'Lamp', kind: 4, primary: 'off',
      secondary: '', battery: 255, controlFlags: 3}],
  });
  const replies = [];
  installation.sessionOptions.onMessage({COMMAND: 1, REQUEST_ID: 9}, {
    handleRead(requestId, operation, run) {
      assert.equal(requestId, 9); assert.equal(operation, 'refresh');
      run(requestId, (response) => replies.push(response));
    },
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].STATUS, 4);
  assert.equal(replies[0].ERROR_TEXT, 'Phone storage failed');
  installation.listeners.webviewclosed({response: {token: 'replacement-token'}});
  assert.equal(JSON.parse(storage.value('hubitat.settings.v1')).token, 'maker-token');
  assert.deepEqual(JSON.parse(storage.value('hubitat.authorized.v1')), ['7']);
  assert.ok(installation.reports.some(({whileDoing}) =>
    whileDoing === 'saving authorized Hubitat devices'));
  assert.ok(installation.reports.some(({whileDoing}) =>
    whileDoing === 'clearing authorized Hubitat devices'));
});

test('a cached-device control without phone settings returns a global setup response', () => {
  const installation = boot(storageWith({token: ''}));
  let reply;
  installation.sessionOptions.onMessage({COMMAND: 6, REQUEST_ID: 10,
    DEVICE_ID: '7', ACTION: 'on'}, {
    handleRead(requestId, operation, run) {
      assert.equal(requestId, 10); assert.equal(operation, 'control');
      run(requestId, (response) => { reply = response; });
    },
  });

  assert.equal(reply.STATUS, 1);
  assert.equal(reply.COMMAND, 0);
  assert.equal(reply.ERROR_TEXT, 'Open phone settings');
});
