export function validateConfiguration(config) {
  if (config.devEmulator) {
    if (config.host !== '127.0.0.1') {
      throw new Error('CPAP_DEV_EMULATOR requires CPAP_BRIDGE_HOST=127.0.0.1');
    }
    if (!config.qaEnabled && (!config.username || !config.password)) {
      throw new Error('MYAIR_USERNAME and MYAIR_PASSWORD are required in emulator dev mode');
    }
    return;
  }
  if (config.setupToken.length < 16) {
    throw new Error('CPAP_BRIDGE_SETUP_TOKEN must be at least 16 characters');
  }
  if (config.secret.length < 16) {
    throw new Error('CPAP_BRIDGE_SECRET must be at least 16 characters');
  }
}

export function isAllowedDevRequest(headers) {
  return !headers.origin && headers['x-cpap-dev'] === '1';
}

export function publicResMedError(code) {
  if (code === 'authentication_failed') {
    return {code, message: 'ResMed sign-in failed'};
  }
  if (code === 'mfa_required') {
    return {code, message: 'MFA is not supported'};
  }
  return {code: 'service_error', message: 'ResMed is unavailable'};
}

export function jsonHeaders(cors) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Headers'] = 'authorization, content-type';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
  }
  return headers;
}
