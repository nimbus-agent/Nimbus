/**
 * Wildcard host patterns for first-party connectors on Linux. Pure, so every OS can test it.
 *
 * A pattern has exactly one `*`, standing for part or all of ONE DNS label drawn from
 * `[a-z0-9-]+`, so it never crosses a dot. At least two labels must follow the wildcard's label,
 * which keeps `*.com` and a bare `*` out. Only a table in `first-party-manifests.ts` may carry one
 * (see `ExtensionManifest.firstPartyWildcardHosts`). Port 443 only, decided by the runner.
 */

const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
/** A literal label: RFC 1123, lower case. */
const PLAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** The wildcard's label: lower-case DNS characters and exactly one `*`. */
const WILDCARD_LABEL = /^[a-z0-9-]*\*[a-z0-9-]*$/;
/** What a name's label may be, and what the `*` may stand for. */
const NAME_CHARS = /^[a-z0-9-]+$/;

export function isValidWildcardHost(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_NAME_LENGTH) return false;
  const labels = pattern.split(".");
  const starAt = labels.findIndex((label) => label.includes("*"));
  if (starAt === -1 || labels.length - starAt < 3) return false;
  return labels.every((label, i) => {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return false;
    return i === starAt ? WILDCARD_LABEL.test(label) : PLAIN_LABEL.test(label);
  });
}

/**
 * Whether `name` (lower case, no trailing dot) is one the pattern covers. An invalid pattern
 * matches nothing.
 */
export function wildcardHostMatches(pattern: string, name: string): boolean {
  if (!isValidWildcardHost(pattern)) return false;
  const patternLabels = pattern.split(".");
  const nameLabels = name.split(".");
  if (patternLabels.length !== nameLabels.length) return false;
  return patternLabels.every((p, i) => {
    const n = nameLabels[i] ?? "";
    if (!p.includes("*")) return p === n;
    const star = p.indexOf("*");
    const prefix = p.slice(0, star);
    const suffix = p.slice(star + 1);
    return (
      n.length > prefix.length + suffix.length &&
      n.startsWith(prefix) &&
      n.endsWith(suffix) &&
      NAME_CHARS.test(n)
    );
  });
}
