import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";

import type { NimbusFilesystemRootToml } from "../../config/filesystem-toml.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { matchConfiguredRoot, parseRef, resolveWhySubject } from "./why-subject.ts";

const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
function root(p: string): NimbusFilesystemRootToml {
  return { path: p, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] };
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
