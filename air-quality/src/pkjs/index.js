'use strict';

var Model = require('../common/air_quality_model');
var Aranet = require('../common/aranet_client');
var client = Aranet(XMLHttpRequest);
var SETTINGS_KEY = 'airquality.settings.v1';
var DIAGNOSTICS_KEY = 'airquality.diagnostics.v1';
var requestInFlight = false;
var latestRequestId = 0;

var STATUS = {UNCONFIGURED: 1, AUTH: 2, RATE: 3, PHONE: 4, NETWORK: 5, TIMEOUT: 6, SERVICE: 7};

function readJson(key, fallback) {
  try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch (error) { return fallback; }
}

function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function diagnose(error) {
  var entries = readJson(DIAGNOSTICS_KEY, []);
  entries.push({at: new Date().toISOString(), type: String(error.type || 'unknown'),
    status: Number(error.status || 0), step: String(error.step || 'history'),
    replay: String(error.type || 'unknown') + ':history'});
  writeJson(DIAGNOSTICS_KEY, entries.slice(-12));
}

function send(message) {
  Pebble.sendAppMessage(message, function () {}, function () {
    console.log('AIRQUALITY_DIAGNOSTIC ' + JSON.stringify({type: 'delivery', step: 'appmessage'}));
  });
}

function sendStatus(status, requestId, text) {
  var message = {PROTOCOL: 1, STATUS: status};
  if (requestId) message.REQUEST_ID = requestId;
  if (text) message.ERROR_TEXT = String(text).slice(0, 48);
  send(message);
}

function statusFor(error) {
  if (error.type === 'unconfigured') return STATUS.UNCONFIGURED;
  if (error.type === 'auth') return STATUS.AUTH;
  if (error.type === 'rate') return STATUS.RATE;
  if (error.type === 'network') return STATUS.NETWORK;
  if (error.type === 'timeout') return STATUS.TIMEOUT;
  return STATUS.SERVICE;
}

function refresh(requestId) {
  if (requestInFlight) return;
  latestRequestId = requestId || latestRequestId;
  requestInFlight = true;
  client.fetchSnapshot(readJson(SETTINGS_KEY, {}), function (error, snapshot) {
    requestInFlight = false;
    if (error) { diagnose(error); sendStatus(statusFor(error), latestRequestId, error.message); return; }
    send(Model.dictionary(snapshot, Date.now(), latestRequestId));
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function settingsPage(settings) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>AirQuality Settings</title><style>body{margin:0;background:#f4f4f4;color:#111;font:16px -apple-system,sans-serif}' +
    'main{max-width:520px;margin:auto;padding:24px 18px 40px}h1{margin:0 0 4px}p{line-height:1.4}.note{font-size:13px;color:#555}' +
    'label{display:block;font-weight:700;margin:18px 0 6px}input{box-sizing:border-box;width:100%;font-size:16px;padding:12px;border:1px solid #777;border-radius:5px}' +
    'button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:5px;background:#111;color:#fff;font-size:17px;font-weight:700}</style></head>' +
    '<body><main><h1>AirQuality</h1><p>Connect your Aranet sensor.</p><form id="form">' +
    '<label for="share">Aranet sensor ID</label><input id="share" required value="' + escapeHtml(settings.sharingId || '') + '">' +
    '<label for="key">Aranet API key</label><input id="key" type="password" ' + (settings.apiCredential ? 'placeholder="Saved - leave blank to keep"' : 'required') + '>' +
    '<label for="location">Location</label><input id="location" required maxlength="31" value="' + escapeHtml(settings.location || '') + '">' +
    '<p class="note">The API key stays on your phone and is never sent to the watch.</p>' +
    '<button type="submit">Save and refresh</button></form><script>var saved=' + JSON.stringify(settings.apiCredential || '') + ';' +
    'document.getElementById("form").onsubmit=function(e){e.preventDefault();var key=document.getElementById("key").value||saved;' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify({sharingId:document.getElementById("share").value.trim(),apiCredential:key,location:document.getElementById("location").value.trim()}));};' +
    '</script></main></body></html>';
}

Pebble.addEventListener('ready', function () { send({PROTOCOL: 1, COMMAND: 2}); });
Pebble.addEventListener('appmessage', function (event) {
  if (event.payload.COMMAND === 1) refresh(event.payload.REQUEST_ID || 0);
});
Pebble.addEventListener('showConfiguration', function () {
  readJson(DIAGNOSTICS_KEY, []).forEach(function (entry) {
    console.log('AIRQUALITY_DIAGNOSTIC ' + JSON.stringify(entry));
  });
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(settingsPage(readJson(SETTINGS_KEY, {}))));
});
Pebble.addEventListener('webviewclosed', function (event) {
  if (!event.response) return;
  try { var settings = JSON.parse(decodeURIComponent(event.response)); writeJson(SETTINGS_KEY, settings); refresh(latestRequestId); }
  catch (error) { console.log('AIRQUALITY_DIAGNOSTIC ' + JSON.stringify({type: 'settings', step: 'decode'})); }
});
