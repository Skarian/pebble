'use strict';

function decodeSettingsResponse(response, reportError) {
  if (!response) return null;
  if (typeof response === 'object') return response;

  var raw = String(response);
  try {
    return JSON.parse(raw);
  } catch (rawError) {
    var hash = raw.indexOf('#');
    var encoded = hash >= 0 ? raw.slice(hash + 1) : raw;
    try {
      return JSON.parse(decodeURIComponent(encoded));
    } catch (encodedError) {
      encodedError.name = 'SettingsResponseError';
      encodedError.length = raw.length;
      encodedError.rawCause = rawError;
      try {
        if (typeof reportError === 'function')
          reportError(encodedError, 'decoding the CPAP settings response');
      } catch (ignored) {}
      return null;
    }
  }
}

module.exports = decodeSettingsResponse;
