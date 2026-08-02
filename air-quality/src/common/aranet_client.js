'use strict';

var BASE_URL = 'https://aranet.cloud/api/v1';
var UNAVAILABLE = null;

function metricName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalMetric(reading, metricNames) {
  var name = metricName(metricNames && metricNames[String(reading.metric)] || reading.metric);
  var unit = metricName(reading.unit);
  if (name.indexOf('pm25') >= 0 || name.indexOf('pm2') >= 0) return 'pm25';
  if (name.indexOf('co2') >= 0 || unit === 'ppm' && name.indexOf('carbon') >= 0) return 'co2';
  if (name.indexOf('humidity') >= 0 || name === 'rh') return 'humidity';
  if (name.indexOf('temperature') >= 0 || name === 'temp') return 'temperature';
  return null;
}

function pm25Aqi(value) {
  if (value === null || value === undefined || !isFinite(Number(value))) return UNAVAILABLE;
  var concentration = Math.floor(Number(value) * 10) / 10;
  var ranges = [[0, 9, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
    [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]];
  for (var i = 0; i < ranges.length; i += 1) {
    var r = ranges[i];
    if (concentration <= r[1]) return Math.round((r[3] - r[2]) / (r[1] - r[0]) * (concentration - r[0]) + r[2]);
  }
  return 500;
}

function localDate(time) {
  var date = new Date(time);
  function pad(value) { return value < 10 ? '0' + value : String(value); }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function metricNamesFromLinks(links) {
  var names = {};
  Object.keys(links || {}).forEach(function (key) {
    var values = Array.isArray(links[key]) ? links[key] : [links[key]];
    values.forEach(function (link) {
      if (!link) return;
      var href = String(link.href || '');
      var match = href.match(/\/metrics\/([^/?#]+)$/);
      if (match && link.name) names[decodeURIComponent(match[1])] = link.name;
      if (link.id && link.name) names[String(link.id)] = link.name;
    });
  });
  return names;
}

function normalizeHistory(readings, location, links) {
  var metricNames = metricNamesFromLinks(links);
  var sorted = (readings || []).slice().sort(function (a, b) { return new Date(a.time) - new Date(b.time); });
  var current = {};
  var daily = {};
  var observedAt = null;
  sorted.forEach(function (reading) {
    var metric = canonicalMetric(reading, metricNames);
    var numeric = Number(reading.value);
    if (!metric || !isFinite(numeric) || !reading.time) return;
    current[metric] = numeric;
    observedAt = reading.time;
    var date = localDate(reading.time);
    if (!daily[date]) daily[date] = {date: date, sums: {}, counts: {}};
    daily[date].sums[metric] = (daily[date].sums[metric] || 0) + numeric;
    daily[date].counts[metric] = (daily[date].counts[metric] || 0) + 1;
  });
  var rows = Object.keys(daily).sort().map(function (date) {
    var row = {date: date};
    Object.keys(daily[date].sums).forEach(function (metric) {
      row[metric] = daily[date].sums[metric] / daily[date].counts[metric];
    });
    row.aqi = pm25Aqi(row.pm25);
    return row;
  });
  current.aqi = pm25Aqi(current.pm25);
  return {location: location, observedAt: observedAt, current: current, daily: rows};
}

function Client(XMLHttpRequestImpl) {
  function fetchSnapshot(settings, callback) {
    if (!settings.apiCredential || !settings.sharingId || !settings.location) {
      callback({type: 'unconfigured', message: 'Complete Aranet settings'}); return;
    }
    var path = '/measurements/history?sensor=' + encodeURIComponent(settings.sharingId) +
      '&days=7&limit=10000';
    var xhr = new XMLHttpRequestImpl();
    xhr.open('GET', BASE_URL + path, true);
    xhr.timeout = 12000;
    xhr.setRequestHeader('ApiKey', settings.apiCredential);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var body;
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch (error) {
        callback({type: 'service', message: 'Invalid Aranet response', step: 'parse'}); return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        callback(null, normalizeHistory(body.readings || [], settings.location, body.links || {}));
      } else if (xhr.status === 401 || xhr.status === 403) callback({type: 'auth', message: 'Aranet API access denied', status: xhr.status});
      else if (xhr.status === 429) callback({type: 'rate', message: 'Aranet refresh limit reached', status: 429});
      else callback({type: 'service', message: 'Aranet Cloud unavailable', status: xhr.status});
    };
    xhr.ontimeout = function () { callback({type: 'timeout', message: 'Aranet request timed out'}); };
    xhr.onerror = function () { callback({type: 'network', message: 'Phone network unavailable'}); };
    xhr.send();
  }
  return {fetchSnapshot: fetchSnapshot};
}

Client.normalizeHistory = normalizeHistory;
Client.pm25Aqi = pm25Aqi;
Client.canonicalMetric = canonicalMetric;
Client.metricNamesFromLinks = metricNamesFromLinks;
module.exports = Client;
