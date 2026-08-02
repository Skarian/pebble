'use strict';

var Model = require('../common/hubitat_model');
var MakerClient = require('../common/maker_client');
var Diagnostics = require('../common/diagnostics');
var maker = MakerClient(function () { return new XMLHttpRequest(); });
var diagnostics = Diagnostics(localStorage);

var SETTINGS_KEY = 'hubitat.settings.v1';
var AUTHORIZED_IDS_KEY = 'hubitat.authorized.v1';
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
var requestInFlight = false;

function readSettings() {
  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {baseUrl: MAKER_BASE_URL, token: saved.token || ''};
  } catch (error) { return {baseUrl: MAKER_BASE_URL, token: ''}; }
}

function readAuthorizedIds() {
  try {
    var ids = JSON.parse(localStorage.getItem(AUTHORIZED_IDS_KEY) || '[]');
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch (error) { return []; }
}

function send(message, success) {
  Pebble.sendAppMessage(message, success || function () {}, function () {
    console.log('Hubitat AppMessage delivery failed');
  });
}

function sendStatus(status, requestId, text, command) {
  send({PROTOCOL: PROTOCOL, COMMAND: command || 0, STATUS: status,
    REQUEST_ID: requestId || 0, ERROR_TEXT: String(text || '').slice(0, 47)});
}

function statusFor(error) {
  if (error && error.type === 'auth') return STATUS.AUTH;
  if (error && error.type === 'timeout') return STATUS.TIMEOUT;
  if (error && error.type === 'network') return STATUS.NETWORK;
  return STATUS.SERVICE;
}

function sendDevices(devices, requestId) {
  var fetchedAt = Math.floor(Date.now() / 1000);
  send({PROTOCOL: PROTOCOL, COMMAND: CMD_DATA_BEGIN, REQUEST_ID: requestId,
    FETCHED_AT: fetchedAt, COUNT: devices.length}, function () {
    var index = 0;
    function next() {
      if (index >= devices.length) {
        send({PROTOCOL: PROTOCOL, COMMAND: CMD_DATA_END, REQUEST_ID: requestId,
          STATUS: devices.length ? STATUS.OK : STATUS.PARTIAL,
          PARTIAL: devices.length ? 0 : 1});
        return;
      }
      var device = devices[index];
      send({PROTOCOL: PROTOCOL, COMMAND: CMD_DEVICE, REQUEST_ID: requestId,
        DEVICE_INDEX: index, DEVICE_ID: device.id, DEVICE_LABEL: device.label,
        DEVICE_KIND: device.kind, PRIMARY_VALUE: device.primary,
        SECONDARY_VALUE: device.secondary, BATTERY: device.battery,
        CONTROL_FLAGS: device.controlFlags}, function () { index += 1; next(); });
    }
    next();
  });
}

function refresh(requestId) {
  diagnostics.replay(function (line) { console.log(line); });
  if (requestInFlight) return;
  var settings = readSettings();
  try { MakerClient.validateSettings(settings); }
  catch (error) { sendStatus(STATUS.SETUP, requestId, 'Open phone settings'); return; }
  requestInFlight = true;
  sendStatus(STATUS.LOADING, requestId, '', 0);
  maker.devices(settings, function (error, response) {
    requestInFlight = false;
    if (error) {
      diagnostics.record('refresh', error);
      sendStatus(statusFor(error), requestId, error.message);
      return;
    }
    var devices = Model.normalizeDevices(response, []);
    localStorage.setItem(AUTHORIZED_IDS_KEY, JSON.stringify(devices.map(function (device) {
      return String(device.id);
    })));
    sendDevices(devices, requestId);
  });
}

function control(payload) {
  var settings = readSettings();
  var requestId = payload.REQUEST_ID || 0;
  var deviceId = String(payload.DEVICE_ID || '');
  var action = String(payload.ACTION || '').toLowerCase();
  try { MakerClient.validateSettings(settings); }
  catch (error) { sendStatus(STATUS.SETUP, requestId, 'Open phone settings', CMD_RESULT); return; }
  if (readAuthorizedIds().indexOf(deviceId) === -1) {
    sendStatus(STATUS.COMMAND_FAILURE, requestId, 'Refresh devices first', CMD_RESULT);
    return;
  }
  sendStatus(STATUS.COMMAND_PENDING, requestId, action.toUpperCase() + ' pending', CMD_RESULT);
  maker.command(settings, deviceId, action, function (error) {
    if (error) {
      diagnostics.record('control', error);
      sendStatus(STATUS.COMMAND_FAILURE, requestId, error.message, CMD_RESULT);
      return;
    }
    sendStatus(STATUS.COMMAND_SUCCESS, requestId, action.toUpperCase() + ' complete', CMD_RESULT);
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function settingsPage(settings) {
  var hasToken = Boolean(settings.token);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Hubitat Settings</title><style>body{margin:0;background:#f1f1ed;color:#090909;font:16px -apple-system,sans-serif}' +
    'main{max-width:540px;margin:auto;padding:22px 18px 42px}h1{margin:0;border-bottom:4px solid #111;padding-bottom:8px}' +
    'label{display:block;font-weight:700;margin:18px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:2px solid #555;font-size:16px}' +
    'button{width:100%;margin-top:20px;padding:13px;border:0;background:#111;color:#fff;font-size:17px;font-weight:700}.note{font-size:13px;line-height:1.4}' +
    '.privacy{margin:16px 0;padding:10px;border:2px solid #111;background:#fff}.cancel{display:block;text-align:center;margin-top:18px;color:#333}</style></head>' +
    '<body><main><h1>Hubitat</h1><p>Connect this watch to Maker API.</p>' +
    '<div class="privacy">Your access token stays in this app on your phone. It is never sent to the watch.</div>' +
    '<form id="form"><label for="token">Access token</label><input id="token" type="password" ' + (hasToken ? 'placeholder="Saved — leave blank to keep"' : 'required') + '>' +
    '<p class="note">The watch shows up to six devices authorized in Maker API.</p>' +
    '<button type="submit">Save</button></form><p class="note">After saving, press Select on the watch to sync.</p><h2>Diagnostics</h2><p class="note">Sanitized failures contain no URL, token, device ID, or device value.</p>' +
    '<textarea readonly style="box-sizing:border-box;width:100%;height:130px">' + escapeHtml(diagnostics.report()) + '</textarea><a class="cancel" href="pebblejs://close">Cancel</a>' +
    '<script>document.getElementById("form").onsubmit=function(e){e.preventDefault();var v={token:document.getElementById("token").value};' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(v));};</script></main></body></html>';
}

Pebble.addEventListener('ready', function () {
  diagnostics.replay(function (line) { console.log(line); });
  send({PROTOCOL: PROTOCOL, COMMAND: CMD_PHONE_READY});
});

Pebble.addEventListener('appmessage', function (event) {
  if (event.payload.COMMAND === CMD_REFRESH) refresh(event.payload.REQUEST_ID || 0);
  if (event.payload.COMMAND === CMD_CONTROL) control(event.payload);
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(settingsPage(readSettings())));
});

Pebble.addEventListener('webviewclosed', function (event) {
  if (!event.response) return;
  try {
    var values = JSON.parse(decodeURIComponent(event.response));
    var previous = readSettings();
    if (!values.token) values.token = previous.token;
    MakerClient.validateSettings({baseUrl: MAKER_BASE_URL, token: values.token});
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({version: 2, token: values.token}));
    localStorage.removeItem(AUTHORIZED_IDS_KEY);
  } catch (error) {
    sendStatus(STATUS.SETUP, 0, error.message || 'Settings were not saved');
  }
});
