import { describe, expect, test } from "bun:test";
import { assertSafeUrl, isPrivateAddress, safeFetch } from "./safe-fetch.ts";

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
    ["::ffff:8.8.8.8", false],
    ["fc00::1", true],
    ["fe80::1", true],
    ["not-an-ip", false],
  ])("%s -> private=%p", (addr, expected) => {
    expect(isPrivateAddress(addr as string)).toBe(expected);
  });
});

describe("safeFetch (injected DNS + fetch seam)", () => {
  test("fetches when the host resolves to a public address", async () => {
    let fetched: string | undefined;
    const res = await safeFetch(
      "https://example.com/share.json",
      { method: "GET" },
      {
        lookupFn: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
        fetchFn: (async (url: URL) => {
          fetched = url.toString();
          return new Response("ok");
        }) as never,
      },
    );
    expect(await res.text()).toBe("ok");
    expect(fetched).toBe("https://example.com/share.json");
  });

  test("rejects when the host resolves to a private address (no fetch)", async () => {
    let fetchCalled = false;
    await expect(
      safeFetch("https://sneaky.example/x", undefined, {
        lookupFn: (async () => [{ address: "10.0.0.5", family: 4 }]) as never,
        fetchFn: (async () => {
          fetchCalled = true;
          return new Response("should not happen");
        }) as never,
      }),
    ).rejects.toThrow(/resolves to private/i);
    expect(fetchCalled).toBe(false);
  });

  test("rejects an unsafe scheme before any DNS lookup", async () => {
    let lookupCalled = false;
    await expect(
      safeFetch("file:///etc/passwd", undefined, {
        lookupFn: (async () => {
          lookupCalled = true;
          return [];
        }) as never,
      }),
    ).rejects.toThrow(/scheme/i);
    expect(lookupCalled).toBe(false);
  });

  test("skips DNS for a literal public IP host and fetches directly", async () => {
    const res = await safeFetch("https://93.184.216.34/x", undefined, {
      lookupFn: (async () => {
        throw new Error("lookup should not be called for a literal IP");
      }) as never,
      fetchFn: (async () => new Response("direct")) as never,
    });
    expect(await res.text()).toBe("direct");
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
