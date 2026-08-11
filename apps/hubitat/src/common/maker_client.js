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

function sourceError(name, message, fields) {
  var error = new Error(message); error.name = name;
  Object.keys(fields || {}).forEach(function (key) { error[key] = fields[key]; });
  return error;
}

function create(xhrFactory, options) {
  options = options || {};
  var report = typeof options.reportError === 'function' ? options.reportError : function () {};

  function requestJson(url, whileDoing, secrets, callback) {
    var xhr;
    var completed = false;
    function capture(error, action) { try { report(error, action || whileDoing, secrets); } catch (ignored) {} }
    function finish(error, response) {
      if (completed) return;
      completed = true;
      try { callback(error, response); }
      catch (callbackError) { capture(callbackError, 'returning a Hubitat response'); }
    }
    function responseFields(includeBody) {
      var headers = '';
      try { if (xhr.getAllResponseHeaders) headers = xhr.getAllResponseHeaders() || ''; }
      catch (error) { capture(error, 'reading Hubitat response headers'); }
      var fields = {type: 'service', status: Number(xhr.status || 0),
        statusText: String(xhr.statusText || ''), headers: headers, method: 'GET', url: url};
      if (includeBody) fields.body = String(xhr.responseText || '');
      return fields;
    }
    function transportFailure(type, name, message, original) {
      var error = sourceError(name, message,
        {type: type, method: 'GET', url: url});
      if (original && typeof original === 'object') {
        error.original = original;
        error.event = {};
        ['type', 'loaded', 'total', 'lengthComputable'].forEach(function (key) {
          try { if (original[key] !== undefined) error.event[key] = original[key]; }
          catch (ignored) {}
        });
      }
      capture(error);
      finish(error);
    }
    function guard(action, work) {
      try { work(); }
      catch (error) {
        capture(error, action);
        if (!error.type) error.type = 'service';
        finish(error);
      }
    }
    try {
      xhr = xhrFactory();
      xhr.open('GET', url, true);
      xhr.timeout = 12000;
      xhr.onreadystatechange = function () { guard('handling a Hubitat response', function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status < 200 || xhr.status >= 300) {
          var fields = responseFields(true);
          fields.type = xhr.status === 401 || xhr.status === 403 ? 'auth' : 'service';
          var httpError = sourceError('HubitatHttpError', fields.type === 'auth' ?
            'Maker API access denied' : 'Hubitat returned HTTP ' + xhr.status, fields);
          capture(httpError); finish(httpError); return;
        }
        try { finish(null, JSON.parse(xhr.responseText)); }
        catch (error) {
          var metadata = responseFields(true);
          Object.keys(metadata).forEach(function (key) { error[key] = metadata[key]; });
          error.type = 'service'; error.responseBytes = String(xhr.responseText || '').length;
          capture(error, 'parsing a Hubitat response'); finish(error);
        }
      });
      };
      xhr.ontimeout = function (event) { transportFailure('timeout', 'HubitatTimeoutError',
        'Hubitat request timed out', event); };
      xhr.onerror = function (event) { transportFailure('network', 'HubitatNetworkError',
        'Phone cannot reach Hubitat', event); };
      xhr.onloadend = function (event) {
        if (!completed && (!xhr.status || xhr.status === 0)) transportFailure(
          'network', 'HubitatNetworkError', 'Phone cannot reach Hubitat', event);
      };
      xhr.send();
    } catch (error) {
      capture(error, 'starting a Hubitat request');
      if (!error.type) error.type = 'network';
      finish(error);
    }
  }

  return {
    devices: function (settings, callback) {
      var valid = validateSettings(settings);
      requestJson(endpoint(valid, 'devices/all'), 'refreshing Hubitat devices',
        [valid.token], callback);
    },
    command: function (settings, deviceId, command, callback) {
      var allowed = {on: true, off: true, lock: true, unlock: true};
      if (!allowed[command] || !/^\d+$/.test(String(deviceId))) {
        var validation = sourceError('HubitatCommandError', !allowed[command] ?
          'Command is not allowed' : 'Invalid device ID',
        {type: 'service', command: command, deviceId: String(deviceId)});
        report(validation, 'validating a Hubitat control request');
        callback(validation); return;
      }
      var valid = validateSettings(settings);
      requestJson(endpoint(valid, 'devices/' + deviceId + '/' + command),
        'controlling a Hubitat device', [valid.token], callback);
    }
  };
}

create.endpoint = endpoint;
create.validateSettings = validateSettings;
module.exports = create;
