import type { Database } from "bun:sqlite";

import { publisherKeyFingerprint } from "../extensions/install-from-local.ts";
import { RegistryError } from "../extensions/registry/registry-errors.ts";
import {
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
      default:
        return { kind: "miss" };
    }
  } catch (e) {
    if (e instanceof RegistryError) throw new RpcMethodError(-32000, e.message);
    throw e;
  }
}
