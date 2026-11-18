/**
 * `extension.info`'s `installedProvenance` and `extension.verifyProvenance` (offline provenance
 * re-verification, slice 2) over a real database at the current schema. The stored record and bundle
 * are written through the store's own writer, as a registry install would.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordInstalledProvenance } from "../extensions/registry/installed-provenance.ts";
import { LocalIndex } from "../index/local-index.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "./automation-rpc.ts";

const ID = "com.example.tool";
const BUNDLE = readFileSync(
  join(
    import.meta.dir,
    "..",
    "extensions",
    "registry",
    "__fixtures__",
    "provenance",
    "cli-cli-2.105.0-slsa.json",
  ),
  "utf8",
);

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run(
    `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
     VALUES (?, '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
    [ID],
  );
});

afterEach(() => {
  db.close();
});

const record = () => ({
  v: 1 as const,
  version: "1.0.0",
  registry: "main",
  packageSha256: "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f",
  provenance: {
    sourceRepository: "cli/cli",
    commit: "e1219499a578b69e3437adaa31cd60614e23c802",
    workflow: ".github/workflows/deployment.yml@refs/heads/trunk",
    runner: "github-hosted" as const,
    verifiedAt: "2026-11-18T00:30:00Z",
  },
  recheck: { status: "unverified" as const, reason: "bundle_unavailable" as const },
  checkedAt: 5,
});

async function call(method: string, params: unknown): Promise<Record<string, unknown>> {
  const out = await dispatchAutomationRpc({ method, params, db });
  if (out.kind !== "hit") throw new Error("not a hit");
  return out.value as Record<string, unknown>;
}

describe("extension.verifyProvenance", () => {
  test("re-checks the stored bundle; none when nothing was recorded", async () => {
    expect(await call("extension.verifyProvenance", { id: ID })).toEqual({
      id: ID,
      version: "1.0.0",
      status: "none",
    });
    recordInstalledProvenance(db, ID, record(), BUNDLE);
    const r = await call("extension.verifyProvenance", { id: ID });
    expect(["verified", "unverified"]).toContain(r["status"] as string);
    expect(typeof r["note"]).toBe("string");
  });

  test("refuses an unknown or missing id", async () => {
    const e = await dispatchAutomationRpc({
      method: "extension.verifyProvenance",
      params: { id: "com.example.nope" },
      db,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(AutomationRpcError);
    expect((e as AutomationRpcError).message).toBe("Extension not found");
  });

  test("writes nothing", async () => {
    recordInstalledProvenance(db, ID, record(), BUNDLE);
    const before = db.query("SELECT provenance_json, provenance_bundle FROM extension").get();
    await call("extension.verifyProvenance", { id: ID });
    expect(db.query("SELECT provenance_json, provenance_bundle FROM extension").get()).toEqual(
      before,
    );
  });
});

describe("extension.info", () => {
  test("carries installedProvenance only when a record exists for the installed version", async () => {
    const without = (await call("extension.info", { id: ID }))["extension"] as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(without, "installedProvenance")).toBe(false);
    recordInstalledProvenance(db, ID, record(), null);
    const withIt = (await call("extension.info", { id: ID }))["extension"] as Record<
      string,
      unknown
    >;
    expect(withIt["installedProvenance"]).toMatchObject({
      note: expect.stringContaining(
        "not re-verified offline: the attestation could not be fetched",
      ),
      bundleStored: false,
      checkedAt: 5,
    });
  });
});
