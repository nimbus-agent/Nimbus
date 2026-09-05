import { describe, expect, test } from "bun:test";
import type { lookup } from "node:dns/promises";
import { assertSafeUrl, isPrivateAddress, safeFetch, safeFetchFollowing } from "./safe-fetch.ts";

const publicLookup = (() =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }])) as unknown as typeof lookup;

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
    // fe80::/10 link-local spans the fe80–febf hextet range, not just fe80::/16.
    ["fe90::1", true],
    ["fea0::1", true],
    ["febf::1", true],
    ["not-an-ip", false],
    // 100.64.0.0/10 (CGNAT, RFC 6598): the /10 mask covers second-octet values 64–127, so the
    // near-miss just below the range (100.63.x) must stay public and the first address IN the
    // range (100.64.0.0) must be blocked.
    ["100.64.0.1", true],
    ["100.100.1.1", true],
    ["100.127.255.255", true],
    ["100.63.255.255", false],
    ["100.128.0.0", false],
    // NAT64's well-known prefix (RFC 6052, `64:ff9b::/96`) embeds a translated IPv4 address in its
    // low 32 bits — the IPv6 mirror of `::ffff:/96` above. `7f00:1` decodes to 127.0.0.1, so this
    // must resolve as private through the SAME embedded-address check the mapped form uses.
    ["64:ff9b::7f00:1", true],
    // The embedded address itself is public, so the NAT64 wrapper must not make it private.
    ["64:ff9b::808:808", false],
    // One hextet off the real well-known prefix (64:ff9c, not 64:ff9b) — must NOT be treated as
    // NAT64 at all, so it falls through to the plain non-private IPv6 case.
    ["64:ff9c::7f00:1", false],
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

describe("safeFetchFollowing", () => {
  test("refuses a redirect to loopback", async () => {
    const hops: string[] = [];
    const redirects: (string | undefined)[] = [];
    const fetchFn = ((url: URL | string, init?: RequestInit) => {
      hops.push(String(url));
      redirects.push(init?.redirect);
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/x" } }),
      );
    }) as unknown as typeof fetch;

    await expect(
      safeFetchFollowing("https://example.test/a", {}, { fetchFn, lookupFn: publicLookup }),
    ).rejects.toThrow(/loopback\/private/);
    expect(hops).toHaveLength(1);
    expect(redirects).toEqual(["manual"]);
  });

  test("stops after maxHops rather than following a redirect loop", async () => {
    let calls = 0;
    const redirects: (string | undefined)[] = [];
    const fetchFn = ((_u: URL | string, init?: RequestInit) => {
      calls += 1;
      redirects.push(init?.redirect);
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://example.test/next" } }),
      );
    }) as unknown as typeof fetch;

    await expect(
      safeFetchFollowing(
        "https://example.test/a",
        {},
        { fetchFn, lookupFn: publicLookup, maxHops: 3 },
      ),
    ).rejects.toThrow(/too many redirects/);
    expect(calls).toBe(4); // initial + 3 hops
    expect(redirects).toEqual(["manual", "manual", "manual", "manual"]);
  });

  // The forced "manual" is the property this whole function exists to establish: without it, real
  // `fetch` follows the redirect internally, the first response is already the final 200, and no
  // intermediate hop is ever validated — silently restoring the bug this task fixes. A caller's
  // own `redirect` request must not be able to win that argument.
  test("forces redirect: 'manual' even when the caller requests 'follow'", async () => {
    const redirects: (string | undefined)[] = [];
    let calls = 0;
    const fetchFn = ((_u: URL | string, init?: RequestInit) => {
      calls += 1;
      redirects.push(init?.redirect);
      return Promise.resolve(
        calls === 1
          ? new Response(null, { status: 302, headers: { location: "https://example.test/b" } })
          : new Response("BYTES", { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const res = await safeFetchFollowing(
      "https://example.test/a",
      { redirect: "follow" },
      { fetchFn, lookupFn: publicLookup },
    );
    expect(await res.text()).toBe("BYTES");
    expect(redirects).toEqual(["manual", "manual"]);
  });

  test("STRIPS Authorization when the redirect crosses an origin", async () => {
    const seen: (string | null)[] = [];
    const redirects: (string | undefined)[] = [];
    let calls = 0;
    const fetchFn = ((_u: URL | string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      redirects.push(init?.redirect);
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(null, { status: 302, headers: { location: "https://cdn.other.test/b" } })
          : new Response("BYTES", { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await safeFetchFollowing(
      "https://api.example.test/a",
      { headers: { Authorization: "Bearer SECRET" } },
      { fetchFn, lookupFn: publicLookup },
    );
    expect(seen).toEqual(["Bearer SECRET", null]);
    expect(redirects).toEqual(["manual", "manual"]);
  });

  test("KEEPS Authorization on a same-origin redirect", async () => {
    const seen: (string | null)[] = [];
    const redirects: (string | undefined)[] = [];
    let calls = 0;
    const fetchFn = ((_u: URL | string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      redirects.push(init?.redirect);
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(null, { status: 302, headers: { location: "https://api.example.test/b" } })
          : new Response("BYTES", { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await safeFetchFollowing(
      "https://api.example.test/a",
      { headers: { Authorization: "Bearer SECRET" } },
      { fetchFn, lookupFn: publicLookup },
    );
    expect(seen).toEqual(["Bearer SECRET", "Bearer SECRET"]);
    expect(redirects).toEqual(["manual", "manual"]);
  });

  // fetch's own cross-origin redirect handling strips Authorization, Cookie AND Proxy-Authorization
  // — safeFetchFollowing must not be strictly weaker than the runtime behaviour it replaces.
  test("STRIPS a standard Cookie header when the redirect crosses an origin", async () => {
    const seen: (string | null)[] = [];
    let calls = 0;
    const fetchFn = ((_u: URL | string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("cookie"));
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(null, { status: 302, headers: { location: "https://cdn.other.test/b" } })
          : new Response("BYTES", { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await safeFetchFollowing(
      "https://api.example.test/a",
      { headers: { Cookie: "sid=SECRET" } },
      { fetchFn, lookupFn: publicLookup },
    );
    expect(seen).toEqual(["sid=SECRET", null]);
  });

  // This codebase also sends bearer-shaped credentials under repo-specific header names (GitLab's
  // PRIVATE-TOKEN among them) that a deny-list naming only the WHATWG-standard three would miss.
  test("STRIPS a repo-specific credential header (PRIVATE-TOKEN) when the redirect crosses an origin", async () => {
    const seen: (string | null)[] = [];
    let calls = 0;
    const fetchFn = ((_u: URL | string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("private-token"));
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(null, { status: 302, headers: { location: "https://cdn.other.test/b" } })
          : new Response("BYTES", { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await safeFetchFollowing(
      "https://gitlab.example.test/a",
      { headers: { "PRIVATE-TOKEN": "glpat-SECRET" } },
      { fetchFn, lookupFn: publicLookup },
    );
    expect(seen).toEqual(["glpat-SECRET", null]);
  });

  // URL.origin includes the port, so this passes today — but it is the one axis a future refactor
  // to a bare `.host`/`.hostname` comparison would break invisibly.
  test("treats a differing port on the same host as a different origin", async () => {
    const seen: (string | null)[] = [];
    let calls = 0;
    const fetchFn = ((_u: URL | string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://api.example.test:8443/b" },
            })
          : new Response("BYTES", { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await safeFetchFollowing(
      "https://api.example.test/a",
      { headers: { Authorization: "Bearer SECRET" } },
      { fetchFn, lookupFn: publicLookup },
    );
    expect(seen).toEqual(["Bearer SECRET", null]);
  });

  test("returns the final response when every hop is public", async () => {
    let calls = 0;
    const fetchFn = (() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(null, { status: 302, headers: { location: "https://cdn.example.test/b" } })
          : new Response("BYTES", { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const res = await safeFetchFollowing(
      "https://example.test/a",
      {},
      { fetchFn, lookupFn: publicLookup },
    );
    expect(await res.text()).toBe("BYTES");
  });
});
