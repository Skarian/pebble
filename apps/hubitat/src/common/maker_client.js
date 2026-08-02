'use strict';

function trimSlash(value) { return String(value || '').trim().replace(/\/+$/, ''); }

function validateSettings(settings) {
  var baseUrl = trimSlash(settings.baseUrl);
  var token = String(settings.token || '').trim();
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Maker API URL must start with http:// or https://');
  if (!token) throw new Error('Maker API access token is required');
  return {baseUrl: baseUrl, token: token, deviceIds: settings.deviceIds || []};
}

function endpoint(settings, path) {
  var valid = validateSettings(settings);
  var separator = path.indexOf('?') === -1 ? '?' : '&';
  return valid.baseUrl + '/' + path.replace(/^\//, '') + separator + 'access_token=' + encodeURIComponent(valid.token);
}

function requestJson(xhrFactory, url, callback) {
  var xhr = xhrFactory();
  var completed = false;
  function finish(error, response) {
    if (completed) return;
    completed = true;
    callback(error, response);
  }
  xhr.open('GET', url, true);
  xhr.timeout = 12000;
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status === 401 || xhr.status === 403) return finish({type: 'auth', status: xhr.status, message: 'Maker API access denied'});
    if (xhr.status < 200 || xhr.status >= 300) return finish({type: 'service', status: xhr.status, message: 'Hubitat returned HTTP ' + xhr.status});
    try { finish(null, JSON.parse(xhr.responseText)); }
    catch (error) { finish({type: 'service', status: xhr.status, message: 'Hubitat returned invalid JSON'}); }
  };
  xhr.ontimeout = function () { finish({type: 'timeout', message: 'Hubitat request timed out'}); };
  xhr.onerror = function () { finish({type: 'network', message: 'Phone cannot reach Hubitat'}); };
  xhr.onloadend = function () {
    if (!completed && (!xhr.status || xhr.status === 0)) finish({type: 'network', message: 'Phone cannot reach Hubitat'});
  };
  xhr.send();
}

function create(xhrFactory) {
  return {
    devices: function (settings, callback) {
      requestJson(xhrFactory, endpoint(settings, 'devices/all'), callback);
    },
    command: function (settings, deviceId, command, callback) {
      var allowed = {on: true, off: true, lock: true, unlock: true};
      if (!allowed[command]) return callback({type: 'service', message: 'Command is not allowed'});
      if (!/^\d+$/.test(String(deviceId))) return callback({type: 'service', message: 'Invalid device ID'});
      requestJson(xhrFactory, endpoint(settings, 'devices/' + deviceId + '/' + command), callback);
    }
  };
}

create.endpoint = endpoint;
create.validateSettings = validateSettings;
module.exports = create;
