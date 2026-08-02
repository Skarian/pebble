import {createHash, randomBytes} from 'node:crypto';

const CONFIG = {
  authServerId: 'aus4ccsxvnidQgLmA297',
  authorizeClientId: '0oa4ccq1v413ypROi297',
  myAirApiKey: 'da2-cenztfjrezhwphdqtwtbpqvzui',
  authnUrl: 'https://resmed-ext-1.okta.com/api/v1/authn',
  authorizeUrl: 'https://resmed-ext-1.okta.com/oauth2/aus4ccsxvnidQgLmA297/v1/authorize',
  tokenUrl: 'https://resmed-ext-1.okta.com/oauth2/aus4ccsxvnidQgLmA297/v1/token',
  graphqlUrl: 'https://graphql.myair-prd.dht.live/graphql',
  redirectUrl: 'https://myair.resmed.com'
};

export class ResMedError extends Error {
  constructor(code, message, status = 502, upstreamStatus = null) {
    super(message);
    this.name = 'ResMedError';
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

export function isRetryableStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

export function isTransientResMedError(error) {
  if (error instanceof ResMedError) {
    return isRetryableStatus(error.upstreamStatus);
  }
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' ||
    (error instanceof TypeError && Boolean(error.cause));
}

export async function retryTransient(operation, wait = () => new Promise((resolve) => {
  setTimeout(resolve, 1000);
})) {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientResMedError(error)) throw error;
    await wait();
    return operation();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
}

function updateCookies(response, jar) {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const header of headers) {
    const first = header.split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator > 0) {
      const name = first.slice(0, separator).trim();
      if (name === 'DT' || name === 'sid') {
        jar[name] = first.slice(separator + 1).trim();
      }
    }
  }
}

async function fetchWithTimeout(url, options = {}) {
  const signal = AbortSignal.timeout(12000);
  const response = await fetch(url, {...options, signal});
  if (isRetryableStatus(response.status)) {
    throw new ResMedError('service_error', 'ResMed is temporarily unavailable',
      502, response.status);
  }
  return response;
}

async function responseJson(response, step) {
  let value;
  try {
    value = await response.json();
  } catch {
    throw new ResMedError('invalid_response', `Invalid response during ${step}`,
      502, response.status);
  }
  if (!response.ok || value.error || value.errors) {
    const message = value.errorSummary || value.error_description || value.error ||
      value.errors?.[0]?.message || `ResMed request failed during ${step}`;
    const status = response.status === 401 || response.status === 403 ? 401 : 502;
    throw new ResMedError(status === 401 ? 'authentication_failed' : 'service_error',
      message, status, response.status);
  }
  return value;
}

function pkcePair() {
  const verifier = randomBytes(40).toString('base64url').replace(/[^a-zA-Z0-9]+/g, '');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return {verifier, challenge};
}

function decodeJwtPayload(token) {
  const pieces = String(token || '').split('.');
  if (pieces.length < 2) {
    throw new ResMedError('invalid_token', 'ResMed returned an invalid identity token');
  }
  return JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
}

export async function authenticate({username, password, deviceToken}) {
  const jar = {};
  if (deviceToken) {
    jar.DT = deviceToken;
  }

  if (!jar.DT) {
    const initial = await fetchWithTimeout(CONFIG.authorizeUrl, {
      headers: {Accept: 'application/json'},
      redirect: 'manual'
    });
    updateCookies(initial, jar);
  }

  const authResponse = await fetchWithTimeout(CONFIG.authnUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(cookieHeader(jar) ? {Cookie: cookieHeader(jar)} : {})
    },
    body: JSON.stringify({username, password})
  });
  updateCookies(authResponse, jar);
  const auth = await responseJson(authResponse, 'authentication');
  if (auth.status === 'MFA_REQUIRED') {
    throw new ResMedError('mfa_required', 'This USA account requires MFA, which this build does not support', 401);
  }
  if (auth.status !== 'SUCCESS' || !auth.sessionToken) {
    throw new ResMedError('authentication_failed', 'Invalid ResMed username or password', 401);
  }

  const pkce = pkcePair();
  const authorize = new URL(CONFIG.authorizeUrl);
  authorize.search = new URLSearchParams({
    client_id: CONFIG.authorizeClientId,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    prompt: 'none',
    redirect_uri: CONFIG.redirectUrl,
    response_mode: 'fragment',
    response_type: 'code',
    sessionToken: auth.sessionToken,
    scope: 'openid profile email',
    state: 'cpap-pebble'
  }).toString();

  const codeResponse = await fetchWithTimeout(authorize, {
    headers: {Accept: 'application/json', ...(cookieHeader(jar) ? {Cookie: cookieHeader(jar)} : {})},
    redirect: 'manual'
  });
  updateCookies(codeResponse, jar);
  const location = codeResponse.headers.get('location');
  if (!location) {
    throw new ResMedError('oauth_failed', 'ResMed did not return an authorization redirect');
  }
  const code = new URLSearchParams(new URL(location).hash.slice(1)).get('code');
  if (!code) {
    throw new ResMedError('oauth_failed', 'ResMed authorization code was missing');
  }

  const tokenResponse = await fetchWithTimeout(CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookieHeader(jar) ? {Cookie: cookieHeader(jar)} : {})
    },
    body: new URLSearchParams({
      client_id: CONFIG.authorizeClientId,
      redirect_uri: CONFIG.redirectUrl,
      grant_type: 'authorization_code',
      code_verifier: pkce.verifier,
      code
    })
  });
  const tokens = await responseJson(tokenResponse, 'token exchange');
  if (!tokens.access_token || !tokens.id_token) {
    throw new ResMedError('oauth_failed', 'ResMed token response was incomplete');
  }
  const identity = decodeJwtPayload(tokens.id_token);
  if (!identity.myAirCountryId) {
    throw new ResMedError('invalid_token', 'ResMed country claim was missing');
  }
  return {
    accessToken: tokens.access_token,
    country: identity.myAirCountryId,
    deviceToken: jar.DT || null
  };
}

function isoDateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function fetchSleepRecordsOnce(credentials) {
  const auth = await authenticate(credentials);
  const query = `query GetPatientSleepRecords {
    getPatientWrapper {
      sleepRecords(startMonth: "${isoDateOffset(-30)}", endMonth: "${isoDateOffset(0)}") {
        items { startDate sleepScore totalUsage ahi maskPairCount leakPercentile }
      }
    }
  }`;
  const response = await fetchWithTimeout(CONFIG.graphqlUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
      'x-api-key': CONFIG.myAirApiKey,
      rmdhandsetid: '02c1c662-c289-41fd-a9ae-196ff15b5166',
      rmdlanguage: 'en',
      rmdhandsetmodel: 'Chrome',
      rmdhandsetosversion: '127.0.6533.119',
      rmdproduct: 'myAir',
      rmdappversion: '1.0.0',
      rmdhandsetplatform: 'Web',
      rmdcountry: auth.country,
      'accept-language': 'en-US,en;q=0.9'
    },
    body: JSON.stringify({operationName: 'GetPatientSleepRecords', variables: {}, query})
  });
  const payload = await responseJson(response, 'sleep records');
  const records = payload?.data?.getPatientWrapper?.sleepRecords?.items;
  if (!Array.isArray(records)) {
    throw new ResMedError('invalid_response', 'ResMed sleep records were missing');
  }
  return {
    records: records.map((record) => ({
      startDate: String(record.startDate || '').slice(0, 10),
      sleepScore: record.sleepScore,
      totalUsage: record.totalUsage,
      ahi: record.ahi,
      maskPairCount: record.maskPairCount,
      leakPercentile: record.leakPercentile
    })),
    deviceToken: auth.deviceToken
  };
}

export function fetchSleepRecords(credentials) {
  return retryTransient(() => fetchSleepRecordsOnce(credentials));
}
