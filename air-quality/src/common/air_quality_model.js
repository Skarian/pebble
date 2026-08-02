'use strict';

var DAYS = 7;
var UNAVAILABLE = 65535;
var METRICS = ['aqi', 'pm25', 'co2', 'temperature', 'humidity'];

function finite(value) {
  return value !== null && value !== undefined && value !== '' && isFinite(Number(value));
}

function scaled(value, scale, maximum) {
  if (!finite(value) || Number(value) < 0 || Number(value) > maximum) return UNAVAILABLE;
  return Math.round(Number(value) * scale);
}

function packedDate(value) {
  var match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? Number(match[1] + match[2] + match[3]) : 0;
}

function localDate(daysAgo, now) {
  var value = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12);
  function pad(number) { return number < 10 ? '0' + number : String(number); }
  return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
}

function normalize(reading) {
  reading = reading || {};
  return {
    aqi: scaled(reading.aqi, 1, 500),
    pm25: scaled(reading.pm25, 10, 1000),
    co2: scaled(reading.co2, 1, 10000),
    temperature: finite(reading.temperature) && Number(reading.temperature) >= -100 && Number(reading.temperature) <= 100 ? Math.round(Number(reading.temperature) * 10) : UNAVAILABLE,
    humidity: scaled(reading.humidity, 10, 100)
  };
}

function sevenDays(daily, now) {
  var byDate = {};
  (daily || []).forEach(function (row) { if (row && row.date) byDate[String(row.date).slice(0, 10)] = normalize(row); });
  var result = [];
  for (var i = 0; i < DAYS; i += 1) {
    var iso = localDate(i, now);
    result.push({date: packedDate(iso), values: byDate[iso] || normalize({})});
  }
  return result;
}

function isPartial(current, days) {
  var values = normalize(current);
  if (METRICS.some(function (name) { return values[name] === UNAVAILABLE; })) return true;
  return days.some(function (day) { return METRICS.some(function (name) { return day.values[name] === UNAVAILABLE; }); });
}

function dictionary(snapshot, fetchedAt, requestId) {
  var current = normalize(snapshot.current);
  var days = sevenDays(snapshot.daily, new Date(fetchedAt));
  var result = {
    PROTOCOL: 1, STATUS: isPartial(snapshot.current, days) ? 8 : 0,
    FETCHED_AT: Math.floor(fetchedAt / 1000), FLAGS: snapshot.stale ? 1 : 0,
    LOCATION: String(snapshot.location || 'AIR SENSOR').slice(0, 31),
    AQI: current.aqi, PM25_X10: current.pm25, CO2: current.co2,
    TEMP_X10: current.temperature, HUMIDITY_X10: current.humidity
  };
  if (requestId) result.REQUEST_ID = requestId;
  var suffixes = {aqi: 'AQI', pm25: 'PM25_X10', co2: 'CO2', temperature: 'TEMP_X10', humidity: 'HUMIDITY_X10'};
  days.forEach(function (day, index) {
    result['DAY' + index + '_DATE'] = day.date;
    METRICS.forEach(function (name) { result['DAY' + index + '_' + suffixes[name]] = day.values[name]; });
  });
  return result;
}

module.exports = {DAYS: DAYS, UNAVAILABLE: UNAVAILABLE, METRICS: METRICS,
  normalize: normalize, sevenDays: sevenDays, isPartial: isPartial, dictionary: dictionary};
