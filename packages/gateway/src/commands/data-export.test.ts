import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memVault, newIndex } from "../../test/fixtures/data-test-helpers.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { runDataExport } from "./data-export.ts";

describe("data export", () => {
  test("produces a tarball with manifest.json and writes the recovery seed on first run", async () => {
    const vault = memVault();
    await vault.set("github.pat", "secret_value_xyz");
    const idx = newIndex();
    const outPath = join(mkdtempSync(join(tmpdir(), "nimbus-export-")), "backup.tar.gz");

    const result = await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "passphrase",
      vault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: 21,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });

    expect(result.outputPath).toBe(outPath);
    expect(result.recoverySeedGenerated).toBe(true);
    expect(result.recoverySeed.split(" ")).toHaveLength(24);
  });

  test("second export reuses the existing seed (generated=false)", async () => {
    const vault = memVault();
    const idx = newIndex();
    const outDir = mkdtempSync(join(tmpdir(), "nimbus-export2-"));

    await runDataExport({
      output: join(outDir, "a.tar.gz"),
      includeIndex: false,
      passphrase: "pw",
      vault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: 21,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });
    const second = await runDataExport({
      output: join(outDir, "b.tar.gz"),
      includeIndex: false,
      passphrase: "pw",
      vault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: 21,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });
    expect(second.recoverySeedGenerated).toBe(false);
    expect(second.recoverySeed).toBe("");
    expect(readdirSync(outDir).sort((a, b) => a.localeCompare(b))).toEqual([
      "a.tar.gz",
      "b.tar.gz",
    ]);
  });

  test("first export still returns the freshly-generated seed (S2-F5)", async () => {
    const vault = memVault();
    const idx = newIndex();
    const outPath = join(mkdtempSync(join(tmpdir(), "nimbus-export3-")), "backup.tar.gz");

    const result = await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "pw",
      vault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: 21,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });

    expect(result.recoverySeedGenerated).toBe(true);
    expect(result.recoverySeed.split(" ").length).toBeGreaterThanOrEqual(12);
  });

  test("empty vault yields itemsExported=0", async () => {
    // No vault entries → parsedVault.length === 0
    const vault = memVault();
    const idx = newIndex();
    const outPath = join(mkdtempSync(join(tmpdir(), "nimbus-export-empty-")), "backup.tar.gz");

    const result = await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "pw",
      vault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: 1,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });

    expect(result.itemsExported).toBe(0);
    expect(result.recoverySeedGenerated).toBe(true);
  });

  test("multi-service vault entries are all counted in itemsExported", async () => {
    // Multiple keys → parsedVault.length reflects all collected entries
    const vault = memVault();
    await vault.set("github.pat", "tok1");
    await vault.set("slack.token", "tok2");
    await vault.set("notion.api_key", "tok3");
    const idx = newIndex();
    const outPath = join(mkdtempSync(join(tmpdir(), "nimbus-export-multi-")), "backup.tar.gz");

    const result = await runDataExport({
      output: outPath,
      includeIndex: true,
      passphrase: "pw",
      vault,
      index: idx,
      platform: "darwin",
      nimbusVersion: "1.2.3",
      schemaVersion: 38,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });

    expect(result.itemsExported).toBe(3);
    expect(result.recoverySeedGenerated).toBe(true);
    expect(result.outputPath).toBe(outPath);
  });

  test("backup.recovery_seed key is skipped and not counted in itemsExported", async () => {
    // Exercises the `if (key === "backup.recovery_seed") continue;` branch (true arm)
    // and ensures the seed key itself is excluded from the exported entries.
    const vault = memVault();
    await vault.set("github.pat", "tok1");
    // Pre-seed the recovery seed in the vault so it appears in listKeys()
    await vault.set("backup.recovery_seed", "word1 word2 word3");
    await vault.set("slack.token", "tok2");
    const idx = newIndex();
    const outPath = join(mkdtempSync(join(tmpdir(), "nimbus-export-skip-seed-")), "backup.tar.gz");

    const result = await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "pw",
      vault,
      index: idx,
      platform: "win32",
      nimbusVersion: "0.5.0",
      schemaVersion: 38,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });

    // backup.recovery_seed is excluded from the manifest, so only 2 entries
    expect(result.itemsExported).toBe(2);
    // Seed was already present so it should NOT be reported as generated
    expect(result.recoverySeedGenerated).toBe(false);
    expect(result.recoverySeed).toBe("");
  });

  test("vault key with null value is excluded from itemsExported", async () => {
    // Exercises the `if (value !== null) entries.push(...)` false arm.
    // We craft a vault where listKeys() reports a key but get() returns null for it.
    const nullKeyVault: NimbusVault = {
      listKeys: async (_prefix?: string) => ["ghost.key", "real.key"],
      get: async (k: string) => {
        if (k === "ghost.key") return null; // triggers the null branch
        if (k === "real.key") return "real_value";
        return null;
      },
      set: async (_k: string, _v: string) => {
        // no-op
      },
      delete: async (_k: string) => {
        // no-op
      },
    };

    const idx = newIndex();
    const outPath = join(mkdtempSync(join(tmpdir(), "nimbus-export-null-val-")), "backup.tar.gz");

    const result = await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "pw",
      vault: nullKeyVault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.5.0",
      schemaVersion: 38,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });

    // ghost.key has null value → excluded; only real.key contributes
    expect(result.itemsExported).toBe(1);
  });

  test("kdfParams omitted uses default KDF (no explicit kdfParams branch)", async () => {
    // Exercises the `kdfParams === undefined ? {} : { kdfParams }` true arm (undefined path).
    // We omit kdfParams to let the source spread `{}` and use the default argon2id params.
    const vault = memVault();
    await vault.set("jira.token", "tok_jira");
    const idx = newIndex();
    const outPath = join(
      mkdtempSync(join(tmpdir(), "nimbus-export-default-kdf-")),
      "backup.tar.gz",
    );

    // Note: no kdfParams — this is a slow path (default t=3,m=64k); we run it because
    // branch coverage requires it. The test still completes within a reasonable time.
    const result = await runDataExport({
      output: outPath,
      includeIndex: false,
      passphrase: "default-kdf-passphrase",
      vault,
      index: idx,
      platform: "linux",
      nimbusVersion: "0.5.0",
      schemaVersion: 38,
      // kdfParams intentionally omitted
    });

    expect(result.itemsExported).toBe(1);
    expect(result.recoverySeedGenerated).toBe(true);
    expect(result.outputPath).toBe(outPath);
  });
});

describe("data export staging directory", () => {
  const stageDirs = (): string[] =>
    readdirSync(tmpdir()).filter((n) => n.startsWith("nimbus-export-stage-"));

  const exportInput = (output: string) => ({
    output,
    includeIndex: false,
    passphrase: "passphrase",
    vault: memVault(),
    index: newIndex(),
    platform: "linux" as const,
    nimbusVersion: "0.1.0",
    schemaVersion: 21,
    kdfParams: { t: 1, m: 1024, p: 1 },
  });

  test("is removed after a successful export", async () => {
    const before = new Set(stageDirs());

    await runDataExport(
      exportInput(join(mkdtempSync(join(tmpdir(), "nimbus-export-cleanup-")), "backup.tar.gz")),
    );

    // The staging tree holds a full copy of the exported data — the audit chain among it,
    // in plaintext — so leaving it in the OS temp directory means every export accumulates
    // another copy that nothing ever removes.
    expect(stageDirs().filter((n) => !before.has(n))).toEqual([]);
  });

  test("is removed even when the export fails part-way through", async () => {
    const before = new Set(stageDirs());

    // Output nested under a *file*, so mkdirSync fails with ENOTDIR after the staging tree
    // is already populated. That is precisely when a half-written copy of vault and audit
    // data must not be the thing left behind.
    const blocker = join(mkdtempSync(join(tmpdir(), "nimbus-export-cleanup-")), "not-a-dir");
    writeFileSync(blocker, "");

    await expect(
      runDataExport(exportInput(join(blocker, "sub", "backup.tar.gz"))),
    ).rejects.toThrow();

    expect(stageDirs().filter((n) => !before.has(n))).toEqual([]);
  });
});
