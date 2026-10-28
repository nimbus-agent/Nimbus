import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import {
  MAX_INDEX_BYTES,
  parseRegistryIndex,
  RegistryError,
  type RegistryErrorCode,
  type RegistryIndex,
  readRegistryStatements,
  registryIndexDigest,
  type TrustStatement,
  verifyRegistryIndexPinned,
  verifyRegistryIndexSelf,
  verifyTrustStatement,
} from "@nimbus-dev/registry-format";
import { recordRegistryEgress } from "../../egress/registry-egress.ts";
import { recordTrustStatements } from "../trust/trust-store.ts";
import {
  type BuiltinRegistryConfig,
  currentRegistryFloor,
  recordAnyRegistryFetch,
} from "./builtin-registry.ts";
import type { RegistryRow } from "./registry-store.ts";
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
  /**
   * The built-in official registry these deps resolve the reserved name to. Absent means the baked
   * `BUILTIN_REGISTRY` (see `builtin-registry.ts` `builtinRegistryOf`); `null` means none. Only code
   * sets it — tests, and a composition seam for an E2E — never the environment, a config file or an
   * IPC parameter.
   */
  builtin?: BuiltinRegistryConfig | null;
  /**
   * Trust layer (I48): called with the ids of trust statements a verified registry index or the
   * trust feed just stored for the first time, so the gateway can stop and notify what they newly
   * block. Must not throw; a throw is swallowed.
   */
  onTrustRecorded?: (insertedIds: readonly string[]) => void;
}

export type RegistryFetchMeta = {
  method: "registry.index" | "registry.manifest" | "registry.package" | "trust.feed";
  extensionId?: string;
  version?: string;
  maxBytes: number;
};

/** Registry errors that mean the bytes could not be FETCHED, as opposed to fetched and refused. */
export const FETCH_FAILURE_CODES: ReadonlySet<RegistryErrorCode> = new Set<RegistryErrorCode>([
  "ERR_REGISTRY_UNREACHABLE",
  "ERR_REGISTRY_AIR_GAP",
  "ERR_REGISTRY_TRANSPORT_REFUSED",
  "ERR_REGISTRY_TOO_LARGE",
  "ERR_REGISTRY_NOT_FOUND",
]);

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
  // Sequential by definition: a stream yields its chunks one read at a time.
  for (;;) {
    const { done, value } = await reader.read(); // NOSONAR S9382: a stream yields one chunk per read
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

/**
 * One signal that aborts on either the fetch timeout or the caller's signal. `detach` removes both
 * listeners, so a long-lived caller signal does not leak one per request.
 */
function linkAbortSignals(signal: AbortSignal | undefined): {
  readonly combined: AbortSignal;
  readonly detach: () => void;
} {
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
  return {
    combined: controller.signal,
    detach: () => {
      if (signal !== undefined && onCaller !== undefined)
        signal.removeEventListener("abort", onCaller);
      timeout.removeEventListener("abort", onTimeout);
    },
  };
}

/**
 * The next hop of a redirect answer (its body cancelled), or a refusal: too many hops, no
 * Location, a hop to a local path, or an https registry downgrading to plain http.
 */
async function redirectTarget(
  deps: RegistryFetchDeps,
  res: Response,
  url: string,
  hop: number,
): Promise<string> {
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
  return next;
}

/** Refuses a non-redirect answer that is not 2xx (body cancelled): 404 is not-found, else unreachable. */
async function refuseUnsuccessful(res: Response): Promise<void> {
  if (res.status === 404) {
    await res.body?.cancel();
    throw new RegistryError("ERR_REGISTRY_NOT_FOUND", "registry resource not found");
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    throw unreachable(`registry answered HTTP ${res.status}`);
  }
}

async function fetchRemote(
  deps: RegistryFetchDeps,
  regName: string,
  meta: RegistryFetchMeta,
  startUrl: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const { combined, detach } = linkAbortSignals(signal);
  let url = startUrl;
  try {
    // Sequential by definition: each hop's URL comes from the previous hop's answer.
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
      const res = await deps.fetchFn(url, { redirect: "manual", signal: combined }); // NOSONAR S9382: each hop's URL comes from the previous answer
      if (REDIRECT_STATUSES.has(res.status)) {
        url = await redirectTarget(deps, res, url, hop);
        continue;
      }
      await refuseUnsuccessful(res);
      return await readCapped(res, meta.maxBytes);
    }
  } catch (e) {
    if (e instanceof RegistryError) throw e;
    throw unreachable(e instanceof Error ? e.message : "registry request failed");
  } finally {
    detach();
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

function equivocation(sequence: number): RegistryError {
  return new RegistryError(
    "ERR_REGISTRY_EQUIVOCATION",
    `index sequence ${sequence} was already accepted with different content`,
  );
}

/**
 * Pinned verify (root key must equal the pinned one), anti-rollback, anti-equivocation (an index at
 * the accepted sequence must be the document accepted at it), then record the fetch.
 */
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
  const digest = registryIndexDigest(index);
  if (
    index.sequence === reg.lastSequence &&
    reg.lastIndexSha256 !== null &&
    digest !== reg.lastIndexSha256
  ) {
    throw equivocation(index.sequence);
  }
  // Conditional write: the row may have moved (or gone) while this fetch was in flight. The built-in
  // registry's floor lives in its own table; the rollback and equivocation rules are the same.
  if (
    !recordAnyRegistryFetch(deps.db, reg, index.sequence, index.generatedAt, deps.now(), digest)
  ) {
    const cur = currentRegistryFloor(deps.db, reg);
    if (cur === undefined) {
      throw new RegistryError(
        "ERR_REGISTRY_ROOT_KEY_CHANGED",
        "registry was removed or re-pinned during the fetch",
      );
    }
    if (cur.lastSequence === index.sequence && cur.lastIndexSha256 !== digest) {
      throw equivocation(index.sequence);
    }
    throw new RegistryError(
      "ERR_REGISTRY_ROLLBACK",
      `index sequence ${index.sequence} is older than the last seen ${cur.lastSequence}`,
    );
  }
  ingestRegistryStatements(deps, reg, index);
  return index;
}

/**
 * Stores the trust statements a verified index carries, scoped to this registry (trust layer). Only
 * a PINNED, verified index is read: `fetchUnpinnedIndex` (registry add) stores nothing. A store
 * failure never fails the index fetch: the statements are re-read on the next refresh.
 */
function ingestRegistryStatements(
  deps: RegistryFetchDeps,
  reg: RegistryRow,
  index: RegistryIndex,
): void {
  try {
    const { statements } = readRegistryStatements(index);
    const out = recordTrustStatements(
      deps.db,
      statements,
      {
        kind: "registry",
        name: reg.name,
        rootKey: reg.rootKey,
        rootFingerprint: reg.rootFingerprint,
        listedPublisherKeys: listedPublisherKeysOf(index, statements),
      },
      deps.now(),
    );
    if (out.insertedIds.length > 0) deps.onTrustRecorded?.(out.insertedIds);
  } catch {
    // Best-effort: a locked or full database must not turn a verified index into a failed fetch.
  }
}

/**
 * The keys this index ties to each publisher: every entry's key, closed in BOTH directions over the
 * index's publisher-signed `key.rotate` statements. A registry moves an entry to the publisher's
 * rotated key when a version signed by it is published, so without the closure a later revocation of
 * the OLD key would no longer concern a "listed" key and clients on the new key would drop it,
 * escaping R4. Closing over rotations only widens admission to keys the publisher's own signed chain
 * connects to a listed key (the registry's admission already requires that chain to start at one).
 */
function listedPublisherKeysOf(
  index: RegistryIndex,
  statements: readonly TrustStatement[],
): Map<string, Set<string>> {
  const listed = new Map<string, Set<string>>();
  for (const entry of Object.values(index.extensions)) {
    const keys = listed.get(entry.publisher.id) ?? new Set<string>();
    keys.add(entry.publisher.key);
    listed.set(entry.publisher.id, keys);
  }
  const rotations = statements.filter(
    (s): s is Extract<TrustStatement, { kind: "key.rotate" }> =>
      s.kind === "key.rotate" && verifyTrustStatement(s, {}) === "publisher",
  );
  for (const [publisherId, keys] of listed) {
    const mine = rotations.filter((r) => r.publisherId === publisherId);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of mine) {
        for (const [a, b] of [
          [r.fromKey, r.toKey],
          [r.toKey, r.fromKey],
        ] as const) {
          if (keys.has(a) && !keys.has(b)) {
            keys.add(b);
            grew = true;
          }
        }
      }
    }
  }
  return listed;
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
