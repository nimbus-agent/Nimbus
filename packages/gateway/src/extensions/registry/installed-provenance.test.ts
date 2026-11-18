/**
 * Installed copies carry their provenance (slice 2) over a real database at the current schema and
 * the real cli/cli SLSA bundle (see provenance-verify.test.ts for the fixture and the runtime probe).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { updateExtensionRowVersion } from "../../automation/extension-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  type InstalledProvenanceRecord,
  readInstalledProvenance,
  recordInstalledProvenance,
  reverifyInstalledProvenance,
} from "./installed-provenance.ts";

const BUNDLE = readFileSync(
  join(import.meta.dir, "__fixtures__", "provenance", "cli-cli-2.105.0-slsa.json"),
  "utf8",
);
const ID = "com.example.tool";

function ecDefaultDigestWorks(): boolean {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const data = Buffer.from("probe");
  try {
    return verify(null, data, publicKey, sign("sha256", data, privateKey));
  } catch {
    return false;
  }
}
const CAPABLE = ecDefaultDigestWorks();

const RECORD: InstalledProvenanceRecord = {
  v: 1,
  version: "1.0.0",
  registry: "main",
  packageSha256: "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f",
  provenance: {
    sourceRepository: "cli/cli",
    commit: "e1219499a578b69e3437adaa31cd60614e23c802",
    workflow: ".github/workflows/deployment.yml@refs/heads/trunk",
    runner: "github-hosted",
    verifiedAt: "2026-11-18T00:30:00Z",
  },
  recheck: { status: "verified", instance: "public-good" },
  checkedAt: 1_800_000_000_000,
};
const BASE =
  "Provenance verified by main: built from cli/cli at e1219499a578 by .github/workflows/deployment.yml@refs/heads/trunk";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  db.run(
    `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
     VALUES (?, '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
    [ID],
  );
});

afterEach(() => {
  db.close();
});

describe("recordInstalledProvenance / readInstalledProvenance", () => {
  test("what the install showed is read back as the same sentence", () => {
    recordInstalledProvenance(db, ID, RECORD, BUNDLE);
    expect(readInstalledProvenance(db, ID, "1.0.0")).toEqual({
      note: `${BASE}; re-verified offline against the Sigstore roots in this Nimbus release`,
      recheck: { status: "verified", instance: "public-good" },
      checkedAt: RECORD.checkedAt,
      bundleStored: true,
    });
  });

  test("a record for another version (an update replaced the code) is none", () => {
    recordInstalledProvenance(db, ID, RECORD, BUNDLE);
    expect(readInstalledProvenance(db, ID, "1.1.0")).toBeUndefined();
    expect(reverifyInstalledProvenance(db, ID, "1.1.0")).toEqual({ status: "none" });
  });

  test("no record, an unknown id and an off-shape record are none", () => {
    expect(readInstalledProvenance(db, ID, "1.0.0")).toBeUndefined();
    expect(readInstalledProvenance(db, "com.other", "1.0.0")).toBeUndefined();
    for (const bad of [
      "not json",
      JSON.stringify({ ...RECORD, v: 2 }),
      JSON.stringify({ ...RECORD, packageSha256: "short" }),
      JSON.stringify({ ...RECORD, recheck: { status: "verified", instance: "elsewhere" } }),
      JSON.stringify({ ...RECORD, recheck: { status: "unverified", reason: "made_up" } }),
      JSON.stringify({ ...RECORD, provenance: { ...RECORD.provenance, runner: "laptop" } }),
    ]) {
      db.run("UPDATE extension SET provenance_json = ? WHERE id = ?", [bad, ID]);
      expect(readInstalledProvenance(db, ID, "1.0.0")).toBeUndefined();
    }
  });

  test("a record with no re-check reads as the registry's sentence alone; no bundle is stored as such", () => {
    const { recheck: _r, ...noRecheck } = RECORD;
    recordInstalledProvenance(db, ID, noRecheck, null);
    expect(readInstalledProvenance(db, ID, "1.0.0")).toEqual({
      note: BASE,
      checkedAt: RECORD.checkedAt,
      bundleStored: false,
    });
  });

  test("an oversized bundle is not stored; the record still is", () => {
    recordInstalledProvenance(db, ID, RECORD, "x".repeat(64 * 1024 + 1));
    expect(readInstalledProvenance(db, ID, "1.0.0")?.bundleStored).toBe(false);
  });

  test("a version change (update or downgrade) drops the record and the bundle", () => {
    recordInstalledProvenance(db, ID, RECORD, BUNDLE);
    updateExtensionRowVersion(db, ID, "1.1.0", "m2", "e2", 2);
    // Even a later move back to 1.0.0 cannot resurrect it: the row holds nothing.
    updateExtensionRowVersion(db, ID, "1.0.0", "m", "e", 3);
    expect(readInstalledProvenance(db, ID, "1.0.0")).toBeUndefined();
    expect(db.query("SELECT provenance_json, provenance_bundle FROM extension").get()).toEqual({
      provenance_json: null,
      provenance_bundle: null,
    });
  });

  test("a database before V105 stores and reads nothing", () => {
    const old = new Database(":memory:");
    runIndexedSchemaMigrations(old, 104);
    recordInstalledProvenance(old, ID, RECORD, BUNDLE);
    expect(readInstalledProvenance(old, ID, "1.0.0")).toBeUndefined();
    expect(reverifyInstalledProvenance(old, ID, "1.0.0")).toEqual({ status: "none" });
    old.close();
  });
});

describe("reverifyInstalledProvenance", () => {
  test("re-checks the stored bundle offline", () => {
    recordInstalledProvenance(db, ID, RECORD, BUNDLE);
    const r = reverifyInstalledProvenance(db, ID, "1.0.0");
    expect(r.status).toBe(CAPABLE ? "verified" : "unverified");
    if (r.status === "verified" || r.status === "unverified") {
      expect(r.note.startsWith(`${BASE}; `)).toBe(true);
    }
  });

  test("a stored bundle that no longer names the recorded package is not re-verified", () => {
    recordInstalledProvenance(db, ID, { ...RECORD, packageSha256: "0".repeat(64) }, BUNDLE);
    const r = reverifyInstalledProvenance(db, ID, "1.0.0");
    expect(r).toMatchObject({
      status: "unverified",
      reason: CAPABLE ? "subject_mismatch" : "signature_unverified",
    });
  });

  test("no stored bundle: the sentence, and that it cannot be re-checked", () => {
    recordInstalledProvenance(db, ID, RECORD, null);
    expect(reverifyInstalledProvenance(db, ID, "1.0.0")).toEqual({
      status: "no_bundle",
      note: BASE,
    });
  });
});
