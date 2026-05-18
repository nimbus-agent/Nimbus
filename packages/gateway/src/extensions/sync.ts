/**
 * Sync orchestrator for publisher pubkeys. Walks installed extensions,
 * collects distinct publisher ids, refreshes each from the registry, and
 * reverifies installed manifests when a key rotates.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { listExtensions } from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { NimbusVault } from "../vault/index.ts";
import { parseExtensionManifestForRegistry, resolveExtensionManifestPath } from "./manifest.ts";
import { evictPublisherKey, readPublisherKey, writePublisherKey } from "./publisher-keys.ts";
import type { PublisherKeyFetcher } from "./registry-client.ts";
import { encodeBase64, verifyManifestSignature } from "./verify-signature.ts";

type SyncedKind = "unchanged" | "updated" | "evicted" | "failed";

function auditPublisherKeySynced(
  db: Database,
  dryRun: boolean,
  publisherId: string,
  kind: SyncedKind,
  reason?: string,
): void {
  // Spec §6.2: extension.publisher_key_synced — one audit row per publisher per
  // sync run. dryRun runs do NOT emit audit (per spec §4.3 "dry-run writes
  // nothing, audits nothing").
  if (dryRun) return;
  const payload: Record<string, unknown> = { id: publisherId, kind };
  if (reason !== undefined) payload["reason"] = reason;
  appendAuditEntry(db, {
    actionType: "extension.publisher_key_synced",
    hitlStatus: "not_required",
    actionJson: JSON.stringify(payload),
    timestamp: Date.now(),
  });
}

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

    const dryRun = opts.dryRun === true;
    for (const [publisherId, extIds] of publisherIdToExtensions) {
      result.publishersChecked++;
      const fetched = await opts.fetcher.fetch(publisherId);
      if (fetched.kind === "transient" || fetched.kind === "registry_error") {
        result.failures.push({ id: publisherId, reason: fetched.message });
        auditPublisherKeySynced(opts.db, dryRun, publisherId, "failed", fetched.message);
        continue;
      }
      if (fetched.kind === "not_found") {
        if (!dryRun) await evictPublisherKey(opts.vault, publisherId);
        result.publishersEvicted.push(publisherId);
        auditPublisherKeySynced(opts.db, dryRun, publisherId, "evicted");
        continue;
      }
      const cached = await readPublisherKey(opts.vault, publisherId);
      const equal = cached !== undefined && encodeBase64(cached) === encodeBase64(fetched.pubkey);
      if (equal) {
        result.publishersUnchanged++;
        auditPublisherKeySynced(opts.db, dryRun, publisherId, "unchanged");
        continue;
      }
      if (!dryRun) await writePublisherKey(opts.vault, publisherId, fetched.pubkey);
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
      auditPublisherKeySynced(opts.db, dryRun, publisherId, "updated");
    }

    return result;
  };

  const ticket = syncMutex.then(() => run());
  syncMutex = ticket.catch(() => undefined);
  return ticket;
}
