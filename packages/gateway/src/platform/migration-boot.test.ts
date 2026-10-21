import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTINUITY_TABLE } from "../extensions/continuity/continuity-table.ts";
import { BUILTIN_REGISTRY } from "../extensions/registry/builtin-registry.ts";
import { resolveMigrationComposition, startMigrationBootEvaluation } from "./migration-boot.ts";

const FIXTURE_BUILTIN = { url: "/fixture/registry", rootKey: "AAAA" };
const FIXTURE_ENTRY = {
  legacyServiceId: "fixturewise",
  extensionId: "com.example.fixturewise",
  publisherKey: "k",
  sourceRootFingerprint: "f",
  credentials: { token: "fixturewise.token" },
  expectedPermissions: { network: [], read: [], write: [] },
  itemTypes: ["highlight"],
};

describe("ruling B1: the built-in registry and continuity table are injected, never configured", () => {
  test("the production assemble path (no composition options) resolves the baked defaults", () => {
    const resolved = resolveMigrationComposition(undefined);
    expect(resolved.builtin).toBe(BUILTIN_REGISTRY);
    expect(resolved.continuityTable).toBe(CONTINUITY_TABLE);
    // And the baked defaults are what make boot evaluation a no-op in this release.
    expect(BUILTIN_REGISTRY).toBeNull();
    expect(CONTINUITY_TABLE).toEqual([]);
    expect(resolveMigrationComposition({})).toEqual(resolved);
    expect(resolveMigrationComposition({ migration: {} })).toEqual(resolved);
  });

  test("a runner's fixture is passed through as ONE value, and an explicit null stays null", () => {
    const r = resolveMigrationComposition({
      migration: { builtin: FIXTURE_BUILTIN, continuityTable: [FIXTURE_ENTRY] },
    });
    expect(r.builtin).toBe(FIXTURE_BUILTIN);
    expect(r.continuityTable).toEqual([FIXTURE_ENTRY]);
    expect(resolveMigrationComposition({ migration: { builtin: null } }).builtin).toBeNull();
  });

  test("every production entry point calls assemblePlatformServices with the paths alone", () => {
    for (const os of ["win32", "darwin", "linux"]) {
      const src = readFileSync(join(import.meta.dir, `${os}.ts`), "utf8");
      const calls = [...src.matchAll(/assemblePlatformServices\(([^)]*)\)/g)].map((m) => m[1]);
      expect(calls, os).toEqual(["paths"]);
    }
  });

  test("assemble resolves ONE composition and threads it to every binding consumer", () => {
    // Comments stripped, so prose naming a constant cannot satisfy (or trip) a pin.
    const src = readFileSync(join(import.meta.dir, "assemble.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src.match(/resolveMigrationComposition\(/g)).toHaveLength(1);
    expect(src).toMatch(/const migration = resolveMigrationComposition\(composition\);/);
    // The registry fetch, the registrar, the spawn verifier, the credential resolver, the purge
    // and the engine all read the same `migration` value.
    expect(src).toMatch(/builtin: migration\.builtin,/);
    expect(src).toMatch(/table: migration\.continuityTable,/);
    expect(src).toMatch(/continuityTable: migration\.continuityTable,/);
    expect(src).toMatch(/createExtensionCredentialsResolver\(db, migration\.continuityTable\)/);
    expect(src).toMatch(/table: migration\.continuityTable \}/);
    expect(src).toMatch(/composition: migration,/);
    // Nothing in assemble names the baked constants directly, so no consumer can bypass it.
    expect(src).not.toMatch(/\bCONTINUITY_TABLE\b/);
    expect(src).not.toMatch(/\bBUILTIN_REGISTRY\b/);
  });
});

describe("boot evaluation", () => {
  const logger = () => {
    const warnings: unknown[] = [];
    return { warnings, log: { warn: (...a: unknown[]) => warnings.push(a) } };
  };

  test("runs once on a real gateway", async () => {
    let n = 0;
    const { log } = logger();
    await startMigrationBootEvaluation({ evaluate: async () => void n++ }, false, log);
    expect(n).toBe(1);
  });

  test("is skipped when demo-rooted (I41)", () => {
    let n = 0;
    const { log } = logger();
    expect(
      startMigrationBootEvaluation({ evaluate: async () => void n++ }, true, log),
    ).toBeUndefined();
    expect(n).toBe(0);
  });

  test("a rejecting evaluate is logged and never blocks or fails boot", async () => {
    const { warnings, log } = logger();
    const p = startMigrationBootEvaluation(
      { evaluate: () => Promise.reject(new Error("registry offline")) },
      false,
      log,
    );
    await expect(p).resolves.toBeUndefined();
    expect(JSON.stringify(warnings)).toContain("registry offline");
  });

  test("a synchronously throwing evaluate is logged too", async () => {
    const { warnings, log } = logger();
    const p = startMigrationBootEvaluation(
      {
        evaluate: () => {
          throw new Error("boom");
        },
      },
      false,
      log,
    );
    await expect(p).resolves.toBeUndefined();
    expect(JSON.stringify(warnings)).toContain("boom");
  });
});
