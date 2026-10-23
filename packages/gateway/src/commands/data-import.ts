import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackupManifest,
  type LegacyBackupManifestV1,
  verifyManifest,
} from "../db/backup-manifest.ts";
import { decryptVaultManifest, type VaultManifestBlob } from "../db/data-vault-crypto.ts";
import { unpackBundle } from "../db/tar-bundle.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { isWellFormedVaultKey } from "../vault/key-format.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export class DataImportVersionError extends Error {
  readonly archiveSchemaVersion: number;
  readonly currentSchemaVersion: number;
  readonly relation: "archive_newer" | "archive_older_unsupported";
  constructor(
    archiveSchemaVersion: number,
    currentSchemaVersion: number,
    relation: "archive_newer" | "archive_older_unsupported",
  ) {
    super(
      `Data archive is from an incompatible Nimbus schema version ` +
        `(archive=${archiveSchemaVersion}, current=${currentSchemaVersion}, ${relation})`,
    );
    this.name = "DataImportVersionError";
    this.archiveSchemaVersion = archiveSchemaVersion;
    this.currentSchemaVersion = currentSchemaVersion;
    this.relation = relation;
  }
}

function checkSchemaVersion(manifest: BackupManifest | LegacyBackupManifestV1): void {
  const current = CURRENT_SCHEMA_VERSION;
  const archive =
    manifest.version === 2 && typeof manifest.schema_version === "number"
      ? manifest.schema_version
      : 0;
  if (archive === current) return;
  const relation: "archive_newer" | "archive_older_unsupported" =
    archive > current ? "archive_newer" : "archive_older_unsupported";
  throw new DataImportVersionError(archive, current, relation);
}

export type RunDataImportInput = {
  bundlePath: string;
  passphrase?: string;
  recoverySeed?: string;
  vault: NimbusVault;
  index: LocalIndex;
  injectFailureAfterVault?: boolean;
};

export type RunDataImportResult = {
  credentialsRestored: number;
  oauthEntriesFlagged: number;
};

type VaultEntry = { key: string; value: string };

/**
 * Validate the decrypted vault manifest COMPLETELY before any entry is written.
 *
 * Decryption proves the archive was made with this passphrase, not that its contents have the
 * expected shape. This used to be `JSON.parse(...) as VaultEntry[]`, so a malformed entry was only
 * discovered by the vault mid-restore (after earlier keys were already written), and a non-string
 * value reached `vault.set` unchecked. Errors name the entry index, never the key or value.
 */
export function parseVaultEntries(plaintext: string): VaultEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new Error("vault manifest is not valid JSON");
  }
  if (!Array.isArray(raw)) throw new Error("vault manifest is not a list of entries");
  const seen = new Set<string>();
  return raw.map((entry: unknown, i): VaultEntry => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`vault manifest entry ${String(i)} is not an object`);
    }
    const { key, value } = entry as Record<string, unknown>;
    if (typeof key !== "string" || typeof value !== "string") {
      throw new Error(`vault manifest entry ${String(i)} needs a string key and value`);
    }
    if (!isWellFormedVaultKey(key)) {
      throw new Error(`vault manifest entry ${String(i)} has a malformed vault key`);
    }
    if (seen.has(key)) throw new Error(`vault manifest entry ${String(i)} repeats an earlier key`);
    seen.add(key);
    return { key, value };
  });
}

export async function runDataImport(input: RunDataImportInput): Promise<RunDataImportResult> {
  const stage = mkdtempSync(join(tmpdir(), "nimbus-import-stage-"));
  try {
    return await importFromStage(input, stage);
  } finally {
    // The unpacked bundle (index payload included) must not outlive the import.
    rmSync(stage, { recursive: true, force: true });
  }
}

async function importFromStage(
  input: RunDataImportInput,
  stage: string,
): Promise<RunDataImportResult> {
  await unpackBundle(input.bundlePath, stage);

  const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as
    | BackupManifest
    | LegacyBackupManifestV1;
  const files: Record<string, string> = Object.fromEntries(
    Object.keys(manifest.hashes).map((name) => [name, join(stage, name)]),
  );
  const verify = await verifyManifest(manifest, files);
  if (!verify.ok) {
    throw new Error(`bundle integrity check failed at ${verify.firstMismatch ?? "unknown"}`);
  }

  checkSchemaVersion(manifest);

  const encrypted = JSON.parse(
    readFileSync(join(stage, "vault-manifest.json.enc"), "utf8"),
  ) as VaultManifestBlob;
  const plaintext = decryptVaultManifest(encrypted, {
    ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase }),
    ...(input.recoverySeed === undefined ? {} : { seed: input.recoverySeed }),
  });
  const entries = parseVaultEntries(plaintext);

  const writtenKeys: string[] = [];
  let oauthFlagged = 0;
  try {
    for (const e of entries) {
      await input.vault.set(e.key, e.value); // NOSONAR S9382: fail-fast restore - writtenKeys must hold exactly the keys written before a failure, for the rollback below
      writtenKeys.push(e.key);
      // audit-ignore-next-line D11-vault-key (shape-check on already-restored entry, not vault-key construction)
      if (e.key.endsWith(".oauth") || e.key.includes(".oauth.")) oauthFlagged += 1;
    }
    if (input.injectFailureAfterVault === true) {
      throw new Error("injected failure");
    }
    // Index/watcher/workflow/extension/profile payloads are restored in future integration work.
  } catch (err) {
    for (const key of writtenKeys) {
      await input.vault.delete(key).catch(() => {}); // NOSONAR S9382: the macOS vault's delete rewrites one shared key-index file (read-modify-write); concurrent deletes would lose index updates
    }
    throw err;
  }

  return { credentialsRestored: writtenKeys.length, oauthEntriesFlagged: oauthFlagged };
}
