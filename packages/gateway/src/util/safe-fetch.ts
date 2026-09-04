import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Strip surrounding brackets from a WHATWG-URL IPv6 hostname (`[::1]` -> `::1`). */
export function unbracketHost(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

function isPrivateV4(addr: string): boolean {
  const p = addr.split(".").map((n) => Number.parseInt(n, 10));
  if (p[0] === 127 || p[0] === 10) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && (p[1] ?? 0) >= 16 && (p[1] ?? 0) <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 0) return true;
  return false;
}

/**
 * If `addr` is an IPv4-mapped IPv6 address, return the embedded IPv4 in dotted form;
 * otherwise null. Handles both the dotted tail (`::ffff:127.0.0.1`) and the hex tail
 * (`::ffff:7f00:1`) forms.
 */
function extractMappedV4(addr: string): string | null {
  const a = addr.toLowerCase();
  const m = /^::ffff:(.+)$/.exec(a);
  if (!m) return null;
  const tail = m[1] as string;
  // Dotted form: ::ffff:127.0.0.1
  if (isIP(tail) === 4) return tail;
  // Hex form: ::ffff:7f00:1  -> two 16-bit hex groups
  const groups = tail.split(":");
  if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
    const hi = Number.parseInt(groups[0] as string, 16);
    const lo = Number.parseInt(groups[1] as string, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    return isPrivateV4(addr);
  }
  if (v === 6) {
    const mappedV4 = extractMappedV4(addr);
    if (mappedV4 !== null) return isPrivateV4(mappedV4);
    const a = addr.toLowerCase();
    // fc00::/7 (ULA: fc/fd) + fe80::/10 (link-local: the first hextet is fe80–febf, i.e. fe8/fe9/
    // fea/feb) + loopback/unspecified. `startsWith("fe80")` alone would miss fe90::–febf:: .
    return (
      a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || /^fe[89ab]/.test(a)
    );
  }
  return false;
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`unsafe url: malformed (${raw})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsafe url: scheme ${url.protocol} not allowed (http/https only)`);
  }
  const host = unbracketHost(url.hostname);
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new Error(`unsafe url: host ${host} is loopback/private`);
  }
  return url;
}

/**
 * Validate scheme + literal/resolved address, then fetch.
 *
 * KNOWN LIMITATION: `fetch()` performs its own DNS resolution at connect time, so a malicious
 * low-TTL DNS server could return a public IP to `lookup()` here and a private IP to `fetch()` —
 * a TOCTOU/DNS-rebind window. We do NOT fully close it: pinning the connection to the resolved IP
 * would break TLS cert validation for https in Bun's fetch. Residual risk is bounded because the
 * --http sink host is config-pinned and verify-share url fetch is a user-initiated read. Full
 * IP-pinning via a custom connector is a tracked hardening follow-up, not 8a.
 */
/**
 * Injectable DNS + fetch seam. Defaults to the real `node:dns` resolver and global `fetch`;
 * tests substitute fakes to exercise the resolve-then-fetch path without real network I/O.
 */
export interface SafeFetchDeps {
  readonly lookupFn?: typeof lookup;
  readonly fetchFn?: typeof fetch;
}

export async function safeFetch(
  raw: string,
  init?: RequestInit,
  deps?: SafeFetchDeps,
): Promise<Response> {
  const doLookup = deps?.lookupFn ?? lookup;
  const doFetch = deps?.fetchFn ?? fetch;
  const url = assertSafeUrl(raw);
  const host = unbracketHost(url.hostname);
  if (isIP(host) === 0) {
    const resolved = await doLookup(host, { all: true });
    for (const { address } of resolved) {
      if (isPrivateAddress(address)) {
        throw new Error(`unsafe url: ${url.hostname} resolves to private ${address}`);
      }
    }
  }
  return doFetch(url, init);
}

const DEFAULT_MAX_HOPS = 5;

/**
 * `safeFetch` with MANUAL redirect handling, so every hop is re-validated.
 *
 * `safeFetch` alone validates only the URL it is handed and then lets `fetch` follow redirects on
 * its own — so a 302 to `127.0.0.1` is followed unchecked. That matters more for a
 * provider-returned download URL, which is pinned to nothing, than for `share/`'s config-pinned
 * sink; and the most interesting loopback target here is this gateway's own HTTP API.
 *
 * Manual following additionally removes any dependency on the runtime's own header handling across
 * an origin crossing. Bun 1.3.14 strips `Authorization` there, but relying on that would make a
 * security property depend on undocumented behaviour a version bump could change silently.
 *
 * INHERITED BOUND: `safeFetch`'s DNS-rebind TOCTOU is not closed here either — see its doc comment.
 */
export async function safeFetchFollowing(
  raw: string,
  init: RequestInit,
  deps?: SafeFetchDeps & { readonly maxHops?: number },
): Promise<Response> {
  const maxHops = deps?.maxHops ?? DEFAULT_MAX_HOPS;
  let url = raw;
  let current: RequestInit = { ...init };

  for (let hop = 0; hop <= maxHops; hop += 1) {
    // Every hop, not just the first: assertSafeUrl + the DNS check run inside safeFetch.
    const res = await safeFetch(url, { ...current, redirect: "manual" }, deps);
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (location === null || location === "") return res;
    const next = new URL(location, url).toString();

    // STRIP the credential when the origin changes. Taking over redirect handling means taking
    // over the header stripping the runtime was doing for us — and this path is LIVE, not
    // theoretical: a Drive `alt=media` download carries a bearer to `www.googleapis.com` and is
    // routinely 302'd to `*.googleusercontent.com`. Forwarding it there would hand an OAuth token
    // to a host we never authenticated to, which is the exact failure the credential rule
    // (spec § 16.4) exists to prevent.
    if (new URL(next).origin !== new URL(url).origin) {
      const headers = new Headers(current.headers);
      headers.delete("authorization");
      current = { ...current, headers };
    }
    url = next;
  }
  throw new Error(`unsafe url: too many redirects (>${maxHops})`);
}
