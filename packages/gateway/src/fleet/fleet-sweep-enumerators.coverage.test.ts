/**
 * `buildFleetSweepEnumerate`'s routing for the three DB-backed kinds (the existing test drives only
 * `services`), its refusal of a kind it does not know, and a symbol label with no file part under
 * a path-filtered sweep. Every routed result is compared against the enumerator called directly
 * AND is non-empty, so a route that reached the wrong enumerator (or passed the wrong param or
 * prefix) cannot pass by both sides being empty.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SweepKind } from "../config/fleet-toml.ts";
import { computeTermStats, markConsolidated, upsertCandidate } from "../glossary/glossary-store.ts";
import { normalizeTerm } from "../glossary/term-normalize.ts";
import { ensureGraphEntity } from "../graph/relationship-graph.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dirExternalId, fileExternalId } from "../ownership/ownership-pass.ts";
import {
  buildFleetSweepEnumerate,
  enumeratePaths,
  enumerateSymbols,
  enumerateTerms,
} from "./fleet-sweep-enumerators.ts";

// Roots are only ever compared as strings here; nothing is read from or written to them.
const ROOT = join(tmpdir(), "nimbus-sweep-cov-root");

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});

afterEach(() => {
  db.close();
});

function symbol(label: string): void {
  ensureGraphEntity(db, {
    type: "symbol",
    externalId: `sym:${label}`,
    label,
    service: "filesystem",
  });
}

function seedAll(): void {
  for (const rel of ["src/auth.ts", "docs/readme.md"]) {
    ensureGraphEntity(db, {
      type: "source_file",
      externalId: fileExternalId(ROOT, rel),
      label: rel,
      service: "filesystem",
    });
  }
  ensureGraphEntity(db, {
    type: "directory",
    externalId: dirExternalId(ROOT, "src"),
    label: "src",
    service: "filesystem",
  });
  symbol("parseConfig — src/config.ts");
  symbol("Widget — lib/widget.ts");
  const key = normalizeTerm("Retry Budget");
  upsertCandidate(db, {
    key,
    surface: "Retry Budget",
    form: "phrase",
    stats: computeTermStats(db, key),
    score: 1,
    nowMs: 1,
  });
  markConsolidated(db, {
    termKey: key,
    definition: "d",
    definitionSource: "snippet",
    synonyms: [],
    nearMisses: [],
    nowMs: 2,
  });
}

describe("buildFleetSweepEnumerate routing", () => {
  test("paths, symbols and terms each reach their own enumerator with the request's param and prefix", () => {
    seedAll();
    let rootReads = 0;
    const enumerate = buildFleetSweepEnumerate({
      db,
      roots: () => {
        rootReads += 1;
        return [ROOT];
      },
      serviceIds: () => [],
    });

    // Each kind is asked for a param it does not usually carry (paths normally `path`, symbols
    // `file`, terms `term`), so a route that ignored `req.param` and hard-coded its usual one would
    // produce a different subject param — and fail — rather than coincide with the request.
    const paths = enumerate({ kind: "paths", param: "file", pathPrefix: "src/" });
    expect(paths).toEqual(enumeratePaths(db, [ROOT], "file", "src/"));
    // The prefix is matched against each node's relative path: `src/auth.ts` is under "src/",
    // while the `src` directory node itself and `docs/readme.md` are not.
    expect(paths.subjects).toEqual([
      {
        key: `paths:${fileExternalId(ROOT, "src/auth.ts")}`,
        params: { file: join(ROOT, "src/auth.ts") },
      },
    ]);
    expect(rootReads).toBe(1);

    const symbols = enumerate({ kind: "symbols", param: "path", pathPrefix: "src/" });
    expect(symbols).toEqual(enumerateSymbols(db, "path", "src/"));
    expect(symbols.subjects).toEqual([
      {
        key: "symbols:parseConfig — src/config.ts",
        params: { path: "parseConfig — src/config.ts" },
      },
    ]);

    const terms = enumerate({ kind: "terms", param: "service", pathPrefix: null });
    expect(terms).toEqual(enumerateTerms(db, "service"));
    expect(terms.subjects).toEqual([
      { key: `terms:${normalizeTerm("Retry Budget")}`, params: { service: "Retry Budget" } },
    ]);
    // Roots are read per PATHS enumeration only.
    expect(rootReads).toBe(1);
  });

  test("a kind it does not know is refused, not answered with an empty list", () => {
    const enumerate = buildFleetSweepEnumerate({ db, roots: () => [], serviceIds: () => [] });
    expect(() =>
      enumerate({ kind: "repos" as SweepKind, param: "path", pathPrefix: null }),
    ).toThrow("unknown sweep kind: repos");
  });
});

describe("enumerateSymbols — a label with no file part", () => {
  test("is excluded from a path-filtered sweep, but swept when unfiltered", () => {
    symbol("orphanSymbol");
    // A fileless label that itself STARTS with the prefix: matching the whole label against the
    // prefix (the fallback the source rules out) would admit it, so excluding it proves the
    // file part — empty here — is what is matched.
    symbol("src/orphanShim");
    symbol("parseConfig — src/config.ts");
    expect(enumerateSymbols(db, "file", "src/").subjects.map((s) => s.key)).toEqual([
      "symbols:parseConfig — src/config.ts",
    ]);
    expect(enumerateSymbols(db, "file", null).subjects.map((s) => s.key)).toEqual([
      "symbols:orphanSymbol",
      "symbols:parseConfig — src/config.ts",
      "symbols:src/orphanShim",
    ]);
  });
});
