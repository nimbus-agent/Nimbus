import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";

import type { NimbusFilesystemRootToml } from "../../config/filesystem-toml.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { matchConfiguredRoot, parseRef, resolveWhySubject } from "./why-subject.ts";

const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
function root(p: string): NimbusFilesystemRootToml {
  return {
    path: p,
    gitAware: true,
    codeIndex: true,
    dependencyGraph: true,
    mediaIndex: false,
    exclude: [],
  };
}

test("parseRef splits a trailing line suffix and keeps drive-letter paths whole", () => {
  expect(parseRef("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
  expect(parseRef("C:\\work\\repo\\src\\a.ts:7")).toEqual({
    path: "C:\\work\\repo\\src\\a.ts",
    line: 7,
  });
  expect(parseRef("src/a.ts")).toEqual({ path: "src/a.ts", line: null });
  expect(parseRef("mySymbol")).toEqual({ path: "mySymbol", line: null });
});

test("matchConfiguredRoot maps an absolute path inside a root to root-relative POSIX", () => {
  const abs = path.join(ROOT, "src", "a.ts");
  expect(matchConfiguredRoot([root(ROOT)], abs)).toEqual({ repoRoot: ROOT, filePath: "src/a.ts" });
});

test("matchConfiguredRoot returns null for a path outside every root — the escape fence", () => {
  const outside = path.resolve(path.join(path.sep, "elsewhere", "a.ts"));
  expect(matchConfiguredRoot([root(ROOT)], outside)).toBeNull();
});

test("a relative path resolves against the first root where it exists", () => {
  const exists = (p: string): boolean => p === path.join(ROOT, "src", "a.ts");
  expect(matchConfiguredRoot([root(ROOT)], "src/a.ts", exists)).toEqual({
    repoRoot: ROOT,
    filePath: "src/a.ts",
  });
  expect(matchConfiguredRoot([root(ROOT)], "src/missing.ts", () => false)).toBeNull();
});

test("a bare token resolves through a symbol entity, line from the item's excerptStartLine", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  // Grounded in filesystem-v2-sync.ts upsertCodeSymbolsForFile (~lines 276-315):
  // externalId `sym:${rootKey}:${relNorm}:${name}:${kind}`, title `${name} (${kind})`,
  // bodyPreview `${relNorm}\n${excerpt}`, metadata {name, kind, file, repoRoot,
  // excerptStartLine?}. `upsertIndexedItem` itself calls `syncGraphFromIndexedItem`
  // (item-store.ts), which for `code_symbol` rows (graph-populator.ts
  // `syncCodeSymbolGraph`, ~line 422) upserts a `symbol` graph_entity with
  // externalId = the item's row id and metadata {file, name, repoRoot} —
  // so a single upsertIndexedItem call seeds both tables the query joins.
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "code_symbol",
    externalId: `sym:${ROOT}:src/a.ts:retryBackoff:function`,
    title: "retryBackoff (function)",
    bodyPreview: "src/a.ts\nexport function retryBackoff() {",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      name: "retryBackoff",
      kind: "function",
      file: "src/a.ts",
      repoRoot: ROOT,
      excerptStartLine: 42,
    },
  });
  const subject = resolveWhySubject(db, [root(ROOT)], { ref: "retryBackoff" }, () => false);
  expect(subject).toEqual({
    repoRoot: ROOT,
    filePath: "src/a.ts",
    lineNo: 42,
    symbol: "retryBackoff",
  });
});

test("a symbol entity whose metadata repoRoot is NOT among the configured roots resolves to null — the symbol-branch fence", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  const OUTSIDE_ROOT = path.resolve(path.join(path.sep, "elsewhere", "repo"));
  // Same connector-verbatim code_symbol shape as the test above, but the
  // symbol's own repoRoot metadata is a root that was never configured (e.g.
  // stale after removal from nimbus.toml, or written by a future symbol-entity
  // writer) — resolveWhySubject must refuse to hand this out as a subject.
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "code_symbol",
    externalId: `sym:${OUTSIDE_ROOT}:src/a.ts:retryBackoff:function`,
    title: "retryBackoff (function)",
    bodyPreview: "src/a.ts\nexport function retryBackoff() {",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      name: "retryBackoff",
      kind: "function",
      file: "src/a.ts",
      repoRoot: OUTSIDE_ROOT,
      excerptStartLine: 42,
    },
  });
  const subject = resolveWhySubject(db, [root(ROOT)], { ref: "retryBackoff" }, () => false);
  expect(subject).toBeNull();
});

test("a symbol entity whose repoRoot IS configured but whose file ..-escapes the root resolves to null — the symbol-branch file fence", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  // repoRoot is the configured root (passes the first fence), but the `file`
  // metadata traverses out of it — a poisoned/malformed symbol row must not
  // become a blame-spawn path pointing outside the root. Mirrors the
  // matchConfiguredRoot ..-escape fence for the caller-path branch.
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "code_symbol",
    externalId: `sym:${ROOT}:../../etc/passwd:retryBackoff:function`,
    title: "retryBackoff (function)",
    bodyPreview: "../../etc/passwd\nexport function retryBackoff() {",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      name: "retryBackoff",
      kind: "function",
      file: "../../etc/passwd",
      repoRoot: ROOT,
      excerptStartLine: 42,
    },
  });
  const subject = resolveWhySubject(db, [root(ROOT)], { ref: "retryBackoff" }, () => false);
  expect(subject).toBeNull();
});

test("lookupSymbol's LIKE fallback resolves a partial token against the label", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "code_symbol",
    externalId: `sym:${ROOT}:src/a.ts:retryBackoff:function`,
    title: "retryBackoff (function)",
    bodyPreview: "src/a.ts\nexport function retryBackoff() {",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      name: "retryBackoff",
      kind: "function",
      file: "src/a.ts",
      repoRoot: ROOT,
      excerptStartLine: 42,
    },
  });
  // "retryBack" is a prefix of the symbol's name, not an exact match, so the
  // exact-name query misses and only the `label LIKE '%...%'` fallback finds it.
  const subject = resolveWhySubject(db, [root(ROOT)], { ref: "retryBack" }, () => false);
  expect(subject).toEqual({
    repoRoot: ROOT,
    filePath: "src/a.ts",
    lineNo: 42,
    symbol: "retryBackoff",
  });
});

test("lookupSymbol's LIKE fallback tie-break picks the shorter label when two symbols match", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  // Neither symbol's `name` is exactly "foo", so the exact-match query misses
  // for both and the LIKE fallback (ORDER BY length(e.label) ASC) decides.
  // label = "fooBarLongName — src/deep/nested/aaa.ts" (long)
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "code_symbol",
    externalId: `sym:${ROOT}:src/deep/nested/aaa.ts:fooBarLongName:function`,
    title: "fooBarLongName (function)",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      name: "fooBarLongName",
      kind: "function",
      file: "src/deep/nested/aaa.ts",
      repoRoot: ROOT,
      excerptStartLine: 5,
    },
  });
  // label = "fooX — src/b.ts" (short)
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "code_symbol",
    externalId: `sym:${ROOT}:src/b.ts:fooX:function`,
    title: "fooX (function)",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      name: "fooX",
      kind: "function",
      file: "src/b.ts",
      repoRoot: ROOT,
      excerptStartLine: 9,
    },
  });
  const subject = resolveWhySubject(db, [root(ROOT)], { ref: "foo" }, () => false);
  expect(subject).toEqual({
    repoRoot: ROOT,
    filePath: "src/b.ts",
    lineNo: 9,
    symbol: "fooX",
  });
});

test("an unresolvable ref yields null", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  expect(resolveWhySubject(db, [root(ROOT)], { ref: "nothingHere" }, () => false)).toBeNull();
});

test("matchConfiguredRoot rejects a relative ..-escape even when the joined path exists — the escape fence", () => {
  const escapeRef = path.join("..", "..", "etc", "hosts");
  // exists() unconditionally returns true — proving the null verdict comes from
  // containment rejection, not from a failed existence check.
  expect(matchConfiguredRoot([root(ROOT)], escapeRef, () => true)).toBeNull();
});

test("matchConfiguredRoot normalizes a relative ref with a redundant ./-style segment that stays inside the root", () => {
  const innerRef = path.join("src", "..", "src", "a.ts");
  const resolvedTarget = path.resolve(path.join(ROOT, "src", "a.ts"));
  const exists = (p: string): boolean => path.resolve(p) === resolvedTarget;
  expect(matchConfiguredRoot([root(ROOT)], innerRef, exists)).toEqual({
    repoRoot: ROOT,
    filePath: "src/a.ts",
  });
});

test("matchConfiguredRoot returns null for an empty roots list", () => {
  expect(matchConfiguredRoot([], path.join("src", "a.ts"), () => true)).toBeNull();
});
