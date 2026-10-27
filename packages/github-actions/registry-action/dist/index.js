// nimbus-action-dist bun=1.4.3 inputHash=sha256:7b4900f46de914b5d90b5329e7920e423ef519a91466d7e81cb526dd48210bab
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../../../node_modules/.bun/tweetnacl@1.0.3/node_modules/tweetnacl/nacl-fast.js
var require_nacl_fast = __commonJS(function(exports, module) {
  (function(nacl) {
    var gf = function(init) {
      var i, r = new Float64Array(16);
      if (init)
        for (i = 0;i < init.length; i++)
          r[i] = init[i];
      return r;
    };
    var randombytes = function() {
      throw new Error("no PRNG");
    };
    var _0 = new Uint8Array(16);
    var _9 = new Uint8Array(32);
    _9[0] = 9;
    var gf0 = gf(), gf1 = gf([1]), _121665 = gf([56129, 1]), D = gf([30883, 4953, 19914, 30187, 55467, 16705, 2637, 112, 59544, 30585, 16505, 36039, 65139, 11119, 27886, 20995]), D2 = gf([61785, 9906, 39828, 60374, 45398, 33411, 5274, 224, 53552, 61171, 33010, 6542, 64743, 22239, 55772, 9222]), X = gf([54554, 36645, 11616, 51542, 42930, 38181, 51040, 26924, 56412, 64982, 57905, 49316, 21502, 52590, 14035, 8553]), Y = gf([26200, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214]), I = gf([41136, 18958, 6951, 50414, 58488, 44335, 6150, 12099, 55207, 15867, 153, 11085, 57099, 20417, 9344, 11139]);
    function ts64(x, i, h, l) {
      x[i] = h >> 24 & 255;
      x[i + 1] = h >> 16 & 255;
      x[i + 2] = h >> 8 & 255;
      x[i + 3] = h & 255;
      x[i + 4] = l >> 24 & 255;
      x[i + 5] = l >> 16 & 255;
      x[i + 6] = l >> 8 & 255;
      x[i + 7] = l & 255;
    }
    function vn(x, xi, y, yi, n) {
      var i, d = 0;
      for (i = 0;i < n; i++)
        d |= x[xi + i] ^ y[yi + i];
      return (1 & d - 1 >>> 8) - 1;
    }
    function crypto_verify_16(x, xi, y, yi) {
      return vn(x, xi, y, yi, 16);
    }
    function crypto_verify_32(x, xi, y, yi) {
      return vn(x, xi, y, yi, 32);
    }
    function core_salsa20(o, p, k, c) {
      var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
      var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
      for (var i = 0;i < 20; i += 2) {
        u = x0 + x12 | 0;
        x4 ^= u << 7 | u >>> 32 - 7;
        u = x4 + x0 | 0;
        x8 ^= u << 9 | u >>> 32 - 9;
        u = x8 + x4 | 0;
        x12 ^= u << 13 | u >>> 32 - 13;
        u = x12 + x8 | 0;
        x0 ^= u << 18 | u >>> 32 - 18;
        u = x5 + x1 | 0;
        x9 ^= u << 7 | u >>> 32 - 7;
        u = x9 + x5 | 0;
        x13 ^= u << 9 | u >>> 32 - 9;
        u = x13 + x9 | 0;
        x1 ^= u << 13 | u >>> 32 - 13;
        u = x1 + x13 | 0;
        x5 ^= u << 18 | u >>> 32 - 18;
        u = x10 + x6 | 0;
        x14 ^= u << 7 | u >>> 32 - 7;
        u = x14 + x10 | 0;
        x2 ^= u << 9 | u >>> 32 - 9;
        u = x2 + x14 | 0;
        x6 ^= u << 13 | u >>> 32 - 13;
        u = x6 + x2 | 0;
        x10 ^= u << 18 | u >>> 32 - 18;
        u = x15 + x11 | 0;
        x3 ^= u << 7 | u >>> 32 - 7;
        u = x3 + x15 | 0;
        x7 ^= u << 9 | u >>> 32 - 9;
        u = x7 + x3 | 0;
        x11 ^= u << 13 | u >>> 32 - 13;
        u = x11 + x7 | 0;
        x15 ^= u << 18 | u >>> 32 - 18;
        u = x0 + x3 | 0;
        x1 ^= u << 7 | u >>> 32 - 7;
        u = x1 + x0 | 0;
        x2 ^= u << 9 | u >>> 32 - 9;
        u = x2 + x1 | 0;
        x3 ^= u << 13 | u >>> 32 - 13;
        u = x3 + x2 | 0;
        x0 ^= u << 18 | u >>> 32 - 18;
        u = x5 + x4 | 0;
        x6 ^= u << 7 | u >>> 32 - 7;
        u = x6 + x5 | 0;
        x7 ^= u << 9 | u >>> 32 - 9;
        u = x7 + x6 | 0;
        x4 ^= u << 13 | u >>> 32 - 13;
        u = x4 + x7 | 0;
        x5 ^= u << 18 | u >>> 32 - 18;
        u = x10 + x9 | 0;
        x11 ^= u << 7 | u >>> 32 - 7;
        u = x11 + x10 | 0;
        x8 ^= u << 9 | u >>> 32 - 9;
        u = x8 + x11 | 0;
        x9 ^= u << 13 | u >>> 32 - 13;
        u = x9 + x8 | 0;
        x10 ^= u << 18 | u >>> 32 - 18;
        u = x15 + x14 | 0;
        x12 ^= u << 7 | u >>> 32 - 7;
        u = x12 + x15 | 0;
        x13 ^= u << 9 | u >>> 32 - 9;
        u = x13 + x12 | 0;
        x14 ^= u << 13 | u >>> 32 - 13;
        u = x14 + x13 | 0;
        x15 ^= u << 18 | u >>> 32 - 18;
      }
      x0 = x0 + j0 | 0;
      x1 = x1 + j1 | 0;
      x2 = x2 + j2 | 0;
      x3 = x3 + j3 | 0;
      x4 = x4 + j4 | 0;
      x5 = x5 + j5 | 0;
      x6 = x6 + j6 | 0;
      x7 = x7 + j7 | 0;
      x8 = x8 + j8 | 0;
      x9 = x9 + j9 | 0;
      x10 = x10 + j10 | 0;
      x11 = x11 + j11 | 0;
      x12 = x12 + j12 | 0;
      x13 = x13 + j13 | 0;
      x14 = x14 + j14 | 0;
      x15 = x15 + j15 | 0;
      o[0] = x0 >>> 0 & 255;
      o[1] = x0 >>> 8 & 255;
      o[2] = x0 >>> 16 & 255;
      o[3] = x0 >>> 24 & 255;
      o[4] = x1 >>> 0 & 255;
      o[5] = x1 >>> 8 & 255;
      o[6] = x1 >>> 16 & 255;
      o[7] = x1 >>> 24 & 255;
      o[8] = x2 >>> 0 & 255;
      o[9] = x2 >>> 8 & 255;
      o[10] = x2 >>> 16 & 255;
      o[11] = x2 >>> 24 & 255;
      o[12] = x3 >>> 0 & 255;
      o[13] = x3 >>> 8 & 255;
      o[14] = x3 >>> 16 & 255;
      o[15] = x3 >>> 24 & 255;
      o[16] = x4 >>> 0 & 255;
      o[17] = x4 >>> 8 & 255;
      o[18] = x4 >>> 16 & 255;
      o[19] = x4 >>> 24 & 255;
      o[20] = x5 >>> 0 & 255;
      o[21] = x5 >>> 8 & 255;
      o[22] = x5 >>> 16 & 255;
      o[23] = x5 >>> 24 & 255;
      o[24] = x6 >>> 0 & 255;
      o[25] = x6 >>> 8 & 255;
      o[26] = x6 >>> 16 & 255;
      o[27] = x6 >>> 24 & 255;
      o[28] = x7 >>> 0 & 255;
      o[29] = x7 >>> 8 & 255;
      o[30] = x7 >>> 16 & 255;
      o[31] = x7 >>> 24 & 255;
      o[32] = x8 >>> 0 & 255;
      o[33] = x8 >>> 8 & 255;
      o[34] = x8 >>> 16 & 255;
      o[35] = x8 >>> 24 & 255;
      o[36] = x9 >>> 0 & 255;
      o[37] = x9 >>> 8 & 255;
      o[38] = x9 >>> 16 & 255;
      o[39] = x9 >>> 24 & 255;
      o[40] = x10 >>> 0 & 255;
      o[41] = x10 >>> 8 & 255;
      o[42] = x10 >>> 16 & 255;
      o[43] = x10 >>> 24 & 255;
      o[44] = x11 >>> 0 & 255;
      o[45] = x11 >>> 8 & 255;
      o[46] = x11 >>> 16 & 255;
      o[47] = x11 >>> 24 & 255;
      o[48] = x12 >>> 0 & 255;
      o[49] = x12 >>> 8 & 255;
      o[50] = x12 >>> 16 & 255;
      o[51] = x12 >>> 24 & 255;
      o[52] = x13 >>> 0 & 255;
      o[53] = x13 >>> 8 & 255;
      o[54] = x13 >>> 16 & 255;
      o[55] = x13 >>> 24 & 255;
      o[56] = x14 >>> 0 & 255;
      o[57] = x14 >>> 8 & 255;
      o[58] = x14 >>> 16 & 255;
      o[59] = x14 >>> 24 & 255;
      o[60] = x15 >>> 0 & 255;
      o[61] = x15 >>> 8 & 255;
      o[62] = x15 >>> 16 & 255;
      o[63] = x15 >>> 24 & 255;
    }
    function core_hsalsa20(o, p, k, c) {
      var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
      var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
      for (var i = 0;i < 20; i += 2) {
        u = x0 + x12 | 0;
        x4 ^= u << 7 | u >>> 32 - 7;
        u = x4 + x0 | 0;
        x8 ^= u << 9 | u >>> 32 - 9;
        u = x8 + x4 | 0;
        x12 ^= u << 13 | u >>> 32 - 13;
        u = x12 + x8 | 0;
        x0 ^= u << 18 | u >>> 32 - 18;
        u = x5 + x1 | 0;
        x9 ^= u << 7 | u >>> 32 - 7;
        u = x9 + x5 | 0;
        x13 ^= u << 9 | u >>> 32 - 9;
        u = x13 + x9 | 0;
        x1 ^= u << 13 | u >>> 32 - 13;
        u = x1 + x13 | 0;
        x5 ^= u << 18 | u >>> 32 - 18;
        u = x10 + x6 | 0;
        x14 ^= u << 7 | u >>> 32 - 7;
        u = x14 + x10 | 0;
        x2 ^= u << 9 | u >>> 32 - 9;
        u = x2 + x14 | 0;
        x6 ^= u << 13 | u >>> 32 - 13;
        u = x6 + x2 | 0;
        x10 ^= u << 18 | u >>> 32 - 18;
        u = x15 + x11 | 0;
        x3 ^= u << 7 | u >>> 32 - 7;
        u = x3 + x15 | 0;
        x7 ^= u << 9 | u >>> 32 - 9;
        u = x7 + x3 | 0;
        x11 ^= u << 13 | u >>> 32 - 13;
        u = x11 + x7 | 0;
        x15 ^= u << 18 | u >>> 32 - 18;
        u = x0 + x3 | 0;
        x1 ^= u << 7 | u >>> 32 - 7;
        u = x1 + x0 | 0;
        x2 ^= u << 9 | u >>> 32 - 9;
        u = x2 + x1 | 0;
        x3 ^= u << 13 | u >>> 32 - 13;
        u = x3 + x2 | 0;
        x0 ^= u << 18 | u >>> 32 - 18;
        u = x5 + x4 | 0;
        x6 ^= u << 7 | u >>> 32 - 7;
        u = x6 + x5 | 0;
        x7 ^= u << 9 | u >>> 32 - 9;
        u = x7 + x6 | 0;
        x4 ^= u << 13 | u >>> 32 - 13;
        u = x4 + x7 | 0;
        x5 ^= u << 18 | u >>> 32 - 18;
        u = x10 + x9 | 0;
        x11 ^= u << 7 | u >>> 32 - 7;
        u = x11 + x10 | 0;
        x8 ^= u << 9 | u >>> 32 - 9;
        u = x8 + x11 | 0;
        x9 ^= u << 13 | u >>> 32 - 13;
        u = x9 + x8 | 0;
        x10 ^= u << 18 | u >>> 32 - 18;
        u = x15 + x14 | 0;
        x12 ^= u << 7 | u >>> 32 - 7;
        u = x12 + x15 | 0;
        x13 ^= u << 9 | u >>> 32 - 9;
        u = x13 + x12 | 0;
        x14 ^= u << 13 | u >>> 32 - 13;
        u = x14 + x13 | 0;
        x15 ^= u << 18 | u >>> 32 - 18;
      }
      o[0] = x0 >>> 0 & 255;
      o[1] = x0 >>> 8 & 255;
      o[2] = x0 >>> 16 & 255;
      o[3] = x0 >>> 24 & 255;
      o[4] = x5 >>> 0 & 255;
      o[5] = x5 >>> 8 & 255;
      o[6] = x5 >>> 16 & 255;
      o[7] = x5 >>> 24 & 255;
      o[8] = x10 >>> 0 & 255;
      o[9] = x10 >>> 8 & 255;
      o[10] = x10 >>> 16 & 255;
      o[11] = x10 >>> 24 & 255;
      o[12] = x15 >>> 0 & 255;
      o[13] = x15 >>> 8 & 255;
      o[14] = x15 >>> 16 & 255;
      o[15] = x15 >>> 24 & 255;
      o[16] = x6 >>> 0 & 255;
      o[17] = x6 >>> 8 & 255;
      o[18] = x6 >>> 16 & 255;
      o[19] = x6 >>> 24 & 255;
      o[20] = x7 >>> 0 & 255;
      o[21] = x7 >>> 8 & 255;
      o[22] = x7 >>> 16 & 255;
      o[23] = x7 >>> 24 & 255;
      o[24] = x8 >>> 0 & 255;
      o[25] = x8 >>> 8 & 255;
      o[26] = x8 >>> 16 & 255;
      o[27] = x8 >>> 24 & 255;
      o[28] = x9 >>> 0 & 255;
      o[29] = x9 >>> 8 & 255;
      o[30] = x9 >>> 16 & 255;
      o[31] = x9 >>> 24 & 255;
    }
    function crypto_core_salsa20(out, inp, k, c) {
      core_salsa20(out, inp, k, c);
    }
    function crypto_core_hsalsa20(out, inp, k, c) {
      core_hsalsa20(out, inp, k, c);
    }
    var sigma = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);
    function crypto_stream_salsa20_xor(c, cpos, m, mpos, b, n, k) {
      var z = new Uint8Array(16), x = new Uint8Array(64);
      var u, i;
      for (i = 0;i < 16; i++)
        z[i] = 0;
      for (i = 0;i < 8; i++)
        z[i] = n[i];
      while (b >= 64) {
        crypto_core_salsa20(x, z, k, sigma);
        for (i = 0;i < 64; i++)
          c[cpos + i] = m[mpos + i] ^ x[i];
        u = 1;
        for (i = 8;i < 16; i++) {
          u = u + (z[i] & 255) | 0;
          z[i] = u & 255;
          u >>>= 8;
        }
        b -= 64;
        cpos += 64;
        mpos += 64;
      }
      if (b > 0) {
        crypto_core_salsa20(x, z, k, sigma);
        for (i = 0;i < b; i++)
          c[cpos + i] = m[mpos + i] ^ x[i];
      }
      return 0;
    }
    function crypto_stream_salsa20(c, cpos, b, n, k) {
      var z = new Uint8Array(16), x = new Uint8Array(64);
      var u, i;
      for (i = 0;i < 16; i++)
        z[i] = 0;
      for (i = 0;i < 8; i++)
        z[i] = n[i];
      while (b >= 64) {
        crypto_core_salsa20(x, z, k, sigma);
        for (i = 0;i < 64; i++)
          c[cpos + i] = x[i];
        u = 1;
        for (i = 8;i < 16; i++) {
          u = u + (z[i] & 255) | 0;
          z[i] = u & 255;
          u >>>= 8;
        }
        b -= 64;
        cpos += 64;
      }
      if (b > 0) {
        crypto_core_salsa20(x, z, k, sigma);
        for (i = 0;i < b; i++)
          c[cpos + i] = x[i];
      }
      return 0;
    }
    function crypto_stream(c, cpos, d, n, k) {
      var s = new Uint8Array(32);
      crypto_core_hsalsa20(s, n, k, sigma);
      var sn = new Uint8Array(8);
      for (var i = 0;i < 8; i++)
        sn[i] = n[i + 16];
      return crypto_stream_salsa20(c, cpos, d, sn, s);
    }
    function crypto_stream_xor(c, cpos, m, mpos, d, n, k) {
      var s = new Uint8Array(32);
      crypto_core_hsalsa20(s, n, k, sigma);
      var sn = new Uint8Array(8);
      for (var i = 0;i < 8; i++)
        sn[i] = n[i + 16];
      return crypto_stream_salsa20_xor(c, cpos, m, mpos, d, sn, s);
    }
    var poly1305 = function(key) {
      this.buffer = new Uint8Array(16);
      this.r = new Uint16Array(10);
      this.h = new Uint16Array(10);
      this.pad = new Uint16Array(8);
      this.leftover = 0;
      this.fin = 0;
      var t0, t1, t2, t3, t4, t5, t6, t7;
      t0 = key[0] & 255 | (key[1] & 255) << 8;
      this.r[0] = t0 & 8191;
      t1 = key[2] & 255 | (key[3] & 255) << 8;
      this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
      t2 = key[4] & 255 | (key[5] & 255) << 8;
      this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
      t3 = key[6] & 255 | (key[7] & 255) << 8;
      this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
      t4 = key[8] & 255 | (key[9] & 255) << 8;
      this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
      this.r[5] = t4 >>> 1 & 8190;
      t5 = key[10] & 255 | (key[11] & 255) << 8;
      this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
      t6 = key[12] & 255 | (key[13] & 255) << 8;
      this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
      t7 = key[14] & 255 | (key[15] & 255) << 8;
      this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
      this.r[9] = t7 >>> 5 & 127;
      this.pad[0] = key[16] & 255 | (key[17] & 255) << 8;
      this.pad[1] = key[18] & 255 | (key[19] & 255) << 8;
      this.pad[2] = key[20] & 255 | (key[21] & 255) << 8;
      this.pad[3] = key[22] & 255 | (key[23] & 255) << 8;
      this.pad[4] = key[24] & 255 | (key[25] & 255) << 8;
      this.pad[5] = key[26] & 255 | (key[27] & 255) << 8;
      this.pad[6] = key[28] & 255 | (key[29] & 255) << 8;
      this.pad[7] = key[30] & 255 | (key[31] & 255) << 8;
    };
    poly1305.prototype.blocks = function(m, mpos, bytes) {
      var hibit = this.fin ? 0 : 1 << 11;
      var t0, t1, t2, t3, t4, t5, t6, t7, c;
      var d0, d1, d2, d3, d4, d5, d6, d7, d8, d9;
      var h0 = this.h[0], h1 = this.h[1], h2 = this.h[2], h3 = this.h[3], h4 = this.h[4], h5 = this.h[5], h6 = this.h[6], h7 = this.h[7], h8 = this.h[8], h9 = this.h[9];
      var r0 = this.r[0], r1 = this.r[1], r2 = this.r[2], r3 = this.r[3], r4 = this.r[4], r5 = this.r[5], r6 = this.r[6], r7 = this.r[7], r8 = this.r[8], r9 = this.r[9];
      while (bytes >= 16) {
        t0 = m[mpos + 0] & 255 | (m[mpos + 1] & 255) << 8;
        h0 += t0 & 8191;
        t1 = m[mpos + 2] & 255 | (m[mpos + 3] & 255) << 8;
        h1 += (t0 >>> 13 | t1 << 3) & 8191;
        t2 = m[mpos + 4] & 255 | (m[mpos + 5] & 255) << 8;
        h2 += (t1 >>> 10 | t2 << 6) & 8191;
        t3 = m[mpos + 6] & 255 | (m[mpos + 7] & 255) << 8;
        h3 += (t2 >>> 7 | t3 << 9) & 8191;
        t4 = m[mpos + 8] & 255 | (m[mpos + 9] & 255) << 8;
        h4 += (t3 >>> 4 | t4 << 12) & 8191;
        h5 += t4 >>> 1 & 8191;
        t5 = m[mpos + 10] & 255 | (m[mpos + 11] & 255) << 8;
        h6 += (t4 >>> 14 | t5 << 2) & 8191;
        t6 = m[mpos + 12] & 255 | (m[mpos + 13] & 255) << 8;
        h7 += (t5 >>> 11 | t6 << 5) & 8191;
        t7 = m[mpos + 14] & 255 | (m[mpos + 15] & 255) << 8;
        h8 += (t6 >>> 8 | t7 << 8) & 8191;
        h9 += t7 >>> 5 | hibit;
        c = 0;
        d0 = c;
        d0 += h0 * r0;
        d0 += h1 * (5 * r9);
        d0 += h2 * (5 * r8);
        d0 += h3 * (5 * r7);
        d0 += h4 * (5 * r6);
        c = d0 >>> 13;
        d0 &= 8191;
        d0 += h5 * (5 * r5);
        d0 += h6 * (5 * r4);
        d0 += h7 * (5 * r3);
        d0 += h8 * (5 * r2);
        d0 += h9 * (5 * r1);
        c += d0 >>> 13;
        d0 &= 8191;
        d1 = c;
        d1 += h0 * r1;
        d1 += h1 * r0;
        d1 += h2 * (5 * r9);
        d1 += h3 * (5 * r8);
        d1 += h4 * (5 * r7);
        c = d1 >>> 13;
        d1 &= 8191;
        d1 += h5 * (5 * r6);
        d1 += h6 * (5 * r5);
        d1 += h7 * (5 * r4);
        d1 += h8 * (5 * r3);
        d1 += h9 * (5 * r2);
        c += d1 >>> 13;
        d1 &= 8191;
        d2 = c;
        d2 += h0 * r2;
        d2 += h1 * r1;
        d2 += h2 * r0;
        d2 += h3 * (5 * r9);
        d2 += h4 * (5 * r8);
        c = d2 >>> 13;
        d2 &= 8191;
        d2 += h5 * (5 * r7);
        d2 += h6 * (5 * r6);
        d2 += h7 * (5 * r5);
        d2 += h8 * (5 * r4);
        d2 += h9 * (5 * r3);
        c += d2 >>> 13;
        d2 &= 8191;
        d3 = c;
        d3 += h0 * r3;
        d3 += h1 * r2;
        d3 += h2 * r1;
        d3 += h3 * r0;
        d3 += h4 * (5 * r9);
        c = d3 >>> 13;
        d3 &= 8191;
        d3 += h5 * (5 * r8);
        d3 += h6 * (5 * r7);
        d3 += h7 * (5 * r6);
        d3 += h8 * (5 * r5);
        d3 += h9 * (5 * r4);
        c += d3 >>> 13;
        d3 &= 8191;
        d4 = c;
        d4 += h0 * r4;
        d4 += h1 * r3;
        d4 += h2 * r2;
        d4 += h3 * r1;
        d4 += h4 * r0;
        c = d4 >>> 13;
        d4 &= 8191;
        d4 += h5 * (5 * r9);
        d4 += h6 * (5 * r8);
        d4 += h7 * (5 * r7);
        d4 += h8 * (5 * r6);
        d4 += h9 * (5 * r5);
        c += d4 >>> 13;
        d4 &= 8191;
        d5 = c;
        d5 += h0 * r5;
        d5 += h1 * r4;
        d5 += h2 * r3;
        d5 += h3 * r2;
        d5 += h4 * r1;
        c = d5 >>> 13;
        d5 &= 8191;
        d5 += h5 * r0;
        d5 += h6 * (5 * r9);
        d5 += h7 * (5 * r8);
        d5 += h8 * (5 * r7);
        d5 += h9 * (5 * r6);
        c += d5 >>> 13;
        d5 &= 8191;
        d6 = c;
        d6 += h0 * r6;
        d6 += h1 * r5;
        d6 += h2 * r4;
        d6 += h3 * r3;
        d6 += h4 * r2;
        c = d6 >>> 13;
        d6 &= 8191;
        d6 += h5 * r1;
        d6 += h6 * r0;
        d6 += h7 * (5 * r9);
        d6 += h8 * (5 * r8);
        d6 += h9 * (5 * r7);
        c += d6 >>> 13;
        d6 &= 8191;
        d7 = c;
        d7 += h0 * r7;
        d7 += h1 * r6;
        d7 += h2 * r5;
        d7 += h3 * r4;
        d7 += h4 * r3;
        c = d7 >>> 13;
        d7 &= 8191;
        d7 += h5 * r2;
        d7 += h6 * r1;
        d7 += h7 * r0;
        d7 += h8 * (5 * r9);
        d7 += h9 * (5 * r8);
        c += d7 >>> 13;
        d7 &= 8191;
        d8 = c;
        d8 += h0 * r8;
        d8 += h1 * r7;
        d8 += h2 * r6;
        d8 += h3 * r5;
        d8 += h4 * r4;
        c = d8 >>> 13;
        d8 &= 8191;
        d8 += h5 * r3;
        d8 += h6 * r2;
        d8 += h7 * r1;
        d8 += h8 * r0;
        d8 += h9 * (5 * r9);
        c += d8 >>> 13;
        d8 &= 8191;
        d9 = c;
        d9 += h0 * r9;
        d9 += h1 * r8;
        d9 += h2 * r7;
        d9 += h3 * r6;
        d9 += h4 * r5;
        c = d9 >>> 13;
        d9 &= 8191;
        d9 += h5 * r4;
        d9 += h6 * r3;
        d9 += h7 * r2;
        d9 += h8 * r1;
        d9 += h9 * r0;
        c += d9 >>> 13;
        d9 &= 8191;
        c = (c << 2) + c | 0;
        c = c + d0 | 0;
        d0 = c & 8191;
        c = c >>> 13;
        d1 += c;
        h0 = d0;
        h1 = d1;
        h2 = d2;
        h3 = d3;
        h4 = d4;
        h5 = d5;
        h6 = d6;
        h7 = d7;
        h8 = d8;
        h9 = d9;
        mpos += 16;
        bytes -= 16;
      }
      this.h[0] = h0;
      this.h[1] = h1;
      this.h[2] = h2;
      this.h[3] = h3;
      this.h[4] = h4;
      this.h[5] = h5;
      this.h[6] = h6;
      this.h[7] = h7;
      this.h[8] = h8;
      this.h[9] = h9;
    };
    poly1305.prototype.finish = function(mac, macpos) {
      var g = new Uint16Array(10);
      var c, mask, f, i;
      if (this.leftover) {
        i = this.leftover;
        this.buffer[i++] = 1;
        for (;i < 16; i++)
          this.buffer[i] = 0;
        this.fin = 1;
        this.blocks(this.buffer, 0, 16);
      }
      c = this.h[1] >>> 13;
      this.h[1] &= 8191;
      for (i = 2;i < 10; i++) {
        this.h[i] += c;
        c = this.h[i] >>> 13;
        this.h[i] &= 8191;
      }
      this.h[0] += c * 5;
      c = this.h[0] >>> 13;
      this.h[0] &= 8191;
      this.h[1] += c;
      c = this.h[1] >>> 13;
      this.h[1] &= 8191;
      this.h[2] += c;
      g[0] = this.h[0] + 5;
      c = g[0] >>> 13;
      g[0] &= 8191;
      for (i = 1;i < 10; i++) {
        g[i] = this.h[i] + c;
        c = g[i] >>> 13;
        g[i] &= 8191;
      }
      g[9] -= 1 << 13;
      mask = (c ^ 1) - 1;
      for (i = 0;i < 10; i++)
        g[i] &= mask;
      mask = ~mask;
      for (i = 0;i < 10; i++)
        this.h[i] = this.h[i] & mask | g[i];
      this.h[0] = (this.h[0] | this.h[1] << 13) & 65535;
      this.h[1] = (this.h[1] >>> 3 | this.h[2] << 10) & 65535;
      this.h[2] = (this.h[2] >>> 6 | this.h[3] << 7) & 65535;
      this.h[3] = (this.h[3] >>> 9 | this.h[4] << 4) & 65535;
      this.h[4] = (this.h[4] >>> 12 | this.h[5] << 1 | this.h[6] << 14) & 65535;
      this.h[5] = (this.h[6] >>> 2 | this.h[7] << 11) & 65535;
      this.h[6] = (this.h[7] >>> 5 | this.h[8] << 8) & 65535;
      this.h[7] = (this.h[8] >>> 8 | this.h[9] << 5) & 65535;
      f = this.h[0] + this.pad[0];
      this.h[0] = f & 65535;
      for (i = 1;i < 8; i++) {
        f = (this.h[i] + this.pad[i] | 0) + (f >>> 16) | 0;
        this.h[i] = f & 65535;
      }
      mac[macpos + 0] = this.h[0] >>> 0 & 255;
      mac[macpos + 1] = this.h[0] >>> 8 & 255;
      mac[macpos + 2] = this.h[1] >>> 0 & 255;
      mac[macpos + 3] = this.h[1] >>> 8 & 255;
      mac[macpos + 4] = this.h[2] >>> 0 & 255;
      mac[macpos + 5] = this.h[2] >>> 8 & 255;
      mac[macpos + 6] = this.h[3] >>> 0 & 255;
      mac[macpos + 7] = this.h[3] >>> 8 & 255;
      mac[macpos + 8] = this.h[4] >>> 0 & 255;
      mac[macpos + 9] = this.h[4] >>> 8 & 255;
      mac[macpos + 10] = this.h[5] >>> 0 & 255;
      mac[macpos + 11] = this.h[5] >>> 8 & 255;
      mac[macpos + 12] = this.h[6] >>> 0 & 255;
      mac[macpos + 13] = this.h[6] >>> 8 & 255;
      mac[macpos + 14] = this.h[7] >>> 0 & 255;
      mac[macpos + 15] = this.h[7] >>> 8 & 255;
    };
    poly1305.prototype.update = function(m, mpos, bytes) {
      var i, want;
      if (this.leftover) {
        want = 16 - this.leftover;
        if (want > bytes)
          want = bytes;
        for (i = 0;i < want; i++)
          this.buffer[this.leftover + i] = m[mpos + i];
        bytes -= want;
        mpos += want;
        this.leftover += want;
        if (this.leftover < 16)
          return;
        this.blocks(this.buffer, 0, 16);
        this.leftover = 0;
      }
      if (bytes >= 16) {
        want = bytes - bytes % 16;
        this.blocks(m, mpos, want);
        mpos += want;
        bytes -= want;
      }
      if (bytes) {
        for (i = 0;i < bytes; i++)
          this.buffer[this.leftover + i] = m[mpos + i];
        this.leftover += bytes;
      }
    };
    function crypto_onetimeauth(out, outpos, m, mpos, n, k) {
      var s = new poly1305(k);
      s.update(m, mpos, n);
      s.finish(out, outpos);
      return 0;
    }
    function crypto_onetimeauth_verify(h, hpos, m, mpos, n, k) {
      var x = new Uint8Array(16);
      crypto_onetimeauth(x, 0, m, mpos, n, k);
      return crypto_verify_16(h, hpos, x, 0);
    }
    function crypto_secretbox(c, m, d, n, k) {
      var i;
      if (d < 32)
        return -1;
      crypto_stream_xor(c, 0, m, 0, d, n, k);
      crypto_onetimeauth(c, 16, c, 32, d - 32, c);
      for (i = 0;i < 16; i++)
        c[i] = 0;
      return 0;
    }
    function crypto_secretbox_open(m, c, d, n, k) {
      var i;
      var x = new Uint8Array(32);
      if (d < 32)
        return -1;
      crypto_stream(x, 0, 32, n, k);
      if (crypto_onetimeauth_verify(c, 16, c, 32, d - 32, x) !== 0)
        return -1;
      crypto_stream_xor(m, 0, c, 0, d, n, k);
      for (i = 0;i < 32; i++)
        m[i] = 0;
      return 0;
    }
    function set25519(r, a) {
      var i;
      for (i = 0;i < 16; i++)
        r[i] = a[i] | 0;
    }
    function car25519(o) {
      var i, v, c = 1;
      for (i = 0;i < 16; i++) {
        v = o[i] + c + 65535;
        c = Math.floor(v / 65536);
        o[i] = v - c * 65536;
      }
      o[0] += c - 1 + 37 * (c - 1);
    }
    function sel25519(p, q, b) {
      var t, c = ~(b - 1);
      for (var i = 0;i < 16; i++) {
        t = c & (p[i] ^ q[i]);
        p[i] ^= t;
        q[i] ^= t;
      }
    }
    function pack25519(o, n) {
      var i, j, b;
      var m = gf(), t = gf();
      for (i = 0;i < 16; i++)
        t[i] = n[i];
      car25519(t);
      car25519(t);
      car25519(t);
      for (j = 0;j < 2; j++) {
        m[0] = t[0] - 65517;
        for (i = 1;i < 15; i++) {
          m[i] = t[i] - 65535 - (m[i - 1] >> 16 & 1);
          m[i - 1] &= 65535;
        }
        m[15] = t[15] - 32767 - (m[14] >> 16 & 1);
        b = m[15] >> 16 & 1;
        m[14] &= 65535;
        sel25519(t, m, 1 - b);
      }
      for (i = 0;i < 16; i++) {
        o[2 * i] = t[i] & 255;
        o[2 * i + 1] = t[i] >> 8;
      }
    }
    function neq25519(a, b) {
      var c = new Uint8Array(32), d = new Uint8Array(32);
      pack25519(c, a);
      pack25519(d, b);
      return crypto_verify_32(c, 0, d, 0);
    }
    function par25519(a) {
      var d = new Uint8Array(32);
      pack25519(d, a);
      return d[0] & 1;
    }
    function unpack25519(o, n) {
      var i;
      for (i = 0;i < 16; i++)
        o[i] = n[2 * i] + (n[2 * i + 1] << 8);
      o[15] &= 32767;
    }
    function A(o, a, b) {
      for (var i = 0;i < 16; i++)
        o[i] = a[i] + b[i];
    }
    function Z(o, a, b) {
      for (var i = 0;i < 16; i++)
        o[i] = a[i] - b[i];
    }
    function M(o, a, b) {
      var v, c, t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0, t8 = 0, t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0, t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0, t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0, b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11], b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];
      v = a[0];
      t0 += v * b0;
      t1 += v * b1;
      t2 += v * b2;
      t3 += v * b3;
      t4 += v * b4;
      t5 += v * b5;
      t6 += v * b6;
      t7 += v * b7;
      t8 += v * b8;
      t9 += v * b9;
      t10 += v * b10;
      t11 += v * b11;
      t12 += v * b12;
      t13 += v * b13;
      t14 += v * b14;
      t15 += v * b15;
      v = a[1];
      t1 += v * b0;
      t2 += v * b1;
      t3 += v * b2;
      t4 += v * b3;
      t5 += v * b4;
      t6 += v * b5;
      t7 += v * b6;
      t8 += v * b7;
      t9 += v * b8;
      t10 += v * b9;
      t11 += v * b10;
      t12 += v * b11;
      t13 += v * b12;
      t14 += v * b13;
      t15 += v * b14;
      t16 += v * b15;
      v = a[2];
      t2 += v * b0;
      t3 += v * b1;
      t4 += v * b2;
      t5 += v * b3;
      t6 += v * b4;
      t7 += v * b5;
      t8 += v * b6;
      t9 += v * b7;
      t10 += v * b8;
      t11 += v * b9;
      t12 += v * b10;
      t13 += v * b11;
      t14 += v * b12;
      t15 += v * b13;
      t16 += v * b14;
      t17 += v * b15;
      v = a[3];
      t3 += v * b0;
      t4 += v * b1;
      t5 += v * b2;
      t6 += v * b3;
      t7 += v * b4;
      t8 += v * b5;
      t9 += v * b6;
      t10 += v * b7;
      t11 += v * b8;
      t12 += v * b9;
      t13 += v * b10;
      t14 += v * b11;
      t15 += v * b12;
      t16 += v * b13;
      t17 += v * b14;
      t18 += v * b15;
      v = a[4];
      t4 += v * b0;
      t5 += v * b1;
      t6 += v * b2;
      t7 += v * b3;
      t8 += v * b4;
      t9 += v * b5;
      t10 += v * b6;
      t11 += v * b7;
      t12 += v * b8;
      t13 += v * b9;
      t14 += v * b10;
      t15 += v * b11;
      t16 += v * b12;
      t17 += v * b13;
      t18 += v * b14;
      t19 += v * b15;
      v = a[5];
      t5 += v * b0;
      t6 += v * b1;
      t7 += v * b2;
      t8 += v * b3;
      t9 += v * b4;
      t10 += v * b5;
      t11 += v * b6;
      t12 += v * b7;
      t13 += v * b8;
      t14 += v * b9;
      t15 += v * b10;
      t16 += v * b11;
      t17 += v * b12;
      t18 += v * b13;
      t19 += v * b14;
      t20 += v * b15;
      v = a[6];
      t6 += v * b0;
      t7 += v * b1;
      t8 += v * b2;
      t9 += v * b3;
      t10 += v * b4;
      t11 += v * b5;
      t12 += v * b6;
      t13 += v * b7;
      t14 += v * b8;
      t15 += v * b9;
      t16 += v * b10;
      t17 += v * b11;
      t18 += v * b12;
      t19 += v * b13;
      t20 += v * b14;
      t21 += v * b15;
      v = a[7];
      t7 += v * b0;
      t8 += v * b1;
      t9 += v * b2;
      t10 += v * b3;
      t11 += v * b4;
      t12 += v * b5;
      t13 += v * b6;
      t14 += v * b7;
      t15 += v * b8;
      t16 += v * b9;
      t17 += v * b10;
      t18 += v * b11;
      t19 += v * b12;
      t20 += v * b13;
      t21 += v * b14;
      t22 += v * b15;
      v = a[8];
      t8 += v * b0;
      t9 += v * b1;
      t10 += v * b2;
      t11 += v * b3;
      t12 += v * b4;
      t13 += v * b5;
      t14 += v * b6;
      t15 += v * b7;
      t16 += v * b8;
      t17 += v * b9;
      t18 += v * b10;
      t19 += v * b11;
      t20 += v * b12;
      t21 += v * b13;
      t22 += v * b14;
      t23 += v * b15;
      v = a[9];
      t9 += v * b0;
      t10 += v * b1;
      t11 += v * b2;
      t12 += v * b3;
      t13 += v * b4;
      t14 += v * b5;
      t15 += v * b6;
      t16 += v * b7;
      t17 += v * b8;
      t18 += v * b9;
      t19 += v * b10;
      t20 += v * b11;
      t21 += v * b12;
      t22 += v * b13;
      t23 += v * b14;
      t24 += v * b15;
      v = a[10];
      t10 += v * b0;
      t11 += v * b1;
      t12 += v * b2;
      t13 += v * b3;
      t14 += v * b4;
      t15 += v * b5;
      t16 += v * b6;
      t17 += v * b7;
      t18 += v * b8;
      t19 += v * b9;
      t20 += v * b10;
      t21 += v * b11;
      t22 += v * b12;
      t23 += v * b13;
      t24 += v * b14;
      t25 += v * b15;
      v = a[11];
      t11 += v * b0;
      t12 += v * b1;
      t13 += v * b2;
      t14 += v * b3;
      t15 += v * b4;
      t16 += v * b5;
      t17 += v * b6;
      t18 += v * b7;
      t19 += v * b8;
      t20 += v * b9;
      t21 += v * b10;
      t22 += v * b11;
      t23 += v * b12;
      t24 += v * b13;
      t25 += v * b14;
      t26 += v * b15;
      v = a[12];
      t12 += v * b0;
      t13 += v * b1;
      t14 += v * b2;
      t15 += v * b3;
      t16 += v * b4;
      t17 += v * b5;
      t18 += v * b6;
      t19 += v * b7;
      t20 += v * b8;
      t21 += v * b9;
      t22 += v * b10;
      t23 += v * b11;
      t24 += v * b12;
      t25 += v * b13;
      t26 += v * b14;
      t27 += v * b15;
      v = a[13];
      t13 += v * b0;
      t14 += v * b1;
      t15 += v * b2;
      t16 += v * b3;
      t17 += v * b4;
      t18 += v * b5;
      t19 += v * b6;
      t20 += v * b7;
      t21 += v * b8;
      t22 += v * b9;
      t23 += v * b10;
      t24 += v * b11;
      t25 += v * b12;
      t26 += v * b13;
      t27 += v * b14;
      t28 += v * b15;
      v = a[14];
      t14 += v * b0;
      t15 += v * b1;
      t16 += v * b2;
      t17 += v * b3;
      t18 += v * b4;
      t19 += v * b5;
      t20 += v * b6;
      t21 += v * b7;
      t22 += v * b8;
      t23 += v * b9;
      t24 += v * b10;
      t25 += v * b11;
      t26 += v * b12;
      t27 += v * b13;
      t28 += v * b14;
      t29 += v * b15;
      v = a[15];
      t15 += v * b0;
      t16 += v * b1;
      t17 += v * b2;
      t18 += v * b3;
      t19 += v * b4;
      t20 += v * b5;
      t21 += v * b6;
      t22 += v * b7;
      t23 += v * b8;
      t24 += v * b9;
      t25 += v * b10;
      t26 += v * b11;
      t27 += v * b12;
      t28 += v * b13;
      t29 += v * b14;
      t30 += v * b15;
      t0 += 38 * t16;
      t1 += 38 * t17;
      t2 += 38 * t18;
      t3 += 38 * t19;
      t4 += 38 * t20;
      t5 += 38 * t21;
      t6 += 38 * t22;
      t7 += 38 * t23;
      t8 += 38 * t24;
      t9 += 38 * t25;
      t10 += 38 * t26;
      t11 += 38 * t27;
      t12 += 38 * t28;
      t13 += 38 * t29;
      t14 += 38 * t30;
      c = 1;
      v = t0 + c + 65535;
      c = Math.floor(v / 65536);
      t0 = v - c * 65536;
      v = t1 + c + 65535;
      c = Math.floor(v / 65536);
      t1 = v - c * 65536;
      v = t2 + c + 65535;
      c = Math.floor(v / 65536);
      t2 = v - c * 65536;
      v = t3 + c + 65535;
      c = Math.floor(v / 65536);
      t3 = v - c * 65536;
      v = t4 + c + 65535;
      c = Math.floor(v / 65536);
      t4 = v - c * 65536;
      v = t5 + c + 65535;
      c = Math.floor(v / 65536);
      t5 = v - c * 65536;
      v = t6 + c + 65535;
      c = Math.floor(v / 65536);
      t6 = v - c * 65536;
      v = t7 + c + 65535;
      c = Math.floor(v / 65536);
      t7 = v - c * 65536;
      v = t8 + c + 65535;
      c = Math.floor(v / 65536);
      t8 = v - c * 65536;
      v = t9 + c + 65535;
      c = Math.floor(v / 65536);
      t9 = v - c * 65536;
      v = t10 + c + 65535;
      c = Math.floor(v / 65536);
      t10 = v - c * 65536;
      v = t11 + c + 65535;
      c = Math.floor(v / 65536);
      t11 = v - c * 65536;
      v = t12 + c + 65535;
      c = Math.floor(v / 65536);
      t12 = v - c * 65536;
      v = t13 + c + 65535;
      c = Math.floor(v / 65536);
      t13 = v - c * 65536;
      v = t14 + c + 65535;
      c = Math.floor(v / 65536);
      t14 = v - c * 65536;
      v = t15 + c + 65535;
      c = Math.floor(v / 65536);
      t15 = v - c * 65536;
      t0 += c - 1 + 37 * (c - 1);
      c = 1;
      v = t0 + c + 65535;
      c = Math.floor(v / 65536);
      t0 = v - c * 65536;
      v = t1 + c + 65535;
      c = Math.floor(v / 65536);
      t1 = v - c * 65536;
      v = t2 + c + 65535;
      c = Math.floor(v / 65536);
      t2 = v - c * 65536;
      v = t3 + c + 65535;
      c = Math.floor(v / 65536);
      t3 = v - c * 65536;
      v = t4 + c + 65535;
      c = Math.floor(v / 65536);
      t4 = v - c * 65536;
      v = t5 + c + 65535;
      c = Math.floor(v / 65536);
      t5 = v - c * 65536;
      v = t6 + c + 65535;
      c = Math.floor(v / 65536);
      t6 = v - c * 65536;
      v = t7 + c + 65535;
      c = Math.floor(v / 65536);
      t7 = v - c * 65536;
      v = t8 + c + 65535;
      c = Math.floor(v / 65536);
      t8 = v - c * 65536;
      v = t9 + c + 65535;
      c = Math.floor(v / 65536);
      t9 = v - c * 65536;
      v = t10 + c + 65535;
      c = Math.floor(v / 65536);
      t10 = v - c * 65536;
      v = t11 + c + 65535;
      c = Math.floor(v / 65536);
      t11 = v - c * 65536;
      v = t12 + c + 65535;
      c = Math.floor(v / 65536);
      t12 = v - c * 65536;
      v = t13 + c + 65535;
      c = Math.floor(v / 65536);
      t13 = v - c * 65536;
      v = t14 + c + 65535;
      c = Math.floor(v / 65536);
      t14 = v - c * 65536;
      v = t15 + c + 65535;
      c = Math.floor(v / 65536);
      t15 = v - c * 65536;
      t0 += c - 1 + 37 * (c - 1);
      o[0] = t0;
      o[1] = t1;
      o[2] = t2;
      o[3] = t3;
      o[4] = t4;
      o[5] = t5;
      o[6] = t6;
      o[7] = t7;
      o[8] = t8;
      o[9] = t9;
      o[10] = t10;
      o[11] = t11;
      o[12] = t12;
      o[13] = t13;
      o[14] = t14;
      o[15] = t15;
    }
    function S(o, a) {
      M(o, a, a);
    }
    function inv25519(o, i) {
      var c = gf();
      var a;
      for (a = 0;a < 16; a++)
        c[a] = i[a];
      for (a = 253;a >= 0; a--) {
        S(c, c);
        if (a !== 2 && a !== 4)
          M(c, c, i);
      }
      for (a = 0;a < 16; a++)
        o[a] = c[a];
    }
    function pow2523(o, i) {
      var c = gf();
      var a;
      for (a = 0;a < 16; a++)
        c[a] = i[a];
      for (a = 250;a >= 0; a--) {
        S(c, c);
        if (a !== 1)
          M(c, c, i);
      }
      for (a = 0;a < 16; a++)
        o[a] = c[a];
    }
    function crypto_scalarmult(q, n, p) {
      var z = new Uint8Array(32);
      var x = new Float64Array(80), r, i;
      var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
      for (i = 0;i < 31; i++)
        z[i] = n[i];
      z[31] = n[31] & 127 | 64;
      z[0] &= 248;
      unpack25519(x, p);
      for (i = 0;i < 16; i++) {
        b[i] = x[i];
        d[i] = a[i] = c[i] = 0;
      }
      a[0] = d[0] = 1;
      for (i = 254;i >= 0; --i) {
        r = z[i >>> 3] >>> (i & 7) & 1;
        sel25519(a, b, r);
        sel25519(c, d, r);
        A(e, a, c);
        Z(a, a, c);
        A(c, b, d);
        Z(b, b, d);
        S(d, e);
        S(f, a);
        M(a, c, a);
        M(c, b, e);
        A(e, a, c);
        Z(a, a, c);
        S(b, a);
        Z(c, d, f);
        M(a, c, _121665);
        A(a, a, d);
        M(c, c, a);
        M(a, d, f);
        M(d, b, x);
        S(b, e);
        sel25519(a, b, r);
        sel25519(c, d, r);
      }
      for (i = 0;i < 16; i++) {
        x[i + 16] = a[i];
        x[i + 32] = c[i];
        x[i + 48] = b[i];
        x[i + 64] = d[i];
      }
      var x32 = x.subarray(32);
      var x16 = x.subarray(16);
      inv25519(x32, x32);
      M(x16, x16, x32);
      pack25519(q, x16);
      return 0;
    }
    function crypto_scalarmult_base(q, n) {
      return crypto_scalarmult(q, n, _9);
    }
    function crypto_box_keypair(y, x) {
      randombytes(x, 32);
      return crypto_scalarmult_base(y, x);
    }
    function crypto_box_beforenm(k, y, x) {
      var s = new Uint8Array(32);
      crypto_scalarmult(s, x, y);
      return crypto_core_hsalsa20(k, _0, s, sigma);
    }
    var crypto_box_afternm = crypto_secretbox;
    var crypto_box_open_afternm = crypto_secretbox_open;
    function crypto_box(c, m, d, n, y, x) {
      var k = new Uint8Array(32);
      crypto_box_beforenm(k, y, x);
      return crypto_box_afternm(c, m, d, n, k);
    }
    function crypto_box_open(m, c, d, n, y, x) {
      var k = new Uint8Array(32);
      crypto_box_beforenm(k, y, x);
      return crypto_box_open_afternm(m, c, d, n, k);
    }
    var K = [
      1116352408,
      3609767458,
      1899447441,
      602891725,
      3049323471,
      3964484399,
      3921009573,
      2173295548,
      961987163,
      4081628472,
      1508970993,
      3053834265,
      2453635748,
      2937671579,
      2870763221,
      3664609560,
      3624381080,
      2734883394,
      310598401,
      1164996542,
      607225278,
      1323610764,
      1426881987,
      3590304994,
      1925078388,
      4068182383,
      2162078206,
      991336113,
      2614888103,
      633803317,
      3248222580,
      3479774868,
      3835390401,
      2666613458,
      4022224774,
      944711139,
      264347078,
      2341262773,
      604807628,
      2007800933,
      770255983,
      1495990901,
      1249150122,
      1856431235,
      1555081692,
      3175218132,
      1996064986,
      2198950837,
      2554220882,
      3999719339,
      2821834349,
      766784016,
      2952996808,
      2566594879,
      3210313671,
      3203337956,
      3336571891,
      1034457026,
      3584528711,
      2466948901,
      113926993,
      3758326383,
      338241895,
      168717936,
      666307205,
      1188179964,
      773529912,
      1546045734,
      1294757372,
      1522805485,
      1396182291,
      2643833823,
      1695183700,
      2343527390,
      1986661051,
      1014477480,
      2177026350,
      1206759142,
      2456956037,
      344077627,
      2730485921,
      1290863460,
      2820302411,
      3158454273,
      3259730800,
      3505952657,
      3345764771,
      106217008,
      3516065817,
      3606008344,
      3600352804,
      1432725776,
      4094571909,
      1467031594,
      275423344,
      851169720,
      430227734,
      3100823752,
      506948616,
      1363258195,
      659060556,
      3750685593,
      883997877,
      3785050280,
      958139571,
      3318307427,
      1322822218,
      3812723403,
      1537002063,
      2003034995,
      1747873779,
      3602036899,
      1955562222,
      1575990012,
      2024104815,
      1125592928,
      2227730452,
      2716904306,
      2361852424,
      442776044,
      2428436474,
      593698344,
      2756734187,
      3733110249,
      3204031479,
      2999351573,
      3329325298,
      3815920427,
      3391569614,
      3928383900,
      3515267271,
      566280711,
      3940187606,
      3454069534,
      4118630271,
      4000239992,
      116418474,
      1914138554,
      174292421,
      2731055270,
      289380356,
      3203993006,
      460393269,
      320620315,
      685471733,
      587496836,
      852142971,
      1086792851,
      1017036298,
      365543100,
      1126000580,
      2618297676,
      1288033470,
      3409855158,
      1501505948,
      4234509866,
      1607167915,
      987167468,
      1816402316,
      1246189591
    ];
    function crypto_hashblocks_hl(hh, hl, m, n) {
      var wh = new Int32Array(16), wl = new Int32Array(16), bh0, bh1, bh2, bh3, bh4, bh5, bh6, bh7, bl0, bl1, bl2, bl3, bl4, bl5, bl6, bl7, th, tl, i, j, h, l, a, b, c, d;
      var ah0 = hh[0], ah1 = hh[1], ah2 = hh[2], ah3 = hh[3], ah4 = hh[4], ah5 = hh[5], ah6 = hh[6], ah7 = hh[7], al0 = hl[0], al1 = hl[1], al2 = hl[2], al3 = hl[3], al4 = hl[4], al5 = hl[5], al6 = hl[6], al7 = hl[7];
      var pos = 0;
      while (n >= 128) {
        for (i = 0;i < 16; i++) {
          j = 8 * i + pos;
          wh[i] = m[j + 0] << 24 | m[j + 1] << 16 | m[j + 2] << 8 | m[j + 3];
          wl[i] = m[j + 4] << 24 | m[j + 5] << 16 | m[j + 6] << 8 | m[j + 7];
        }
        for (i = 0;i < 80; i++) {
          bh0 = ah0;
          bh1 = ah1;
          bh2 = ah2;
          bh3 = ah3;
          bh4 = ah4;
          bh5 = ah5;
          bh6 = ah6;
          bh7 = ah7;
          bl0 = al0;
          bl1 = al1;
          bl2 = al2;
          bl3 = al3;
          bl4 = al4;
          bl5 = al5;
          bl6 = al6;
          bl7 = al7;
          h = ah7;
          l = al7;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = (ah4 >>> 14 | al4 << 32 - 14) ^ (ah4 >>> 18 | al4 << 32 - 18) ^ (al4 >>> 41 - 32 | ah4 << 32 - (41 - 32));
          l = (al4 >>> 14 | ah4 << 32 - 14) ^ (al4 >>> 18 | ah4 << 32 - 18) ^ (ah4 >>> 41 - 32 | al4 << 32 - (41 - 32));
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          h = ah4 & ah5 ^ ~ah4 & ah6;
          l = al4 & al5 ^ ~al4 & al6;
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          h = K[i * 2];
          l = K[i * 2 + 1];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          h = wh[i % 16];
          l = wl[i % 16];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          th = c & 65535 | d << 16;
          tl = a & 65535 | b << 16;
          h = th;
          l = tl;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = (ah0 >>> 28 | al0 << 32 - 28) ^ (al0 >>> 34 - 32 | ah0 << 32 - (34 - 32)) ^ (al0 >>> 39 - 32 | ah0 << 32 - (39 - 32));
          l = (al0 >>> 28 | ah0 << 32 - 28) ^ (ah0 >>> 34 - 32 | al0 << 32 - (34 - 32)) ^ (ah0 >>> 39 - 32 | al0 << 32 - (39 - 32));
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          h = ah0 & ah1 ^ ah0 & ah2 ^ ah1 & ah2;
          l = al0 & al1 ^ al0 & al2 ^ al1 & al2;
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          bh7 = c & 65535 | d << 16;
          bl7 = a & 65535 | b << 16;
          h = bh3;
          l = bl3;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = th;
          l = tl;
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          bh3 = c & 65535 | d << 16;
          bl3 = a & 65535 | b << 16;
          ah1 = bh0;
          ah2 = bh1;
          ah3 = bh2;
          ah4 = bh3;
          ah5 = bh4;
          ah6 = bh5;
          ah7 = bh6;
          ah0 = bh7;
          al1 = bl0;
          al2 = bl1;
          al3 = bl2;
          al4 = bl3;
          al5 = bl4;
          al6 = bl5;
          al7 = bl6;
          al0 = bl7;
          if (i % 16 === 15) {
            for (j = 0;j < 16; j++) {
              h = wh[j];
              l = wl[j];
              a = l & 65535;
              b = l >>> 16;
              c = h & 65535;
              d = h >>> 16;
              h = wh[(j + 9) % 16];
              l = wl[(j + 9) % 16];
              a += l & 65535;
              b += l >>> 16;
              c += h & 65535;
              d += h >>> 16;
              th = wh[(j + 1) % 16];
              tl = wl[(j + 1) % 16];
              h = (th >>> 1 | tl << 32 - 1) ^ (th >>> 8 | tl << 32 - 8) ^ th >>> 7;
              l = (tl >>> 1 | th << 32 - 1) ^ (tl >>> 8 | th << 32 - 8) ^ (tl >>> 7 | th << 32 - 7);
              a += l & 65535;
              b += l >>> 16;
              c += h & 65535;
              d += h >>> 16;
              th = wh[(j + 14) % 16];
              tl = wl[(j + 14) % 16];
              h = (th >>> 19 | tl << 32 - 19) ^ (tl >>> 61 - 32 | th << 32 - (61 - 32)) ^ th >>> 6;
              l = (tl >>> 19 | th << 32 - 19) ^ (th >>> 61 - 32 | tl << 32 - (61 - 32)) ^ (tl >>> 6 | th << 32 - 6);
              a += l & 65535;
              b += l >>> 16;
              c += h & 65535;
              d += h >>> 16;
              b += a >>> 16;
              c += b >>> 16;
              d += c >>> 16;
              wh[j] = c & 65535 | d << 16;
              wl[j] = a & 65535 | b << 16;
            }
          }
        }
        h = ah0;
        l = al0;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[0];
        l = hl[0];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[0] = ah0 = c & 65535 | d << 16;
        hl[0] = al0 = a & 65535 | b << 16;
        h = ah1;
        l = al1;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[1];
        l = hl[1];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[1] = ah1 = c & 65535 | d << 16;
        hl[1] = al1 = a & 65535 | b << 16;
        h = ah2;
        l = al2;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[2];
        l = hl[2];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[2] = ah2 = c & 65535 | d << 16;
        hl[2] = al2 = a & 65535 | b << 16;
        h = ah3;
        l = al3;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[3];
        l = hl[3];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[3] = ah3 = c & 65535 | d << 16;
        hl[3] = al3 = a & 65535 | b << 16;
        h = ah4;
        l = al4;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[4];
        l = hl[4];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[4] = ah4 = c & 65535 | d << 16;
        hl[4] = al4 = a & 65535 | b << 16;
        h = ah5;
        l = al5;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[5];
        l = hl[5];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[5] = ah5 = c & 65535 | d << 16;
        hl[5] = al5 = a & 65535 | b << 16;
        h = ah6;
        l = al6;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[6];
        l = hl[6];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[6] = ah6 = c & 65535 | d << 16;
        hl[6] = al6 = a & 65535 | b << 16;
        h = ah7;
        l = al7;
        a = l & 65535;
        b = l >>> 16;
        c = h & 65535;
        d = h >>> 16;
        h = hh[7];
        l = hl[7];
        a += l & 65535;
        b += l >>> 16;
        c += h & 65535;
        d += h >>> 16;
        b += a >>> 16;
        c += b >>> 16;
        d += c >>> 16;
        hh[7] = ah7 = c & 65535 | d << 16;
        hl[7] = al7 = a & 65535 | b << 16;
        pos += 128;
        n -= 128;
      }
      return n;
    }
    function crypto_hash(out, m, n) {
      var hh = new Int32Array(8), hl = new Int32Array(8), x = new Uint8Array(256), i, b = n;
      hh[0] = 1779033703;
      hh[1] = 3144134277;
      hh[2] = 1013904242;
      hh[3] = 2773480762;
      hh[4] = 1359893119;
      hh[5] = 2600822924;
      hh[6] = 528734635;
      hh[7] = 1541459225;
      hl[0] = 4089235720;
      hl[1] = 2227873595;
      hl[2] = 4271175723;
      hl[3] = 1595750129;
      hl[4] = 2917565137;
      hl[5] = 725511199;
      hl[6] = 4215389547;
      hl[7] = 327033209;
      crypto_hashblocks_hl(hh, hl, m, n);
      n %= 128;
      for (i = 0;i < n; i++)
        x[i] = m[b - n + i];
      x[n] = 128;
      n = 256 - 128 * (n < 112 ? 1 : 0);
      x[n - 9] = 0;
      ts64(x, n - 8, b / 536870912 | 0, b << 3);
      crypto_hashblocks_hl(hh, hl, x, n);
      for (i = 0;i < 8; i++)
        ts64(out, 8 * i, hh[i], hl[i]);
      return 0;
    }
    function add(p, q) {
      var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
      Z(a, p[1], p[0]);
      Z(t, q[1], q[0]);
      M(a, a, t);
      A(b, p[0], p[1]);
      A(t, q[0], q[1]);
      M(b, b, t);
      M(c, p[3], q[3]);
      M(c, c, D2);
      M(d, p[2], q[2]);
      A(d, d, d);
      Z(e, b, a);
      Z(f, d, c);
      A(g, d, c);
      A(h, b, a);
      M(p[0], e, f);
      M(p[1], h, g);
      M(p[2], g, f);
      M(p[3], e, h);
    }
    function cswap(p, q, b) {
      var i;
      for (i = 0;i < 4; i++) {
        sel25519(p[i], q[i], b);
      }
    }
    function pack(r, p) {
      var tx = gf(), ty = gf(), zi = gf();
      inv25519(zi, p[2]);
      M(tx, p[0], zi);
      M(ty, p[1], zi);
      pack25519(r, ty);
      r[31] ^= par25519(tx) << 7;
    }
    function scalarmult(p, q, s) {
      var b, i;
      set25519(p[0], gf0);
      set25519(p[1], gf1);
      set25519(p[2], gf1);
      set25519(p[3], gf0);
      for (i = 255;i >= 0; --i) {
        b = s[i / 8 | 0] >> (i & 7) & 1;
        cswap(p, q, b);
        add(q, p);
        add(p, p);
        cswap(p, q, b);
      }
    }
    function scalarbase(p, s) {
      var q = [gf(), gf(), gf(), gf()];
      set25519(q[0], X);
      set25519(q[1], Y);
      set25519(q[2], gf1);
      M(q[3], X, Y);
      scalarmult(p, q, s);
    }
    function crypto_sign_keypair(pk, sk, seeded) {
      var d = new Uint8Array(64);
      var p = [gf(), gf(), gf(), gf()];
      var i;
      if (!seeded)
        randombytes(sk, 32);
      crypto_hash(d, sk, 32);
      d[0] &= 248;
      d[31] &= 127;
      d[31] |= 64;
      scalarbase(p, d);
      pack(pk, p);
      for (i = 0;i < 32; i++)
        sk[i + 32] = pk[i];
      return 0;
    }
    var L = new Float64Array([237, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]);
    function modL(r, x) {
      var carry, i, j, k;
      for (i = 63;i >= 32; --i) {
        carry = 0;
        for (j = i - 32, k = i - 12;j < k; ++j) {
          x[j] += carry - 16 * x[i] * L[j - (i - 32)];
          carry = Math.floor((x[j] + 128) / 256);
          x[j] -= carry * 256;
        }
        x[j] += carry;
        x[i] = 0;
      }
      carry = 0;
      for (j = 0;j < 32; j++) {
        x[j] += carry - (x[31] >> 4) * L[j];
        carry = x[j] >> 8;
        x[j] &= 255;
      }
      for (j = 0;j < 32; j++)
        x[j] -= carry * L[j];
      for (i = 0;i < 32; i++) {
        x[i + 1] += x[i] >> 8;
        r[i] = x[i] & 255;
      }
    }
    function reduce(r) {
      var x = new Float64Array(64), i;
      for (i = 0;i < 64; i++)
        x[i] = r[i];
      for (i = 0;i < 64; i++)
        r[i] = 0;
      modL(r, x);
    }
    function crypto_sign(sm, m, n, sk) {
      var d = new Uint8Array(64), h = new Uint8Array(64), r = new Uint8Array(64);
      var i, j, x = new Float64Array(64);
      var p = [gf(), gf(), gf(), gf()];
      crypto_hash(d, sk, 32);
      d[0] &= 248;
      d[31] &= 127;
      d[31] |= 64;
      var smlen = n + 64;
      for (i = 0;i < n; i++)
        sm[64 + i] = m[i];
      for (i = 0;i < 32; i++)
        sm[32 + i] = d[32 + i];
      crypto_hash(r, sm.subarray(32), n + 32);
      reduce(r);
      scalarbase(p, r);
      pack(sm, p);
      for (i = 32;i < 64; i++)
        sm[i] = sk[i];
      crypto_hash(h, sm, n + 64);
      reduce(h);
      for (i = 0;i < 64; i++)
        x[i] = 0;
      for (i = 0;i < 32; i++)
        x[i] = r[i];
      for (i = 0;i < 32; i++) {
        for (j = 0;j < 32; j++) {
          x[i + j] += h[i] * d[j];
        }
      }
      modL(sm.subarray(32), x);
      return smlen;
    }
    function unpackneg(r, p) {
      var t = gf(), chk = gf(), num = gf(), den = gf(), den2 = gf(), den4 = gf(), den6 = gf();
      set25519(r[2], gf1);
      unpack25519(r[1], p);
      S(num, r[1]);
      M(den, num, D);
      Z(num, num, r[2]);
      A(den, r[2], den);
      S(den2, den);
      S(den4, den2);
      M(den6, den4, den2);
      M(t, den6, num);
      M(t, t, den);
      pow2523(t, t);
      M(t, t, num);
      M(t, t, den);
      M(t, t, den);
      M(r[0], t, den);
      S(chk, r[0]);
      M(chk, chk, den);
      if (neq25519(chk, num))
        M(r[0], r[0], I);
      S(chk, r[0]);
      M(chk, chk, den);
      if (neq25519(chk, num))
        return -1;
      if (par25519(r[0]) === p[31] >> 7)
        Z(r[0], gf0, r[0]);
      M(r[3], r[0], r[1]);
      return 0;
    }
    function crypto_sign_open(m, sm, n, pk) {
      var i;
      var t = new Uint8Array(32), h = new Uint8Array(64);
      var p = [gf(), gf(), gf(), gf()], q = [gf(), gf(), gf(), gf()];
      if (n < 64)
        return -1;
      if (unpackneg(q, pk))
        return -1;
      for (i = 0;i < n; i++)
        m[i] = sm[i];
      for (i = 0;i < 32; i++)
        m[i + 32] = pk[i];
      crypto_hash(h, m, n);
      reduce(h);
      scalarmult(p, q, h);
      scalarbase(q, sm.subarray(32));
      add(p, q);
      pack(t, p);
      n -= 64;
      if (crypto_verify_32(sm, 0, t, 0)) {
        for (i = 0;i < n; i++)
          m[i] = 0;
        return -1;
      }
      for (i = 0;i < n; i++)
        m[i] = sm[i + 64];
      return n;
    }
    var crypto_secretbox_KEYBYTES = 32, crypto_secretbox_NONCEBYTES = 24, crypto_secretbox_ZEROBYTES = 32, crypto_secretbox_BOXZEROBYTES = 16, crypto_scalarmult_BYTES = 32, crypto_scalarmult_SCALARBYTES = 32, crypto_box_PUBLICKEYBYTES = 32, crypto_box_SECRETKEYBYTES = 32, crypto_box_BEFORENMBYTES = 32, crypto_box_NONCEBYTES = crypto_secretbox_NONCEBYTES, crypto_box_ZEROBYTES = crypto_secretbox_ZEROBYTES, crypto_box_BOXZEROBYTES = crypto_secretbox_BOXZEROBYTES, crypto_sign_BYTES = 64, crypto_sign_PUBLICKEYBYTES = 32, crypto_sign_SECRETKEYBYTES = 64, crypto_sign_SEEDBYTES = 32, crypto_hash_BYTES = 64;
    nacl.lowlevel = {
      crypto_core_hsalsa20,
      crypto_stream_xor,
      crypto_stream,
      crypto_stream_salsa20_xor,
      crypto_stream_salsa20,
      crypto_onetimeauth,
      crypto_onetimeauth_verify,
      crypto_verify_16,
      crypto_verify_32,
      crypto_secretbox,
      crypto_secretbox_open,
      crypto_scalarmult,
      crypto_scalarmult_base,
      crypto_box_beforenm,
      crypto_box_afternm,
      crypto_box,
      crypto_box_open,
      crypto_box_keypair,
      crypto_hash,
      crypto_sign,
      crypto_sign_keypair,
      crypto_sign_open,
      crypto_secretbox_KEYBYTES,
      crypto_secretbox_NONCEBYTES,
      crypto_secretbox_ZEROBYTES,
      crypto_secretbox_BOXZEROBYTES,
      crypto_scalarmult_BYTES,
      crypto_scalarmult_SCALARBYTES,
      crypto_box_PUBLICKEYBYTES,
      crypto_box_SECRETKEYBYTES,
      crypto_box_BEFORENMBYTES,
      crypto_box_NONCEBYTES,
      crypto_box_ZEROBYTES,
      crypto_box_BOXZEROBYTES,
      crypto_sign_BYTES,
      crypto_sign_PUBLICKEYBYTES,
      crypto_sign_SECRETKEYBYTES,
      crypto_sign_SEEDBYTES,
      crypto_hash_BYTES,
      gf,
      D,
      L,
      pack25519,
      unpack25519,
      M,
      A,
      S,
      Z,
      pow2523,
      add,
      set25519,
      modL,
      scalarmult,
      scalarbase
    };
    function checkLengths(k, n) {
      if (k.length !== crypto_secretbox_KEYBYTES)
        throw new Error("bad key size");
      if (n.length !== crypto_secretbox_NONCEBYTES)
        throw new Error("bad nonce size");
    }
    function checkBoxLengths(pk, sk) {
      if (pk.length !== crypto_box_PUBLICKEYBYTES)
        throw new Error("bad public key size");
      if (sk.length !== crypto_box_SECRETKEYBYTES)
        throw new Error("bad secret key size");
    }
    function checkArrayTypes() {
      for (var i = 0;i < arguments.length; i++) {
        if (!(arguments[i] instanceof Uint8Array))
          throw new TypeError("unexpected type, use Uint8Array");
      }
    }
    function cleanup(arr) {
      for (var i = 0;i < arr.length; i++)
        arr[i] = 0;
    }
    nacl.randomBytes = function(n) {
      var b = new Uint8Array(n);
      randombytes(b, n);
      return b;
    };
    nacl.secretbox = function(msg, nonce, key) {
      checkArrayTypes(msg, nonce, key);
      checkLengths(key, nonce);
      var m = new Uint8Array(crypto_secretbox_ZEROBYTES + msg.length);
      var c = new Uint8Array(m.length);
      for (var i = 0;i < msg.length; i++)
        m[i + crypto_secretbox_ZEROBYTES] = msg[i];
      crypto_secretbox(c, m, m.length, nonce, key);
      return c.subarray(crypto_secretbox_BOXZEROBYTES);
    };
    nacl.secretbox.open = function(box, nonce, key) {
      checkArrayTypes(box, nonce, key);
      checkLengths(key, nonce);
      var c = new Uint8Array(crypto_secretbox_BOXZEROBYTES + box.length);
      var m = new Uint8Array(c.length);
      for (var i = 0;i < box.length; i++)
        c[i + crypto_secretbox_BOXZEROBYTES] = box[i];
      if (c.length < 32)
        return null;
      if (crypto_secretbox_open(m, c, c.length, nonce, key) !== 0)
        return null;
      return m.subarray(crypto_secretbox_ZEROBYTES);
    };
    nacl.secretbox.keyLength = crypto_secretbox_KEYBYTES;
    nacl.secretbox.nonceLength = crypto_secretbox_NONCEBYTES;
    nacl.secretbox.overheadLength = crypto_secretbox_BOXZEROBYTES;
    nacl.scalarMult = function(n, p) {
      checkArrayTypes(n, p);
      if (n.length !== crypto_scalarmult_SCALARBYTES)
        throw new Error("bad n size");
      if (p.length !== crypto_scalarmult_BYTES)
        throw new Error("bad p size");
      var q = new Uint8Array(crypto_scalarmult_BYTES);
      crypto_scalarmult(q, n, p);
      return q;
    };
    nacl.scalarMult.base = function(n) {
      checkArrayTypes(n);
      if (n.length !== crypto_scalarmult_SCALARBYTES)
        throw new Error("bad n size");
      var q = new Uint8Array(crypto_scalarmult_BYTES);
      crypto_scalarmult_base(q, n);
      return q;
    };
    nacl.scalarMult.scalarLength = crypto_scalarmult_SCALARBYTES;
    nacl.scalarMult.groupElementLength = crypto_scalarmult_BYTES;
    nacl.box = function(msg, nonce, publicKey, secretKey) {
      var k = nacl.box.before(publicKey, secretKey);
      return nacl.secretbox(msg, nonce, k);
    };
    nacl.box.before = function(publicKey, secretKey) {
      checkArrayTypes(publicKey, secretKey);
      checkBoxLengths(publicKey, secretKey);
      var k = new Uint8Array(crypto_box_BEFORENMBYTES);
      crypto_box_beforenm(k, publicKey, secretKey);
      return k;
    };
    nacl.box.after = nacl.secretbox;
    nacl.box.open = function(msg, nonce, publicKey, secretKey) {
      var k = nacl.box.before(publicKey, secretKey);
      return nacl.secretbox.open(msg, nonce, k);
    };
    nacl.box.open.after = nacl.secretbox.open;
    nacl.box.keyPair = function() {
      var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
      var sk = new Uint8Array(crypto_box_SECRETKEYBYTES);
      crypto_box_keypair(pk, sk);
      return { publicKey: pk, secretKey: sk };
    };
    nacl.box.keyPair.fromSecretKey = function(secretKey) {
      checkArrayTypes(secretKey);
      if (secretKey.length !== crypto_box_SECRETKEYBYTES)
        throw new Error("bad secret key size");
      var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
      crypto_scalarmult_base(pk, secretKey);
      return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
    };
    nacl.box.publicKeyLength = crypto_box_PUBLICKEYBYTES;
    nacl.box.secretKeyLength = crypto_box_SECRETKEYBYTES;
    nacl.box.sharedKeyLength = crypto_box_BEFORENMBYTES;
    nacl.box.nonceLength = crypto_box_NONCEBYTES;
    nacl.box.overheadLength = nacl.secretbox.overheadLength;
    nacl.sign = function(msg, secretKey) {
      checkArrayTypes(msg, secretKey);
      if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
        throw new Error("bad secret key size");
      var signedMsg = new Uint8Array(crypto_sign_BYTES + msg.length);
      crypto_sign(signedMsg, msg, msg.length, secretKey);
      return signedMsg;
    };
    nacl.sign.open = function(signedMsg, publicKey) {
      checkArrayTypes(signedMsg, publicKey);
      if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
        throw new Error("bad public key size");
      var tmp = new Uint8Array(signedMsg.length);
      var mlen = crypto_sign_open(tmp, signedMsg, signedMsg.length, publicKey);
      if (mlen < 0)
        return null;
      var m = new Uint8Array(mlen);
      for (var i = 0;i < m.length; i++)
        m[i] = tmp[i];
      return m;
    };
    nacl.sign.detached = function(msg, secretKey) {
      var signedMsg = nacl.sign(msg, secretKey);
      var sig = new Uint8Array(crypto_sign_BYTES);
      for (var i = 0;i < sig.length; i++)
        sig[i] = signedMsg[i];
      return sig;
    };
    nacl.sign.detached.verify = function(msg, sig, publicKey) {
      checkArrayTypes(msg, sig, publicKey);
      if (sig.length !== crypto_sign_BYTES)
        throw new Error("bad signature size");
      if (publicKey.length !== crypto_sign_PUBLICKEYBYTES)
        throw new Error("bad public key size");
      var sm = new Uint8Array(crypto_sign_BYTES + msg.length);
      var m = new Uint8Array(crypto_sign_BYTES + msg.length);
      var i;
      for (i = 0;i < crypto_sign_BYTES; i++)
        sm[i] = sig[i];
      for (i = 0;i < msg.length; i++)
        sm[i + crypto_sign_BYTES] = msg[i];
      return crypto_sign_open(m, sm, sm.length, publicKey) >= 0;
    };
    nacl.sign.keyPair = function() {
      var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
      var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
      crypto_sign_keypair(pk, sk);
      return { publicKey: pk, secretKey: sk };
    };
    nacl.sign.keyPair.fromSecretKey = function(secretKey) {
      checkArrayTypes(secretKey);
      if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
        throw new Error("bad secret key size");
      var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
      for (var i = 0;i < pk.length; i++)
        pk[i] = secretKey[32 + i];
      return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
    };
    nacl.sign.keyPair.fromSeed = function(seed) {
      checkArrayTypes(seed);
      if (seed.length !== crypto_sign_SEEDBYTES)
        throw new Error("bad seed size");
      var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
      var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
      for (var i = 0;i < 32; i++)
        sk[i] = seed[i];
      crypto_sign_keypair(pk, sk, true);
      return { publicKey: pk, secretKey: sk };
    };
    nacl.sign.publicKeyLength = crypto_sign_PUBLICKEYBYTES;
    nacl.sign.secretKeyLength = crypto_sign_SECRETKEYBYTES;
    nacl.sign.seedLength = crypto_sign_SEEDBYTES;
    nacl.sign.signatureLength = crypto_sign_BYTES;
    nacl.hash = function(msg) {
      checkArrayTypes(msg);
      var h = new Uint8Array(crypto_hash_BYTES);
      crypto_hash(h, msg, msg.length);
      return h;
    };
    nacl.hash.hashLength = crypto_hash_BYTES;
    nacl.verify = function(x, y) {
      checkArrayTypes(x, y);
      if (x.length === 0 || y.length === 0)
        return false;
      if (x.length !== y.length)
        return false;
      return vn(x, 0, y, 0, x.length) === 0 ? true : false;
    };
    nacl.setPRNG = function(fn) {
      randombytes = fn;
    };
    (function() {
      var crypto2 = typeof self !== "undefined" ? self.crypto || self.msCrypto : null;
      if (crypto2 && crypto2.getRandomValues) {
        var QUOTA = 65536;
        nacl.setPRNG(function(x, n) {
          var i, v = new Uint8Array(n);
          for (i = 0;i < n; i += QUOTA) {
            crypto2.getRandomValues(v.subarray(i, i + Math.min(n - i, QUOTA)));
          }
          for (i = 0;i < n; i++)
            x[i] = v[i];
          cleanup(v);
        });
      } else if (true) {
        crypto2 = __require("crypto");
        if (crypto2 && crypto2.randomBytes) {
          nacl.setPRNG(function(x, n) {
            var i, v = crypto2.randomBytes(n);
            for (i = 0;i < n; i++)
              x[i] = v[i];
            cleanup(v);
          });
        }
      }
    })();
  })(typeof module !== "undefined" && exports ? exports : self.nacl = self.nacl || {});
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/internal/constants.js
var require_constants = __commonJS(function(exports, module) {
  var SEMVER_SPEC_VERSION = "2.0.0";
  var MAX_LENGTH = 256;
  var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || 9007199254740991;
  var MAX_SAFE_COMPONENT_LENGTH = 16;
  var MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6;
  var RELEASE_TYPES = [
    "major",
    "premajor",
    "minor",
    "preminor",
    "patch",
    "prepatch",
    "prerelease"
  ];
  module.exports = {
    MAX_LENGTH,
    MAX_SAFE_COMPONENT_LENGTH,
    MAX_SAFE_BUILD_LENGTH,
    MAX_SAFE_INTEGER,
    RELEASE_TYPES,
    SEMVER_SPEC_VERSION,
    FLAG_INCLUDE_PRERELEASE: 1,
    FLAG_LOOSE: 2
  };
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/internal/debug.js
var require_debug = __commonJS(function(exports, module) {
  var debug = typeof process === "object" && process.env && process.env.NODE_DEBUG && /\bsemver\b/i.test(process.env.NODE_DEBUG) ? (...args) => console.error("SEMVER", ...args) : () => {};
  module.exports = debug;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/internal/re.js
var require_re = __commonJS(function(exports, module) {
  var {
    MAX_SAFE_COMPONENT_LENGTH,
    MAX_SAFE_BUILD_LENGTH,
    MAX_LENGTH
  } = require_constants();
  var debug = require_debug();
  exports = module.exports = {};
  var re = exports.re = [];
  var safeRe = exports.safeRe = [];
  var src = exports.src = [];
  var safeSrc = exports.safeSrc = [];
  var t = exports.t = {};
  var R = 0;
  var LETTERDASHNUMBER = "[a-zA-Z0-9-]";
  var safeRegexReplacements = [
    ["\\s", 1],
    ["\\d", MAX_LENGTH],
    [LETTERDASHNUMBER, MAX_SAFE_BUILD_LENGTH]
  ];
  var makeSafeRegex = (value) => {
    for (const [token, max] of safeRegexReplacements) {
      value = value.split(`${token}*`).join(`${token}{0,${max}}`).split(`${token}+`).join(`${token}{1,${max}}`);
    }
    return value;
  };
  var createToken = (name, value, isGlobal) => {
    const safe = makeSafeRegex(value);
    const index = R++;
    debug(name, index, value);
    t[name] = index;
    src[index] = value;
    safeSrc[index] = safe;
    re[index] = new RegExp(value, isGlobal ? "g" : undefined);
    safeRe[index] = new RegExp(safe, isGlobal ? "g" : undefined);
  };
  createToken("NUMERICIDENTIFIER", "0|[1-9]\\d*");
  createToken("NUMERICIDENTIFIERLOOSE", "\\d+");
  createToken("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${LETTERDASHNUMBER}*`);
  createToken("MAINVERSION", `(${src[t.NUMERICIDENTIFIER]})\\.` + `(${src[t.NUMERICIDENTIFIER]})\\.` + `(${src[t.NUMERICIDENTIFIER]})`);
  createToken("MAINVERSIONLOOSE", `(${src[t.NUMERICIDENTIFIERLOOSE]})\\.` + `(${src[t.NUMERICIDENTIFIERLOOSE]})\\.` + `(${src[t.NUMERICIDENTIFIERLOOSE]})`);
  createToken("PRERELEASEIDENTIFIER", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIER]})`);
  createToken("PRERELEASEIDENTIFIERLOOSE", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIERLOOSE]})`);
  createToken("PRERELEASE", `(?:-(${src[t.PRERELEASEIDENTIFIER]}(?:\\.${src[t.PRERELEASEIDENTIFIER]})*))`);
  createToken("PRERELEASELOOSE", `(?:-?(${src[t.PRERELEASEIDENTIFIERLOOSE]}(?:\\.${src[t.PRERELEASEIDENTIFIERLOOSE]})*))`);
  createToken("BUILDIDENTIFIER", `${LETTERDASHNUMBER}+`);
  createToken("BUILD", `(?:\\+(${src[t.BUILDIDENTIFIER]}(?:\\.${src[t.BUILDIDENTIFIER]})*))`);
  createToken("FULLPLAIN", `v?${src[t.MAINVERSION]}${src[t.PRERELEASE]}?${src[t.BUILD]}?`);
  createToken("FULL", `^${src[t.FULLPLAIN]}$`);
  createToken("LOOSEPLAIN", `[v=\\s]*${src[t.MAINVERSIONLOOSE]}${src[t.PRERELEASELOOSE]}?${src[t.BUILD]}?`);
  createToken("LOOSE", `^${src[t.LOOSEPLAIN]}$`);
  createToken("GTLT", "((?:<|>)?=?)");
  createToken("XRANGEIDENTIFIERLOOSE", `${src[t.NUMERICIDENTIFIERLOOSE]}|x|X|\\*`);
  createToken("XRANGEIDENTIFIER", `${src[t.NUMERICIDENTIFIER]}|x|X|\\*`);
  createToken("XRANGEPLAIN", `[v=\\s]*(${src[t.XRANGEIDENTIFIER]})` + `(?:\\.(${src[t.XRANGEIDENTIFIER]})` + `(?:\\.(${src[t.XRANGEIDENTIFIER]})` + `(?:${src[t.PRERELEASE]})?${src[t.BUILD]}?` + `)?)?`);
  createToken("XRANGEPLAINLOOSE", `[v=\\s]*(${src[t.XRANGEIDENTIFIERLOOSE]})` + `(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})` + `(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})` + `(?:${src[t.PRERELEASELOOSE]})?${src[t.BUILD]}?` + `)?)?`);
  createToken("XRANGE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAIN]}$`);
  createToken("XRANGELOOSE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAINLOOSE]}$`);
  createToken("COERCEPLAIN", `${"(^|[^\\d])" + "(\\d{1,"}${MAX_SAFE_COMPONENT_LENGTH}})` + `(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?` + `(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?`);
  createToken("COERCE", `${src[t.COERCEPLAIN]}(?:$|[^\\d])`);
  createToken("COERCEFULL", src[t.COERCEPLAIN] + `(?:${src[t.PRERELEASE]})?` + `(?:${src[t.BUILD]})?` + `(?:$|[^\\d])`);
  createToken("COERCERTL", src[t.COERCE], true);
  createToken("COERCERTLFULL", src[t.COERCEFULL], true);
  createToken("LONETILDE", "(?:~>?)");
  createToken("TILDETRIM", `(\\s*)${src[t.LONETILDE]}\\s+`, true);
  exports.tildeTrimReplace = "$1~";
  createToken("TILDE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAIN]}$`);
  createToken("TILDELOOSE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAINLOOSE]}$`);
  createToken("LONECARET", "(?:\\^)");
  createToken("CARETTRIM", `(\\s*)${src[t.LONECARET]}\\s+`, true);
  exports.caretTrimReplace = "$1^";
  createToken("CARET", `^${src[t.LONECARET]}${src[t.XRANGEPLAIN]}$`);
  createToken("CARETLOOSE", `^${src[t.LONECARET]}${src[t.XRANGEPLAINLOOSE]}$`);
  createToken("COMPARATORLOOSE", `^${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]})$|^$`);
  createToken("COMPARATOR", `^${src[t.GTLT]}\\s*(${src[t.FULLPLAIN]})$|^$`);
  createToken("COMPARATORTRIM", `(\\s*)${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]}|${src[t.XRANGEPLAIN]})`, true);
  exports.comparatorTrimReplace = "$1$2$3";
  createToken("HYPHENRANGE", `^\\s*(${src[t.XRANGEPLAIN]})` + `\\s+-\\s+` + `(${src[t.XRANGEPLAIN]})` + `\\s*$`);
  createToken("HYPHENRANGELOOSE", `^\\s*(${src[t.XRANGEPLAINLOOSE]})` + `\\s+-\\s+` + `(${src[t.XRANGEPLAINLOOSE]})` + `\\s*$`);
  createToken("STAR", "(<|>)?=?\\s*\\*");
  createToken("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$");
  createToken("GTE0PRE", "^\\s*>=\\s*0\\.0\\.0-0\\s*$");
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/internal/parse-options.js
var require_parse_options = __commonJS(function(exports, module) {
  var looseOption = Object.freeze({ loose: true });
  var emptyOpts = Object.freeze({});
  var parseOptions = (options) => {
    if (!options) {
      return emptyOpts;
    }
    if (typeof options !== "object") {
      return looseOption;
    }
    return options;
  };
  module.exports = parseOptions;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/internal/identifiers.js
var require_identifiers = __commonJS(function(exports, module) {
  var numeric = /^[0-9]+$/;
  var compareIdentifiers = (a, b) => {
    if (typeof a === "number" && typeof b === "number") {
      return a === b ? 0 : a < b ? -1 : 1;
    }
    const anum = numeric.test(a);
    const bnum = numeric.test(b);
    if (anum && bnum) {
      a = +a;
      b = +b;
    }
    return a === b ? 0 : anum && !bnum ? -1 : bnum && !anum ? 1 : a < b ? -1 : 1;
  };
  var rcompareIdentifiers = (a, b) => compareIdentifiers(b, a);
  module.exports = {
    compareIdentifiers,
    rcompareIdentifiers
  };
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/classes/semver.js
var require_semver = __commonJS(function(exports, module) {
  var debug = require_debug();
  var { MAX_LENGTH, MAX_SAFE_INTEGER } = require_constants();
  var { safeRe: re, t } = require_re();
  var parseOptions = require_parse_options();
  var { compareIdentifiers } = require_identifiers();
  var isPrereleaseIdentifier = (prerelease, identifier) => {
    const identifiers = identifier.split(".");
    if (identifiers.length > prerelease.length) {
      return false;
    }
    for (let i = 0;i < identifiers.length; i++) {
      if (compareIdentifiers(prerelease[i], identifiers[i]) !== 0) {
        return false;
      }
    }
    return true;
  };

  class SemVer {
    constructor(version, options) {
      options = parseOptions(options);
      if (version instanceof SemVer) {
        if (version.loose === !!options.loose && version.includePrerelease === !!options.includePrerelease) {
          return version;
        } else {
          version = version.version;
        }
      } else if (typeof version !== "string") {
        throw new TypeError(`Invalid version. Must be a string. Got type "${typeof version}".`);
      }
      if (version.length > MAX_LENGTH) {
        throw new TypeError(`version is longer than ${MAX_LENGTH} characters`);
      }
      debug("SemVer", version, options);
      this.options = options;
      this.loose = !!options.loose;
      this.includePrerelease = !!options.includePrerelease;
      const m = version.trim().match(options.loose ? re[t.LOOSE] : re[t.FULL]);
      if (!m) {
        throw new TypeError(`Invalid Version: ${version}`);
      }
      this.raw = version;
      this.major = +m[1];
      this.minor = +m[2];
      this.patch = +m[3];
      if (this.major > MAX_SAFE_INTEGER || this.major < 0) {
        throw new TypeError("Invalid major version");
      }
      if (this.minor > MAX_SAFE_INTEGER || this.minor < 0) {
        throw new TypeError("Invalid minor version");
      }
      if (this.patch > MAX_SAFE_INTEGER || this.patch < 0) {
        throw new TypeError("Invalid patch version");
      }
      if (!m[4]) {
        this.prerelease = [];
      } else {
        this.prerelease = m[4].split(".").map((id) => {
          if (/^[0-9]+$/.test(id)) {
            const num = +id;
            if (num >= 0 && num < MAX_SAFE_INTEGER) {
              return num;
            }
          }
          return id;
        });
      }
      this.build = m[5] ? m[5].split(".") : [];
      this.format();
    }
    format() {
      this.version = `${this.major}.${this.minor}.${this.patch}`;
      if (this.prerelease.length) {
        this.version += `-${this.prerelease.join(".")}`;
      }
      return this.version;
    }
    toString() {
      return this.version;
    }
    compare(other) {
      debug("SemVer.compare", this.version, this.options, other);
      if (!(other instanceof SemVer)) {
        if (typeof other === "string" && other === this.version) {
          return 0;
        }
        other = new SemVer(other, this.options);
      }
      if (other.version === this.version) {
        return 0;
      }
      return this.compareMain(other) || this.comparePre(other);
    }
    compareMain(other) {
      if (!(other instanceof SemVer)) {
        other = new SemVer(other, this.options);
      }
      if (this.major < other.major) {
        return -1;
      }
      if (this.major > other.major) {
        return 1;
      }
      if (this.minor < other.minor) {
        return -1;
      }
      if (this.minor > other.minor) {
        return 1;
      }
      if (this.patch < other.patch) {
        return -1;
      }
      if (this.patch > other.patch) {
        return 1;
      }
      return 0;
    }
    comparePre(other) {
      if (!(other instanceof SemVer)) {
        other = new SemVer(other, this.options);
      }
      if (this.prerelease.length && !other.prerelease.length) {
        return -1;
      } else if (!this.prerelease.length && other.prerelease.length) {
        return 1;
      } else if (!this.prerelease.length && !other.prerelease.length) {
        return 0;
      }
      let i = 0;
      do {
        const a = this.prerelease[i];
        const b = other.prerelease[i];
        debug("prerelease compare", i, a, b);
        if (a === undefined && b === undefined) {
          return 0;
        } else if (b === undefined) {
          return 1;
        } else if (a === undefined) {
          return -1;
        } else if (a === b) {
          continue;
        } else {
          return compareIdentifiers(a, b);
        }
      } while (++i);
    }
    compareBuild(other) {
      if (!(other instanceof SemVer)) {
        other = new SemVer(other, this.options);
      }
      let i = 0;
      do {
        const a = this.build[i];
        const b = other.build[i];
        debug("build compare", i, a, b);
        if (a === undefined && b === undefined) {
          return 0;
        } else if (b === undefined) {
          return 1;
        } else if (a === undefined) {
          return -1;
        } else if (a === b) {
          continue;
        } else {
          return compareIdentifiers(a, b);
        }
      } while (++i);
    }
    inc(release, identifier, identifierBase) {
      if (release.startsWith("pre")) {
        if (!identifier && identifierBase === false) {
          throw new Error("invalid increment argument: identifier is empty");
        }
        if (identifier) {
          const match = `-${identifier}`.match(this.options.loose ? re[t.PRERELEASELOOSE] : re[t.PRERELEASE]);
          if (!match || match[1] !== identifier) {
            throw new Error(`invalid identifier: ${identifier}`);
          }
        }
      }
      switch (release) {
        case "premajor":
          this.prerelease.length = 0;
          this.patch = 0;
          this.minor = 0;
          this.major++;
          this.inc("pre", identifier, identifierBase);
          break;
        case "preminor":
          this.prerelease.length = 0;
          this.patch = 0;
          this.minor++;
          this.inc("pre", identifier, identifierBase);
          break;
        case "prepatch":
          this.prerelease.length = 0;
          this.inc("patch", identifier, identifierBase);
          this.inc("pre", identifier, identifierBase);
          break;
        case "prerelease":
          if (this.prerelease.length === 0) {
            this.inc("patch", identifier, identifierBase);
          }
          this.inc("pre", identifier, identifierBase);
          break;
        case "release":
          if (this.prerelease.length === 0) {
            throw new Error(`version ${this.raw} is not a prerelease`);
          }
          this.prerelease.length = 0;
          break;
        case "major":
          if (this.minor !== 0 || this.patch !== 0 || this.prerelease.length === 0) {
            this.major++;
          }
          this.minor = 0;
          this.patch = 0;
          this.prerelease = [];
          break;
        case "minor":
          if (this.patch !== 0 || this.prerelease.length === 0) {
            this.minor++;
          }
          this.patch = 0;
          this.prerelease = [];
          break;
        case "patch":
          if (this.prerelease.length === 0) {
            this.patch++;
          }
          this.prerelease = [];
          break;
        case "pre": {
          const base = Number(identifierBase) ? 1 : 0;
          if (this.prerelease.length === 0) {
            this.prerelease = [base];
          } else {
            let i = this.prerelease.length;
            while (--i >= 0) {
              if (typeof this.prerelease[i] === "number") {
                this.prerelease[i]++;
                i = -2;
              }
            }
            if (i === -1) {
              if (identifier === this.prerelease.join(".") && identifierBase === false) {
                throw new Error("invalid increment argument: identifier already exists");
              }
              this.prerelease.push(base);
            }
          }
          if (identifier) {
            let prerelease = [identifier, base];
            if (identifierBase === false) {
              prerelease = [identifier];
            }
            if (isPrereleaseIdentifier(this.prerelease, identifier)) {
              const prereleaseBase = this.prerelease[identifier.split(".").length];
              if (isNaN(prereleaseBase)) {
                this.prerelease = prerelease;
              }
            } else {
              this.prerelease = prerelease;
            }
          }
          break;
        }
        default:
          throw new Error(`invalid increment argument: ${release}`);
      }
      this.raw = this.format();
      if (this.build.length) {
        this.raw += `+${this.build.join(".")}`;
      }
      return this;
    }
  }
  module.exports = SemVer;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/parse.js
var require_parse = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var parse = (version, options, throwErrors = false) => {
    if (version instanceof SemVer) {
      return version;
    }
    try {
      return new SemVer(version, options);
    } catch (er) {
      if (!throwErrors) {
        return null;
      }
      throw er;
    }
  };
  module.exports = parse;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/valid.js
var require_valid = __commonJS(function(exports, module) {
  var parse = require_parse();
  var valid = (version, options) => {
    const v = parse(version, options);
    return v ? v.version : null;
  };
  module.exports = valid;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/clean.js
var require_clean = __commonJS(function(exports, module) {
  var parse = require_parse();
  var clean = (version, options) => {
    const s = parse(version.trim().replace(/^[=v]+/, ""), options);
    return s ? s.version : null;
  };
  module.exports = clean;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/inc.js
var require_inc = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var inc = (version, release, options, identifier, identifierBase) => {
    if (typeof options === "string") {
      identifierBase = identifier;
      identifier = options;
      options = undefined;
    }
    try {
      return new SemVer(version instanceof SemVer ? version.version : version, options).inc(release, identifier, identifierBase).version;
    } catch (er) {
      return null;
    }
  };
  module.exports = inc;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/diff.js
var require_diff = __commonJS(function(exports, module) {
  var parse = require_parse();
  var diff = (version1, version2) => {
    const v1 = parse(version1, null, true);
    const v2 = parse(version2, null, true);
    const comparison = v1.compare(v2);
    if (comparison === 0) {
      return null;
    }
    const v1Higher = comparison > 0;
    const highVersion = v1Higher ? v1 : v2;
    const lowVersion = v1Higher ? v2 : v1;
    const highHasPre = !!highVersion.prerelease.length;
    const lowHasPre = !!lowVersion.prerelease.length;
    if (lowHasPre && !highHasPre) {
      if (!lowVersion.patch && !lowVersion.minor) {
        return "major";
      }
      if (lowVersion.compareMain(highVersion) === 0) {
        if (lowVersion.minor && !lowVersion.patch) {
          return "minor";
        }
        return "patch";
      }
    }
    const prefix = highHasPre ? "pre" : "";
    if (v1.major !== v2.major) {
      return prefix + "major";
    }
    if (v1.minor !== v2.minor) {
      return prefix + "minor";
    }
    if (v1.patch !== v2.patch) {
      return prefix + "patch";
    }
    return "prerelease";
  };
  module.exports = diff;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/major.js
var require_major = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var major = (a, loose) => new SemVer(a, loose).major;
  module.exports = major;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/minor.js
var require_minor = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var minor = (a, loose) => new SemVer(a, loose).minor;
  module.exports = minor;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/patch.js
var require_patch = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var patch = (a, loose) => new SemVer(a, loose).patch;
  module.exports = patch;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/prerelease.js
var require_prerelease = __commonJS(function(exports, module) {
  var parse = require_parse();
  var prerelease = (version, options) => {
    const parsed = parse(version, options);
    return parsed && parsed.prerelease.length ? parsed.prerelease : null;
  };
  module.exports = prerelease;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/compare.js
var require_compare = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var compare = (a, b, loose) => new SemVer(a, loose).compare(new SemVer(b, loose));
  module.exports = compare;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/rcompare.js
var require_rcompare = __commonJS(function(exports, module) {
  var compare = require_compare();
  var rcompare = (a, b, loose) => compare(b, a, loose);
  module.exports = rcompare;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/compare-loose.js
var require_compare_loose = __commonJS(function(exports, module) {
  var compare = require_compare();
  var compareLoose = (a, b) => compare(a, b, true);
  module.exports = compareLoose;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/compare-build.js
var require_compare_build = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var compareBuild = (a, b, loose) => {
    const versionA = new SemVer(a, loose);
    const versionB = new SemVer(b, loose);
    return versionA.compare(versionB) || versionA.compareBuild(versionB);
  };
  module.exports = compareBuild;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/sort.js
var require_sort = __commonJS(function(exports, module) {
  var compareBuild = require_compare_build();
  var sort = (list, loose) => list.sort((a, b) => compareBuild(a, b, loose));
  module.exports = sort;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/rsort.js
var require_rsort = __commonJS(function(exports, module) {
  var compareBuild = require_compare_build();
  var rsort = (list, loose) => list.sort((a, b) => compareBuild(b, a, loose));
  module.exports = rsort;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/gt.js
var require_gt = __commonJS(function(exports, module) {
  var compare = require_compare();
  var gt = (a, b, loose) => compare(a, b, loose) > 0;
  module.exports = gt;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/lt.js
var require_lt = __commonJS(function(exports, module) {
  var compare = require_compare();
  var lt = (a, b, loose) => compare(a, b, loose) < 0;
  module.exports = lt;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/eq.js
var require_eq = __commonJS(function(exports, module) {
  var compare = require_compare();
  var eq = (a, b, loose) => compare(a, b, loose) === 0;
  module.exports = eq;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/neq.js
var require_neq = __commonJS(function(exports, module) {
  var compare = require_compare();
  var neq = (a, b, loose) => compare(a, b, loose) !== 0;
  module.exports = neq;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/gte.js
var require_gte = __commonJS(function(exports, module) {
  var compare = require_compare();
  var gte = (a, b, loose) => compare(a, b, loose) >= 0;
  module.exports = gte;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/lte.js
var require_lte = __commonJS(function(exports, module) {
  var compare = require_compare();
  var lte = (a, b, loose) => compare(a, b, loose) <= 0;
  module.exports = lte;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/cmp.js
var require_cmp = __commonJS(function(exports, module) {
  var eq = require_eq();
  var neq = require_neq();
  var gt = require_gt();
  var gte = require_gte();
  var lt = require_lt();
  var lte = require_lte();
  var cmp = (a, op, b, loose) => {
    switch (op) {
      case "===":
        if (typeof a === "object") {
          a = a.version;
        }
        if (typeof b === "object") {
          b = b.version;
        }
        return a === b;
      case "!==":
        if (typeof a === "object") {
          a = a.version;
        }
        if (typeof b === "object") {
          b = b.version;
        }
        return a !== b;
      case "":
      case "=":
      case "==":
        return eq(a, b, loose);
      case "!=":
        return neq(a, b, loose);
      case ">":
        return gt(a, b, loose);
      case ">=":
        return gte(a, b, loose);
      case "<":
        return lt(a, b, loose);
      case "<=":
        return lte(a, b, loose);
      default:
        throw new TypeError(`Invalid operator: ${op}`);
    }
  };
  module.exports = cmp;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/coerce.js
var require_coerce = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var parse = require_parse();
  var { safeRe: re, t } = require_re();
  var coerce = (version, options) => {
    if (version instanceof SemVer) {
      return version;
    }
    if (typeof version === "number") {
      version = String(version);
    }
    if (typeof version !== "string") {
      return null;
    }
    options = options || {};
    let match = null;
    if (!options.rtl) {
      match = version.match(options.includePrerelease ? re[t.COERCEFULL] : re[t.COERCE]);
    } else {
      const coerceRtlRegex = options.includePrerelease ? re[t.COERCERTLFULL] : re[t.COERCERTL];
      let next;
      while ((next = coerceRtlRegex.exec(version)) && (!match || match.index + match[0].length !== version.length)) {
        if (!match || next.index + next[0].length !== match.index + match[0].length) {
          match = next;
        }
        coerceRtlRegex.lastIndex = next.index + next[1].length + next[2].length;
      }
      coerceRtlRegex.lastIndex = -1;
    }
    if (match === null) {
      return null;
    }
    const major = match[2];
    const minor = match[3] || "0";
    const patch = match[4] || "0";
    const prerelease = options.includePrerelease && match[5] ? `-${match[5]}` : "";
    const build = options.includePrerelease && match[6] ? `+${match[6]}` : "";
    return parse(`${major}.${minor}.${patch}${prerelease}${build}`, options);
  };
  module.exports = coerce;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/truncate.js
var require_truncate = __commonJS(function(exports, module) {
  var parse = require_parse();
  var constants = require_constants();
  var SemVer = require_semver();
  var truncate = (version, truncation, options) => {
    if (!constants.RELEASE_TYPES.includes(truncation)) {
      return null;
    }
    const clonedVersion = cloneInputVersion(version, options);
    return clonedVersion && doTruncation(clonedVersion, truncation);
  };
  var cloneInputVersion = (version, options) => {
    const versionStringToParse = version instanceof SemVer ? version.version : version;
    return parse(versionStringToParse, options);
  };
  var doTruncation = (version, truncation) => {
    if (isPrerelease(truncation)) {
      return version.version;
    }
    version.prerelease = [];
    switch (truncation) {
      case "major":
        version.minor = 0;
        version.patch = 0;
        break;
      case "minor":
        version.patch = 0;
        break;
    }
    return version.format();
  };
  var isPrerelease = (type) => {
    return type.startsWith("pre");
  };
  module.exports = truncate;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/internal/lrucache.js
var require_lrucache = __commonJS(function(exports, module) {
  class LRUCache {
    constructor() {
      this.max = 1000;
      this.map = new Map;
    }
    get(key) {
      const value = this.map.get(key);
      if (value === undefined) {
        return;
      } else {
        this.map.delete(key);
        this.map.set(key, value);
        return value;
      }
    }
    delete(key) {
      return this.map.delete(key);
    }
    set(key, value) {
      const deleted = this.delete(key);
      if (!deleted && value !== undefined) {
        if (this.map.size >= this.max) {
          const firstKey = this.map.keys().next().value;
          this.delete(firstKey);
        }
        this.map.set(key, value);
      }
      return this;
    }
  }
  module.exports = LRUCache;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/classes/range.js
var require_range = __commonJS(function(exports, module) {
  var SPACE_CHARACTERS = /\s+/g;

  class Range {
    constructor(range, options) {
      options = parseOptions(options);
      if (range instanceof Range) {
        if (range.loose === !!options.loose && range.includePrerelease === !!options.includePrerelease) {
          return range;
        } else {
          return new Range(range.raw, options);
        }
      }
      if (range instanceof Comparator) {
        this.raw = range.value;
        this.set = [[range]];
        this.formatted = undefined;
        return this;
      }
      this.options = options;
      this.loose = !!options.loose;
      this.includePrerelease = !!options.includePrerelease;
      this.raw = range.trim().replace(SPACE_CHARACTERS, " ");
      this.set = this.raw.split("||").map((r) => this.parseRange(r.trim())).filter((c) => c.length);
      if (!this.set.length) {
        throw new TypeError(`Invalid SemVer Range: ${this.raw}`);
      }
      if (this.set.length > 1) {
        const first = this.set[0];
        this.set = this.set.filter((c) => !isNullSet(c[0]));
        if (this.set.length === 0) {
          this.set = [first];
        } else if (this.set.length > 1) {
          for (const c of this.set) {
            if (c.length === 1 && isAny(c[0])) {
              this.set = [c];
              break;
            }
          }
        }
      }
      this.formatted = undefined;
    }
    get range() {
      if (this.formatted === undefined) {
        this.formatted = "";
        for (let i = 0;i < this.set.length; i++) {
          if (i > 0) {
            this.formatted += "||";
          }
          const comps = this.set[i];
          for (let k = 0;k < comps.length; k++) {
            if (k > 0) {
              this.formatted += " ";
            }
            this.formatted += comps[k].toString().trim();
          }
        }
      }
      return this.formatted;
    }
    format() {
      return this.range;
    }
    toString() {
      return this.range;
    }
    parseRange(range) {
      range = range.replace(BUILDSTRIPRE, "");
      const memoOpts = (this.options.includePrerelease && FLAG_INCLUDE_PRERELEASE) | (this.options.loose && FLAG_LOOSE);
      const memoKey = memoOpts + ":" + range;
      const cached = cache.get(memoKey);
      if (cached) {
        return cached;
      }
      const loose = this.options.loose;
      const hr = loose ? re[t.HYPHENRANGELOOSE] : re[t.HYPHENRANGE];
      range = range.replace(hr, hyphenReplace(this.options.includePrerelease));
      debug("hyphen replace", range);
      range = range.replace(re[t.COMPARATORTRIM], comparatorTrimReplace);
      debug("comparator trim", range);
      range = range.replace(re[t.TILDETRIM], tildeTrimReplace);
      debug("tilde trim", range);
      range = range.replace(re[t.CARETTRIM], caretTrimReplace);
      debug("caret trim", range);
      let rangeList = range.split(" ").map((comp) => parseComparator(comp, this.options)).join(" ").split(/\s+/).map((comp) => replaceGTE0(comp, this.options));
      if (loose) {
        rangeList = rangeList.filter((comp) => {
          debug("loose invalid filter", comp, this.options);
          return !!comp.match(re[t.COMPARATORLOOSE]);
        });
      }
      debug("range list", rangeList);
      const rangeMap = new Map;
      const comparators = rangeList.map((comp) => new Comparator(comp, this.options));
      for (const comp of comparators) {
        if (isNullSet(comp)) {
          return [comp];
        }
        rangeMap.set(comp.value, comp);
      }
      if (rangeMap.size > 1 && rangeMap.has("")) {
        rangeMap.delete("");
      }
      const result = [...rangeMap.values()];
      cache.set(memoKey, result);
      return result;
    }
    intersects(range, options) {
      if (!(range instanceof Range)) {
        throw new TypeError("a Range is required");
      }
      return this.set.some((thisComparators) => {
        return isSatisfiable(thisComparators, options) && range.set.some((rangeComparators) => {
          return isSatisfiable(rangeComparators, options) && thisComparators.every((thisComparator) => {
            return rangeComparators.every((rangeComparator) => {
              return thisComparator.intersects(rangeComparator, options);
            });
          });
        });
      });
    }
    test(version) {
      if (!version) {
        return false;
      }
      if (typeof version === "string") {
        try {
          version = new SemVer(version, this.options);
        } catch (er) {
          return false;
        }
      }
      for (let i = 0;i < this.set.length; i++) {
        if (testSet(this.set[i], version, this.options)) {
          return true;
        }
      }
      return false;
    }
  }
  module.exports = Range;
  var LRU = require_lrucache();
  var cache = new LRU;
  var parseOptions = require_parse_options();
  var Comparator = require_comparator();
  var debug = require_debug();
  var SemVer = require_semver();
  var {
    safeRe: re,
    src,
    t,
    comparatorTrimReplace,
    tildeTrimReplace,
    caretTrimReplace
  } = require_re();
  var { FLAG_INCLUDE_PRERELEASE, FLAG_LOOSE } = require_constants();
  var BUILDSTRIPRE = new RegExp(src[t.BUILD], "g");
  var isNullSet = (c) => c.value === "<0.0.0-0";
  var isAny = (c) => c.value === "";
  var isSatisfiable = (comparators, options) => {
    let result = true;
    const remainingComparators = comparators.slice();
    let testComparator = remainingComparators.pop();
    while (result && remainingComparators.length) {
      result = remainingComparators.every((otherComparator) => {
        return testComparator.intersects(otherComparator, options);
      });
      testComparator = remainingComparators.pop();
    }
    return result;
  };
  var parseComparator = (comp, options) => {
    comp = comp.replace(re[t.BUILD], "");
    debug("comp", comp, options);
    comp = replaceCarets(comp, options);
    debug("caret", comp);
    comp = replaceTildes(comp, options);
    debug("tildes", comp);
    comp = replaceXRanges(comp, options);
    debug("xrange", comp);
    comp = replaceStars(comp, options);
    debug("stars", comp);
    return comp;
  };
  var isX = (id) => !id || id.toLowerCase() === "x" || id === "*";
  var invalidXRangeOrder = (M, m, p) => isX(M) && !isX(m) || isX(m) && p && !isX(p);
  var replaceTildes = (comp, options) => {
    return comp.trim().split(/\s+/).map((c) => replaceTilde(c, options)).join(" ");
  };
  var replaceTilde = (comp, options) => {
    const r = options.loose ? re[t.TILDELOOSE] : re[t.TILDE];
    const z = options.includePrerelease ? "-0" : "";
    return comp.replace(r, (_, M, m, p, pr) => {
      debug("tilde", comp, _, M, m, p, pr);
      let ret;
      if (isX(M)) {
        ret = "";
      } else if (isX(m)) {
        ret = `>=${M}.0.0${z} <${+M + 1}.0.0-0`;
      } else if (isX(p)) {
        ret = `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`;
      } else if (pr) {
        debug("replaceTilde pr", pr);
        ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
      } else {
        ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
      }
      debug("tilde return", ret);
      return ret;
    });
  };
  var replaceCarets = (comp, options) => {
    return comp.trim().split(/\s+/).map((c) => replaceCaret(c, options)).join(" ");
  };
  var replaceCaret = (comp, options) => {
    debug("caret", comp, options);
    const r = options.loose ? re[t.CARETLOOSE] : re[t.CARET];
    const z = options.includePrerelease ? "-0" : "";
    return comp.replace(r, (_, M, m, p, pr) => {
      debug("caret", comp, _, M, m, p, pr);
      let ret;
      if (isX(M)) {
        ret = "";
      } else if (isX(m)) {
        ret = `>=${M}.0.0${z} <${+M + 1}.0.0-0`;
      } else if (isX(p)) {
        if (M === "0") {
          ret = `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`;
        } else {
          ret = `>=${M}.${m}.0${z} <${+M + 1}.0.0-0`;
        }
      } else if (pr) {
        debug("replaceCaret pr", pr);
        if (M === "0") {
          if (m === "0") {
            ret = `>=${M}.${m}.${p}-${pr} <${M}.${m}.${+p + 1}-0`;
          } else {
            ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
          }
        } else {
          ret = `>=${M}.${m}.${p}-${pr} <${+M + 1}.0.0-0`;
        }
      } else {
        debug("no pr");
        if (M === "0") {
          if (m === "0") {
            ret = `>=${M}.${m}.${p} <${M}.${m}.${+p + 1}-0`;
          } else {
            ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
          }
        } else {
          ret = `>=${M}.${m}.${p} <${+M + 1}.0.0-0`;
        }
      }
      debug("caret return", ret);
      return ret;
    });
  };
  var replaceXRanges = (comp, options) => {
    debug("replaceXRanges", comp, options);
    return comp.split(/\s+/).map((c) => replaceXRange(c, options)).join(" ");
  };
  var replaceXRange = (comp, options) => {
    comp = comp.trim();
    const r = options.loose ? re[t.XRANGELOOSE] : re[t.XRANGE];
    return comp.replace(r, (ret, gtlt, M, m, p, pr) => {
      debug("xRange", comp, ret, gtlt, M, m, p, pr);
      if (invalidXRangeOrder(M, m, p)) {
        return comp;
      }
      const xM = isX(M);
      const xm = xM || isX(m);
      const xp = xm || isX(p);
      const anyX = xp;
      if (gtlt === "=" && anyX) {
        gtlt = "";
      }
      pr = options.includePrerelease ? "-0" : "";
      if (xM) {
        if (gtlt === ">" || gtlt === "<") {
          ret = "<0.0.0-0";
        } else {
          ret = "*";
        }
      } else if (gtlt && anyX) {
        if (xm) {
          m = 0;
        }
        p = 0;
        if (gtlt === ">") {
          gtlt = ">=";
          if (xm) {
            M = +M + 1;
            m = 0;
            p = 0;
          } else {
            m = +m + 1;
            p = 0;
          }
        } else if (gtlt === "<=") {
          gtlt = "<";
          if (xm) {
            M = +M + 1;
          } else {
            m = +m + 1;
          }
        }
        if (gtlt === "<") {
          pr = "-0";
        }
        ret = `${gtlt + M}.${m}.${p}${pr}`;
      } else if (xm) {
        ret = `>=${M}.0.0${pr} <${+M + 1}.0.0-0`;
      } else if (xp) {
        ret = `>=${M}.${m}.0${pr} <${M}.${+m + 1}.0-0`;
      }
      debug("xRange return", ret);
      return ret;
    });
  };
  var replaceStars = (comp, options) => {
    debug("replaceStars", comp, options);
    return comp.trim().replace(re[t.STAR], "");
  };
  var replaceGTE0 = (comp, options) => {
    debug("replaceGTE0", comp, options);
    return comp.trim().replace(re[options.includePrerelease ? t.GTE0PRE : t.GTE0], "");
  };
  var hyphenReplace = (incPr) => ($0, from, fM, fm, fp, fpr, fb, to, tM, tm, tp, tpr) => {
    if (isX(fM)) {
      from = "";
    } else if (isX(fm)) {
      from = `>=${fM}.0.0${incPr ? "-0" : ""}`;
    } else if (isX(fp)) {
      from = `>=${fM}.${fm}.0${incPr ? "-0" : ""}`;
    } else if (fpr) {
      from = `>=${from}`;
    } else {
      from = `>=${from}${incPr ? "-0" : ""}`;
    }
    if (isX(tM)) {
      to = "";
    } else if (isX(tm)) {
      to = `<${+tM + 1}.0.0-0`;
    } else if (isX(tp)) {
      to = `<${tM}.${+tm + 1}.0-0`;
    } else if (tpr) {
      to = `<=${tM}.${tm}.${tp}-${tpr}`;
    } else if (incPr) {
      to = `<${tM}.${tm}.${+tp + 1}-0`;
    } else {
      to = `<=${to}`;
    }
    return `${from} ${to}`.trim();
  };
  var testSet = (set, version, options) => {
    for (let i = 0;i < set.length; i++) {
      if (!set[i].test(version)) {
        return false;
      }
    }
    if (version.prerelease.length && !options.includePrerelease) {
      for (let i = 0;i < set.length; i++) {
        debug(set[i].semver);
        if (set[i].semver === Comparator.ANY) {
          continue;
        }
        if (set[i].semver.prerelease.length > 0) {
          const allowed = set[i].semver;
          if (allowed.major === version.major && allowed.minor === version.minor && allowed.patch === version.patch) {
            return true;
          }
        }
      }
      return false;
    }
    return true;
  };
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/classes/comparator.js
var require_comparator = __commonJS(function(exports, module) {
  var ANY = Symbol("SemVer ANY");

  class Comparator {
    static get ANY() {
      return ANY;
    }
    constructor(comp, options) {
      options = parseOptions(options);
      if (comp instanceof Comparator) {
        if (comp.loose === !!options.loose) {
          return comp;
        } else {
          comp = comp.value;
        }
      }
      comp = comp.trim().split(/\s+/).join(" ");
      debug("comparator", comp, options);
      this.options = options;
      this.loose = !!options.loose;
      this.parse(comp);
      if (this.semver === ANY) {
        this.value = "";
      } else {
        this.value = this.operator + this.semver.version;
      }
      debug("comp", this);
    }
    parse(comp) {
      const r = this.options.loose ? re[t.COMPARATORLOOSE] : re[t.COMPARATOR];
      const m = comp.match(r);
      if (!m) {
        throw new TypeError(`Invalid comparator: ${comp}`);
      }
      this.operator = m[1] !== undefined ? m[1] : "";
      if (this.operator === "=") {
        this.operator = "";
      }
      if (!m[2]) {
        this.semver = ANY;
      } else {
        this.semver = new SemVer(m[2], this.options.loose);
      }
    }
    toString() {
      return this.value;
    }
    test(version) {
      debug("Comparator.test", version, this.options.loose);
      if (this.semver === ANY || version === ANY) {
        return true;
      }
      if (typeof version === "string") {
        try {
          version = new SemVer(version, this.options);
        } catch (er) {
          return false;
        }
      }
      return cmp(version, this.operator, this.semver, this.options);
    }
    intersects(comp, options) {
      if (!(comp instanceof Comparator)) {
        throw new TypeError("a Comparator is required");
      }
      if (this.operator === "") {
        if (this.value === "") {
          return true;
        }
        return new Range(comp.value, options).test(this.value);
      } else if (comp.operator === "") {
        if (comp.value === "") {
          return true;
        }
        return new Range(this.value, options).test(comp.semver);
      }
      options = parseOptions(options);
      if (options.includePrerelease && (this.value === "<0.0.0-0" || comp.value === "<0.0.0-0")) {
        return false;
      }
      if (!options.includePrerelease && (this.value.startsWith("<0.0.0") || comp.value.startsWith("<0.0.0"))) {
        return false;
      }
      if (this.operator.startsWith(">") && comp.operator.startsWith(">")) {
        return true;
      }
      if (this.operator.startsWith("<") && comp.operator.startsWith("<")) {
        return true;
      }
      if (this.semver.version === comp.semver.version && this.operator.includes("=") && comp.operator.includes("=")) {
        return true;
      }
      if (cmp(this.semver, "<", comp.semver, options) && this.operator.startsWith(">") && comp.operator.startsWith("<")) {
        return true;
      }
      if (cmp(this.semver, ">", comp.semver, options) && this.operator.startsWith("<") && comp.operator.startsWith(">")) {
        return true;
      }
      return false;
    }
  }
  module.exports = Comparator;
  var parseOptions = require_parse_options();
  var { safeRe: re, t } = require_re();
  var cmp = require_cmp();
  var debug = require_debug();
  var SemVer = require_semver();
  var Range = require_range();
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/functions/satisfies.js
var require_satisfies = __commonJS(function(exports, module) {
  var Range = require_range();
  var satisfies = (version, range, options) => {
    try {
      range = new Range(range, options);
    } catch (er) {
      return false;
    }
    return range.test(version);
  };
  module.exports = satisfies;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/to-comparators.js
var require_to_comparators = __commonJS(function(exports, module) {
  var Range = require_range();
  var toComparators = (range, options) => new Range(range, options).set.map((comp) => comp.map((c) => c.value).join(" ").trim().split(" "));
  module.exports = toComparators;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/max-satisfying.js
var require_max_satisfying = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var Range = require_range();
  var maxSatisfying = (versions, range, options) => {
    let max = null;
    let maxSV = null;
    let rangeObj = null;
    try {
      rangeObj = new Range(range, options);
    } catch (er) {
      return null;
    }
    versions.forEach((v) => {
      if (rangeObj.test(v)) {
        if (!max || maxSV.compare(v) === -1) {
          max = v;
          maxSV = new SemVer(max, options);
        }
      }
    });
    return max;
  };
  module.exports = maxSatisfying;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/min-satisfying.js
var require_min_satisfying = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var Range = require_range();
  var minSatisfying = (versions, range, options) => {
    let min = null;
    let minSV = null;
    let rangeObj = null;
    try {
      rangeObj = new Range(range, options);
    } catch (er) {
      return null;
    }
    versions.forEach((v) => {
      if (rangeObj.test(v)) {
        if (!min || minSV.compare(v) === 1) {
          min = v;
          minSV = new SemVer(min, options);
        }
      }
    });
    return min;
  };
  module.exports = minSatisfying;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/min-version.js
var require_min_version = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var Range = require_range();
  var gt = require_gt();
  var minVersion = (range, loose) => {
    range = new Range(range, loose);
    let minver = new SemVer("0.0.0");
    if (range.test(minver)) {
      return minver;
    }
    minver = new SemVer("0.0.0-0");
    if (range.test(minver)) {
      return minver;
    }
    minver = null;
    for (let i = 0;i < range.set.length; ++i) {
      const comparators = range.set[i];
      let setMin = null;
      comparators.forEach((comparator) => {
        const compver = new SemVer(comparator.semver.version);
        switch (comparator.operator) {
          case ">":
            if (compver.prerelease.length === 0) {
              compver.patch++;
            } else {
              compver.prerelease.push(0);
            }
            compver.raw = compver.format();
          case "":
          case ">=":
            if (!setMin || gt(compver, setMin)) {
              setMin = compver;
            }
            break;
          case "<":
          case "<=":
            break;
          default:
            throw new Error(`Unexpected operation: ${comparator.operator}`);
        }
      });
      if (setMin && (!minver || gt(minver, setMin))) {
        minver = setMin;
      }
    }
    if (minver && range.test(minver)) {
      return minver;
    }
    return null;
  };
  module.exports = minVersion;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/valid.js
var require_valid2 = __commonJS(function(exports, module) {
  var Range = require_range();
  var validRange = (range, options) => {
    try {
      return new Range(range, options).range || "*";
    } catch (er) {
      return null;
    }
  };
  module.exports = validRange;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/outside.js
var require_outside = __commonJS(function(exports, module) {
  var SemVer = require_semver();
  var Comparator = require_comparator();
  var { ANY } = Comparator;
  var Range = require_range();
  var satisfies = require_satisfies();
  var gt = require_gt();
  var lt = require_lt();
  var lte = require_lte();
  var gte = require_gte();
  var outside = (version, range, hilo, options) => {
    version = new SemVer(version, options);
    range = new Range(range, options);
    let gtfn, ltefn, ltfn, comp, ecomp;
    switch (hilo) {
      case ">":
        gtfn = gt;
        ltefn = lte;
        ltfn = lt;
        comp = ">";
        ecomp = ">=";
        break;
      case "<":
        gtfn = lt;
        ltefn = gte;
        ltfn = gt;
        comp = "<";
        ecomp = "<=";
        break;
      default:
        throw new TypeError('Must provide a hilo val of "<" or ">"');
    }
    if (satisfies(version, range, options)) {
      return false;
    }
    for (let i = 0;i < range.set.length; ++i) {
      const comparators = range.set[i];
      let high = null;
      let low = null;
      comparators.forEach((comparator) => {
        if (comparator.semver === ANY) {
          comparator = new Comparator(">=0.0.0");
        }
        high = high || comparator;
        low = low || comparator;
        if (gtfn(comparator.semver, high.semver, options)) {
          high = comparator;
        } else if (ltfn(comparator.semver, low.semver, options)) {
          low = comparator;
        }
      });
      if (high.operator === comp || high.operator === ecomp) {
        return false;
      }
      if ((!low.operator || low.operator === comp) && ltefn(version, low.semver)) {
        return false;
      } else if (low.operator === ecomp && ltfn(version, low.semver)) {
        return false;
      }
    }
    return true;
  };
  module.exports = outside;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/gtr.js
var require_gtr = __commonJS(function(exports, module) {
  var outside = require_outside();
  var gtr = (version, range, options) => outside(version, range, ">", options);
  module.exports = gtr;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/ltr.js
var require_ltr = __commonJS(function(exports, module) {
  var outside = require_outside();
  var ltr = (version, range, options) => outside(version, range, "<", options);
  module.exports = ltr;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/intersects.js
var require_intersects = __commonJS(function(exports, module) {
  var Range = require_range();
  var intersects = (r1, r2, options) => {
    r1 = new Range(r1, options);
    r2 = new Range(r2, options);
    return r1.intersects(r2, options);
  };
  module.exports = intersects;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/simplify.js
var require_simplify = __commonJS(function(exports, module) {
  var satisfies = require_satisfies();
  var compare = require_compare();
  module.exports = (versions, range, options) => {
    const set = [];
    let first = null;
    let prev = null;
    const v = versions.sort((a, b) => compare(a, b, options));
    for (const version of v) {
      const included = satisfies(version, range, options);
      if (included) {
        prev = version;
        if (!first) {
          first = version;
        }
      } else {
        if (prev) {
          set.push([first, prev]);
        }
        prev = null;
        first = null;
      }
    }
    if (first) {
      set.push([first, null]);
    }
    const ranges = [];
    for (const [min, max] of set) {
      if (min === max) {
        ranges.push(min);
      } else if (!max && min === v[0]) {
        ranges.push("*");
      } else if (!max) {
        ranges.push(`>=${min}`);
      } else if (min === v[0]) {
        ranges.push(`<=${max}`);
      } else {
        ranges.push(`${min} - ${max}`);
      }
    }
    const simplified = ranges.join(" || ");
    const original = typeof range.raw === "string" ? range.raw : String(range);
    return simplified.length < original.length ? simplified : range;
  };
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/ranges/subset.js
var require_subset = __commonJS(function(exports, module) {
  var Range = require_range();
  var Comparator = require_comparator();
  var { ANY } = Comparator;
  var satisfies = require_satisfies();
  var compare = require_compare();
  var subset = (sub, dom, options = {}) => {
    if (sub === dom) {
      return true;
    }
    sub = new Range(sub, options);
    dom = new Range(dom, options);
    let sawNonNull = false;
    OUTER:
      for (const simpleSub of sub.set) {
        for (const simpleDom of dom.set) {
          const isSub = simpleSubset(simpleSub, simpleDom, options);
          sawNonNull = sawNonNull || isSub !== null;
          if (isSub) {
            continue OUTER;
          }
        }
        if (sawNonNull) {
          return false;
        }
      }
    return true;
  };
  var minimumVersionWithPreRelease = [new Comparator(">=0.0.0-0")];
  var minimumVersion = [new Comparator(">=0.0.0")];
  var simpleSubset = (sub, dom, options) => {
    if (sub === dom) {
      return true;
    }
    if (sub.length === 1 && sub[0].semver === ANY) {
      if (dom.length === 1 && dom[0].semver === ANY) {
        return true;
      } else if (options.includePrerelease) {
        sub = minimumVersionWithPreRelease;
      } else {
        sub = minimumVersion;
      }
    }
    if (dom.length === 1 && dom[0].semver === ANY) {
      if (options.includePrerelease) {
        return true;
      } else {
        dom = minimumVersion;
      }
    }
    const eqSet = new Set;
    let gt, lt;
    for (const c of sub) {
      if (c.operator === ">" || c.operator === ">=") {
        gt = higherGT(gt, c, options);
      } else if (c.operator === "<" || c.operator === "<=") {
        lt = lowerLT(lt, c, options);
      } else {
        eqSet.add(c.semver);
      }
    }
    if (eqSet.size > 1) {
      return null;
    }
    let gtltComp;
    if (gt && lt) {
      gtltComp = compare(gt.semver, lt.semver, options);
      if (gtltComp > 0) {
        return null;
      } else if (gtltComp === 0 && (gt.operator !== ">=" || lt.operator !== "<=")) {
        return null;
      }
    }
    for (const eq of eqSet) {
      if (gt && !satisfies(eq, String(gt), options)) {
        return null;
      }
      if (lt && !satisfies(eq, String(lt), options)) {
        return null;
      }
      for (const c of dom) {
        if (!satisfies(eq, String(c), options)) {
          return false;
        }
      }
      return true;
    }
    let higher, lower;
    let hasDomLT, hasDomGT;
    let needDomLTPre = lt && !options.includePrerelease && lt.semver.prerelease.length ? lt.semver : false;
    let needDomGTPre = gt && !options.includePrerelease && gt.semver.prerelease.length ? gt.semver : false;
    if (needDomLTPre && needDomLTPre.prerelease.length === 1 && lt.operator === "<" && needDomLTPre.prerelease[0] === 0) {
      needDomLTPre = false;
    }
    for (const c of dom) {
      hasDomGT = hasDomGT || c.operator === ">" || c.operator === ">=";
      hasDomLT = hasDomLT || c.operator === "<" || c.operator === "<=";
      if (gt) {
        if (needDomGTPre) {
          if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomGTPre.major && c.semver.minor === needDomGTPre.minor && c.semver.patch === needDomGTPre.patch) {
            needDomGTPre = false;
          }
        }
        if (c.operator === ">" || c.operator === ">=") {
          higher = higherGT(gt, c, options);
          if (higher === c && higher !== gt) {
            return false;
          }
        } else if (gt.operator === ">=" && !c.test(gt.semver)) {
          return false;
        }
      }
      if (lt) {
        if (needDomLTPre) {
          if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomLTPre.major && c.semver.minor === needDomLTPre.minor && c.semver.patch === needDomLTPre.patch) {
            needDomLTPre = false;
          }
        }
        if (c.operator === "<" || c.operator === "<=") {
          lower = lowerLT(lt, c, options);
          if (lower === c && lower !== lt) {
            return false;
          }
        } else if (lt.operator === "<=" && !c.test(lt.semver)) {
          return false;
        }
      }
      if (!c.operator && (lt || gt) && gtltComp !== 0) {
        return false;
      }
    }
    if (gt && hasDomLT && !lt && gtltComp !== 0) {
      return false;
    }
    if (lt && hasDomGT && !gt && gtltComp !== 0) {
      return false;
    }
    if (needDomGTPre || needDomLTPre) {
      return false;
    }
    return true;
  };
  var higherGT = (a, b, options) => {
    if (!a) {
      return b;
    }
    const comp = compare(a.semver, b.semver, options);
    return comp > 0 ? a : comp < 0 ? b : b.operator === ">" && a.operator === ">=" ? b : a;
  };
  var lowerLT = (a, b, options) => {
    if (!a) {
      return b;
    }
    const comp = compare(a.semver, b.semver, options);
    return comp < 0 ? a : comp > 0 ? b : b.operator === "<" && a.operator === "<=" ? b : a;
  };
  module.exports = subset;
});

// ../../../node_modules/.bun/semver@7.8.5/node_modules/semver/index.js
var require_semver2 = __commonJS(function(exports, module) {
  var internalRe = require_re();
  var constants = require_constants();
  var SemVer = require_semver();
  var identifiers = require_identifiers();
  var parse = require_parse();
  var valid = require_valid();
  var clean = require_clean();
  var inc = require_inc();
  var diff = require_diff();
  var major = require_major();
  var minor = require_minor();
  var patch = require_patch();
  var prerelease = require_prerelease();
  var compare = require_compare();
  var rcompare = require_rcompare();
  var compareLoose = require_compare_loose();
  var compareBuild = require_compare_build();
  var sort = require_sort();
  var rsort = require_rsort();
  var gt = require_gt();
  var lt = require_lt();
  var eq = require_eq();
  var neq = require_neq();
  var gte = require_gte();
  var lte = require_lte();
  var cmp = require_cmp();
  var coerce = require_coerce();
  var truncate = require_truncate();
  var Comparator = require_comparator();
  var Range = require_range();
  var satisfies = require_satisfies();
  var toComparators = require_to_comparators();
  var maxSatisfying = require_max_satisfying();
  var minSatisfying = require_min_satisfying();
  var minVersion = require_min_version();
  var validRange = require_valid2();
  var outside = require_outside();
  var gtr = require_gtr();
  var ltr = require_ltr();
  var intersects = require_intersects();
  var simplifyRange = require_simplify();
  var subset = require_subset();
  module.exports = {
    parse,
    valid,
    clean,
    inc,
    diff,
    major,
    minor,
    patch,
    prerelease,
    compare,
    rcompare,
    compareLoose,
    compareBuild,
    sort,
    rsort,
    gt,
    lt,
    eq,
    neq,
    gte,
    lte,
    cmp,
    coerce,
    truncate,
    Comparator,
    Range,
    satisfies,
    toComparators,
    maxSatisfying,
    minSatisfying,
    minVersion,
    validRange,
    outside,
    gtr,
    ltr,
    intersects,
    simplifyRange,
    subset,
    SemVer,
    re: internalRe.re,
    src: internalRe.src,
    tokens: internalRe.t,
    SEMVER_SPEC_VERSION: constants.SEMVER_SPEC_VERSION,
    RELEASE_TYPES: constants.RELEASE_TYPES,
    compareIdentifiers: identifiers.compareIdentifiers,
    rcompareIdentifiers: identifiers.rcompareIdentifiers
  };
});

// src/git-tree.ts
var exports_git_tree = {};
__export(exports_git_tree, {
  REGISTRY_NOT_INITIALISED: () => REGISTRY_NOT_INITIALISED,
  REGULAR_FILE_MODE: () => REGULAR_FILE_MODE,
  assertSafeTreePath: () => assertSafeTreePath,
  commitOf: () => commitOf,
  commitTime: () => commitTime,
  diffTree: () => diffTree,
  fetchRefs: () => fetchRefs,
  findMergeBase: () => findMergeBase,
  listTreeEntries: () => listTreeEntries,
  readBlob: () => readBlob,
  remoteDefaultBranch: () => remoteDefaultBranch
});

// ../shared/gha-io.ts
import { appendFileSync } from "node:fs";
function inputEnvName(name) {
  return `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
}
function getInput(name) {
  return process.env[inputEnvName(name)] ?? "";
}
var STEP_SUMMARY_MAX_BYTES = 64 * 1024;
function writeJobSummary(md) {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file === undefined)
    return;
  const safe = md.length > STEP_SUMMARY_MAX_BYTES ? md.slice(0, STEP_SUMMARY_MAX_BYTES) : md;
  appendFileSync(file, `${safe}
`);
}
function emitAnnotation(level, message) {
  const safe = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll(`
`, "%0A");
  process.stdout.write(`::${level}::${safe}
`);
}

// src/check.ts
import { mkdtempSync as mkdtempSync2, rmSync as rmSync2 } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as join3 } from "node:path";

// ../../registry-format/src/caps.ts
var MAX_MANIFEST_BYTES = 64 * 1024;
var MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
var MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
var MAX_ENTRY_COUNT = 5000;
var MAX_ROLE_PACK_MANIFEST_BYTES = 128 * 1024;
// ../../registry-format/src/code-unit-compare.ts
function codeUnitCompare(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
// ../../registry-format/src/errors.ts
class RegistryError extends Error {
  code;
  detail;
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.name = "RegistryError";
  }
}
// ../../registry-format/src/extension-env.ts
var BASELINE_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "SYSTEMROOT",
  "BUN_INSTALL",
  "LANG",
  "TZ"
];
var BASELINE_KEY_SET = new Set(BASELINE_KEYS);
function isExtensionBaselineEnvKey(name) {
  return BASELINE_KEY_SET.has(name);
}
// ../../registry-format/src/extension-id.ts
var MAX_EXTENSION_ID_LENGTH = 128;
function assertSafeExtensionId(extensionId) {
  if (extensionId.trim() === "" || extensionId.includes("\x00")) {
    throw new Error("invalid extension id");
  }
  if (extensionId.length > MAX_EXTENSION_ID_LENGTH) {
    throw new Error(`extension id too long (max ${String(MAX_EXTENSION_ID_LENGTH)} chars, got ${String(extensionId.length)})`);
  }
  const normalized = extensionId.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) {
    throw new Error("invalid extension id");
  }
  for (const p of parts) {
    if (p === "..") {
      throw new Error("invalid extension id");
    }
  }
}
function assertCanonicalExtensionId(extensionId) {
  const refuse = (why) => new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", `extension id ${JSON.stringify(extensionId)} is not canonical: ${why}`);
  if (extensionId !== extensionId.trim())
    throw refuse("it has surrounding whitespace");
  if (extensionId.includes("\\"))
    throw refuse("it contains a backslash");
  if (extensionId.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw refuse("it has an empty, '.' or '..' path segment");
  }
}
var PUBLISHABLE_ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertPublishableExtensionId(extensionId) {
  for (const seg of extensionId.split("/")) {
    let why;
    if (!PUBLISHABLE_ID_SEGMENT_RE.test(seg)) {
      why = "must start with a letter or digit and hold only letters, digits, '.', '_' and '-'";
    } else if (seg.endsWith(".")) {
      why = "must not end in '.'";
    } else if (seg.endsWith(".lock")) {
      why = "must not end in '.lock'";
    }
    if (why !== undefined) {
      throw new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", `extension id ${JSON.stringify(extensionId)} cannot be published: segment ${JSON.stringify(seg)} ${why}`);
    }
  }
}
var EXTENSION_SERVICE_ID_PATTERN = /^ext_[a-z0-9_]{1,62}$/;
function deriveExtensionServiceId(manifestId) {
  const id = `ext_${manifestId.toLowerCase().replaceAll(/[^a-z0-9]/g, "_")}`;
  if (!EXTENSION_SERVICE_ID_PATTERN.test(id)) {
    throw new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", `extension id "${manifestId}" does not yield a service id of 1-62 characters after "ext_"`);
  }
  return id;
}
function findServiceIdPrefixCollision(candidate, existing) {
  return existing.find((id) => id === candidate || id.startsWith(`${candidate}_`) || candidate.startsWith(`${id}_`));
}
// ../../registry-format/src/fingerprint.ts
import { createHash } from "node:crypto";
function publisherKeyFingerprint(base64Key) {
  return createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
}
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/agents/guard-factory.js
function createBriefGuard(kind, extra, opts) {
  const requireQuery = opts?.requireQuery ?? false;
  return (x) => {
    if (x === null || typeof x !== "object") {
      return false;
    }
    const b = x;
    if (b["kind"] !== kind || b["agentVersion"] !== 1 || !Array.isArray(b["gaps"]) || typeof b["generatedAt"] !== "number" || typeof b["latencyMs"] !== "number") {
      return false;
    }
    if (requireQuery && (typeof b["query"] !== "object" || b["query"] === null)) {
      return false;
    }
    return extra(b);
  };
}

// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/agents/brief-guards.js
var STRICT = { requireQuery: true };
var isExpertBrief = createBriefGuard("expert", (b) => Array.isArray(b["ranked"]), STRICT);
var isImpactBrief = createBriefGuard("impact", (b) => Array.isArray(b["affected"]), STRICT);
var isCatchupBrief = createBriefGuard("catchup", (b) => Array.isArray(b["sections"]), STRICT);
var isGhostBrief = createBriefGuard("ghost", (b) => Array.isArray(b["findings"]), STRICT);
var isConflictBrief = createBriefGuard("conflict", (b) => Array.isArray(b["collisions"]), STRICT);
var isHuddleBrief = createBriefGuard("huddle", (b) => Array.isArray(b["contributions"]), STRICT);
var isJanitorBrief = createBriefGuard("janitor", (b) => typeof b["idle"] === "boolean" && Array.isArray(b["peersTouched"]), STRICT);
var isPreflightBrief = createBriefGuard("preflight", (b) => Array.isArray(b["downstreams"]) && typeof b["anyFailed"] === "boolean" && typeof b["anyIncomplete"] === "boolean", STRICT);
var isWhyBrief = createBriefGuard("why", (b) => Array.isArray(b["findings"]), STRICT);
var isGlossaryBrief = createBriefGuard("glossary", (b) => Array.isArray(b["entries"]) && Array.isArray(b["suggestions"]), STRICT);
var isDecisionsBrief = createBriefGuard("decisions", (b) => Array.isArray(b["entries"]), STRICT);
var isOwnershipBrief = createBriefGuard("ownership", (b) => typeof b["coverage"] === "object" && b["coverage"] !== null, STRICT);
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/contract-version.js
var CONTRACT_VERSION_PATTERN = /^[1-9][0-9]*$/;

// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/contract-tests.js
var PERMS = new Set(["read", "write", "delete"]);
var HITL = new Set(["write", "delete"]);
var ALL_BLANK = /^[\p{White_Space}\uFEFF]*$/u;
var BLANK_CHAR = /[\p{White_Space}\uFEFF]/u;
var SEMVER_PREFIX = /^[0-9]+\.[0-9]+\.[0-9]+/;
function isNonBlankString(v) {
  return typeof v === "string" && !ALL_BLANK.test(v);
}
function trimBlank(s) {
  let start = 0;
  let end = s.length;
  while (start < end && BLANK_CHAR.test(s.charAt(start))) {
    start += 1;
  }
  while (end > start && BLANK_CHAR.test(s.charAt(end - 1))) {
    end -= 1;
  }
  return s.slice(start, end);
}
var REQUIRED_STRING_FIELDS = [
  "id",
  "displayName",
  "version",
  "description",
  "author",
  "entrypoint"
];
function requiredStringRule(field) {
  const rule = `manifest.${field}.required`;
  return {
    id: rule,
    field,
    check: (manifest) => isNonBlankString(manifest[field]) ? [] : [{ rule, path: `/${field}`, message: `manifest.${field} is required` }]
  };
}
function arrayTypeRule(field) {
  const rule = `manifest.${field}.type`;
  return {
    id: rule,
    field,
    supersedes: [`manifest.${field}.entry`],
    check: (manifest) => Array.isArray(manifest[field]) ? [] : [{ rule, path: `/${field}`, message: `manifest.${field} must be an array` }]
  };
}
function arrayEntryRule(field, allowed) {
  const rule = `manifest.${field}.entry`;
  return {
    id: rule,
    field,
    check: (manifest) => {
      const value = manifest[field];
      if (!Array.isArray(value)) {
        return [];
      }
      const violations = [];
      for (let i = 0;i < value.length; i++) {
        const entry = value[i];
        if (typeof entry === "string" && allowed.has(entry)) {
          continue;
        }
        violations.push({
          rule,
          path: `/${field}/${i}`,
          message: `invalid manifest.${field} entry: ${String(entry)}`
        });
      }
      return violations;
    }
  };
}
var RUNTIME_ENUM = {
  id: "manifest.runtime.enum",
  field: "runtime",
  check: (manifest) => manifest["runtime"] === "bun" || manifest["runtime"] === "node" || manifest["runtime"] === "python" ? [] : [
    {
      rule: "manifest.runtime.enum",
      path: "/runtime",
      message: 'manifest.runtime must be "bun", "node", or "python"'
    }
  ]
};
var MIN_VERSION_REQUIRED = {
  id: "manifest.minNimbusVersion.required",
  field: "minNimbusVersion",
  supersedes: ["manifest.minNimbusVersion.semver"],
  check: (manifest) => isNonBlankString(manifest["minNimbusVersion"]) ? [] : [
    {
      rule: "manifest.minNimbusVersion.required",
      path: "/minNimbusVersion",
      message: "manifest.minNimbusVersion is required"
    }
  ]
};
var MIN_VERSION_SEMVER = {
  id: "manifest.minNimbusVersion.semver",
  field: "minNimbusVersion",
  check: (manifest) => {
    const value = manifest["minNimbusVersion"];
    if (!isNonBlankString(value) || SEMVER_PREFIX.test(trimBlank(value))) {
      return [];
    }
    return [
      {
        rule: "manifest.minNimbusVersion.semver",
        path: "/minNimbusVersion",
        message: "manifest.minNimbusVersion must start with semver x.y.z"
      }
    ];
  }
};
var CONTRACT_VERSIONS_TYPE = {
  id: "manifest.contractVersions.type",
  field: "contractVersions",
  supersedes: ["manifest.contractVersions.nonempty", "manifest.contractVersions.entry"],
  check: (manifest) => {
    const value = manifest["contractVersions"];
    return value === undefined || Array.isArray(value) ? [] : [
      {
        rule: "manifest.contractVersions.type",
        path: "/contractVersions",
        message: "manifest.contractVersions must be an array"
      }
    ];
  }
};
var CONTRACT_VERSIONS_NONEMPTY = {
  id: "manifest.contractVersions.nonempty",
  field: "contractVersions",
  check: (manifest) => {
    const value = manifest["contractVersions"];
    return Array.isArray(value) && value.length === 0 ? [
      {
        rule: "manifest.contractVersions.nonempty",
        path: "/contractVersions",
        message: "manifest.contractVersions must declare at least one version when present"
      }
    ] : [];
  }
};
var CONTRACT_VERSIONS_ENTRY = {
  id: "manifest.contractVersions.entry",
  field: "contractVersions",
  check: (manifest) => {
    const value = manifest["contractVersions"];
    if (!Array.isArray(value)) {
      return [];
    }
    const violations = [];
    const seen = new Set;
    for (let i = 0;i < value.length; i++) {
      const entry = value[i];
      if (typeof entry !== "string" || !CONTRACT_VERSION_PATTERN.test(entry)) {
        violations.push({
          rule: "manifest.contractVersions.entry",
          path: `/contractVersions/${i}`,
          message: `invalid manifest.contractVersions entry: ${String(entry)}`
        });
        continue;
      }
      if (seen.has(entry)) {
        violations.push({
          rule: "manifest.contractVersions.entry",
          path: `/contractVersions/${i}`,
          message: `duplicate manifest.contractVersions entry: ${entry}`
        });
        continue;
      }
      seen.add(entry);
    }
    return violations;
  }
};
var MANIFEST_RULES = [
  ...REQUIRED_STRING_FIELDS.map(requiredStringRule),
  RUNTIME_ENUM,
  arrayTypeRule("permissions"),
  arrayEntryRule("permissions", PERMS),
  arrayTypeRule("hitlRequired"),
  arrayEntryRule("hitlRequired", HITL),
  MIN_VERSION_REQUIRED,
  MIN_VERSION_SEMVER,
  CONTRACT_VERSIONS_TYPE,
  CONTRACT_VERSIONS_NONEMPTY,
  CONTRACT_VERSIONS_ENTRY
];
var ROW_DATA_TOOL_SEGMENTS = new Set([
  "query",
  "queries",
  "row",
  "rows",
  "cell",
  "cells",
  "record",
  "records",
  "event",
  "events",
  "result",
  "results",
  "tabledata",
  "scan",
  "sample",
  "samples",
  "select",
  "values",
  "preview",
  "head",
  "dump",
  "export",
  "download"
]);
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/crypto/canonical-json.js
class NonIntegerNumberInManifest extends Error {
  name = "NonIntegerNumberInManifest";
}

class UnsupportedManifestValueType extends Error {
  name = "UnsupportedManifestValueType";
}

class ManifestNestedTooDeep extends Error {
  name = "ManifestNestedTooDeep";
}
var MAX_DEPTH = 32;
function canonicalize(value, depth = 0) {
  if (depth > MAX_DEPTH)
    throw new ManifestNestedTooDeep;
  if (value === null)
    return "null";
  if (value === true)
    return "true";
  if (value === false)
    return "false";
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value))
      throw new NonIntegerNumberInManifest;
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort((a, b) => {
      if (a < b)
        return -1;
      if (a > b)
        return 1;
      return 0;
    });
    return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k], depth + 1)}`).join(",") + "}";
  }
  throw new UnsupportedManifestValueType;
}
function canonicalizeManifest(manifest) {
  const clone = { ...manifest };
  delete clone["signature"];
  return new TextEncoder().encode(canonicalize(clone));
}
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/crypto/verify-signature.js
class PublisherKeyMismatch extends Error {
  name = "PublisherKeyMismatch";
}

class SignatureInvalidFormat extends Error {
  name = "SignatureInvalidFormat";
}

class SignatureInvalid extends Error {
  name = "SignatureInvalid";
}
function decodeBase64(s) {
  return new Uint8Array(Buffer.from(s, "base64"));
}
function constantTimeBytesEqual(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
async function verifyManifestSignature(manifest, resolvedPubkey) {
  if (manifest.publisher === undefined || manifest.signature === undefined) {
    throw new Error("verifyManifestSignature called on unsigned manifest — caller must check first");
  }
  if (resolvedPubkey.length !== 32)
    throw new SignatureInvalidFormat;
  const declaredPubkey = decodeBase64(manifest.publisher.key);
  if (declaredPubkey.length !== 32)
    throw new SignatureInvalidFormat;
  if (!constantTimeBytesEqual(declaredPubkey, resolvedPubkey)) {
    throw new PublisherKeyMismatch;
  }
  const sig = decodeBase64(manifest.signature);
  if (sig.length !== 64)
    throw new SignatureInvalidFormat;
  const canonical = canonicalizeManifest(manifest);
  const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(resolvedPubkey), { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("Ed25519", cryptoKey, new Uint8Array(sig), new Uint8Array(canonical));
  if (!ok)
    throw new SignatureInvalid;
}
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/internal/whitespace.js
var NORMATIVE_WHITESPACE = new Set([
  9,
  10,
  11,
  12,
  13,
  32,
  160,
  5760,
  8192,
  8193,
  8194,
  8195,
  8196,
  8197,
  8198,
  8199,
  8200,
  8201,
  8202,
  8232,
  8233,
  8239,
  8287,
  12288,
  65279
]);
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/distribution-channel.js
var KNOWN_CHANNELS = new Set([
  "homebrew",
  "scoop",
  "winget",
  "apt",
  "yum",
  "msi",
  "pkg"
]);
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/item-types.js
var KNOWN_ITEM_TYPES = [
  "account",
  "api_endpoint",
  "app",
  "application",
  "board",
  "bookmark",
  "build",
  "ci_run",
  "code_issue",
  "code_symbol",
  "conversation",
  "dag",
  "dashboard",
  "data_model",
  "data_pipeline",
  "data_quality_test",
  "deal",
  "dependency",
  "deployment",
  "design",
  "email",
  "event",
  "feature_flag",
  "file",
  "finding",
  "folder",
  "git_commit",
  "highlight",
  "incident",
  "index",
  "invoice",
  "issue",
  "job",
  "job_posting",
  "k8s_workload",
  "lambda_function",
  "log_group",
  "meeting",
  "message",
  "ml_model",
  "model",
  "monitor",
  "obsidian_note",
  "opportunity",
  "page",
  "photo",
  "posting",
  "pr",
  "project",
  "question",
  "reference",
  "release",
  "report",
  "resource",
  "saved_query",
  "sink",
  "site",
  "story",
  "subscription",
  "sync_heartbeat",
  "table",
  "ticket",
  "time_off",
  "transaction",
  "transcript",
  "vulnerability",
  "web_clip",
  "worker"
];
var KNOWN = new Set(KNOWN_ITEM_TYPES);
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/ipc/ndjson-line-reader.js
var IPC_MAX_LINE_BYTES = 1024 * 1024;
// ../../../node_modules/.bun/@nimbus-dev+sdk@2.1.0/node_modules/@nimbus-dev/sdk/dist/testing/sandbox-protocol.js
var NETWORK_BLOCKED_CODES = new Set([
  "ECONNREFUSED",
  "EPERM",
  "EHOSTUNREACH",
  "ENETUNREACH"
]);
var FS_DENIED_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
// ../../registry-format/src/index-format.ts
var import_tweetnacl3 = __toESM(require_nacl_fast(), 1);

// ../../registry-format/src/manifest.ts
var import_semver = __toESM(require_semver2(), 1);

// ../../registry-format/src/permissions-validator.ts
var HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
function validateAndNormalizePermissions(input) {
  if (Array.isArray(input)) {
    return { network: [], filesystem: { read: [], write: [] } };
  }
  if (typeof input !== "object" || input === null) {
    throw new TypeError("permissions must be an object or legacy string[]");
  }
  const obj = input;
  for (const key of Object.keys(obj)) {
    if (key !== "network" && key !== "filesystem") {
      throw new Error(`unknown permission key: ${key}`);
    }
  }
  const network = validateNetwork(obj["network"]);
  const filesystem = validateFilesystem(obj["filesystem"]);
  return { network, filesystem };
}
function validateNetworkPort(portStr, entry) {
  if (!/^\d{1,5}$/.test(portStr)) {
    throw new Error(`permissions.network: ${entry} has a non-numeric port`);
  }
  const port = Number(portStr);
  if (port < 1 || port > 65535) {
    throw new Error(`permissions.network: ${entry} port must be in 1..65535`);
  }
}
function validateNetworkEntry(entry) {
  if (typeof entry !== "string") {
    throw new TypeError("permissions.network entries must be strings");
  }
  const colon = entry.lastIndexOf(":");
  const host = colon === -1 ? entry : entry.slice(0, colon);
  if (!HOSTNAME_RE.test(host)) {
    throw new Error(`permissions.network: ${entry} is not a valid RFC 1123 hostname`);
  }
  if (colon !== -1) {
    validateNetworkPort(entry.slice(colon + 1), entry);
  }
  return entry;
}
function validateNetwork(input) {
  if (input === undefined)
    return [];
  if (!Array.isArray(input))
    throw new TypeError("permissions.network must be an array");
  return input.map(validateNetworkEntry);
}
function validateFilesystem(input) {
  if (input === undefined)
    return { read: [], write: [] };
  if (typeof input !== "object" || input === null) {
    throw new TypeError("permissions.filesystem must be an object");
  }
  const obj = input;
  for (const key of Object.keys(obj)) {
    if (key !== "read" && key !== "write") {
      throw new Error(`unknown permissions.filesystem key: ${key}`);
    }
  }
  return {
    read: validatePathList(obj["read"], "permissions.filesystem.read"),
    write: validatePathList(obj["write"], "permissions.filesystem.write")
  };
}
function validatePathList(input, label) {
  if (input === undefined)
    return [];
  if (!Array.isArray(input))
    throw new TypeError(`${label} must be an array`);
  const out = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      throw new TypeError(`${label} entries must be strings`);
    }
    if (entry.split("/").includes("..") || entry.split("\\").includes("..")) {
      throw new Error(`${label}: ${entry} contains '..'`);
    }
    out.push(entry);
  }
  return out;
}

// ../../registry-format/src/manifest.ts
var DEFAULT_EXTENSION_ENTRY = "dist/index.js";
function extensionEntryRelPath(manifest) {
  return manifest.entry !== undefined && manifest.entry !== "" ? manifest.entry : DEFAULT_EXTENSION_ENTRY;
}
var PUBLISHER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
var PUBLISHER_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
var SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
function parsePublisher(value) {
  if (value === undefined)
    return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("extension manifest publisher must be an object");
  }
  const o = value;
  const allowed = new Set(["id", "key"]);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) {
      throw new Error(`extension manifest publisher has unknown key: ${k}`);
    }
  }
  const id = typeof o["id"] === "string" ? o["id"].trim() : "";
  if (id === "" || id.length > 64 || !PUBLISHER_ID_RE.test(id)) {
    throw new Error("extension manifest publisher.id is required and must match [a-z0-9][a-z0-9._-]* (max 64 chars)");
  }
  const key = typeof o["key"] === "string" ? o["key"].trim() : "";
  if (!PUBLISHER_KEY_RE.test(key)) {
    throw new Error("extension manifest publisher.key must be 44-char base64 of a 32-byte Ed25519 public key");
  }
  return { id, key };
}
function parseSignature(value) {
  if (value === undefined)
    return;
  if (typeof value !== "string")
    throw new Error("extension manifest signature must be a string");
  if (!SIGNATURE_RE.test(value)) {
    throw new Error("extension manifest signature must be 88-char base64 of a 64-byte Ed25519 signature");
  }
  return value;
}
var CHANGELOG_MAX_BYTES = 4096;
function parseUpdateChannel(value) {
  if (value === undefined)
    return "stable";
  if (value !== "stable" && value !== "beta") {
    throw new Error(`extension manifest updateChannel must be "stable" or "beta" (got: ${JSON.stringify(value)})`);
  }
  return value;
}
function parseChangelog(value) {
  if (value === undefined)
    return;
  if (typeof value !== "string") {
    throw new TypeError("extension manifest changelog must be a string");
  }
  const normalized = value.normalize("NFC");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes > CHANGELOG_MAX_BYTES) {
    throw new Error(`extension manifest changelog must be ≤ 4 KiB after NFC normalization (got ${bytes} bytes)`);
  }
  return normalized;
}
function parseDependsOn(value) {
  if (value === undefined)
    return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("extension manifest dependsOn must be an object");
  }
  const o = value;
  const out = {};
  for (const [depId, range] of Object.entries(o)) {
    if (typeof depId !== "string" || depId.trim() === "") {
      throw new Error("extension manifest dependsOn keys must be non-empty strings");
    }
    if (typeof range !== "string" || range.trim() === "") {
      throw new Error(`extension manifest dependsOn.${depId} must be a non-empty string`);
    }
    if (import_semver.default.validRange(range) === null) {
      throw new Error(`extension manifest dependsOn.${depId} is not a valid semver range: ${range}`);
    }
    out[depId] = range;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
var SYNC_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
var CREDENTIAL_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
var RESERVED_ENV_PREFIXES = ["NIMBUS_", "BUN_", "NODE_", "LD_", "DYLD_"];
var RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT"
]);
var MIN_SYNC_INTERVAL_SECONDS = 60;
function asPlainObject(value, what) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`extension manifest ${what} must be an object`);
  }
  return value;
}
function rejectUnknownKeys(o, allowed, what) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      throw new Error(`extension manifest ${what} has unknown key: ${k}`);
    }
  }
}
function parseSync(value) {
  if (value === undefined)
    return;
  const o = asPlainObject(value, "sync");
  rejectUnknownKeys(o, ["contract", "intervalSeconds", "itemTypes"], "sync");
  if (o["contract"] !== "1") {
    throw new Error('extension manifest sync.contract must be exactly "1"');
  }
  const interval = o["intervalSeconds"];
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < MIN_SYNC_INTERVAL_SECONDS) {
    throw new Error(`extension manifest sync.intervalSeconds must be an integer >= ${MIN_SYNC_INTERVAL_SECONDS}`);
  }
  const types = o["itemTypes"];
  if (!Array.isArray(types) || types.length === 0 || !types.every((t) => typeof t === "string" && SYNC_NAME_RE.test(t))) {
    throw new Error("extension manifest sync.itemTypes must be a non-empty array of [a-z][a-z0-9_]{0,31} names");
  }
  return { contract: "1", intervalSeconds: interval, itemTypes: [...types] };
}
function isReservedEnv(env) {
  return RESERVED_ENV_NAMES.has(env) || isExtensionBaselineEnvKey(env) || RESERVED_ENV_PREFIXES.some((p) => env.startsWith(p));
}
function parseCredentials(value) {
  if (value === undefined)
    return;
  const o = asPlainObject(value, "credentials");
  const out = {};
  const seenEnv = new Set;
  for (const [name, entry] of Object.entries(o)) {
    if (!SYNC_NAME_RE.test(name)) {
      throw new Error(`extension manifest credentials name must match [a-z][a-z0-9_]{0,31}: ${name}`);
    }
    const e = asPlainObject(entry, `credentials.${name}`);
    rejectUnknownKeys(e, ["env"], `credentials.${name}`);
    const env = e["env"];
    if (typeof env !== "string" || !CREDENTIAL_ENV_RE.test(env) || isReservedEnv(env)) {
      throw new Error(`extension manifest credentials.${name}.env must match [A-Z][A-Z0-9_]{0,63} and not be a reserved variable`);
    }
    if (seenEnv.has(env)) {
      throw new Error(`extension manifest credentials has duplicate env var: ${env}`);
    }
    seenEnv.add(env);
    out[name] = { env };
  }
  return out;
}
function parseEntry(o) {
  const raw = typeof o["entry"] === "string" ? o["entry"] : o["entrypoint"];
  return typeof raw === "string" ? raw.trim().replaceAll("\\", "/") : undefined;
}
function rawManifestEntryRelPath(raw) {
  const entry = parseEntry(raw);
  return extensionEntryRelPath(entry === undefined ? {} : { entry });
}
function parseManifestObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("extension manifest is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("extension manifest must be a JSON object");
  }
  return parsed;
}
function parseOptionalBlocks(o) {
  const changelog = parseChangelog(o["changelog"]);
  const dependsOn = parseDependsOn(o["dependsOn"]);
  const sync = parseSync(o["sync"]);
  const credentials = parseCredentials(o["credentials"]);
  return {
    ...changelog === undefined ? {} : { changelog },
    ...dependsOn === undefined ? {} : { dependsOn },
    ...sync === undefined ? {} : { sync },
    ...credentials === undefined ? {} : { credentials }
  };
}
function parseExtensionManifestForRegistry(text) {
  const o = parseManifestObject(text);
  const id = typeof o["id"] === "string" ? o["id"].trim() : "";
  const version = typeof o["version"] === "string" ? o["version"].trim() : "";
  if (id === "" || version === "") {
    throw new Error("extension manifest requires non-empty id and version");
  }
  const name = typeof o["name"] === "string" ? o["name"].trim() : undefined;
  const entry = parseEntry(o);
  const publisher = parsePublisher(o["publisher"]);
  const signature = parseSignature(o["signature"]);
  if (publisher === undefined !== (signature === undefined)) {
    throw new Error("extension manifest must have publisher and signature together, or neither");
  }
  const updateChannel = parseUpdateChannel(o["updateChannel"]);
  const blocks = parseOptionalBlocks(o);
  const isPreT2Legacy = Array.isArray(o["permissions"]);
  const permissions = validateAndNormalizePermissions(o["permissions"] === undefined ? {} : o["permissions"]);
  return {
    manifest: {
      id,
      version,
      ...name !== undefined && name !== "" ? { name } : {},
      ...entry !== undefined && entry !== "" ? { entry } : {},
      permissions,
      ...publisher === undefined ? {} : { publisher },
      ...signature === undefined ? {} : { signature },
      updateChannel,
      ...blocks
    },
    isPreT2Legacy
  };
}

// ../../registry-format/src/semver.ts
var NUMERIC_ID_RE = /^(?:0|[1-9]\d*)$/;
var ID_CHARS_RE = /^[0-9A-Za-z-]+$/;
var ALL_DIGITS_RE = /^\d+$/;
function isPrereleaseId(id) {
  return ID_CHARS_RE.test(id) && (NUMERIC_ID_RE.test(id) || !ALL_DIGITS_RE.test(id));
}
function isBuildId(id) {
  return ID_CHARS_RE.test(id);
}
function splitFirst(s, sep) {
  const at = s.indexOf(sep);
  return at === -1 ? [s, undefined] : [s.slice(0, at), s.slice(at + 1)];
}
function isValidSemver(v) {
  const [head, build] = splitFirst(v, "+");
  if (build !== undefined && !build.split(".").every(isBuildId))
    return false;
  const [core, pre] = splitFirst(head, "-");
  if (pre !== undefined && !pre.split(".").every(isPrereleaseId))
    return false;
  const parts = core.split(".");
  return parts.length === 3 && parts.every((p) => NUMERIC_ID_RE.test(p));
}

// ../../registry-format/src/role-pack.ts
var ALLOWED_KEYS = new Set([
  "schema",
  "id",
  "name",
  "version",
  "description",
  "roles",
  "suggestedConnectors",
  "members",
  "defaults"
]);

// ../../registry-format/src/trust-feed.ts
var import_tweetnacl2 = __toESM(require_nacl_fast(), 1);

// ../../registry-format/src/ed25519-seed.ts
import { createPrivateKey } from "node:crypto";
var PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function privateKeyFromSeed(seed) {
  if (seed.byteLength !== 32)
    throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8"
  });
}

// ../../registry-format/src/trust-statement.ts
import { createHash as createHash2, sign } from "node:crypto";
var import_tweetnacl = __toESM(require_nacl_fast(), 1);
var TRUST_STATEMENT_KINDS = [
  "key.revoke",
  "extension.takedown",
  "key.rotate",
  "publisher.verified"
];
var MAX_STATEMENT_REASON_CHARS = 500;
var MAX_TAKEDOWN_VERSIONS = 100;
var MAX_VERIFIED_KEYS = 10;
var KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
var SIGNATURE_RE2 = /^[A-Za-z0-9+/]{86}==$/;
var FINGERPRINT_RE = /^[0-9a-f]{32}$/;
var GITHUB_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
function invalid(detail) {
  return new RegistryError("ERR_TRUST_STATEMENT_INVALID", detail);
}
function asObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("a statement must be an object");
  }
  return value;
}
function str(o, key) {
  const v = o[key];
  if (typeof v !== "string" || v === "")
    throw invalid(`${key} must be a non-empty string`);
  return v;
}
function matching(o, key, re) {
  const v = str(o, key);
  if (!re.test(v))
    throw invalid(`${key} is malformed`);
  return v;
}
function timestamp(o, key) {
  const v = str(o, key);
  if (Number.isNaN(Date.parse(v)))
    throw invalid(`${key} is not a timestamp`);
  return v;
}
function publisherId(o) {
  const v = str(o, "publisherId");
  if (v.length > 64 || !PUBLISHER_ID_RE.test(v))
    throw invalid("publisherId is malformed");
  return v;
}
function reason(o) {
  const v = str(o, "reason");
  if ([...v].length > MAX_STATEMENT_REASON_CHARS) {
    throw invalid(`reason exceeds ${String(MAX_STATEMENT_REASON_CHARS)} characters`);
  }
  return v;
}
function versions(o) {
  const v = o["versions"];
  if (v === "*")
    return v;
  if (!Array.isArray(v) || v.length === 0) {
    throw invalid('versions must be "*" or a non-empty list');
  }
  if (v.length > MAX_TAKEDOWN_VERSIONS) {
    throw invalid(`versions lists more than ${String(MAX_TAKEDOWN_VERSIONS)} entries`);
  }
  const seen = new Set;
  for (const item of v) {
    if (typeof item !== "string" || !isValidSemver(item))
      throw invalid("versions has a non-semver entry");
    if (seen.has(item))
      throw invalid("versions has a duplicate entry");
    seen.add(item);
  }
  return v;
}
function verifiedKeys(o) {
  const v = o["keys"];
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_VERIFIED_KEYS) {
    throw invalid(`keys must list 1 to ${String(MAX_VERIFIED_KEYS)} keys`);
  }
  const seen = new Set;
  for (const k of v) {
    if (typeof k !== "string" || !KEY_RE.test(k))
      throw invalid("keys has a malformed key");
    if (seen.has(k))
      throw invalid("keys has a duplicate key");
    seen.add(k);
  }
  return v;
}
function isKnownStatementKind(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return false;
  const kind = raw["kind"];
  return typeof kind === "string" && TRUST_STATEMENT_KINDS.includes(kind);
}
function parseTrustStatement(raw) {
  const o = asObject(raw);
  if (!isKnownStatementKind(o))
    throw invalid("kind is not known");
  const base = {
    ...o,
    issuedAt: timestamp(o, "issuedAt"),
    signerKey: matching(o, "signerKey", KEY_RE),
    signature: matching(o, "signature", SIGNATURE_RE2)
  };
  switch (o["kind"]) {
    case "key.revoke":
      return {
        ...base,
        kind: "key.revoke",
        publisherId: publisherId(o),
        keyFingerprint: matching(o, "keyFingerprint", FINGERPRINT_RE),
        reason: reason(o)
      };
    case "extension.takedown": {
      const extensionId = str(o, "extensionId");
      try {
        assertSafeExtensionId(extensionId);
      } catch (e) {
        throw invalid(`extensionId is not safe: ${e.message}`);
      }
      return {
        ...base,
        kind: "extension.takedown",
        extensionId,
        publisherId: publisherId(o),
        versions: versions(o),
        reason: reason(o)
      };
    }
    case "key.rotate": {
      const fromKey = matching(o, "fromKey", KEY_RE);
      const toKey = matching(o, "toKey", KEY_RE);
      if (fromKey === toKey)
        throw invalid("fromKey and toKey are the same key");
      return { ...base, kind: "key.rotate", publisherId: publisherId(o), fromKey, toKey };
    }
    case "publisher.verified":
      return {
        ...base,
        kind: "publisher.verified",
        publisherId: publisherId(o),
        keys: verifiedKeys(o),
        github: matching(o, "github", GITHUB_HANDLE_RE),
        verifiedAt: timestamp(o, "verifiedAt")
      };
  }
}
function trustStatementSigningBytes(s) {
  const { signature: _omitted, ...rest } = s;
  return new TextEncoder().encode(canonicalize(rest));
}
function trustStatementId(s) {
  return createHash2("sha256").update(canonicalize(s)).digest("hex");
}
function signTrustStatement(s, seed) {
  return new Promise((resolve) => {
    const { signature: _omitted, ...rest } = s;
    const sig = sign(null, trustStatementSigningBytes(rest), privateKeyFromSeed(seed));
    resolve({ ...rest, signature: sig.toString("base64") });
  });
}
function signatureVerifies(s) {
  try {
    return import_tweetnacl.default.sign.detached.verify(trustStatementSigningBytes(s), new Uint8Array(Buffer.from(s.signature, "base64")), new Uint8Array(Buffer.from(s.signerKey, "base64")));
  } catch {
    return false;
  }
}
function verifyTrustStatement(s, opts) {
  if (!signatureVerifies(s))
    return null;
  const root = opts.nimbusRootKey !== undefined && s.signerKey === opts.nimbusRootKey ? "nimbus" : opts.registryRootKey !== undefined && s.signerKey === opts.registryRootKey ? "registry" : null;
  switch (s.kind) {
    case "key.revoke":
      if (publisherKeyFingerprint(s.signerKey) === s.keyFingerprint)
        return "publisher";
      return root;
    case "extension.takedown":
      return root;
    case "publisher.verified":
      return root === "nimbus" ? "nimbus" : null;
    case "key.rotate":
      return s.signerKey === s.fromKey ? "publisher" : null;
  }
}

// ../../registry-format/src/trust-feed.ts
var MAX_TRUST_FEED_BYTES = 8 * 1024 * 1024;
var MAX_STATEMENTS_PER_DOCUMENT = 1e4;
function hasStringKind(entry) {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry) && typeof entry["kind"] === "string";
}
function readStatementList(raw) {
  if (raw === undefined)
    return { statements: [], dropped: 0, unknownKinds: 0 };
  if (!Array.isArray(raw))
    return { statements: [], dropped: 1, unknownKinds: 0 };
  const statements = [];
  let dropped = Math.max(0, raw.length - MAX_STATEMENTS_PER_DOCUMENT);
  let unknownKinds = 0;
  for (const entry of raw.slice(0, MAX_STATEMENTS_PER_DOCUMENT)) {
    if (!hasStringKind(entry)) {
      dropped++;
      continue;
    }
    if (!isKnownStatementKind(entry)) {
      unknownKinds++;
      continue;
    }
    try {
      statements.push(parseTrustStatement(entry));
    } catch (err) {
      if (!(err instanceof RegistryError))
        throw err;
      dropped++;
    }
  }
  return { statements, dropped, unknownKinds };
}

// ../../registry-format/src/index-format.ts
function decodeBase642(s) {
  return new Uint8Array(Buffer.from(s, "base64"));
}
var MAX_INDEX_BYTES = 8 * 1024 * 1024;
var HEX64_RE = /^[0-9a-f]{64}$/;
var KEY_RE2 = /^[A-Za-z0-9+/]{43}=$/;
var SIGNATURE_RE3 = /^[A-Za-z0-9+/]{86}==$/;
function invalid2(detail) {
  return new RegistryError("ERR_REGISTRY_INDEX_INVALID", detail);
}
function asObject2(value, what) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid2(`${what} must be an object`);
  }
  return value;
}
function requireKeys(o, keys, what) {
  for (const k of keys) {
    if (!(k in o))
      throw invalid2(`${what} is missing key: ${k}`);
  }
}
function str2(o, key, what) {
  const v = o[key];
  if (typeof v !== "string" || v === "")
    throw invalid2(`${what}.${key} must be a non-empty string`);
  return v;
}
function matching2(o, key, re, what) {
  const v = str2(o, key, what);
  if (!re.test(v))
    throw invalid2(`${what}.${key} is malformed`);
  return v;
}
function isoTimestamp(o, key, what) {
  const v = str2(o, key, what);
  if (Number.isNaN(Date.parse(v)))
    throw invalid2(`${what}.${key} is not a timestamp`);
  return v;
}
function parseVersionEntry(raw, id, version) {
  const what = `extensions.${id}.versions.${version}`;
  const o = asObject2(raw, what);
  requireKeys(o, [
    "channel",
    "name",
    "manifest",
    "manifestSha256",
    "package",
    "packageSha256",
    "packageSizeBytes",
    "entryHash",
    "publishedAt"
  ], what);
  const channel = o["channel"];
  if (channel !== "stable" && channel !== "beta")
    throw invalid2(`${what}.channel is not known`);
  const base = `extensions/${id}/${version}`;
  const manifest = str2(o, "manifest", what);
  if (manifest !== `${base}/manifest.json`)
    throw invalid2(`${what}.manifest is not canonical`);
  const pkg = str2(o, "package", what);
  if (pkg !== `${base}/package.tgz`)
    throw invalid2(`${what}.package is not canonical`);
  const size = o["packageSizeBytes"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
    throw invalid2(`${what}.packageSizeBytes must be a positive integer`);
  }
  return {
    ...o,
    channel,
    name: str2(o, "name", what),
    manifest,
    manifestSha256: matching2(o, "manifestSha256", HEX64_RE, what),
    package: pkg,
    packageSha256: matching2(o, "packageSha256", HEX64_RE, what),
    packageSizeBytes: size,
    entryHash: matching2(o, "entryHash", HEX64_RE, what),
    publishedAt: isoTimestamp(o, "publishedAt", what)
  };
}
function parseExtensionEntry(raw, id) {
  try {
    assertSafeExtensionId(id);
  } catch (e) {
    throw invalid2(`extension id ${JSON.stringify(id)} is not safe: ${e.message}`);
  }
  const what = `extensions.${id}`;
  const o = asObject2(raw, what);
  requireKeys(o, ["publisher", "versions"], what);
  const p = asObject2(o["publisher"], `${what}.publisher`);
  requireKeys(p, ["id", "key"], `${what}.publisher`);
  const pid = str2(p, "id", `${what}.publisher`);
  if (pid.length > 64 || !PUBLISHER_ID_RE.test(pid)) {
    throw invalid2(`${what}.publisher.id is malformed`);
  }
  const key = matching2(p, "key", KEY_RE2, `${what}.publisher`);
  const versionsRaw = asObject2(o["versions"], `${what}.versions`);
  const versions = {};
  for (const [version, entry] of Object.entries(versionsRaw)) {
    if (!isValidSemver(version))
      throw invalid2(`${what} has a non-semver version: ${version}`);
    versions[version] = parseVersionEntry(entry, id, version);
  }
  if (Object.keys(versions).length === 0)
    throw invalid2(`${what} has no versions`);
  return { ...o, publisher: { ...p, id: pid, key }, versions };
}
function parseRegistryIndex(bytes) {
  if (bytes.byteLength > MAX_INDEX_BYTES) {
    throw new RegistryError("ERR_REGISTRY_TOO_LARGE", `index.json exceeds ${String(MAX_INDEX_BYTES)} bytes`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid2("index.json is not valid UTF-8");
  }
  if (text.startsWith("\uFEFF"))
    text = text.slice(1);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid2("index.json is not valid JSON");
  }
  const o = asObject2(raw, "index");
  requireKeys(o, ["format", "rootKey", "sequence", "generatedAt", "extensions", "signature"], "index");
  if (o["format"] !== 1)
    throw invalid2("unsupported index format");
  const sequence = o["sequence"];
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) {
    throw invalid2("index.sequence must be a positive integer");
  }
  const extensionsRaw = asObject2(o["extensions"], "index.extensions");
  const extensions = {};
  for (const [id, entry] of Object.entries(extensionsRaw)) {
    extensions[id] = parseExtensionEntry(entry, id);
  }
  return {
    ...o,
    format: 1,
    rootKey: matching2(o, "rootKey", KEY_RE2, "index"),
    sequence,
    generatedAt: isoTimestamp(o, "generatedAt", "index"),
    extensions,
    signature: matching2(o, "signature", SIGNATURE_RE3, "index")
  };
}
function readRegistryReportUrl(index) {
  const v = index.reportUrl;
  if (typeof v !== "string")
    return;
  try {
    const url = new URL(v);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return;
  }
}
function registryIndexSigningBytes(index) {
  const { signature: _omitted, ...rest } = index;
  return new TextEncoder().encode(canonicalize(rest));
}
function verifyRegistryIndexSelf(index) {
  return new Promise((resolve) => {
    assertRegistryIndexSelf(index);
    resolve();
  });
}
function assertRegistryIndexSelf(index) {
  let ok;
  try {
    ok = import_tweetnacl3.default.sign.detached.verify(registryIndexSigningBytes(index), decodeBase642(index.signature), decodeBase642(index.rootKey));
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new RegistryError("ERR_REGISTRY_SIGNATURE_INVALID", "index signature does not verify");
  }
}
async function verifyRegistryIndexPinned(index, pinnedRootKey) {
  if (index.rootKey !== pinnedRootKey) {
    throw new RegistryError("ERR_REGISTRY_ROOT_KEY_CHANGED", "index root key differs from the pinned key");
  }
  await verifyRegistryIndexSelf(index);
}
// ../../registry-format/src/inspect.ts
import { createHash as createHash3 } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// ../../../node_modules/.bun/tar@7.5.22/node_modules/tar/dist/esm/index.min.js
import Qr from "events";
import I from "fs";
import { EventEmitter as Di } from "node:events";
import Cs from "node:stream";
import { StringDecoder as Hr } from "node:string_decoder";
import cr from "node:path";
import Kt from "node:fs";
import { dirname as Fn, parse as kn } from "path";
import { EventEmitter as Dn } from "events";
import zi from "assert";
import { Buffer as Ot } from "buffer";
import * as Ps from "zlib";
import en from "zlib";
import { posix as Zt } from "node:path";
import { basename as _n } from "node:path";
import mi from "fs";
import X from "fs";
import js from "path";
import { win32 as Pn } from "node:path";
import ar from "path";
import Br from "node:fs";
import co from "node:assert";
import { randomBytes as Mr } from "node:crypto";
import u from "node:fs";
import R from "node:path";
import pr from "fs";
import wi from "node:fs";
import we from "node:path";
import k from "node:fs";
import ro from "node:fs/promises";
import Si from "node:path";
import { join as xr } from "node:path";
import v from "node:fs";
import Pr from "node:path";
var zr = Object.defineProperty;
var Ur = (s, t) => {
  for (var e in t)
    zr(s, e, { get: t[e], enumerable: true });
};
var Ds = typeof process == "object" && process ? process : { stdout: null, stderr: null };
var Wr = (s) => !!s && typeof s == "object" && (s instanceof A || s instanceof Cs || Gr(s) || Zr(s));
var Gr = (s) => !!s && typeof s == "object" && s instanceof Di && typeof s.pipe == "function" && s.pipe !== Cs.Writable.prototype.pipe;
var Zr = (s) => !!s && typeof s == "object" && s instanceof Di && typeof s.write == "function" && typeof s.end == "function";
var Q = Symbol("EOF");
var J = Symbol("maybeEmitEnd");
var nt = Symbol("emittedEnd");
var De = Symbol("emittingEnd");
var qt = Symbol("emittedError");
var Ne = Symbol("closed");
var Ns = Symbol("read");
var Ae = Symbol("flush");
var As = Symbol("flushChunk");
var z = Symbol("encoding");
var Mt = Symbol("decoder");
var g = Symbol("flowing");
var Qt = Symbol("paused");
var Bt = Symbol("resume");
var b = Symbol("buffer");
var N = Symbol("pipes");
var _ = Symbol("bufferLength");
var bi = Symbol("bufferPush");
var Ie = Symbol("bufferShift");
var L = Symbol("objectMode");
var S = Symbol("destroyed");
var _i = Symbol("error");
var Oi = Symbol("emitData");
var Is = Symbol("emitEnd");
var Ti = Symbol("emitEnd2");
var Z = Symbol("async");
var xi = Symbol("abort");
var Ce = Symbol("aborted");
var Jt = Symbol("signal");
var Rt = Symbol("dataListeners");
var C = Symbol("discarded");
var jt = (s) => Promise.resolve().then(s);
var Yr = (s) => s();
var Kr = (s) => s === "end" || s === "finish" || s === "prefinish";
var Vr = (s) => s instanceof ArrayBuffer || !!s && typeof s == "object" && s.constructor && s.constructor.name === "ArrayBuffer" && s.byteLength >= 0;
var $r = (s) => !Buffer.isBuffer(s) && ArrayBuffer.isView(s);
var Fe = class {
  src;
  dest;
  opts;
  ondrain;
  constructor(t, e, i) {
    this.src = t, this.dest = e, this.opts = i, this.ondrain = () => t[Bt](), this.dest.on("drain", this.ondrain);
  }
  unpipe() {
    this.dest.removeListener("drain", this.ondrain);
  }
  proxyErrors(t) {}
  end() {
    this.unpipe(), this.opts.end && this.dest.end();
  }
};
var Li = class extends Fe {
  unpipe() {
    this.src.removeListener("error", this.proxyErrors), super.unpipe();
  }
  constructor(t, e, i) {
    super(t, e, i), this.proxyErrors = (r) => this.dest.emit("error", r), t.on("error", this.proxyErrors);
  }
};
var Xr = (s) => !!s.objectMode;
var qr = (s) => !s.objectMode && !!s.encoding && s.encoding !== "buffer";
var A = class extends Di {
  [g] = false;
  [Qt] = false;
  [N] = [];
  [b] = [];
  [L];
  [z];
  [Z];
  [Mt];
  [Q] = false;
  [nt] = false;
  [De] = false;
  [Ne] = false;
  [qt] = null;
  [_] = 0;
  [S] = false;
  [Jt];
  [Ce] = false;
  [Rt] = 0;
  [C] = false;
  writable = true;
  readable = true;
  constructor(...t) {
    let e = t[0] || {};
    if (super(), e.objectMode && typeof e.encoding == "string")
      throw new TypeError("Encoding and objectMode may not be used together");
    Xr(e) ? (this[L] = true, this[z] = null) : qr(e) ? (this[z] = e.encoding, this[L] = false) : (this[L] = false, this[z] = null), this[Z] = !!e.async, this[Mt] = this[z] ? new Hr(this[z]) : null, e && e.debugExposeBuffer === true && Object.defineProperty(this, "buffer", { get: () => this[b] }), e && e.debugExposePipes === true && Object.defineProperty(this, "pipes", { get: () => this[N] });
    let { signal: i } = e;
    i && (this[Jt] = i, i.aborted ? this[xi]() : i.addEventListener("abort", () => this[xi]()));
  }
  get bufferLength() {
    return this[_];
  }
  get encoding() {
    return this[z];
  }
  set encoding(t) {
    throw new Error("Encoding must be set at instantiation time");
  }
  setEncoding(t) {
    throw new Error("Encoding must be set at instantiation time");
  }
  get objectMode() {
    return this[L];
  }
  set objectMode(t) {
    throw new Error("objectMode must be set at instantiation time");
  }
  get async() {
    return this[Z];
  }
  set async(t) {
    this[Z] = this[Z] || !!t;
  }
  [xi]() {
    this[Ce] = true, this.emit("abort", this[Jt]?.reason), this.destroy(this[Jt]?.reason);
  }
  get aborted() {
    return this[Ce];
  }
  set aborted(t) {}
  write(t, e, i) {
    if (this[Ce])
      return false;
    if (this[Q])
      throw new Error("write after end");
    if (this[S])
      return this.emit("error", Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" })), true;
    typeof e == "function" && (i = e, e = "utf8"), e || (e = "utf8");
    let r = this[Z] ? jt : Yr;
    if (!this[L] && !Buffer.isBuffer(t)) {
      if ($r(t))
        t = Buffer.from(t.buffer, t.byteOffset, t.byteLength);
      else if (Vr(t))
        t = Buffer.from(t);
      else if (typeof t != "string")
        throw new Error("Non-contiguous data written to non-objectMode stream");
    }
    return this[L] ? (this[g] && this[_] !== 0 && this[Ae](true), this[g] ? this.emit("data", t) : this[bi](t), this[_] !== 0 && this.emit("readable"), i && r(i), this[g]) : t.length ? (typeof t == "string" && !(e === this[z] && !this[Mt]?.lastNeed) && (t = Buffer.from(t, e)), Buffer.isBuffer(t) && this[z] && (t = this[Mt].write(t)), this[g] && this[_] !== 0 && this[Ae](true), this[g] ? this.emit("data", t) : this[bi](t), this[_] !== 0 && this.emit("readable"), i && r(i), this[g]) : (this[_] !== 0 && this.emit("readable"), i && r(i), this[g]);
  }
  read(t) {
    if (this[S])
      return null;
    if (this[C] = false, this[_] === 0 || t === 0 || t && t > this[_])
      return this[J](), null;
    this[L] && (t = null), this[b].length > 1 && !this[L] && (this[b] = [this[z] ? this[b].join("") : Buffer.concat(this[b], this[_])]);
    let e = this[Ns](t || null, this[b][0]);
    return this[J](), e;
  }
  [Ns](t, e) {
    if (this[L])
      this[Ie]();
    else {
      let i = e;
      t === i.length || t === null ? this[Ie]() : typeof i == "string" ? (this[b][0] = i.slice(t), e = i.slice(0, t), this[_] -= t) : (this[b][0] = i.subarray(t), e = i.subarray(0, t), this[_] -= t);
    }
    return this.emit("data", e), !this[b].length && !this[Q] && this.emit("drain"), e;
  }
  end(t, e, i) {
    return typeof t == "function" && (i = t, t = undefined), typeof e == "function" && (i = e, e = "utf8"), t !== undefined && this.write(t, e), i && this.once("end", i), this[Q] = true, this.writable = false, (this[g] || !this[Qt]) && this[J](), this;
  }
  [Bt]() {
    this[S] || (!this[Rt] && !this[N].length && (this[C] = true), this[Qt] = false, this[g] = true, this.emit("resume"), this[b].length ? this[Ae]() : this[Q] ? this[J]() : this.emit("drain"));
  }
  resume() {
    return this[Bt]();
  }
  pause() {
    this[g] = false, this[Qt] = true, this[C] = false;
  }
  get destroyed() {
    return this[S];
  }
  get flowing() {
    return this[g];
  }
  get paused() {
    return this[Qt];
  }
  [bi](t) {
    this[L] ? this[_] += 1 : this[_] += t.length, this[b].push(t);
  }
  [Ie]() {
    return this[L] ? this[_] -= 1 : this[_] -= this[b][0].length, this[b].shift();
  }
  [Ae](t = false) {
    do
      ;
    while (this[As](this[Ie]()) && this[b].length);
    !t && !this[b].length && !this[Q] && this.emit("drain");
  }
  [As](t) {
    return this.emit("data", t), this[g];
  }
  pipe(t, e) {
    if (this[S])
      return t;
    this[C] = false;
    let i = this[nt];
    return e = e || {}, t === Ds.stdout || t === Ds.stderr ? e.end = false : e.end = e.end !== false, e.proxyErrors = !!e.proxyErrors, i ? e.end && t.end() : (this[N].push(e.proxyErrors ? new Li(this, t, e) : new Fe(this, t, e)), this[Z] ? jt(() => this[Bt]()) : this[Bt]()), t;
  }
  unpipe(t) {
    let e = this[N].find((i) => i.dest === t);
    e && (this[N].length === 1 ? (this[g] && this[Rt] === 0 && (this[g] = false), this[N] = []) : this[N].splice(this[N].indexOf(e), 1), e.unpipe());
  }
  addListener(t, e) {
    return this.on(t, e);
  }
  on(t, e) {
    let i = super.on(t, e);
    if (t === "data")
      this[C] = false, this[Rt]++, !this[N].length && !this[g] && this[Bt]();
    else if (t === "readable" && this[_] !== 0)
      super.emit("readable");
    else if (Kr(t) && this[nt])
      super.emit(t), this.removeAllListeners(t);
    else if (t === "error" && this[qt]) {
      let r = e;
      this[Z] ? jt(() => r.call(this, this[qt])) : r.call(this, this[qt]);
    }
    return i;
  }
  removeListener(t, e) {
    return this.off(t, e);
  }
  off(t, e) {
    let i = super.off(t, e);
    return t === "data" && (this[Rt] = this.listeners("data").length, this[Rt] === 0 && !this[C] && !this[N].length && (this[g] = false)), i;
  }
  removeAllListeners(t) {
    let e = super.removeAllListeners(t);
    return (t === "data" || t === undefined) && (this[Rt] = 0, !this[C] && !this[N].length && (this[g] = false)), e;
  }
  get emittedEnd() {
    return this[nt];
  }
  [J]() {
    !this[De] && !this[nt] && !this[S] && this[b].length === 0 && this[Q] && (this[De] = true, this.emit("end"), this.emit("prefinish"), this.emit("finish"), this[Ne] && this.emit("close"), this[De] = false);
  }
  emit(t, ...e) {
    let i = e[0];
    if (t !== "error" && t !== "close" && t !== S && this[S])
      return false;
    if (t === "data")
      return !this[L] && !i ? false : this[Z] ? (jt(() => this[Oi](i)), true) : this[Oi](i);
    if (t === "end")
      return this[Is]();
    if (t === "close") {
      if (this[Ne] = true, !this[nt] && !this[S])
        return false;
      let n = super.emit("close");
      return this.removeAllListeners("close"), n;
    } else if (t === "error") {
      this[qt] = i, super.emit(_i, i);
      let n = !this[Jt] || this.listeners("error").length ? super.emit("error", i) : false;
      return this[J](), n;
    } else if (t === "resume") {
      let n = super.emit("resume");
      return this[J](), n;
    } else if (t === "finish" || t === "prefinish") {
      let n = super.emit(t);
      return this.removeAllListeners(t), n;
    }
    let r = super.emit(t, ...e);
    return this[J](), r;
  }
  [Oi](t) {
    for (let i of this[N])
      i.dest.write(t) === false && this.pause();
    let e = this[C] ? false : super.emit("data", t);
    return this[J](), e;
  }
  [Is]() {
    return this[nt] ? false : (this[nt] = true, this.readable = false, this[Z] ? (jt(() => this[Ti]()), true) : this[Ti]());
  }
  [Ti]() {
    if (this[Mt]) {
      let e = this[Mt].end();
      if (e) {
        for (let i of this[N])
          i.dest.write(e);
        this[C] || super.emit("data", e);
      }
    }
    for (let e of this[N])
      e.end();
    let t = super.emit("end");
    return this.removeAllListeners("end"), t;
  }
  async collect() {
    let t = Object.assign([], { dataLength: 0 });
    this[L] || (t.dataLength = 0);
    let e = this.promise();
    return this.on("data", (i) => {
      t.push(i), this[L] || (t.dataLength += i.length);
    }), await e, t;
  }
  async concat() {
    if (this[L])
      throw new Error("cannot concat in objectMode");
    let t = await this.collect();
    return this[z] ? t.join("") : Buffer.concat(t, t.dataLength);
  }
  async promise() {
    return new Promise((t, e) => {
      this.on(S, () => e(new Error("stream destroyed"))), this.on("error", (i) => e(i)), this.on("end", () => t());
    });
  }
  [Symbol.asyncIterator]() {
    this[C] = false;
    let t = false, e = async () => (this.pause(), t = true, { value: undefined, done: true });
    return { next: () => {
      if (t)
        return e();
      let r = this.read();
      if (r !== null)
        return Promise.resolve({ done: false, value: r });
      if (this[Q])
        return e();
      let n, o, h = (d) => {
        this.off("data", a), this.off("end", l), this.off(S, c), e(), o(d);
      }, a = (d) => {
        this.off("error", h), this.off("end", l), this.off(S, c), this.pause(), n({ value: d, done: !!this[Q] });
      }, l = () => {
        this.off("error", h), this.off("data", a), this.off(S, c), e(), n({ done: true, value: undefined });
      }, c = () => h(new Error("stream destroyed"));
      return new Promise((d, y) => {
        o = y, n = d, this.once(S, c), this.once("error", h), this.once("end", l), this.once("data", a);
      });
    }, throw: e, return: e, [Symbol.asyncIterator]() {
      return this;
    }, [Symbol.asyncDispose]: async () => {} };
  }
  [Symbol.iterator]() {
    this[C] = false;
    let t = false, e = () => (this.pause(), this.off(_i, e), this.off(S, e), this.off("end", e), t = true, { done: true, value: undefined }), i = () => {
      if (t)
        return e();
      let r = this.read();
      return r === null ? e() : { done: false, value: r };
    };
    return this.once("end", e), this.once(_i, e), this.once(S, e), { next: i, throw: e, return: e, [Symbol.iterator]() {
      return this;
    }, [Symbol.dispose]: () => {} };
  }
  destroy(t) {
    if (this[S])
      return t ? this.emit("error", t) : this.emit(S), this;
    this[S] = true, this[C] = true, this[b].length = 0, this[_] = 0;
    let e = this;
    return typeof e.close == "function" && !this[Ne] && e.close(), t ? this.emit("error", t) : this.emit(S), this;
  }
  static get isStream() {
    return Wr;
  }
};
var Jr = I.writev;
var ht = Symbol("_autoClose");
var H = Symbol("_close");
var te = Symbol("_ended");
var m = Symbol("_fd");
var Ni = Symbol("_finished");
var tt = Symbol("_flags");
var Ai = Symbol("_flush");
var ki = Symbol("_handleChunk");
var vi = Symbol("_makeBuf");
var ie = Symbol("_mode");
var ke = Symbol("_needDrain");
var Ut = Symbol("_onerror");
var Ht = Symbol("_onopen");
var Ii = Symbol("_onread");
var Pt = Symbol("_onwrite");
var at = Symbol("_open");
var U = Symbol("_path");
var ot = Symbol("_pos");
var Y = Symbol("_queue");
var zt = Symbol("_read");
var Ci = Symbol("_readSize");
var j = Symbol("_reading");
var ee = Symbol("_remain");
var Fi = Symbol("_size");
var ve = Symbol("_write");
var gt = Symbol("_writing");
var Me = Symbol("_defaultFlag");
var bt = Symbol("_errored");
var _t = class extends A {
  [bt] = false;
  [m];
  [U];
  [Ci];
  [j] = false;
  [Fi];
  [ee];
  [ht];
  constructor(t, e) {
    if (e = e || {}, super(e), this.readable = true, this.writable = false, typeof t != "string")
      throw new TypeError("path must be a string");
    this[bt] = false, this[m] = typeof e.fd == "number" ? e.fd : undefined, this[U] = t, this[Ci] = e.readSize || 16 * 1024 * 1024, this[j] = false, this[Fi] = typeof e.size == "number" ? e.size : 1 / 0, this[ee] = this[Fi], this[ht] = typeof e.autoClose == "boolean" ? e.autoClose : true, typeof this[m] == "number" ? this[zt]() : this[at]();
  }
  get fd() {
    return this[m];
  }
  get path() {
    return this[U];
  }
  write() {
    throw new TypeError("this is a readable stream");
  }
  end() {
    throw new TypeError("this is a readable stream");
  }
  [at]() {
    I.open(this[U], "r", (t, e) => this[Ht](t, e));
  }
  [Ht](t, e) {
    t ? this[Ut](t) : (this[m] = e, this.emit("open", e), this[zt]());
  }
  [vi]() {
    return Buffer.allocUnsafe(Math.min(this[Ci], this[ee]));
  }
  [zt]() {
    if (!this[j]) {
      this[j] = true;
      let t = this[vi]();
      if (t.length === 0)
        return process.nextTick(() => this[Ii](null, 0, t));
      I.read(this[m], t, 0, t.length, null, (e, i, r) => this[Ii](e, i, r));
    }
  }
  [Ii](t, e, i) {
    this[j] = false, t ? this[Ut](t) : this[ki](e, i) && this[zt]();
  }
  [H]() {
    if (this[ht] && typeof this[m] == "number") {
      let t = this[m];
      this[m] = undefined, I.close(t, (e) => e ? this.emit("error", e) : this.emit("close"));
    }
  }
  [Ut](t) {
    this[j] = true, this[H](), this.emit("error", t);
  }
  [ki](t, e) {
    let i = false;
    return this[ee] -= t, t > 0 && (i = super.write(t < e.length ? e.subarray(0, t) : e)), (t === 0 || this[ee] <= 0) && (i = false, this[H](), super.end()), i;
  }
  emit(t, ...e) {
    switch (t) {
      case "prefinish":
      case "finish":
        return false;
      case "drain":
        return typeof this[m] == "number" && this[zt](), false;
      case "error":
        return this[bt] ? false : (this[bt] = true, super.emit(t, ...e));
      default:
        return super.emit(t, ...e);
    }
  }
};
var Be = class extends _t {
  [at]() {
    let t = true;
    try {
      this[Ht](null, I.openSync(this[U], "r")), t = false;
    } finally {
      t && this[H]();
    }
  }
  [zt]() {
    let t = true;
    try {
      if (!this[j]) {
        this[j] = true;
        do {
          let e = this[vi](), i = e.length === 0 ? 0 : I.readSync(this[m], e, 0, e.length, null);
          if (!this[ki](i, e))
            break;
        } while (true);
        this[j] = false;
      }
      t = false;
    } finally {
      t && this[H]();
    }
  }
  [H]() {
    if (this[ht] && typeof this[m] == "number") {
      let t = this[m];
      this[m] = undefined, I.closeSync(t), this.emit("close");
    }
  }
};
var et = class extends Qr {
  readable = false;
  writable = true;
  [bt] = false;
  [gt] = false;
  [te] = false;
  [Y] = [];
  [ke] = false;
  [U];
  [ie];
  [ht];
  [m];
  [Me];
  [tt];
  [Ni] = false;
  [ot];
  constructor(t, e) {
    e = e || {}, super(e), this[U] = t, this[m] = typeof e.fd == "number" ? e.fd : undefined, this[ie] = e.mode === undefined ? 438 : e.mode, this[ot] = typeof e.start == "number" ? e.start : undefined, this[ht] = typeof e.autoClose == "boolean" ? e.autoClose : true;
    let i = this[ot] !== undefined ? "r+" : "w";
    this[Me] = e.flags === undefined, this[tt] = e.flags === undefined ? i : e.flags, this[m] === undefined && this[at]();
  }
  emit(t, ...e) {
    if (t === "error") {
      if (this[bt])
        return false;
      this[bt] = true;
    }
    return super.emit(t, ...e);
  }
  get fd() {
    return this[m];
  }
  get path() {
    return this[U];
  }
  [Ut](t) {
    this[H](), this[gt] = true, this.emit("error", t);
  }
  [at]() {
    I.open(this[U], this[tt], this[ie], (t, e) => this[Ht](t, e));
  }
  [Ht](t, e) {
    this[Me] && this[tt] === "r+" && t && t.code === "ENOENT" ? (this[tt] = "w", this[at]()) : t ? this[Ut](t) : (this[m] = e, this.emit("open", e), this[gt] || this[Ai]());
  }
  end(t, e) {
    return t && this.write(t, e), this[te] = true, !this[gt] && !this[Y].length && typeof this[m] == "number" && this[Pt](null, 0), this;
  }
  write(t, e) {
    return typeof t == "string" && (t = Buffer.from(t, e)), this[te] ? (this.emit("error", new Error("write() after end()")), false) : this[m] === undefined || this[gt] || this[Y].length ? (this[Y].push(t), this[ke] = true, false) : (this[gt] = true, this[ve](t), true);
  }
  [ve](t) {
    I.write(this[m], t, 0, t.length, this[ot], (e, i) => this[Pt](e, i));
  }
  [Pt](t, e) {
    t ? this[Ut](t) : (this[ot] !== undefined && typeof e == "number" && (this[ot] += e), this[Y].length ? this[Ai]() : (this[gt] = false, this[te] && !this[Ni] ? (this[Ni] = true, this[H](), this.emit("finish")) : this[ke] && (this[ke] = false, this.emit("drain"))));
  }
  [Ai]() {
    if (this[Y].length === 0)
      this[te] && this[Pt](null, 0);
    else if (this[Y].length === 1)
      this[ve](this[Y].pop());
    else {
      let t = this[Y];
      this[Y] = [], Jr(this[m], t, this[ot], (e, i) => this[Pt](e, i));
    }
  }
  [H]() {
    if (this[ht] && typeof this[m] == "number") {
      let t = this[m];
      this[m] = undefined, I.close(t, (e) => e ? this.emit("error", e) : this.emit("close"));
    }
  }
};
var Wt = class extends et {
  [at]() {
    let t;
    if (this[Me] && this[tt] === "r+")
      try {
        t = I.openSync(this[U], this[tt], this[ie]);
      } catch (e) {
        if (e?.code === "ENOENT")
          return this[tt] = "w", this[at]();
        throw e;
      }
    else
      t = I.openSync(this[U], this[tt], this[ie]);
    this[Ht](null, t);
  }
  [H]() {
    if (this[ht] && typeof this[m] == "number") {
      let t = this[m];
      this[m] = undefined, I.closeSync(t), this.emit("close");
    }
  }
  [ve](t) {
    let e = true;
    try {
      this[Pt](null, I.writeSync(this[m], t, 0, t.length, this[ot])), e = false;
    } finally {
      if (e)
        try {
          this[H]();
        } catch {}
    }
  }
};
var jr = new Map([["C", "cwd"], ["f", "file"], ["z", "gzip"], ["P", "preservePaths"], ["U", "unlink"], ["strip-components", "strip"], ["stripComponents", "strip"], ["keep-newer", "newer"], ["keepNewer", "newer"], ["keep-newer-files", "newer"], ["keepNewerFiles", "newer"], ["k", "keep"], ["keep-existing", "keep"], ["keepExisting", "keep"], ["m", "noMtime"], ["no-mtime", "noMtime"], ["p", "preserveOwner"], ["L", "follow"], ["h", "follow"], ["onentry", "onReadEntry"]]);
var Fs = (s) => !!s.sync && !!s.file;
var ks = (s) => !s.sync && !!s.file;
var vs = (s) => !!s.sync && !s.file;
var Ms = (s) => !s.sync && !s.file;
var Bs = (s) => !!s.file;
var tn = (s) => {
  let t = jr.get(s);
  return t || s;
};
var se = (s = {}) => {
  if (!s)
    return {};
  let t = {};
  for (let [e, i] of Object.entries(s)) {
    let r = tn(e);
    t[r] = i;
  }
  return t.chmod === undefined && t.noChmod === false && (t.chmod = true), delete t.noChmod, t;
};
var K = (s, t, e, i, r) => Object.assign((n = [], o, h) => {
  Array.isArray(n) && (o = n, n = {}), typeof o == "function" && (h = o, o = undefined), o = o ? Array.from(o) : [];
  let a = se(n);
  if (r?.(a, o), Fs(a)) {
    if (typeof h == "function")
      throw new TypeError("callback not supported for sync tar functions");
    return s(a, o);
  } else if (ks(a)) {
    let l = t(a, o);
    return h ? l.then(() => h(), h) : l;
  } else if (vs(a)) {
    if (typeof h == "function")
      throw new TypeError("callback not supported for sync tar functions");
    return e(a, o);
  } else if (Ms(a)) {
    if (typeof h == "function")
      throw new TypeError("callback only supported with file option");
    return i(a, o);
  }
  throw new Error("impossible options??");
}, { syncFile: s, asyncFile: t, syncNoFile: e, asyncNoFile: i, validate: r });
var sn = en.constants || { ZLIB_VERNUM: 4736 };
var M = Object.freeze(Object.assign(Object.create(null), { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7, BROTLI_DECODE: 8, BROTLI_ENCODE: 9, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: 1 / 0, Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1, BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2, BROTLI_DEFAULT_MODE: 0, BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_LARGE_MAX_WINDOW_BITS: 30, BROTLI_DEFAULT_WINDOW: 22, BROTLI_MIN_INPUT_BLOCK_BITS: 16, BROTLI_MAX_INPUT_BLOCK_BITS: 24, BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_LGWIN: 2, BROTLI_PARAM_LGBLOCK: 3, BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4, BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6, BROTLI_PARAM_NPOSTFIX: 7, BROTLI_PARAM_NDIRECT: 8, BROTLI_DECODER_RESULT_ERROR: 0, BROTLI_DECODER_RESULT_SUCCESS: 1, BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0, BROTLI_DECODER_PARAM_LARGE_WINDOW: 1, BROTLI_DECODER_NO_ERROR: 0, BROTLI_DECODER_SUCCESS: 1, BROTLI_DECODER_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1, BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2, BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5, BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6, BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7, BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10, BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11, BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12, BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13, BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14, BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15, BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16, BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19, BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21, BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27, BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30, BROTLI_DECODER_ERROR_UNREACHABLE: -31 }, sn));
var rn = Ot.concat;
var zs = Object.getOwnPropertyDescriptor(Ot, "concat");
var nn = (s) => s;
var Bi = zs?.writable === true || zs?.set !== undefined ? (s) => {
  Ot.concat = s ? nn : rn;
} : (s) => {};
var Tt = Symbol("_superWrite");
var Gt = class extends Error {
  code;
  errno;
  constructor(t, e) {
    super("zlib: " + t.message, { cause: t }), this.code = t.code, this.errno = t.errno, this.code || (this.code = "ZLIB_ERROR"), this.message = "zlib: " + t.message, Error.captureStackTrace(this, e ?? this.constructor);
  }
  get name() {
    return "ZlibError";
  }
};
var Pi = Symbol("flushFlag");
var re = class extends A {
  #t = false;
  #i = false;
  #s;
  #n;
  #r;
  #e;
  #o;
  get sawError() {
    return this.#t;
  }
  get handle() {
    return this.#e;
  }
  get flushFlag() {
    return this.#s;
  }
  constructor(t, e) {
    if (!t || typeof t != "object")
      throw new TypeError("invalid options for ZlibBase constructor");
    if (super(t), this.#s = t.flush ?? 0, this.#n = t.finishFlush ?? 0, this.#r = t.fullFlushFlag ?? 0, typeof Ps[e] != "function")
      throw new TypeError("Compression method not supported: " + e);
    try {
      this.#e = new Ps[e](t);
    } catch (i) {
      throw new Gt(i, this.constructor);
    }
    this.#o = (i) => {
      this.#t || (this.#t = true, this.close(), this.emit("error", i));
    }, this.#e?.on("error", (i) => this.#o(new Gt(i))), this.once("end", () => this.close);
  }
  close() {
    this.#e && (this.#e.close(), this.#e = undefined, this.emit("close"));
  }
  reset() {
    if (!this.#t)
      return zi(this.#e, "zlib binding closed"), this.#e.reset?.();
  }
  flush(t) {
    this.ended || (typeof t != "number" && (t = this.#r), this.write(Object.assign(Ot.alloc(0), { [Pi]: t })));
  }
  end(t, e, i) {
    return typeof t == "function" && (i = t, e = undefined, t = undefined), typeof e == "function" && (i = e, e = undefined), t && (e ? this.write(t, e) : this.write(t)), this.flush(this.#n), this.#i = true, super.end(i);
  }
  get ended() {
    return this.#i;
  }
  [Tt](t) {
    return super.write(t);
  }
  write(t, e, i) {
    if (typeof e == "function" && (i = e, e = "utf8"), typeof t == "string" && (t = Ot.from(t, e)), this.#t)
      return;
    zi(this.#e, "zlib binding closed");
    let r = this.#e._handle, n = r.close;
    r.close = () => {};
    let o = this.#e.close;
    this.#e.close = () => {}, Bi(true);
    let h;
    try {
      let l = typeof t[Pi] == "number" ? t[Pi] : this.#s;
      h = this.#e._processChunk(t, l), Bi(false);
    } catch (l) {
      Bi(false), this.#o(new Gt(l, this.write));
    } finally {
      this.#e && (this.#e._handle = r, r.close = n, this.#e.close = o, this.#e.removeAllListeners("error"));
    }
    this.#e && this.#e.on("error", (l) => this.#o(new Gt(l, this.write)));
    let a;
    if (h)
      if (Array.isArray(h) && h.length > 0) {
        let l = h[0];
        a = this[Tt](Ot.from(l));
        for (let c = 1;c < h.length; c++)
          a = this[Tt](h[c]);
      } else
        a = this[Tt](Ot.from(h));
    return i && i(), a;
  }
};
var Pe = class extends re {
  #t;
  #i;
  constructor(t, e) {
    t = t || {}, t.flush = t.flush || M.Z_NO_FLUSH, t.finishFlush = t.finishFlush || M.Z_FINISH, t.fullFlushFlag = M.Z_FULL_FLUSH, super(t, e), this.#t = t.level, this.#i = t.strategy;
  }
  params(t, e) {
    if (!this.sawError) {
      if (!this.handle)
        throw new Error("cannot switch params when binding is closed");
      if (!this.handle.params)
        throw new Error("not supported in this implementation");
      if (this.#t !== t || this.#i !== e) {
        this.flush(M.Z_SYNC_FLUSH), zi(this.handle, "zlib binding closed");
        let i = this.handle.flush;
        this.handle.flush = (r, n) => {
          typeof r == "function" && (n = r, r = this.flushFlag), this.flush(r), n?.();
        };
        try {
          this.handle.params(t, e);
        } finally {
          this.handle.flush = i;
        }
        this.handle && (this.#t = t, this.#i = e);
      }
    }
  }
};
var ze = class extends Pe {
  #t;
  constructor(t) {
    super(t, "Gzip"), this.#t = t && !!t.portable;
  }
  [Tt](t) {
    return this.#t ? (this.#t = false, t[9] = 255, super[Tt](t)) : super[Tt](t);
  }
};
var Ue = class extends Pe {
  constructor(t) {
    super(t, "Unzip");
  }
};
var He = class extends re {
  constructor(t, e) {
    t = t || {}, t.flush = t.flush || M.BROTLI_OPERATION_PROCESS, t.finishFlush = t.finishFlush || M.BROTLI_OPERATION_FINISH, t.fullFlushFlag = M.BROTLI_OPERATION_FLUSH, super(t, e);
  }
};
var We = class extends He {
  constructor(t) {
    super(t, "BrotliCompress");
  }
};
var Ge = class extends He {
  constructor(t) {
    super(t, "BrotliDecompress");
  }
};
var Ze = class extends re {
  constructor(t, e) {
    t = t || {}, t.flush = t.flush || M.ZSTD_e_continue, t.finishFlush = t.finishFlush || M.ZSTD_e_end, t.fullFlushFlag = M.ZSTD_e_flush, super(t, e);
  }
};
var Ye = class extends Ze {
  constructor(t) {
    super(t, "ZstdCompress");
  }
};
var Ke = class extends Ze {
  constructor(t) {
    super(t, "ZstdDecompress");
  }
};
var Us = (s, t) => {
  if (Number.isSafeInteger(s))
    s < 0 ? an(s, t) : hn(s, t);
  else
    throw Error("cannot encode number outside of javascript safe integer range");
  return t;
};
var hn = (s, t) => {
  t[0] = 128;
  for (var e = t.length;e > 1; e--)
    t[e - 1] = s & 255, s = Math.floor(s / 256);
};
var an = (s, t) => {
  t[0] = 255;
  var e = false;
  s = s * -1;
  for (var i = t.length;i > 1; i--) {
    var r = s & 255;
    s = Math.floor(s / 256), e ? t[i - 1] = Ws(r) : r === 0 ? t[i - 1] = 0 : (e = true, t[i - 1] = Gs(r));
  }
};
var Hs = (s) => {
  let t = s[0], e = t === 128 ? cn(s.subarray(1, s.length)) : t === 255 ? ln(s) : null;
  if (e === null)
    throw Error("invalid base256 encoding");
  if (!Number.isSafeInteger(e))
    throw Error("parsed number outside of javascript safe integer range");
  return e;
};
var ln = (s) => {
  for (var t = s.length, e = 0, i = false, r = t - 1;r > -1; r--) {
    var n = Number(s[r]), o;
    i ? o = Ws(n) : n === 0 ? o = n : (i = true, o = Gs(n)), o !== 0 && (e -= o * Math.pow(256, t - r - 1));
  }
  return e;
};
var cn = (s) => {
  for (var t = s.length, e = 0, i = t - 1;i > -1; i--) {
    var r = Number(s[i]);
    r !== 0 && (e += r * Math.pow(256, t - i - 1));
  }
  return e;
};
var Ws = (s) => (255 ^ s) & 255;
var Gs = (s) => (255 ^ s) + 1 & 255;
var Hi = {};
Ur(Hi, { code: () => Ve, isCode: () => ne, isName: () => dn, name: () => oe, normalFsTypes: () => Ui });
var ne = (s) => oe.has(s);
var dn = (s) => Ve.has(s);
var Ui = new Set(["0", "", "1", "2", "3", "4", "5", "6", "7", "D"]);
var oe = new Map([["0", "File"], ["", "OldFile"], ["1", "Link"], ["2", "SymbolicLink"], ["3", "CharacterDevice"], ["4", "BlockDevice"], ["5", "Directory"], ["6", "FIFO"], ["7", "ContiguousFile"], ["g", "GlobalExtendedHeader"], ["x", "ExtendedHeader"], ["A", "SolarisACL"], ["D", "GNUDumpDir"], ["I", "Inode"], ["K", "NextFileHasLongLinkpath"], ["L", "NextFileHasLongPath"], ["M", "ContinuationFile"], ["N", "OldGnuLongPath"], ["S", "SparseFile"], ["V", "TapeVolumeHeader"], ["X", "OldExtendedHeader"]]);
var Ve = new Map(Array.from(oe).map((s) => [s[1], s[0]]));
var un = (s) => s === undefined || s < 0 ? undefined : s;
var F = class {
  cksumValid = false;
  needPax = false;
  nullBlock = false;
  block;
  path;
  mode;
  uid;
  gid;
  size;
  cksum;
  #t = "Unsupported";
  linkpath;
  uname;
  gname;
  devmaj = 0;
  devmin = 0;
  atime;
  ctime;
  mtime;
  charset;
  comment;
  constructor(t, e = 0, i, r) {
    Buffer.isBuffer(t) ? this.decode(t, e || 0, i, r) : t && this.#i(t);
  }
  decode(t, e, i, r) {
    if (e || (e = 0), !t || !(t.length >= e + 512))
      throw new Error("need 512 bytes for header");
    let n = xt(t, e + 156, 1), o = Ui.has(n), h = o ? i : undefined, a = o ? r : undefined;
    if (this.path = h?.path ?? xt(t, e, 100), this.mode = h?.mode ?? a?.mode ?? lt(t, e + 100, 8), this.uid = h?.uid ?? a?.uid ?? lt(t, e + 108, 8), this.gid = h?.gid ?? a?.gid ?? lt(t, e + 116, 8), this.size = un(h?.size ?? a?.size ?? lt(t, e + 124, 12)), this.mtime = h?.mtime ?? a?.mtime ?? Wi(t, e + 136, 12), this.cksum = lt(t, e + 148, 12), a && this.#i(a, true), h && this.#i(h), ne(n) && (this.#t = n || "0"), this.#t === "0" && this.path.slice(-1) === "/" && (this.#t = "5"), this.#t === "5" && (this.size = 0), this.linkpath = xt(t, e + 157, 100), t.subarray(e + 257, e + 265).toString() === "ustar\x0000")
      if (this.uname = h?.uname ?? a?.uname ?? xt(t, e + 265, 32), this.gname = h?.gname ?? a?.gname ?? xt(t, e + 297, 32), this.devmaj = h?.devmaj ?? a?.devmaj ?? lt(t, e + 329, 8) ?? 0, this.devmin = h?.devmin ?? a?.devmin ?? lt(t, e + 337, 8) ?? 0, t[e + 475] !== 0) {
        let c = xt(t, e + 345, 155);
        this.path = c + "/" + this.path;
      } else {
        let c = xt(t, e + 345, 130);
        c && (this.path = c + "/" + this.path), this.atime = i?.atime ?? r?.atime ?? Wi(t, e + 476, 12), this.ctime = i?.ctime ?? r?.ctime ?? Wi(t, e + 488, 12);
      }
    let l = 256;
    for (let c = e;c < e + 148; c++)
      l += t[c];
    for (let c = e + 156;c < e + 512; c++)
      l += t[c];
    this.cksumValid = l === this.cksum, this.cksum === undefined && l === 256 && (this.nullBlock = true);
  }
  #i(t, e = false) {
    Object.assign(this, Object.fromEntries(Object.entries(t).filter(([i, r]) => !(r == null || i === "size" && Number(r) < 0 || i === "path" && e || i === "linkpath" && e || i === "global"))));
  }
  encode(t, e = 0) {
    if (t || (t = this.block = Buffer.alloc(512)), this.#t === "Unsupported" && (this.#t = "0"), !(t.length >= e + 512))
      throw new Error("need 512 bytes for header");
    let i = this.ctime || this.atime ? 130 : 155, r = mn(this.path || "", i), n = r[0], o = r[1];
    this.needPax = !!r[2], this.needPax = Lt(t, e, 100, n) || this.needPax, this.needPax = ct(t, e + 100, 8, this.mode) || this.needPax, this.needPax = ct(t, e + 108, 8, this.uid) || this.needPax, this.needPax = ct(t, e + 116, 8, this.gid) || this.needPax, this.needPax = ct(t, e + 124, 12, this.size) || this.needPax, this.needPax = Gi(t, e + 136, 12, this.mtime) || this.needPax, t[e + 156] = Number(this.#t.codePointAt(0)), this.needPax = Lt(t, e + 157, 100, this.linkpath) || this.needPax, t.write("ustar\x0000", e + 257, 8), this.needPax = Lt(t, e + 265, 32, this.uname) || this.needPax, this.needPax = Lt(t, e + 297, 32, this.gname) || this.needPax, this.needPax = ct(t, e + 329, 8, this.devmaj) || this.needPax, this.needPax = ct(t, e + 337, 8, this.devmin) || this.needPax, this.needPax = Lt(t, e + 345, i, o) || this.needPax, t[e + 475] !== 0 ? this.needPax = Lt(t, e + 345, 155, o) || this.needPax : (this.needPax = Lt(t, e + 345, 130, o) || this.needPax, this.needPax = Gi(t, e + 476, 12, this.atime) || this.needPax, this.needPax = Gi(t, e + 488, 12, this.ctime) || this.needPax);
    let h = 256;
    for (let a = e;a < e + 148; a++)
      h += t[a];
    for (let a = e + 156;a < e + 512; a++)
      h += t[a];
    return this.cksum = h, ct(t, e + 148, 8, this.cksum), this.cksumValid = true, this.needPax;
  }
  get type() {
    return this.#t === "Unsupported" ? this.#t : oe.get(this.#t);
  }
  get typeKey() {
    return this.#t;
  }
  set type(t) {
    let e = String(Ve.get(t));
    if (ne(e) || e === "Unsupported")
      this.#t = e;
    else if (ne(t))
      this.#t = t;
    else
      throw new TypeError("invalid entry type: " + t);
  }
};
var mn = (s, t) => {
  let i = s, r = "", n, o = Zt.parse(s).root || ".";
  if (Buffer.byteLength(i) < 100)
    n = [i, r, false];
  else {
    r = Zt.dirname(i), i = Zt.basename(i);
    do
      Buffer.byteLength(i) <= 100 && Buffer.byteLength(r) <= t ? n = [i, r, false] : Buffer.byteLength(i) > 100 && Buffer.byteLength(r) <= t ? n = [i.slice(0, 99), r, true] : (i = Zt.join(Zt.basename(r), i), r = Zt.dirname(r));
    while (r !== o && n === undefined);
    n || (n = [s.slice(0, 99), "", true]);
  }
  return n;
};
var xt = (s, t, e) => s.subarray(t, t + e).toString("utf8").replace(/\0.*/, "");
var Wi = (s, t, e) => pn(lt(s, t, e));
var pn = (s) => s === undefined ? undefined : new Date(s * 1000);
var lt = (s, t, e) => Number(s[t]) & 128 ? Hs(s.subarray(t, t + e)) : wn(s, t, e);
var En = (s) => isNaN(s) ? undefined : s;
var wn = (s, t, e) => En(parseInt(s.subarray(t, t + e).toString("utf8").replace(/\0.*$/, "").trim(), 8));
var Sn = { 12: 8589934591, 8: 2097151 };
var ct = (s, t, e, i) => i === undefined ? false : i > Sn[e] || i < 0 ? (Us(i, s.subarray(t, t + e)), true) : (yn(s, t, e, i), false);
var yn = (s, t, e, i) => s.write(Rn(i, e), t, e, "ascii");
var Rn = (s, t) => gn(Math.floor(s).toString(8), t);
var gn = (s, t) => (s.length === t - 1 ? s : new Array(t - s.length - 1).join("0") + s + " ") + "\x00";
var Gi = (s, t, e, i) => i === undefined ? false : ct(s, t, e, i.getTime() / 1000);
var bn = new Array(156).join("\x00");
var Lt = (s, t, e, i) => i === undefined ? false : (s.write(i + bn, t, e, "utf8"), i.length !== Buffer.byteLength(i) || i.length > e);
var ft = class s {
  atime;
  mtime;
  ctime;
  charset;
  comment;
  gid;
  uid;
  gname;
  uname;
  linkpath;
  dev;
  ino;
  nlink;
  path;
  size;
  mode;
  global;
  constructor(t, e = false) {
    this.atime = t.atime, this.charset = t.charset, this.comment = t.comment, this.ctime = t.ctime, this.dev = t.dev, this.gid = t.gid, this.global = e, this.gname = t.gname, this.ino = t.ino, this.linkpath = t.linkpath, this.mtime = t.mtime, this.nlink = t.nlink, this.path = t.path, this.size = t.size, this.uid = t.uid, this.uname = t.uname;
  }
  encode() {
    let t = this.encodeBody();
    if (t === "")
      return Buffer.allocUnsafe(0);
    let e = Buffer.byteLength(t), i = 512 * Math.ceil(1 + e / 512), r = Buffer.allocUnsafe(i);
    for (let n = 0;n < 512; n++)
      r[n] = 0;
    new F({ path: ("PaxHeader/" + _n(this.path ?? "")).slice(0, 99), mode: this.mode || 420, uid: this.uid, gid: this.gid, size: e, mtime: this.mtime, type: this.global ? "GlobalExtendedHeader" : "ExtendedHeader", linkpath: "", uname: this.uname || "", gname: this.gname || "", devmaj: 0, devmin: 0, atime: this.atime, ctime: this.ctime }).encode(r), r.write(t, 512, e, "utf8");
    for (let n = e + 512;n < r.length; n++)
      r[n] = 0;
    return r;
  }
  encodeBody() {
    return this.encodeField("path") + this.encodeField("ctime") + this.encodeField("atime") + this.encodeField("dev") + this.encodeField("ino") + this.encodeField("nlink") + this.encodeField("charset") + this.encodeField("comment") + this.encodeField("gid") + this.encodeField("gname") + this.encodeField("linkpath") + this.encodeField("mtime") + this.encodeField("size") + this.encodeField("uid") + this.encodeField("uname");
  }
  encodeField(t) {
    if (this[t] === undefined)
      return "";
    let e = this[t], i = e instanceof Date ? e.getTime() / 1000 : e, r = " " + (t === "dev" || t === "ino" || t === "nlink" ? "SCHILY." : "") + t + "=" + i + `
`, n = Buffer.byteLength(r), o = Math.floor(Math.log(n) / Math.log(10)) + 1;
    return n + o >= Math.pow(10, o) && (o += 1), o + n + r;
  }
  static parse(t, e, i = false) {
    return new s(On(Tn(t), e), i);
  }
};
var On = (s, t) => t ? Object.assign({}, t, s) : s;
var Tn = (s) => s.replace(/\n$/, "").split(`
`).reduce(xn, Object.create(null));
var xn = (s, t) => {
  let e = parseInt(t, 10);
  if (e !== Buffer.byteLength(t) + 1)
    return s;
  t = t.slice((e + " ").length);
  let i = t.split("="), r = i.shift();
  if (!r)
    return s;
  let n = r.replace(/^SCHILY\.(dev|ino|nlink)/, "$1"), o = i.join("=").replace(/\0.*/, "");
  switch (n) {
    case "path":
    case "linkpath":
    case "type":
    case "charset":
    case "comment":
    case "gname":
    case "uname":
      s[n] = o;
      break;
    case "ctime":
    case "atime":
    case "mtime":
      s[n] = new Date(Number(o) * 1000);
      break;
    case "size":
      let h = +o;
      h >= 0 && (s[n] = h);
      break;
    case "gid":
    case "uid":
    case "dev":
    case "ino":
    case "nlink":
    case "mode":
      s[n] = +o;
      break;
  }
  return s;
};
var Ln = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
var f = Ln !== "win32" ? (s) => String(s) : (s) => String(s).replaceAll(/\\/g, "/");
var $e = class extends A {
  extended;
  globalExtended;
  header;
  startBlockSize;
  blockRemain;
  remain;
  type;
  meta = false;
  ignore = false;
  path;
  mode;
  uid;
  gid;
  uname;
  gname;
  size = 0;
  mtime;
  atime;
  ctime;
  linkpath;
  dev;
  ino;
  nlink;
  invalid = false;
  absolute;
  unsupported = false;
  constructor(t, e, i) {
    switch (super({}), this.pause(), this.extended = e, this.globalExtended = i, this.header = t, this.remain = t.size ?? 0, this.startBlockSize = 512 * Math.ceil(this.remain / 512), this.blockRemain = this.startBlockSize, this.type = t.type, this.type) {
      case "File":
      case "OldFile":
      case "Link":
      case "SymbolicLink":
      case "CharacterDevice":
      case "BlockDevice":
      case "Directory":
      case "FIFO":
      case "ContiguousFile":
      case "GNUDumpDir":
        break;
      case "NextFileHasLongLinkpath":
      case "NextFileHasLongPath":
      case "OldGnuLongPath":
      case "GlobalExtendedHeader":
      case "ExtendedHeader":
      case "OldExtendedHeader":
        this.meta = true;
        break;
      default:
        this.ignore = true;
    }
    if (!t.path)
      throw new Error("no path provided for tar.ReadEntry");
    this.path = f(t.path), this.mode = t.mode, this.mode && (this.mode = this.mode & 4095), this.uid = t.uid, this.gid = t.gid, this.uname = t.uname, this.gname = t.gname, this.size = this.remain, this.mtime = t.mtime, this.atime = t.atime, this.ctime = t.ctime, this.linkpath = t.linkpath ? f(t.linkpath) : undefined, this.uname = t.uname, this.gname = t.gname, e && this.#t(e), i && this.#t(i, true);
  }
  write(t) {
    let e = t.length;
    if (e > this.blockRemain)
      throw new Error("writing more to entry than is appropriate");
    let i = this.remain, r = this.blockRemain;
    return this.remain = Math.max(0, i - e), this.blockRemain = Math.max(0, r - e), this.ignore ? true : i >= e ? super.write(t) : super.write(t.subarray(0, i));
  }
  #t(t, e = false) {
    t.path && (t.path = f(t.path)), t.linkpath && (t.linkpath = f(t.linkpath)), Object.assign(this, Object.fromEntries(Object.entries(t).filter(([i, r]) => !(r == null || i === "path" && e))));
  }
};
var Dt = (s, t, e, i = {}) => {
  s.file && (i.file = s.file), s.cwd && (i.cwd = s.cwd), i.code = e instanceof Error && e.code || t, i.tarCode = t, !s.strict && i.recoverable !== false ? (e instanceof Error && (i = Object.assign(e, i), e = e.message), s.emit("warn", t, e, i)) : e instanceof Error ? s.emit("error", Object.assign(e, i)) : s.emit("error", Object.assign(new Error(`${t}: ${e}`), i));
};
var Nn = 1024 * 1024;
var Xi = Buffer.from([31, 139]);
var qi = Buffer.from([40, 181, 47, 253]);
var An = Math.max(Xi.length, qi.length);
var B = Symbol("state");
var Nt = Symbol("writeEntry");
var it = Symbol("readEntry");
var Zi = Symbol("nextEntry");
var Zs = Symbol("processEntry");
var V = Symbol("extendedHeader");
var he = Symbol("globalExtendedHeader");
var dt = Symbol("meta");
var Ys = Symbol("emitMeta");
var p = Symbol("buffer");
var st = Symbol("queue");
var ut = Symbol("ended");
var Yi = Symbol("emittedEnd");
var At = Symbol("emit");
var w = Symbol("unzip");
var Xe = Symbol("consumeChunk");
var qe = Symbol("consumeChunkSub");
var Ki = Symbol("consumeBody");
var Ks = Symbol("consumeMeta");
var Vs = Symbol("consumeHeader");
var ae = Symbol("consuming");
var Vi = Symbol("bufferConcat");
var Qe = Symbol("maybeEnd");
var Yt = Symbol("writing");
var $ = Symbol("aborted");
var Je = Symbol("onDone");
var It = Symbol("sawValidEntry");
var je = Symbol("sawNullBlock");
var ti = Symbol("sawEOF");
var $s = Symbol("closeStream");
var In = 1000;
var le = Symbol("compressedBytesRead");
var $i = Symbol("decompressedBytesRead");
var Xs = Symbol("checkDecompressionRatio");
var Cn = () => true;
var rt = class extends Dn {
  file;
  strict;
  maxMetaEntrySize;
  filter;
  brotli;
  zstd;
  maxDecompressionRatio;
  writable = true;
  readable = false;
  [st] = [];
  [p];
  [it];
  [Nt];
  [B] = "begin";
  [dt] = "";
  [V];
  [he];
  [ut] = false;
  [w];
  [$] = false;
  [It];
  [je] = false;
  [ti] = false;
  [Yt] = false;
  [ae] = false;
  [Yi] = false;
  [le] = 0;
  [$i] = 0;
  constructor(t = {}) {
    super(), this.file = t.file || "", this.on(Je, () => {
      (this[B] === "begin" || this[It] === false) && this.warn("TAR_BAD_ARCHIVE", "Unrecognized archive format");
    }), t.ondone ? this.on(Je, t.ondone) : this.on(Je, () => {
      this.emit("prefinish"), this.emit("finish"), this.emit("end");
    }), this.strict = !!t.strict, this.maxDecompressionRatio = typeof t.maxDecompressionRatio == "number" ? t.maxDecompressionRatio : In, this.maxMetaEntrySize = t.maxMetaEntrySize || Nn, this.filter = typeof t.filter == "function" ? t.filter : Cn;
    let e = t.file && (t.file.endsWith(".tar.br") || t.file.endsWith(".tbr"));
    this.brotli = !(t.gzip || t.zstd) && t.brotli !== undefined ? t.brotli : e ? undefined : false;
    let i = t.file && (t.file.endsWith(".tar.zst") || t.file.endsWith(".tzst"));
    this.zstd = !(t.gzip || t.brotli) && t.zstd !== undefined ? t.zstd : i ? true : undefined, this.on("end", () => this[$s]()), typeof t.onwarn == "function" && this.on("warn", t.onwarn), typeof t.onReadEntry == "function" && this.on("entry", t.onReadEntry);
  }
  warn(t, e, i = {}) {
    Dt(this, t, e, i);
  }
  [Vs](t, e) {
    this[It] === undefined && (this[It] = false);
    let i;
    try {
      i = new F(t, e, this[V], this[he]);
    } catch (r) {
      return this.warn("TAR_ENTRY_INVALID", r);
    }
    if (i.nullBlock)
      this[je] ? (this[ti] = true, this[B] === "begin" && (this[B] = "header"), this[At]("eof")) : (this[je] = true, this[At]("nullBlock"));
    else if (this[je] = false, !i.cksumValid)
      this.warn("TAR_ENTRY_INVALID", "checksum failure", { header: i });
    else if (!i.path)
      this.warn("TAR_ENTRY_INVALID", "path is required", { header: i });
    else {
      let r = i.type;
      if (/^(Symbolic)?Link$/.test(r) && !i.linkpath)
        this.warn("TAR_ENTRY_INVALID", "linkpath required", { header: i });
      else if (!/^(Symbolic)?Link$/.test(r) && !/^(Global)?ExtendedHeader$/.test(r) && i.linkpath)
        this.warn("TAR_ENTRY_INVALID", "linkpath forbidden", { header: i });
      else {
        let n = this[Nt] = new $e(i, this[V], this[he]);
        if (!this[It])
          if (n.remain) {
            let o = () => {
              n.invalid || (this[It] = true);
            };
            n.on("end", o);
          } else
            this[It] = true;
        n.meta ? n.size > this.maxMetaEntrySize ? (n.ignore = true, this[At]("ignoredEntry", n), this[B] = "ignore", n.resume()) : n.size > 0 && (this[dt] = "", n.on("data", (o) => this[dt] += o), this[B] = "meta") : (this[V] = undefined, n.ignore = n.ignore || !this.filter(n.path, n), n.ignore ? (this[At]("ignoredEntry", n), this[B] = n.remain ? "ignore" : "header", n.resume()) : (n.remain ? this[B] = "body" : (this[B] = "header", n.end()), this[it] ? this[st].push(n) : (this[st].push(n), this[Zi]())));
      }
    }
  }
  [$s]() {
    queueMicrotask(() => this.emit("close"));
  }
  [Zs](t) {
    let e = true;
    if (!t)
      this[it] = undefined, e = false;
    else if (Array.isArray(t)) {
      let [i, ...r] = t;
      this.emit(i, ...r);
    } else
      this[it] = t, this.emit("entry", t), t.emittedEnd || (t.on("end", () => this[Zi]()), e = false);
    return e;
  }
  [Zi]() {
    do
      ;
    while (this[Zs](this[st].shift()));
    if (this[st].length === 0) {
      let t = this[it];
      !t || t.flowing || t.size === t.remain ? this[Yt] || this.emit("drain") : t.once("drain", () => this.emit("drain"));
    }
  }
  [Ki](t, e) {
    let i = this[Nt];
    if (!i)
      throw new Error("attempt to consume body without entry??");
    let r = i.blockRemain ?? 0, n = r >= t.length && e === 0 ? t : t.subarray(e, e + r);
    return i.write(n), i.blockRemain || (this[B] = "header", this[Nt] = undefined, i.end()), n.length;
  }
  [Ks](t, e) {
    let i = this[Nt], r = this[Ki](t, e);
    return !this[Nt] && i && this[Ys](i), r;
  }
  [At](t, e, i) {
    this[st].length === 0 && !this[it] ? this.emit(t, e, i) : this[st].push([t, e, i]);
  }
  [Ys](t) {
    switch (this[At]("meta", this[dt]), t.type) {
      case "ExtendedHeader":
      case "OldExtendedHeader":
        this[V] = ft.parse(this[dt], this[V], false);
        break;
      case "GlobalExtendedHeader":
        this[he] = ft.parse(this[dt], this[he], true);
        break;
      case "NextFileHasLongPath":
      case "OldGnuLongPath": {
        let e = this[V] ?? Object.create(null);
        this[V] = e, e.path = this[dt].replace(/\0.*/, "");
        break;
      }
      case "NextFileHasLongLinkpath": {
        let e = this[V] || Object.create(null);
        this[V] = e, e.linkpath = this[dt].replace(/\0.*/, "");
        break;
      }
      default:
        throw new Error("unknown meta: " + t.type);
    }
  }
  abort(t) {
    if (!this[$]) {
      if (this[w]) {
        let e = this[w];
        e.write = () => true, e.end = () => e, e.emit = () => false, e.destroy?.();
      }
      this[$] = true, this.emit("abort", t), this.warn("TAR_ABORT", t, { recoverable: false });
    }
  }
  [Xs](t) {
    this[$i] += t.length;
    let e = this[$i] / this[le];
    return e > this.maxDecompressionRatio ? (this.abort(new Error(`max decompression ratio exceeded: ${e.toFixed(2)} > ${this.maxDecompressionRatio}`)), false) : true;
  }
  write(t, e, i) {
    if (typeof e == "function" && (i = e, e = undefined), typeof t == "string" && (t = Buffer.from(t, typeof e == "string" ? e : "utf8")), this[$])
      return i?.(), false;
    if ((this[w] === undefined || this.brotli === undefined && this[w] === false) && t) {
      if (this[p] && (t = Buffer.concat([this[p], t]), this[p] = undefined), t.length < An)
        return this[p] = t, i?.(), true;
      for (let a = 0;this[w] === undefined && a < Xi.length; a++)
        t[a] !== Xi[a] && (this[w] = false);
      let o = false;
      if (this[w] === false && this.zstd !== false) {
        o = true;
        for (let a = 0;a < qi.length; a++)
          if (t[a] !== qi[a]) {
            o = false;
            break;
          }
      }
      let h = this.brotli === undefined && !o;
      if (this[w] === false && h)
        if (t.length < 512)
          if (this[ut])
            this.brotli = true;
          else
            return this[p] = t, i?.(), true;
        else
          try {
            new F(t.subarray(0, 512)), this.brotli = false;
          } catch {
            this.brotli = true;
          }
      if (this[w] === undefined || this[w] === false && (this.brotli || o)) {
        let a = this[ut];
        this[ut] = false, this[w] = this[w] === undefined ? new Ue({}) : o ? new Ke({}) : new Ge({}), this[w].on("data", (c) => {
          this[Xs](c) && this[Xe](c);
        }), this[w].on("error", (c) => {
          this[$] || this.abort(c);
        }), this[w].on("end", () => {
          this[ut] = true, this[Xe]();
        }), this[Yt] = true, this[le] += t.length;
        let l = !!this[w][a ? "end" : "write"](t);
        return this[Yt] = false, i?.(), l;
      }
    }
    this[Yt] = true, this[w] ? (this[le] += t.length, this[w].write(t)) : this[Xe](t), this[Yt] = false;
    let n = this[st].length > 0 ? false : this[it] ? this[it].flowing : true;
    return !n && this[st].length === 0 && this[it]?.once("drain", () => this.emit("drain")), i?.(), n;
  }
  [Vi](t) {
    t && !this[$] && (this[p] = this[p] ? Buffer.concat([this[p], t]) : t);
  }
  [Qe]() {
    if (this[ut] && !this[Yi] && !this[$] && !this[ae]) {
      this[Yi] = true;
      let t = this[Nt];
      if (t?.blockRemain) {
        let e = this[p] ? this[p].length : 0;
        this.warn("TAR_BAD_ARCHIVE", `Truncated input (needed ${t.blockRemain} more bytes, only ${e} available)`, { entry: t }), this[p] && t.write(this[p]), t.end();
      }
      this[At](Je);
    }
  }
  [Xe](t) {
    if (this[ae] && t)
      this[Vi](t);
    else if (!t && !this[p])
      this[Qe]();
    else if (t) {
      if (this[ae] = true, this[p]) {
        this[Vi](t);
        let e = this[p];
        this[p] = undefined, this[qe](e);
      } else
        this[qe](t);
      for (;this[p] && this[p]?.length >= 512 && !this[$] && !this[ti]; ) {
        let e = this[p];
        this[p] = undefined, this[qe](e);
      }
      this[ae] = false;
    }
    (!this[p] || this[ut]) && this[Qe]();
  }
  [qe](t) {
    let e = 0, i = t.length;
    for (;e + 512 <= i && !this[$] && !this[ti]; )
      switch (this[B]) {
        case "begin":
        case "header":
          this[Vs](t, e), e += 512;
          break;
        case "ignore":
        case "body":
          e += this[Ki](t, e);
          break;
        case "meta":
          e += this[Ks](t, e);
          break;
        default:
          throw new Error("invalid state: " + this[B]);
      }
    e < i && (this[p] = this[p] ? Buffer.concat([t.subarray(e), this[p]]) : t.subarray(e));
  }
  end(t, e, i) {
    return typeof t == "function" && (i = t, e = undefined, t = undefined), typeof e == "function" && (i = e, e = undefined), typeof t == "string" && (t = Buffer.from(t, e)), i && this.once("finish", i), this[$] || (this[w] ? (t && (this[le] += t.length, this[w].write(t)), this[w].end()) : (this[ut] = true, (this.brotli === undefined || this.zstd === undefined) && (t = t || Buffer.alloc(0)), t && this.write(t), this[Qe]())), this;
  }
};
var mt = (s) => {
  let t = s.length - 1, e = -1;
  for (;t > -1 && s.charAt(t) === "/"; )
    e = t, t--;
  return e === -1 ? s : s.slice(0, e);
};
var vn = (s) => {
  let t = s.onReadEntry;
  s.onReadEntry = t ? (e) => {
    t(e), e.resume();
  } : (e) => e.resume();
};
var Qi = (s, t) => {
  let e = new Map(t.map((o) => [mt(o), true])), i = s.filter, r = 100, n = (o, h = "", a = 0) => {
    if (a >= r)
      return e.set(o, false), false;
    let l = h || kn(o).root || ".", c;
    if (o === l)
      c = false;
    else {
      let d = e.get(o);
      c = d !== undefined ? d : n(Fn(o), l, a + 1);
    }
    return e.set(o, c), c;
  };
  s.filter = i ? (o, h) => i(o, h) && n(mt(o)) : (o) => n(mt(o));
};
var Mn = (s) => {
  let t = new rt(s), e = s.file, i;
  try {
    i = Kt.openSync(e, "r");
    let r = Kt.fstatSync(i), n = s.maxReadSize || 16 * 1024 * 1024;
    if (r.size < n) {
      let o = Buffer.allocUnsafe(r.size), h = Kt.readSync(i, o, 0, r.size, 0);
      t.end(h === o.byteLength ? o : o.subarray(0, h));
    } else {
      let o = 0, h = Buffer.allocUnsafe(n);
      for (;o < r.size; ) {
        let a = Kt.readSync(i, h, 0, n, o);
        if (a === 0)
          break;
        o += a, t.write(h.subarray(0, a));
      }
      t.end();
    }
  } finally {
    if (typeof i == "number")
      try {
        Kt.closeSync(i);
      } catch {}
  }
};
var Bn = (s, t) => {
  let e = new rt(s), i = s.maxReadSize || 16 * 1024 * 1024, r = s.file;
  return new Promise((o, h) => {
    e.on("error", h), e.on("end", o), Kt.stat(r, (a, l) => {
      if (a)
        h(a);
      else {
        let c = new _t(r, { readSize: i, size: l.size });
        c.on("error", h), c.pipe(e);
      }
    });
  });
};
var Ct = K(Mn, Bn, (s) => new rt(s), (s) => new rt(s), (s, t) => {
  t?.length && Qi(s, t), s.noResume || vn(s);
});
var Ji = (s, t, e) => (s &= 4095, e && (s = (s | 384) & -19), t && (s & 256 && (s |= 64), s & 32 && (s |= 8), s & 4 && (s |= 1)), s);
var { isAbsolute: zn, parse: qs } = Pn;
var ce = (s) => {
  let t = "", e = qs(s);
  for (;zn(s) || e.root; ) {
    let i = s.charAt(0) === "/" && s.slice(0, 4) !== "//?/" ? "/" : e.root;
    s = s.slice(i.length), t += i, e = qs(s);
  }
  return [t, s];
};
var ei = ["|", "<", ">", "?", ":"];
var ji = ei.map((s) => String.fromCodePoint(61440 + Number(s.codePointAt(0))));
var Un = new Map(ei.map((s, t) => [s, ji[t]]));
var Hn = new Map(ji.map((s, t) => [s, ei[t]]));
var ts = (s) => ei.reduce((t, e) => t.split(e).join(Un.get(e)), s);
var Qs = (s) => ji.reduce((t, e) => t.split(e).join(Hn.get(e)), s);
var rr = (s, t) => t ? (s = f(s).replace(/^\.(\/|$)/, ""), mt(t) + "/" + s) : f(s);
var Wn = 16 * 1024 * 1024;
var tr = Symbol("process");
var er = Symbol("file");
var ir = Symbol("directory");
var is = Symbol("symlink");
var sr = Symbol("hardlink");
var fe = Symbol("header");
var ii = Symbol("read");
var ss = Symbol("lstat");
var si = Symbol("onlstat");
var rs = Symbol("onread");
var ns = Symbol("onreadlink");
var os = Symbol("openfile");
var hs = Symbol("onopenfile");
var pt = Symbol("close");
var ri = Symbol("mode");
var as = Symbol("awaitDrain");
var es = Symbol("ondrain");
var q = Symbol("prefix");
var de = class extends A {
  path;
  portable;
  myuid = process.getuid && process.getuid() || 0;
  myuser = process.env.USER || "";
  maxReadSize;
  linkCache;
  statCache;
  preservePaths;
  cwd;
  strict;
  mtime;
  noPax;
  noMtime;
  prefix;
  fd;
  blockLen = 0;
  blockRemain = 0;
  buf;
  pos = 0;
  remain = 0;
  length = 0;
  offset = 0;
  win32;
  absolute;
  header;
  type;
  linkpath;
  stat;
  onWriteEntry;
  #t = false;
  constructor(t, e = {}) {
    let i = se(e);
    super(), this.path = f(t), this.portable = !!i.portable, this.maxReadSize = i.maxReadSize || Wn, this.linkCache = i.linkCache || new Map, this.statCache = i.statCache || new Map, this.preservePaths = !!i.preservePaths, this.cwd = f(i.cwd || process.cwd()), this.strict = !!i.strict, this.noPax = !!i.noPax, this.noMtime = !!i.noMtime, this.mtime = i.mtime, this.prefix = i.prefix ? f(i.prefix) : undefined, this.onWriteEntry = i.onWriteEntry, typeof i.onwarn == "function" && this.on("warn", i.onwarn);
    let r = false;
    if (!this.preservePaths) {
      let [o, h] = ce(this.path);
      o && typeof h == "string" && (this.path = h, r = o);
    }
    this.win32 = !!i.win32 || process.platform === "win32", this.win32 && (this.path = Qs(this.path.replaceAll(/\\/g, "/")), t = t.replaceAll(/\\/g, "/")), this.absolute = f(i.absolute || js.resolve(this.cwd, t)), this.path === "" && (this.path = "./"), r && this.warn("TAR_ENTRY_INFO", `stripping ${r} from absolute path`, { entry: this, path: r + this.path });
    let n = this.statCache.get(this.absolute);
    n ? this[si](n) : this[ss]();
  }
  warn(t, e, i = {}) {
    return Dt(this, t, e, i);
  }
  emit(t, ...e) {
    return t === "error" && (this.#t = true), super.emit(t, ...e);
  }
  [ss]() {
    X.lstat(this.absolute, (t, e) => {
      if (t)
        return this.emit("error", t);
      this[si](e);
    });
  }
  [si](t) {
    this.statCache.set(this.absolute, t), this.stat = t, t.isFile() || (t.size = 0), this.type = Gn(t), this.emit("stat", t), this[tr]();
  }
  [tr]() {
    switch (this.type) {
      case "File":
        return this[er]();
      case "Directory":
        return this[ir]();
      case "SymbolicLink":
        return this[is]();
      default:
        return this.end();
    }
  }
  [ri](t) {
    return Ji(t, this.type === "Directory", this.portable);
  }
  [q](t) {
    return rr(t, this.prefix);
  }
  [fe]() {
    if (!this.stat)
      throw new Error("cannot write header before stat");
    this.type === "Directory" && this.portable && (this.noMtime = true), this.onWriteEntry?.(this), this.header = new F({ path: this[q](this.path), linkpath: this.type === "Link" && this.linkpath !== undefined ? this[q](this.linkpath) : this.linkpath, mode: this[ri](this.stat.mode), uid: this.portable ? undefined : this.stat.uid, gid: this.portable ? undefined : this.stat.gid, size: this.stat.size, mtime: this.noMtime ? undefined : this.mtime || this.stat.mtime, type: this.type === "Unsupported" ? undefined : this.type, uname: this.portable ? undefined : this.stat.uid === this.myuid ? this.myuser : "", atime: this.portable ? undefined : this.stat.atime, ctime: this.portable ? undefined : this.stat.ctime }), this.header.encode() && !this.noPax && super.write(new ft({ atime: this.portable ? undefined : this.header.atime, ctime: this.portable ? undefined : this.header.ctime, gid: this.portable ? undefined : this.header.gid, mtime: this.noMtime ? undefined : this.mtime || this.header.mtime, path: this[q](this.path), linkpath: this.type === "Link" && this.linkpath !== undefined ? this[q](this.linkpath) : this.linkpath, size: this.header.size, uid: this.portable ? undefined : this.header.uid, uname: this.portable ? undefined : this.header.uname, dev: this.portable ? undefined : this.stat.dev, ino: this.portable ? undefined : this.stat.ino, nlink: this.portable ? undefined : this.stat.nlink }).encode());
    let t = this.header?.block;
    if (!t)
      throw new Error("failed to encode header");
    super.write(t);
  }
  [ir]() {
    if (!this.stat)
      throw new Error("cannot create directory entry without stat");
    this.path.slice(-1) !== "/" && (this.path += "/"), this.stat.size = 0, this[fe](), this.end();
  }
  [is]() {
    X.readlink(this.absolute, (t, e) => {
      if (t)
        return this.emit("error", t);
      this[ns](e);
    });
  }
  [ns](t) {
    this.linkpath = f(t), this[fe](), this.end();
  }
  [sr](t) {
    if (!this.stat)
      throw new Error("cannot create link entry without stat");
    this.type = "Link", this.linkpath = f(js.relative(this.cwd, t)), this.stat.size = 0, this[fe](), this.end();
  }
  [er]() {
    if (!this.stat)
      throw new Error("cannot create file entry without stat");
    if (this.stat.nlink > 1) {
      let t = `${this.stat.dev}:${this.stat.ino}`, e = this.linkCache.get(t);
      if (e?.indexOf(this.cwd) === 0)
        return this[sr](e);
      this.linkCache.set(t, this.absolute);
    }
    if (this[fe](), this.stat.size === 0)
      return this.end();
    this[os]();
  }
  [os]() {
    X.open(this.absolute, "r", (t, e) => {
      if (t)
        return this.emit("error", t);
      this[hs](e);
    });
  }
  [hs](t) {
    if (this.fd = t, this.#t)
      return this[pt]();
    if (!this.stat)
      throw new Error("should stat before calling onopenfile");
    this.blockLen = 512 * Math.ceil(this.stat.size / 512), this.blockRemain = this.blockLen;
    let e = Math.min(this.blockLen, this.maxReadSize);
    this.buf = Buffer.allocUnsafe(e), this.offset = 0, this.pos = 0, this.remain = this.stat.size, this.length = this.buf.length, this[ii]();
  }
  [ii]() {
    let { fd: t, buf: e, offset: i, length: r, pos: n } = this;
    if (t === undefined || e === undefined)
      throw new Error("cannot read file without first opening");
    X.read(t, e, i, r, n, (o, h) => {
      if (o)
        return this[pt](() => this.emit("error", o));
      this[rs](h);
    });
  }
  [pt](t = () => {}) {
    this.fd !== undefined && X.close(this.fd, t);
  }
  [rs](t) {
    if (t <= 0 && this.remain > 0) {
      let r = Object.assign(new Error("encountered unexpected EOF"), { path: this.absolute, syscall: "read", code: "EOF" });
      return this[pt](() => this.emit("error", r));
    }
    if (t > this.remain) {
      let r = Object.assign(new Error("did not encounter expected EOF"), { path: this.absolute, syscall: "read", code: "EOF" });
      return this[pt](() => this.emit("error", r));
    }
    if (!this.buf)
      throw new Error("should have created buffer prior to reading");
    if (t === this.remain)
      for (let r = t;r < this.length && t < this.blockRemain; r++)
        this.buf[r + this.offset] = 0, t++, this.remain++;
    let e = this.offset === 0 && t === this.buf.length ? this.buf : this.buf.subarray(this.offset, this.offset + t);
    this.write(e) ? this[es]() : this[as](() => this[es]());
  }
  [as](t) {
    this.once("drain", t);
  }
  write(t, e, i) {
    if (typeof e == "function" && (i = e, e = undefined), typeof t == "string" && (t = Buffer.from(t, typeof e == "string" ? e : "utf8")), this.blockRemain < t.length) {
      let r = Object.assign(new Error("writing more data than expected"), { path: this.absolute });
      return this.emit("error", r);
    }
    return this.remain -= t.length, this.blockRemain -= t.length, this.pos += t.length, this.offset += t.length, super.write(t, null, i);
  }
  [es]() {
    if (!this.remain)
      return this.blockRemain && super.write(Buffer.alloc(this.blockRemain)), this[pt]((t) => t ? this.emit("error", t) : this.end());
    if (!this.buf)
      throw new Error("buffer lost somehow in ONDRAIN");
    this.offset >= this.length && (this.buf = Buffer.allocUnsafe(Math.min(this.blockRemain, this.buf.length)), this.offset = 0), this.length = this.buf.length - this.offset, this[ii]();
  }
};
var ni = class extends de {
  sync = true;
  [ss]() {
    this[si](X.lstatSync(this.absolute));
  }
  [is]() {
    this[ns](X.readlinkSync(this.absolute));
  }
  [os]() {
    this[hs](X.openSync(this.absolute, "r"));
  }
  [ii]() {
    let t = true;
    try {
      let { fd: e, buf: i, offset: r, length: n, pos: o } = this;
      if (e === undefined || i === undefined)
        throw new Error("fd and buf must be set in READ method");
      let h = X.readSync(e, i, r, n, o);
      this[rs](h), t = false;
    } finally {
      if (t)
        try {
          this[pt](() => {});
        } catch {}
    }
  }
  [as](t) {
    t();
  }
  [pt](t = () => {}) {
    this.fd !== undefined && X.closeSync(this.fd), t();
  }
};
var oi = class extends A {
  blockLen = 0;
  blockRemain = 0;
  buf = 0;
  pos = 0;
  remain = 0;
  length = 0;
  preservePaths;
  portable;
  strict;
  noPax;
  noMtime;
  readEntry;
  type;
  prefix;
  path;
  mode;
  uid;
  gid;
  uname;
  gname;
  header;
  mtime;
  atime;
  ctime;
  linkpath;
  size;
  onWriteEntry;
  warn(t, e, i = {}) {
    return Dt(this, t, e, i);
  }
  constructor(t, e = {}) {
    let i = se(e);
    super(), this.preservePaths = !!i.preservePaths, this.portable = !!i.portable, this.strict = !!i.strict, this.noPax = !!i.noPax, this.noMtime = !!i.noMtime, this.onWriteEntry = i.onWriteEntry, this.readEntry = t;
    let { type: r } = t;
    if (r === "Unsupported")
      throw new Error("writing entry that should be ignored");
    this.type = r, this.type === "Directory" && this.portable && (this.noMtime = true), this.prefix = i.prefix, this.path = f(t.path), this.mode = t.mode !== undefined ? this[ri](t.mode) : undefined, this.uid = this.portable ? undefined : t.uid, this.gid = this.portable ? undefined : t.gid, this.uname = this.portable ? undefined : t.uname, this.gname = this.portable ? undefined : t.gname, this.size = t.size, this.mtime = this.noMtime ? undefined : i.mtime || t.mtime, this.atime = this.portable ? undefined : t.atime, this.ctime = this.portable ? undefined : t.ctime, this.linkpath = t.linkpath !== undefined ? f(t.linkpath) : undefined, typeof i.onwarn == "function" && this.on("warn", i.onwarn);
    let n = false;
    if (!this.preservePaths) {
      let [h, a] = ce(this.path);
      h && typeof a == "string" && (this.path = a, n = h);
    }
    this.remain = t.size, this.blockRemain = t.startBlockSize, this.onWriteEntry?.(this), this.header = new F({ path: this[q](this.path), linkpath: this.type === "Link" && this.linkpath !== undefined ? this[q](this.linkpath) : this.linkpath, mode: this.mode, uid: this.portable ? undefined : this.uid, gid: this.portable ? undefined : this.gid, size: this.size, mtime: this.noMtime ? undefined : this.mtime, type: this.type, uname: this.portable ? undefined : this.uname, atime: this.portable ? undefined : this.atime, ctime: this.portable ? undefined : this.ctime }), n && this.warn("TAR_ENTRY_INFO", `stripping ${n} from absolute path`, { entry: this, path: n + this.path }), this.header.encode() && !this.noPax && super.write(new ft({ atime: this.portable ? undefined : this.atime, ctime: this.portable ? undefined : this.ctime, gid: this.portable ? undefined : this.gid, mtime: this.noMtime ? undefined : this.mtime, path: this[q](this.path), linkpath: this.type === "Link" && this.linkpath !== undefined ? this[q](this.linkpath) : this.linkpath, size: this.size, uid: this.portable ? undefined : this.uid, uname: this.portable ? undefined : this.uname, dev: this.portable ? undefined : this.readEntry.dev, ino: this.portable ? undefined : this.readEntry.ino, nlink: this.portable ? undefined : this.readEntry.nlink }).encode());
    let o = this.header?.block;
    if (!o)
      throw new Error("failed to encode header");
    super.write(o), t.pipe(this);
  }
  [q](t) {
    return rr(t, this.prefix);
  }
  [ri](t) {
    return Ji(t, this.type === "Directory", this.portable);
  }
  write(t, e, i) {
    typeof e == "function" && (i = e, e = undefined), typeof t == "string" && (t = Buffer.from(t, typeof e == "string" ? e : "utf8"));
    let r = t.length;
    if (r > this.blockRemain)
      throw new Error("writing more to entry than is appropriate");
    return this.blockRemain -= r, super.write(t, i);
  }
  end(t, e, i) {
    return this.blockRemain && super.write(Buffer.alloc(this.blockRemain)), typeof t == "function" && (i = t, e = undefined, t = undefined), typeof e == "function" && (i = e, e = undefined), typeof t == "string" && (t = Buffer.from(t, e ?? "utf8")), i && this.once("finish", i), t ? super.end(t, i) : super.end(i), this;
  }
};
var Gn = (s) => s.isFile() ? "File" : s.isDirectory() ? "Directory" : s.isSymbolicLink() ? "SymbolicLink" : "Unsupported";
var hi = class s {
  tail;
  head;
  length = 0;
  static create(t = []) {
    return new s(t);
  }
  constructor(t = []) {
    for (let e of t)
      this.push(e);
  }
  *[Symbol.iterator]() {
    for (let t = this.head;t; t = t.next)
      yield t.value;
  }
  removeNode(t) {
    if (t.list !== this)
      throw new Error("removing node which does not belong to this list");
    let { next: e, prev: i } = t;
    return e && (e.prev = i), i && (i.next = e), t === this.head && (this.head = e), t === this.tail && (this.tail = i), this.length--, t.next = undefined, t.prev = undefined, t.list = undefined, e;
  }
  unshiftNode(t) {
    if (t === this.head)
      return;
    t.list && t.list.removeNode(t);
    let e = this.head;
    t.list = this, t.next = e, e && (e.prev = t), this.head = t, this.tail || (this.tail = t), this.length++;
  }
  pushNode(t) {
    if (t === this.tail)
      return;
    t.list && t.list.removeNode(t);
    let e = this.tail;
    t.list = this, t.prev = e, e && (e.next = t), this.tail = t, this.head || (this.head = t), this.length++;
  }
  push(...t) {
    for (let e = 0, i = t.length;e < i; e++)
      Yn(this, t[e]);
    return this.length;
  }
  unshift(...t) {
    for (var e = 0, i = t.length;e < i; e++)
      Kn(this, t[e]);
    return this.length;
  }
  pop() {
    if (!this.tail)
      return;
    let t = this.tail.value, e = this.tail;
    return this.tail = this.tail.prev, this.tail ? this.tail.next = undefined : this.head = undefined, e.list = undefined, this.length--, t;
  }
  shift() {
    if (!this.head)
      return;
    let t = this.head.value, e = this.head;
    return this.head = this.head.next, this.head ? this.head.prev = undefined : this.tail = undefined, e.list = undefined, this.length--, t;
  }
  forEach(t, e) {
    e = e || this;
    for (let i = this.head, r = 0;i; r++)
      t.call(e, i.value, r, this), i = i.next;
  }
  forEachReverse(t, e) {
    e = e || this;
    for (let i = this.tail, r = this.length - 1;i; r--)
      t.call(e, i.value, r, this), i = i.prev;
  }
  get(t) {
    let e = 0, i = this.head;
    for (;i && e < t; e++)
      i = i.next;
    if (e === t && i)
      return i.value;
  }
  getReverse(t) {
    let e = 0, i = this.tail;
    for (;i && e < t; e++)
      i = i.prev;
    if (e === t && i)
      return i.value;
  }
  map(t, e) {
    e = e || this;
    let i = new s;
    for (let r = this.head;r; )
      i.push(t.call(e, r.value, this)), r = r.next;
    return i;
  }
  mapReverse(t, e) {
    e = e || this;
    var i = new s;
    for (let r = this.tail;r; )
      i.push(t.call(e, r.value, this)), r = r.prev;
    return i;
  }
  reduce(t, e) {
    let i, r = this.head;
    if (arguments.length > 1)
      i = e;
    else if (this.head)
      r = this.head.next, i = this.head.value;
    else
      throw new TypeError("Reduce of empty list with no initial value");
    for (var n = 0;r; n++)
      i = t(i, r.value, n), r = r.next;
    return i;
  }
  reduceReverse(t, e) {
    let i, r = this.tail;
    if (arguments.length > 1)
      i = e;
    else if (this.tail)
      r = this.tail.prev, i = this.tail.value;
    else
      throw new TypeError("Reduce of empty list with no initial value");
    for (let n = this.length - 1;r; n--)
      i = t(i, r.value, n), r = r.prev;
    return i;
  }
  toArray() {
    let t = new Array(this.length);
    for (let e = 0, i = this.head;i; e++)
      t[e] = i.value, i = i.next;
    return t;
  }
  toArrayReverse() {
    let t = new Array(this.length);
    for (let e = 0, i = this.tail;i; e++)
      t[e] = i.value, i = i.prev;
    return t;
  }
  slice(t = 0, e = this.length) {
    e < 0 && (e += this.length), t < 0 && (t += this.length);
    let i = new s;
    if (e < t || e < 0)
      return i;
    t < 0 && (t = 0), e > this.length && (e = this.length);
    let r = this.head, n = 0;
    for (n = 0;r && n < t; n++)
      r = r.next;
    for (;r && n < e; n++, r = r.next)
      i.push(r.value);
    return i;
  }
  sliceReverse(t = 0, e = this.length) {
    e < 0 && (e += this.length), t < 0 && (t += this.length);
    let i = new s;
    if (e < t || e < 0)
      return i;
    t < 0 && (t = 0), e > this.length && (e = this.length);
    let r = this.length, n = this.tail;
    for (;n && r > e; r--)
      n = n.prev;
    for (;n && r > t; r--, n = n.prev)
      i.push(n.value);
    return i;
  }
  splice(t, e = 0, ...i) {
    t > this.length && (t = this.length - 1), t < 0 && (t = this.length + t);
    let r = this.head;
    for (let o = 0;r && o < t; o++)
      r = r.next;
    let n = [];
    for (let o = 0;r && o < e; o++)
      n.push(r.value), r = this.removeNode(r);
    r ? r !== this.tail && (r = r.prev) : r = this.tail;
    for (let o of i)
      r = Zn(this, r, o);
    return n;
  }
  reverse() {
    let t = this.head, e = this.tail;
    for (let i = t;i; i = i.prev) {
      let r = i.prev;
      i.prev = i.next, i.next = r;
    }
    return this.head = e, this.tail = t, this;
  }
};
function Zn(s, t, e) {
  let i = t, r = t ? t.next : s.head, n = new ue(e, i, r, s);
  return n.next === undefined && (s.tail = n), n.prev === undefined && (s.head = n), s.length++, n;
}
function Yn(s, t) {
  s.tail = new ue(t, s.tail, undefined, s), s.head || (s.head = s.tail), s.length++;
}
function Kn(s, t) {
  s.head = new ue(t, undefined, s.head, s), s.tail || (s.tail = s.head), s.length++;
}
var ue = class {
  list;
  next;
  prev;
  value;
  constructor(t, e, i, r) {
    this.list = r, this.value = t, e ? (e.next = this, this.prev = e) : this.prev = undefined, i ? (i.prev = this, this.next = i) : this.next = undefined;
  }
};
var pi = class {
  path;
  absolute;
  entry;
  stat;
  readdir;
  pending = false;
  pendingLink = false;
  ignore = false;
  piped = false;
  constructor(t, e) {
    this.path = t || "./", this.absolute = e;
  }
};
var nr = Buffer.alloc(1024);
var li = Symbol("onStat");
var me = Symbol("ended");
var W = Symbol("queue");
var pe = Symbol("pendingLinks");
var Et = Symbol("current");
var Ft = Symbol("process");
var Ee = Symbol("processing");
var ai = Symbol("processJob");
var G = Symbol("jobs");
var ls = Symbol("jobDone");
var ci = Symbol("addFSEntry");
var or = Symbol("addTarEntry");
var ds = Symbol("stat");
var us = Symbol("readdir");
var fi = Symbol("onreaddir");
var di = Symbol("pipe");
var hr = Symbol("entry");
var cs = Symbol("entryOpt");
var ui = Symbol("writeEntryClass");
var lr = Symbol("write");
var fs = Symbol("ondrain");
var wt = class extends A {
  sync = false;
  opt;
  cwd;
  maxReadSize;
  preservePaths;
  strict;
  noPax;
  prefix;
  linkCache;
  statCache;
  file;
  portable;
  zip;
  readdirCache;
  noDirRecurse;
  follow;
  noMtime;
  mtime;
  filter;
  jobs;
  [ui];
  onWriteEntry;
  [W];
  [pe] = new Map;
  [G] = 0;
  [Ee] = false;
  [me] = false;
  constructor(t = {}) {
    if (super(), this.opt = t, this.file = t.file || "", this.cwd = t.cwd || process.cwd(), this.maxReadSize = t.maxReadSize, this.preservePaths = !!t.preservePaths, this.strict = !!t.strict, this.noPax = !!t.noPax, this.prefix = f(t.prefix || ""), this.linkCache = t.linkCache || new Map, this.statCache = t.statCache || new Map, this.readdirCache = t.readdirCache || new Map, this.onWriteEntry = t.onWriteEntry, this[ui] = de, typeof t.onwarn == "function" && this.on("warn", t.onwarn), this.portable = !!t.portable, t.gzip || t.brotli || t.zstd) {
      if ((t.gzip ? 1 : 0) + (t.brotli ? 1 : 0) + (t.zstd ? 1 : 0) > 1)
        throw new TypeError("gzip, brotli, zstd are mutually exclusive");
      if (t.gzip && (typeof t.gzip != "object" && (t.gzip = {}), this.portable && (t.gzip.portable = true), this.zip = new ze(t.gzip)), t.brotli && (typeof t.brotli != "object" && (t.brotli = {}), this.zip = new We(t.brotli)), t.zstd && (typeof t.zstd != "object" && (t.zstd = {}), this.zip = new Ye(t.zstd)), !this.zip)
        throw new Error("impossible");
      let e = this.zip;
      e.on("data", (i) => super.write(i)), e.on("end", () => super.end()), e.on("drain", () => this[fs]()), this.on("resume", () => e.resume());
    } else
      this.on("drain", this[fs]);
    this.noDirRecurse = !!t.noDirRecurse, this.follow = !!t.follow, this.noMtime = !!t.noMtime, t.mtime && (this.mtime = t.mtime), this.filter = typeof t.filter == "function" ? t.filter : () => true, this[W] = new hi, this[G] = 0, this.jobs = Number(t.jobs) || 4, this[Ee] = false, this[me] = false;
  }
  [lr](t) {
    return super.write(t);
  }
  add(t) {
    return this.write(t), this;
  }
  end(t, e, i) {
    return typeof t == "function" && (i = t, t = undefined), typeof e == "function" && (i = e, e = undefined), t && this.add(t), this[me] = true, this[Ft](), i && i(), this;
  }
  write(t) {
    if (this[me])
      throw new Error("write after end");
    return typeof t == "string" ? this[ci](t) : this[or](t), this.flowing;
  }
  [or](t) {
    let e = f(ar.resolve(this.cwd, t.path));
    if (!this.filter(t.path, t))
      t.resume();
    else {
      let i = new pi(t.path, e);
      i.entry = new oi(t, this[cs](i)), i.entry.on("end", () => this[ls](i)), this[G] += 1, this[W].push(i);
    }
    this[Ft]();
  }
  [ci](t) {
    let e = f(ar.resolve(this.cwd, t));
    this[W].push(new pi(t, e)), this[Ft]();
  }
  [ds](t) {
    t.pending = true, this[G] += 1;
    let e = this.follow ? "stat" : "lstat";
    mi[e](t.absolute, (i, r) => {
      t.pending = false, this[G] -= 1, i ? this.emit("error", i) : this[li](t, r);
    });
  }
  [li](t, e) {
    if (this.statCache.set(t.absolute, e), t.stat = e, !this.filter(t.path, e))
      t.ignore = true;
    else if (e.isFile() && e.nlink > 1 && !this.linkCache.get(`${e.dev}:${e.ino}`) && !this.sync)
      if (t === this[Et])
        this[ai](t);
      else {
        let i = `${e.dev}:${e.ino}`, r = this[pe].get(i);
        r ? r.push(t) : this[pe].set(i, [t]), t.pendingLink = true, t.pending = true;
      }
    this[Ft]();
  }
  [us](t) {
    t.pending = true, this[G] += 1, mi.readdir(t.absolute, (e, i) => {
      if (t.pending = false, this[G] -= 1, e)
        return this.emit("error", e);
      this[fi](t, i);
    });
  }
  [fi](t, e) {
    this.readdirCache.set(t.absolute, e), t.readdir = e, this[Ft]();
  }
  [Ft]() {
    if (!this[Ee]) {
      this[Ee] = true;
      for (let t = this[W].head;t && this[G] < this.jobs; t = t.next)
        if (this[ai](t.value), t.value.ignore) {
          let e = t.next;
          this[W].removeNode(t), t.next = e;
        }
      this[Ee] = false, this[me] && this[W].length === 0 && this[G] === 0 && (this.zip ? this.zip.end(nr) : (super.write(nr), super.end()));
    }
  }
  get [Et]() {
    return this[W] && this[W].head && this[W].head.value;
  }
  [ls](t) {
    this[W].shift(), this[G] -= 1;
    let { stat: e } = t;
    if (e && e.isFile() && e.nlink > 1) {
      let i = `${e.dev}:${e.ino}`, r = this[pe].get(i);
      if (r) {
        this[pe].delete(i);
        for (let n of r)
          n.pending = false, this[ai](n);
      }
    }
    this[Ft]();
  }
  [ai](t) {
    if (t.pending && t.pendingLink && t === this[Et] && (t.pending = false, t.pendingLink = false), !t.pending) {
      if (t.entry) {
        t === this[Et] && !t.piped && this[di](t);
        return;
      }
      if (!t.stat) {
        let e = this.statCache.get(t.absolute);
        e ? this[li](t, e) : this[ds](t);
      }
      if (t.stat && !t.ignore) {
        if (!this.noDirRecurse && t.stat.isDirectory() && !t.readdir) {
          let e = this.readdirCache.get(t.absolute);
          if (e ? this[fi](t, e) : this[us](t), !t.readdir)
            return;
        }
        if (t.entry = this[hr](t), !t.entry) {
          t.ignore = true;
          return;
        }
        t === this[Et] && !t.piped && this[di](t);
      }
    }
  }
  [cs](t) {
    return { onwarn: (e, i, r) => this.warn(e, i, r), noPax: this.noPax, cwd: this.cwd, absolute: t.absolute, preservePaths: this.preservePaths, maxReadSize: this.maxReadSize, strict: this.strict, portable: this.portable, linkCache: this.linkCache, statCache: this.statCache, noMtime: this.noMtime, mtime: this.mtime, prefix: this.prefix, onWriteEntry: this.onWriteEntry };
  }
  [hr](t) {
    this[G] += 1;
    try {
      return new this[ui](t.path, this[cs](t)).on("end", () => this[ls](t)).on("error", (i) => this.emit("error", i));
    } catch (e) {
      this.emit("error", e);
    }
  }
  [fs]() {
    this[Et] && this[Et].entry && this[Et].entry.resume();
  }
  [di](t) {
    t.piped = true, t.readdir && t.readdir.forEach((r) => {
      let n = t.path, o = n === "./" ? "" : n.replace(/\/*$/, "/");
      this[ci](o + r);
    });
    let e = t.entry, i = this.zip;
    if (!e)
      throw new Error("cannot pipe without source");
    i ? e.on("data", (r) => {
      i.write(r) || e.pause();
    }) : e.on("data", (r) => {
      super.write(r) || e.pause();
    });
  }
  pause() {
    return this.zip && this.zip.pause(), super.pause();
  }
  warn(t, e, i = {}) {
    Dt(this, t, e, i);
  }
};
var kt = class extends wt {
  sync = true;
  constructor(t) {
    super(t), this[ui] = ni;
  }
  pause() {}
  resume() {}
  [ds](t) {
    let e = this.follow ? "statSync" : "lstatSync";
    this[li](t, mi[e](t.absolute));
  }
  [us](t) {
    this[fi](t, mi.readdirSync(t.absolute));
  }
  [di](t) {
    let e = t.entry, i = this.zip;
    if (t.readdir && t.readdir.forEach((r) => {
      let n = t.path, o = n === "./" ? "" : n.replace(/\/*$/, "/");
      this[ci](o + r);
    }), !e)
      throw new Error("Cannot pipe without source");
    i ? e.on("data", (r) => {
      i.write(r);
    }) : e.on("data", (r) => {
      super[lr](r);
    });
  }
};
var Vn = (s, t) => {
  let e = new kt(s), i = new Wt(s.file, { mode: s.mode || 438 });
  e.pipe(i), fr(e, t);
};
var $n = (s, t) => {
  let e = new wt(s), i = new et(s.file, { mode: s.mode || 438 });
  e.pipe(i);
  let r = new Promise((n, o) => {
    i.on("error", o), i.on("close", n), e.on("error", o);
  });
  return dr(e, t).catch((n) => e.emit("error", n)), r;
};
var fr = (s, t) => {
  t.forEach((e) => {
    e.charAt(0) === "@" ? Ct({ file: cr.resolve(s.cwd, e.slice(1)), sync: true, noResume: true, onReadEntry: (i) => s.add(i) }) : s.add(e);
  }), s.end();
};
var dr = async (s, t) => {
  for (let e of t)
    e.charAt(0) === "@" ? await Ct({ file: cr.resolve(String(s.cwd), e.slice(1)), noResume: true, onReadEntry: (i) => {
      s.add(i);
    } }) : s.add(e);
  s.end();
};
var Xn = (s, t) => {
  let e = new kt(s);
  return fr(e, t), e;
};
var qn = (s, t) => {
  let e = new wt(s);
  return dr(e, t).catch((i) => e.emit("error", i)), e;
};
var Qn = K(Vn, $n, Xn, qn, (s, t) => {
  if (!t?.length)
    throw new TypeError("no paths specified to add to archive");
});
var Jn = process.env.__FAKE_PLATFORM__ || process.platform;
var Er = Jn === "win32";
var { O_CREAT: wr, O_NOFOLLOW: ur, O_TRUNC: Sr, O_WRONLY: yr } = pr.constants;
var Rr = Number(process.env.__FAKE_FS_O_FILENAME__) || pr.constants.UV_FS_O_FILEMAP || 0;
var jn = Er && !!Rr;
var to = 512 * 1024;
var eo = Rr | Sr | wr | yr;
var mr = !Er && typeof ur == "number" ? ur | Sr | wr | yr : null;
var ms = mr !== null ? () => mr : jn ? (s) => s < to ? eo : "w" : () => "w";
var ps = (s, t, e) => {
  try {
    return wi.lchownSync(s, t, e);
  } catch (i) {
    if (i?.code !== "ENOENT")
      throw i;
  }
};
var Ei = (s, t, e, i) => {
  wi.lchown(s, t, e, (r) => {
    i(r && r?.code !== "ENOENT" ? r : null);
  });
};
var io = (s, t, e, i, r) => {
  if (t.isDirectory())
    Es(we.resolve(s, t.name), e, i, (n) => {
      if (n)
        return r(n);
      let o = we.resolve(s, t.name);
      Ei(o, e, i, r);
    });
  else {
    let n = we.resolve(s, t.name);
    Ei(n, e, i, r);
  }
};
var Es = (s, t, e, i) => {
  wi.readdir(s, { withFileTypes: true }, (r, n) => {
    if (r) {
      if (r.code === "ENOENT")
        return i();
      if (r.code !== "ENOTDIR" && r.code !== "ENOTSUP")
        return i(r);
    }
    if (r || !n.length)
      return Ei(s, t, e, i);
    let o = n.length, h = null, a = (l) => {
      if (!h) {
        if (l)
          return i(h = l);
        if (--o === 0)
          return Ei(s, t, e, i);
      }
    };
    for (let l of n)
      io(s, l, t, e, a);
  });
};
var so = (s, t, e, i) => {
  t.isDirectory() && ws(we.resolve(s, t.name), e, i), ps(we.resolve(s, t.name), e, i);
};
var ws = (s, t, e) => {
  let i;
  try {
    i = wi.readdirSync(s, { withFileTypes: true });
  } catch (r) {
    let n = r;
    if (n?.code === "ENOENT")
      return;
    if (n?.code === "ENOTDIR" || n?.code === "ENOTSUP")
      return ps(s, t, e);
    throw n;
  }
  for (let r of i)
    so(s, r, t, e);
  return ps(s, t, e);
};
var Se = class extends Error {
  path;
  code;
  syscall = "chdir";
  constructor(t, e) {
    super(`${e}: Cannot cd into '${t}'`), this.path = t, this.code = e;
  }
  get name() {
    return "CwdError";
  }
};
var St = class extends Error {
  path;
  symlink;
  syscall = "symlink";
  code = "TAR_SYMLINK_ERROR";
  constructor(t, e) {
    super("TAR_SYMLINK_ERROR: Cannot extract through symbolic link"), this.symlink = t, this.path = e;
  }
  get name() {
    return "SymlinkError";
  }
};
var no = (s, t) => {
  k.stat(s, (e, i) => {
    (e || !i.isDirectory()) && (e = new Se(s, e?.code || "ENOTDIR")), t(e);
  });
};
var gr = (s, t, e) => {
  s = f(s);
  let i = t.umask ?? 18, r = t.mode | 448, n = (r & i) !== 0, { uid: o, gid: h } = t, a = typeof o == "number" && typeof h == "number" && (o !== t.processUid || h !== t.processGid), { preserve: l, unlink: c } = t, d = f(t.cwd), y = (E, x) => {
    E ? e(E) : x && a ? Es(x, o, h, (Le) => y(Le)) : n ? k.chmod(s, r, e) : e();
  };
  if (s === d)
    return no(s, y);
  if (l)
    return ro.mkdir(s, { mode: r, recursive: true }).then((E) => y(null, E ?? undefined), y);
  let D = f(Si.relative(d, s)).split("/");
  Ss(d, D, r, c, d, undefined, y);
};
var Ss = (s, t, e, i, r, n, o) => {
  if (t.length === 0)
    return o(null, n);
  let h = t.shift(), a = f(Si.resolve(s + "/" + h));
  k.mkdir(a, e, br(a, t, e, i, r, n, o));
};
var br = (s, t, e, i, r, n, o) => (h) => {
  h ? k.lstat(s, (a, l) => {
    if (a)
      a.path = a.path && f(a.path), o(a);
    else if (l.isDirectory())
      Ss(s, t, e, i, r, n, o);
    else if (i)
      k.unlink(s, (c) => {
        if (c)
          return o(c);
        k.mkdir(s, e, br(s, t, e, i, r, n, o));
      });
    else {
      if (l.isSymbolicLink())
        return o(new St(s, s + "/" + t.join("/")));
      o(h);
    }
  }) : (n = n || s, Ss(s, t, e, i, r, n, o));
};
var oo = (s) => {
  let t = false, e;
  try {
    t = k.statSync(s).isDirectory();
  } catch (i) {
    e = i?.code;
  } finally {
    if (!t)
      throw new Se(s, e ?? "ENOTDIR");
  }
};
var _r = (s, t) => {
  s = f(s);
  let e = t.umask ?? 18, i = t.mode | 448, r = (i & e) !== 0, { uid: n, gid: o } = t, h = typeof n == "number" && typeof o == "number" && (n !== t.processUid || o !== t.processGid), { preserve: a, unlink: l } = t, c = f(t.cwd), d = (E) => {
    E && h && ws(E, n, o), r && k.chmodSync(s, i);
  };
  if (s === c)
    return oo(c), d();
  if (a)
    return d(k.mkdirSync(s, { mode: i, recursive: true }) ?? undefined);
  let T = f(Si.relative(c, s)).split("/"), D;
  for (let E = T.shift(), x = c;E && (x += "/" + E); E = T.shift()) {
    x = f(Si.resolve(x));
    try {
      k.mkdirSync(x, i), D = D || x;
    } catch {
      let Le = k.lstatSync(x);
      if (Le.isDirectory())
        continue;
      if (l) {
        k.unlinkSync(x), k.mkdirSync(x, i), D = D || x;
        continue;
      } else if (Le.isSymbolicLink())
        return new St(x, x + "/" + T.join("/"));
    }
  }
  return d(D);
};
var ys = Object.create(null);
var Or = 1e4;
var Vt = new Set;
var Tr = (s) => {
  Vt.has(s) ? Vt.delete(s) : ys[s] = s.normalize("NFD").toLocaleLowerCase("en").toLocaleUpperCase("en"), Vt.add(s);
  let t = ys[s], e = Vt.size - Or;
  if (e > Or / 10) {
    for (let i of Vt)
      if (Vt.delete(i), delete ys[i], --e <= 0)
        break;
  }
  return t;
};
var ho = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
var ao = ho === "win32";
var lo = (s) => s.split("/").slice(0, -1).reduce((e, i) => {
  let r = e.at(-1);
  return r !== undefined && (i = xr(r, i)), e.push(i || "/"), e;
}, []);
var yi = class {
  #t = new Map;
  #i = new Map;
  #s = new Set;
  reserve(t, e) {
    t = ao ? ["win32 parallelization disabled"] : t.map((r) => mt(xr(Tr(r))));
    let i = new Set(t.map((r) => lo(r)).reduce((r, n) => r.concat(n)));
    this.#i.set(e, { dirs: i, paths: t });
    for (let r of t) {
      let n = this.#t.get(r);
      n ? n.push(e) : this.#t.set(r, [e]);
    }
    for (let r of i) {
      let n = this.#t.get(r);
      if (!n)
        this.#t.set(r, [new Set([e])]);
      else {
        let o = n.at(-1);
        o instanceof Set ? o.add(e) : n.push(new Set([e]));
      }
    }
    return this.#r(e);
  }
  #n(t) {
    let e = this.#i.get(t);
    if (!e)
      throw new Error("function does not have any path reservations");
    return { paths: e.paths.map((i) => this.#t.get(i)), dirs: [...e.dirs].map((i) => this.#t.get(i)) };
  }
  check(t) {
    let { paths: e, dirs: i } = this.#n(t);
    return e.every((r) => r && r[0] === t) && i.every((r) => r && r[0] instanceof Set && r[0].has(t));
  }
  #r(t) {
    return this.#s.has(t) || !this.check(t) ? false : (this.#s.add(t), t(() => this.#e(t)), true);
  }
  #e(t) {
    if (!this.#s.has(t))
      return false;
    let e = this.#i.get(t);
    if (!e)
      throw new Error("invalid reservation");
    let { paths: i, dirs: r } = e, n = new Set;
    for (let o of i) {
      let h = this.#t.get(o);
      if (!h || h?.[0] !== t)
        continue;
      let a = h[1];
      if (!a) {
        this.#t.delete(o);
        continue;
      }
      if (h.shift(), typeof a == "function")
        n.add(a);
      else
        for (let l of a)
          n.add(l);
    }
    for (let o of r) {
      let h = this.#t.get(o), a = h?.[0];
      if (!(!h || !(a instanceof Set)))
        if (a.size === 1 && h.length === 1) {
          this.#t.delete(o);
          continue;
        } else if (a.size === 1) {
          h.shift();
          let l = h[0];
          typeof l == "function" && n.add(l);
        } else
          a.delete(t);
    }
    return this.#s.delete(t), n.forEach((o) => this.#r(o)), true;
  }
};
var Lr = () => process.umask();
var Dr = Symbol("onEntry");
var _s = Symbol("checkFs");
var Nr = Symbol("checkFs2");
var Os = Symbol("isReusable");
var P = Symbol("makeFs");
var Ts = Symbol("file");
var xs = Symbol("directory");
var gi = Symbol("link");
var Ar = Symbol("symlink");
var Ir = Symbol("hardlink");
var Re = Symbol("ensureNoSymlink");
var Cr = Symbol("unsupported");
var Fr = Symbol("checkPath");
var Rs = Symbol("stripAbsolutePath");
var yt = Symbol("mkdir");
var O = Symbol("onError");
var Ri = Symbol("pending");
var kr = Symbol("pend");
var $t = Symbol("unpend");
var gs = Symbol("ended");
var bs = Symbol("maybeClose");
var Ls = Symbol("skip");
var ge = Symbol("doChown");
var be = Symbol("uid");
var _e = Symbol("gid");
var Oe = Symbol("checkedCwd");
var fo = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
var Te = fo === "win32";
var uo = 1024;
var mo = (s, t) => {
  if (!Te)
    return u.unlink(s, t);
  let e = s + ".DELETE." + Mr(16).toString("hex");
  u.rename(s, e, (i) => {
    if (i)
      return t(i);
    u.unlink(e, t);
  });
};
var po = (s) => {
  if (!Te)
    return u.unlinkSync(s);
  let t = s + ".DELETE." + Mr(16).toString("hex");
  u.renameSync(s, t), u.unlinkSync(t);
};
var vr = (s, t, e) => s !== undefined && s === s >>> 0 ? s : t !== undefined && t === t >>> 0 ? t : e;
var Xt = class extends rt {
  [gs] = false;
  [Oe] = false;
  [Ri] = 0;
  reservations = new yi;
  transform;
  writable = true;
  readable = false;
  uid;
  gid;
  setOwner;
  preserveOwner;
  processGid;
  processUid;
  maxDepth;
  forceChown;
  win32;
  newer;
  keep;
  noMtime;
  preservePaths;
  unlink;
  cwd;
  strip;
  processUmask;
  umask;
  dmode;
  fmode;
  chmod;
  constructor(t = {}) {
    if (t.ondone = () => {
      this[gs] = true, this[bs]();
    }, super(t), this.transform = t.transform, this.chmod = !!t.chmod, typeof t.uid == "number" || typeof t.gid == "number") {
      if (typeof t.uid != "number" || typeof t.gid != "number")
        throw new TypeError("cannot set owner without number uid and gid");
      if (t.preserveOwner)
        throw new TypeError("cannot preserve owner in archive and also set owner explicitly");
      this.uid = t.uid, this.gid = t.gid, this.setOwner = true;
    } else
      this.uid = undefined, this.gid = undefined, this.setOwner = false;
    this.preserveOwner = t.preserveOwner === undefined && typeof t.uid != "number" ? process.getuid?.() === 0 : !!t.preserveOwner, this.processUid = (this.preserveOwner || this.setOwner) && process.getuid ? process.getuid() : undefined, this.processGid = (this.preserveOwner || this.setOwner) && process.getgid ? process.getgid() : undefined, this.maxDepth = typeof t.maxDepth == "number" ? t.maxDepth : uo, this.forceChown = t.forceChown === true, this.win32 = !!t.win32 || Te, this.newer = !!t.newer, this.keep = !!t.keep, this.noMtime = !!t.noMtime, this.preservePaths = !!t.preservePaths, this.unlink = !!t.unlink, this.cwd = f(R.resolve(t.cwd || process.cwd())), this.strip = Number(t.strip) || 0, this.processUmask = this.chmod ? typeof t.processUmask == "number" ? t.processUmask : Lr() : 0, this.umask = typeof t.umask == "number" ? t.umask : this.processUmask, this.dmode = t.dmode || 511 & ~this.umask, this.fmode = t.fmode || 438 & ~this.umask, this.on("entry", (e) => this[Dr](e));
  }
  warn(t, e, i = {}) {
    return (t === "TAR_BAD_ARCHIVE" || t === "TAR_ABORT") && (i.recoverable = false), super.warn(t, e, i);
  }
  [bs]() {
    this[gs] && this[Ri] === 0 && (this.emit("prefinish"), this.emit("finish"), this.emit("end"));
  }
  [Rs](t, e) {
    let i = t[e], { type: r } = t;
    if (!i || this.preservePaths)
      return true;
    let [n, o] = ce(i), h = o.replaceAll(/\\/g, "/").split("/");
    if (h.includes("..") || Te && /^[a-z]:\.\.$/i.test(h[0] ?? "")) {
      if (e === "path" || r === "Link")
        return this.warn("TAR_ENTRY_ERROR", `${e} contains '..'`, { entry: t, [e]: i }), false;
      let a = R.posix.dirname(t.path), l = R.posix.normalize(R.posix.join(a, h.join("/")));
      if (l.startsWith("../") || l === "..")
        return this.warn("TAR_ENTRY_ERROR", `${e} escapes extraction directory`, { entry: t, [e]: i }), false;
    }
    return n && (t[e] = String(o), this.warn("TAR_ENTRY_INFO", `stripping ${n} from absolute ${e}`, { entry: t, [e]: i })), true;
  }
  [Fr](t) {
    let e = f(t.path), i = e.split("/");
    if (this.strip) {
      if (i.length < this.strip)
        return false;
      if (t.type === "Link") {
        let r = f(String(t.linkpath)).split("/");
        if (r.length >= this.strip)
          t.linkpath = r.slice(this.strip).join("/");
        else
          return false;
      }
      i.splice(0, this.strip), t.path = i.join("/");
    }
    if (isFinite(this.maxDepth) && i.length > this.maxDepth)
      return this.warn("TAR_ENTRY_ERROR", "path excessively deep", { entry: t, path: e, depth: i.length, maxDepth: this.maxDepth }), false;
    if (!this[Rs](t, "path") || !this[Rs](t, "linkpath"))
      return false;
    if (t.absolute = R.isAbsolute(t.path) ? f(R.resolve(t.path)) : f(R.resolve(this.cwd, t.path)), !this.preservePaths && typeof t.absolute == "string" && t.absolute.indexOf(this.cwd + "/") !== 0 && t.absolute !== this.cwd)
      return this.warn("TAR_ENTRY_ERROR", "path escaped extraction target", { entry: t, path: f(t.path), resolvedPath: t.absolute, cwd: this.cwd }), false;
    if (t.absolute === this.cwd && t.type !== "Directory" && t.type !== "GNUDumpDir")
      return false;
    if (this.win32) {
      let { root: r } = R.win32.parse(String(t.absolute));
      t.absolute = r + ts(String(t.absolute).slice(r.length));
      let { root: n } = R.win32.parse(t.path);
      t.path = n + ts(t.path.slice(n.length));
    }
    return true;
  }
  [Dr](t) {
    if (!this[Fr](t))
      return t.resume();
    switch (co.equal(typeof t.absolute, "string"), t.type) {
      case "Directory":
      case "GNUDumpDir":
        t.mode && (t.mode = t.mode | 448);
      case "File":
      case "OldFile":
      case "ContiguousFile":
      case "Link":
      case "SymbolicLink":
        return this[_s](t);
      default:
        return this[Cr](t);
    }
  }
  [O](t, e) {
    t.name === "CwdError" ? this.emit("error", t) : (this.warn("TAR_ENTRY_ERROR", t, { entry: e }), this[$t](), e.resume());
  }
  [yt](t, e, i) {
    gr(f(t), { uid: this.uid, gid: this.gid, processUid: this.processUid, processGid: this.processGid, umask: this.processUmask, preserve: this.preservePaths, unlink: this.unlink, cwd: this.cwd, mode: e }, i);
  }
  [ge](t) {
    return this.forceChown || this.preserveOwner && (typeof t.uid == "number" && t.uid !== this.processUid || typeof t.gid == "number" && t.gid !== this.processGid) || typeof this.uid == "number" && this.uid !== this.processUid || typeof this.gid == "number" && this.gid !== this.processGid;
  }
  [be](t) {
    return vr(this.uid, t.uid, this.processUid);
  }
  [_e](t) {
    return vr(this.gid, t.gid, this.processGid);
  }
  [Ts](t, e) {
    let i = typeof t.mode == "number" ? t.mode & 4095 : this.fmode, r = new et(String(t.absolute), { flags: ms(t.size), mode: i, autoClose: false });
    r.on("error", (a) => {
      r.fd && u.close(r.fd, () => {}), r.write = () => true, this[O](a, t), e();
    });
    let n = 1, o = (a) => {
      if (a) {
        r.fd && u.close(r.fd, () => {}), this[O](a, t), e();
        return;
      }
      --n === 0 && r.fd !== undefined && u.close(r.fd, (l) => {
        l ? this[O](l, t) : this[$t](), e();
      });
    };
    r.on("finish", () => {
      let a = String(t.absolute), l = r.fd;
      if (typeof l == "number" && t.mtime && !this.noMtime) {
        n++;
        let c = t.atime || new Date, d = t.mtime;
        u.futimes(l, c, d, (y) => y ? u.utimes(a, c, d, (T) => o(T && y)) : o());
      }
      if (typeof l == "number" && this[ge](t)) {
        n++;
        let c = this[be](t), d = this[_e](t);
        typeof c == "number" && typeof d == "number" && u.fchown(l, c, d, (y) => y ? u.chown(a, c, d, (T) => o(T && y)) : o());
      }
      o();
    });
    let h = this.transform && this.transform(t) || t;
    h !== t && (h.on("error", (a) => {
      this[O](a, t), e();
    }), t.pipe(h)), h.pipe(r);
  }
  [xs](t, e) {
    let i = typeof t.mode == "number" ? t.mode & 4095 : this.dmode;
    this[yt](String(t.absolute), i, (r) => {
      if (r) {
        this[O](r, t), e();
        return;
      }
      let n = 1, o = () => {
        --n === 0 && (e(), this[$t](), t.resume());
      };
      t.mtime && !this.noMtime && (n++, u.utimes(String(t.absolute), t.atime || new Date, t.mtime, o)), this[ge](t) && (n++, u.chown(String(t.absolute), Number(this[be](t)), Number(this[_e](t)), o)), o();
    });
  }
  [Cr](t) {
    t.unsupported = true, this.warn("TAR_ENTRY_UNSUPPORTED", `unsupported entry type: ${t.type}`, { entry: t }), t.resume();
  }
  [Ar](t, e) {
    let i = f(R.relative(this.cwd, R.resolve(R.dirname(String(t.absolute)), String(t.linkpath)))).split("/");
    this[Re](t, this.cwd, i, () => this[gi](t, String(t.linkpath), "symlink", e), (r) => {
      this[O](r, t), e();
    });
  }
  [Ir](t, e) {
    let i = f(R.resolve(this.cwd, String(t.linkpath))), r = f(String(t.linkpath)).split("/");
    this[Re](t, this.cwd, r, () => this[gi](t, i, "link", e), (n) => {
      this[O](n, t), e();
    });
  }
  [Re](t, e, i, r, n) {
    let o = i.shift();
    if (this.preservePaths || o === undefined)
      return r();
    let h = R.resolve(e, o);
    u.lstat(h, (a, l) => {
      if (a)
        return r();
      if (l?.isSymbolicLink())
        return n(new St(h, R.resolve(h, i.join("/"))));
      this[Re](t, h, i, r, n);
    });
  }
  [kr]() {
    this[Ri]++;
  }
  [$t]() {
    this[Ri]--, this[bs]();
  }
  [Ls](t) {
    this[$t](), t.resume();
  }
  [Os](t, e) {
    return t.type === "File" && !this.unlink && e.isFile() && e.nlink <= 1 && !Te;
  }
  [_s](t) {
    this[kr]();
    let e = [t.path];
    t.linkpath && e.push(t.linkpath), this.reservations.reserve(e, (i) => this[Nr](t, i));
  }
  [Nr](t, e) {
    let i = (h) => {
      e(h);
    }, r = () => {
      this[yt](this.cwd, this.dmode, (h) => {
        if (h) {
          this[O](h, t), i();
          return;
        }
        this[Oe] = true, n();
      });
    }, n = () => {
      if (t.absolute !== this.cwd) {
        let h = f(R.dirname(String(t.absolute)));
        if (h !== this.cwd)
          return this[yt](h, this.dmode, (a) => {
            if (a) {
              this[O](a, t), i();
              return;
            }
            o();
          });
      }
      o();
    }, o = () => {
      u.lstat(String(t.absolute), (h, a) => {
        if (a && (this.keep || this.newer && a.mtime > (t.mtime ?? a.mtime))) {
          this[Ls](t), i();
          return;
        }
        if (h || this[Os](t, a))
          return this[P](null, t, i);
        if (a.isDirectory()) {
          if (t.type === "Directory") {
            let l = this.chmod && t.mode && (a.mode & 4095) !== t.mode, c = (d) => this[P](d ?? null, t, i);
            return l ? u.chmod(String(t.absolute), Number(t.mode), c) : c();
          }
          if (t.absolute !== this.cwd)
            return u.rmdir(String(t.absolute), (l) => this[P](l ?? null, t, i));
        }
        if (t.absolute === this.cwd)
          return this[P](null, t, i);
        mo(String(t.absolute), (l) => this[P](l ?? null, t, i));
      });
    };
    this[Oe] ? n() : r();
  }
  [P](t, e, i) {
    if (t) {
      this[O](t, e), i();
      return;
    }
    switch (e.type) {
      case "File":
      case "OldFile":
      case "ContiguousFile":
        return this[Ts](e, i);
      case "Link":
        return this[Ir](e, i);
      case "SymbolicLink":
        return this[Ar](e, i);
      case "Directory":
      case "GNUDumpDir":
        return this[xs](e, i);
    }
  }
  [gi](t, e, i, r) {
    u[i](e, String(t.absolute), (n) => {
      n ? this[O](n, t) : (this[$t](), t.resume()), r();
    });
  }
};
var ye = (s) => {
  try {
    return [null, s()];
  } catch (t) {
    return [t, null];
  }
};
var xe = class extends Xt {
  sync = true;
  [P](t, e) {
    return super[P](t, e, () => {});
  }
  [_s](t) {
    if (!this[Oe]) {
      let n = this[yt](this.cwd, this.dmode);
      if (n)
        return this[O](n, t);
      this[Oe] = true;
    }
    if (t.absolute !== this.cwd) {
      let n = f(R.dirname(String(t.absolute)));
      if (n !== this.cwd) {
        let o = this[yt](n, this.dmode);
        if (o)
          return this[O](o, t);
      }
    }
    let [e, i] = ye(() => u.lstatSync(String(t.absolute)));
    if (i && (this.keep || this.newer && i.mtime > (t.mtime ?? i.mtime)))
      return this[Ls](t);
    if (e || this[Os](t, i))
      return this[P](null, t);
    if (i.isDirectory()) {
      if (t.type === "Directory") {
        let o = this.chmod && t.mode && (i.mode & 4095) !== t.mode, [h] = o ? ye(() => {
          u.chmodSync(String(t.absolute), Number(t.mode));
        }) : [];
        return this[P](h, t);
      }
      let [n] = ye(() => u.rmdirSync(String(t.absolute)));
      this[P](n, t);
    }
    let [r] = t.absolute === this.cwd ? [] : ye(() => po(String(t.absolute)));
    this[P](r, t);
  }
  [Ts](t, e) {
    let i = typeof t.mode == "number" ? t.mode & 4095 : this.fmode, r = (h) => {
      let a;
      try {
        u.closeSync(n);
      } catch (l) {
        a = l;
      }
      (h || a) && this[O](h || a, t), e();
    }, n;
    try {
      n = u.openSync(String(t.absolute), ms(t.size), i);
    } catch (h) {
      return r(h);
    }
    let o = this.transform && this.transform(t) || t;
    o !== t && (o.on("error", (h) => this[O](h, t)), t.pipe(o)), o.on("data", (h) => {
      try {
        u.writeSync(n, h, 0, h.length);
      } catch (a) {
        r(a);
      }
    }), o.on("end", () => {
      let h = null;
      if (t.mtime && !this.noMtime) {
        let a = t.atime || new Date, l = t.mtime;
        try {
          u.futimesSync(n, a, l);
        } catch (c) {
          try {
            u.utimesSync(String(t.absolute), a, l);
          } catch {
            h = c;
          }
        }
      }
      if (this[ge](t)) {
        let a = this[be](t), l = this[_e](t);
        try {
          u.fchownSync(n, Number(a), Number(l));
        } catch (c) {
          try {
            u.chownSync(String(t.absolute), Number(a), Number(l));
          } catch {
            h = h || c;
          }
        }
      }
      r(h);
    });
  }
  [xs](t, e) {
    let i = typeof t.mode == "number" ? t.mode & 4095 : this.dmode, r = this[yt](String(t.absolute), i);
    if (r) {
      this[O](r, t), e();
      return;
    }
    if (t.mtime && !this.noMtime)
      try {
        u.utimesSync(String(t.absolute), t.atime || new Date, t.mtime);
      } catch {}
    if (this[ge](t))
      try {
        u.chownSync(String(t.absolute), Number(this[be](t)), Number(this[_e](t)));
      } catch {}
    e(), t.resume();
  }
  [yt](t, e) {
    try {
      return _r(f(t), { uid: this.uid, gid: this.gid, processUid: this.processUid, processGid: this.processGid, umask: this.processUmask, preserve: this.preservePaths, unlink: this.unlink, cwd: this.cwd, mode: e });
    } catch (i) {
      return i;
    }
  }
  [Re](t, e, i, r, n) {
    if (this.preservePaths || i.length === 0)
      return r();
    let o = e;
    for (let h of i) {
      o = R.resolve(o, h);
      let [a, l] = ye(() => u.lstatSync(o));
      if (a)
        return r();
      if (l.isSymbolicLink())
        return n(new St(o, R.resolve(e, i.join("/"))));
    }
    r();
  }
  [gi](t, e, i, r) {
    let n = `${i}Sync`;
    try {
      u[n](e, String(t.absolute)), r(), t.resume();
    } catch (o) {
      return this[O](o, t);
    }
  }
};
var Eo = (s) => {
  let t = new xe(s), e = s.file, i = Br.statSync(e), r = s.maxReadSize || 16 * 1024 * 1024;
  new Be(e, { readSize: r, size: i.size }).pipe(t);
};
var wo = (s, t) => {
  let e = new Xt(s), i = s.maxReadSize || 16 * 1024 * 1024, r = s.file;
  return new Promise((o, h) => {
    e.on("error", h), e.on("close", o), Br.stat(r, (a, l) => {
      if (a)
        h(a);
      else {
        let c = new _t(r, { readSize: i, size: l.size });
        c.on("error", h), c.pipe(e);
      }
    });
  });
};
var So = K(Eo, wo, (s) => new xe(s), (s) => new Xt(s), (s, t) => {
  t?.length && Qi(s, t);
});
var yo = (s, t) => {
  let e = new kt(s), i = true, r, n;
  try {
    try {
      r = v.openSync(s.file, "r+");
    } catch (a) {
      if (a?.code === "ENOENT")
        r = v.openSync(s.file, "w+");
      else
        throw a;
    }
    let o = v.fstatSync(r), h = Buffer.alloc(512);
    t:
      for (n = 0;n < o.size; n += 512) {
        for (let c = 0, d = 0;c < 512; c += d) {
          if (d = v.readSync(r, h, c, h.length - c, n + c), n === 0 && h[0] === 31 && h[1] === 139)
            throw new Error("cannot append to compressed archives");
          if (!d)
            break t;
        }
        let a = new F(h);
        if (!a.cksumValid)
          break;
        let l = 512 * Math.ceil((a.size || 0) / 512);
        if (n + l + 512 > o.size)
          break;
        n += l, s.mtimeCache && a.mtime && s.mtimeCache.set(String(a.path), a.mtime);
      }
    i = false, Ro(s, e, n, r, t);
  } finally {
    if (i)
      try {
        v.closeSync(r);
      } catch {}
  }
};
var Ro = (s, t, e, i, r) => {
  let n = new Wt(s.file, { fd: i, start: e });
  t.pipe(n), bo(t, r);
};
var go = (s, t) => {
  t = Array.from(t);
  let e = new wt(s), i = (n, o, h) => {
    let a = (T, D) => {
      T ? v.close(n, (E) => h(T)) : h(null, D);
    }, l = 0;
    if (o === 0)
      return a(null, 0);
    let c = 0, d = Buffer.alloc(512), y = (T, D) => {
      if (T || D === undefined)
        return a(T);
      if (c += D, c < 512 && D)
        return v.read(n, d, c, d.length - c, l + c, y);
      if (l === 0 && d[0] === 31 && d[1] === 139)
        return a(new Error("cannot append to compressed archives"));
      if (c < 512)
        return a(null, l);
      let E = new F(d);
      if (!E.cksumValid)
        return a(null, l);
      let x = 512 * Math.ceil((E.size ?? 0) / 512);
      if (l + x + 512 > o || (l += x + 512, l >= o))
        return a(null, l);
      s.mtimeCache && E.mtime && s.mtimeCache.set(String(E.path), E.mtime), c = 0, v.read(n, d, 0, 512, l, y);
    };
    v.read(n, d, 0, 512, l, y);
  };
  return new Promise((n, o) => {
    e.on("error", o);
    let h = "r+", a = (l, c) => {
      if (l && l.code === "ENOENT" && h === "r+")
        return h = "w+", v.open(s.file, h, a);
      if (l || !c)
        return o(l);
      v.fstat(c, (d, y) => {
        if (d)
          return v.close(c, () => o(d));
        i(c, y.size, (T, D) => {
          if (T)
            return o(T);
          let E = new et(s.file, { fd: c, start: D });
          e.pipe(E), E.on("error", o), E.on("close", n), _o(e, t);
        });
      });
    };
    v.open(s.file, h, a);
  });
};
var bo = (s, t) => {
  t.forEach((e) => {
    e.charAt(0) === "@" ? Ct({ file: Pr.resolve(s.cwd, e.slice(1)), sync: true, noResume: true, onReadEntry: (i) => s.add(i) }) : s.add(e);
  }), s.end();
};
var _o = async (s, t) => {
  for (let e of t)
    e.charAt(0) === "@" ? await Ct({ file: Pr.resolve(String(s.cwd), e.slice(1)), noResume: true, onReadEntry: (i) => s.add(i) }) : s.add(e);
  s.end();
};
var vt = K(yo, go, () => {
  throw new TypeError("file is required");
}, () => {
  throw new TypeError("file is required");
}, (s, t) => {
  if (!Bs(s))
    throw new TypeError("file is required");
  if (s.gzip || s.brotli || s.zstd || s.file.endsWith(".br") || s.file.endsWith(".tbr"))
    throw new TypeError("cannot append to compressed archives");
  if (!t?.length)
    throw new TypeError("no paths specified to add/replace");
});
var Oo = K(vt.syncFile, vt.asyncFile, vt.syncNoFile, vt.asyncNoFile, (s, t = []) => {
  vt.validate?.(s, t), To(s);
});
var To = (s) => {
  let t = s.filter;
  s.mtimeCache || (s.mtimeCache = new Map), s.filter = t ? (e, i) => t(e, i) && !((s.mtimeCache?.get(e) ?? i.mtime ?? 0) > (i.mtime ?? 0)) : (e, i) => !((s.mtimeCache?.get(e) ?? i.mtime ?? 0) > (i.mtime ?? 0));
};

// ../../registry-format/src/package-set.ts
var PACKAGE_MANIFEST_FILE = "nimbus.extension.json";
var DIST_DIR = "dist";
var DOC_FILE_RE = /^(README|LICENSE)(\..+)?$/i;
function isPackageFile(relPath) {
  if (relPath === PACKAGE_MANIFEST_FILE)
    return true;
  if (relPath.startsWith(`${DIST_DIR}/`))
    return relPath.length > DIST_DIR.length + 1;
  return !relPath.includes("/") && DOC_FILE_RE.test(relPath);
}

// ../../registry-format/src/inspect.ts
function describeEntryType(type) {
  if (type === "SymbolicLink")
    return "symlink";
  if (type === "Link")
    return "hardlink";
  return `${type} entry`;
}
var extractFailed = (detail) => new RegistryError("ERR_REGISTRY_EXTRACT_FAILED", detail);
var manifestInvalid = (detail) => new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", detail);
function readRegularFile(path, missing, maxBytes) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    throw missing();
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile())
      throw missing();
    if (maxBytes !== undefined && st.size > maxBytes)
      throw manifestInvalid("manifest is too large");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
async function inspectPackage(tgz, work) {
  let entries = 0;
  let declaredBytes = 0;
  let badEntry;
  const files = [];
  await Ct({
    file: tgz,
    onReadEntry: (entry) => {
      entries++;
      if (badEntry === undefined && entry.type !== "File" && entry.type !== "Directory") {
        badEntry = `package entry ${entry.path} is a ${describeEntryType(entry.type)}; only files and directories are allowed`;
      }
      if (entry.type === "File")
        files.push(entry.path.replaceAll("\\", "/"));
      declaredBytes += entry.size ?? 0;
      entry.resume();
    }
  });
  if (badEntry !== undefined)
    throw extractFailed(badEntry);
  if (entries > MAX_ENTRY_COUNT) {
    throw extractFailed(`package has more than ${String(MAX_ENTRY_COUNT)} entries`);
  }
  if (declaredBytes > MAX_UNPACKED_BYTES) {
    throw extractFailed("package unpacked size exceeds 200 MiB");
  }
  const out = join(work, "x");
  mkdirSync(out);
  await So({
    file: tgz,
    cwd: out,
    strict: true,
    filter: (_path, entry) => {
      const type = "type" in entry ? entry.type : "File";
      return type === "File" || type === "Directory";
    }
  });
  const manifestBytes = readRegularFile(join(out, PACKAGE_MANIFEST_FILE), () => manifestInvalid(`package has no ${PACKAGE_MANIFEST_FILE} at its root`), MAX_MANIFEST_BYTES);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw manifestInvalid("manifest is not valid JSON");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw manifestInvalid("manifest is not a JSON object");
  }
  const m = manifest;
  const entryRel = rawManifestEntryRelPath(m);
  const entryPath = resolve(out, entryRel);
  const missing = () => manifestInvalid(`extension entry ${entryRel} is missing or outside the package`);
  if (!entryPath.startsWith(resolve(out) + sep))
    throw missing();
  const entryBytes = readRegularFile(entryPath, missing);
  return {
    manifestBytes,
    manifest: m,
    entryHash: createHash3("sha256").update(entryBytes).digest("hex"),
    files: files.toSorted(codeUnitCompare)
  };
}
// ../../registry-format/src/rotation-graph.ts
function walk(start, next, allow) {
  const seen = new Set;
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const n of next(node)) {
      if (seen.has(n) || n === start || !allow(n))
        continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}
function adjacency(edges, reverse) {
  const out = new Map;
  for (const e of edges) {
    const [a, b] = reverse ? [e.to, e.from] : [e.from, e.to];
    const list = out.get(a) ?? [];
    list.push(b);
    out.set(a, list);
  }
  return out;
}
function ancestorsOf(edges, fp) {
  const back = adjacency(edges, true);
  return walk(fp, (n) => back.get(n) ?? [], () => true);
}
function successorsOf(edges, fp, usable) {
  if (!usable(fp))
    return { reachable: new Set, terminal: new Set };
  const fwd = adjacency(edges, false);
  const reachable = walk(fp, (n) => fwd.get(n) ?? [], usable);
  const terminal = new Set;
  for (const n of reachable) {
    const onward = (fwd.get(n) ?? []).filter((m) => usable(m) && m !== n);
    if (onward.length === 0)
      terminal.add(n);
  }
  return { reachable, terminal };
}

// ../../registry-format/src/publisher-statements.ts
var MAX_REGISTRY_STATEMENTS = 1000;
var MAX_ROTATIONS_PER_PUBLISHER = 20;
var MAX_STATEMENTS_PER_PUBLISHER = 50;
function publisherAfterPublish(existing, signer) {
  return existing !== undefined && existing.publisher.key === signer.key ? existing.publisher : signer;
}
function indexedPublisherStatements(index) {
  return readStatementList(index.statements).statements.filter((s) => (s.kind === "key.rotate" || s.kind === "key.revoke") && verifyTrustStatement(s, {}) === "publisher");
}
function boundKeys(index, publisherId) {
  const out = new Set;
  for (const e of Object.values(index.extensions)) {
    if (e.publisher.id === publisherId)
      out.add(e.publisher.key);
  }
  return out;
}
var rotationsOf = (list) => list.filter((s) => s.kind === "key.rotate");
var edgesOf = (rotations) => rotations.map((r) => ({
  from: publisherKeyFingerprint(r.fromKey),
  to: publisherKeyFingerprint(r.toKey)
}));
var signingKey = (s) => s.kind === "key.rotate" ? s.fromKey : s.signerKey;
function stateOf(index, publisherId, list = indexedPublisherStatements(index)) {
  const mine = list.filter((s) => s.publisherId === publisherId);
  return {
    bound: boundKeys(index, publisherId),
    rotations: rotationsOf(mine),
    revokedFps: new Set(mine.filter((s) => s.kind === "key.revoke").map((s) => s.keyFingerprint))
  };
}
function revokedIn(state, fp) {
  if (state.revokedFps.has(fp))
    return true;
  for (const a of ancestorsOf(edgesOf(state.rotations), fp)) {
    if (state.revokedFps.has(a))
      return true;
  }
  return false;
}
function currentOf(state) {
  const keyByFp = new Map;
  for (const k of state.bound)
    keyByFp.set(publisherKeyFingerprint(k), k);
  for (const r of state.rotations) {
    keyByFp.set(publisherKeyFingerprint(r.fromKey), r.fromKey);
    keyByFp.set(publisherKeyFingerprint(r.toKey), r.toKey);
  }
  const edges = edgesOf(state.rotations);
  const usable = (fp) => !state.revokedFps.has(fp);
  const rotatedAway = new Set(edges.map((e) => e.from));
  const current = new Set;
  for (const k of state.bound) {
    const fp = publisherKeyFingerprint(k);
    if (!usable(fp))
      continue;
    const { reachable } = successorsOf(edges, fp, usable);
    for (const n of [fp, ...reachable]) {
      if (!rotatedAway.has(n))
        current.add(keyByFp.get(n));
    }
  }
  return current;
}
function publisherKeyStanding(index, publisherId, key) {
  const state = stateOf(index, publisherId);
  const current = [...currentOf(state)].sort(codeUnitCompare);
  const refuse = (reason) => ({
    ok: false,
    reason,
    current
  });
  if (revokedIn(state, publisherKeyFingerprint(key)))
    return refuse("revoked");
  if (state.bound.size === 0)
    return { ok: true };
  if (current.length === 1 && current[0] === key)
    return { ok: true };
  if (current.length > 1)
    return refuse("fork");
  const known = new Set([...state.bound, ...state.rotations.map((r) => r.fromKey)]);
  if (known.has(key))
    return refuse("superseded");
  const looped = current.length === 0 && [...state.bound].some((k) => !state.revokedFps.has(publisherKeyFingerprint(k)));
  return refuse(looped ? "fork" : "unrelated");
}
function structural(index, raw, skip) {
  let s;
  try {
    s = parseTrustStatement(raw);
  } catch (e) {
    skip(undefined, `not a valid statement: ${e.message}`);
    return;
  }
  const id = trustStatementId(s);
  if (s.kind !== "key.rotate" && s.kind !== "key.revoke") {
    skip(id, `${s.kind} is signed by a root key, not a publisher; a registry admits only key.rotate and key.revoke here`);
    return;
  }
  if (verifyTrustStatement(s, {}) !== "publisher") {
    skip(id, `${s.kind} is not signed by the key it concerns`);
    return;
  }
  if (boundKeys(index, s.publisherId).size === 0) {
    skip(id, `publisher ${s.publisherId} has no extension in this index`);
    return;
  }
  return { id, s };
}
function reachOf(bound, rotations) {
  const reach = new Set(bound);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rotations) {
      if (reach.has(r.fromKey) && !reach.has(r.toKey)) {
        reach.add(r.toKey);
        grew = true;
      }
    }
  }
  return reach;
}
function hasRoom(budget, id, publisherId, skip) {
  if (budget.total >= MAX_REGISTRY_STATEMENTS) {
    skip(id, `the index is at its statement cap (${String(MAX_REGISTRY_STATEMENTS)})`);
    return false;
  }
  if (budget.publisher >= MAX_STATEMENTS_PER_PUBLISHER) {
    skip(id, `publisher ${publisherId} is at its statement cap (${String(MAX_STATEMENTS_PER_PUBLISHER)})`);
    return false;
  }
  return true;
}
function spend(budget) {
  budget.total++;
  budget.publisher++;
}
function forks(pending, admitted) {
  const targets = new Map;
  const add = (from, to) => {
    const set = targets.get(from) ?? new Set;
    set.add(to);
    targets.set(from, set);
  };
  for (const r of admitted)
    add(r.fromKey, r.toKey);
  for (const p of pending)
    if (p.s.kind === "key.rotate")
      add(p.s.fromKey, p.s.toKey);
  const out = new Set;
  for (const p of pending) {
    if (p.s.kind === "key.rotate" && (targets.get(p.s.fromKey)?.size ?? 0) > 1)
      out.add(p.id);
  }
  return out;
}
var fromRevoked = (run, r) => revokedIn(run.state, publisherKeyFingerprint(r.fromKey));
function admitRevocationRound(run, reach) {
  let progressed = false;
  for (const [id, p] of run.revocations) {
    const r = p.s;
    if (!reach.has(r.signerKey))
      continue;
    run.revocations.delete(id);
    if (run.state.revokedFps.has(r.keyFingerprint)) {
      run.skip(id, `redundant: key ${r.keyFingerprint} is already revoked`);
      continue;
    }
    if (!hasRoom(run.budget, id, r.publisherId, run.skip))
      continue;
    run.state.revokedFps.add(r.keyFingerprint);
    spend(run.budget);
    run.admitted.push(p);
    progressed = true;
  }
  return progressed;
}
function admitRotationRound(run, reach) {
  let progressed = false;
  const reachedNow = new Set;
  for (const [id, p] of run.rotations) {
    const r = p.s;
    if (!reach.has(r.fromKey) || fromRevoked(run, r))
      continue;
    run.rotations.delete(id);
    if (reach.has(r.toKey) || reachedNow.has(r.toKey)) {
      run.skip(id, `key ${publisherKeyFingerprint(r.toKey)} is already reached: a loop or a repeat`);
      continue;
    }
    if (run.state.rotations.length >= MAX_ROTATIONS_PER_PUBLISHER) {
      run.skip(id, `publisher ${r.publisherId} is at its rotation cap (${String(MAX_ROTATIONS_PER_PUBLISHER)})`);
      continue;
    }
    if (!hasRoom(run.budget, id, r.publisherId, run.skip))
      continue;
    run.state.rotations.push(r);
    reachedNow.add(r.toKey);
    spend(run.budget);
    run.admitted.push(p);
    progressed = true;
  }
  return progressed;
}
function leftoverReason(run, p, publisherId) {
  if (p.s.kind === "key.rotate" && fromRevoked(run, p.s)) {
    return `from revoked key ${publisherKeyFingerprint(p.s.fromKey)}`;
  }
  return `signing key ${publisherKeyFingerprint(signingKey(p.s))} is not bound to publisher ${publisherId} in this index (directly or through an admitted rotation)`;
}
function admitForPublisher(publisherId, mine, state, budget, skip) {
  const pendingRotations = mine.filter((p) => p.s.kind === "key.rotate");
  const forked = forks(pendingRotations, state.rotations);
  for (const p of pendingRotations) {
    if (!forked.has(p.id))
      continue;
    const from = publisherKeyFingerprint(p.s.fromKey);
    skip(p.id, `fork: key ${from} already rotates, or is asked to rotate, to a different key`);
  }
  const run = {
    state,
    budget,
    skip,
    revocations: new Map(mine.filter((p) => p.s.kind === "key.revoke").map((p) => [p.id, p])),
    rotations: new Map(pendingRotations.filter((p) => !forked.has(p.id)).map((p) => [p.id, p])),
    admitted: []
  };
  let progressed = true;
  while (progressed) {
    const reach = reachOf(state.bound, state.rotations);
    const revoked = admitRevocationRound(run, reach);
    const rotated = admitRotationRound(run, reach);
    progressed = revoked || rotated;
  }
  for (const p of [...run.revocations.values(), ...run.rotations.values()]) {
    skip(p.id, leftoverReason(run, p, publisherId));
  }
  return run.admitted;
}
function newCandidates(index, raws, existingIds, skip) {
  const byId = new Map;
  for (const raw of raws) {
    const p = structural(index, raw, skip);
    if (p !== undefined && !existingIds.has(p.id))
      byId.set(p.id, p);
  }
  return [...byId.values()].sort((a, b) => codeUnitCompare(a.id, b.id));
}
function admitPublisherStatements(index, candidates) {
  const existingRaw = Array.isArray(index.statements) ? [...index.statements] : [];
  const indexed = indexedPublisherStatements(index);
  const existingIds = new Set(readStatementList(index.statements).statements.map(trustStatementId));
  const skippedAll = [];
  const skip = (id, reason) => {
    skippedAll.push({ id, reason });
  };
  const fresh = newCandidates(index, candidates, existingIds, skip);
  const total = { value: existingRaw.length };
  const admitted = [];
  const publishers = [...new Set(fresh.map((p) => p.s.publisherId))].sort(codeUnitCompare);
  for (const publisherId of publishers) {
    const state = stateOf(index, publisherId, indexed);
    const mine = fresh.filter((p) => p.s.publisherId === publisherId);
    const already = indexed.filter((x) => x.publisherId === publisherId).length;
    const budget = { total: total.value, publisher: already };
    admitted.push(...admitForPublisher(publisherId, mine, state, budget, skip));
    total.value = budget.total;
  }
  return {
    index: admitted.length === 0 ? index : { ...index, statements: [...existingRaw, ...admitted.map((p) => p.s)] },
    admitted: admitted.map((p) => p.s),
    skipped: skippedAll
  };
}
// ../../registry-format/src/sign.ts
import { createPublicKey, sign as sign2, verify } from "node:crypto";
function publicKeyFromSeed(seed) {
  const jwk = createPublicKey(privateKeyFromSeed(seed)).export({ format: "jwk" });
  return new Uint8Array(Buffer.from(jwk.x, "base64url"));
}
var SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function signIndex(unsigned, privkey) {
  return new Promise((resolve) => {
    const { signature: _omitted, ...rest } = unsigned;
    const sig = sign2(null, registryIndexSigningBytes(rest), privateKeyFromSeed(privkey));
    resolve({ ...rest, signature: sig.toString("base64") });
  });
}

// ../../registry-format/src/registry-requests.ts
var REQUEST_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var REVOKE_KEYS = ["kind", "publisherId", "keyFingerprint", "reason"];
var TAKEDOWN_KEYS = ["kind", "extensionId", "publisherId", "versions", "reason"];
var TAKEDOWN_REQUIRED = ["kind", "extensionId", "versions", "reason"];
var PLACEHOLDER_KEY = `${"A".repeat(43)}=`;
var PLACEHOLDER_SIGNATURE = `${"A".repeat(86)}==`;
var PLACEHOLDER_PUBLISHER = "placeholder";
function invalid3(detail) {
  return new RegistryError("ERR_TRUST_STATEMENT_INVALID", detail);
}
function exactKeys(o, allowed, required) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k))
      throw invalid3(`a request has an unknown key: ${k}`);
  }
  for (const k of required) {
    if (!Object.hasOwn(o, k))
      throw invalid3(`a request is missing key: ${k}`);
  }
}
function parseRegistryRequest(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid3("a request must be an object");
  }
  const o = raw;
  const signer = {
    issuedAt: "2026-01-01T00:00:00Z",
    signerKey: PLACEHOLDER_KEY,
    signature: PLACEHOLDER_SIGNATURE
  };
  if (o["kind"] === "key.revoke") {
    exactKeys(o, REVOKE_KEYS, REVOKE_KEYS);
    const s = parseTrustStatement({ ...o, ...signer });
    return {
      kind: "key.revoke",
      publisherId: s.publisherId,
      keyFingerprint: s.keyFingerprint,
      reason: s.reason
    };
  }
  if (o["kind"] === "extension.takedown") {
    exactKeys(o, TAKEDOWN_KEYS, TAKEDOWN_REQUIRED);
    const explicit = o["publisherId"];
    const s = parseTrustStatement({
      ...o,
      publisherId: explicit === undefined ? PLACEHOLDER_PUBLISHER : explicit,
      ...signer
    });
    return {
      kind: "extension.takedown",
      extensionId: s.extensionId,
      ...explicit === undefined ? {} : { publisherId: s.publisherId },
      versions: s.versions,
      reason: s.reason
    };
  }
  throw invalid3("a request's kind must be key.revoke or extension.takedown");
}
function takedownPublisher(req, index) {
  const entry = Object.hasOwn(index.extensions, req.extensionId) ? index.extensions[req.extensionId] : undefined;
  if (entry !== undefined) {
    if (req.publisherId !== undefined && req.publisherId !== entry.publisher.id) {
      throw invalid3(`${req.extensionId} is bound to publisher ${entry.publisher.id} in this registry, not ${req.publisherId}`);
    }
    return entry.publisher.id;
  }
  if (req.publisherId === undefined) {
    throw invalid3(`${req.extensionId} is not in this registry's index; name its publisher with --publisher to take down copies already installed`);
  }
  return req.publisherId;
}
function assertRequestSignable(req, index) {
  if (req.kind === "extension.takedown") {
    takedownPublisher(req, index);
    return;
  }
  if (req.keyFingerprint === publisherKeyFingerprint(index.rootKey)) {
    throw invalid3("a registry cannot revoke its own root key this way; re-initialise the registry instead");
  }
}
async function signRegistryRequest(req, index, rootSeed, issuedAt) {
  const signerKey = Buffer.from(publicKeyFromSeed(rootSeed)).toString("base64");
  if (signerKey !== index.rootKey) {
    throw invalid3(`the key given (fingerprint ${publisherKeyFingerprint(signerKey)}) is not this registry's root key (${publisherKeyFingerprint(index.rootKey)})`);
  }
  assertRequestSignable(req, index);
  if (req.kind === "key.revoke") {
    return signTrustStatement({ ...req, issuedAt, signerKey }, rootSeed);
  }
  const { publisherId: _explicit, ...rest } = req;
  return signTrustStatement({ ...rest, publisherId: takedownPublisher(req, index), issuedAt, signerKey }, rootSeed);
}
function covers(have, want) {
  if (have === "*")
    return true;
  if (want === "*")
    return false;
  return want.every((v) => have.includes(v));
}
function sameBlock(s, req, index) {
  if (req.kind === "key.revoke") {
    return s.kind === "key.revoke" && s.publisherId === req.publisherId && s.keyFingerprint === req.keyFingerprint;
  }
  if (s.kind !== "extension.takedown" || s.extensionId !== req.extensionId)
    return false;
  let publisher;
  try {
    publisher = takedownPublisher(req, index);
  } catch {
    return false;
  }
  return s.publisherId === publisher && covers(s.versions, req.versions);
}
function alreadyCarried(index, req) {
  return readStatementList(index.statements).statements.some((s) => verifyTrustStatement(s, { registryRootKey: index.rootKey }) === "registry" && s.signerKey === index.rootKey && sameBlock(s, req, index));
}
// ../../registry-format/src/validate-publish.ts
import { createHash as createHash4 } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
var import_semver5 = __toESM(require_semver2(), 1);
var MAX_SMALL_JSON_BYTES = 4096;
var PUBLISH_REQUEST_KEYS = ["id", "version", "channel", "publisherFingerprint"];
var CONFIG_KEYS = ["format", "requirePublisherNamespace"];
var FINGERPRINT_RE2 = /^[0-9a-f]{32}$/;
var DIST_PREFIX = "dist/";
function decodeJsonObject(bytes, what, fail) {
  let raw;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw fail(`${what} is not valid UTF-8 JSON`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail(`${what} must be a JSON object`);
  }
  return raw;
}
function requireExactKeys(o, keys, what, fail) {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k))
      throw fail(`${what} has an unknown key: ${k}`);
  }
  for (const k of keys) {
    if (!Object.hasOwn(o, k))
      throw fail(`${what} is missing key: ${k}`);
  }
}
var configInvalid = (detail) => new RegistryError("ERR_REGISTRY_CONFIG_INVALID", detail);
function parseRegistryConfig(bytes) {
  const what = "nimbus-registry.json";
  if (bytes.byteLength > MAX_SMALL_JSON_BYTES)
    throw configInvalid(`${what} is too large`);
  const o = decodeJsonObject(bytes, what, configInvalid);
  requireExactKeys(o, CONFIG_KEYS, what, configInvalid);
  if (o["format"] !== 1)
    throw configInvalid(`${what} has an unsupported format`);
  const ns = o["requirePublisherNamespace"];
  if (typeof ns !== "boolean") {
    throw configInvalid(`${what}.requirePublisherNamespace must be a boolean`);
  }
  return { format: 1, requirePublisherNamespace: ns };
}
function effectiveRegistryConfig(pages, defaultBranch) {
  return {
    format: 1,
    requirePublisherNamespace: (pages?.requirePublisherNamespace ?? false) || (defaultBranch?.requirePublisherNamespace ?? false)
  };
}
var requestInvalid = (detail) => new RegistryError("ERR_REGISTRY_PUBLISH_REQUEST_INVALID", detail);
function parsePublishRequest(bytes) {
  const what = "publish-request.json";
  if (bytes.byteLength > MAX_SMALL_JSON_BYTES)
    throw requestInvalid(`${what} is too large`);
  const o = decodeJsonObject(bytes, what, requestInvalid);
  requireExactKeys(o, PUBLISH_REQUEST_KEYS, what, requestInvalid);
  const { id, version, channel, publisherFingerprint } = o;
  if (typeof id !== "string" || typeof version !== "string") {
    throw requestInvalid(`${what}.id and .version must be strings`);
  }
  if (channel !== "stable" && channel !== "beta") {
    throw requestInvalid(`${what}.channel must be "stable" or "beta"`);
  }
  if (typeof publisherFingerprint !== "string" || !FINGERPRINT_RE2.test(publisherFingerprint)) {
    throw requestInvalid(`${what}.publisherFingerprint must be 32 lowercase hex characters`);
  }
  return { id, version, channel, publisherFingerprint };
}
var manifestInvalid2 = (detail) => new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", detail);
function parseCandidateManifest(bytes) {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new RegistryError("ERR_REGISTRY_TOO_LARGE", `manifest exceeds ${String(MAX_MANIFEST_BYTES)} bytes`);
  }
  const raw = decodeJsonObject(bytes, "manifest", manifestInvalid2);
  let manifest;
  try {
    manifest = parseExtensionManifestForRegistry(new TextDecoder().decode(bytes)).manifest;
    assertSafeExtensionId(manifest.id);
  } catch (e) {
    if (e instanceof RegistryError)
      throw e;
    throw manifestInvalid2(e.message);
  }
  assertCanonicalExtensionId(typeof raw["id"] === "string" ? raw["id"] : "");
  assertPublishableExtensionId(manifest.id);
  if (raw["version"] !== manifest.version) {
    throw manifestInvalid2(`version ${JSON.stringify(raw["version"])} has surrounding whitespace`);
  }
  if (!isValidSemver(manifest.version)) {
    throw manifestInvalid2(`version ${JSON.stringify(manifest.version)} is not strict semver`);
  }
  if (manifest.version.includes("+")) {
    throw manifestInvalid2(`version ${manifest.version} carries build metadata, which a published version may not`);
  }
  return { manifest, raw };
}
function assertCoordinates(c, m, req) {
  for (const [field, dir, fromReq] of [
    ["id", c.dirId, req.id],
    ["version", c.dirVersion, req.version]
  ]) {
    const fromManifest = m[field];
    if (dir !== fromManifest || fromReq !== fromManifest) {
      throw requestInvalid(`manifest ${field} ${JSON.stringify(fromManifest)} must equal the directory's ` + `(${JSON.stringify(dir)}) and publish-request.json's (${JSON.stringify(fromReq)})`);
    }
  }
}
async function assertSigned(m, raw) {
  if (m.publisher === undefined || m.signature === undefined) {
    throw new RegistryError("ERR_REGISTRY_SIGNATURE_INVALID", "a published manifest must carry publisher and signature");
  }
  try {
    await verifyManifestSignature(raw, new Uint8Array(Buffer.from(m.publisher.key, "base64")));
  } catch {
    throw new RegistryError("ERR_REGISTRY_SIGNATURE_INVALID", `manifest signature does not verify with publisher ${m.publisher.id}'s key`);
  }
  return m.publisher;
}
function indexedServiceIds(signed) {
  const out = new Map;
  for (const id of Object.keys(signed.extensions)) {
    try {
      out.set(deriveExtensionServiceId(id), id);
    } catch {}
  }
  return out;
}
function assertCurrentPublisherKey(publisher, signed) {
  const standing = publisherKeyStanding(signed, publisher.id, publisher.key);
  if (standing.ok)
    return;
  const fp = publisherKeyFingerprint(publisher.key);
  const current = standing.current.map(publisherKeyFingerprint).join(", ");
  if (standing.current.length === 0 && standing.reason !== "revoked") {
    throw keyConflict(`publisher ${publisher.id} has no current key in this registry (its key chain ends in a revoked key, or loops); no key can publish until the registry maintainer resolves it`);
  }
  switch (standing.reason) {
    case "revoked":
      throw new RegistryError("ERR_REGISTRY_PUBLISHER_KEY_REVOKED", `publisher ${publisher.id}'s key ${fp} is revoked in this registry (itself or a key it was rotated from)`);
    case "superseded":
      throw keyConflict(`publisher ${publisher.id}'s key ${fp} is superseded by ${current}; sign with the current key`);
    case "fork":
      throw keyConflict(`publisher ${publisher.id}'s key rotations fork or loop (current keys: ${current || "none"}); no key can publish until the registry maintainer resolves it`);
    case "unrelated": {
      const bound = Object.entries(signed.extensions).filter(([, e]) => e.publisher.id === publisher.id).map(([id]) => id).sort(codeUnitCompare).join(", ");
      throw keyConflict(`publisher ${publisher.id} is bound to key ${current || "(revoked)"} by indexed extension ${bound}; this manifest is signed by ${fp}, which no key.rotate in the index reaches — include the key.rotate statement with --statement`);
    }
  }
}
function assertKeyMoveOnStable(id, publisher, channel, signed) {
  const existing = Object.hasOwn(signed.extensions, id) ? signed.extensions[id] : undefined;
  if (existing === undefined || existing.publisher.key === publisher.key || channel === "stable") {
    return;
  }
  throw keyConflict(`${id} is bound to key ${publisherKeyFingerprint(existing.publisher.key)}; publish the first version under key ${publisherKeyFingerprint(publisher.key)} on the stable channel, or default installs of the newest stable version would break`);
}
var keyConflict = (detail) => new RegistryError("ERR_REGISTRY_PUBLISHER_KEY_CONFLICT", detail);
function assertRegistryState(m, publisher, serviceId, signed) {
  const existing = Object.hasOwn(signed.extensions, m.id) ? signed.extensions[m.id] : undefined;
  if (existing === undefined) {
    const indexed = indexedServiceIds(signed);
    const hit = findServiceIdPrefixCollision(serviceId, [...indexed.keys()]);
    if (hit !== undefined) {
      throw new RegistryError("ERR_REGISTRY_SERVICE_ID_COLLISION", `service id ${serviceId} of new id ${m.id} collides with ${hit} of indexed id ${String(indexed.get(hit))}`);
    }
  }
  if (existing !== undefined && existing.publisher.id !== publisher.id) {
    throw new RegistryError("ERR_REGISTRY_PUBLISHER_KEY_CONFLICT", `${m.id} is bound to publisher ${existing.publisher.id}`);
  }
  assertCurrentPublisherKey(publisher, signed);
  if (existing !== undefined) {
    const taken = Object.keys(existing.versions).find((v) => v === m.version || import_semver5.default.compare(v, m.version) === 0);
    if (taken !== undefined) {
      throw new RegistryError("ERR_REGISTRY_VERSION_EXISTS", `${m.id}@${m.version} is already in the index (as ${taken})`);
    }
  }
  return existing === undefined;
}
var fileSetInvalid = (detail) => new RegistryError("ERR_REGISTRY_PACKAGE_FILE_SET", detail);
function isCleanRelPath(rel) {
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
function assertFileSet(m, files) {
  const entry = extensionEntryRelPath(m);
  if (!entry.startsWith(DIST_PREFIX) || !isCleanRelPath(entry)) {
    throw fileSetInvalid(`extension entry ${entry} must be a file inside dist/`);
  }
  const seen = new Set;
  const folded = new Map;
  for (const f of files) {
    if (seen.has(f))
      throw fileSetInvalid(`package holds ${f} more than once`);
    seen.add(f);
    const twin = folded.get(f.toLowerCase());
    if (twin !== undefined) {
      throw fileSetInvalid(`package holds ${twin} and ${f}, which differ only by case`);
    }
    folded.set(f.toLowerCase(), f);
    if (!isCleanRelPath(f) || !isPackageFile(f)) {
      throw fileSetInvalid(`package holds ${f}, which is outside the package file set`);
    }
  }
  if (!seen.has(PACKAGE_MANIFEST_FILE) || !seen.has(entry)) {
    throw fileSetInvalid(`package must hold ${PACKAGE_MANIFEST_FILE} and the entry ${entry}`);
  }
}
var sha256Hex = (b) => createHash4("sha256").update(b).digest("hex");
async function validatePublish(c, signed, config, work) {
  const req = parsePublishRequest(c.publishRequestBytes);
  const { manifest: m, raw } = parseCandidateManifest(c.manifestBytes);
  assertCoordinates(c, m, req);
  const publisher = await assertSigned(m, raw);
  if (req.publisherFingerprint !== publisherKeyFingerprint(publisher.key)) {
    throw requestInvalid(`publish-request.json.publisherFingerprint does not match publisher ${publisher.id}'s key`);
  }
  if (config.requirePublisherNamespace) {
    const ns = `${publisher.id}/`;
    if (!m.id.startsWith(ns) || m.id.length === ns.length) {
      throw new RegistryError("ERR_REGISTRY_NAMESPACE_REQUIRED", `this registry requires ids of the form ${ns}<name>; got ${m.id}`);
    }
  }
  const serviceId = deriveExtensionServiceId(m.id);
  const newId = assertRegistryState(m, publisher, serviceId, signed);
  assertKeyMoveOnStable(m.id, publisher, req.channel, signed);
  if (c.packageBytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new RegistryError("ERR_REGISTRY_TOO_LARGE", `package exceeds ${String(MAX_PACKAGE_BYTES)} bytes`);
  }
  const scratch = mkdtempSync(join2(work, "validate-"));
  try {
    const tgz = join2(scratch, "package.tgz");
    writeFileSync(tgz, c.packageBytes);
    let inspected;
    try {
      inspected = await inspectPackage(tgz, scratch);
    } catch (e) {
      if (e instanceof RegistryError)
        throw e;
      throw new RegistryError("ERR_REGISTRY_EXTRACT_FAILED", `package could not be read: ${e.message}`);
    }
    if (!Buffer.from(c.manifestBytes).equals(inspected.manifestBytes)) {
      throw new RegistryError("ERR_REGISTRY_MANIFEST_MISMATCH", `the package's ${PACKAGE_MANIFEST_FILE} differs from the committed manifest.json`);
    }
    assertFileSet(m, inspected.files);
    return {
      id: m.id,
      version: m.version,
      channel: req.channel,
      name: m.name ?? m.id,
      publisher: { id: publisher.id, key: publisher.key },
      entryHash: inspected.entryHash,
      manifestSha256: sha256Hex(c.manifestBytes),
      packageSha256: sha256Hex(c.packageBytes),
      packageSizeBytes: c.packageBytes.byteLength,
      newId,
      permissions: m.permissions
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
// src/git-tree.ts
import { execFileSync } from "node:child_process";
var REGULAR_FILE_MODE = "100644";
var EXTENSIONS_PREFIX = "extensions/";
var MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
var REGISTRY_NOT_INITIALISED = "registry not initialised: push the init --github site to gh-pages first";
function git(args, opts) {
  return execFileSync("git", [...args], {
    cwd: opts.cwd,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
function stderrOf(err) {
  if (err !== null && typeof err === "object" && "stderr" in err) {
    const s = err.stderr;
    if (typeof s === "string")
      return s;
    if (s instanceof Uint8Array)
      return Buffer.from(s).toString("utf8");
  }
  return err instanceof Error ? err.message : String(err);
}
function assertBranchName(name) {
  if (name === "" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(name)) {
    throw new Error(`refusing unsafe branch name: ${JSON.stringify(name)}`);
  }
}
function assertRev(rev) {
  if (rev === "" || rev.startsWith("-") || !/^[A-Za-z0-9._/^~@-]+$/.test(rev)) {
    throw new Error(`refusing unsafe revision: ${JSON.stringify(rev)}`);
  }
}
function assertSafeTreePath(path) {
  const segments = path.split("/");
  const bad = path === "" || path.includes("\\") || /^[A-Za-z]:/.test(path) || /[\x00-\x1f\x7f]/.test(path) || segments.some((s) => s === "" || s === "." || s === "..");
  if (bad)
    throw new Error(`refusing unsafe path in git tree: ${JSON.stringify(path)}`);
}
function refspecFor(branch) {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}
function fetchRefs(refs, opts) {
  assertBranchList(refs, "fetchRefs");
  try {
    git(["fetch", "--no-tags", "--depth=1", "origin", ...refs.map(refspecFor)], opts);
  } catch (err) {
    const stderr = stderrOf(err);
    const missing = /couldn't find remote ref (\S+)/.exec(stderr)?.[1];
    if (missing === "refs/heads/gh-pages" || missing === "gh-pages") {
      throw new Error(REGISTRY_NOT_INITIALISED);
    }
    throw new Error(`git fetch ${refs.join(" ")} failed: ${stderr.trim()}`);
  }
}
function listTreeEntries(ref, prefix, opts) {
  assertRev(ref);
  const args = ["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", ref];
  if (prefix !== "") {
    assertSafeTreePath(prefix.replace(/\/$/, ""));
    args.push("--", prefix);
  }
  const out = git(args, opts).toString("utf8");
  const entries = [];
  for (const record of out.split("\x00")) {
    if (record === "")
      continue;
    const tab = record.indexOf("\t");
    const [mode, , blob] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (tab < 0 || mode === undefined || blob === undefined) {
      throw new Error(`unparseable git ls-tree record: ${JSON.stringify(record)}`);
    }
    assertSafeTreePath(path);
    if (path.startsWith(EXTENSIONS_PREFIX) && mode !== REGULAR_FILE_MODE) {
      throw new Error(`refusing ${path}: git mode ${mode} is not a regular file (${REGULAR_FILE_MODE}); symlinks, submodules and executables are not accepted under extensions/`);
    }
    entries.push({ mode, path, blob });
  }
  return entries;
}
function readBlob(ref, path, opts) {
  assertRev(ref);
  assertSafeTreePath(path);
  return new Uint8Array(git(["cat-file", "blob", `${ref}:${path}`], opts));
}
function tryMergeBase(a, b, opts) {
  try {
    return git(["merge-base", a, b], opts).toString("utf8").trim();
  } catch (err) {
    const status = err !== null && typeof err === "object" && "status" in err ? err.status : null;
    if (status === 1)
      return null;
    throw new Error(`git merge-base ${a} ${b} failed: ${stderrOf(err).trim()}`);
  }
}
function assertBranchList(refs, what) {
  if (refs.length === 0)
    throw new Error(`${what}: refusing an empty list of branches`);
  for (const r of refs)
    assertBranchName(r);
}
function findMergeBase(a, b, opts) {
  assertRev(a);
  assertRev(b);
  assertBranchList(opts.deepen, "findMergeBase deepen");
  const step = opts.step ?? 50;
  const maxRounds = opts.maxRounds ?? 10;
  for (let round = 0;; round++) {
    const base = tryMergeBase(a, b, opts);
    if (base !== null)
      return base;
    const shallow = git(["rev-parse", "--is-shallow-repository"], opts).toString("utf8").trim() === "true";
    if (!shallow)
      throw new Error(`${a} and ${b} have no common history`);
    if (round >= maxRounds) {
      throw new Error(`no merge base of ${a} and ${b} within ${maxRounds} rounds of ${step} commits`);
    }
    git(["fetch", "--no-tags", `--deepen=${step}`, "origin", ...opts.deepen.map(refspecFor)], opts);
  }
}
var ABSENT_MODE = "000000";
function diffTree(from, to, opts) {
  assertRev(from);
  assertRev(to);
  const out = git(["diff-tree", "-r", "-z", "--no-renames", from, to], opts).toString("utf8");
  const fields = out.split("\x00");
  const changes = [];
  for (let i = 0;i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    const [oldMode, mode, , , status] = meta.replace(/^:/, "").split(" ");
    if (!meta.startsWith(":") || oldMode === undefined || mode === undefined || status === undefined) {
      throw new Error(`unparseable git diff-tree record: ${JSON.stringify(meta)}`);
    }
    assertSafeTreePath(path);
    if (path.startsWith(EXTENSIONS_PREFIX)) {
      for (const m of [oldMode, mode]) {
        if (m !== REGULAR_FILE_MODE && m !== ABSENT_MODE) {
          throw new Error(`refusing ${path}: git mode ${m} is not a regular file (${REGULAR_FILE_MODE}); symlinks, submodules and executables are not accepted under extensions/`);
        }
      }
    }
    changes.push({ status, path, mode });
  }
  return changes;
}
function commitOf(rev, opts) {
  assertRev(rev);
  return git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], opts).toString("utf8").trim();
}
function commitTime(rev, opts) {
  assertRev(rev);
  const raw = git(["log", "-1", "--format=%cI", rev, "--"], opts).toString("utf8").trim();
  const ms = Date.parse(raw);
  if (Number.isNaN(ms))
    throw new Error(`git gave no commit time for ${rev}: ${JSON.stringify(raw)}`);
  return new Date(ms).toISOString();
}
function remoteDefaultBranch(opts) {
  const out = git(["ls-remote", "--symref", "origin", "HEAD"], opts).toString("utf8");
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out);
  if (m?.[1] === undefined)
    throw new Error("cannot tell origin's default branch from git ls-remote");
  assertBranchName(m[1]);
  return m[1];
}

// src/registry-state.ts
var PAGES_BRANCH = "gh-pages";
var PAGES_REF = `origin/${PAGES_BRANCH}`;
var INDEX_FILE = "index.json";
var CONFIG_FILE = "nimbus-registry.json";
var STATEMENTS_DIR = "statements/";
var REQUESTS_DIR = "trust-requests/";
var CANDIDATE_FILES = ["manifest.json", "package.tgz", "publish-request.json"];
function hasFile(git, ref, path, cwd) {
  return git.listTreeEntries(ref, path, { cwd }).some((e) => e.path === path);
}
async function readVerifiedIndex(git, cwd) {
  if (!hasFile(git, PAGES_REF, INDEX_FILE, cwd))
    throw new Error(git.REGISTRY_NOT_INITIALISED);
  const index = parseRegistryIndex(git.readBlob(PAGES_REF, INDEX_FILE, { cwd }));
  await verifyRegistryIndexSelf(index);
  return index;
}
function readConfigAt(git, ref, cwd) {
  if (!hasFile(git, ref, CONFIG_FILE, cwd))
    return;
  const bytes = git.readBlob(ref, CONFIG_FILE, { cwd });
  return { config: parseRegistryConfig(bytes), bytes };
}
function loosens(prev, next) {
  return prev.requirePublisherNamespace && !next.requirePublisherNamespace;
}
function splitExtensionDir(dir) {
  const m = /^extensions\/(.+)\/([^/]+)$/.exec(dir);
  if (m?.[1] === undefined || m[2] === undefined)
    return;
  return { id: m[1], version: m[2] };
}
function readCandidate(git, ref, dir, cwd) {
  const base = `extensions/${dir.id}/${dir.version}`;
  const read = (file) => git.readBlob(ref, `${base}/${file}`, { cwd });
  return {
    dirId: dir.id,
    dirVersion: dir.version,
    manifestBytes: read("manifest.json"),
    packageBytes: read("package.tgz"),
    publishRequestBytes: read("publish-request.json")
  };
}
var MAX_STATEMENT_FILE_BYTES = 16 * 1024;
var STATEMENT_FILE_RE = /^statements\/([0-9a-f]{64})\.json$/;
function readStatementFile(git, ref, e, cwd) {
  const m = STATEMENT_FILE_RE.exec(e.path);
  if (m === null)
    return { reason: "must be statements/<64 lowercase hex statement id>.json" };
  if (e.mode !== git.REGULAR_FILE_MODE)
    return { reason: `git mode ${e.mode} is not a regular file` };
  const bytes = git.readBlob(ref, e.path, { cwd });
  if (bytes.byteLength > MAX_STATEMENT_FILE_BYTES) {
    return { reason: `exceeds ${String(MAX_STATEMENT_FILE_BYTES)} bytes` };
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { reason: "is not valid UTF-8 JSON" };
  }
  let id;
  try {
    id = trustStatementId(parseTrustStatement(value));
  } catch (e) {
    return { reason: `is not a valid trust statement: ${e.message}` };
  }
  if (id !== m[1])
    return { reason: "is not named by its statement id" };
  return { value };
}
function readStatementFiles(git, ref, cwd, only) {
  const out = { values: [], skipped: [] };
  for (const e of git.listTreeEntries(ref, STATEMENTS_DIR, { cwd })) {
    if (e.path === `${STATEMENTS_DIR}.gitkeep` || only !== undefined && !only.has(e.path)) {
      continue;
    }
    const r = readStatementFile(git, ref, e, cwd);
    if ("reason" in r) {
      out.skipped.push({ path: e.path, reason: r.reason });
    } else {
      out.values.push(r.value);
    }
  }
  return out;
}
function statementPath(id) {
  return id === undefined ? STATEMENTS_DIR : `${STATEMENTS_DIR}${id}.json`;
}
function readRequestFiles(git, ref, cwd, only) {
  const requests = [];
  const skipped = [];
  for (const e of git.listTreeEntries(ref, REQUESTS_DIR, { cwd })) {
    if (e.path === `${REQUESTS_DIR}.gitkeep` || only !== undefined && !only.has(e.path))
      continue;
    const name = /^trust-requests\/(.+)\.json$/.exec(e.path)?.[1];
    if (name === undefined || !REQUEST_NAME_RE.test(name)) {
      skipped.push({
        path: e.path,
        reason: "must be trust-requests/<name>.json (lowercase letters, digits, . _ -)"
      });
      continue;
    }
    if (e.mode !== git.REGULAR_FILE_MODE) {
      skipped.push({ path: e.path, reason: `git mode ${e.mode} is not a regular file` });
      continue;
    }
    const bytes = git.readBlob(ref, e.path, { cwd });
    try {
      if (bytes.byteLength > MAX_STATEMENT_FILE_BYTES)
        throw new Error("too large");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      requests.push({ path: e.path, name, request: parseRegistryRequest(value) });
    } catch (err) {
      skipped.push({ path: e.path, reason: `is not a valid request: ${err.message}` });
    }
  }
  return { requests, skipped };
}

// src/report.ts
var GHA_IO = {
  annotate: emitAnnotation,
  summary: writeJobSummary,
  log: (line) => {
    process.stdout.write(`${line}
`);
  }
};
var CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
function code(s) {
  const flat = s.replace(CONTROL_CHARS, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

// src/check.ts
var SHARED = { validate: validatePublish, git: exports_git_tree, io: GHA_IO, tmpdir: osTmpdir };
var CANDIDATE_ALTERNATION = CANDIDATE_FILES.join("|").replaceAll(".", String.raw`\.`);
var FILE_RE = new RegExp(`^(extensions/.+)/(${CANDIDATE_ALTERNATION})$`);
var STATEMENT_RE = /^statements\/[0-9a-f]{64}\.json$/;
function assertPublishShape(changes) {
  if (changes.length === 0)
    throw new Error("the pull request changes no files");
  const offending = [];
  const dirs = new Set;
  const statements = new Set;
  let dirFiles = 0;
  for (const c of changes) {
    const m = FILE_RE.exec(c.path);
    if (c.status === "A" && STATEMENT_RE.test(c.path)) {
      statements.add(c.path);
    } else if (c.status !== "A" || m?.[1] === undefined) {
      offending.push(`${c.status} ${c.path}`);
    } else {
      dirs.add(m[1]);
      dirFiles++;
    }
  }
  if (offending.length > 0) {
    throw new Error("a publish pull request may only add manifest.json, package.tgz and publish-request.json " + "under one extensions/<id>/<version>/, and statements/<statement id>.json files; " + `it also changes: ${offending.join(", ")}`);
  }
  if (dirs.size > 1) {
    throw new Error(`a publish pull request adds exactly one extensions/<id>/<version>/; this one adds ${[...dirs].sort(codeUnitCompare).join(", ")}`);
  }
  const [dir] = dirs;
  if (dir === undefined)
    return { dir: undefined, statements };
  const coords = splitExtensionDir(dir);
  if (coords === undefined || dirFiles !== CANDIDATE_FILES.length) {
    throw new Error(`${dir}/ must add all of ${CANDIDATE_FILES.join(", ")}`);
  }
  return { dir: coords, statements };
}
function admitPullRequestStatements(git, signed, baseRef, added, cwd) {
  const index = admitPublisherStatements(signed, readStatementFiles(git, `origin/${baseRef}`, cwd).values).index;
  if (added.size === 0)
    return { index, admitted: [] };
  const files = readStatementFiles(git, "HEAD", cwd, added);
  const admission = admitPublisherStatements(index, files.values);
  const problems = [
    ...files.skipped.map((f) => `${f.path} ${f.reason}`),
    ...admission.skipped.map((x) => `${statementPath(x.id)}: ${x.reason}`)
  ];
  if (problems.length > 0) {
    throw new Error(`the registry would not admit these statements: ${problems.join("; ")}`);
  }
  return { index: admission.index, admitted: admission.admitted };
}
function effectiveConfig(git, baseRef, cwd) {
  return effectiveRegistryConfig(readConfigAt(git, PAGES_REF, cwd)?.config, readConfigAt(git, `origin/${baseRef}`, cwd)?.config);
}
var listOf = (items) => items.length === 0 ? "none" : items.map(code).join(", ");
function statementSubject(s) {
  if (s.kind === "key.rotate") {
    return `${code(publisherKeyFingerprint(s.fromKey))} -> ${code(publisherKeyFingerprint(s.toKey))}`;
  }
  if (s.kind === "key.revoke")
    return `key ${code(s.keyFingerprint)}, reason ${code(s.reason)}`;
  return "";
}
function statementLines(admitted) {
  if (admitted.length === 0)
    return [];
  const lines = ["**Publisher statements**", ""];
  for (const s of admitted) {
    lines.push(`- ${code(s.kind)} for ${code(s.publisherId)}: ${statementSubject(s)} (${code(trustStatementId(s))})`);
  }
  lines.push("");
  return lines;
}
function statementOnlySummary(admitted) {
  return ["## Registry statements", "", ...statementLines(admitted)].join(`
`);
}
function checkSummary(v, admitted = []) {
  const ref = `${v.id}@${v.version}`;
  const lines = [`## Registry publish: ${code(ref)}`, ""];
  if (v.newId) {
    lines.push(`> [!WARNING]`, `> **NEW ID** — ${code(v.id)} is not in the signed index yet. Check the publisher and the name before approving.`, "");
  }
  lines.push(`- **Extension:** ${code(v.id)}`, `- **Version:** ${code(v.version)}`, `- **Channel:** ${code(v.channel)}`, `- **Name:** ${code(v.name)}`, `- **Publisher:** ${code(v.publisher.id)}, key fingerprint ${code(publisherKeyFingerprint(v.publisher.key))}`, `- **Package:** ${String(v.packageSizeBytes)} bytes, sha256 ${code(v.packageSha256)}`, "", ...statementLines(admitted), "**Declared permissions**", "", `- Network hosts: ${listOf(v.permissions.network)}`, `- Filesystem read: ${listOf(v.permissions.filesystem.read)}`, `- Filesystem write: ${listOf(v.permissions.filesystem.write)}`, "", "No runtime check of the package is performed: this check validated the signature, the " + "registry rules and the package's file set, not what the code does.");
  return lines.join(`
`);
}
function requestLine(f) {
  const r = f.request;
  if (r.kind === "key.revoke") {
    return `- ${code(f.path)}: revoke publisher ${code(r.publisherId)}'s key ${code(r.keyFingerprint)} — ${code(r.reason)}`;
  }
  const versions = r.versions === "*" ? "every version" : r.versions.map(code).join(", ");
  const publisher = r.publisherId === undefined ? "" : ` (publisher ${code(r.publisherId)})`;
  return `- ${code(f.path)}: take down ${code(r.extensionId)}${publisher}, ${versions} — ${code(r.reason)}`;
}
function checkRequestPullRequest(git, index, changes, cwd, io) {
  const offending = changes.filter((c) => c.status !== "A" || !c.path.startsWith(REQUESTS_DIR));
  if (offending.length > 0) {
    throw new Error(`a maintainer request pull request may only add ${REQUESTS_DIR}<name>.json files; it also changes: ${offending.map((c) => `${c.status} ${c.path}`).join(", ")}`);
  }
  const files = readRequestFiles(git, "HEAD", cwd, new Set(changes.map((c) => c.path)));
  for (const f of files.requests) {
    try {
      assertRequestSignable(f.request, index);
    } catch (e) {
      files.skipped.push({ path: f.path, reason: e.message });
    }
  }
  if (files.skipped.length > 0) {
    throw new Error(`invalid maintainer request: ${files.skipped.map((f) => `${f.path} ${f.reason}`).join("; ")}`);
  }
  io.summary([
    "## Registry maintainer request",
    "",
    "> [!CAUTION]",
    "> **MAINTAINER REQUEST — merge only if you, a maintainer of this registry, intend this block.** On merge the sign job signs it with the registry root key, and every client that installed from this registry applies it.",
    "",
    ...files.requests.map(requestLine)
  ].join(`
`));
  io.log(`check passed: ${String(files.requests.length)} maintainer request(s)`);
}
async function runCheck(opts, deps = SHARED) {
  const { git } = deps;
  const cwd = opts.workspace;
  if (opts.baseRef === "") {
    throw new Error("check runs on pull_request: the base branch (GITHUB_BASE_REF) is empty");
  }
  git.fetchRefs([opts.baseRef, PAGES_BRANCH], { cwd });
  const index = await readVerifiedIndex(git, cwd);
  const mergeBase = git.findMergeBase(`origin/${opts.baseRef}`, "HEAD", {
    cwd,
    deepen: [opts.baseRef]
  });
  const changes = git.diffTree(mergeBase, "HEAD", { cwd });
  if (changes.some((c) => c.path.startsWith(REQUESTS_DIR))) {
    checkRequestPullRequest(git, index, changes, cwd, deps.io);
    return;
  }
  const shape = assertPublishShape(changes);
  const admitted = admitPullRequestStatements(git, index, opts.baseRef, shape.statements, cwd);
  if (shape.dir === undefined) {
    deps.io.summary(statementOnlySummary(admitted.admitted));
    deps.io.log(`check passed: ${String(admitted.admitted.length)} statement(s), no publish`);
    return;
  }
  const candidate = readCandidate(git, "HEAD", shape.dir, cwd);
  const config = effectiveConfig(git, opts.baseRef, cwd);
  const work = mkdtempSync2(join3(deps.tmpdir(), "nimbus-registry-check-"));
  try {
    const verdict = await deps.validate(candidate, admitted.index, config, work);
    deps.io.summary(checkSummary(verdict, admitted.admitted));
    deps.io.log(`check passed: ${verdict.id}@${verdict.version} (${verdict.channel})${verdict.newId ? " — NEW ID" : ""}`);
  } finally {
    rmSync2(work, { recursive: true, force: true });
  }
}

// src/sign.ts
import { createHash as createHash5 } from "node:crypto";
import { mkdtempSync as mkdtempSync4, rmSync as rmSync4 } from "node:fs";
import { tmpdir as osTmpdir2 } from "node:os";
import { join as join5 } from "node:path";

// src/site-commit.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { mkdtempSync as mkdtempSync3, rmSync as rmSync3 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
var BOT_NAME = "github-actions[bot]";
var BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
var BOT_IDENTITY = ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`];
var BOT_ENV = {
  GIT_AUTHOR_NAME: BOT_NAME,
  GIT_AUTHOR_EMAIL: BOT_EMAIL,
  GIT_COMMITTER_NAME: BOT_NAME,
  GIT_COMMITTER_EMAIL: BOT_EMAIL
};
function run(args, opts) {
  return execFileSync2("git", [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"]
  }).toString("utf8").trim();
}
function commitSite(parent, files, message, cwd) {
  const scratch = mkdtempSync3(join4(tmpdir(), "nimbus-registry-site-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join4(scratch, "index") };
    run(["read-tree", parent], { cwd, env });
    for (const f of files) {
      assertSafeTreePath(f.path);
      const blob = run(["hash-object", "-w", "--no-filters", "--stdin"], { cwd, input: f.bytes });
      run(["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path}`], { cwd, env });
    }
    const tree = run(["write-tree"], { cwd, env });
    if (tree === run(["rev-parse", `${parent}^{tree}`], { cwd }))
      return;
    return run([...BOT_IDENTITY, "commit-tree", tree, "-p", parent, "-m", message], {
      cwd,
      env: { ...process.env, ...BOT_ENV }
    });
  } finally {
    rmSync3(scratch, { recursive: true, force: true });
  }
}
var NON_FAST_FORWARD = /non-fast-forward|fetch first|\[rejected\]/;
function pushCommit(commit, branch, cwd) {
  try {
    run(["push", "--porcelain", "origin", `${commit}:refs/heads/${branch}`], { cwd });
    return "pushed";
  } catch (err) {
    const text = [
      err !== null && typeof err === "object" && "stderr" in err ? String(err.stderr) : "",
      err !== null && typeof err === "object" && "stdout" in err ? String(err.stdout) : ""
    ].join(`
`);
    if (NON_FAST_FORWARD.test(text))
      return "non-fast-forward";
    throw new Error(`git push to ${branch} failed: ${text.trim()}`);
  }
}

// src/sign.ts
var SHARED2 = {
  validate: validatePublish,
  sign: signIndex,
  git: exports_git_tree,
  io: GHA_IO,
  tmpdir: osTmpdir2
};
var MAX_ATTEMPTS = 3;
var ROOT_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
function parseRootKey(raw) {
  const s = raw.trim();
  if (!ROOT_KEY_RE.test(s)) {
    throw new Error('input "root-key" is not a registry root key: expected the base64 of a 32-byte Ed25519 seed, as `nimbus registry maintain init` writes it');
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}
function extensionDirs(git, ref, cwd) {
  const dirs = new Map;
  const paths = new Set;
  for (const e of git.listTreeEntries(ref, "extensions/", { cwd })) {
    paths.add(e.path);
    const slash = e.path.lastIndexOf("/");
    const dir = e.path.slice(0, slash);
    if (dir === "extensions")
      continue;
    const names = dirs.get(dir) ?? new Set;
    names.add(e.path.slice(slash + 1));
    dirs.set(dir, names);
  }
  return { dirs, paths };
}
var sha256Hex2 = (b) => createHash5("sha256").update(b).digest("hex");
function assertSignedIntact(git, index, ref, paths, cwd) {
  const problems = [];
  const signedDirs = new Set;
  for (const [id, ext] of Object.entries(index.extensions)) {
    for (const [version, v] of Object.entries(ext.versions)) {
      signedDirs.add(`extensions/${id}/${version}`);
      for (const [path, want] of [
        [v.manifest, v.manifestSha256],
        [v.package, v.packageSha256]
      ]) {
        if (!paths.has(path)) {
          problems.push(`${path} is signed but was deleted`);
        } else if (sha256Hex2(git.readBlob(ref, path, { cwd })) !== want) {
          problems.push(`${path} differs from the signed version`);
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`refusing to sign: already-signed versions changed on the default branch (a signed version is immutable): ${problems.join("; ")}`);
  }
  return signedDirs;
}
function sameFileSet(names) {
  return names.size === CANDIDATE_FILES.length && CANDIDATE_FILES.every((f) => names.has(f));
}
async function attemptSign(opts, seed, rootKey, deps) {
  const { git } = deps;
  const cwd = opts.workspace;
  const mainRef = `origin/${opts.defaultBranch}`;
  git.fetchRefs([opts.defaultBranch, PAGES_BRANCH], { cwd });
  const index = await readVerifiedIndex(git, cwd);
  if (index.rootKey !== rootKey) {
    throw new Error(`refusing to sign: the root-key input (public key fingerprint ${publisherKeyFingerprint(rootKey)}) is not this registry's root key (fingerprint ${publisherKeyFingerprint(index.rootKey)})`);
  }
  const config = readConfigAt(git, mainRef, cwd);
  if (config === undefined) {
    throw new Error(`refusing to sign: ${opts.defaultBranch} has no ${CONFIG_FILE}`);
  }
  const pagesConfig = readConfigAt(git, PAGES_REF, cwd);
  if (pagesConfig !== undefined && loosens(pagesConfig.config, config.config)) {
    throw new Error(`refusing to sign: ${opts.defaultBranch}'s ${CONFIG_FILE} loosens the rules the last signed run used (requirePublisherNamespace true -> false); loosening is a maintainer action done by hand`);
  }
  const { dirs, paths } = extensionDirs(git, mainRef, cwd);
  const signedDirs = assertSignedIntact(git, index, mainRef, paths, cwd);
  const skipped = [];
  const admission = admitStatements(git, index, mainRef, cwd, skipped);
  const extensions = { ...index.extensions };
  const publishedAt = git.commitTime(mainRef, { cwd });
  const added = [];
  const files = [{ path: CONFIG_FILE, bytes: config.bytes }];
  const work = mkdtempSync4(join5(deps.tmpdir(), "nimbus-registry-sign-"));
  try {
    for (const dir of [...dirs.keys()].filter((d) => !signedDirs.has(d)).sort(codeUnitCompare)) {
      const coords = splitExtensionDir(dir);
      const names = dirs.get(dir) ?? new Set;
      if (coords === undefined || !sameFileSet(names)) {
        skipped.push({
          dir,
          reason: `must hold exactly ${CANDIDATE_FILES.join(", ")}; holds ${[...names].sort(codeUnitCompare).join(", ")}`
        });
        continue;
      }
      const candidate = readCandidate(git, mainRef, coords, cwd);
      let v;
      try {
        v = await deps.validate(candidate, { ...admission.index, extensions }, config.config, work);
      } catch (e) {
        if (!(e instanceof RegistryError))
          throw e;
        skipped.push({ dir, reason: e.message });
        continue;
      }
      const base = `extensions/${v.id}/${v.version}`;
      const existing = extensions[v.id];
      extensions[v.id] = {
        publisher: publisherAfterPublish(existing, v.publisher),
        versions: {
          ...existing?.versions,
          [v.version]: {
            channel: v.channel,
            name: v.name,
            manifest: `${base}/manifest.json`,
            manifestSha256: v.manifestSha256,
            package: `${base}/package.tgz`,
            packageSha256: v.packageSha256,
            packageSizeBytes: v.packageSizeBytes,
            entryHash: v.entryHash,
            publishedAt
          }
        }
      };
      files.push({ path: `${base}/manifest.json`, bytes: candidate.manifestBytes }, { path: `${base}/package.tgz`, bytes: candidate.packageBytes });
      added.push({ id: v.id, version: v.version, channel: v.channel });
    }
  } finally {
    rmSync4(work, { recursive: true, force: true });
  }
  const requested = await signRequests(git, { ...admission.index, extensions }, { ref: mainRef, cwd, seed, issuedAt: publishedAt }, skipped);
  const reportUrl = reportUrlFor(index, opts.repository);
  const statements = [...admission.admitted, ...requested].map(trustStatementId);
  let sequence = index.sequence;
  if (added.length > 0 || statements.length > 0 || reportUrl !== undefined) {
    const { signature: _previousSignature, ...carried } = admission.index;
    const priorStatements = Array.isArray(carried.statements) ? carried.statements : [];
    const signed = await deps.sign({
      ...carried,
      ...requested.length > 0 && { statements: [...priorStatements, ...requested] },
      ...reportUrl !== undefined && { reportUrl },
      format: 1,
      sequence: index.sequence + 1,
      generatedAt: new Date().toISOString(),
      extensions
    }, seed);
    await verifyRegistryIndexPinned(signed, rootKey);
    sequence = signed.sequence;
    files.push({
      path: INDEX_FILE,
      bytes: new TextEncoder().encode(`${JSON.stringify(signed, null, 2)}
`)
    });
  }
  const parent = git.commitOf(PAGES_REF, { cwd });
  const message = commitMessage(added, statements, sequence, opts.defaultBranch);
  return {
    commit: commitSite(parent, files, message, cwd),
    added,
    statements,
    skipped,
    sequence
  };
}
async function signRequests(git, index, at, skipped) {
  const files = readRequestFiles(git, at.ref, at.cwd);
  for (const f of files.skipped)
    skipped.push({ dir: f.path, reason: f.reason });
  const signed = [];
  let current = index;
  for (const f of [...files.requests].sort((a, b) => codeUnitCompare(a.name, b.name))) {
    if (alreadyCarried(current, f.request))
      continue;
    try {
      const s = await signRegistryRequest(f.request, current, at.seed, at.issuedAt);
      signed.push(s);
      const prior = Array.isArray(current.statements) ? current.statements : [];
      current = { ...current, statements: [...prior, s] };
    } catch (e) {
      if (!(e instanceof RegistryError))
        throw e;
      skipped.push({ dir: f.path, reason: e.message });
    }
  }
  return signed;
}
function reportUrlFor(index, repository) {
  if (repository === undefined || readRegistryReportUrl(index) !== undefined)
    return;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repository))
    return;
  return `https://github.com/${repository}/issues/new`;
}
function admitStatements(git, index, ref, cwd, skipped) {
  const files = readStatementFiles(git, ref, cwd);
  for (const f of files.skipped)
    skipped.push({ dir: f.path, reason: f.reason });
  const admission = admitPublisherStatements(index, files.values);
  for (const s of admission.skipped)
    skipped.push({ dir: statementPath(s.id), reason: s.reason });
  return admission;
}
function commitMessage(added, statements, sequence, defaultBranch) {
  if (added.length === 0 && statements.length === 0) {
    return `Copy ${CONFIG_FILE} from ${defaultBranch}`;
  }
  const parts = [
    ...added.map(versionRef),
    ...statements.map((id) => `statement ${id.slice(0, 12)}`)
  ];
  return `Sign ${parts.join(", ")} (sequence ${String(sequence)})`;
}
function versionRef(x) {
  return `${x.id}@${x.version}`;
}
function report(io, a, pushed) {
  warnSkipped(io, a);
  const lines = ["## Registry sign", ""];
  if (a.added.length === 0 && a.statements.length === 0) {
    lines.push("Nothing new to sign.");
  } else {
    lines.push(`Signed index sequence ${String(a.sequence)}:`, "");
    for (const x of a.added)
      lines.push(`- ${code(versionRef(x))} (${x.channel})`);
    for (const id of a.statements)
      lines.push(`- statement ${code(id)}`);
  }
  if (a.skipped.length > 0) {
    lines.push("", "**Skipped** (not signed; fix the directory or statement file and it is signed on a later run):", "");
    for (const s of a.skipped)
      lines.push(`- ${code(s.dir)}: ${code(s.reason)}`);
  }
  lines.push("", pushed ? `Pushed to ${code(PAGES_BRANCH)}.` : "No change: nothing was committed.");
  io.summary(lines.join(`
`));
  io.log(pushed ? `signed ${String(a.added.length)} version(s) and ${String(a.statements.length)} statement(s), skipped ${String(a.skipped.length)}; pushed ${PAGES_BRANCH}` : `nothing to sign; skipped ${String(a.skipped.length)}; no commit`);
}
function warnSkipped(io, a) {
  for (const s of a.skipped)
    io.annotate("warning", `skipped ${s.dir}: ${s.reason}`);
}
async function signLoop(opts, seed, deps) {
  const rootKey = Buffer.from(publicKeyFromSeed(seed)).toString("base64");
  const defaultBranch = opts.defaultBranch ?? deps.git.remoteDefaultBranch({ cwd: opts.workspace });
  let last;
  try {
    for (let attempt = 1;attempt <= MAX_ATTEMPTS; attempt++) {
      last = await attemptSign({ ...opts, defaultBranch }, seed, rootKey, deps);
      if (last.commit === undefined) {
        report(deps.io, last, false);
        return;
      }
      await deps.beforePush?.(attempt);
      if (pushCommit(last.commit, PAGES_BRANCH, opts.workspace) === "pushed") {
        report(deps.io, last, true);
        return;
      }
      deps.io.log(`${PAGES_BRANCH} moved during attempt ${String(attempt)}; starting over`);
    }
  } catch (e) {
    if (last !== undefined)
      warnSkipped(deps.io, last);
    throw e;
  }
  warnSkipped(deps.io, last);
  throw new Error(`refusing to continue: the push to ${PAGES_BRANCH} lost to a concurrent update ${String(MAX_ATTEMPTS)} times`);
}
async function runSign(opts, deps = SHARED2) {
  const seed = parseRootKey(opts.rootKey);
  try {
    await signLoop(opts, seed, deps);
  } finally {
    seed.fill(0);
  }
}

// src/main.ts
function parseMode(raw) {
  if (raw === "check" || raw === "sign")
    return raw;
  throw new Error(`input "mode" must be "check" or "sign"; got ${JSON.stringify(raw)}`);
}
function requireInput(name) {
  const v = getInput(name);
  if (v === "")
    throw new Error(`input "${name}" is required`);
  return v;
}
function maskSecret(secret, write = (s) => process.stdout.write(s)) {
  const parts = new Set([secret, secret.trim(), ...secret.split(/[\r\n]+/).map((l) => l.trim())]);
  parts.delete("");
  for (const p of parts) {
    if (/[\r\n]/.test(p))
      continue;
    write(`::add-mask::${p.replaceAll("%", "%25")}
`);
  }
}
function signOptions(workspace, rootKey, defaultBranch) {
  const repository = process.env["GITHUB_REPOSITORY"];
  return {
    workspace,
    rootKey,
    ...defaultBranch !== "" && { defaultBranch },
    ...repository !== undefined && repository !== "" && { repository }
  };
}
function workspace() {
  return process.env["GITHUB_WORKSPACE"] ?? process.cwd();
}
async function main() {
  try {
    const mode = parseMode(getInput("mode"));
    if (mode === "check") {
      await runCheck({ workspace: workspace(), baseRef: process.env["GITHUB_BASE_REF"] ?? "" });
    } else {
      const rootKey = requireInput("root-key");
      maskSecret(rootKey);
      delete process.env[inputEnvName("root-key")];
      await runSign(signOptions(workspace(), rootKey, getInput("default-branch")));
    }
  } catch (err) {
    emitAnnotation("error", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
if (__require.main == __require.module) {
  await main();
}
export {
  main,
  maskSecret,
  parseMode,
  signOptions
};
