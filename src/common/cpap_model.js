'use strict';

var DAYS = 7;
var SCORE_UNAVAILABLE = 255;
var METRIC_UNAVAILABLE = 65535;
var COUNT_UNAVAILABLE = 255;

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function isoLocalDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function packedLocalDate(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function normalizeScore(value) {
  if (value === null || value === undefined || value === '') {
    return SCORE_UNAVAILABLE;
  }
  var numeric = Number(value);
  if (!isFinite(numeric) || numeric < 0 || numeric > 100) {
    return SCORE_UNAVAILABLE;
  }
  return Math.round(numeric);
}

function normalizeMetric(value, scale) {
  if (value === null || value === undefined || value === '') {
    return METRIC_UNAVAILABLE;
  }
  var numeric = Number(value);
  var normalized = Math.round(numeric * scale);
  if (!isFinite(numeric) || numeric < 0 || normalized >= METRIC_UNAVAILABLE) {
    return METRIC_UNAVAILABLE;
  }
  return normalized;
}

function normalizeCount(value) {
  if (value === null || value === undefined || value === '') {
    return COUNT_UNAVAILABLE;
  }
  var numeric = Number(value);
  if (!isFinite(numeric) || numeric < 0 || numeric >= COUNT_UNAVAILABLE) {
    return COUNT_UNAVAILABLE;
  }
  return Math.round(numeric);
}

function normalizeRecord(record) {
  return {
    score: normalizeScore(record.sleepScore),
    usage: normalizeMetric(record.totalUsage, 1),
    ahiX10: normalizeMetric(record.ahi, 10),
    maskOff: normalizeCount(record.maskPairCount),
    leakX10: normalizeMetric(record.leakPercentile, 10)
  };
}

function emptyRecord() {
  return {
    score: SCORE_UNAVAILABLE,
    usage: METRIC_UNAVAILABLE,
    ahiX10: METRIC_UNAVAILABLE,
    maskOff: COUNT_UNAVAILABLE,
    leakX10: METRIC_UNAVAILABLE
  };
}

function sevenDaySlots(records, now) {
  var byDate = {};
  var source = records || [];
  var i;
  for (i = 0; i < source.length; i += 1) {
    if (source[i] && typeof source[i].startDate === 'string') {
      byDate[source[i].startDate.slice(0, 10)] = normalizeRecord(source[i]);
    }
  }

  var slots = [];
  for (i = 0; i < DAYS; i += 1) {
    var date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i - 1, 12, 0, 0, 0);
    var iso = isoLocalDate(date);
    var values = Object.prototype.hasOwnProperty.call(byDate, iso) ? byDate[iso] : emptyRecord();
    slots.push({date: packedLocalDate(date),
      score: values.score, usage: values.usage, ahiX10: values.ahiX10,
      maskOff: values.maskOff, leakX10: values.leakX10});
  }
  return slots;
}

function isPartial(slots) {
  for (var i = 0; i < slots.length; i += 1) {
    if (slots[i].score === SCORE_UNAVAILABLE) {
      return true;
    }
  }
  return false;
}

function responseDictionary(slots, fetchedAt, requestId, source) {
  var result = {
    PROTOCOL: 1,
    STATUS: isPartial(slots) ? 5 : 0,
    SOURCE: source || 0,
    FETCHED_AT: Math.floor(fetchedAt / 1000),
    COUNT: DAYS
  };
  if (requestId) {
    result.REQUEST_ID = requestId;
  }
  for (var i = 0; i < DAYS; i += 1) {
    result['DAY' + i + '_DATE'] = slots[i].date;
    result['DAY' + i + '_SCORE'] = slots[i].score;
    result['DAY' + i + '_USAGE'] = slots[i].usage;
    result['DAY' + i + '_AHI_X10'] = slots[i].ahiX10;
    result['DAY' + i + '_MASK_OFF'] = slots[i].maskOff;
    result['DAY' + i + '_LEAK_X10'] = slots[i].leakX10;
  }
  return result;
}

module.exports = {
  DAYS: DAYS,
  SCORE_UNAVAILABLE: SCORE_UNAVAILABLE,
  METRIC_UNAVAILABLE: METRIC_UNAVAILABLE,
  COUNT_UNAVAILABLE: COUNT_UNAVAILABLE,
  isoLocalDate: isoLocalDate,
  normalizeScore: normalizeScore,
  normalizeMetric: normalizeMetric,
  normalizeCount: normalizeCount,
  sevenDaySlots: sevenDaySlots,
  isPartial: isPartial,
  responseDictionary: responseDictionary
};
