'use strict';

var ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256(message) {
  var bytes = [];
  var i;
  for (i = 0; i < message.length; i++) {
    bytes.push(message.charCodeAt(i) & 255);
  }
  var bitLength = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (i = 7; i >= 0; i--) {
    bytes.push(Math.floor(bitLength / Math.pow(256, i)) & 255);
  }

  var state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  for (var offset = 0; offset < bytes.length; offset += 64) {
    var schedule = [];
    for (i = 0; i < 16; i++) {
      var p = offset + i * 4;
      schedule[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) |
        (bytes[p + 2] << 8) | bytes[p + 3];
    }
    for (i = 16; i < 64; i++) {
      var x = schedule[i - 15];
      var y = schedule[i - 2];
      var small0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      var small1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      schedule[i] = (schedule[i - 16] + small0 + schedule[i - 7] + small1) | 0;
    }

    var work = state.slice(0);
    for (i = 0; i < 64; i++) {
      var big1 = rotate(work[4], 6) ^ rotate(work[4], 11) ^ rotate(work[4], 25);
      var choose = (work[4] & work[5]) ^ (~work[4] & work[6]);
      var first = (work[7] + big1 + choose + ROUND[i] + schedule[i]) | 0;
      var big0 = rotate(work[0], 2) ^ rotate(work[0], 13) ^ rotate(work[0], 22);
      var majority = (work[0] & work[1]) ^ (work[0] & work[2]) ^ (work[1] & work[2]);
      var second = (big0 + majority) | 0;
      work = [
        (first + second) | 0, work[0], work[1], work[2],
        (work[3] + first) | 0, work[4], work[5], work[6]
      ];
    }
    for (i = 0; i < 8; i++) state[i] = (state[i] + work[i]) | 0;
  }

  var digest = [];
  for (i = 0; i < state.length; i++) {
    digest.push((state[i] >>> 24) & 255, (state[i] >>> 16) & 255,
      (state[i] >>> 8) & 255, state[i] & 255);
  }
  return digest;
}

module.exports = sha256;
