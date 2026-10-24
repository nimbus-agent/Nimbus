// Strict SemVer 2.0.0: the version is joined into a path, so no range syntax, `v` prefix or whitespace.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Strict SemVer 2.0.0, the one rule the index, update apply, publishing and role packs share. */
export function isValidSemver(v: string): boolean {
  return SEMVER_RE.test(v);
}
