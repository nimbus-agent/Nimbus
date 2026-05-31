import { readFile } from "node:fs/promises";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type BackupManifest = {
  version: 2;
  nimbus_version: string;
  schema_version: number;
  created_at: string;
  platform: "win32" | "darwin" | "linux";
  contents: {
    index_rows: number;
    index_included: boolean;
    vault_entries: number;
    watchers: number;
    workflows: number;
    extensions: number;
    profiles: number;
  };
  hashes: Record<string, string>;
};

export type LegacyBackupManifestV1 = Omit<BackupManifest, "version" | "schema_version"> & {
  version: 1;
};

export async function blake3HashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return bytesToHex(blake3(new Uint8Array(buf)));
}

export async function buildManifest(input: {
  bundleDir: string;
  nimbusVersion: string;
  schemaVersion: number;
  platform: "win32" | "darwin" | "linux";
  contents: Omit<BackupManifest["contents"], "index_included">;
  files: Record<string, string>;
  indexIncluded: boolean;
}): Promise<BackupManifest> {
  const hashes: Record<string, string> = {};
  for (const [name, absPath] of Object.entries(input.files)) {
    hashes[name] = await blake3HashFile(absPath);
  }
  return {
    version: 2,
    nimbus_version: input.nimbusVersion,
    schema_version: input.schemaVersion,
    created_at: new Date().toISOString(),
    platform: input.platform,
    contents: { ...input.contents, index_included: input.indexIncluded },
    hashes,
  };
}

export type ManifestVerifyResult = { ok: boolean; firstMismatch?: string };

export async function verifyManifest(
  manifest: BackupManifest | LegacyBackupManifestV1,
  files: Record<string, string>,
): Promise<ManifestVerifyResult> {
  for (const [name, expected] of Object.entries(manifest.hashes)) {
    const actualPath = files[name];
    if (actualPath === undefined) return { ok: false, firstMismatch: name };
    const actual = await blake3HashFile(actualPath);
    if (actual !== expected) return { ok: false, firstMismatch: name };
  }
  return { ok: true };
}
