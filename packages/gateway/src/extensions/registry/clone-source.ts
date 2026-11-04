/**
 * `registry.cloneSource` (`nimbus extension clone`): the published package an author starts from,
 * fetched through the SAME verified chain as a registry install (I44) — verified index from the
 * extension's registry, I48 version selection and block refusal, the hash-checked manifest, the
 * hash-checked package and the index-named key's I16 signature, in install's order
 * (`fetchVerifiedPackageBytes`). The archive is staged for the CLI, never installed.
 *
 * The one stated difference from install: no publisher-key decision is made and no key is stored,
 * because nothing clone produces is installed or run under that publisher. It never asks for
 * approval, never extracts, writes no `extension` row and no Vault entry, and does not refuse an
 * installed id. The writes it shares with install are the fetch's own: the registry's anti-rollback
 * sequence advances, and remote requests append registry egress rows (I29). On disk it writes only
 * inside `stagingRoot`.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { verifiedPublisherFor } from "../trust/verified-publisher.ts";
import { fetchVerifiedPackageBytes } from "./install-from-registry.ts";
import type { RegistryFetchDeps } from "./registry-fetch.ts";

export interface CloneSourceRequest {
  readonly id: string;
  readonly registry?: string;
  readonly version?: string;
}

export interface CloneSource {
  readonly id: string;
  readonly version: string;
  readonly channel: string;
  readonly registry: string;
  readonly publisherId: string;
  readonly keyFingerprint: string;
  readonly verifiedPublisher: { readonly github: string; readonly verifiedAt: string } | null;
  readonly packageSha256: string;
  /** Absolute path of the hash-checked `package.tgz`, inside a fresh directory under the staging root. */
  readonly archivePath: string;
}

export interface CloneSourceDeps {
  readonly db: Database;
  readonly fetch: Omit<RegistryFetchDeps, "db">;
}

/** A staged clone the CLI never collected is removed after this long (one hour). */
export const CLONE_STAGING_MAX_AGE_MS = 3_600_000;

/** Every staged clone directory starts with this; nothing else under the root is touched. */
const STAGE_PREFIX = "c-";

/**
 * Removes staged clone directories older than `maxAgeMs`. Best-effort: a missing root, or an entry
 * that cannot be read or removed, is skipped.
 */
export function sweepCloneStaging(
  stagingRoot: string,
  now: number,
  maxAgeMs: number = CLONE_STAGING_MAX_AGE_MS,
): void {
  let names: string[];
  try {
    names = readdirSync(stagingRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(STAGE_PREFIX)) continue;
    const path = join(stagingRoot, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true });
    } catch {
      /* best-effort: the next clone sweeps again */
    }
  }
}

export async function cloneRegistrySource(
  deps: CloneSourceDeps,
  req: CloneSourceRequest,
  stagingRoot: string,
): Promise<CloneSource> {
  mkdirSync(stagingRoot, { recursive: true });
  sweepCloneStaging(stagingRoot, Date.now());
  const fetchDeps: RegistryFetchDeps = { ...deps.fetch, db: deps.db };
  // No installed-id check, no publisher-key decision, no extraction: see the header.
  const { reg, entry, version, vEntry, packageBytes, rootFingerprint } =
    await fetchVerifiedPackageBytes(fetchDeps, deps.db, {
      id: req.id,
      ...(req.registry === undefined ? {} : { registry: req.registry }),
      ...(req.version === undefined ? {} : { version: req.version }),
    });
  const keyFingerprint = publisherKeyFingerprint(entry.publisher.key);
  const dir = mkdtempSync(join(stagingRoot, STAGE_PREFIX));
  const archivePath = join(dir, "package.tgz");
  try {
    // One write into the fresh directory; 0600 where the OS honours it.
    writeFileSync(archivePath, packageBytes, { mode: 0o600 });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    id: req.id,
    version,
    channel: vEntry.channel,
    registry: reg.name,
    publisherId: entry.publisher.id,
    keyFingerprint,
    verifiedPublisher: verifiedPublisherFor(deps.db, {
      publisherId: entry.publisher.id,
      keyFingerprint,
      source: { registry: reg.name, rootFingerprint },
    }),
    packageSha256: vEntry.packageSha256,
    archivePath,
  };
}
