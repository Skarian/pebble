'use strict';

// External QA produces the same packed chart contract as the Android companion.
// This file is not bundled in the production PBW.
var GRAPH_COLUMNS = 56;
var UNAVAILABLE = -2147483648;
var PACKED_UNAVAILABLE = -32768;
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

function chartColumns(points) {
  var input = points || [];
  return Array.from({length: GRAPH_COLUMNS}, function (_, index) {
    var point = input[index];
    var values = normalize(point);
    return METRICS.map(function (name) {
      return values[name] === UNAVAILABLE ? PACKED_UNAVAILABLE : values[name];
    });
  });
}

function average(columns, metric) {
  var values = columns.map(function (column) { return column[metric]; })
    .filter(function (value) { return value !== PACKED_UNAVAILABLE; });
  if (!values.length) return UNAVAILABLE;
  return Math.round(values.reduce(function (total, value) { return total + value; }, 0) / values.length);
}

function packSeries(columns, metric) {
  var bytes = [];
  columns.forEach(function (column) {
    var value = column[metric];
    var packed = value >= -32767 && value <= 32767 ? value : PACKED_UNAVAILABLE;
    bytes.push(packed & 255, (packed >> 8) & 255);
  });
  return bytes;
}

function isPartial(current, columns) {
  var values = normalize(current);
  if (METRICS.some(function (name) { return values[name] === UNAVAILABLE; })) return true;
  return METRICS.some(function (_, metric) { return average(columns, metric) === UNAVAILABLE; });
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
  var columns = chartColumns(snapshot.points);
  var windows = [3600, 86400, 604800];
  var result = {
    PROTOCOL: 2,
    STATUS: isPartial(snapshot.current, columns) ? 8 : 0,
    OBSERVED_AT: Math.floor(observedAt / 1000),
    FLAGS: snapshot.stale ? 1 : 0,
    LOCATION: String(snapshot.location || 'ARANET4').slice(0, 31),
    CO2_STATE: co2State(snapshot.current && snapshot.current.co2,
      snapshot.current && snapshot.current.co2State),
    BATTERY: integer(snapshot.current && snapshot.current.battery, 0, 100),
    CO2: current.co2,
    TEMP_X10: current.temperature,
    HUMIDITY_X10: current.humidity,
    PRESSURE_X10: current.pressure,
    SCALE: scale,
    POINT_COUNT: GRAPH_COLUMNS,
    WINDOW_START: Math.floor(observedAt / 1000) - windows[scale],
    SERIES_CO2: packSeries(columns, 0),
    SERIES_TEMP_X10: packSeries(columns, 1),
    SERIES_HUMIDITY_X10: packSeries(columns, 2),
    SERIES_PRESSURE_X10: packSeries(columns, 3),
    AVG_CO2: average(columns, 0),
    AVG_TEMP_X10: average(columns, 1),
    AVG_HUMIDITY_X10: average(columns, 2),
    AVG_PRESSURE_X10: average(columns, 3)
  };
  if (requestId) result.REQUEST_ID = requestId;
  return result;
}

module.exports = {GRAPH_COLUMNS: GRAPH_COLUMNS,
  UNAVAILABLE: UNAVAILABLE, PACKED_UNAVAILABLE: PACKED_UNAVAILABLE, METRICS: METRICS,
  normalize: normalize, chartColumns: chartColumns, packSeries: packSeries,
  isPartial: isPartial, co2State: co2State, dictionary: dictionary};
