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

function parseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    return null;
  }
}

function errorForResponse(response, step) {
  var body = parseJson(response.text) || {};
  var auth = response.status === 401 || response.status === 403 ||
    body.errorCode === 'E0000004';
  var transient = response.status === 502 || response.status === 503 || response.status === 504;
  return {
    type: auth ? 'auth' : 'service',
    message: auth ? 'ResMed sign-in failed' : 'ResMed unavailable',
    transient: transient,
    step: step,
    status: response.status
  };
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

  function request(method, url, headers, body, callback) {
    var xhr = new Xhr();
    var finished = false;
    var timer = null;

    function finish(error, response) {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimer(timer);
      callback(error, response);
    }

    xhr.open(method, url, true);
    Object.keys(headers || {}).forEach(function (name) {
      xhr.setRequestHeader(name, headers[name]);
    });
    xhr.onload = function () {
      finish(null, {status: Number(xhr.status || 0), text: xhr.responseText || ''});
    };
    xhr.onerror = function () {
      finish({type: 'network', message: 'Phone cannot be reached', transient: true});
    };
    xhr.ontimeout = function () {
      finish({type: 'network', message: 'ResMed timed out', transient: true});
    };
    xhr.onloadend = function () {
      if (!finished && (!xhr.status || xhr.status === 0)) {
        finish({type: 'network', message: 'Phone cannot be reached', transient: true});
      }
    };
    if (requestTimeoutMs > 0) {
      xhr.timeout = requestTimeoutMs;
      timer = setTimer(function () {
        try { xhr.abort(); } catch (ignored) {}
        finish({type: 'network', message: 'ResMed timed out', transient: true});
      }, requestTimeoutMs);
    }
    xhr.send(body === undefined ? null : body);
  }

  function readToken() {
    var token;
    try { token = JSON.parse(storage.getItem(TOKEN_KEY) || 'null'); } catch (error) { return null; }
    if (!token || !token.accessToken || !token.idToken || !token.expiresAt) return null;
    return Date.now() < token.expiresAt - 300000 ? token : null;
  }

  function saveToken(payload) {
    var token = {
      accessToken: payload.access_token,
      idToken: payload.id_token,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
    };
    storage.setItem(TOKEN_KEY, JSON.stringify(token));
    return token;
  }

  function clearToken() {
    storage.removeItem(TOKEN_KEY);
  }

  function parseAuthorization(html, expectedState) {
    var code = /data\.code\s*=\s*['"]([^'"]+)['"]/i.exec(html) ||
      /["']code["']\s*:\s*["']([^"']+)["']/i.exec(html) ||
      /(?:^|[?&])code=([^&"'\s]+)/i.exec(html);
    var state = /data\.state\s*=\s*['"]([^'"]+)['"]/i.exec(html) ||
      /["']state["']\s*:\s*["']([^"']+)["']/i.exec(html) ||
      /(?:^|[?&])state=([^&"'\s]+)/i.exec(html);
    if (!code || !state || decodeURIComponent(state[1]) !== expectedState) return null;
    return decodeURIComponent(code[1]);
  }

  function authenticate(credentials, callback) {
    var cached = readToken();
    if (cached) {
      callback(null, cached, true);
      return;
    }
    request('POST', CONFIG.authnUrl, {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }, JSON.stringify({username: credentials.username, password: credentials.password}),
    function (networkError, authResponse) {
      if (networkError) { callback(networkError); return; }
      if (authResponse.status < 200 || authResponse.status >= 300) {
        callback(errorForResponse(authResponse, 'authentication'));
        return;
      }
      var auth = parseJson(authResponse.text);
      if (!auth) {
        callback({type: 'service', message: 'Invalid ResMed response'});
        return;
      }
      if (auth.status === 'MFA_REQUIRED') {
        callback({type: 'auth', message: 'ResMed MFA is not supported'});
        return;
      }
      if (auth.status !== 'SUCCESS' || !auth.sessionToken) {
        callback({type: 'auth', message: 'ResMed sign-in failed'});
        return;
      }

      var verifier = randomString(96, VERIFIER_CHARS);
      var challenge = bytesToBase64Url(sha256(verifier));
      var state = randomString(32, STATE_CHARS);
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
          callback(errorForResponse(authorizeResponse, 'authorization'));
          return;
        }
        var code = parseAuthorization(authorizeResponse.text, state);
        if (!code) {
          callback({type: 'auth', message: 'ResMed authorization failed'});
          return;
        }
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
            callback(errorForResponse(tokenResponse, 'token exchange'));
            return;
          }
          var payload = parseJson(tokenResponse.text);
          if (!payload || !payload.access_token || !payload.id_token) {
            callback({type: 'service', message: 'Invalid ResMed token response'});
            return;
          }
          callback(null, saveToken(payload), false);
        });
      });
    });
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
        callback(errorForResponse(response, 'sleep records'));
        return;
      }
      var payload = parseJson(response.text);
      var items = payload && payload.data && payload.data.getPatientWrapper &&
        payload.data.getPatientWrapper.sleepRecords && payload.data.getPatientWrapper.sleepRecords.items;
      if (!payload || payload.errors || !Array.isArray(items)) {
        callback({type: 'service', message: 'Invalid ResMed sleep data'});
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
    });
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
        callback(error, records);
        return;
      }
      retryDelay(function () { fetchOnce(credentials, callback); });
    });
  }

  return {fetchSleepRecords: fetchSleepRecords, clearSession: clearToken};
}

module.exports = createClient;
module.exports.CONFIG = CONFIG;
module.exports.bytesToBase64Url = bytesToBase64Url;
