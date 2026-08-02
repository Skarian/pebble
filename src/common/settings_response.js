'use strict';

function decodeSettingsResponse(response) {
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
      return null;
    }
  }
}

module.exports = decodeSettingsResponse;
