import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestRegistry } from "../../packages/gateway/src/extensions/registry/__fixtures__/build-test-registry.ts";
import { assertNoRollback, buildCatalogSnapshot, type CatalogDeps } from "./catalog-snapshot.ts";
import { readPrevious } from "./snapshot-official-registry.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-catalog-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-18T12:00:00Z");

function deps(rootKey: string, over: Partial<CatalogDeps> = {}): CatalogDeps {
  return {
    builtin: { url: dir, rootKey },
    trustSnapshot: null,
    trustFeed: null,
    // A local-folder registry is read from disk; any network use is a test failure.
    fetchFn: () => Promise.reject(new Error("unexpected network")),
    production: false,
    now: () => NOW,
    previous: null,
    ...over,
  };
}

describe("buildCatalogSnapshot", () => {
  test("snapshots each extension's newest verified manifest, every version and its evidence", async () => {
    const reg = await buildTestRegistry(dir, {
      id: "acme.tool",
      publisherId: "acme",
      versions: [
        { version: "1.0.0" },
        {
          version: "1.1.0",
          quality: {
            scorer: 1,
            score: 66,
            cases: 3,
            passed: 2,
            rubrics: {
              exact: { cases: 1, passed: 1 },
              "json-match": { cases: 1, passed: 1 },
              "one-of": { cases: 1, passed: 0 },
            },
          },
        },
      ],
      manifestExtra: {
        displayName: "Acme Tool",
        description: "Does acme things.",
        permissions: { network: ["api.acme.test"], filesystem: { read: [], write: [] } },
        license: "MIT",
        funding: [{ url: "https://sponsor.acme.test/", label: "Sponsor" }],
      },
    });
    const snap = await buildCatalogSnapshot(deps(reg.rootKey));
    expect(snap.registry).toBe("nimbus-official");
    expect(snap.snapshotAt).toBe("2026-11-18T12:00:00.000Z");
    expect(snap.indexSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.extensions).toHaveLength(1);
    const e = snap.extensions[0];
    expect(e).toMatchObject({
      id: "acme.tool",
      displayName: "Acme Tool",
      description: "Does acme things.",
      publisherId: "acme",
      verifiedPublisher: null,
      kind: "other",
      newest: "1.1.0",
      network: ["api.acme.test"],
      license: "MIT",
      funding: [{ url: "https://sponsor.acme.test/", label: "Sponsor" }],
    });
    expect(e?.versions.map((v) => [v.version, v.blocked, v.quality?.score ?? null])).toEqual([
      ["1.1.0", false, 66],
      ["1.0.0", false, null],
    ]);
    expect(e?.tested).toContain("2 of 3");
    expect(e?.history).toContain("2 versions");
  });

  test("writes the same content for the same index (stable output, equal sequence accepted)", async () => {
    const reg = await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    const a = await buildCatalogSnapshot(deps(reg.rootKey));
    const b = await buildCatalogSnapshot(
      deps(reg.rootKey, { previous: { sequence: a.sequence, indexSha256: a.indexSha256 } }),
    );
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("refuses a manifest whose signature does not verify (I16)", async () => {
    const reg = await buildTestRegistry(dir, {
      id: "acme.tool",
      versions: [{ version: "1.0.0" }],
      badManifestSignature: true,
    });
    await expect(buildCatalogSnapshot(deps(reg.rootKey))).rejects.toThrow(/signature/);
  });

  test("refuses a manifest whose bytes do not match the index hash", async () => {
    const reg = await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    const path = join(dir, "extensions", "acme.tool", "1.0.0", "manifest.json");
    writeFileSync(path, `${readFileSync(path, "utf8")} `);
    await expect(buildCatalogSnapshot(deps(reg.rootKey))).rejects.toThrow(/hash/);
  });

  test("refuses an index the baked root key did not sign", async () => {
    await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    const otherKey = "tBHSfVjFZzyMoSVR69FbZfMyUstbLdUcfGwHKIaY/qA=";
    await expect(buildCatalogSnapshot(deps(otherKey))).rejects.toThrow();
  });

  test("refuses a rollback below, or different content at, the committed sequence", async () => {
    const reg = await buildTestRegistry(dir, {
      id: "acme.tool",
      versions: [{ version: "1.0.0" }],
      sequence: 3,
    });
    await expect(
      buildCatalogSnapshot(deps(reg.rootKey, { previous: { sequence: 4, indexSha256: "x" } })),
    ).rejects.toThrow(/below the committed snapshot/);
    await expect(
      buildCatalogSnapshot(deps(reg.rootKey, { previous: { sequence: 3, indexSha256: "x" } })),
    ).rejects.toThrow(/different content/);
  });
});

describe("assertNoRollback and readPrevious", () => {
  test("a first snapshot and a newer sequence pass", () => {
    expect(() => assertNoRollback(null, 1, "a")).not.toThrow();
    expect(() => assertNoRollback({ sequence: 1, indexSha256: "a" }, 2, "b")).not.toThrow();
  });

  test("reads the committed floor, or none, and refuses a file that is not a snapshot", () => {
    const path = join(dir, "snap.json");
    expect(readPrevious(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ sequence: 4, indexSha256: "ab" }));
    expect(readPrevious(path)).toEqual({ sequence: 4, indexSha256: "ab" });
    writeFileSync(path, JSON.stringify({ sequence: "4" }));
    expect(() => readPrevious(path)).toThrow(/no sequence/);
    writeFileSync(path, "null");
    expect(() => readPrevious(path)).toThrow(/not a snapshot/);
  });
});
