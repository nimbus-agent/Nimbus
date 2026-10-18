import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";

import { recordRegistryEgress } from "../../egress/registry-egress.ts";
import {
  MAX_INDEX_BYTES,
  parseRegistryIndex,
  type RegistryIndex,
  verifyRegistryIndexPinned,
  verifyRegistryIndexSelf,
} from "./index-format.ts";
import { RegistryError } from "./registry-errors.ts";
import { getRegistry, type RegistryRow, recordRegistryFetch } from "./registry-store.ts";
import { resolveRegistryLocation, resolveRegistryResource } from "./registry-transport.ts";

export interface RegistryFetchDeps {
  db: Database;
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  enforceAirGap: () => boolean;
  now: () => number;
  /**
   * A production runtime (the compiled release binary, or `NODE_ENV=production`; see
   * `platform/runtime-layout.ts` `isProductionRuntime`), injected so the functions below never read
   * the environment.
   */
  production: boolean;
}

export type RegistryFetchMeta = {
  method: "registry.index" | "registry.manifest" | "registry.package";
  extensionId?: string;
  version?: string;
  maxBytes: number;
};

const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function unreachable(detail: string): RegistryError {
  return new RegistryError("ERR_REGISTRY_UNREACHABLE", detail);
}

function tooLarge(max: number): RegistryError {
  return new RegistryError("ERR_REGISTRY_TOO_LARGE", `registry response exceeds ${max} bytes`);
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      await res.body?.cancel();
      throw tooLarge(maxBytes);
    }
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function readLocal(path: string, root: string, maxBytes: number): Uint8Array {
  let rootStat: ReturnType<typeof statSync>;
  try {
    rootStat = statSync(root);
  } catch {
    throw unreachable("local registry directory does not exist");
  }
  if (!rootStat.isDirectory()) throw unreachable("local registry path is not a directory");
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    throw new RegistryError("ERR_REGISTRY_NOT_FOUND", "registry file not found");
  }
  try {
    // Everything below goes through the one descriptor, so the file checked is the file read.
    const st = fstatSync(fd);
    if (!st.isFile()) throw new RegistryError("ERR_REGISTRY_NOT_FOUND", "registry file not found");
    if (st.size > maxBytes) throw tooLarge(maxBytes);
    const bytes = new Uint8Array(readFileSync(fd));
    // The size check can be outrun by a growing file; the bytes actually read are the authority.
    if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

async function fetchRemote(
  deps: RegistryFetchDeps,
  regName: string,
  meta: RegistryFetchMeta,
  startUrl: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  // One controller aborts on either the timeout or the caller's signal.
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const abortFrom = (src: AbortSignal) => () => controller.abort(src.reason);
  const onTimeout = abortFrom(timeout);
  const onCaller = signal === undefined ? undefined : abortFrom(signal);
  if (timeout.aborted) onTimeout();
  else timeout.addEventListener("abort", onTimeout, { once: true });
  if (signal !== undefined && onCaller !== undefined) {
    if (signal.aborted) onCaller();
    else signal.addEventListener("abort", onCaller, { once: true });
  }
  const combined = controller.signal;
  let url = startUrl;
  try {
    for (let hop = 0; ; hop++) {
      // One ledger row per outbound REQUEST, each redirect hop included; a failed append aborts
      // this hop before it is made.
      recordRegistryEgress(deps.db, {
        registryName: regName,
        method: meta.method,
        extensionId: meta.extensionId,
        version: meta.version,
        host: new URL(url).host,
        now: deps.now(),
      });
      const res = await deps.fetchFn(url, { redirect: "manual", signal: combined });
      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw unreachable("too many registry redirects");
        const loc = res.headers.get("location");
        if (loc === null || loc === "") throw unreachable("registry redirect without a Location");
        const next = new URL(loc, url).href;
        // Re-run the transport check on every hop: an https registry must not redirect to http, a
        // non-loopback http host, or file:.
        const nextLoc = resolveRegistryLocation(next, { production: deps.production });
        if (nextLoc.kind !== "remote") {
          throw new RegistryError(
            "ERR_REGISTRY_TRANSPORT_REFUSED",
            "registry redirected to a local path",
          );
        }
        if (url.startsWith("https:") && !next.startsWith("https:")) {
          throw new RegistryError(
            "ERR_REGISTRY_TRANSPORT_REFUSED",
            "an https registry redirected to a plain http location",
          );
        }
        url = next;
        continue;
      }
      if (res.status === 404) {
        await res.body?.cancel();
        throw new RegistryError("ERR_REGISTRY_NOT_FOUND", "registry resource not found");
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel();
        throw unreachable(`registry answered HTTP ${res.status}`);
      }
      return await readCapped(res, meta.maxBytes);
    }
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    throw unreachable(e instanceof Error ? e.message : "registry request failed");
  } finally {
    // Do not leak a listener on the caller's long-lived signal.
    if (signal !== undefined && onCaller !== undefined)
      signal.removeEventListener("abort", onCaller);
    timeout.removeEventListener("abort", onTimeout);
  }
}

/**
 * The ONE place registry bytes enter. Order for a remote registry: air-gap check, ledger row
 * (fail-closed), then the request. A local registry makes no request: no row, allowed under
 * air-gap.
 */
export async function fetchRegistryBytes(
  deps: RegistryFetchDeps,
  reg: { name: string; url: string },
  rel: string,
  meta: RegistryFetchMeta,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const loc = resolveRegistryLocation(reg.url, { production: deps.production });
  const res = resolveRegistryResource(loc, rel);
  if (res.kind === "local" && loc.kind === "local") {
    return readLocal(res.path, loc.root, meta.maxBytes);
  }
  if (res.kind !== "remote") throw new Error("registry location and resource kinds disagree");
  if (deps.enforceAirGap()) {
    throw new RegistryError("ERR_REGISTRY_AIR_GAP", "air-gap mode refuses remote registry fetches");
  }
  return fetchRemote(deps, reg.name, meta, res.url, signal);
}

async function fetchIndex(
  deps: RegistryFetchDeps,
  reg: { name: string; url: string },
  signal: AbortSignal | undefined,
): Promise<RegistryIndex> {
  const bytes = await fetchRegistryBytes(
    deps,
    reg,
    "index.json",
    { method: "registry.index", maxBytes: MAX_INDEX_BYTES },
    signal,
  );
  return parseRegistryIndex(bytes);
}

/** Pinned verify (root key must equal the pinned one), anti-rollback, then record the fetch. */
export async function fetchVerifiedIndex(
  deps: RegistryFetchDeps,
  reg: RegistryRow,
  signal?: AbortSignal,
): Promise<RegistryIndex> {
  const index = await fetchIndex(deps, reg, signal);
  await verifyRegistryIndexPinned(index, reg.rootKey);
  if (index.sequence < reg.lastSequence) {
    throw new RegistryError(
      "ERR_REGISTRY_ROLLBACK",
      `index sequence ${index.sequence} is older than the last seen ${reg.lastSequence}`,
    );
  }
  // Conditional write: the row may have moved (or gone) while this fetch was in flight.
  if (
    !recordRegistryFetch(
      deps.db,
      reg.name,
      reg.rootKey,
      index.sequence,
      index.generatedAt,
      deps.now(),
    )
  ) {
    const cur = getRegistry(deps.db, reg.name);
    if (cur === undefined || cur.rootKey !== reg.rootKey) {
      throw new RegistryError(
        "ERR_REGISTRY_ROOT_KEY_CHANGED",
        "registry was removed or re-pinned during the fetch",
      );
    }
    throw new RegistryError(
      "ERR_REGISTRY_ROLLBACK",
      `index sequence ${index.sequence} is older than the last seen ${cur.lastSequence}`,
    );
  }
  return index;
}

/** Self-verify only (the key is not pinned yet); used by `registry add`. */
export async function fetchUnpinnedIndex(
  deps: RegistryFetchDeps,
  reg: { name: string; url: string },
  signal?: AbortSignal,
): Promise<RegistryIndex> {
  const index = await fetchIndex(deps, reg, signal);
  await verifyRegistryIndexSelf(index);
  return index;
}
