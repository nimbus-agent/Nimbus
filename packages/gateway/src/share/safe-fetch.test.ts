import { describe, expect, test } from "bun:test";
import { assertSafeUrl, isPrivateAddress } from "./safe-fetch.ts";

describe("isPrivateAddress", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["192.168.1.1", true],
    ["169.254.1.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["2606:4700:4700::1111", false],
  ])("%s -> private=%p", (addr, expected) => {
    expect(isPrivateAddress(addr as string)).toBe(expected);
  });
});

describe("assertSafeUrl", () => {
  test("rejects non-http(s) schemes", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/scheme/i);
    expect(() => assertSafeUrl("ftp://host/x")).toThrow(/scheme/i);
  });
  test("rejects literal loopback/private hosts", () => {
    expect(() => assertSafeUrl("http://127.0.0.1/x")).toThrow(/private|loopback/i);
    expect(() => assertSafeUrl("http://192.168.0.5/x")).toThrow(/private|loopback/i);
  });
  test("rejects bracketed IPv6 loopback + IPv4-mapped loopback", () => {
    expect(() => assertSafeUrl("http://[::1]/x")).toThrow(/private|loopback/i);
    expect(() => assertSafeUrl("http://[::ffff:127.0.0.1]/x")).toThrow(/private|loopback/i);
  });
  test("accepts a public https url", () => {
    expect(() => assertSafeUrl("https://example.com/share.json")).not.toThrow();
  });
  test("accepts a public bracketed IPv6 url", () => {
    expect(() => assertSafeUrl("https://[2606:4700:4700::1111]/x")).not.toThrow();
  });
});
