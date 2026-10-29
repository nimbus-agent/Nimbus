/**
 * Where the auto-update daemon learns of updates (spec § 8.8): an extension's OWN source registry,
 * and only that one. A tick groups the registry-sourced extensions by `source_registry`, reads each
 * registry's freshly verified `index.json` ONCE, and fetches a `manifest.json` only for an
 * extension whose index shows a newer version on its channel set. Detection only: nothing here
 * downloads a package or touches the install tree.
 */
import type { Database } from "bun:sqlite";
import {
  isStarterPack,
  publisherKeyFingerprint,
  type RegistryChannel,
  type RegistryVersionEntry,
} from "@nimbus-dev/registry-format";
import type { NimbusVault } from "../../vault/index.ts";
import { diffPermissions } from "../auto-update-permissions-diff.ts";
import type {
  AvailableUpdate,
  InstalledExtensionManifestSlice,
  VerificationStatus,
} from "../auto-update-types.ts";
import { rangesOf } from "../manifest-support.ts";
import { publisherKeyDecision } from "../trust/publisher-key-decision.ts";
import { type BlockSubject, blocksFor } from "../trust/trust-blocks.ts";
import { builtinRegistryOf, resolveRegistry } from "./builtin-registry.ts";
import { fetchVerifiedIndex, type RegistryFetchDeps } from "./registry-fetch.ts";
import { fetchRegistryManifest, verifyRegistryManifestSignature } from "./registry-manifest.ts";
import type { RegistryRow } from "./registry-store.ts";

export interface InstalledRegistryRow {
  id: string;
  version: string;
  enabled: number;
  source: { registry: string; rootFingerprint: string; channel: RegistryChannel };
  publisherId: string;
  /** The fingerprint of the key that verified the installed copy, when recorded. */
  keyFingerprint?: string;
  manifest: InstalledExtensionManifestSlice;
}

export interface RegistryUpdateSourceDeps {
  db: Database;
  fetch: RegistryFetchDeps;
  vault: NimbusVault;
  verifyManifestSignature: (m: object, k: Uint8Array) => Promise<void>;
  now: () => number;
}

export interface CollectedRegistryUpdates {
  updates: AvailableUpdate[];
  errors: Array<{ registry: string; error: string }>;
  /** Each update's NEW `dependsOn` (absent when it declares none), for the daemon's conflict check. */
  dependsOn: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A `stable` install is offered `stable` only; a `beta` install the newest across stable ∪ beta.
 * A version something blocks (I48) is never offered, so a taken-down 1.1.0 does not hide a clean
 * 1.0.9 — though only a version NEWER than the installed one becomes an update.
 */
function newestOnChannel(
  versions: Readonly<Record<string, RegistryVersionEntry>>,
  channel: RegistryChannel,
  isBlocked: (version: string) => boolean,
): [string, RegistryVersionEntry] | undefined {
  const wanted: readonly RegistryChannel[] = channel === "beta" ? ["stable", "beta"] : ["stable"];
  return Object.entries(versions)
    .filter(([v, e]) => wanted.includes(e.channel) && !isBlocked(v))
    .sort(([a], [b]) => Bun.semver.order(b, a))[0];
}

function groupByRegistry(
  rows: readonly InstalledRegistryRow[],
): Map<string, InstalledRegistryRow[]> {
  const groups = new Map<string, InstalledRegistryRow[]>();
  for (const row of rows) {
    if (row.enabled !== 1) continue;
    const list = groups.get(row.source.registry) ?? [];
    list.push(row);
    groups.set(row.source.registry, list);
  }
  return groups;
}

async function detectOne(
  deps: RegistryUpdateSourceDeps,
  reg: RegistryRow,
  index: Awaited<ReturnType<typeof fetchVerifiedIndex>>,
  row: InstalledRegistryRow,
  signal: AbortSignal,
  out: CollectedRegistryUpdates & { dependsOn: Map<string, Readonly<Record<string, string>>> },
): Promise<void> {
  const entry = index.extensions[row.id];
  if (entry === undefined) return;
  const subjectAt = (version: string): BlockSubject => ({
    extensionId: row.id,
    version,
    publisherId: entry.publisher.id,
    keyFingerprint: publisherKeyFingerprint(entry.publisher.key),
    source: { registry: reg.name, rootFingerprint: reg.rootFingerprint },
  });
  const newest = newestOnChannel(
    entry.versions,
    row.source.channel,
    (v) => blocksFor(deps.db, subjectAt(v)).length > 0,
  );
  if (newest === undefined) return;
  const [toVersion, vEntry] = newest;
  if (Bun.semver.order(toVersion, row.version) <= 0) return;

  const fetched = await fetchRegistryManifest(
    deps.fetch,
    reg,
    entry,
    row.id,
    toVersion,
    vEntry,
    signal,
  );
  // The signed index is the publisher-key authority. A key the Vault does not trust is applied only
  // along the publisher's rotation chain or when Nimbus vouches (spec R5); anything else, or another
  // publisher, is surfaced as a conflict, never applied.
  const decision =
    entry.publisher.id === row.publisherId
      ? await publisherKeyDecision(
          { db: deps.db, vault: deps.vault },
          {
            publisherId: entry.publisher.id,
            key: entry.publisher.key,
            source: { registry: reg.name, rootFingerprint: reg.rootFingerprint },
            installedFingerprint: row.keyFingerprint ?? null,
          },
        )
      : null;
  let verificationStatus: VerificationStatus;
  if (decision === null || !decision.ok) {
    verificationStatus = "publisher_key_conflict";
  } else {
    verificationStatus = await verifyRegistryManifestSignature(
      fetched,
      row.id,
      toVersion,
      deps.verifyManifestSignature,
    ).then(
      () => "verified" as const,
      () => "signature_failed" as const,
    );
  }
  const m = fetched.manifest;
  out.updates.push({
    id: row.id,
    displayName: m.name ?? row.manifest.name ?? row.id,
    fromVersion: row.version,
    toVersion,
    channel: vEntry.channel,
    changelog: m.changelog ?? "",
    publisherStatus: verificationStatus === "verified" ? "verified" : "unverified",
    manifestHash: vEntry.manifestSha256,
    signatureB64: m.signature ?? "",
    entryHash: vEntry.entryHash,
    packageSha256: vEntry.packageSha256,
    packageSizeBytes: vEntry.packageSizeBytes,
    sourceRegistry: reg.name,
    rootFingerprint: reg.rootFingerprint,
    packagePath: vEntry.package,
    permissionDiff: diffPermissions(row.manifest.permissions, m.permissions),
    verificationStatus,
    publisherKeyFingerprint: publisherKeyFingerprint(entry.publisher.key),
    publisherId: entry.publisher.id,
    ...(decision?.change == null
      ? {}
      : {
          publisherKeyChange: {
            ...decision.change,
            ...(decision.ok && (decision.via === "rotation" || decision.via === "nimbus")
              ? { via: decision.via }
              : {}),
          },
        }),
    ...(isStarterPack(m) ? { toStarterPack: true as const } : {}),
    detectedAt: deps.now(),
  });
  if (m.dependsOn !== undefined) out.dependsOn.set(row.id, rangesOf(m.dependsOn));
}

export async function collectRegistryUpdates(
  deps: RegistryUpdateSourceDeps,
  rows: InstalledRegistryRow[],
  signal: AbortSignal,
): Promise<CollectedRegistryUpdates> {
  const out = {
    updates: [] as AvailableUpdate[],
    errors: [] as Array<{ registry: string; error: string }>,
    dependsOn: new Map<string, Readonly<Record<string, string>>>(),
  };
  for (const [name, group] of groupByRegistry(rows)) {
    // The CURRENT registry table: a registry removed since install yields nothing, and one whose
    // root key is no longer the one the extension was installed under is a different trust root.
    // The reserved name resolves to the built-in registry, whose key is the release's.
    const reg = resolveRegistry(deps.db, name, builtinRegistryOf(deps.fetch));
    if (reg === undefined) continue;
    const pinned = group.filter((r) => r.source.rootFingerprint === reg.rootFingerprint);
    if (pinned.length === 0) continue;
    let index: Awaited<ReturnType<typeof fetchVerifiedIndex>>;
    try {
      // SERIAL by design: one registry at a time keeps the egress rows and detection audit in a
      // deterministic order, and one failing registry is recorded without blocking the next.
      index = await fetchVerifiedIndex(deps.fetch, reg, signal); // NOSONAR S9382: deterministic per-registry order (see above)
    } catch (e) {
      out.errors.push({ registry: name, error: message(e) });
      continue;
    }
    for (const row of pinned) {
      try {
        await detectOne(deps, reg, index, row, signal, out); // NOSONAR S9382: one manifest fetch at a time per registry
      } catch (e) {
        out.errors.push({ registry: name, error: `${row.id}: ${message(e)}` });
      }
    }
  }
  return out;
}
