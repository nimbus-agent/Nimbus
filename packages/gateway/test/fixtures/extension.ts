import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertExtensionRow } from "../../src/automation/extension-store.ts";
import { encodeBase64, signManifest } from "../../src/extensions/verify-signature.ts";
import { CURRENT_SCHEMA_VERSION } from "../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../src/index/migrations/runner.ts";

const __nimbusTestDirs: string[] = [];
function __cleanupNimbusTestDirs() {
  for (const d of __nimbusTestDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
afterEach(() => {
  __cleanupNimbusTestDirs();
});

function sha256HexOfBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function setupFreshExtensionDb(): { db: Database; extensionsDir: string } {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const extensionsDir = mkdtempSync(join(tmpdir(), "nimbus-ext-test-"));
  __nimbusTestDirs.push(extensionsDir);
  return { db, extensionsDir };
}

export async function stageSignedExtensionOnDisk(opts: {
  db: Database;
  extensionsDir: string;
  publisherId: string;
  pubkey: Uint8Array;
  privkey?: Uint8Array;
  extensionId?: string;
  version?: string;
}): Promise<string> {
  const id = opts.extensionId ?? `ext-${opts.publisherId}`;
  const version = opts.version ?? "1.0.0";
  const dir = join(opts.extensionsDir, id);
  mkdirSync(join(dir, "dist"), { recursive: true });
  const baseManifest = {
    id,
    version,
    permissions: {},
    publisher: { id: opts.publisherId, key: encodeBase64(opts.pubkey) },
  };
  let signature: string;
  if (opts.privkey === undefined) {
    signature = `${"A".repeat(86)}==`;
  } else {
    signature = await signManifest(baseManifest, opts.privkey);
  }
  const manifest = { ...baseManifest, signature };
  const manifestPath = join(dir, "nimbus.extension.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  writeFileSync(manifestPath, manifestBytes);
  const entryPath = join(dir, "dist", "index.js");
  const entryText = "export default {};";
  writeFileSync(entryPath, entryText);
  const entryBytes = Buffer.from(entryText, "utf8");
  insertExtensionRow(opts.db, {
    id,
    version,
    install_path: dir,
    manifest_hash: sha256HexOfBytes(manifestBytes),
    entry_hash: sha256HexOfBytes(entryBytes),
    enabled: 1,
    installed_at: Date.now(),
    last_verified_at: Date.now(),
  });
  return dir;
}
