// packages/gateway/src/security/credential-text.ts
// Whether a piece of text looks like a credential, by the high-confidence secret patterns. Moved out of
// `connectors/connector-writes/commit-paths.ts` unchanged so a module outside `connectors/` (the signed
// workflow export) can use it; `commit-paths.ts` re-exports it. Imports only `secret-patterns.ts`.
import { SECRET_PATTERNS } from "./secret-patterns.ts";

/** The longest run a credential pattern may match in one token class (see {@link boundedSource}). */
export const TOKEN_RUN_MAX = 4096;

/**
 * A LINEAR-TIME copy of a shared pattern's source. The shared patterns have unbounded runs (`+`,
 * `{n,}`), so text like `eyJ-eyJ-eyJ-...` made each start rescan the whole rest (quadratic). Here
 * every unbounded run is capped at {@link TOKEN_RUN_MAX}, which bounds the work per start, and a
 * word boundary (`\b`) after an unbounded run is dropped (a prefix of a longer token is still a
 * credential-looking token, so nothing is lost by matching it). Fixed-length patterns are as is.
 */
export function boundedSource(source: string): string {
  const unboundedEnd = /(?:\+|\{\d+,\})\\b$/u;
  const noTail = unboundedEnd.test(source) ? source.slice(0, -2) : source;
  return noTail
    .replaceAll(/\{(\d+),\}/gu, `{$1,${String(TOKEN_RUN_MAX)}}`)
    .replaceAll(/(\])\+/gu, `$1{1,${String(TOKEN_RUN_MAX)}}`);
}

/**
 * NON-GLOBAL, bounded clones of the high-confidence secret patterns, compiled once at load. The
 * shared `SECRET_PATTERNS` regexes are global (`lastIndex` state), so calling `.test()` on them
 * would make a second check of the same text depend on the first.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze(
  SECRET_PATTERNS.map(
    (p) => new RegExp(boundedSource(p.regex.source), p.regex.flags.replaceAll("g", "")),
  ),
);

/** Whether `text` looks like a credential by any high-confidence pattern. */
export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(text));
}

/** The number of compiled credential patterns (a test pins it to the shared table's length). */
export const CREDENTIAL_PATTERN_COUNT = CREDENTIAL_PATTERNS.length;
