import { describe, expect, test } from "bun:test";

import { type AddressClass, allowedAddresses, classifyAddress } from "./net-address-rules.ts";

describe("classifyAddress", () => {
  const cases: [string, AddressClass][] = [
    ["140.82.114.6", "public"],
    ["2606:4700::1", "public"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["100.128.0.1", "public"],
    ["fd00::1", "private"],
    ["127.0.0.1", "loopback"],
    ["127.9.9.9", "loopback"],
    ["::1", "loopback"],
    ["169.254.169.254", "refused"],
    ["fe80::1", "refused"],
    ["0.0.0.0", "refused"],
    ["0.1.2.3", "refused"],
    ["::", "refused"],
    ["224.0.0.1", "refused"],
    ["240.0.0.1", "refused"],
    ["255.255.255.255", "refused"],
    ["192.0.0.1", "refused"],
    ["198.18.0.1", "refused"],
    ["ff02::1", "refused"],
    ["not-an-ip", "refused"],
    ["", "refused"],
    ["1.2.3", "refused"],
    ["01.2.3.4", "refused"],
    ["256.1.1.1", "refused"],
    ["fe80::1%eth0", "refused"],
    ["1::2::3", "refused"],
    ["2001:db8::1", "refused"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "refused"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["0:0:0:0:0:ffff:7f00:1", "loopback"],
    ["0:0:0:0:0:ffff:a9fe:a9fe", "refused"],
    ["0000:0000:0000:0000:0000:0000:0000:0001", "loopback"],
  ];
  for (const [ip, want] of cases) {
    test(`${JSON.stringify(ip)} is ${want}`, () => {
      expect(classifyAddress(ip)).toBe(want);
    });
  }
});

describe("allowedAddresses", () => {
  test("a package-declared name reaches only public answers", () => {
    const pkg = { host: "evil.example", trust: "package" as const };
    expect(allowedAddresses(pkg, ["140.82.114.6", "10.0.0.1", "127.0.0.1"])).toEqual([
      "140.82.114.6",
    ]);
  });

  test("a package-declared private literal reaches only that literal", () => {
    expect(allowedAddresses({ host: "10.0.0.1", trust: "package" }, ["10.0.0.1"])).toEqual([
      "10.0.0.1",
    ]);
    expect(allowedAddresses({ host: "10.0.0.1", trust: "package" }, ["10.0.0.2"])).toEqual([]);
  });

  test("a package-declared loopback literal reaches nothing", () => {
    expect(allowedAddresses({ host: "127.0.0.1", trust: "package" }, ["127.0.0.1"])).toEqual([]);
    expect(allowedAddresses({ host: "localhost", trust: "package" }, ["127.0.0.1"])).toEqual([]);
  });

  test("an owner-configured name reaches private but not loopback or link-local", () => {
    const own = { host: "jenkins", trust: "owner" as const };
    expect(allowedAddresses(own, ["10.0.0.1", "127.0.0.1", "169.254.169.254"])).toEqual([
      "10.0.0.1",
    ]);
  });

  test("an owner-configured loopback is allowed only as localhost or that literal", () => {
    expect(allowedAddresses({ host: "localhost", trust: "owner" }, ["127.0.0.1"])).toEqual([
      "127.0.0.1",
    ]);
    expect(allowedAddresses({ host: "localhost", trust: "owner" }, ["::1"])).toEqual(["::1"]);
    expect(allowedAddresses({ host: "127.0.0.1", trust: "owner" }, ["127.0.0.1"])).toEqual([
      "127.0.0.1",
    ]);
    expect(allowedAddresses({ host: "127.0.0.1", trust: "owner" }, ["127.0.0.2"])).toEqual([]);
    expect(allowedAddresses({ host: "[::1]", trust: "owner" }, ["::1"])).toEqual(["::1"]);
  });

  test("a first-party name reaches private answers but not loopback or link-local", () => {
    const first = { host: "logs.us-east-1.amazonaws.com", trust: "first-party" as const };
    expect(allowedAddresses(first, ["10.0.0.1", "127.0.0.1", "169.254.169.254"])).toEqual([
      "10.0.0.1",
    ]);
  });

  test("a first-party literal loopback is still refused", () => {
    expect(allowedAddresses({ host: "127.0.0.1", trust: "first-party" }, ["127.0.0.1"])).toEqual(
      [],
    );
  });

  test("an unparseable answer is dropped, and order is kept", () => {
    const own = { host: "x.example", trust: "owner" as const };
    expect(allowedAddresses(own, ["bogus", "8.8.8.8", "10.0.0.1", "0.0.0.0"])).toEqual([
      "8.8.8.8",
      "10.0.0.1",
    ]);
  });

  test("an IPv4-mapped loopback is judged as loopback for every trust", () => {
    const mapped = ["::ffff:127.0.0.1"];
    expect(allowedAddresses({ host: "x.example", trust: "owner" }, mapped)).toEqual([]);
    expect(allowedAddresses({ host: "x.example", trust: "package" }, mapped)).toEqual([]);
    expect(allowedAddresses({ host: "localhost", trust: "owner" }, mapped)).toEqual(mapped);
  });
});
