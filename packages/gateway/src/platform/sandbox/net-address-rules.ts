/**
 * Which resolved addresses a declared network entry may connect to (the forwarder's "Address
 * rules"). Pure: no I/O, no resolver. The wrapper outside the sandbox resolves the name once,
 * passes the answers here, and connects only to an address that comes back.
 *
 * "Public" is whatever matches NO listed range, so a range nobody listed is refused rather than
 * allowed. Everything below is a refusal list plus two allow lists (private, loopback).
 */

export type AddressClass = "public" | "private" | "loopback" | "refused";

/** Who chose the entry. Decides which classes of answer the entry may reach. */
export type EntryTrust = "owner" | "first-party" | "package";

/** The 4 bytes of a dotted-quad IPv4 address, or null for anything else (no leading zeros). */
export function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** True when `s` is a dotted-quad IPv4 address by the same rule the address checks use. */
export function isIpv4Literal(s: string): boolean {
  return parseIpv4(s) !== null;
}

/** Replace a dotted-quad tail with its two hex groups; null for a malformed tail, `s` if none. */
function embedIpv4Tail(s: string): string | null {
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (!tail.includes(".")) return s;
  const v4 = parseIpv4(tail);
  if (v4 === null) return null;
  const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
  const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
  return `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
}

/** The colon-separated hex groups of one side of `::`, or null when any group is malformed. */
function parseGroups(part: string): string[] | null {
  if (part === "") return [];
  const g = part.split(":");
  return g.every((h) => /^[0-9a-fA-F]{1,4}$/.test(h)) ? g : null;
}

/** The 8 groups of an address split on `::` (one or two halves), zero-filled, or null. */
function expandHalves(halves: readonly string[]): string[] | null {
  const head = parseGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    return [...head, ...Array.from({ length: missing }, () => "0"), ...rest];
  }
  return head.length === 8 ? head : null;
}

function groupsToBytes(groups: readonly string[]): number[] {
  const bytes: number[] = [];
  for (const h of groups) {
    const n = Number.parseInt(h, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

/** The 16 bytes of an IPv6 address (with `::` and an embedded dotted-quad tail), or null. */
function parseIpv6(s: string): number[] | null {
  if (!s.includes(":") || s.includes("%")) return null;
  const text = embedIpv4Tail(s);
  if (text === null) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const all = expandHalves(halves);
  return all === null ? null : groupsToBytes(all);
}

/** One range of the address space: the leading `bits` bits of `prefix`, and what it classifies as. */
type CidrRule = {
  readonly prefix: readonly number[];
  readonly bits: number;
  readonly class: AddressClass;
};

/** True when the first `bits` bits of `b` equal those of `prefix`. */
function inCidr(b: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i * 8 < bits; i++) {
    const mask = (0xff << (8 - Math.min(8, bits - i * 8))) & 0xff;
    if (((b[i] ?? 0) & mask) !== ((prefix[i] ?? 0) & mask)) return false;
  }
  return true;
}

/** The class of the FIRST rule that contains `b`, or null. Table order is the order of the checks. */
function firstMatch(b: readonly number[], rules: readonly CidrRule[]): AddressClass | null {
  for (const rule of rules) {
    if (inCidr(b, rule.prefix, rule.bits)) return rule.class;
  }
  return null;
}

/** IPv4 ranges, checked in this order; an address in none of them is public. */
const IPV4_RULES: readonly CidrRule[] = [
  { prefix: [0], bits: 8, class: "refused" }, // 0.0.0.0/8 reaches the host's loopback
  { prefix: [127], bits: 8, class: "loopback" },
  { prefix: [10], bits: 8, class: "private" },
  { prefix: [172, 16], bits: 12, class: "private" },
  { prefix: [192, 168], bits: 16, class: "private" },
  { prefix: [100, 64], bits: 10, class: "private" }, // CGNAT, Tailscale
  { prefix: [169, 254], bits: 16, class: "refused" }, // link-local, cloud metadata
  { prefix: [192, 0, 0], bits: 24, class: "refused" }, // IETF protocol assignments
  { prefix: [192, 0, 2], bits: 24, class: "refused" }, // documentation
  { prefix: [198, 51, 100], bits: 24, class: "refused" }, // documentation
  { prefix: [203, 0, 113], bits: 24, class: "refused" }, // documentation
  { prefix: [198, 18], bits: 15, class: "refused" }, // benchmarking
  { prefix: [224], bits: 3, class: "refused" }, // multicast, reserved, broadcast
];

function classifyIpv4(b: readonly number[]): AddressClass {
  return firstMatch(b, IPV4_RULES) ?? "public";
}

/** ::ffff:0:0/96, IPv4-mapped: judged as the IPv4 address it carries. */
const IPV4_MAPPED_PREFIX: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/** IPv6 ranges checked after the mapped form, in this order. */
const IPV6_RULES: readonly CidrRule[] = [
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], bits: 128, class: "loopback" },
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 128, class: "refused" }, // ::
  { prefix: [0xfc], bits: 7, class: "private" }, // fc00::/7 unique-local
  { prefix: [0xfe, 0x80], bits: 10, class: "refused" }, // fe80::/10 link-local
  { prefix: [0xff], bits: 8, class: "refused" }, // multicast
  { prefix: [0x20, 0x01, 0x0d, 0xb8], bits: 32, class: "refused" }, // documentation
  { prefix: [0x3f, 0xff], bits: 20, class: "refused" }, // 3fff::/20 documentation
  { prefix: [0x20, 0x01, 0, 0], bits: 32, class: "refused" }, // Teredo
  { prefix: [0x20, 0x02], bits: 16, class: "refused" }, // 6to4 embeds an arbitrary IPv4 address
];

function classifyIpv6(b: readonly number[]): AddressClass {
  if (inCidr(b, IPV4_MAPPED_PREFIX, 96)) return classifyIpv4(b.slice(12));
  const listed = firstMatch(b, IPV6_RULES);
  if (listed !== null) return listed;
  // Only global unicast (2000::/3) can be public; everything else is unassigned or special.
  return inCidr(b, [0x20], 3) ? "public" : "refused";
}

function parseAddress(ip: string): number[] | null {
  return parseIpv4(ip) ?? parseIpv6(ip);
}

/** Classify one literal address. Anything that is not an IP literal is `refused`. */
export function classifyAddress(ip: string): AddressClass {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = parseIpv6(ip);
  return v6 === null ? "refused" : classifyIpv6(v6);
}

/** The entry's host as an address when it is a literal (brackets allowed), else null. */
function literalBytes(host: string): number[] | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return parseAddress(bare);
}

/** An IPv4-mapped IPv6 address as its 4 IPv4 bytes; anything else unchanged. */
function unmapped(x: readonly number[]): readonly number[] {
  return x.length === 16 && x.slice(0, 10).every((v) => v === 0) && x[10] === 0xff && x[11] === 0xff
    ? x.slice(12)
    : x;
}

/** True when two literals name the same address, an IPv4-mapped form equalling its IPv4 form. */
function sameAddress(a: readonly number[], b: readonly number[]): boolean {
  const ua = unmapped(a);
  const ub = unmapped(b);
  return ua.length === ub.length && ua.every((v, i) => v === ub[i]);
}

/**
 * The answers of `entry.host` the wrapper may connect to, in the order given. A refused address is
 * dropped, never rewritten.
 *
 * - owner: public and private; loopback only when the entry is `localhost` or that same literal.
 * - first-party: public and private.
 * - package: public; private only when the entry IS that literal address (the owner saw it at
 *   approval); never loopback.
 * Link-local and every non-routable range are refused for everyone.
 */
export function allowedAddresses(
  entry: { host: string; trust: EntryTrust },
  answers: readonly string[],
): string[] {
  const host = entry.host.toLowerCase();
  const literal = literalBytes(host);
  return answers.filter((answer) => {
    const bytes = parseAddress(answer);
    if (bytes === null) return false;
    switch (classifyAddress(answer)) {
      case "public":
        return true;
      case "private":
        if (entry.trust === "package") return literal !== null && sameAddress(literal, bytes);
        return true;
      case "loopback":
        if (entry.trust !== "owner") return false;
        return host === "localhost" || (literal !== null && sameAddress(literal, bytes));
      default:
        return false;
    }
  });
}
