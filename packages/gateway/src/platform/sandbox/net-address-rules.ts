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
function parseIpv4(s: string): number[] | null {
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

/** The 16 bytes of an IPv6 address (with `::` and an embedded dotted-quad tail), or null. */
function parseIpv6(s: string): number[] | null {
  if (!s.includes(":") || s.includes("%")) return null;
  let text = s;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): string[] | null => {
    if (part === "") return [];
    const g = part.split(":");
    return g.every((h) => /^[0-9a-fA-F]{1,4}$/.test(h)) ? g : null;
  };
  const head = groups(halves[0] ?? "");
  const rest = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;
  let all: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    all = [...head, ...Array.from({ length: missing }, () => "0"), ...rest];
  } else {
    all = head;
  }
  if (all.length !== 8) return null;
  const bytes: number[] = [];
  for (const h of all) {
    const n = Number.parseInt(h, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function classifyIpv4(b: readonly number[]): AddressClass {
  const a = b[0] ?? 0;
  const c = b[1] ?? 0;
  const d = b[2] ?? 0;
  if (a === 0) return "refused"; // 0.0.0.0/8 reaches the host's loopback
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && c >= 16 && c <= 31) return "private";
  if (a === 192 && c === 168) return "private";
  if (a === 100 && c >= 64 && c <= 127) return "private"; // CGNAT, Tailscale
  if (a === 169 && c === 254) return "refused"; // link-local, cloud metadata
  if (a === 192 && c === 0 && d === 0) return "refused"; // IETF protocol assignments
  if (a === 192 && c === 0 && d === 2) return "refused"; // documentation
  if (a === 198 && c === 51 && d === 100) return "refused"; // documentation
  if (a === 203 && c === 0 && d === 113) return "refused"; // documentation
  if (a === 198 && (c === 18 || c === 19)) return "refused"; // benchmarking
  if (a >= 224) return "refused"; // multicast, reserved, broadcast
  return "public";
}

function classifyIpv6(b: readonly number[]): AddressClass {
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  if (first10Zero && b[10] === 0xff && b[11] === 0xff) {
    return classifyIpv4(b.slice(12)); // IPv4-mapped: judged as the IPv4 address it carries
  }
  if (b.slice(0, 15).every((x) => x === 0)) {
    if (b[15] === 1) return "loopback";
    if (b[15] === 0) return "refused"; // ::
  }
  const b0 = b[0] ?? 0;
  const b1 = b[1] ?? 0;
  if ((b0 & 0xfe) === 0xfc) return "private"; // fc00::/7 unique-local
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return "refused"; // fe80::/10 link-local
  if (b0 === 0xff) return "refused"; // multicast
  // Only global unicast (2000::/3) can be public; everything else is unassigned or special.
  if ((b0 & 0xe0) !== 0x20) return "refused";
  if (b0 === 0x20 && b1 === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "refused"; // documentation
  if (b0 === 0x3f && b1 === 0xff && ((b[2] ?? 0) & 0xf0) === 0) return "refused"; // 3fff::/20 documentation
  if (b0 === 0x20 && b1 === 0x01 && b[2] === 0 && b[3] === 0) return "refused"; // Teredo
  if (b0 === 0x20 && b1 === 0x02) return "refused"; // 6to4 embeds an arbitrary IPv4 address
  return "public";
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
