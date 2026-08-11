'use strict';

var Model = require('../common/hubitat_model');
var MakerClient = require('../common/maker_client');
var createAppMessageSession =
  require('../../../../shared/appmessage/pkjs/app_message_session');
var createErrorReporter = require('../../../../shared/errors/pkjs/error_reporter');

var SETTINGS_KEY = 'hubitat.settings.v1';
var AUTHORIZED_IDS_KEY = 'hubitat.authorized.v1';
var ERROR_SETTINGS_KEY = 'hubitat.errorReporting.v1';
var ERROR_OUTBOX_KEY = 'pebble.errors.hubitat.v1';
var LEGACY_DIAGNOSTICS_KEY = 'hubitat.diagnostics.v1';
var MAKER_BASE_URL = 'https://cloud.hubitat.com/api/225f419b-0b18-4988-8236-459b66cd2a49/apps/83';
var PROTOCOL = 1;
var CMD_REFRESH = 1;
var CMD_PHONE_READY = 2;
var CMD_DATA_BEGIN = 3;
var CMD_DEVICE = 4;
var CMD_DATA_END = 5;
var CMD_CONTROL = 6;
var CMD_RESULT = 7;
var STATUS = {
  OK: 0, SETUP: 1, AUTH: 2, NETWORK: 3, SERVICE: 4, TIMEOUT: 5,
  LOADING: 6, PARTIAL: 7, COMMAND_PENDING: 8, COMMAND_SUCCESS: 9, COMMAND_FAILURE: 10
};
var businessActive = 0;
var diagnosticSecrets = [];
var errorReporter;

function readJson(key, fallback, whileDoing) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    if (errorReporter) errorReporter.report(error, whileDoing || 'reading Hubitat settings');
    return fallback;
  }
}

function writeJson(key, value, whileDoing) {
  try {
    var serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw new Error('Stored value could not be verified');
    return true;
  } catch (error) {
    if (errorReporter) errorReporter.report(error, whileDoing || 'saving Hubitat settings');
    return false;
  }
}

function readSettings() {
  var saved = readJson(SETTINGS_KEY, {}, 'reading the Maker API settings');
  return {baseUrl: MAKER_BASE_URL, token: typeof saved.token === 'string' ? saved.token : ''};
}

function readAuthorizedIds() {
  var ids = readJson(AUTHORIZED_IDS_KEY, [], 'reading authorized Hubitat devices');
  if (Array.isArray(ids)) return ids.map(String);
  errorReporter.report(new TypeError('Authorized Hubitat device list is invalid'),
    'reading authorized Hubitat devices');
  return [];
}

var initialSettings = readSettings();
diagnosticSecrets = [initialSettings.token];
errorReporter = createErrorReporter({
  source: 'hubitat/pkjs@0.1.0',
  watchSource: 'hubitat/watch@0.1.0',
  storage: localStorage,
  storageKey: ERROR_OUTBOX_KEY,
  Xhr: XMLHttpRequest,
  config: readJson(ERROR_SETTINGS_KEY, {}),
  isIdle: function () { return businessActive === 0; },
  secrets: function () { return diagnosticSecrets; }
});
var maker = MakerClient(function () { return new XMLHttpRequest(); },
  {reportError: errorReporter.report});

function readyMessage() {
  return {PROTOCOL: PROTOCOL, COMMAND: CMD_PHONE_READY,
    ERROR_ENABLED: errorReporter.readyValue()};
}

var appMessages = createAppMessageSession({
  requestIdKey: 'REQUEST_ID',
  pebble: Pebble,
  errorReporter: errorReporter,
  readyMessage: readyMessage,
  onMessage: function (payload, session) {
    var requestId = Number(payload.REQUEST_ID || 0);
    if (payload.COMMAND === CMD_REFRESH) {
      session.handleRead(requestId, 'refresh', runRefresh,
        {failureResponse: function () { return statusMessage(STATUS.SERVICE, 'Hubitat is unavailable'); }});
    } else if (payload.COMMAND === CMD_CONTROL) {
      var deviceId = String(payload.DEVICE_ID || '');
      var action = String(payload.ACTION || '').toLowerCase();
      session.handleRead(requestId, 'control', function (id, done) {
        runControl(id, deviceId, action, done);
      }, {fingerprint: deviceId + ':' + action, failureResponse: function () {
        return statusMessage(STATUS.COMMAND_FAILURE, 'Hubitat is unavailable', CMD_RESULT);
      }});
    }
  }
});

function statusMessage(status, text, command, requestId) {
  var message = {PROTOCOL: PROTOCOL, COMMAND: command || 0, STATUS: status};
  if (text) message.ERROR_TEXT = String(text).slice(0, 47);
  if (requestId) message.REQUEST_ID = requestId;
  return message;
}

function statusFor(error) {
  if (error && error.type === 'auth') return STATUS.AUTH;
  if (error && error.type === 'timeout') return STATUS.TIMEOUT;
  if (error && error.type === 'network') return STATUS.NETWORK;
  return STATUS.SERVICE;
}

function deviceMessages(devices, partial) {
  var messages = [{PROTOCOL: PROTOCOL, COMMAND: CMD_DATA_BEGIN,
    FETCHED_AT: Math.floor(Date.now() / 1000), COUNT: devices.length}];
  devices.forEach(function (device, index) {
    messages.push({PROTOCOL: PROTOCOL, COMMAND: CMD_DEVICE,
      DEVICE_INDEX: index, DEVICE_ID: device.id, DEVICE_LABEL: device.label,
      DEVICE_KIND: device.kind, PRIMARY_VALUE: device.primary,
      SECONDARY_VALUE: device.secondary, BATTERY: device.battery,
      CONTROL_FLAGS: device.controlFlags});
  });
  messages.push({PROTOCOL: PROTOCOL, COMMAND: CMD_DATA_END,
    STATUS: partial || !devices.length ? STATUS.PARTIAL : STATUS.OK,
    PARTIAL: partial || !devices.length ? 1 : 0});
  return messages;
}

function finishBusiness(done, response) {
  businessActive = Math.max(0, businessActive - 1);
  try { done(response); }
  catch (error) { errorReporter.report(error, 'returning a Hubitat response'); }
  errorReporter.sendNow();
}

function runRefresh(requestId, done) {
  var settings = readSettings();
  diagnosticSecrets = [settings.token];
  try { MakerClient.validateSettings(settings); }
  catch (error) { done(statusMessage(STATUS.SETUP, 'Open phone settings')); return; }
  businessActive += 1;
  try {
    maker.devices(settings, function (error, response) {
      if (error) { finishBusiness(done, statusMessage(statusFor(error), error.message)); return; }
      try {
        if (!Array.isArray(response)) throw new TypeError('Hubitat device response is not an array');
        var devices = Model.normalizeDevices(response, []);
        if (!writeJson(AUTHORIZED_IDS_KEY,
          devices.map(function (device) { return String(device.id); }),
          'saving authorized Hubitat devices')) {
          finishBusiness(done, statusMessage(STATUS.SERVICE, 'Phone storage failed'));
          return;
        }
        finishBusiness(done, deviceMessages(devices, response.length > Model.MAX_DEVICES));
      } catch (parseError) {
        errorReporter.report(parseError, 'normalizing Hubitat devices', [settings.token]);
        finishBusiness(done, statusMessage(STATUS.SERVICE, 'Hubitat is unavailable'));
      }
    });
  } catch (error) {
    errorReporter.report(error, 'starting a Hubitat refresh', [settings.token]);
    finishBusiness(done, statusMessage(STATUS.SERVICE, 'Hubitat is unavailable'));
  }
}

function runControl(requestId, deviceId, action, done) {
  var settings = readSettings();
  diagnosticSecrets = [settings.token];
  try { MakerClient.validateSettings(settings); }
  catch (error) { done(statusMessage(STATUS.SETUP, 'Open phone settings')); return; }
  if (readAuthorizedIds().indexOf(deviceId) === -1) {
    var authorization = new Error('Hubitat device is not authorized by the latest refresh');
    authorization.name = 'HubitatControlError'; authorization.code = 'device_not_authorized';
    authorization.deviceId = deviceId; authorization.action = action;
    errorReporter.report(authorization, 'authorizing a Hubitat control request');
    done(statusMessage(STATUS.COMMAND_FAILURE, 'Refresh devices first', CMD_RESULT));
    return;
  }
  appMessages.send(statusMessage(STATUS.COMMAND_PENDING,
    action.toUpperCase() + ' pending', CMD_RESULT, requestId),
  {operation: 'control', requestId: requestId});
  businessActive += 1;
  try {
    maker.command(settings, deviceId, action, function (error) {
      finishBusiness(done, error ? statusMessage(STATUS.COMMAND_FAILURE, error.message, CMD_RESULT) :
        statusMessage(STATUS.COMMAND_SUCCESS, action.toUpperCase() + ' complete', CMD_RESULT));
    });
  } catch (error) {
    errorReporter.report(error, 'starting a Hubitat control request', [settings.token]);
    finishBusiness(done, statusMessage(STATUS.COMMAND_FAILURE, 'Hubitat is unavailable', CMD_RESULT));
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function settingsPage(settings, errorSettings, reportStatus) {
  var hasToken = Boolean(settings.token), enabled = Boolean(errorSettings.enabled);
  var hasKey = Boolean(errorSettings.key);
  var status = !reportStatus.enabled ? 'Off' :
    reportStatus.queued + ' queued; ' + reportStatus.dropped + ' dropped locally';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Hubitat Settings</title><style>body{margin:0;background:#f1f1ed;color:#090909;font:16px -apple-system,sans-serif}' +
    'main{max-width:540px;margin:auto;padding:22px 18px 42px}h1{margin:0;border-bottom:4px solid #111;padding-bottom:8px}' +
    'label{display:block;font-weight:700;margin:18px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:2px solid #555;font-size:16px}' +
    'label.check{font-weight:400}.check input{width:auto;margin-right:8px}button{width:100%;margin-top:20px;padding:13px;border:0;background:#111;color:#fff;font-size:17px;font-weight:700}' +
    '.note{font-size:13px;line-height:1.4}.privacy{margin:16px 0;padding:10px;border:2px solid #111;background:#fff}.cancel{display:block;text-align:center;margin-top:18px;color:#333}</style></head>' +
    '<body><main><h1>Hubitat</h1><p>Connect this watch to Maker API.</p>' +
    '<div class="privacy">Your access token stays in this app on your phone. It is never sent to the watch.</div>' +
    '<form id="form"><label for="token">Access token</label><input id="token" type="password" ' +
    (hasToken ? 'placeholder="Saved — leave blank to keep"' : 'required') + '>' +
    '<p class="note">The watch shows up to 32 devices authorized in Maker API.</p>' +
    '<h2>Error reporting</h2><label class="check"><input id="errors" type="checkbox" ' +
    (enabled ? 'checked' : '') + '>Send errors to Pebble Diagnostics</label>' +
    '<p class="note">Opt-in. Only failures are kept; exact credentials, tokens, authorization, and cookie values are redacted. Offline errors wait locally. Create or recreate the Diagnostic key at <a href="https://pebble.exe.xyz/diagnostics" target="_blank" rel="noopener">pebble.exe.xyz</a>. Status: ' + escapeHtml(status) + '.</p>' +
    '<label for="errorKey">Diagnostic key</label><input id="errorKey" type="password" ' +
    (hasKey ? 'placeholder="Saved — leave blank to keep"' : '') + '>' +
    '<button type="submit">Save</button><button type="submit" id="send">Save and send now</button></form>' +
    '<p class="note">After saving, press Select on the watch to sync.</p><a class="cancel" href="pebblejs://close">Cancel</a>' +
    '<script>var send=false;document.getElementById("send").onclick=function(){send=true;};document.getElementById("form").onsubmit=function(e){e.preventDefault();' +
    'var on=document.getElementById("errors").checked,k=document.getElementById("errorKey").value;' +
    'if(on&&!k&&' + (hasKey ? 'false' : 'true') + '){alert("A Diagnostic key is required.");return;}' +
    'var v={token:document.getElementById("token").value,errorReporting:{enabled:on,key:k,sendNow:send}};' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(v));};</script></main></body></html>';
}

function saveAccount(values) {
  var previous = readSettings();
  var token = typeof values.token === 'string' && values.token ? values.token : previous.token;
  try { MakerClient.validateSettings({baseUrl: MAKER_BASE_URL, token: token}); }
  catch (error) { return false; }
  if (!writeJson(AUTHORIZED_IDS_KEY, [], 'clearing authorized Hubitat devices')) return false;
  if (!writeJson(SETTINGS_KEY, {version: 2, token: token}, 'saving the Maker API settings')) return false;
  diagnosticSecrets = [token];
  return true;
}

function saveErrorSettings(values) {
  if (values === undefined) return true;
  values = values || {};
  var previous = readJson(ERROR_SETTINGS_KEY, {}, 'reading Hubitat error-reporting settings');
  if (!values.enabled) {
    var durable = writeJson(ERROR_SETTINGS_KEY, {enabled: false}, 'disabling Hubitat error reporting');
    if (durable) {
      var marker = readJson(ERROR_SETTINGS_KEY, null, 'verifying disabled Hubitat error reporting');
      durable = Boolean(marker && marker.enabled === false);
    }
    try {
      localStorage.removeItem(ERROR_SETTINGS_KEY);
      durable = localStorage.getItem(ERROR_SETTINGS_KEY) === null || durable;
    } catch (error) { errorReporter.report(error, 'disabling Hubitat error reporting'); }
    if (!durable) return false;
    errorReporter.configure({enabled: false});
    return true;
  }
  var enteredKey = typeof values.key === 'string' ? values.key.trim() : '';
  var key = enteredKey || (typeof previous.key === 'string' ? previous.key.trim() : '');
  if (!key) return false;
  var config = {enabled: true, key: key};
  errorReporter.configure(config);
  if (!writeJson(ERROR_SETTINGS_KEY, config, 'saving Hubitat error-reporting settings')) {
    errorReporter.configure(previous); return false;
  }
  if (values.sendNow) errorReporter.sendNow();
  return true;
}

function decodeSettingsResponse(response) {
  if (!response) return null;
  if (typeof response === 'object') return response;
  return JSON.parse(decodeURIComponent(response));
}

function removeLegacyDiagnostics() {
  try { localStorage.removeItem(LEGACY_DIAGNOSTICS_KEY); }
  catch (error) { errorReporter.report(error, 'removing the old Hubitat diagnostics log'); }
}

appMessages.open();

Pebble.addEventListener('showConfiguration', function () {
  try {
    Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(settingsPage(
      readSettings(), readJson(ERROR_SETTINGS_KEY, {}), errorReporter.status())));
  } catch (error) { errorReporter.report(error, 'opening the Hubitat settings page'); }
});

Pebble.addEventListener('webviewclosed', function (event) {
  try {
    var values = decodeSettingsResponse(event && event.response);
    if (!values) return;
    saveErrorSettings(values.errorReporting);
    removeLegacyDiagnostics();
    saveAccount(values);
    appMessages.announceReady(readyMessage());
  } catch (error) { errorReporter.report(error, 'saving the Hubitat settings response'); }
});
