'use strict';

// External QA uses this model to produce the same typed AppMessage contract as
// the Android companion. It is not bundled in the production PBW.
var DAYS = 7;
var UNAVAILABLE = -2147483648;
var METRICS = ['co2', 'temperature', 'humidity', 'pressure'];

function finite(value) {
  return value !== null && value !== undefined && value !== '' && isFinite(Number(value));
}

function integer(value, minimum, maximum) {
  if (!finite(value) || Number(value) < minimum || Number(value) > maximum) return UNAVAILABLE;
  return Math.round(Number(value));
}

function scaled(value, scale, minimum, maximum) {
  if (!finite(value) || Number(value) < minimum || Number(value) > maximum) return UNAVAILABLE;
  return Math.round(Number(value) * scale);
}

function normalize(reading) {
  reading = reading || {};
  return {
    co2: integer(reading.co2, 0, 9999),
    temperature: scaled(reading.temperature, 10, -100, 100),
    humidity: scaled(reading.humidity, 10, 0, 100),
    pressure: scaled(reading.pressure, 10, 300, 1200)
  };
}

function sevenBuckets(points, now, scale) {
  var widths = [600000, 14400000, 86400000];
  var width = widths[scale] || widths[0];
  var start = Math.floor(now.getTime() / width) * width;
  if (scale === 2) start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var result = [];
  for (var i = 0; i < DAYS; i += 1) {
    result.push({time: Math.floor((start - i * width) / 1000),
      values: normalize((points || [])[i])});
  }
  return result;
}

function isPartial(current, days) {
  var values = normalize(current);
  if (METRICS.some(function (name) { return values[name] === UNAVAILABLE; })) return true;
  return days.some(function (day) {
    return METRICS.some(function (name) { return day.values[name] === UNAVAILABLE; });
  });
}

function co2State(value, supplied) {
  if (finite(supplied) && Number(supplied) >= 0 && Number(supplied) <= 3) return Number(supplied);
  if (!finite(value)) return 0;
  return Number(value) < 1000 ? 1 : Number(value) <= 1400 ? 2 : 3;
}

function dictionary(snapshot, observedAt, requestId, requestedScale) {
  snapshot = snapshot || {};
  var scale = finite(requestedScale) ? Number(requestedScale) : Number(snapshot.scale || 0);
  if (scale < 0 || scale > 2) scale = 0;
  var current = normalize(snapshot.current);
  var days = sevenBuckets(snapshot.points, new Date(observedAt), scale);
  var result = {
    PROTOCOL: 1,
    STATUS: isPartial(snapshot.current, days) ? 8 : 0,
    OBSERVED_AT: Math.floor(observedAt / 1000),
    FLAGS: snapshot.stale ? 1 : 0,
    LOCATION: String(snapshot.location || 'ARANET4').slice(0, 31),
    CO2_STATE: co2State(snapshot.current && snapshot.current.co2,
      snapshot.current && snapshot.current.co2State),
    BATTERY: integer(snapshot.current && snapshot.current.battery, 0, 100),
    CO2: current.co2,
    TEMP_X10: current.temperature,
    HUMIDITY_X10: current.humidity,
    PRESSURE_X10: current.pressure
  };
  result.SCALE = scale;
  if (requestId) result.REQUEST_ID = requestId;
  var suffixes = {co2: 'CO2', temperature: 'TEMP_X10', humidity: 'HUMIDITY_X10', pressure: 'PRESSURE_X10'};
  days.forEach(function (day, index) {
    result['DAY' + index + '_DATE'] = day.time;
    METRICS.forEach(function (name) {
      result['DAY' + index + '_' + suffixes[name]] = day.values[name];
    });
  });
  return result;
}

module.exports = {DAYS: DAYS, UNAVAILABLE: UNAVAILABLE, METRICS: METRICS,
  normalize: normalize, sevenBuckets: sevenBuckets, isPartial: isPartial,
  co2State: co2State, dictionary: dictionary};
