// One link-value: `<uri>; rel="next"`. No `g` flag, so the shared instance is
// safe to reuse across iterations (exec keeps no lastIndex state without `g`).
const LINK_VALUE_RE = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/i;

/**
 * Parse an RFC 5988 Link header and return the absolute URL of the `rel="next"`
 * relation, or null when absent. Tolerant of casing, surrounding whitespace, and
 * the quoting style of the rel value.
 */
export function parseNextLink(header: string | null): string | null {
  if (header === null || header.trim() === "") {
    return null;
  }
  for (const part of header.split(",")) {
    const match = LINK_VALUE_RE.exec(part);
    if (match === null) {
      continue;
    }
    const url = match[1]?.trim();
    const rel = match[2]?.trim().toLowerCase();
    if (rel === "next" && url !== undefined && url !== "") {
      return url;
    }
  }
  return null;
}
