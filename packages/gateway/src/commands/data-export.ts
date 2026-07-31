import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "../db/backup-manifest.ts";
import { encryptVaultManifest, type KdfParams } from "../db/data-vault-crypto.ts";
import { ensureRecoverySeed } from "../db/recovery-seed.ts";
import { packBundle } from "../db/tar-bundle.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export type RunDataExportInput = {
  output: string;
  includeIndex: boolean;
  passphrase: string;
  vault: NimbusVault;
  index: LocalIndex;
  platform: "win32" | "darwin" | "linux";
  nimbusVersion: string;
  schemaVersion: number;
  kdfParams?: KdfParams;
};

export type RunDataExportResult = {
  outputPath: string;
  recoverySeed: string;
  recoverySeedGenerated: boolean;
  itemsExported: number;
};

async function collectVaultManifestPlaintext(vault: NimbusVault): Promise<string> {
  const keys = await vault.listKeys();
  const entries: Array<{ key: string; value: string }> = [];
  for (const key of keys) {
    if (key === "backup.recovery_seed") continue;
    const value = await vault.get(key);
    if (value !== null) entries.push({ key, value });
  }
  return JSON.stringify(entries);
}

export async function runDataExport(input: RunDataExportInput): Promise<RunDataExportResult> {
  const seed = await ensureRecoverySeed(input.vault);
  const stage = mkdtempSync(join(tmpdir(), "nimbus-export-stage-"));

  // The staging tree holds a second copy of everything being exported: the audit chain in
  // plaintext, the encrypted vault manifest, and the watcher/workflow/extension/profile
  // files. Once packBundle has written the archive it serves no further purpose, but it
  // lives in the OS temp directory, so leaving it behind means every export silently
  // accumulates another copy of the user's exported data with no expiry.
  //
  // Removed in `finally` rather than after packBundle: a failure part-way through is
  // exactly when a half-written copy of vault and audit data should not be the thing left
  // on disk.
  try {
    const vaultPlaintext = await collectVaultManifestPlaintext(input.vault);
    const encrypted = await encryptVaultManifest({
      plaintext: vaultPlaintext,
      passphrase: input.passphrase,
      seed: seed.mnemonic,
      ...(input.kdfParams === undefined ? {} : { kdfParams: input.kdfParams }),
    });
    const vaultPath = join(stage, "vault-manifest.json.enc");
    writeFileSync(vaultPath, JSON.stringify(encrypted));

    const watchersPath = join(stage, "watchers.json");
    writeFileSync(watchersPath, "[]");
    const workflowsPath = join(stage, "workflows.json");
    writeFileSync(workflowsPath, "[]");
    const extensionsPath = join(stage, "extensions.json");
    writeFileSync(extensionsPath, "[]");
    const profilesPath = join(stage, "profiles.json");
    writeFileSync(profilesPath, "[]");
    const auditPath = join(stage, "audit-chain.json");
    writeFileSync(auditPath, JSON.stringify(input.index.listAuditWithChain(10_000)));

    const files: Record<string, string> = {
      "vault-manifest.json.enc": vaultPath,
      "watchers.json": watchersPath,
      "workflows.json": workflowsPath,
      "extensions.json": extensionsPath,
      "profiles.json": profilesPath,
      "audit-chain.json": auditPath,
    };

    const parsedVault = JSON.parse(vaultPlaintext) as Array<unknown>;
    const manifest = await buildManifest({
      bundleDir: stage,
      nimbusVersion: input.nimbusVersion,
      schemaVersion: input.schemaVersion,
      platform: input.platform,
      contents: {
        index_rows: 0,
        vault_entries: parsedVault.length,
        watchers: 0,
        workflows: 0,
        extensions: 0,
        profiles: 0,
      },
      files,
      indexIncluded: input.includeIndex,
    });
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));

    mkdirSync(join(input.output, ".."), { recursive: true });
    await packBundle(stage, input.output);

    return {
      outputPath: input.output,
      recoverySeed: seed.generated ? seed.mnemonic : "",
      recoverySeedGenerated: seed.generated,
      itemsExported: parsedVault.length,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
