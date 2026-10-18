import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { publisherKeyFingerprint } from "../extensions/install-from-local.ts";
import { parseExtensionManifestForRegistry } from "../extensions/manifest.ts";
import type {
  RegistryExtensionEntry,
  RegistryIndex,
  RegistryVersionEntry,
} from "../extensions/registry/index-format.ts";
import { RegistryError } from "../extensions/registry/registry-errors.ts";
import {
  fetchRegistryBytes,
  fetchUnpinnedIndex,
  fetchVerifiedIndex,
  type RegistryFetchDeps,
} from "../extensions/registry/registry-fetch.ts";
import {
  deleteRegistry,
  getRegistry,
  insertRegistry,
  listExtensionIdsFromRegistry,
  listRegistries,
  type RegistryRow,
  recordRegistryFetch,
} from "../extensions/registry/registry-store.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { asRecord } from "./connector-rpc-shared.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

/** The local owner's HITL gate (`ToolExecutor.gate`): `true` only for "proceed". */
export type RegistryOwnerGate = (action: {
  type: string;
  payload: Record<string, unknown>;
}) => Promise<boolean>;

export type RegistryFetchBag = Omit<RegistryFetchDeps, "db">;

export interface RegistryRpcOptions {
  method: string;
  params: unknown;
  db: Database;
  /** Absent only on a bespoke harness: every method that fetches then refuses. */
  fetch?: RegistryFetchBag;
  ownerGate?: RegistryOwnerGate;
}

type Hit = { kind: "hit"; value: unknown };
type Miss = { kind: "miss" };

/** A registry whose index is older than this reads `stale` in `registry.list`. */
export const REGISTRY_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME_LENGTH = 32;
const FINGERPRINT_RE = /^[0-9a-f]{32}$/;

function invalidParams(detail: string): RpcMethodError {
  return new RpcMethodError(-32602, `ERR_INVALID_PARAMS: ${detail}`);
}

function stringParam(rec: Record<string, unknown> | undefined, key: string): string {
  const v = rec?.[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw invalidParams(`${key} (non-empty string) required`);
  }
  return v.trim();
}

function requireName(rec: Record<string, unknown> | undefined): string {
  const name = stringParam(rec, "name");
  if (name.length > MAX_NAME_LENGTH || !NAME_RE.test(name)) {
    throw invalidParams(
      `name must match [a-z0-9][a-z0-9-]* and be at most ${MAX_NAME_LENGTH} characters`,
    );
  }
  return name;
}

/** Trim + lowercase, then require the `publisherKeyFingerprint` shape. Done HERE, not in the CLI. */
function normalizeFingerprint(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const fp = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!FINGERPRINT_RE.test(fp)) {
    throw new RegistryError(
      "ERR_REGISTRY_FINGERPRINT_MISMATCH",
      "a registry fingerprint must be 32 hex characters",
    );
  }
  return fp;
}

function requireFetch(fetch: RegistryFetchBag | undefined): RegistryFetchBag {
  if (fetch === undefined) {
    throw new RpcMethodError(-32603, "Registry fetch is not configured on this gateway");
  }
  return fetch;
}

async function handleAdd(
  rec: Record<string, unknown> | undefined,
  o: RegistryRpcOptions,
): Promise<Hit> {
  const name = requireName(rec);
  const url = stringParam(rec, "url");
  const wanted = normalizeFingerprint(rec?.["fingerprint"]);
  const ownerGate = o.ownerGate;
  if (ownerGate === undefined) {
    throw new RpcMethodError(-32603, "registry.add requires the owner's HITL gate");
  }
  const fetch = requireFetch(o.fetch);
  const clash = listRegistries(o.db).find((r) => r.name === name || r.url === url);
  if (clash !== undefined) {
    throw new RegistryError(
      "ERR_REGISTRY_EXISTS",
      clash.name === name
        ? `a registry named "${name}" is already added`
        : `the registry at ${url} is already added as "${clash.name}"`,
    );
  }
  // Fetched BEFORE the prompt and before anything is stored: the owner is shown what the registry
  // really serves, and the fetch is ledgered even if they then decline.
  const index = await fetchUnpinnedIndex({ ...fetch, db: o.db }, { name, url });
  const rootFingerprint = publisherKeyFingerprint(index.rootKey);
  if (wanted !== undefined && wanted !== rootFingerprint) {
    throw new RegistryError(
      "ERR_REGISTRY_FINGERPRINT_MISMATCH",
      `the registry's root key fingerprint is ${rootFingerprint}, not ${wanted}`,
    );
  }
  const extensionCount = Object.keys(index.extensions).length;
  const summary = { name, url, rootFingerprint, extensionCount, generatedAt: index.generatedAt };
  // Field names deliberately avoid key/auth/token: the executor redacts those in the prompt.
  const approved = await ownerGate({ type: "registry.add", payload: { ...summary } });
  if (!approved) {
    throw new RegistryError(
      "ERR_REGISTRY_ADD_NOT_APPROVED",
      "the owner declined to add the registry",
    );
  }
  // One transaction: an approved add never leaves a row without its recorded first fetch.
  o.db.transaction(() => {
    insertRegistry(o.db, {
      name,
      url,
      rootKey: index.rootKey,
      rootFingerprint,
      lastSequence: index.sequence,
      lastGeneratedAt: index.generatedAt,
      addedAt: fetch.now(),
    });
    recordRegistryFetch(o.db, name, index.rootKey, index.sequence, index.generatedAt, fetch.now());
  })();
  return { kind: "hit", value: summary };
}

function handleList(o: RegistryRpcOptions): Hit {
  const now = o.fetch?.now() ?? Date.now();
  const registries = listRegistries(o.db).map((r) => {
    const generated = Date.parse(r.lastGeneratedAt);
    return {
      name: r.name,
      url: r.url,
      rootFingerprint: r.rootFingerprint,
      // Counted only by refresh/search; `list` reads the database and never fetches.
      extensionCount: null,
      lastFetchedAt: r.lastFetchedAt,
      generatedAt: r.lastGeneratedAt,
      stale: !Number.isFinite(generated) || now - generated > REGISTRY_STALE_AFTER_MS,
    };
  });
  return { kind: "hit", value: { registries } };
}

async function handleRefresh(
  rec: Record<string, unknown> | undefined,
  o: RegistryRpcOptions,
): Promise<Hit> {
  const fetch = requireFetch(o.fetch);
  let targets: RegistryRow[];
  if (rec?.["name"] === undefined) {
    targets = listRegistries(o.db);
  } else {
    const name = stringParam(rec, "name");
    const one = getRegistry(o.db, name);
    if (one === undefined) {
      throw new RegistryError("ERR_REGISTRY_NOT_FOUND", `no registry named "${name}"`);
    }
    targets = [one];
  }
  const results: Array<{
    name: string;
    ok: boolean;
    error?: string;
    sequence?: number;
    extensionCount?: number;
  }> = [];
  for (const reg of targets) {
    try {
      const index = await fetchVerifiedIndex({ ...fetch, db: o.db }, reg);
      results.push({
        name: reg.name,
        ok: true,
        sequence: index.sequence,
        extensionCount: Object.keys(index.extensions).length,
      });
    } catch (e) {
      results.push({
        name: reg.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { kind: "hit", value: { results } };
}

function handleRemove(rec: Record<string, unknown> | undefined, o: RegistryRpcOptions): Hit {
  const name = stringParam(rec, "name");
  const orphanedExtensions = listExtensionIdsFromRegistry(o.db, name);
  const removed = deleteRegistry(o.db, name);
  return { kind: "hit", value: { removed, orphanedExtensions: removed ? orphanedExtensions : [] } };
}

/** A registry manifest is a small JSON document; anything larger is refused. */
const MAX_MANIFEST_BYTES = 64 * 1024;

type IndexRead = { reg: RegistryRow; index: RegistryIndex };

/** Freshly verified indexes of `targets`, fetched concurrently; a failing registry is reported, not thrown. */
async function readIndexes(
  targets: readonly RegistryRow[],
  o: RegistryRpcOptions,
): Promise<{ ok: IndexRead[]; errors: Array<{ registry: string; error: string }> }> {
  const fetch = requireFetch(o.fetch);
  const settled = await Promise.allSettled(
    targets.map((reg) => fetchVerifiedIndex({ ...fetch, db: o.db }, reg)),
  );
  const ok: IndexRead[] = [];
  const errors: Array<{ registry: string; error: string }> = [];
  settled.forEach((r, i) => {
    const reg = targets[i] as RegistryRow;
    if (r.status === "fulfilled") ok.push({ reg, index: r.value });
    else {
      const e: unknown = r.reason;
      errors.push({ registry: reg.name, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return { ok, errors };
}

/** Versions of an entry, semver-newest first (across channels). */
function versionsNewestFirst(entry: RegistryExtensionEntry): Array<[string, RegistryVersionEntry]> {
  return Object.entries(entry.versions).sort(([a], [b]) => Bun.semver.order(b, a));
}

async function handleSearch(
  rec: Record<string, unknown> | undefined,
  o: RegistryRpcOptions,
): Promise<Hit> {
  const needle = stringParam(rec, "query").toLowerCase();
  const read = await readIndexes(listRegistries(o.db), o);
  const results: Array<{
    registry: string;
    id: string;
    name: string;
    publisherId: string;
    latestStable: string | null;
    latestBeta: string | null;
  }> = [];
  for (const { reg, index } of read.ok) {
    for (const [id, entry] of Object.entries(index.extensions)) {
      const versions = versionsNewestFirst(entry);
      const newest = versions[0];
      if (newest === undefined) continue;
      const name = newest[1].name;
      const hay = [id, name, entry.publisher.id].map((v) => v.toLowerCase());
      if (!hay.some((h) => h.includes(needle))) continue;
      results.push({
        registry: reg.name,
        id,
        name,
        publisherId: entry.publisher.id,
        latestStable: versions.find(([, v]) => v.channel === "stable")?.[0] ?? null,
        latestBeta: versions.find(([, v]) => v.channel === "beta")?.[0] ?? null,
      });
    }
  }
  return { kind: "hit", value: { results, errors: read.errors } };
}

async function handleInfo(
  rec: Record<string, unknown> | undefined,
  o: RegistryRpcOptions,
): Promise<Hit> {
  const id = stringParam(rec, "id");
  let targets: RegistryRow[];
  if (rec?.["registry"] === undefined) {
    targets = listRegistries(o.db);
  } else {
    const name = stringParam(rec, "registry");
    const one = getRegistry(o.db, name);
    if (one === undefined) {
      throw new RegistryError("ERR_REGISTRY_NOT_FOUND", `no registry named "${name}"`);
    }
    targets = [one];
  }
  const read = await readIndexes(targets, o);
  const carrying = read.ok.filter((r) => r.index.extensions[id] !== undefined);
  if (carrying.length > 1) {
    throw new RegistryError(
      "ERR_REGISTRY_AMBIGUOUS",
      `"${id}" is carried by ${carrying.map((r) => r.reg.name).join(", ")}; pass --registry <name>`,
    );
  }
  const found = carrying[0];
  const entry = found?.index.extensions[id];
  if (found === undefined || entry === undefined) {
    const failed = read.errors.map((e) => `${e.registry}: ${e.error}`).join("; ");
    throw new RegistryError(
      "ERR_REGISTRY_NOT_FOUND",
      `no registry carries "${id}"${failed === "" ? "" : ` (unreachable: ${failed})`}`,
    );
  }
  const versions = versionsNewestFirst(entry);
  const newest = versions[0];
  if (newest === undefined) {
    throw new RegistryError("ERR_REGISTRY_INDEX_INVALID", `"${id}" has no versions`);
  }
  const bytes = await fetchRegistryBytes(
    { ...requireFetch(o.fetch), db: o.db },
    found.reg,
    newest[1].manifest,
    {
      method: "registry.manifest",
      extensionId: id,
      version: newest[0],
      maxBytes: MAX_MANIFEST_BYTES,
    },
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!sha256HexEqualConstantTime(digest, newest[1].manifestSha256)) {
    throw new RegistryError(
      "ERR_REGISTRY_HASH_MISMATCH",
      `the manifest of ${id}@${newest[0]} does not match the hash the index signed`,
    );
  }
  const { manifest } = parseExtensionManifestForRegistry(new TextDecoder().decode(bytes));
  return {
    kind: "hit",
    value: {
      registry: found.reg.name,
      id,
      publisherId: entry.publisher.id,
      publisherFingerprint: publisherKeyFingerprint(entry.publisher.key),
      versions: versions.map(([version, v], i) => ({
        version,
        channel: v.channel,
        publishedAt: v.publishedAt,
        packageSizeBytes: v.packageSizeBytes,
        ...(i === 0 ? { permissions: manifest.permissions } : {}),
      })),
    },
  };
}

/** The `registry.*` client methods (CLI-only). A registry error is surfaced with its `ERR_` code. */
export async function dispatchRegistryRpc(o: RegistryRpcOptions): Promise<Hit | Miss> {
  const rec = asRecord(o.params);
  try {
    switch (o.method) {
      case "registry.add":
        return await handleAdd(rec, o);
      case "registry.list":
        return handleList(o);
      case "registry.refresh":
        return await handleRefresh(rec, o);
      case "registry.remove":
        return handleRemove(rec, o);
      case "registry.search":
        return await handleSearch(rec, o);
      case "registry.info":
        return await handleInfo(rec, o);
      default:
        return { kind: "miss" };
    }
  } catch (e) {
    if (e instanceof RegistryError) throw new RpcMethodError(-32000, e.message);
    throw e;
  }
}
