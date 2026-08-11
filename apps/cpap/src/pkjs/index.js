'use strict';

var CPAP = require('../common/cpap_model');
var XHR = require('../common/xhr_json');
var ResMed = require('../common/resmed_client');
var decodeSettingsResponse = require('../common/settings_response');
var createAppMessageSession =
  require('../../../../shared/appmessage/pkjs/app_message_session');
var createErrorReporter = require('../../../../shared/errors/pkjs/error_reporter');

var SETTINGS_KEY = 'cpap.settings.v2';
var ERROR_SETTINGS_KEY = 'cpap.errorReporting.v1';
var ERROR_OUTBOX_KEY = 'pebble.errors.cpap.v1';
var STATUS_UNCONFIGURED = 1;
var STATUS_AUTH_REQUIRED = 2;
var STATUS_SERVICE_ERROR = 4;
var STATUS_RESMED_NETWORK = 7;
var COMMAND_PHONE_READY = 2;
var DEV_BRIDGE_URL = 'http://127.0.0.1:8787';
var businessActive = 0;
var diagnosticSecrets = [];
var errorReporter;

function readJson(key, fallback, whileDoing) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    if (errorReporter) errorReporter.report(error, whileDoing || 'reading CPAP settings');
    return fallback;
  }
}

function writeJson(key, value, whileDoing) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    if (errorReporter) errorReporter.report(error, whileDoing || 'saving CPAP settings');
    return false;
  }
}

errorReporter = createErrorReporter({
  source: 'cpap/pkjs@0.1.0',
  watchSource: 'cpap/watch@0.1.0',
  storage: localStorage,
  storageKey: ERROR_OUTBOX_KEY,
  Xhr: XMLHttpRequest,
  config: readJson(ERROR_SETTINGS_KEY, {}),
  isIdle: function () { return businessActive === 0; },
  secrets: function () { return diagnosticSecrets; }
});

var xhrJson = XHR(XMLHttpRequest, {reportError: errorReporter.report});
var resMed = ResMed(XMLHttpRequest, localStorage, {reportError: errorReporter.report});

function readyMessage() {
  return {PROTOCOL: 1, COMMAND: COMMAND_PHONE_READY,
    ERROR_ENABLED: errorReporter.readyValue()};
}

var appMessages = createAppMessageSession({
  requestIdKey: 'REQUEST_ID',
  pebble: Pebble,
  errorReporter: errorReporter,
  readyMessage: readyMessage,
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

function recordsMessage(records) {
  return CPAP.responseDictionary(CPAP.sevenDaySlots(records, new Date()), Date.now(), 0, 1);
}

function isEmulator() {
  try {
    var info = Pebble.getActiveWatchInfo();
    return info && String(info.model || '').indexOf('qemu_platform_') === 0;
  } catch (error) {
    errorReporter.report(error, 'checking the active Pebble model');
    return false;
  }
}

function statusForError(error) {
  if (error && error.type === 'auth') return STATUS_AUTH_REQUIRED;
  if (error && error.type === 'network') return STATUS_RESMED_NETWORK;
  return STATUS_SERVICE_ERROR;
}

function fetchConfiguredScores(settings, done) {
  if (!settings.email || !settings.password) {
    done(statusMessage(STATUS_UNCONFIGURED));
    return;
  }
  diagnosticSecrets = [settings.email, settings.password];
  resMed.fetchSleepRecords({username: settings.email, password: settings.password},
    function (error, records) {
      if (error) {
        done(statusMessage(statusForError(error), error.message));
        return;
      }
      done(recordsMessage(records || []));
    });
}

function runScoreFetch(requestId, done) {
  var finished = false;
  businessActive += 1;
  function finish(response) {
    if (finished) return;
    finished = true;
    businessActive = Math.max(0, businessActive - 1);
    try { done(response); }
    catch (error) { errorReporter.report(error, 'returning the CPAP refresh response'); }
    errorReporter.sendNow();
  }
  try {
    var settings = readJson(SETTINGS_KEY, {}, 'reading the ResMed account settings');
    diagnosticSecrets = [settings.email || '', settings.password || ''];
    if (!isEmulator()) {
      fetchConfiguredScores(settings, finish);
      return;
    }
    xhrJson('GET', DEV_BRIDGE_URL + '/health', '', null, function (healthError, health) {
      if (healthError || !health.devEmulator) {
        fetchConfiguredScores(settings, finish);
        return;
      }
      xhrJson('GET', DEV_BRIDGE_URL + '/v1/dev/scores', '', null,
        function (error, response) {
          if (error) {
            finish(statusMessage(statusForError(error), error.message));
            return;
          }
          finish(recordsMessage(response.records || []));
        }, {'X-CPAP-Dev': '1'});
    });
  } catch (error) {
    try { error.requestId = requestId; } catch (ignored) {}
    errorReporter.report(error, 'running the CPAP refresh');
    finish(statusMessage(STATUS_SERVICE_ERROR, 'Phone request failed'));
  }
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

function settingsPage(settings, errorSettings, reportStatus) {
  var email = escapeHtml(settings.email || ''), hasPassword = Boolean(settings.password);
  var enabled = Boolean(errorSettings.enabled), hasKey = Boolean(errorSettings.key);
  var status = !reportStatus.enabled ? 'Off' :
    reportStatus.queued + ' queued; ' + reportStatus.dropped + ' dropped locally';
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>CPAP Settings</title><style>' +
    'body{margin:0;background:#f3f5f7;color:#101820;font:16px -apple-system,BlinkMacSystemFont,sans-serif}' +
    'main{max-width:520px;margin:auto;padding:24px 18px 40px}h1{margin:0 0 4px;color:#003b66}' +
    'p{line-height:1.4}.note{font-size:13px;color:#52606b;margin:6px 0 22px}' +
    'label{display:block;font-weight:650;margin:17px 0 6px}input[type=email],input[type=password]{box-sizing:border-box;width:100%;font-size:16px;padding:12px;border:1px solid #9aa6af;border-radius:6px;background:white}' +
    '.check{display:flex;gap:10px;align-items:center}.check input{width:20px;height:20px}' +
    'button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:6px;background:#0079b8;color:white;font-size:17px;font-weight:700}' +
    'h2{margin-top:34px}.cancel{display:block;text-align:center;margin-top:18px;color:#52606b;text-decoration:none}' +
    '.privacy{border-left:4px solid #52606b;background:#e9edf0;padding:10px 12px;font-size:13px}' +
    '</style></head><body><main><h1>CPAP</h1><p>Connect your ResMed myAir account.</p>' +
    '<div class="privacy">This uses an unofficial ResMed API. Credentials stay in this app on your phone and are never sent to the watch.</div>' +
    '<form id="form"><label for="email">ResMed email</label><input id="email" type="email" required autocomplete="username" value="' + email + '">' +
    '<label for="password">ResMed password</label><input id="password" type="password" ' +
    (hasPassword ? 'placeholder="Saved — leave blank to keep"' : 'required') +
    ' autocomplete="current-password">' +
    '<p class="note">The Pebble mobile runtime has no keychain. Your password is stored in this app’s private local storage.</p>' +
    '<h2>Error reporting</h2><label class="check"><input id="errors" type="checkbox" ' +
    (enabled ? 'checked' : '') + '>Send errors to Pebble Diagnostics</label>' +
    '<p class="note">Opt-in. Only failures are kept; credentials, tokens, and sleep data are removed. Offline errors wait locally. Create or recreate the Diagnostic key at <a href="https://pebble.exe.xyz/diagnostics" target="_blank" rel="noopener">pebble.exe.xyz</a>. Status: ' + status + '.</p>' +
    '<label for="errorKey">Diagnostic key</label><input id="errorKey" type="password" ' +
    (hasKey ? 'placeholder="Saved — leave blank to keep"' : '') + '>' +
    '<button type="submit">Save</button><button type="submit" id="send">Save and send now</button></form><a class="cancel" href="pebblejs://close">Cancel</a>' +
    '<script>var send=false;document.getElementById("send").onclick=function(){send=true;};document.getElementById("form").onsubmit=function(e){e.preventDefault();' +
    'var on=document.getElementById("errors").checked,k=document.getElementById("errorKey").value;' +
    'if(on&&!k&&' + (hasKey ? 'false' : 'true') + '){alert("A Diagnostic key is required.");return;}' +
    'var v={email:document.getElementById("email").value,password:document.getElementById("password").value,errorReporting:{enabled:on,key:k,sendNow:send}};' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(v));};</script></main></body></html>';
}

function saveAccount(values) {
  var previous = readJson(SETTINGS_KEY, {}, 'reading the saved ResMed account');
  var password = values.password || previous.password;
  if (!values.email || !password) return false;
  diagnosticSecrets = [values.email, password];
  if (!writeJson(SETTINGS_KEY,
    {version: 2, email: values.email, password: password}, 'saving the ResMed account')) return false;
  resMed.clearSession();
}

function saveErrorSettings(values) {
  if (values === undefined) return true;
  values = values || {};
  var previous = readJson(ERROR_SETTINGS_KEY, {}, 'reading CPAP error-reporting settings');
  if (!values.enabled) {
    var durable = writeJson(ERROR_SETTINGS_KEY, {enabled: false},
      'disabling CPAP error reporting');
    if (durable) {
      var marker = readJson(ERROR_SETTINGS_KEY, null, 'verifying disabled error reporting');
      durable = Boolean(marker && marker.enabled === false);
    }
    try {
      localStorage.removeItem(ERROR_SETTINGS_KEY);
      durable = localStorage.getItem(ERROR_SETTINGS_KEY) === null || durable;
    }
    catch (error) { errorReporter.report(error, 'disabling CPAP error reporting'); }
    if (!durable) return false;
    errorReporter.configure({enabled: false});
    return true;
  }
  var enteredKey = typeof values.key === 'string' ? values.key.trim() : '';
  var key = enteredKey || (typeof previous.key === 'string' ? previous.key.trim() : '');
  if (!key) {
    errorReporter.report(new Error('A Diagnostic key is required'),
      'saving CPAP error-reporting settings');
    return false;
  }
  var config = {enabled: true, key: key};
  errorReporter.configure(config);
  if (!writeJson(ERROR_SETTINGS_KEY, config, 'saving CPAP error-reporting settings')) {
    errorReporter.configure(previous);
    return false;
  }
  if (values.sendNow) errorReporter.sendNow();
}

appMessages.open();

Pebble.addEventListener('showConfiguration', function () {
  try {
    var page = settingsPage(readJson(SETTINGS_KEY, {}, 'reading CPAP account settings'),
      readJson(ERROR_SETTINGS_KEY, {}), errorReporter.status());
    Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  } catch (error) {
    errorReporter.report(error, 'opening the CPAP settings page');
  }
});

Pebble.addEventListener('webviewclosed', function (event) {
  try {
    var values = decodeSettingsResponse(event && event.response, errorReporter.report);
    if (!values || !values.email) return;
    saveAccount(values);
    saveErrorSettings(values.errorReporting);
    appMessages.announceReady(readyMessage());
  } catch (error) {
    errorReporter.report(error, 'saving the CPAP settings response');
  }
});
