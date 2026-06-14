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
    const match = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/i);
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
