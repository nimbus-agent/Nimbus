import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const p = addr.split(".").map((n) => Number.parseInt(n, 10));
    if (p[0] === 127 || p[0] === 10) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && (p[1] ?? 0) >= 16 && (p[1] ?? 0) <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 0) return true;
    return false;
  }
  if (v === 6) {
    const a = addr.toLowerCase();
    return (
      a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80")
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
  const host = url.hostname;
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
export async function safeFetch(raw: string, init?: RequestInit): Promise<Response> {
  const url = assertSafeUrl(raw);
  if (isIP(url.hostname) === 0) {
    const resolved = await lookup(url.hostname, { all: true });
    for (const { address } of resolved) {
      if (isPrivateAddress(address)) {
        throw new Error(`unsafe url: ${url.hostname} resolves to private ${address}`);
      }
    }
  }
  return fetch(url, init);
}
