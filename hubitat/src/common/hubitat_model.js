'use strict';

var MAX_DEVICES = 32;
var KIND = {unknown: 0, motion: 1, contact: 2, temperature: 3, switch: 4, lock: 5};
var CONTROL = {ON: 1, OFF: 2, LOCK: 4, UNLOCK: 8};

function text(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback || '';
  return String(value);
}

function has(values, name) {
  return values.some(function (value) { return String(value).toLowerCase() === name; });
}

function attributes(device) {
  var source = device.attributes || {};
  if (Array.isArray(source)) {
    var mapped = {};
    source.forEach(function (item) {
      if (item && item.name) mapped[item.name] = item.currentValue !== undefined ? item.currentValue : item.value;
    });
    return mapped;
  }
  return source;
}

function commands(device) {
  return (device.commands || []).map(function (item) {
    return String(item.command || item.name || item).toLowerCase();
  });
}

function classify(device) {
  var attrs = attributes(device);
  var caps = (device.capabilities || []).map(function (value) { return String(value).toLowerCase(); });
  if (attrs.motion !== undefined || has(caps, 'motionsensor')) return 'motion';
  if (attrs.contact !== undefined || has(caps, 'contactsensor')) return 'contact';
  if (attrs.lock !== undefined || has(caps, 'lock')) return 'lock';
  if (attrs.switch !== undefined || has(caps, 'switch')) return 'switch';
  if (attrs.temperature !== undefined || has(caps, 'temperaturesensor')) return 'temperature';
  return 'unknown';
}

function primaryFor(kind, attrs) {
  if (kind === 'motion') return text(attrs.motion, 'missing');
  if (kind === 'contact') return text(attrs.contact, 'missing');
  if (kind === 'lock') return text(attrs.lock, 'missing');
  if (kind === 'switch') return text(attrs.switch, 'missing');
  if (kind === 'temperature') return attrs.temperature === undefined ? 'missing' : text(attrs.temperature) + '°';
  var preferred = ['smoke', 'carbonMonoxide', 'water', 'presence', 'acceleration', 'valve', 'alarm', 'level'];
  for (var index = 0; index < preferred.length; index += 1) {
    if (attrs[preferred[index]] !== undefined) return text(attrs[preferred[index]], 'missing');
  }
  var keys = Object.keys(attrs).filter(function (key) {
    return ['battery', 'temperature', 'humidity', 'illuminance', 'power', 'energy', 'voltage', 'current'].indexOf(key) === -1;
  });
  return keys.length ? text(attrs[keys[0]], 'unknown') : 'no state';
}

function secondaryFor(kind, attrs) {
  if (kind !== 'temperature' && attrs.temperature !== undefined) return text(attrs.temperature) + '°';
  if (attrs.humidity !== undefined) return text(attrs.humidity) + '% humidity';
  if (attrs.illuminance !== undefined) return text(attrs.illuminance) + ' lux';
  return '';
}

function controlFlags(kind, device) {
  var list = commands(device);
  var flags = 0;
  if (kind === 'switch') {
    if (has(list, 'on')) flags |= CONTROL.ON;
    if (has(list, 'off')) flags |= CONTROL.OFF;
  }
  if (kind === 'lock') {
    if (has(list, 'lock')) flags |= CONTROL.LOCK;
    if (has(list, 'unlock')) flags |= CONTROL.UNLOCK;
  }
  return flags;
}

function normalizeDevice(device) {
  var attrs = attributes(device);
  var kind = classify(device);
  var battery = Number(attrs.battery);
  return {
    id: text(device.id),
    label: text(device.label || device.name, 'Unnamed').slice(0, 24),
    kind: KIND[kind],
    kindName: kind,
    primary: primaryFor(kind, attrs).slice(0, 24),
    secondary: secondaryFor(kind, attrs).slice(0, 24),
    battery: Number.isFinite(battery) && battery >= 0 && battery <= 100 ? Math.round(battery) : 255,
    controlFlags: controlFlags(kind, device)
  };
}

function normalizeDevices(devices, selectedIds) {
  var selected = (selectedIds || []).map(String);
  return (devices || []).filter(function (device) {
    return !selected.length || selected.indexOf(String(device.id)) !== -1;
  }).slice(0, MAX_DEVICES).map(normalizeDevice);
}

function actionFor(device) {
  if (device.kindName === 'switch') return device.primary.toLowerCase() === 'on' ? 'off' : 'on';
  if (device.kindName === 'lock') return device.primary.toLowerCase() === 'locked' ? 'unlock' : 'lock';
  return '';
}

module.exports = {
  MAX_DEVICES: MAX_DEVICES, KIND: KIND, CONTROL: CONTROL,
  normalizeDevice: normalizeDevice, normalizeDevices: normalizeDevices, actionFor: actionFor
};
