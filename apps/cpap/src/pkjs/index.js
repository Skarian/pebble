'use strict';

var CPAP = require('../common/cpap_model');
var XHR = require('../common/xhr_json');
var xhrJson = XHR(XMLHttpRequest);
var ResMed = require('../common/resmed_client');
var resMed = ResMed(XMLHttpRequest, localStorage);
var decodeSettingsResponse = require('../common/settings_response');
var createAppMessageSession =
  require('../../../../shared/appmessage/pkjs/app_message_session');

var SETTINGS_KEY = 'cpap.settings.v2';
var STATUS_UNCONFIGURED = 1;
var STATUS_AUTH_REQUIRED = 2;
var STATUS_SERVICE_ERROR = 4;
var STATUS_RESMED_NETWORK = 7;
var COMMAND_PHONE_READY = 2;
var DEV_BRIDGE_URL = 'http://127.0.0.1:8787';

function readJson(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

var appMessages = createAppMessageSession({
  app: 'cpap',
  storage: localStorage,
  requestIdKey: 'REQUEST_ID',
  pebble: Pebble,
  readyMessage: {PROTOCOL: 1, COMMAND: COMMAND_PHONE_READY},
  onMessage: function (payload, session) {
    if (payload.COMMAND === 1) {
      session.handleRead(Number(payload.REQUEST_ID || 0),
        'fetch', runScoreFetch, readOptions);
    }
  }
});

function statusMessage(status, text) {
  var message = {PROTOCOL: 1, STATUS: status};
  if (text) message.ERROR_TEXT = String(text).slice(0, 48);
  return message;
}

function logResMedError(context, requestId, error) {
  error = error || {};
  appMessages.record({
    operation: context,
    requestId: requestId,
    event: 'domain_terminal',
    lifecycle: 'active',
    ready: true,
    attempts: error.attempts || 1,
    resultCode: error.code,
    finalCategory: error.type === 'network' ? 'resmed_network' :
      error.type === 'service' ? 'resmed_service' : error.type,
    step: error.step,
    status: error.status,
    elapsedMs: error.elapsedMs,
    replay: error.replay,
    shape: error.shape
  });
}

function recordsMessage(records) {
  var fetchedAt = Date.now();
  var slots = CPAP.sevenDaySlots(records, new Date());
  return CPAP.responseDictionary(slots, fetchedAt, 0, 1);
}

function isEmulator() {
  try {
    var info = Pebble.getActiveWatchInfo();
    return info && String(info.model || '').indexOf('qemu_platform_') === 0;
  } catch (error) {
    return false;
  }
}

function statusForError(error) {
  if (error && error.type === 'auth') return STATUS_AUTH_REQUIRED;
  if (error && error.type === 'network') return STATUS_RESMED_NETWORK;
  return STATUS_SERVICE_ERROR;
}

function fetchConfiguredScores(settings, requestId, done) {
  if (!settings.email || !settings.password) {
    appMessages.record({operation: 'fetch', requestId: requestId,
      event: 'domain_terminal', lifecycle: 'active', ready: true,
      finalCategory: 'unconfigured'});
    done(statusMessage(STATUS_UNCONFIGURED));
    return;
  }
  resMed.fetchSleepRecords({username: settings.email, password: settings.password},
    function (error, records) {
      if (error) {
        logResMedError('refresh', requestId, error);
        done(statusMessage(statusForError(error), error.message));
        return;
      }
      done(recordsMessage(records || []));
    });
}

function runScoreFetch(requestId, done) {
  var settings = readJson(SETTINGS_KEY, {});
  if (!isEmulator()) {
    fetchConfiguredScores(settings, requestId, done);
    return;
  }
  xhrJson('GET', DEV_BRIDGE_URL + '/health', '', null, function (healthError, health) {
    if (healthError || !health.devEmulator) {
      fetchConfiguredScores(settings, requestId, done);
      return;
    }
    xhrJson('GET', DEV_BRIDGE_URL + '/v1/dev/scores', '', null, function (error, response) {
      if (error) {
        logResMedError('refresh', requestId, error);
        done(statusMessage(statusForError(error), error.message));
        return;
      }
      done(recordsMessage(response.records || []));
    }, {'X-CPAP-Dev': '1'});
  });
}

var readOptions = {
  failureResponse: function () {
    return statusMessage(STATUS_SERVICE_ERROR, 'Phone request failed');
  }
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function settingsPage(settings, diagnosticReport) {
  var email = escapeHtml(settings.email || '');
  var hasPassword = Boolean(settings.password);
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>CPAP Settings</title><style>' +
    'body{margin:0;background:#f3f5f7;color:#101820;font:16px -apple-system,BlinkMacSystemFont,sans-serif}' +
    'main{max-width:520px;margin:auto;padding:24px 18px 40px}h1{margin:0 0 4px;color:#003b66}' +
    'p{line-height:1.4}.note{font-size:13px;color:#52606b;margin:6px 0 22px}' +
    'label{display:block;font-weight:650;margin:17px 0 6px}input{box-sizing:border-box;width:100%;font-size:16px;padding:12px;border:1px solid #9aa6af;border-radius:6px;background:white}' +
    'button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:6px;background:#0079b8;color:white;font-size:17px;font-weight:700}' +
    'h2{margin-top:34px}textarea{box-sizing:border-box;width:100%;height:150px;padding:10px;font:11px monospace}' +
    '.cancel{display:block;text-align:center;margin-top:18px;color:#52606b;text-decoration:none}' +
    '.privacy{border-left:4px solid #52606b;background:#e9edf0;padding:10px 12px;font-size:13px}' +
    '</style></head><body><main><h1>CPAP</h1><p>Connect your ResMed myAir account.</p>' +
    '<div class="privacy">This uses an unofficial ResMed API. Credentials stay in this app on your phone and are never sent to the watch.</div>' +
    '<form id="form"><label for="email">ResMed email</label><input id="email" type="email" required autocomplete="username" value="' + email + '">' +
    '<label for="password">ResMed password</label><input id="password" type="password" ' +
    (hasPassword ? 'placeholder="Saved — leave blank to keep"' : 'required') +
    ' autocomplete="current-password">' +
    '<p class="note">The Pebble mobile runtime has no keychain. Your password is stored in this app’s private local storage. After saving, return to CPAP and press Select.</p>' +
    '<button type="submit">Save</button></form>' +
    '<h2>Connection diagnostics</h2><p class="note">Saved errors contain no password, ResMed token, response body, or sleep record. Copy this report for debugging.</p>' +
    '<textarea id="diagnostics" readonly>' + escapeHtml(diagnosticReport) + '</textarea>' +
    '<button type="button" id="copy">Copy diagnostics</button><a class="cancel" href="pebblejs://close">Cancel</a>' +
    '<script>document.getElementById("copy").onclick=function(){var d=document.getElementById("diagnostics");d.select();document.execCommand("copy");this.textContent="Copied";};' +
    'document.getElementById("form").onsubmit=function(e){e.preventDefault();var v={' +
    'email:document.getElementById("email").value,password:document.getElementById("password").value};' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(v));};</script></main></body></html>';
}

function saveAccount(values) {
  var previous = readJson(SETTINGS_KEY, {});
  var password = values.password || previous.password;
  if (!values.email || !password) return;
  writeJson(SETTINGS_KEY, {version: 2, email: values.email, password: password});
  resMed.clearSession();
  appMessages.record({operation: 'settings', event: 'settings_saved',
    lifecycle: 'active', finalCategory: 'ok'});
}

appMessages.open();

Pebble.addEventListener('showConfiguration', function () {
  appMessages.replayLog(function (line) { console.log(line); });
  var page = settingsPage(readJson(SETTINGS_KEY, {}), appMessages.report());
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
});

Pebble.addEventListener('webviewclosed', function (event) {
  var values = decodeSettingsResponse(event.response);
  if (values && values.email) saveAccount(values);
});
