'use strict';

function publicBridgeMessage(status, code) {
  if (status === 401) {
    return code === 'mfa_required' ? 'MFA is not supported' : 'ResMed sign-in failed';
  }
  return 'Bridge unavailable';
}

function isAllowedBridgeUrl(value, emulator) {
  var url = String(value || '');
  return /^https:\/\/[^/]/i.test(url) ||
    Boolean(emulator && /^http:\/\/127\.0\.0\.1(?::\d+)?(?:\/.*)?$/i.test(url));
}

function diagnosticBody(url, text) {
  text = String(text || '');
  if (!/\/scores(?:[/?#]|$)/.test(url)) return text;
  try {
    var payload = JSON.parse(text || '{}'), envelope = {};
    Object.keys(payload).forEach(function (key) {
      if (key !== 'records' && key !== 'data') envelope[key] = payload[key];
    });
    return JSON.stringify(envelope);
  } catch (ignored) { return '[unparseable score response; bytes=' + text.length + ']'; }
}

function createXhrJson(Xhr, options) {
  var reportError = options && options.reportError;
  function report(error, whileDoing, secrets) {
    try { if (typeof reportError === 'function') reportError(error, whileDoing, secrets || []); }
    catch (ignored) {}
  }

  return function xhrJson(method, url, bearer, body, callback, extraHeaders) {
    var xhr, completed = false;
    var secrets = bearer ? [bearer] : [];

    function finish(error, response) {
      if (completed) return;
      completed = true;
      try { callback(error, response); }
      catch (callbackError) { report(callbackError, 'running the CPAP bridge callback', secrets); }
    }

    function fail(error, publicError, fields) {
      if (completed) return;
      error = error instanceof Error ? error : new Error(String(error || 'Bridge request failed'));
      error.method = method; error.url = url;
      Object.keys(fields || {}).forEach(function (key) { error[key] = fields[key]; });
      report(error, 'requesting the CPAP development bridge', secrets);
      finish(publicError);
    }

    function responseFields() {
      var headers = '', statusText = '';
      try {
        if (typeof xhr.getAllResponseHeaders === 'function') {
          headers = String(xhr.getAllResponseHeaders() || '').slice(0, 8192);
        }
      } catch (error) { report(error, 'reading the CPAP bridge response headers', secrets); }
      try { statusText = String(xhr.statusText || ''); }
      catch (error) { report(error, 'reading the CPAP bridge response status', secrets); }
      return {status: Number(xhr.status || 0), statusText: statusText,
        headers: headers, body: diagnosticBody(url, xhr.responseText)};
    }

    try {
      xhr = new Xhr();
      xhr.timeout = 30000;
      xhr.open(method, url, true);
      xhr.setRequestHeader('Accept', 'application/json');
      if (body !== null) xhr.setRequestHeader('Content-Type', 'application/json');
      if (bearer) xhr.setRequestHeader('Authorization', 'Bearer ' + bearer);
      Object.keys(extraHeaders || {}).forEach(function (name) {
        xhr.setRequestHeader(name, extraHeaders[name]);
      });
    } catch (error) {
      fail(error, {type: 'network', message: 'Phone or bridge offline'});
      return;
    }

    xhr.onload = function () {
      if (completed) return;
      var parsed;
      try { parsed = JSON.parse(xhr.responseText || '{}'); }
      catch (error) {
        fail(error, {type: 'service', message: 'Invalid bridge response'}, responseFields());
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) { finish(null, parsed); return; }
      var type = xhr.status === 401 ? 'auth' : 'service';
      var error = new Error('Bridge returned HTTP ' + Number(xhr.status || 0));
      error.name = 'BridgeHttpError';
      fail(error, {type: type, message: publicBridgeMessage(xhr.status, parsed.code)},
        responseFields());
    };
    xhr.onerror = function () {
      fail(new Error('The bridge request failed'),
        {type: 'network', message: 'Phone or bridge offline'}, {event: 'error'});
    };
    xhr.ontimeout = function () {
      fail(new Error('The bridge request timed out'),
        {type: 'network', message: 'Bridge timed out'}, {event: 'timeout'});
    };
    xhr.onloadend = function () {
      if (!completed && (!xhr.status || xhr.status === 0)) {
        fail(new Error('The bridge closed without a response'),
          {type: 'network', message: 'Phone or bridge offline'}, {event: 'loadend'});
      }
    };

    var serialized = null;
    try { if (body !== null) serialized = JSON.stringify(body); }
    catch (error) {
      fail(error, {type: 'service', message: 'Bridge request failed'});
      return;
    }
    try { xhr.send(serialized); }
    catch (error) { fail(error, {type: 'network', message: 'Phone or bridge offline'}); }
  };
}

module.exports = createXhrJson;
module.exports.isAllowedBridgeUrl = isAllowedBridgeUrl;
module.exports.publicBridgeMessage = publicBridgeMessage;
