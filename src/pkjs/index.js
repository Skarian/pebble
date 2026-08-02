'use strict';

var CPAP = require('../common/cpap_model');
var XHR = require('../common/xhr_json');
var xhrJson = XHR(XMLHttpRequest);
var ResMed = require('../common/resmed_client');
var resMed = ResMed(XMLHttpRequest, localStorage);
var decodeSettingsResponse = require('../common/settings_response');

var SETTINGS_KEY = 'cpap.settings.v2';
var STATUS_UNCONFIGURED = 1;
var STATUS_AUTH_REQUIRED = 2;
var STATUS_NETWORK_ERROR = 3;
var STATUS_SERVICE_ERROR = 4;
var STATUS_SYNCING = 6;
var lastRequestId = 0;
var requestInFlight = false;
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

function send(message) {
  Pebble.sendAppMessage(message, function () {}, function () {
    console.log('CPAP AppMessage delivery failed');
  });
}

function sendStatus(status, requestId, text) {
  var message = {
    PROTOCOL: 1,
    STATUS: status
  };
  if (requestId) {
    message.REQUEST_ID = requestId;
  }
  if (text) {
    message.ERROR_TEXT = text.slice(0, 48);
  }
  send(message);
}

function logResMedError(context, error) {
  error = error || {};
  console.log('CPAP ResMed ' + context + ' failed: type=' + (error.type || 'unknown') +
    ' step=' + (error.step || 'unknown') + ' status=' + (error.status || 0));
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function storeAndSendRecords(records, requestId) {
  var fetchedAt = Date.now();
  var slots = CPAP.sevenDaySlots(records, new Date());
  send(CPAP.responseDictionary(slots, fetchedAt, requestId, 1));
}

function isEmulator() {
  try {
    var info = Pebble.getActiveWatchInfo();
    return info && String(info.model || '').indexOf('qemu_platform_') === 0;
  } catch (error) {
    return false;
  }
}

function fetchConfiguredScores(settings) {
  if (!settings.email || !settings.password) {
    requestInFlight = false;
    sendStatus(STATUS_UNCONFIGURED, lastRequestId);
    return;
  }

  resMed.fetchSleepRecords({username: settings.email, password: settings.password},
    function (error, records) {
      requestInFlight = false;
      if (error) {
        logResMedError('refresh', error);
        if (error.type === 'auth') {
          sendStatus(STATUS_AUTH_REQUIRED, lastRequestId, error.message);
        } else {
          sendStatus(error.type === 'network' ? STATUS_NETWORK_ERROR : STATUS_SERVICE_ERROR,
            lastRequestId, error.message);
        }
        return;
      }
      storeAndSendRecords(records || [], lastRequestId);
    });
}

function fetchScores(requestId) {
  lastRequestId = requestId || 0;
  var settings = readJson(SETTINGS_KEY, {});
  if (requestInFlight) {
    return;
  }
  requestInFlight = true;

  if (!isEmulator()) {
    fetchConfiguredScores(settings);
    return;
  }

  xhrJson('GET', DEV_BRIDGE_URL + '/health', '', null, function (healthError, health) {
    if (healthError || !health.devEmulator) {
      fetchConfiguredScores(settings);
      return;
    }
    xhrJson('GET', DEV_BRIDGE_URL + '/v1/dev/scores', '', null, function (error, response) {
      requestInFlight = false;
      if (error) {
        sendStatus(error.type === 'network' ? STATUS_NETWORK_ERROR :
          error.type === 'auth' ? STATUS_AUTH_REQUIRED : STATUS_SERVICE_ERROR,
        lastRequestId, error.message);
        return;
      }
      storeAndSendRecords(response.records || [], lastRequestId);
    }, {'X-CPAP-Dev': '1'});
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function settingsPage(settings) {
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
    '.cancel{display:block;text-align:center;margin-top:18px;color:#52606b;text-decoration:none}' +
    '.privacy{border-left:4px solid #52606b;background:#e9edf0;padding:10px 12px;font-size:13px}' +
    '</style></head><body><main><h1>CPAP</h1><p>Connect your ResMed myAir account.</p>' +
    '<div class="privacy">This uses an unofficial ResMed API. Credentials stay in this app on your phone and are never sent to the watch.</div>' +
    '<form id="form"><label for="email">ResMed email</label><input id="email" type="email" required autocomplete="username" value="' + email + '">' +
    '<label for="password">ResMed password</label><input id="password" type="password" ' +
    (hasPassword ? 'placeholder="Saved — leave blank to keep"' : 'required') +
    ' autocomplete="current-password">' +
    '<p class="note">The Pebble mobile runtime has no keychain. Your password is stored in this app’s private local storage.</p>' +
    '<button type="submit">Save and connect</button></form><a class="cancel" href="pebblejs://close">Cancel</a>' +
    '<script>document.getElementById("form").onsubmit=function(e){e.preventDefault();var v={' +
    'email:document.getElementById("email").value,password:document.getElementById("password").value};' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(v));};</script></main></body></html>';
}

function connectAccount(values) {
  var previous = readJson(SETTINGS_KEY, {});
  var password = values.password || previous.password;
  if (!values.email || !password) {
    sendStatus(STATUS_UNCONFIGURED, lastRequestId);
    return;
  }
  var candidate = {version: 2, email: values.email, password: password};
  writeJson(SETTINGS_KEY, candidate);
  sendStatus(STATUS_SYNCING, lastRequestId);
  requestInFlight = true;
  resMed.clearSession();
  resMed.fetchSleepRecords({username: candidate.email, password: candidate.password},
    function (error, records) {
      requestInFlight = false;
      if (error) {
        logResMedError('connect', error);
        sendStatus(error.type === 'network' ? STATUS_NETWORK_ERROR :
          error.type === 'auth' ? STATUS_AUTH_REQUIRED : STATUS_SERVICE_ERROR,
          lastRequestId, error.message);
        return;
      }
      storeAndSendRecords(records || [], lastRequestId);
    });
}

Pebble.addEventListener('appmessage', function (event) {
  if (event.payload.COMMAND === 1) {
    fetchScores(event.payload.REQUEST_ID || 0);
  }
});

Pebble.addEventListener('showConfiguration', function () {
  var page = settingsPage(readJson(SETTINGS_KEY, {}));
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
});

Pebble.addEventListener('webviewclosed', function (event) {
  var values = decodeSettingsResponse(event.response);
  if (values && values.email) {
    connectAccount(values);
  }
});
