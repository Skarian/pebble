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

function createXhrJson(Xhr) {
  return function xhrJson(method, url, bearer, body, callback, extraHeaders) {
    var xhr = new Xhr();
    var completed = false;

    function finish(error, response) {
      if (completed) {
        return;
      }
      completed = true;
      callback(error, response);
    }

    xhr.timeout = 30000;
    xhr.open(method, url, true);
    xhr.setRequestHeader('Accept', 'application/json');
    if (body !== null) {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }
    if (bearer) {
      xhr.setRequestHeader('Authorization', 'Bearer ' + bearer);
    }
    Object.keys(extraHeaders || {}).forEach(function (name) {
      xhr.setRequestHeader(name, extraHeaders[name]);
    });
    xhr.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(xhr.responseText || '{}');
      } catch (error) {
        finish({type: 'service', message: 'Invalid bridge response'});
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(null, parsed);
      } else if (xhr.status === 401) {
        finish({type: 'auth', message: publicBridgeMessage(xhr.status, parsed.code)});
      } else {
        finish({type: 'service', message: publicBridgeMessage(xhr.status, parsed.code)});
      }
    };
    xhr.onerror = function () {
      finish({type: 'network', message: 'Phone or bridge offline'});
    };
    xhr.ontimeout = function () {
      finish({type: 'network', message: 'Bridge timed out'});
    };
    xhr.onloadend = function () {
      if (!completed && (!xhr.status || xhr.status === 0)) {
        finish({type: 'network', message: 'Phone or bridge offline'});
      }
    };
    xhr.send(body === null ? null : JSON.stringify(body));
  };
}

module.exports = createXhrJson;
module.exports.isAllowedBridgeUrl = isAllowedBridgeUrl;
module.exports.publicBridgeMessage = publicBridgeMessage;
