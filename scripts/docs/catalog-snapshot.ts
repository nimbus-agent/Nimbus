/**
 * The official registry's catalog snapshot for the docs site (S4 marketplace tile, slice B3).
 *
 * Runs the SAME verified chain an install does (I44), with the gateway's own functions: the index is
 * fetched and verified against the baked root key (`fetchVerifiedIndex`), and each newest manifest is
 * fetched, hash-checked against the index, matched to the index's publisher id and key
 * (`fetchRegistryManifest`) and its I16 signature verified (`verifyRegistryManifestSignature`). It
 * refuses a sequence lower than the previous snapshot's, and different content at an equal one. Any
 * failure throws, so the caller writes nothing. The docs build only reads the written file.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  type BuiltinRegistryConfig,
  builtinRegistryRow,
} from "../../packages/gateway/src/extensions/registry/builtin-registry.ts";
import { fetchVerifiedIndex } from "../../packages/gateway/src/extensions/registry/registry-fetch.ts";
import {
  fetchRegistryManifest,
  verifyRegistryManifestSignature,
} from "../../packages/gateway/src/extensions/registry/registry-manifest.ts";
import { BUILTIN_REGISTRY_NAME } from "../../packages/gateway/src/extensions/registry/registry-store.ts";
import { versionEvidence } from "../../packages/gateway/src/extensions/registry/version-evidence.ts";
import { blocksFor } from "../../packages/gateway/src/extensions/trust/trust-blocks.ts";
import {
  applyTrustSnapshot,
  type TrustFeedConfig,
} from "../../packages/gateway/src/extensions/trust/trust-feed.ts";
import { verifiedPublisherFor } from "../../packages/gateway/src/extensions/trust/verified-publisher.ts";
import { CURRENT_SCHEMA_VERSION } from "../../packages/gateway/src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../packages/gateway/src/index/migrations/runner.ts";
import {
  authorMetadataView,
  codeUnitCompare,
  isStarterPack,
  provenanceMatching,
  publisherKeyFingerprint,
  type RegistryIndex,
  type RegistryVersionEntry,
  readManifestRepository,
  readVersionQuality,
  registryIndexSigningBytes,
} from "../../packages/registry-format/src/index.ts";

export const CATALOG_FORMAT = 1;

export type CatalogKind = "connector" | "starter-pack" | "other";

export interface CatalogVersion {
  readonly version: string;
  readonly channel: string;
  readonly publishedAt: string;
  readonly packageSizeBytes: number;
  readonly blocked: boolean;
  readonly quality: {
    readonly score: number;
    readonly cases: number;
    readonly passed: number;
  } | null;
}

export interface CatalogExtension {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly publisherId: string;
  readonly publisherFingerprint: string;
  readonly verifiedPublisher: string | null;
  readonly kind: CatalogKind;
  readonly newest: string;
  readonly network: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesWrite: readonly string[];
  readonly license: string | null;
  readonly funding: ReadonlyArray<{ readonly url: string; readonly label: string | null }>;
  readonly provenance: { readonly sourceRepository: string; readonly commit: string } | null;
  readonly baseline: string;
  readonly tested: string;
  readonly history: string;
  readonly versions: readonly CatalogVersion[];
}

export interface CatalogSnapshot {
  readonly format: typeof CATALOG_FORMAT;
  readonly registry: string;
  readonly sequence: number;
  readonly generatedAt: string;
  readonly indexSha256: string;
  readonly snapshotAt: string;
  readonly extensions: readonly CatalogExtension[];
}

export interface CatalogDeps {
  readonly builtin: BuiltinRegistryConfig;
  readonly trustSnapshot: string | null;
  readonly trustFeed: TrustFeedConfig | null;
  readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  readonly production: boolean;
  readonly now: () => number;
  /** The snapshot already committed, for the anti-rollback check; `null` for the first one. */
  readonly previous: { readonly sequence: number; readonly indexSha256: string } | null;
}

const MAX_TEXT = 2_000;

function text(raw: unknown, key: string, max = MAX_TEXT): string {
  if (raw === null || typeof raw !== "object") return "";
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** SHA-256 over exactly the bytes the root key signed: two indexes hash alike only when they say the same. */
export function indexDigest(index: RegistryIndex): string {
  return createHash("sha256").update(registryIndexSigningBytes(index)).digest("hex");
}

/** Throws on a sequence below the previous snapshot's, or different content at an equal one. */
export function assertNoRollback(
  previous: CatalogDeps["previous"],
  sequence: number,
  digest: string,
): void {
  if (previous === null) return;
  if (sequence < previous.sequence) {
    throw new Error(
      `refused: the index sequence ${String(sequence)} is below the committed snapshot's ${String(previous.sequence)}`,
    );
  }
  if (sequence === previous.sequence && digest !== previous.indexSha256) {
    throw new Error(
      `refused: sequence ${String(sequence)} was already snapshotted with different content`,
    );
  }
}

function newestFirst(versions: Readonly<Record<string, RegistryVersionEntry>>): string[] {
  return Object.keys(versions).sort((a, b) => Bun.semver.order(b, a));
}

function qualityOf(v: RegistryVersionEntry): CatalogVersion["quality"] {
  const q = readVersionQuality(v);
  return q.state === "scored"
    ? { score: q.quality.score, cases: q.quality.cases, passed: q.quality.passed }
    : null;
}

export async function buildCatalogSnapshot(deps: CatalogDeps): Promise<CatalogSnapshot> {
  const db = new Database(":memory:");
  try {
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const now = deps.now();
    // The verified-publisher badge and the blocks come from the baked trust snapshot, as on a fresh install.
    await applyTrustSnapshot(db, deps.trustSnapshot, deps.trustFeed, now);
    const fetchDeps = {
      db,
      fetchFn: deps.fetchFn,
      enforceAirGap: () => false,
      now: deps.now,
      production: deps.production,
      builtin: deps.builtin,
    };
    const reg = builtinRegistryRow(db, deps.builtin);
    const index = await fetchVerifiedIndex(fetchDeps, reg);
    const digest = indexDigest(index);
    assertNoRollback(deps.previous, index.sequence, digest);
    const source = { registry: reg.name, rootFingerprint: reg.rootFingerprint };
    const extensions: CatalogExtension[] = [];
    for (const id of Object.keys(index.extensions).sort(codeUnitCompare)) {
      const entry = index.extensions[id];
      if (entry === undefined) continue;
      const order = newestFirst(entry.versions);
      const newest = order[0];
      const newestEntry = newest === undefined ? undefined : entry.versions[newest];
      if (newest === undefined || newestEntry === undefined) continue;
      const fetched = await fetchRegistryManifest(fetchDeps, reg, entry, id, newest, newestEntry);
      await verifyRegistryManifestSignature(fetched, id, newest);
      const raw = JSON.parse(fetched.text) as unknown;
      const m = fetched.manifest;
      const keyFingerprint = publisherKeyFingerprint(entry.publisher.key);
      const evidence = versionEvidence({
        registry: reg.name,
        versions: entry.versions,
        version: newest,
        declaresNetwork: m.permissions.network.length > 0,
        starterPack: isStarterPack(m),
        now,
      });
      const author = authorMetadataView(raw);
      const provenance = provenanceMatching(newestEntry, readManifestRepository(raw));
      let kind: CatalogKind = "other";
      if (isStarterPack(m)) kind = "starter-pack";
      else if (m.sync !== undefined) kind = "connector";
      extensions.push({
        id,
        displayName: text(raw, "displayName", 120) || text(raw, "name", 120) || id,
        description: text(raw, "description"),
        publisherId: entry.publisher.id,
        publisherFingerprint: keyFingerprint,
        verifiedPublisher:
          verifiedPublisherFor(db, { publisherId: entry.publisher.id, keyFingerprint, source })
            ?.github ?? null,
        kind,
        newest,
        network: [...m.permissions.network],
        filesRead: [...m.permissions.filesystem.read],
        filesWrite: [...m.permissions.filesystem.write],
        license: author.license,
        funding: (author.funding ?? []).map((f) => ({ url: f.url, label: f.label ?? null })),
        provenance:
          provenance === undefined
            ? null
            : { sourceRepository: provenance.sourceRepository, commit: provenance.commit },
        baseline: evidence.baseline.text,
        tested: evidence.tested.text,
        history: evidence.history.text,
        versions: order.map((version) => {
          const v = entry.versions[version] as RegistryVersionEntry;
          return {
            version,
            channel: v.channel,
            publishedAt: v.publishedAt,
            packageSizeBytes: v.packageSizeBytes,
            blocked:
              blocksFor(db, {
                extensionId: id,
                version,
                publisherId: entry.publisher.id,
                keyFingerprint,
                source,
              }).length > 0,
            quality: qualityOf(v),
          };
        }),
      });
    }
    return {
      format: CATALOG_FORMAT,
      registry: BUILTIN_REGISTRY_NAME,
      sequence: index.sequence,
      generatedAt: index.generatedAt,
      indexSha256: digest,
      snapshotAt: new Date(now).toISOString(),
      extensions,
    };
  } finally {
    db.close();
  }
}
