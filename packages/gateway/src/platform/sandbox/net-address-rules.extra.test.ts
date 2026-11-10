import { describe, expect, test } from "bun:test";

import {
  allowedAddresses,
  classifyAddress,
  isIpv4Literal,
  parseIpv4,
} from "./net-address-rules.ts";

describe("isIpv4Literal / parseIpv4", () => {
  test("accepts a dotted quad and rejects other shapes", () => {
    expect(isIpv4Literal("10.0.0.1")).toBe(true);
    expect(isIpv4Literal("10.0.0")).toBe(false);
    expect(isIpv4Literal("010.0.0.1")).toBe(false);
    expect(isIpv4Literal("256.0.0.1")).toBe(false);
    expect(isIpv4Literal("example.com")).toBe(false);
    expect(parseIpv4("1.2.3.4")).toEqual([1, 2, 3, 4]);
  });
});

describe("classifyAddress IPv6 parsing edges", () => {
  test("an embedded dotted-quad tail is judged as that IPv4 address", () => {
    expect(classifyAddress("::ffff:10.1.2.3")).toBe("private");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
  });
  test("a malformed dotted-quad tail is refused", () => {
    expect(classifyAddress("::ffff:1.2.3")).toBe("refused");
    expect(classifyAddress("::ffff:999.1.1.1")).toBe("refused");
  });
  test("zone ids, triple colons, bad groups and wrong group counts are refused", () => {
    expect(classifyAddress("fe80::1%eth0")).toBe("refused");
    expect(classifyAddress("1::2::3")).toBe("refused");
    expect(classifyAddress("2001:zzzz::1")).toBe("refused");
    expect(classifyAddress("1:2:3:4:5:6:7")).toBe("refused");
    expect(classifyAddress("1:2:3:4:5:6:7:8:9")).toBe("refused");
    expect(classifyAddress("1:2:3:4:5:6:7::8")).toBe("refused");
  });
  test("a full eight-group global unicast address is public", () => {
    expect(classifyAddress("2606:4700:4700:0:0:0:0:1111")).toBe("public");
  });
  test("a compressed address with an empty head or tail parses", () => {
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("::")).toBe("refused");
    expect(classifyAddress("2606:4700::")).toBe("public");
  });
  test("non-global-unicast space is refused", () => {
    expect(classifyAddress("4000::1")).toBe("refused");
  });
});

describe("allowedAddresses literal entries", () => {
  test("a bracketed literal entry lets a package reach exactly that private address", () => {
    const entry = { host: "[fc00::5]", trust: "package" as const };
    expect(allowedAddresses(entry, ["fc00::5", "fc00::6"])).toEqual(["fc00::5"]);
  });
  test("an IPv4-mapped answer equals its IPv4 literal entry", () => {
    const entry = { host: "192.168.1.5", trust: "package" as const };
    expect(allowedAddresses(entry, ["::ffff:192.168.1.5", "192.168.1.6"])).toEqual([
      "::ffff:192.168.1.5",
    ]);
  });
  test("an owner entry for a loopback literal reaches only that loopback address", () => {
    const entry = { host: "127.0.0.2", trust: "owner" as const };
    expect(allowedAddresses(entry, ["127.0.0.2", "127.0.0.3"])).toEqual(["127.0.0.2"]);
  });
  test("a non-literal answer is dropped", () => {
    expect(
      allowedAddresses({ host: "a.example", trust: "owner" }, ["not-an-ip", "8.8.8.8"]),
    ).toEqual(["8.8.8.8"]);
  });
  test("a first-party entry never reaches loopback", () => {
    expect(allowedAddresses({ host: "localhost", trust: "first-party" }, ["127.0.0.1"])).toEqual(
      [],
    );
  });
});
