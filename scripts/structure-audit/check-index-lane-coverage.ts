#!/usr/bin/env bun

/**
 * Task 1.6 — census assembly for the index lane-coverage gate (spec B4).
 *
 * Assembles the already-committed Tasks 1.1–1.5 into one census over `packages/gateway/src/**`:
 * every production read predicate on `item.type` / `item.metadata.<key>` (plus the same shape on
 * `graph_entity`/`graph_relation`, carried for visibility only), every production write, and the
 * diff between them — which `item` reads no writer in the scoped corpus satisfies.
 *
 * `collectLaneCensus` is pure (no I/O, no filesystem access) — only `run()` below touches disk.
 *
 * Always exits 0: this is a census, not a gate, exactly like `collectDbRunCensus` in
 * `check-nimbus-invariants.ts`. A later task turns a slice of this artifact into an enforced,
 * exemption-listed gate.
 *
 * **The matching rule this file owns:** a metadata key is matched against the `type` it was read
 * *beside* — the type predicate(s) found in the same SQL string literal — never against a global
 * pool of every type any writer happens to emit that key under. Global matching is a hole big
 * enough to swallow the original bug this whole gate exists to catch: a writer emitting `parent_key`
 * under `issue` would make a `pr`-scoped read of `parent_key` look satisfied, the same cross-context
 * conflation as a `graph_entity` write of `commit` satisfying an `item` read of `commit`. Where a
 * metadata-key read has no type predicate anywhere in its enclosing literal (a JS-side
 * `meta["key"]` read is the common case — it isn't inside a SQL literal at all), the read is scoped
 * `"__ANY__"`: matched against the union of every key any writer emits under any type, which is
 * strictly weaker, and every such read is counted in `ambiguousReadCount` so that weaker confidence
 * stays visible in the artifact rather than blending into the strict-scope numbers.
 */

import type { FileEntry } from "./check-nimbus-invariants.ts";
import { extractReadTriples, type ReadTriple } from "./lane-census/read-sites.ts";
import { extractSqlLiterals, type SqlLiteral } from "./lane-census/sql-literals.ts";
import {
  extractWriterEmissions,
  WRITER_EXCLUDE,
  WRITER_INCLUDE,
  type WriterEmission,
} from "./lane-census/writer-emissions.ts";
import { auditOutputPath, iterateSourceFiles } from "./lib.ts";

export type ParameterizedRead = { readonly file: string; readonly line: number };

export type LaneCensus = {
  readonly reads: readonly ReadTriple[];
  readonly writes: readonly WriterEmission[];
  /** `item` reads (only — `graph_entity`/`graph_relation` are never gated in v1) no writer satisfies. */
  readonly unmatchedItemReads: readonly ReadTriple[];
  /**
   * Count of `item` metadata-key reads that carried no type predicate anywhere in their enclosing
   * SQL literal (or, for a JS-side `meta["key"]` read, no enclosing SQL literal at all) — the
   * `"__ANY__"` scope. These are still checked (against the weaker union-of-everything pool) and
   * may still land in `unmatchedItemReads`; this count is what makes the weaker confidence of that
   * subset visible rather than indistinguishable from a strictly type-scoped result.
   */
  readonly ambiguousReadCount: number;
  /** Every `type = ?` (or `qualifier.type = ?`) site, by file and line — never gated, always visible. */
  readonly parameterizedReads: readonly ParameterizedRead[];
};

/**
 * Type-scope sentinel for a metadata-key read with no type predicate in its enclosing literal.
 * Documents the value `scopeTypesFor` returns as an empty set (see its doc comment) — never
 * assigned anywhere, since an empty `ReadonlySet<string>` already carries this meaning, but the
 * artifact's own vocabulary (LaneCensus doc comment, `check-index-lane-coverage.test.ts`) names it
 * literally, so it is exported rather than left implicit in prose alone.
 */
export const ANY_SCOPE = "__ANY__";

/** `[qualifier.]type = ?` — the parameterized counterpart to `read-sites.ts`'s literal-value regex. Built fresh per call, matching this directory's convention (a shared `g`-flagged RegExp across calls is Task 1.2's hazard). */
function parameterizedTypeRegex(): RegExp {
  return /(?:\b[a-z_][a-z0-9_]*\.)?\btype\s*=\s*\?/gi;
}

/** 1-indexed line of `indexInSql` within `literal`, same counting rule every file in this directory uses. */
function lineWithinLiteral(literal: SqlLiteral, indexInSql: number): number {
  let offset = 0;
  for (let i = 0; i < indexInSql; i++) {
    if (literal.sql[i] === "\n") offset++;
  }
  return literal.line + offset;
}

/** Every `type = ?` site in `contents`, by line — one pass over the file's SQL literals. */
function findParameterizedTypeReads(contents: string): readonly { readonly line: number }[] {
  const out: { line: number }[] = [];
  for (const literal of extractSqlLiterals(contents)) {
    const re = parameterizedTypeRegex();
    let m: RegExpExecArray | null = re.exec(literal.sql);
    while (m !== null) {
      out.push({ line: lineWithinLiteral(literal, m.index) });
      m = re.exec(literal.sql);
    }
  }
  return out;
}

/** The line span (1-indexed, inclusive) a SQL literal occupies, derived from its own newline count. */
type LiteralSpan = { readonly startLine: number; readonly endLine: number };

function computeLiteralSpans(contents: string): readonly LiteralSpan[] {
  return extractSqlLiterals(contents).map((literal) => {
    let newlines = 0;
    for (const ch of literal.sql) {
      if (ch === "\n") newlines++;
    }
    return { startLine: literal.line, endLine: literal.line + newlines };
  });
}

/** Whether `line` falls inside `span`. */
function lineInSpan(span: LiteralSpan, line: number): boolean {
  return line >= span.startLine && line <= span.endLine;
}

/**
 * Whether `relPath` is a real production write site under Task 1.5's `WRITER_INCLUDE`/
 * `WRITER_EXCLUDE` corpus rules — the one place this file decides which files are scanned as
 * writers, mirroring the same prefix/substring rules the constants document.
 */
function isWriterFile(relPath: string): boolean {
  const included = WRITER_INCLUDE.some(
    (prefix) => relPath === prefix || relPath.startsWith(prefix),
  );
  if (!included) return false;
  return !WRITER_EXCLUDE.some((marker) => relPath.includes(marker));
}

/**
 * The type value(s) "read beside" a metadata-key triple: every `kind: "type"` triple, on the SAME
 * tracked table, whose line falls inside the SQL literal span containing the metadata-key triple's
 * own line. Empty when the triple's line falls inside no literal at all (a JS-side read) or inside
 * a literal that carries no type predicate for that table — both cases are the `"__ANY__"` scope.
 *
 * A `type IN (...)` predicate legitimately contributes MULTIPLE values here — those are still "the
 * type(s) read beside" the metadata key, not an ambiguity to fall back from. Ambiguity is reserved
 * for the case this function reports as an empty set: no type predicate in scope at all.
 */
function scopeTypesFor(
  triple: ReadTriple,
  spans: readonly LiteralSpan[],
  fileTypeTriples: readonly ReadTriple[],
): ReadonlySet<string> {
  const span = spans.find((s) => lineInSpan(s, triple.line));
  if (span === undefined) return new Set();
  const types = new Set<string>();
  for (const t of fileTypeTriples) {
    if (t.table !== triple.table) continue;
    if (lineInSpan(span, t.line)) types.add(t.value);
  }
  return types;
}

/** The writer corpus, indexed for both strict per-type matching and the weaker `"__ANY__"` union check. */
type WriterIndex = {
  readonly writtenTypes: ReadonlySet<string>;
  readonly keysByType: ReadonlyMap<string, ReadonlySet<string>>;
  readonly allKeys: ReadonlySet<string>;
};

function buildWriterIndex(writes: readonly WriterEmission[]): WriterIndex {
  const writtenTypes = new Set<string>();
  const keysByType = new Map<string, Set<string>>();
  const allKeys = new Set<string>();
  for (const w of writes) {
    writtenTypes.add(w.itemType);
    const keys = keysByType.get(w.itemType) ?? new Set<string>();
    for (const key of w.metadataKeys) {
      keys.add(key);
      allKeys.add(key);
    }
    keysByType.set(w.itemType, keys);
  }
  return { writtenTypes, keysByType, allKeys };
}

/**
 * Assembles the full lane census over `files`: every read triple, every writer emission (scoped by
 * `WRITER_INCLUDE`/`WRITER_EXCLUDE`), the `item`-table reads no writer satisfies, the count of
 * type-unscoped (`"__ANY__"`) metadata-key reads, and every parameterized `type = ?` site.
 *
 * Pure — takes file contents already in memory, does no filesystem access itself.
 */
export function collectLaneCensus(files: readonly FileEntry[]): LaneCensus {
  const reads: ReadTriple[] = [];
  const writes: WriterEmission[] = [];
  const parameterizedReads: ParameterizedRead[] = [];

  type PerFile = {
    readonly fileReads: readonly ReadTriple[];
    readonly spans: readonly LiteralSpan[];
  };
  const perFile: PerFile[] = [];

  for (const f of files) {
    const fileReads = extractReadTriples(f.relPath, f.contents);
    reads.push(...fileReads);
    perFile.push({ fileReads, spans: computeLiteralSpans(f.contents) });

    for (const p of findParameterizedTypeReads(f.contents)) {
      parameterizedReads.push({ file: f.relPath, line: p.line });
    }

    if (isWriterFile(f.relPath)) {
      writes.push(...extractWriterEmissions(f.relPath, f.contents));
    }
  }

  const writerIndex = buildWriterIndex(writes);

  const unmatchedItemReads: ReadTriple[] = [];
  let ambiguousReadCount = 0;

  for (const { fileReads, spans } of perFile) {
    const typeTriples = fileReads.filter((t) => t.kind === "type");

    for (const triple of fileReads) {
      // graph_entity / graph_relation are carried in `reads` for visibility but are never gated
      // in v1 — the writer corpus below is built exclusively from `item` writes, so a graph-table
      // triple could never be more than an accidental, meaningless match anyway.
      if (triple.table !== "item") continue;

      if (triple.kind === "type") {
        if (!writerIndex.writtenTypes.has(triple.value)) {
          unmatchedItemReads.push(triple);
        }
        continue;
      }

      // kind === "metadata-key"
      const scopeTypes = scopeTypesFor(triple, spans, typeTriples);
      if (scopeTypes.size === 0) {
        ambiguousReadCount++;
        if (!writerIndex.allKeys.has(triple.value)) {
          unmatchedItemReads.push(triple);
        }
        continue;
      }

      const satisfied = [...scopeTypes].some(
        (type) => writerIndex.keysByType.get(type)?.has(triple.value) ?? false,
      );
      if (!satisfied) {
        unmatchedItemReads.push(triple);
      }
    }
  }

  return { reads, writes, unmatchedItemReads, ambiguousReadCount, parameterizedReads };
}

// -------------------------------------------------------------------------------------------
// CLI entry point — the only part of this file that touches the filesystem.
// -------------------------------------------------------------------------------------------

/**
 * `imap`/`protonmail` write item rows through a generic cross-file mapper whose call sites are
 * plain function calls rather than an inline `{ service: ..., type: ..., metadata: ... }` object
 * literal, so their real writes produce ZERO `WriterEmission` rows in this corpus. If this
 * artifact reports `imap:email` or `protonmail:email` (or any other imap/protonmail lane) as
 * unmatched, that is this corpus blind spot surfacing, not a confirmed dead lane — read it that
 * way, don't silently trust the diff. `__UNRESOLVED__` writer rows carry no such risk: they can
 * never accidentally *match* a read (no real read predicate has the literal value
 * `"__UNRESOLVED__"`), so an unresolved writer can only ever cost a missed dead-lane detection,
 * never a false "covered".
 */
const KNOWN_BLIND_SPOTS: readonly string[] = [
  "imap and protonmail write item rows through a generic cross-file mapper called with plain " +
    "function-call arguments rather than an inline `{ service, type, metadata }` object literal, " +
    "so their real writes produce zero WriterEmission rows here. An `imap:*`/`protonmail:*` entry " +
    "in unmatchedItemReads is this blind spot, not a confirmed dead lane.",
];

async function run(): Promise<void> {
  const files: FileEntry[] = [];
  for await (const f of iterateSourceFiles()) {
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    files.push({ relPath: f.relPath, contents: f.contents });
  }

  const census = collectLaneCensus(files);

  const outPath = auditOutputPath("index-lane-census.json");
  const artifact = {
    generatedAt: new Date().toISOString(),
    knownBlindSpots: KNOWN_BLIND_SPOTS,
    counts: {
      reads: census.reads.length,
      writes: census.writes.length,
      unmatchedItemReads: census.unmatchedItemReads.length,
      ambiguousReadCount: census.ambiguousReadCount,
      parameterizedReads: census.parameterizedReads.length,
    },
    reads: census.reads,
    writes: census.writes,
    unmatchedItemReads: census.unmatchedItemReads,
    ambiguousReadCount: census.ambiguousReadCount,
    parameterizedReads: census.parameterizedReads,
  };
  await Bun.write(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(
    `index-lane census: ${census.reads.length} reads, ${census.writes.length} writes, ` +
      `${census.unmatchedItemReads.length} unmatched item reads, ` +
      `${census.ambiguousReadCount} ambiguous (__ANY__-scoped), ` +
      `${census.parameterizedReads.length} parameterized → ${outPath}`,
  );
  // Always exits 0 — this is a census, not a gate. A later task turns a slice of it into an
  // enforced gate, exactly as `db-run-census.json` precedes `check-nimbus-invariants.ts`'s
  // enforced D12 checks.
}

if (import.meta.main) await run();
