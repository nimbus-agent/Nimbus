import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDataExport } from "../../../src/commands/data-export.ts";
import { runDataImport } from "../../../src/commands/data-import.ts";
import { verifyAuditChain } from "../../../src/db/audit-verify.ts";
import { _addTestKdfProfile } from "../../../src/db/data-vault-crypto.ts";
import type { LocalIndex } from "../../../src/index/local-index.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { memVault, newIndex } from "../../fixtures/data-test-helpers.ts";

let _restoreTestKdf: () => void;
beforeAll(() => {
  _restoreTestKdf = _addTestKdfProfile({ t: 1, m: 1024, p: 1 });
});
afterAll(() => {
  _restoreTestKdf();
});

function seed(idx: LocalIndex, service: string, count: number): void {
  for (let i = 0; i < count; i++) {
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?, ?, 'test', ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, 0)`,
      [
        `${service}-${String(i)}`,
        service,
        `ext-${String(i)}`,
        `t-${String(i)}`,
        Date.now(),
        Date.now(),
      ],
    );
  }
  idx.recordAudit({
    actionType: "connector.sync",
    hitlStatus: "approved",
    actionJson: JSON.stringify({ service }),
    timestamp: Date.now(),
  });
}

describe("data sovereignty round-trip", () => {
  test("export → wipe → import restores credentials and audit chain integrity", async () => {
    const sourceVault = memVault();
    await sourceVault.set("github.pat", "pat_source_val");
    const sourceIdx = newIndex();
    seed(sourceIdx, "github", 3);
    seed(sourceIdx, "slack", 2);

    const out = join(mkdtempSync(join(tmpdir(), "nimbus-rt-")), "b.tar.gz");
    let platform: "win32" | "darwin" | "linux";
    if (process.platform === "win32") platform = "win32";
    else if (process.platform === "darwin") platform = "darwin";
    else platform = "linux";
    const expResult = await runDataExport({
      output: out,
      includeIndex: false,
      passphrase: "pw",
      vault: sourceVault,
      index: sourceIdx,
      platform,
      nimbusVersion: "0.1.0",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });
    expect(expResult.recoverySeedGenerated).toBe(true);

    const targetVault = memVault();
    const targetIdx = newIndex();
    const impResult = await runDataImport({
      bundlePath: out,
      passphrase: "pw",
      vault: targetVault,
      index: targetIdx,
    });
    expect(impResult.credentialsRestored).toBe(1);
    expect(await targetVault.get("github.pat")).toBe("pat_source_val");

    const verify = verifyAuditChain(targetIdx, { fromId: 0 });
    expect(verify.ok).toBe(true);
  });

  test("seed-based decrypt works with the 24-word mnemonic", async () => {
    const sourceVault = memVault();
    await sourceVault.set("github.pat", "pat_val");
    const sourceIdx = newIndex();

    const out = join(mkdtempSync(join(tmpdir(), "nimbus-rt-seed-")), "b.tar.gz");
    const exp = await runDataExport({
      output: out,
      includeIndex: false,
      passphrase: "original-pw",
      vault: sourceVault,
      index: sourceIdx,
      platform: "linux",
      nimbusVersion: "0.1.0",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kdfParams: { t: 1, m: 1024, p: 1 },
    });

    const targetVault = memVault();
    const result = await runDataImport({
      bundlePath: out,
      recoverySeed: exp.recoverySeed,
      vault: targetVault,
      index: newIndex(),
    });
    expect(result.credentialsRestored).toBe(1);
    expect(await targetVault.get("github.pat")).toBe("pat_val");
  });
});
