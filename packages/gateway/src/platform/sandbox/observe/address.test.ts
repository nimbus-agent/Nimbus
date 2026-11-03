import { describe, expect, test } from "bun:test";
import { isIP } from "node:net";

import { dotted, formatIpv6, portFromDword } from "./address.ts";

function v6(...groups: number[]): Buffer {
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => {
    buf.writeUInt16BE(g, i * 2);
  });
  return buf;
}

describe("portFromDword", () => {
  test("reads the network-order port in the low 16 bits, ignoring the high bits", () => {
    // 443 = 0x01bb, stored in network order: low byte 0x01, next byte 0xbb.
    expect(portFromDword(0xbb01)).toBe(443);
    expect(portFromDword(0xffff_bb01)).toBe(443);
    expect(portFromDword(0)).toBe(0);
    expect(portFromDword(0xffff)).toBe(65535);
  });
});

describe("dotted", () => {
  test("prints four bytes at an offset", () => {
    expect(dotted(Buffer.from([9, 140, 82, 112, 6]), 1)).toBe("140.82.112.6");
  });
});

describe("formatIpv6", () => {
  test("compresses the first longest zero run, lowercase (RFC 5952)", () => {
    expect(formatIpv6(v6(0x2001, 0xdb8, 0, 0, 1, 0, 0, 1), 0)).toBe("2001:db8::1:0:0:1");
    expect(formatIpv6(v6(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1), 0)).toBe("2001:db8::1");
    expect(formatIpv6(v6(0, 0, 0, 0, 0, 0, 0, 1), 0)).toBe("::1");
    expect(formatIpv6(v6(0xfe80, 0, 0, 0, 0, 0, 0, 0), 0)).toBe("fe80::");
    expect(formatIpv6(v6(0xabcd, 0, 1, 2, 3, 4, 5, 6), 0)).toBe("abcd:0:1:2:3:4:5:6");
  });

  test("prints an IPv4-mapped address dotted", () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 140, 82, 112, 6]);
    expect(formatIpv6(buf, 0)).toBe("::ffff:140.82.112.6");
  });

  test("reads at an offset, and every output is an IPv6 literal", () => {
    const buf = Buffer.concat([Buffer.alloc(3), v6(0x2606, 0x4700, 0, 0, 0, 0, 0x6810, 0x8519)]);
    const text = formatIpv6(buf, 3);
    expect(text).toBe("2606:4700::6810:8519");
    expect(isIP(text)).toBe(6);
  });
});
