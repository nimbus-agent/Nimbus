import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { readDirFiles } from "../../test/helpers/security-invariants.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { encodeBase64 } from "../util/base64.ts";

describe("I51 — liveness and baseline evidence is inert", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  type Scenario = "no-file" | "tests-failed" | "forged" | "other-version";
  const ID = "com.example.i51";

  /** One registry install in a fresh DB; the registry is served over a fake https so it ledgers. */
  async function run(scenario: Scenario) {
    const nacl = (await import("tweetnacl")).default;
    const { signLivenessFile } = await import("@nimbus-dev/registry-format");
    const { MockVault } = await import("../vault/mock.ts");
    const { buildTestRegistry, resignIndex } = await import(
      "../extensions/registry/__fixtures__/build-test-registry.ts"
    );
    const { insertRegistry } = await import("../extensions/registry/registry-store.ts");
    const { installFromRegistry, fetchVerifiedRegistryPackage } = await import(
      "../extensions/registry/install-from-registry.ts"
    );
    const { collectRegistryUpdates } = await import(
      "../extensions/registry/registry-update-source.ts"
    );
    const { verifyManifestSignature } = await import("../extensions/verify-signature.ts");

    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i51-")));
    roots.push(tmp);
    const regDir = join(tmp, "registry");
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 80);
    const reg = await buildTestRegistry(regDir, {
      id: ID,
      versions: [{ version: "1.0.0" }, { version: "2.0.0" }],
    });
    const lseed = Uint8Array.from({ length: 32 }, (_, i) => 150 + i);
    const lkey = encodeBase64(nacl.sign.keyPair.fromSeed(lseed).publicKey);
    const indexPath = join(regDir, "index.json");
    resignIndex(indexPath, {
      ...(JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>),
      livenessKey: lkey,
    });
    const entryFor = (answered: number, tests: unknown) => ({
      checkedAt: "2026-11-01T00:00:00Z",
      hosts: { declared: 2, answered },
      tests,
    });
    if (scenario !== "no-file") {
      const extensions =
        scenario === "other-version"
          ? { [`${ID}@1.0.0`]: entryFor(2, { cases: 3, passed: 3 }) }
          : { [`${ID}@2.0.0`]: entryFor(0, { failure: "run-failed" }) };
      const doc = await signLivenessFile(
        {
          format: 1,
          livenessKey: lkey,
          sequence: 4,
          generatedAt: "2026-11-01T00:00:00Z",
          nimbusVersion: "10.15.0",
          extensions,
        },
        scenario === "forged" ? Uint8Array.from({ length: 32 }, (_, i) => 200 + i) : lseed,
      );
      writeFileSync(join(regDir, "liveness.json"), JSON.stringify(doc));
    }
    insertRegistry(db, {
      name: "main",
      url: "https://reg.test/",
      rootKey: reg.rootKey,
      rootFingerprint: publisherKeyFingerprint(reg.rootKey),
      lastSequence: 0,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: 1,
      lastIndexSha256: null,
    });
    const now = Date.parse("2026-11-02T00:00:00Z");
    const fetchDeps = {
      fetchFn: async (url: string) => {
        const u = new URL(url);
        try {
          return new Response(readFileSync(join(regDir, ...u.pathname.split("/").filter(Boolean))));
        } catch {
          return new Response("missing", { status: 404 });
        }
      },
      enforceAirGap: () => false,
      now: () => now,
      production: false,
      builtin: null,
    };
    const asked: Record<string, unknown>[] = [];
    const vault = new MockVault();
    const extensionsDir = join(tmp, "extensions");
    const deps = {
      db,
      extensionsDir,
      vault,
      fetch: fetchDeps,
      approve: async (r: unknown) => {
        asked.push({ ...(r as Record<string, unknown>) });
        return true;
      },
    };
    const rows = (method: string): number =>
      (
        db.query("SELECT COUNT(*) AS n FROM egress_ledger WHERE method = ?").get(method) as {
          n: number;
        }
      ).n;
    // Detection and the migration's package door make no liveness request at all.
    const before = rows("registry.liveness");
    const stage = join(tmp, "stage");
    mkdirSync(stage);
    await fetchVerifiedRegistryPackage(deps, { id: ID }, stage);
    const detected = await collectRegistryUpdates(
      {
        db,
        fetch: { ...fetchDeps, db },
        vault,
        verifyManifestSignature: (m, k) =>
          verifyManifestSignature(m as Parameters<typeof verifyManifestSignature>[0], k),
        now: () => now,
      },
      [
        {
          id: ID,
          version: "1.0.0",
          enabled: 1,
          source: {
            registry: "main",
            rootFingerprint: publisherKeyFingerprint(reg.rootKey),
            channel: "stable",
          },
          publisherId: "pub",
          manifest: {
            id: ID,
            version: "1.0.0",
            updateChannel: "stable",
            permissions: { network: [], filesystem: { read: [], write: [] } },
          },
        },
      ],
      new AbortController().signal,
    );
    const extra = rows("registry.liveness") - before;
    // Not vacuous: detection really ran (it found the 2.0.0 candidate and recorded no error).
    expect(detected.errors).toEqual([]);
    expect(detected.updates.map((u) => u.id)).toEqual([ID]);
    const out = await installFromRegistry(deps, { id: ID });
    const installedLivenessRows = rows("registry.liveness") - before - extra;

    // Whole rows, not a projection. Two things differ between runs for reasons that have nothing
    // to do with the evidence, and only these are normalised: the run's own temp root (each run
    // installs under a fresh directory; replaced by "<tmp>" in every string) and the wall-clock
    // columns `installed_at` and `last_verified_at` (set from Date.now() at the moment of the
    // install, so they differ by milliseconds between runs; removed). Every other column and every
    // other key of the install result is compared.
    const WALL_CLOCK = new Set(["installed_at", "last_verified_at"]);
    const norm = (v: unknown): unknown =>
      JSON.parse(
        JSON.stringify(v, (k, x) => (WALL_CLOCK.has(k) ? undefined : x))
          .split(JSON.stringify(tmp).slice(1, -1))
          .join("<tmp>"),
      );
    const extensionRows = norm(db.query("SELECT * FROM extension").all());
    const grantRows = norm(db.query("SELECT * FROM extension_run_grant").all());
    const result = norm(out);
    db.close();
    return { asked, result, extensionRows, grantRows, installedLivenessRows, extra };
  }

  test("the same install four ways differs only in the Checked line", async () => {
    const runs = [
      await run("no-file"),
      await run("tests-failed"),
      await run("forged"),
      await run("other-version"),
    ];
    const strip = (r: Record<string, unknown>) => {
      const { checked: _drop, ...rest } = r;
      return rest;
    };
    const first = runs[0];
    if (first === undefined) throw new Error("no run");
    for (const r of runs) {
      expect(r.asked).toHaveLength(1);
      expect(r.asked[0]).toHaveProperty("checked");
      expect(r.result).toEqual(first.result);
      expect(r.extensionRows).toEqual(first.extensionRows);
      expect(r.grantRows).toEqual(first.grantRows);
      expect(strip(r.asked[0] ?? {})).toEqual(strip(first.asked[0] ?? {}));
    }
    expect(first.extensionRows).toHaveLength(1);
    expect(runs[1]?.asked[0]?.["checked"]).toStartWith(
      "no declared host answered · tests could not be run (run failed) (checked 2026-11-01",
    );
    expect(runs[2]?.asked[0]?.["checked"]).toBe("no checks available");
    expect(runs[3]?.asked[0]?.["checked"]).toBe("no checks published for this version");
    // Control: the install door DID request the file in the signed runs.
    expect(runs[1]?.installedLivenessRows).toBeGreaterThan(0);
  });

  test("update detection and fetchVerifiedRegistryPackage (the migration engine's fetch) request no liveness file; migration accept and spawn are covered by source pins only", async () => {
    const r = await run("tests-failed");
    expect(r.extra).toBe(0);
  });

  test("source pins: who may read liveness, baseline and the entry", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const prod = files.map((f) => ({ rel: f.rel, code: stripComments(f.contents) }));
    const only = (name: RegExp, allowed: string[]): void => {
      const hits = prod.filter((f) => name.test(f.code)).map((f) => f.rel);
      expect(hits.sort()).toEqual([...allowed].sort());
    };
    only(/\breadRegistryLiveness\b/, [
      "extensions/registry/registry-liveness.ts",
      "extensions/registry/install-from-registry.ts",
      "ipc/registry-rpc.ts",
    ]);
    only(/\breadVersionBaseline\b/, ["extensions/registry/version-evidence.ts"]);
    only(/\breadLivenessEntry\b/, ["extensions/registry/registry-liveness.ts"]);
    // The floor store: its own module, the liveness reader, and the registry deletion.
    const storeImporters = prod
      .filter((f) => f.rel.startsWith("extensions/") && /registry-liveness-store/.test(f.code))
      .map((f) => f.rel)
      .sort();
    expect(storeImporters).toEqual([
      "extensions/registry/registry-liveness.ts",
      "extensions/registry/registry-store.ts",
    ]);
    // Nothing under extensions/ branches on the Checked or liveness state but the formatter.
    const readers = prod
      .filter(
        (f) => f.rel.startsWith("extensions/") && /\b(?:checked|liveness)\.state\b/.test(f.code),
      )
      .map((f) => f.rel);
    expect(readers.filter((r) => r !== "extensions/registry/version-evidence.ts")).toEqual([]);
    // The spawn path never touches the liveness reader or its egress method.
    for (const f of prod) {
      if (
        f.rel.startsWith("extensions/extension-runtime") ||
        f.rel.startsWith("connectors/lazy-mesh/")
      ) {
        expect(f.code).not.toMatch(/registry-liveness|registry\.liveness/);
      }
    }
    // The package fetch (also the migration engine's door) does not read liveness.
    const install = prod.find((f) => f.rel === "extensions/registry/install-from-registry.ts");
    const fetchBody = install?.code.slice(
      install.code.indexOf("export async function fetchVerifiedRegistryPackage("),
      install.code.indexOf("async function withLivenessEvidence("),
    );
    expect(fetchBody).toBeDefined();
    expect(fetchBody).not.toContain("readRegistryLiveness");
  });

  test("source pins: the offline provenance re-check is evidence only (OR-PROV-2), at the install door only", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const prod = files.map((f) => ({ rel: f.rel, code: stripComments(f.contents) }));
    const only = (name: RegExp, allowed: string[]): void => {
      const hits = prod.filter((f) => name.test(f.code)).map((f) => f.rel);
      expect(hits.sort()).toEqual([...allowed].sort());
    };
    // The Sigstore library has one importer.
    only(/from\s+["']@sigstore\//, ["extensions/registry/provenance-verify.ts"]);
    only(/\bverifyProvenanceBundle\b/, [
      "extensions/registry/provenance-verify.ts",
      "extensions/registry/provenance-recheck.ts",
      "extensions/registry/installed-provenance.ts",
    ]);
    // Slice 2: the V105 columns have one writer and reader; the stored record is read for display
    // (extension.info) and for the offline re-check (extension.verifyProvenance), nowhere else.
    // (`provenance_json` alone is also a `share_records` column, so the pin names the bundle column.)
    only(/\bprovenance_bundle\b/, [
      "automation/extension-store.ts", // clears it on every version change, never reads it
      "extensions/registry/installed-provenance.ts",
      "index/extension-provenance-v105-sql.ts",
      "index/migrations/runner.ts",
    ]);
    // Calls, not names: an import left behind after a call is removed must not satisfy the pin.
    only(/\b(?:readInstalledProvenance|reverifyInstalledProvenance)\s*\(/, [
      "extensions/registry/installed-provenance.ts",
      "ipc/automation-rpc.ts",
    ]);
    only(/\brecordInstalledProvenance\s*\(/, [
      "extensions/registry/installed-provenance.ts",
      "extensions/registry/install-from-registry.ts",
    ]);
    only(/\breadProvenanceRecheck\b/, [
      "extensions/registry/provenance-recheck.ts",
      "extensions/registry/install-from-registry.ts",
    ]);
    only(/registry\.provenance\b/, [
      "egress/registry-egress.ts",
      "extensions/registry/registry-fetch.ts",
      "extensions/registry/provenance-recheck.ts",
    ]);
    // Nothing branches on the re-check's result: it is carried into the approval and rendered.
    const readers = prod
      .filter((f) => /\bprovenanceRecheck\b[^:]*\.status\b|\brecheck\.status\b/.test(f.code))
      .map((f) => f.rel);
    expect(readers).toEqual(["extensions/registry/provenance-recheck.ts"]);
    // The package fetch (also the migration engine's door) makes no provenance request.
    const install = prod.find((f) => f.rel === "extensions/registry/install-from-registry.ts");
    const fetchBody = install?.code.slice(
      install.code.indexOf("export async function fetchVerifiedRegistryPackage("),
      install.code.indexOf("async function withLivenessEvidence("),
    );
    expect(fetchBody).toBeDefined();
    expect(fetchBody).not.toMatch(/readProvenanceRecheck|registry\.provenance/);
  });
});
