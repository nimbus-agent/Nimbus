// scripts/cleanup/protected-comments.ts
//
// Which files `strip-comments.ts` must refuse, and why.
//
// A comment in this repo is frequently not prose. Two independent bodies of work read
// comments as DATA:
//
//   1. `docs/SECURITY-INVARIANTS.md` carries an audited comment inventory - rows of the
//      form `path/to/file.ts:LINE | I13 | what that comment attests`. Deleting the comment
//      does not fail a build; it silently turns a documented security attestation into a
//      citation of nothing. That exact drift was found and fixed on http-routes.ts, where
//      the doc cited comments at lines 5 and 13 of a file that had no comments at all.
//
//   2. Comments carrying an invariant id, a HITL note, a BUG/ticket reference or a
//      security/timing caveat are the rationale that makes those defenses auditable. The
//      repo already had a detector for them (`survey-comments.ts`); it just was not wired
//      to anything that could act on it.
//
// `PRESERVE_PRAGMAS` in `strip-comments.ts` does NOT cover either group - it protects
// machine-read directives (`biome-ignore`, `NOSONAR`, `@ts-expect-error`), which is a
// different question from whether a human-read comment is load-bearing.
//
// The markers and the comment scanner live HERE rather than in `survey-comments.ts` so the
// surveyor and the stripper cannot disagree about what "load-bearing" means: one definition,
// two readers. The same shape the gateway uses for I31's disclosure anchors.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "./lib.ts";

/**
 * A comment matching any of these is load-bearing: it encodes an invariant, a gate, a
 * defect reference or a security caveat that the surrounding code does not restate.
 */
export const LOAD_BEARING_MARKERS = [
  { name: "I-numbered", pattern: /\bI[1-9]\d?\b/ },
  { name: "HITL", pattern: /\bHITL\b/ },
  { name: "WHY", pattern: /\bWHY:/ },
  { name: "NOTE", pattern: /\bNOTE:/ },
  { name: "WORKAROUND", pattern: /\bWORKAROUND\b/i },
  { name: "BUG-ref", pattern: /\bBUG-[A-Z0-9-]+\b/ },
  { name: "ticket-ref", pattern: /#\d{2,}/ },
  { name: "TODO", pattern: /\bTODO\b/ },
  { name: "FIXME", pattern: /\bFIXME\b/ },
  { name: "HACK", pattern: /\bHACK\b/ },
  { name: "XXX", pattern: /\bXXX\b/ },
  { name: "security/timing", pattern: /\b(constant-?time|side-?channel|leak)\b/i },
] as const;

/** Every comment line in `source`, as 1-based line number + the comment text on that line. */
export function findCommentLines(source: string): Array<{ line: number; text: string }> {
  const lines = source.split(/\r?\n/);
  const hits: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (inBlock) {
      hits.push({ line: i + 1, text: raw.trim() });
      if (raw.includes("*/")) inBlock = false;
      continue;
    }
    const slashIdx = raw.indexOf("//");
    const blockIdx = raw.indexOf("/*");
    if (blockIdx >= 0 && (slashIdx < 0 || blockIdx < slashIdx)) {
      hits.push({ line: i + 1, text: raw.slice(blockIdx).trim() });
      if (!raw.slice(blockIdx).includes("*/")) inBlock = true;
    } else if (slashIdx >= 0) {
      hits.push({ line: i + 1, text: raw.slice(slashIdx).trim() });
    }
  }
  return hits;
}

/** The marker a source's comments trip, or `undefined` when none of them are load-bearing. */
export function loadBearingMarker(source: string): string | undefined {
  for (const { line: _line, text } of findCommentLines(source)) {
    for (const { name, pattern } of LOAD_BEARING_MARKERS) {
      if (pattern.test(text)) return name;
    }
  }
  return undefined;
}

const INVARIANT_DOC = "docs/SECURITY-INVARIANTS.md";

/**
 * Repo-relative paths that the invariant doc cites BY LINE, i.e. whose comments it attests to.
 *
 * A bare path mention is deliberately not enough - the doc names plenty of files as wiring
 * sites without depending on their comments. Only a `file.ts:123` citation does.
 */
export function parseInvariantCitedFiles(docText: string): Set<string> {
  const out = new Set<string>();
  for (const m of docText.matchAll(/`((?:packages|scripts)\/[^`\s:]+\.(?:ts|tsx|rs)):\d+`/g)) {
    const p = m[1];
    if (p !== undefined) out.add(p);
  }
  return out;
}

/**
 * The floor below which the guard is not meaningful.
 *
 * The dangerous failure here is not a wrong answer, it is an EMPTY one: if the invariant doc
 * is renamed, moved, or reshaped, `parseInvariantCitedFiles` returns an empty set, every file
 * looks unprotected, and the stripper deletes 152 attested comments while reporting success.
 * So an empty parse is treated as a broken guard rather than as "nothing to protect" - the
 * same reason `check-nimbus-invariants.ts` refuses to trust a scan that lost its subtree.
 */
export const MIN_CITED_FILES = 40;

export class ProtectedSetUnavailableError extends Error {}

export async function loadInvariantCitedFiles(
  readDoc: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<Set<string>> {
  let text: string;
  try {
    text = await readDoc(join(REPO_ROOT, INVARIANT_DOC));
  } catch (cause) {
    throw new ProtectedSetUnavailableError(
      `Cannot read ${INVARIANT_DOC}; refusing to strip comments without knowing which are attested.`,
      { cause },
    );
  }
  const cited = parseInvariantCitedFiles(text);
  if (cited.size < MIN_CITED_FILES) {
    throw new ProtectedSetUnavailableError(
      `${INVARIANT_DOC} yielded only ${String(cited.size)} line-cited files (floor ${String(MIN_CITED_FILES)}). ` +
        "Either the inventory shrank drastically or its format changed - fix the parser before stripping.",
    );
  }
  return cited;
}

export type ProtectionVerdict = { protected: false } | { protected: true; reason: string };

/** Whether this file's comments may be deleted. */
export function protectionFor(
  relFilePath: string,
  source: string,
  citedFiles: ReadonlySet<string>,
): ProtectionVerdict {
  if (citedFiles.has(relFilePath)) {
    return { protected: true, reason: `cited by ${INVARIANT_DOC}` };
  }
  const marker = loadBearingMarker(source);
  if (marker !== undefined) {
    return { protected: true, reason: `load-bearing comment (${marker})` };
  }
  return { protected: false };
}
