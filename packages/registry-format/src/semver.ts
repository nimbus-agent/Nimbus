// Strict SemVer 2.0.0: the version is joined into a path, so no range syntax, `v` prefix or whitespace.
// Parsed in parts rather than by one regex: MAJOR.MINOR.PATCH, then an optional `-` pre-release and
// an optional `+` build, each a non-empty dot-separated list of identifiers.

/** A numeric identifier: `0`, or digits with no leading zero. */
const NUMERIC_ID_RE = /^(?:0|[1-9]\d*)$/;
/** The characters every pre-release and build identifier is drawn from (non-empty). */
const ID_CHARS_RE = /^[0-9A-Za-z-]+$/;
const ALL_DIGITS_RE = /^\d+$/;

/** Numeric with no leading zero, or alphanumeric with at least one non-digit. */
function isPrereleaseId(id: string): boolean {
  return ID_CHARS_RE.test(id) && (NUMERIC_ID_RE.test(id) || !ALL_DIGITS_RE.test(id));
}

function isBuildId(id: string): boolean {
  return ID_CHARS_RE.test(id);
}

/** Splits `s` at the FIRST `sep`: `[before, after]`, or `[s, undefined]` when `sep` is absent. */
function splitFirst(s: string, sep: string): [string, string | undefined] {
  const at = s.indexOf(sep);
  return at === -1 ? [s, undefined] : [s.slice(0, at), s.slice(at + 1)];
}

/** Strict SemVer 2.0.0, the one rule the index, update apply, publishing and role packs share. */
export function isValidSemver(v: string): boolean {
  // Neither the core nor a pre-release identifier may hold `+`, so the first `+` starts the build;
  // the core holds no `-`, so the first `-` before it starts the pre-release.
  const [head, build] = splitFirst(v, "+");
  if (build !== undefined && !build.split(".").every(isBuildId)) return false;
  const [core, pre] = splitFirst(head, "-");
  if (pre !== undefined && !pre.split(".").every(isPrereleaseId)) return false;
  const parts = core.split(".");
  return parts.length === 3 && parts.every((p) => NUMERIC_ID_RE.test(p));
}
