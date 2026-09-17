import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMatchToken } from "../agents/_lib/match-token.ts";
import { computeTermStats, markConsolidated, upsertCandidate } from "../glossary/glossary-store.ts";
import { normalizeTerm } from "../glossary/term-normalize.ts";
import { syncGraphFromIndexedItem } from "../graph/graph-populator.ts";
import { ensureGraphEntity } from "../graph/relationship-graph.ts";
import { openMigratedDb } from "../index/migrated-db-template.ts";
import { dirExternalId, fileExternalId } from "../ownership/ownership-pass.ts";
import { resolveOwnershipPath } from "../ownership/ownership-target.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import {
  buildFleetSweepEnumerate,
  enumeratePaths,
  enumerateServices,
  enumerateSymbols,
  enumerateTerms,
} from "./fleet-sweep-enumerators.ts";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-sweep-enum-"));
  db = openMigratedDb(join(dir, "nimbus.db"));
});

afterEach(() => {
  db.close(); // close BEFORE rm, or an EBUSY cleanup error replaces the real failure
  rmSync(dir, { recursive: true, force: true, maxRetries: 0 });
});

function repo(name: string, files: readonly string[]): string {
  const root = join(dir, name);
  for (const f of files) {
    mkdirSync(join(root, ...f.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...f.split("/")), "x");
  }
  return root;
}

function fileNode(root: string, rel: string): void {
  ensureGraphEntity(db, {
    type: "source_file",
    externalId: fileExternalId(root, rel),
    label: rel,
    service: "filesystem",
  });
}
function dirNode(root: string, rel: string): void {
  ensureGraphEntity(db, {
    type: "directory",
    externalId: dirExternalId(root, rel),
    label: rel === "" ? root : rel,
    service: "filesystem",
  });
}

describe("enumeratePaths", () => {
  test("emits the ownership pass's own nodes, each resolving to ITS OWN root", () => {
    const a = repo("a", ["src/auth.ts"]);
    const b = repo("b", ["src/auth.ts"]);
    fileNode(a, "src/auth.ts");
    fileNode(b, "src/auth.ts");
    dirNode(a, "src");
    dirNode(a, "");

    const out = enumeratePaths(db, [a, b], "path", null);
    expect(out.emptyReason).toBeNull();
    expect(out.subjects.map((s) => s.key)).toEqual(
      [
        `paths:${dirExternalId(a, "")}`,
        `paths:${dirExternalId(a, "src")}`,
        `paths:${fileExternalId(a, "src/auth.ts")}`,
        `paths:${fileExternalId(b, "src/auth.ts")}`,
      ].sort(codeUnitCompare),
    );

    // The AGENT's resolver, not a key-shape check: the same relative path under two roots must
    // resolve to two different roots, and the root node must reach the root-itself arm.
    for (const s of out.subjects) {
      const path = s.params["path"];
      expect(path).toBeDefined();
      const resolved = resolveOwnershipPath([a, b], path ?? "");
      expect(resolved).not.toBeNull();
      const expectedRoot = s.key.includes(b) ? b : a;
      expect(resolved?.repoRoot).toBe(expectedRoot);
    }
    const rootSubject = out.subjects.find((s) => s.key === `paths:${dirExternalId(a, "")}`);
    expect(resolveOwnershipPath([a, b], rootSubject?.params["path"] ?? "")?.relPath).toBe("");
  });

  test("drops nodes under roots no longer configured", () => {
    const a = repo("a", ["x.ts"]);
    const gone = repo("gone", ["y.ts"]);
    fileNode(a, "x.ts");
    fileNode(gone, "y.ts");
    expect(enumeratePaths(db, [a], "path", null).subjects).toHaveLength(1);
  });

  test("path_prefix is a case-sensitive prefix on the relative path", () => {
    const a = repo("a", ["packages/x.ts", "Packages/y.ts", "src/z.ts"]);
    fileNode(a, "packages/x.ts");
    fileNode(a, "Packages/y.ts");
    fileNode(a, "src/z.ts");
    const out = enumeratePaths(db, [a], "path", "packages/");
    expect(out.subjects.map((s) => s.key)).toEqual([`paths:${fileExternalId(a, "packages/x.ts")}`]);
  });

  test("states WHY it is empty", () => {
    expect(enumeratePaths(db, [], "path", null).emptyReason).toMatch(
      /no git-aware filesystem roots/,
    );
    const a = repo("a", []);
    expect(enumeratePaths(db, [a], "path", null).emptyReason).toMatch(/has not written any/);
    fileNode(a, "src/z.ts");
    expect(enumeratePaths(db, [a], "path", "docs/").emptyReason).toMatch(
      /under path_prefix "docs\/"/,
    );
  });

  test("a key is identical across two enumerations of an unchanged index", () => {
    const a = repo("a", ["x.ts"]);
    fileNode(a, "x.ts");
    expect(enumeratePaths(db, [a], "path", null)).toEqual(enumeratePaths(db, [a], "path", null));
  });
});

describe("enumerateSymbols", () => {
  function symbol(id: string, name: string, file: string, kind: string): void {
    syncGraphFromIndexedItem(db, {
      id,
      service: "filesystem",
      type: "code_symbol",
      title: `${name} (${kind})`,
      bodyPreview: file,
      authorId: null,
      metadata: { name, kind, file, repoRoot: "/r" },
    });
  }

  test("emits each DISTINCT label; the agent's exact-label lookup resolves it", () => {
    symbol("filesystem:sym:1", "parseConfig", "src/config.ts", "function");
    symbol("filesystem:sym:2", "Widget", "src/ui/widget.ts", "class");
    const out = enumerateSymbols(db, "file", null);
    expect(out.emptyReason).toBeNull();
    for (const s of out.subjects) {
      const token = resolveMatchToken(db, s.params["file"] ?? "");
      expect(token.entityId).not.toBeNull();
      expect(token.token).toBe(s.params["file"] ?? "");
    }
  });

  test("a label collision (same name + file, different kind) is ONE subject — stated bound", () => {
    symbol("filesystem:sym:1", "Config", "src/config.ts", "function");
    symbol("filesystem:sym:2", "Config", "src/config.ts", "type");
    expect(enumerateSymbols(db, "file", null).subjects).toHaveLength(1);
  });

  test("path_prefix matches the label's file part", () => {
    symbol("filesystem:sym:1", "a", "src/ui/a.ts", "function");
    symbol("filesystem:sym:2", "b", "lib/b.ts", "function");
    const out = enumerateSymbols(db, "file", "src/");
    expect(out.subjects.map((s) => s.params["file"])).toEqual(["a — src/ui/a.ts"]);
  });

  test("states why it is empty", () => {
    expect(enumerateSymbols(db, "file", null).emptyReason).toMatch(/no code symbols are indexed/);
  });
});

describe("enumerateTerms", () => {
  test("consolidated terms only; the parameter normalises back to the key", () => {
    for (const [surface, consolidate] of [
      ["Retry Budget", true],
      ["Pending Thing", false],
    ] as const) {
      const key = normalizeTerm(surface);
      upsertCandidate(db, {
        key,
        surface,
        form: "phrase",
        stats: computeTermStats(db, key),
        score: 1,
        nowMs: 1,
      });
      if (consolidate) {
        markConsolidated(db, {
          termKey: key,
          definition: "d",
          definitionSource: "snippet",
          synonyms: [],
          nearMisses: [],
          nowMs: 2,
        });
      }
    }
    const out = enumerateTerms(db, "term");
    expect(out.subjects).toHaveLength(1);
    const [s] = out.subjects;
    expect(s?.key).toBe(`terms:${normalizeTerm("Retry Budget")}`);
    expect(normalizeTerm(s?.params["term"] ?? "")).toBe(normalizeTerm("Retry Budget"));
  });

  test("states why it is empty", () => {
    expect(enumerateTerms(db, "term").emptyReason).toMatch(/no consolidated glossary terms/);
  });
});

describe("enumerateServices", () => {
  test("one subject per configured service id, sorted", () => {
    const out = enumerateServices(["checkout", "billing"], "service");
    expect(out.subjects).toEqual([
      { key: "services:billing", params: { service: "billing" } },
      { key: "services:checkout", params: { service: "checkout" } },
    ]);
  });

  test("states why it is empty", () => {
    expect(enumerateServices([], "service").emptyReason).toMatch(/no services are configured/);
  });
});

describe("buildFleetSweepEnumerate", () => {
  test("reads roots and services FRESH on every call", () => {
    let ids: string[] = ["a"];
    const enumerate = buildFleetSweepEnumerate({ db, roots: () => [], serviceIds: () => ids });
    expect(
      enumerate({ kind: "services", param: "service", pathPrefix: null }).subjects,
    ).toHaveLength(1);
    ids = ["a", "b"];
    expect(
      enumerate({ kind: "services", param: "service", pathPrefix: null }).subjects,
    ).toHaveLength(2);
  });
});
