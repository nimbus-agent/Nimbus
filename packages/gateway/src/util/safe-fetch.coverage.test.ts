/**
 * `safe-fetch.ts` edges `safe-fetch.test.ts` does not reach: the `0.0.0.0/8` and `172.16/12`
 * boundaries, an IPv4-mapped or NAT64 address whose tail is not an embedded IPv4, a malformed URL,
 * the default resolver when only `fetchFn` is injected, a redirect with no usable Location, and
 * which request headers survive an origin-crossing hop.
 *
 * DNS and fetch are always the injected fakes — no real network.
 */
import { describe, expect, test } from "bun:test";
import type { lookup } from "node:dns/promises";
import { assertSafeUrl, isPrivateAddress, safeFetch, safeFetchFollowing } from "./safe-fetch.ts";

const publicLookup = (() =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }])) as unknown as typeof lookup;

type Call = { url: string; init: RequestInit | undefined };

/** A fetch fake that answers each URL from `routes` and records what it was asked. */
function fakeFetch(routes: Record<string, () => Response>): {
  fetchFn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`);
    return route();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("isPrivateAddress — range boundaries", () => {
  test.each([
    ["0.0.0.0", true],
    ["0.255.1.2", true],
    ["172.15.255.255", false],
    ["172.16.0.0", true],
    ["172.31.255.255", true],
    ["172.32.0.0", false],
    ["192.167.1.1", false],
    ["169.253.1.1", false],
  ])("%s → %p", (addr, expected) => {
    expect(isPrivateAddress(addr)).toBe(expected);
  });

  test("a mapped or NAT64 address whose tail is not an embedded IPv4 is judged as plain IPv6", () => {
    // `::ffff:1:2:3` and `64:ff9b::1:2:3` are valid IPv6 whose tails carry three groups, so there
    // is no embedded IPv4 to extract; neither is in a private IPv6 range either.
    expect(isPrivateAddress("::ffff:1:2:3")).toBe(false);
    expect(isPrivateAddress("64:ff9b::1:2:3")).toBe(false);
    // The two-group hex tail IS decoded: 0a00:0001 is 10.0.0.1.
    expect(isPrivateAddress("64:ff9b::a00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:c0a8:101")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  test("an unparseable URL is refused as malformed, naming the input", () => {
    expect(() => assertSafeUrl("http//missing-colon")).toThrow(
      "unsafe url: malformed (http//missing-colon)",
    );
    expect(() => assertSafeUrl("")).toThrow("unsafe url: malformed ()");
  });
});

describe("safeFetch", () => {
  test("with only fetchFn injected, a literal public IP reaches that fetch with the caller's init unchanged", async () => {
    // No lookupFn: the default resolver stays in place, but a literal-IP host never consults it,
    // so this stays off the network.
    const { fetchFn, calls } = fakeFetch({
      "https://93.184.216.34/file": () => new Response("ok"),
    });
    const res = await safeFetch("https://93.184.216.34/file", { method: "GET" }, { fetchFn });
    expect(await res.text()).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toEqual({ method: "GET" });
  });
});

describe("safeFetchFollowing", () => {
  test("a 3xx with no Location header is returned as the final response", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://a.example/start": () => new Response(null, { status: 302 }),
    });
    const res = await safeFetchFollowing(
      "https://a.example/start",
      {},
      { lookupFn: publicLookup, fetchFn },
    );
    expect(res.status).toBe(302);
    expect(calls.map((c) => c.url)).toEqual(["https://a.example/start"]);
  });

  test("a 3xx with an empty Location header is returned as the final response", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://a.example/start": () =>
        new Response(null, { status: 301, headers: { location: "" } }),
    });
    const res = await safeFetchFollowing(
      "https://a.example/start",
      {},
      { lookupFn: publicLookup, fetchFn },
    );
    expect(res.status).toBe(301);
    expect(calls).toHaveLength(1);
  });

  test("an origin-crossing hop forwards only allow-listed headers; a same-origin hop forwards all", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://api.example/dl": () =>
        new Response(null, { status: 302, headers: { location: "/dl/2" } }),
      "https://api.example/dl/2": () =>
        new Response(null, { status: 307, headers: { location: "https://cdn.example/blob" } }),
      "https://cdn.example/blob": () => new Response("bytes"),
    });
    const res = await safeFetchFollowing(
      "https://api.example/dl",
      {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "nimbus-test",
          Range: "bytes=0-99",
          Authorization: "Bearer secret",
          "X-Api-Key": "k-123",
        },
      },
      { lookupFn: publicLookup, fetchFn },
    );
    expect(await res.text()).toBe("bytes");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.example/dl",
      "https://api.example/dl/2",
      "https://cdn.example/blob",
    ]);
    const headersAt = (i: number): Headers => new Headers(calls[i]?.init?.headers);
    // Same origin: everything, credentials included.
    expect(headersAt(1).get("authorization")).toBe("Bearer secret");
    expect(headersAt(1).get("x-api-key")).toBe("k-123");
    // Cross origin: the allow-list only.
    const crossed = headersAt(2);
    expect(crossed.get("accept")).toBe("application/octet-stream");
    expect(crossed.get("user-agent")).toBe("nimbus-test");
    expect(crossed.get("range")).toBe("bytes=0-99");
    expect(crossed.get("authorization")).toBeNull();
    expect(crossed.get("x-api-key")).toBeNull();
    expect([...crossed.keys()].sort()).toEqual(["accept", "range", "user-agent"]);
    // Every hop is manual, whatever the caller asked for.
    expect(calls.every((c) => c.init?.redirect === "manual")).toBe(true);
  });
});
