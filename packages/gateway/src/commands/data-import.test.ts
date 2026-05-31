import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memVault, newIndex } from "../../test/fixtures/data-test-helpers.ts";
import { _addTestKdfProfile } from "../db/data-vault-crypto.ts";
import { packBundle, unpackBundle } from "../db/tar-bundle.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runDataExport } from "./data-export.ts";
import { DataImportVersionError, runDataImport } from "./data-import.ts";

let _restoreTestKdf: () => void;
beforeAll(() => {
  _restoreTestKdf = _addTestKdfProfile({ t: 1, m: 1024, p: 1 });
});
afterAll(() => {
  _restoreTestKdf();
});

describe("data import", () => {
  const kdfParams = { t: 1, m: 1024, p: 1 } as const;

  test("round-trips vault credentials when passphrase matches", async () => {
    const sourceVault = memVault();
    await sourceVault.set("github.pat", "value_xyz");
    const idx = newIndex();
    const outPath = join(mkdtempSync(join(tmpdir(), "nimbus-import-")), "b.tar.gz");
    await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "pw",
      vault: sourceVault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kdfParams,
    });

    const targetVault = memVault();
    const result = await runDataImport({
      bundlePath: outPath,
      passphrase: "pw",
      vault: targetVault,
      index: newIndex(),
    });
    expect(result.credentialsRestored).toBe(1);
    expect(await targetVault.get("github.pat")).toBe("value_xyz");
  });

  test("rollback deletes vault entries written in step 4 when a later step fails", async () => {
    const sourceVault = memVault();
    await sourceVault.set("github.pat", "value_xyz");
    const idx = newIndex();
    const outPath = join(mkdtempSync(join(tmpdir(), "nimbus-import-rollback-")), "b.tar.gz");
    await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "pw",
      vault: sourceVault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kdfParams,
    });

    const targetVault = memVault();
    await expect(
      runDataImport({
        bundlePath: outPath,
        passphrase: "pw",
        vault: targetVault,
        index: newIndex(),
        injectFailureAfterVault: true,
      }),
    ).rejects.toThrow("injected failure");

    expect(await targetVault.get("github.pat")).toBeNull();
  });

  test("rejects bundle with tampered manifest hash", async () => {
    const sourceVault = memVault();
    await sourceVault.set("github.pat", "value_xyz");
    const idx = newIndex();
    const outDir = mkdtempSync(join(tmpdir(), "nimbus-import-tamper-"));
    const outPath = join(outDir, "b.tar.gz");
    await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "pw",
      vault: sourceVault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kdfParams,
    });

    const { unpackBundle, packBundle } = await import("../db/tar-bundle.ts");
    const { writeFileSync } = await import("node:fs");
    const stage = mkdtempSync(join(tmpdir(), "nimbus-import-tamper-stage-"));
    await unpackBundle(outPath, stage);
    writeFileSync(join(stage, "watchers.json"), '[{"tampered":true}]');
    const tamperedPath = join(outDir, "tampered.tar.gz");
    await packBundle(stage, tamperedPath);

    await expect(
      runDataImport({
        bundlePath: tamperedPath,
        passphrase: "pw",
        vault: memVault(),
        index: newIndex(),
      }),
    ).rejects.toThrow(/integrity check failed/);
  });
});

async function stageBundle(schemaVersion: number): Promise<string> {
  const sourceVault = memVault();
  await sourceVault.set("github.pat", "secret_value");
  const outPath = join(mkdtempSync(join(tmpdir(), `nimbus-sv${schemaVersion}-`)), "b.tar.gz");
  await runDataExport({
    output: outPath,
    includeIndex: false,
    passphrase: "pw",
    vault: sourceVault,
    index: newIndex(),
    platform: "linux",
    nimbusVersion: "0.1.0",
    schemaVersion,
    kdfParams: { t: 1, m: 1024, p: 1 } as const,
  });
  return outPath;
}

describe("runDataImport — schemaVersion compatibility check", () => {
  test("rejects a bundle with schema_version > current as archive_newer", async () => {
    const bundle = await stageBundle(99);
    const err = await runDataImport({
      bundlePath: bundle,
      passphrase: "pw",
      vault: memVault(),
      index: newIndex(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DataImportVersionError);
    expect((err as DataImportVersionError).archiveSchemaVersion).toBe(99);
    expect((err as DataImportVersionError).relation).toBe("archive_newer");
  });

  test("rejects a bundle with schema_version < current as archive_older_unsupported", async () => {
    const bundle = await stageBundle(10);
    const err = await runDataImport({
      bundlePath: bundle,
      passphrase: "pw",
      vault: memVault(),
      index: newIndex(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DataImportVersionError);
    expect((err as DataImportVersionError).archiveSchemaVersion).toBe(10);
    expect((err as DataImportVersionError).relation).toBe("archive_older_unsupported");
  });

  test("rejects a legacy v1 manifest as archive_older_unsupported (archiveSchemaVersion=0)", async () => {
    const bundle = await stageBundle(CURRENT_SCHEMA_VERSION);
    const stage = mkdtempSync(join(tmpdir(), "nimbus-legacy-stage-"));
    await unpackBundle(bundle, stage);
    const manifestPath = join(stage, "manifest.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const legacy = { ...parsed, version: 1 };
    delete (legacy as Record<string, unknown>)["schema_version"];
    writeFileSync(manifestPath, JSON.stringify(legacy, null, 2));
    const legacyBundle = join(stage, "legacy.tar.gz");
    await packBundle(stage, legacyBundle);

    const err = await runDataImport({
      bundlePath: legacyBundle,
      passphrase: "pw",
      vault: memVault(),
      index: newIndex(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DataImportVersionError);
    expect((err as DataImportVersionError).archiveSchemaVersion).toBe(0);
    expect((err as DataImportVersionError).relation).toBe("archive_older_unsupported");
  });

  test("no vault writes occur when schema_version is incompatible", async () => {
    const bundle = await stageBundle(99);
    const targetVault = memVault();
    await runDataImport({
      bundlePath: bundle,
      passphrase: "pw",
      vault: targetVault,
      index: newIndex(),
    }).catch(() => {});
    expect(await targetVault.get("github.pat")).toBeNull();
  });

  test("happy path — matching schema_version restores credentials", async () => {
    const bundle = await stageBundle(CURRENT_SCHEMA_VERSION);
    const targetVault = memVault();
    const result = await runDataImport({
      bundlePath: bundle,
      passphrase: "pw",
      vault: targetVault,
      index: newIndex(),
    });
    expect(result.credentialsRestored).toBe(1);
    expect(await targetVault.get("github.pat")).toBe("secret_value");
  });
});
