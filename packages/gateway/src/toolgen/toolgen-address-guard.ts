import { ToolgenError } from "./toolgen-types.ts";

/**
 * Headers a generated tool may NOT set. The broker attaches credentials itself (spec § 6.3); a tool
 * that could set its own `Authorization` could attach a secret obtained some other way to a host of
 * its choosing. `Cookie` is here for the same reason — it is an auth header wearing a different name.
 *
 * Lowercase, because header names are case-insensitive and the caller lowercases before lookup.
 */
export const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

/**
 * `https:` only in PR 1. Plain `http:` is refused rather than warned about: a generated tool's
 * traffic carries an owner's credential, and the local-dev escape hatch that would relax this is a
 * deliberate deferral (spec § 13), not an oversight.
 */
export function assertAllowedScheme(url: URL): void {
  if (url.protocol !== "https:") {
    throw new ToolgenError(
      "ERR_TOOLGEN_HOST_NOT_ALLOWED",
      `refusing ${url.protocol} — generated tools may reach https only`,
    );
  }
}

function parseIpv4(ip: string): readonly number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

/**
 * Parse an IPv6 address string into an array of 8 hextets (16-bit values).
 * Handles `::` compression, full 8-group form, and trailing dotted-quad for IPv4-mapped/compatible.
 * Returns null if the address is malformed.
 */
type Hextets = readonly [number, number, number, number, number, number, number, number];

/** A hextet group is 1-4 hex digits; `Number.parseInt` then cannot exceed 0xffff, but check anyway. */
function isHextetGroup(g: string): boolean {
  return /^[0-9a-f]{1,4}$/.test(g) && Number.parseInt(g, 16) <= 0xffff;
}

/**
 * Rewrite a trailing dotted-quad (IPv4-mapped `::ffff:1.2.3.4`, IPv4-compatible `::1.2.3.4`) into
 * the two hextets it encodes, so the rest of the parser sees one uniform colon-separated form.
 * Returns the address unchanged when there is no dotted-quad, or `null` when there is one and it
 * does not parse.
 */
function expandIpv4Suffix(addr: string): string | null {
  const groups = addr.split(":");
  const lastGroup = groups.at(-1);
  if (lastGroup?.includes(".") !== true) return addr;
  const v4 = parseIpv4(lastGroup);
  if (v4 === null) return null;
  const [a, b, c, d] = v4 as [number, number, number, number];
  groups[groups.length - 1] = ((a << 8) | b).toString(16);
  groups.push(((c << 8) | d).toString(16));
  return groups.join(":");
}

/** The `::`-compressed form: validate both sides, then pad the middle back out to 8 hextets. */
function parseCompressed(addr: string): number[] | null {
  const [before, after] = addr.split("::");
  const beforeGroups = before ? before.split(":") : [];
  const afterGroups = after ? after.split(":") : [];
  for (const g of [...beforeGroups, ...afterGroups]) {
    if (g && !isHextetGroup(g)) return null;
  }
  const beforeHex = beforeGroups.map((g) => Number.parseInt(g, 16));
  const afterHex = afterGroups.map((g) => Number.parseInt(g, 16));
  const totalGroups = beforeHex.length + afterHex.length;
  // 8 or more groups leaves `::` standing for zero hextets, which is not what it means.
  if (totalGroups >= 8) return null;
  return [...beforeHex, ...new Array(8 - totalGroups).fill(0), ...afterHex];
}

/** The uncompressed form: exactly 8 groups, every one of them a valid hextet. */
function parseFull(groups: readonly string[]): number[] | null {
  if (groups.length !== 8) return null;
  for (const g of groups) {
    if (!isHextetGroup(g)) return null;
  }
  return groups.map((g) => Number.parseInt(g, 16));
}

/**
 * Parse an IPv6 address string into an array of 8 hextets (16-bit values).
 * Handles `::` compression, full 8-group form, and trailing dotted-quad for IPv4-mapped/compatible.
 * Returns null if the address is malformed.
 */
function parseIpv6(ip: string): Hextets | null {
  // Strip surrounding brackets, then fold any trailing dotted-quad into hextets.
  const addr = expandIpv4Suffix(ip.toLowerCase().replace(/^\[|\]$/g, ""));
  if (addr === null) return null;

  // More than one `::` is ambiguous about how many zero hextets each stands for.
  if ((addr.match(/::/g) ?? []).length > 1) return null;

  const hextets = addr.includes("::") ? parseCompressed(addr) : parseFull(addr.split(":"));
  if (hextets === null || hextets.length !== 8) return null;
  return hextets as unknown as Hextets;
}

/**
 * Addresses the broker refuses EVEN WHEN THE OWNER APPROVED THE HOST — the one place this design
 * overrides an owner approval, and deliberately.
 *
 * Spec § 4.3's whole argument is that the sandboxed tool cannot reach the Gateway's own IPC socket
 * or `127.0.0.1` HTTP API (the I13 write surface, the `agents` and `resolve` token scopes). A
 * broker that proxied it there would hand back exactly the reach the empty network set took away.
 * I33 names the same target for the same reason.
 *
 * Called on the RESOLVED address, never the hostname: a name that resolves to `127.0.0.1` defeats
 * a hostname check completely.
 */
/** True when hextets `0 .. n-1` are all zero — the shared prefix test every special form below needs. */
function zerosThrough(h: Hextets, n: number): boolean {
  for (let i = 0; i < n; i++) {
    if (h[i] !== 0) return false;
  }
  return true;
}

/** The dotted-quad an IPv6 form embeds in its low 32 bits. */
function embeddedIpv4(h: Hextets): string {
  const a = (h[6] >> 8) & 0xff;
  const b = h[6] & 0xff;
  const c = (h[7] >> 8) & 0xff;
  const d = h[7] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function isForbiddenIpv4(v4: readonly number[]): boolean {
  const [a, b] = v4 as [number, number, number, number];
  if (a === 127 || a === 0) return true; // loopback + unspecified
  if (a === 10) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 — 172.16/12, NOT all of 172
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  return false;
}

/**
 * The IPv6 half. Three forms EMBED an IPv4 address in their low 32 bits, and all three are judged
 * on what a caller actually reaches — the embedded address — rather than on the wrapper.
 */
function isForbiddenIpv6(h: Hextets): boolean {
  if (zerosThrough(h, 7) && h[7] === 0) return true; // unspecified `::`
  if (zerosThrough(h, 7) && h[7] === 1) return true; // loopback `::1`
  if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10 (fe80–febf)
  if ((h[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7

  // IPv4-mapped `::ffff:x.x.x.x`.
  if (zerosThrough(h, 5) && h[5] === 0xffff) return isForbiddenAddress(embeddedIpv4(h));
  // IPv4-compatible `::x.x.x.x` — everything above already matched what it could.
  if (zerosThrough(h, 6)) return isForbiddenAddress(embeddedIpv4(h));

  // NAT64 well-known prefix `64:ff9b::/96` (RFC 6052 § 2.1) → h[0]=0x0064, h[1]=0xff9b, h[2..5]=0,
  // with the translated IPv4 in the low 32 bits. The prefix itself is NOT a private range — it is a
  // real, routable prefix a NAT64 gateway assigns — so nothing above catches it, and without this
  // branch `64:ff9b::a9fe:a9fe` reaches the cloud metadata endpoint through a translating gateway
  // while every check upstream reports the destination as public.
  //
  // `util/safe-fetch.ts` already saw through this shape (`extractNat64V4`); this is the same policy
  // in the hextet form this file parses to. Stated bound, matching safe-fetch rather than widening
  // past it: RFC 6052 also permits network-specific prefixes (/32 … /64), which are not recognised
  // here because they are not identifiable from the address alone.
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isForbiddenAddress(embeddedIpv4(h));
  }

  return false;
}

export function isForbiddenAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return isForbiddenIpv4(v4);
  const h = parseIpv6(ip);
  // An unparseable string is not an address we can judge.
  return h === null ? false : isForbiddenIpv6(h);
}
