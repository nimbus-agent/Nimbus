/**
 * Backfills `extension.publisher_key_fingerprint` (V76) for rows installed before the column
 * existed. Migrations cannot read the Vault (they are synchronous; the Vault is not), so this runs
 * as an async pass at boot, before the extension spawn gate opens. Until rotation lands the Vault
 * holds one key per publisher, and that key is the one every installed copy of that publisher was
 * verified with, so its fingerprint is the row's.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import {
  listExtensions,
  setExtensionPublisherKeyFingerprint,
} from "../../automation/extension-store.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import type { NimbusVault } from "../../vault/index.ts";
import { parseExtensionManifestForRegistry, resolveExtensionManifestPath } from "../manifest.ts";
import { readPublisherKey } from "../publisher-keys.ts";

function publisherIdOf(installPath: string): string | undefined {
  const path = resolveExtensionManifestPath(installPath);
  if (path === undefined) return undefined;
  return parseExtensionManifestForRegistry(readFileSync(path, "utf8")).manifest.publisher?.id;
}

/**
 * Rows with a publisher and a NULL fingerprint get the fingerprint of the Vault key for that
 * publisher. Returns how many rows it set. Never throws for one row: an unreadable manifest or a
 * Vault error leaves that row NULL.
 */
export async function backfillPublisherKeyFingerprints(
  db: Database,
  vault: NimbusVault,
): Promise<number> {
  if (readIndexedUserVersion(db) < 76) return 0;
  let set = 0;
  for (const row of listExtensions(db)) {
    if (row.publisher_key_fingerprint != null) continue;
    try {
      const publisherId = publisherIdOf(row.install_path);
      if (publisherId === undefined) continue;
      // Sequential: the Vault backends are not safe for unbounded concurrent reads on every OS.
      const key = await readPublisherKey(vault, publisherId); // NOSONAR S9382: one Vault read at a time
      if (key === undefined) continue;
      const fp = publisherKeyFingerprint(Buffer.from(key).toString("base64"));
      if (setExtensionPublisherKeyFingerprint(db, row.id, fp)) set++;
    } catch {
      // Leave this row NULL; the next boot tries again.
    }
  }
  return set;
}
