'use strict';

var sha256 = require('./sha256');

var CONFIG = {
  clientId: '0oa4ccq1v413ypROi297',
  apiKey: 'da2-cenztfjrezhwphdqtwtbpqvzui',
  authnUrl: 'https://resmed-ext-1.okta.com/api/v1/authn',
  authorizeUrl: 'https://resmed-ext-1.okta.com/oauth2/aus4ccsxvnidQgLmA297/v1/authorize',
  tokenUrl: 'https://resmed-ext-1.okta.com/oauth2/aus4ccsxvnidQgLmA297/v1/token',
  graphqlUrl: 'https://graphql.myair-prd.dht.live/graphql',
  redirectUrl: 'https://myair.resmed.com'
};

var TOKEN_KEY = 'cpap.resmed.tokens.v1';
var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
var STATE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function encodeForm(values) {
  var pairs = [];
  Object.keys(values).forEach(function (key) {
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(values[key]));
  });
  return pairs.join('&');
}

function bytesToBase64Url(bytes) {
  var result = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i];
    var b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    result += BASE64.charAt(a >> 2);
    result += BASE64.charAt(((a & 3) << 4) | (b >> 4));
    if (i + 1 < bytes.length) result += BASE64.charAt(((b & 15) << 2) | (c >> 6));
    if (i + 2 < bytes.length) result += BASE64.charAt(c & 63);
  }
  return result.replace(/\+/g, '-').replace(/\//g, '_');
}

function randomString(length, characters) {
  var result = '';
  var seed = '';
  while (result.length < length) {
    seed = Date.now() + ':' + Math.random() + ':' + seed + ':' + result.length;
    var bytes = sha256(seed);
    for (var i = 0; i < bytes.length && result.length < length; i++) {
      result += characters.charAt(bytes[i] % characters.length);
    }
  }
  return result;
}

function parseJsonQuiet(text) {
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    return null;
  }
}

function responseCode(payload) {
  var candidate = payload && (payload.errorCode || payload.code ||
    (payload.errors && payload.errors[0] && payload.errors[0].extensions &&
      payload.errors[0].extensions.code));
  return typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(candidate) ?
    candidate : '';
}

function diagnosticResponseBody(text, step) {
  var result = String(text || '');
  if (step === 'authorization') {
    result = result
      .replace(/(data\.(?:code|state)\s*=\s*['"])[^'"]+/ig, '$1[REDACTED]')
      .replace(/(["'](?:code|state)["']\s*:\s*["'])[^"']+/ig, '$1[REDACTED]')
      .replace(/([?&](?:code|state)=)[^&"'\s]+/ig, '$1[REDACTED]');
  }
  if (step === 'sleep records') {
    var payload = parseJsonQuiet(result);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return '[unparseable sleep response; bytes=' + result.length + ']';
    }
    var envelope = {};
    Object.keys(payload).forEach(function (key) {
      if (key !== 'data') envelope[key] = payload[key];
    });
    result = JSON.stringify(envelope);
  }
  return result.length > 8192 ? result.slice(0, 8181) + '[TRUNCATED]' : result;
}

function publicFailure(type, message, fields) {
  var error = new Error(message);
  error.type = type;
  Object.keys(fields || {}).forEach(function (key) { error[key] = fields[key]; });
  return error;
}

function formatDate(date) {
  return date.getFullYear() + '-' + ('0' + (date.getMonth() + 1)).slice(-2) + '-' +
    ('0' + date.getDate()).slice(-2);
}

function createClient(Xhr, storage, options) {
  options = options || {};
  var requestTimeoutMs = options.requestTimeoutMs === undefined ? 12000 : options.requestTimeoutMs;
  var setTimer = options.setTimer || setTimeout;
  var clearTimer = options.clearTimer || clearTimeout;
  var retryDelay = options.retryDelay || function (callback) { setTimer(callback, 1000); };
  var reportError = options.reportError;

  function report(error, whileDoing, privateValues) {
    try {
      if (typeof reportError === 'function') reportError(error, whileDoing, privateValues || []);
    } catch (ignored) {}
    return error;
  }

  function capture(error, whileDoing, fields, privateValues) {
    error = error instanceof Error ? error : new Error(String(error || 'ResMed failure'));
    Object.keys(fields || {}).forEach(function (key) { error[key] = fields[key]; });
    return report(error, whileDoing, privateValues);
  }

  function responseHeaders(xhr, step, privateValues) {
    try {
      return typeof xhr.getAllResponseHeaders === 'function' ?
        String(xhr.getAllResponseHeaders() || '').slice(0, 8192) : '';
    } catch (error) {
      report(error, 'reading the ResMed ' + step + ' response headers', privateValues);
      return '';
    }
  }

  function parseResponse(text, step, response, privateValues) {
    try { return JSON.parse(text || '{}'); }
    catch (error) {
      capture(error, 'parsing the ResMed ' + step + ' response', {
        step: step,
        status: response && response.status || 0,
        statusText: response && response.statusText || '',
        headers: response && response.headers || '',
        elapsedMs: response && response.elapsedMs || 0,
        body: diagnosticResponseBody(text, step)
      }, privateValues);
      return null;
    }
  }

  function responseError(type, message, fields, body, privateValues) {
    var error = publicFailure(type, message, fields);
    error.name = 'ResMedResponseError';
    if (body !== undefined) error.body = body;
    report(error, 'validating the ResMed ' + fields.step + ' response', privateValues);
    delete error.body; delete error.headers; delete error.statusText;
    return error;
  }

  function errorForResponse(response, step, privateValues) {
    var body = parseJsonQuiet(response.text) || {};
    var auth = response.status === 401 || response.status === 403 ||
      body.errorCode === 'E0000004';
    var oneTimeCodeRejected = step === 'token exchange' && response.status === 400 &&
      body.error === 'invalid_grant';
    var code = oneTimeCodeRejected ? 'invalid_grant' : responseCode(body);
    var transient = response.status === 502 || response.status === 503 ||
      response.status === 504 || oneTimeCodeRejected;
    var fields = {
      transient: transient,
      step: step,
      status: response.status,
      statusText: response.statusText || '',
      headers: response.headers || '',
      elapsedMs: response.elapsedMs || 0,
      code: code
    };
    var error = publicFailure(auth ? 'auth' : 'service',
      auth ? 'ResMed sign-in failed' : 'ResMed unavailable', fields);
    error.name = 'ResMedHttpError';
    error.method = response.method; error.url = response.url;
    error.body = diagnosticResponseBody(response.text, step);
    capture(error, 'receiving the ResMed ' + step + ' response', {
      step: step, status: response.status, statusText: response.statusText || '',
      headers: response.headers || '', elapsedMs: response.elapsedMs || 0, code: code
    }, privateValues);
    delete error.method; delete error.url; delete error.body; delete error.headers;
    delete error.statusText;
    return error;
  }

  function transportError(kind, message, step, fields, cause, privateValues) {
    fields = fields || {};
    var result = publicFailure('network', message, {
      transient: true, step: step, status: 0, elapsedMs: fields.elapsedMs || 0,
      event: kind
    });
    var error = cause || result;
    if (!cause) error.name = 'ResMedTransportError';
    capture(error, 'requesting the ResMed ' + step + ' endpoint', {
      kind: kind,
      method: fields.method,
      url: fields.url,
      step: step,
      elapsedMs: fields.elapsedMs || 0
    }, privateValues);
    return result;
  }

  function request(method, url, headers, body, callback, privateValues) {
    var xhr, finished = false, timer = null;
    var startedAt = Date.now();
    var step = url.indexOf(CONFIG.authnUrl) === 0 ? 'authentication' :
      url.indexOf(CONFIG.authorizeUrl) === 0 ? 'authorization' :
      url.indexOf(CONFIG.tokenUrl) === 0 ? 'token exchange' : 'sleep records';

    function finish(error, response) {
      if (finished) return;
      finished = true;
      if (timer !== null) {
        try { clearTimer(timer); }
        catch (timerError) { report(timerError, 'cancelling the ResMed request timer'); }
      }
      if (error) error.elapsedMs = Date.now() - startedAt;
      if (response) response.elapsedMs = Date.now() - startedAt;
      try { callback(error, response); }
      catch (callbackError) {
        report(callbackError, 'running the ResMed ' + step + ' response callback');
      }
    }

    try {
      xhr = new Xhr();
      xhr.timeout = requestTimeoutMs;
      xhr.open(method, url, true);
      Object.keys(headers || {}).forEach(function (name) {
        xhr.setRequestHeader(name, headers[name]);
      });
    } catch (error) {
      finish(transportError('exception', 'Phone cannot start the ResMed request', step,
        {method: method, url: url}, error, privateValues));
      return;
    }
    xhr.onload = function () {
      if (finished) return;
      try {
        finish(null, {method: method, url: url,
          status: Number(xhr.status || 0), statusText: String(xhr.statusText || ''),
          headers: responseHeaders(xhr, step, privateValues), text: xhr.responseText || ''});
      } catch (error) {
        finish(transportError('callback', 'Phone could not read the ResMed response', step,
          {method: method, url: url}, error, privateValues));
      }
    };
    xhr.onerror = function () {
      if (finished) return;
      finish(transportError('network', 'Phone cannot be reached', step,
        {method: method, url: url, elapsedMs: Date.now() - startedAt}, null, privateValues));
    };
    xhr.ontimeout = function () {
      if (finished) return;
      finish(transportError('timeout', 'ResMed timed out', step,
        {method: method, url: url, elapsedMs: Date.now() - startedAt}, null, privateValues));
    };
    xhr.onloadend = function () {
      if (!finished && (!xhr.status || xhr.status === 0)) {
        finish(transportError('network', 'Phone cannot be reached', step,
          {method: method, url: url, elapsedMs: Date.now() - startedAt}, null, privateValues));
      }
    };
    if (requestTimeoutMs > 0) {
      try {
        timer = setTimer(function () {
          if (finished) return;
          try { xhr.abort(); }
          catch (error) { report(error, 'aborting the ResMed request', privateValues); }
          finish(transportError('timeout', 'ResMed timed out', step,
            {method: method, url: url, elapsedMs: Date.now() - startedAt}, null,
            privateValues));
        }, requestTimeoutMs);
      } catch (error) {
        report(error, 'scheduling the ResMed request timer', privateValues);
      }
    }
    try { xhr.send(body === undefined ? null : body); }
    catch (error) {
      finish(transportError('exception', 'Phone could not send the ResMed request', step,
        {method: method, url: url}, error, privateValues));
    }
  }

  function readToken() {
    var token;
    var raw;
    try { raw = storage.getItem(TOKEN_KEY); }
    catch (error) {
      capture(error, 'reading the saved ResMed session', {operation: 'read'});
      return null;
    }
    if (!raw) return null;
    try { token = JSON.parse(raw); }
    catch (error) {
      capture(error, 'parsing the saved ResMed session', {operation: 'parse', body: raw});
      return null;
    }
    if (!token || !token.accessToken || !token.idToken || !token.expiresAt) {
      capture(new Error('The saved ResMed session is incomplete'),
        'validating the saved ResMed session', {operation: 'validate', body: raw});
      return null;
    }
    return Date.now() < token.expiresAt - 300000 ? token : null;
  }

  function saveToken(payload) {
    var token = {
      accessToken: payload.access_token,
      idToken: payload.id_token,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
    };
    try { storage.setItem(TOKEN_KEY, JSON.stringify(token)); }
    catch (error) {
      capture(error, 'saving the ResMed session', {operation: 'write'},
        [token.accessToken, token.idToken]);
    }
    return token;
  }

  function clearToken() {
    try { storage.removeItem(TOKEN_KEY); }
    catch (error) {
      capture(error, 'clearing the saved ResMed session', {operation: 'delete'});
    }
  }

  function parseAuthorization(html, expectedState, privateValues) {
    var code = /data\.code\s*=\s*['"]([^'"]+)['"]/i.exec(html) ||
      /["']code["']\s*:\s*["']([^"']+)["']/i.exec(html) ||
      /(?:^|[?&])code=([^&"'\s]+)/i.exec(html);
    var state = /data\.state\s*=\s*['"]([^'"]+)['"]/i.exec(html) ||
      /["']state["']\s*:\s*["']([^"']+)["']/i.exec(html) ||
      /(?:^|[?&])state=([^&"'\s]+)/i.exec(html);
    if (!code && !state) return null;
    try {
      var decodedCode = code ? decodeURIComponent(code[1]) : '';
      var decodedState = state ? decodeURIComponent(state[1]) : '';
      return {code: decodedCode, state: decodedState,
        matches: Boolean(decodedCode && decodedState === expectedState)};
    } catch (error) {
      capture(error, 'decoding the ResMed authorization response', {step: 'authorization'},
        privateValues.concat([code && code[1] || '', state && state[1] || '']));
      return null;
    }
  }

  function authenticate(credentials, callback) {
    var cached = readToken();
    if (cached) {
      callback(null, cached, true);
      return;
    }
    var loginSecrets = [credentials.username, credentials.password];
    request('POST', CONFIG.authnUrl, {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }, JSON.stringify({username: credentials.username, password: credentials.password}),
    function (networkError, authResponse) {
      if (networkError) { callback(networkError); return; }
      if (authResponse.status < 200 || authResponse.status >= 300) {
        callback(errorForResponse(authResponse, 'authentication', loginSecrets));
        return;
      }
      var auth = parseResponse(authResponse.text, 'authentication', authResponse, loginSecrets);
      if (!auth) {
        callback(publicFailure('service', 'Invalid ResMed response', {
          step: 'authentication', status: authResponse.status, elapsedMs: authResponse.elapsedMs}));
        return;
      }
      if (auth.status === 'MFA_REQUIRED') {
        callback(responseError('auth', 'ResMed MFA is not supported', {
          step: 'authentication', status: authResponse.status,
          statusText: authResponse.statusText, headers: authResponse.headers,
          elapsedMs: authResponse.elapsedMs
        }, authResponse.text, loginSecrets.concat([auth.sessionToken || ''])));
        return;
      }
      if (auth.status !== 'SUCCESS' || !auth.sessionToken) {
        callback(responseError('auth', 'ResMed sign-in failed', {
          step: 'authentication', status: authResponse.status,
          statusText: authResponse.statusText, headers: authResponse.headers,
          elapsedMs: authResponse.elapsedMs
        }, authResponse.text, loginSecrets));
        return;
      }

      var verifier = randomString(96, VERIFIER_CHARS);
      var challenge = bytesToBase64Url(sha256(verifier));
      var state = randomString(32, STATE_CHARS);
      var authorizationSecrets = loginSecrets.concat([auth.sessionToken, verifier, state]);
      var authorizeUrl = CONFIG.authorizeUrl + '?' + encodeForm({
        client_id: CONFIG.clientId,
        response_type: 'code',
        scope: 'openid profile email',
        redirect_uri: CONFIG.redirectUrl,
        state: state,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        sessionToken: auth.sessionToken,
        response_mode: 'okta_post_message'
      });
      request('GET', authorizeUrl, {Accept: 'text/html'}, undefined,
        function (authorizeError, authorizeResponse) {
        if (authorizeError) { callback(authorizeError); return; }
        if (authorizeResponse.status < 200 || authorizeResponse.status >= 300) {
          callback(errorForResponse(authorizeResponse, 'authorization', authorizationSecrets));
          return;
        }
        var authorization = parseAuthorization(authorizeResponse.text, state,
          authorizationSecrets);
        if (!authorization || !authorization.matches) {
          var responseSecrets = authorizationSecrets.concat(authorization ?
            [authorization.code, authorization.state] : []);
          callback(responseError('auth', 'ResMed authorization failed', {
            step: 'authorization', status: authorizeResponse.status,
            statusText: authorizeResponse.statusText, headers: authorizeResponse.headers,
            elapsedMs: authorizeResponse.elapsedMs
          }, authorizeResponse.text, responseSecrets));
          return;
        }
        var code = authorization.code;
        var tokenSecrets = authorizationSecrets.concat([code]);
        request('POST', CONFIG.tokenUrl, {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        }, encodeForm({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: CONFIG.redirectUrl,
          client_id: CONFIG.clientId,
          code_verifier: verifier
        }), function (tokenError, tokenResponse) {
          if (tokenError) { callback(tokenError); return; }
          if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
            callback(errorForResponse(tokenResponse, 'token exchange', tokenSecrets));
            return;
          }
          var payload = parseResponse(tokenResponse.text, 'token exchange', tokenResponse,
            tokenSecrets);
          if (!payload || !payload.access_token || !payload.id_token) {
            var returnedSecrets = tokenSecrets.concat(payload ?
              [payload.access_token || '', payload.id_token || '', payload.refresh_token || ''] : []);
            if (payload) {
              callback(responseError('service', 'Invalid ResMed token response', {
                step: 'token exchange', status: tokenResponse.status,
                statusText: tokenResponse.statusText, headers: tokenResponse.headers,
                elapsedMs: tokenResponse.elapsedMs
              }, tokenResponse.text, returnedSecrets));
            } else {
              callback(publicFailure('service', 'Invalid ResMed token response', {
                step: 'token exchange', status: tokenResponse.status,
                elapsedMs: tokenResponse.elapsedMs
              }));
            }
            return;
          }
          callback(null, saveToken(payload), false);
        }, tokenSecrets);
      }, authorizationSecrets);
    }, loginSecrets);
  }

  function fetchWithToken(token, callback) {
    var today = new Date();
    var start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
    var query = 'query GetPatientSleepRecords { getPatientWrapper { patient { firstName } ' +
      'sleepRecords(startMonth: "' + formatDate(start) + '", endMonth: "' + formatDate(today) + '") ' +
      '{ items { startDate totalUsage sleepScore ahi maskPairCount leakPercentile __typename } ' +
      '__typename } __typename } }';
    request('POST', CONFIG.graphqlUrl, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token.accessToken,
      'x-api-key': CONFIG.apiKey,
      rmdhandsetid: '02c1c662-c289-41fd-a9ae-196ff15b5166',
      rmdlanguage: 'en',
      rmdhandsetmodel: 'Chrome',
      rmdhandsetosversion: '131.0.0.0',
      rmdproduct: 'myAir',
      rmdappversion: '1.0.0',
      rmdhandsetplatform: 'Web',
      rmdcountry: 'US',
      'accept-language': 'en-US,en;q=0.9'
    }, JSON.stringify({operationName: 'GetPatientSleepRecords', variables: {}, query: query}),
    function (networkError, response) {
      if (networkError) { callback(networkError); return; }
      if (response.status < 200 || response.status >= 300) {
        callback(errorForResponse(response, 'sleep records',
          [token.accessToken, token.idToken]));
        return;
      }
      var payload = parseResponse(response.text, 'sleep records', response,
        [token.accessToken, token.idToken]);
      var items = payload && payload.data && payload.data.getPatientWrapper &&
        payload.data.getPatientWrapper.sleepRecords && payload.data.getPatientWrapper.sleepRecords.items;
      if (!payload || payload.errors || !Array.isArray(items)) {
        var fields = {step: 'sleep records', status: response.status,
          statusText: response.statusText, headers: response.headers,
          elapsedMs: response.elapsedMs, code: responseCode(payload)};
        if (payload) {
          callback(responseError('service', 'Invalid ResMed sleep data', fields,
            diagnosticResponseBody(response.text, 'sleep records'),
            [token.accessToken, token.idToken]));
        } else {
          callback(publicFailure('service', 'Invalid ResMed sleep data', fields));
        }
        return;
      }
      callback(null, items.map(function (record) {
        return {
          startDate: String(record.startDate || '').slice(0, 10),
          sleepScore: record.sleepScore,
          totalUsage: record.totalUsage,
          ahi: record.ahi,
          maskPairCount: record.maskPairCount,
          leakPercentile: record.leakPercentile
        };
      }));
    }, [token.accessToken, token.idToken]);
  }

  function fetchOnce(credentials, callback) {
    authenticate(credentials, function (authError, token, wasCached) {
      if (authError) { callback(authError); return; }
      fetchWithToken(token, function (fetchError, records) {
        if (fetchError && fetchError.type === 'auth' && wasCached) {
          clearToken();
          authenticate(credentials, function (retryAuthError, freshToken) {
            if (retryAuthError) { callback(retryAuthError); return; }
            fetchWithToken(freshToken, callback);
          });
          return;
        }
        callback(fetchError, records);
      });
    });
  }

  function fetchSleepRecords(credentials, callback) {
    fetchOnce(credentials, function (error, records) {
      if (!error || !error.transient) {
        if (error) error.attempts = 1;
        callback(error, records);
        return;
      }
      function retry() {
        try {
          fetchOnce(credentials, function (retryError, retryRecords) {
            if (retryError) { retryError.attempts = 2; retryError.previous = error; }
            callback(retryError, retryRecords);
          });
        } catch (retryError) {
          report(retryError, 'running the ResMed retry callback');
          callback(error);
        }
      }
      try {
        retryDelay(retry);
      } catch (timerError) {
        report(timerError, 'scheduling the ResMed retry');
        callback(error);
      }
    });
  }

  return {fetchSleepRecords: fetchSleepRecords, clearSession: clearToken};
}

module.exports = createClient;
module.exports.CONFIG = CONFIG;
module.exports.bytesToBase64Url = bytesToBase64Url;
