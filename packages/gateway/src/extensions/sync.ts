/**
 * Sync orchestrator for publisher pubkeys. Walks installed extensions,
 * collects distinct publisher ids, refreshes each from the registry, and
 * reverifies installed manifests when a key rotates.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { listExtensions } from "../automation/extension-store.ts";
import type { NimbusVault } from "../vault/index.ts";
import { parseExtensionManifestForRegistry, resolveExtensionManifestPath } from "./manifest.ts";
import { evictPublisherKey, readPublisherKey, writePublisherKey } from "./publisher-keys.ts";
import type { PublisherKeyFetcher } from "./registry-client.ts";
import { encodeBase64, verifyManifestSignature } from "./verify-signature.ts";

export class AirGapEnforcementError extends Error {
  override readonly name = "AirGapEnforcementError";
  constructor() {
    super("air-gap is enforced; nimbus extension sync refused");
  }
}

export type SyncUpdated = {
  id: string;
  reverifyResult: "ok" | "failed";
  failedExtensions: string[];
};

export type SyncFailure = { id: string; reason: string };

export type SyncResult = {
  publishersChecked: number;
  publishersUnchanged: number;
  publishersUpdated: SyncUpdated[];
  publishersEvicted: string[];
  failures: SyncFailure[];
};

let syncMutex: Promise<unknown> = Promise.resolve();

export async function syncPublisherKeys(opts: {
  vault: NimbusVault;
  db: Database;
  fetcher: PublisherKeyFetcher;
  enforceAirGap: boolean;
  dryRun?: boolean;
}): Promise<SyncResult> {
  const run = async (): Promise<SyncResult> => {
    if (opts.enforceAirGap) throw new AirGapEnforcementError();
    const rows = listExtensions(opts.db);
    const publisherIdToExtensions = new Map<string, string[]>();
    const manifestByExtId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const mp = resolveExtensionManifestPath(row.install_path);
      if (mp === undefined) continue;
      let parsed;
      try {
        parsed = parseExtensionManifestForRegistry(readFileSync(mp, "utf8"));
      } catch {
        continue;
      }
      const m = parsed.manifest;
      if (m.publisher === undefined) continue;
      manifestByExtId.set(row.id, m as unknown as Record<string, unknown>);
      const arr = publisherIdToExtensions.get(m.publisher.id) ?? [];
      arr.push(row.id);
      publisherIdToExtensions.set(m.publisher.id, arr);
    }

    const result: SyncResult = {
      publishersChecked: 0,
      publishersUnchanged: 0,
      publishersUpdated: [],
      publishersEvicted: [],
      failures: [],
    };

    for (const [publisherId, extIds] of publisherIdToExtensions) {
      result.publishersChecked++;
      const fetched = await opts.fetcher.fetch(publisherId);
      if (fetched.kind === "transient" || fetched.kind === "registry_error") {
        result.failures.push({ id: publisherId, reason: fetched.message });
        continue;
      }
      if (fetched.kind === "not_found") {
        if (opts.dryRun !== true) await evictPublisherKey(opts.vault, publisherId);
        result.publishersEvicted.push(publisherId);
        continue;
      }
      const cached = await readPublisherKey(opts.vault, publisherId);
      const equal = cached !== undefined && encodeBase64(cached) === encodeBase64(fetched.pubkey);
      if (equal) {
        result.publishersUnchanged++;
        continue;
      }
      if (opts.dryRun !== true) await writePublisherKey(opts.vault, publisherId, fetched.pubkey);
      const failed: string[] = [];
      let allOk = true;
      for (const extId of extIds) {
        const m = manifestByExtId.get(extId);
        if (m === undefined) continue;
        try {
          await verifyManifestSignature(
            m as { publisher?: { id: string; key: string }; signature?: string },
            fetched.pubkey,
          );
        } catch {
          failed.push(extId);
          allOk = false;
        }
      }
      result.publishersUpdated.push({
        id: publisherId,
        reverifyResult: allOk ? "ok" : "failed",
        failedExtensions: failed,
      });
    }

    return result;
  };

  const ticket = syncMutex.then(() => run());
  syncMutex = ticket.catch(() => undefined);
  return ticket;
}
