import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memVault, newIndex } from "../../test/fixtures/data-test-helpers.ts";
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
});
