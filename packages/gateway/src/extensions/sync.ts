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

function gatherPublisherManifests(db: Database): {
  publisherIdToExtensions: Map<string, string[]>;
  manifestByExtId: Map<string, Record<string, unknown>>;
} {
  const publisherIdToExtensions = new Map<string, string[]>();
  const manifestByExtId = new Map<string, Record<string, unknown>>();
  for (const row of listExtensions(db)) {
    const mp = resolveExtensionManifestPath(row.install_path);
    if (mp === undefined) continue;
    let parsed: ReturnType<typeof parseExtensionManifestForRegistry>;
    try {
      parsed = parseExtensionManifestForRegistry(readFileSync(mp, "utf8"));
    } catch {
      continue;
    }
    const m = parsed.manifest;
    if (m.publisher === undefined) continue;
    manifestByExtId.set(row.id, m);
    const arr = publisherIdToExtensions.get(m.publisher.id) ?? [];
    arr.push(row.id);
    publisherIdToExtensions.set(m.publisher.id, arr);
  }
  return { publisherIdToExtensions, manifestByExtId };
}

async function reverifyPublisherExtensions(
  extIds: readonly string[],
  manifestByExtId: ReadonlyMap<string, Record<string, unknown>>,
  pubkey: Uint8Array,
): Promise<{ allOk: boolean; failed: string[] }> {
  const failed: string[] = [];
  let allOk = true;
  for (const extId of extIds) {
    const m = manifestByExtId.get(extId);
    if (m === undefined) continue;
    try {
      await verifyManifestSignature(m, pubkey);
    } catch {
      failed.push(extId);
      allOk = false;
    }
  }
  return { allOk, failed };
}

async function processPublisherKey(
  opts: { vault: NimbusVault; db: Database; fetcher: PublisherKeyFetcher; dryRun: boolean },
  result: SyncResult,
  publisherId: string,
  extIds: readonly string[],
  manifestByExtId: ReadonlyMap<string, Record<string, unknown>>,
): Promise<void> {
  result.publishersChecked++;
  const fetched = await opts.fetcher.fetch(publisherId);
  if (fetched.kind === "transient" || fetched.kind === "registry_error") {
    result.failures.push({ id: publisherId, reason: fetched.message });
    auditPublisherKeySynced(opts.db, opts.dryRun, publisherId, "failed", fetched.message);
    return;
  }
  if (fetched.kind === "not_found") {
    if (!opts.dryRun) await evictPublisherKey(opts.vault, publisherId);
    result.publishersEvicted.push(publisherId);
    auditPublisherKeySynced(opts.db, opts.dryRun, publisherId, "evicted");
    return;
  }
  const cached = await readPublisherKey(opts.vault, publisherId);
  const equal = cached !== undefined && encodeBase64(cached) === encodeBase64(fetched.pubkey);
  if (equal) {
    result.publishersUnchanged++;
    auditPublisherKeySynced(opts.db, opts.dryRun, publisherId, "unchanged");
    return;
  }
  if (!opts.dryRun) await writePublisherKey(opts.vault, publisherId, fetched.pubkey);
  const { allOk, failed } = await reverifyPublisherExtensions(
    extIds,
    manifestByExtId,
    fetched.pubkey,
  );
  result.publishersUpdated.push({
    id: publisherId,
    reverifyResult: allOk ? "ok" : "failed",
    failedExtensions: failed,
  });
  auditPublisherKeySynced(opts.db, opts.dryRun, publisherId, "updated");
}

export async function syncPublisherKeys(opts: {
  vault: NimbusVault;
  db: Database;
  fetcher: PublisherKeyFetcher;
  enforceAirGap: boolean;
  dryRun?: boolean;
}): Promise<SyncResult> {
  const run = async (): Promise<SyncResult> => {
    if (opts.enforceAirGap) throw new AirGapEnforcementError();
    const { publisherIdToExtensions, manifestByExtId } = gatherPublisherManifests(opts.db);

    const result: SyncResult = {
      publishersChecked: 0,
      publishersUnchanged: 0,
      publishersUpdated: [],
      publishersEvicted: [],
      failures: [],
    };

    const dryRun = opts.dryRun === true;
    const processOpts = {
      vault: opts.vault,
      db: opts.db,
      fetcher: opts.fetcher,
      dryRun,
    };
    for (const [publisherId, extIds] of publisherIdToExtensions) {
      await processPublisherKey(processOpts, result, publisherId, extIds, manifestByExtId);
    }

    return result;
  };

  const ticket = syncMutex.then(() => run());
  syncMutex = ticket.catch(() => undefined);
  return ticket;
}
