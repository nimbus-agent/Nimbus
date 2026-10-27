import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  publisherKeyFingerprint,
  RegistryError,
  type RegistryExtensionEntry,
  type RegistryVersionEntry,
  readRegistryReportUrl,
  registryIndexDigest,
} from "@nimbus-dev/registry-format";
import { ExtensionInstallNotApprovedError } from "../extensions/install-from-local.ts";
import { parseExtensionManifestForRegistry } from "../extensions/manifest.ts";
import {
  BUILTIN_REGISTRY_NAME,
  builtinRegistryOf,
} from "../extensions/registry/builtin-registry.ts";
import { installFromRegistry } from "../extensions/registry/install-from-registry.ts";
import {
  fetchRegistryBytes,
  fetchUnpinnedIndex,
  fetchVerifiedIndex,
  type RegistryFetchDeps,
} from "../extensions/registry/registry-fetch.ts";
import {
  type ResolvedEntry,
  readIndexes,
  resolveRegistryEntry,
} from "../extensions/registry/registry-resolve.ts";
import {
  assertRegistryNameNotReserved,
  deleteRegistry,
  getRegistry,
  insertRegistry,
  listExtensionIdsFromRegistry,
  listRegistries,
  type RegistryRow,
  recordRegistryFetch,
} from "../extensions/registry/registry-store.ts";
import { blocksFor, TrustBlockError } from "../extensions/trust/trust-blocks.ts";
import {
  type FreshenHandle,
  freshenTrustFeed,
  trustFeedNote,
} from "../extensions/trust/trust-freshen.ts";
import {
  type VerifiedPublisher,
  verifiedPublisherFor,
} from "../extensions/trust/verified-publisher.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/index.ts";
import { asRecord } from "./connector-rpc-shared.ts";
import { emitGatewayEvent } from "./gateway-events.ts";
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
  /** `registry.install` only: where extensions install, and the Vault holding publisher keys. */
  extensionsDir?: string;
  vault?: NimbusVault;
  /** `registry.install` only: the trust feed, refreshed best-effort first (spec § 6.2). */
  trustFeed?: FreshenHandle;
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
  // The built-in official registry's name, refused outright and first: no URL or key makes it
  // addable (that would be a second way to add the same trust root), and no spelling of it reaches
  // the name rule, a fetch or the owner's prompt.
  assertRegistryNameNotReserved(name);
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
  const indexSha256 = registryIndexDigest(index);
  o.db.transaction(() => {
    insertRegistry(o.db, {
      name,
      url,
      rootKey: index.rootKey,
      rootFingerprint,
      lastSequence: index.sequence,
      lastGeneratedAt: index.generatedAt,
      addedAt: fetch.now(),
      lastIndexSha256: indexSha256,
    });
    recordRegistryFetch(
      o.db,
      name,
      index.rootKey,
      index.sequence,
      index.generatedAt,
      fetch.now(),
      indexSha256,
    );
  })();
  return { kind: "hit", value: summary };
}

/** `registry.install`'s parameters: the id, then the optional registry, version and channel. */
function installParams(rec: Record<string, unknown> | undefined): {
  id: string;
  registry: string | undefined;
  version: string | undefined;
  channel: "stable" | "beta" | undefined;
  acceptPublisherKey: string | undefined;
} {
  const id = stringParam(rec, "id");
  const registry = rec?.["registry"] === undefined ? undefined : stringParam(rec, "registry");
  const version = rec?.["version"] === undefined ? undefined : stringParam(rec, "version");
  const channel = rec?.["channel"];
  if (channel !== undefined && channel !== "stable" && channel !== "beta") {
    throw invalidParams("channel must be stable or beta");
  }
  const accept = rec?.["acceptPublisherKey"];
  if (accept !== undefined && (typeof accept !== "string" || !FINGERPRINT_RE.test(accept))) {
    throw invalidParams("acceptPublisherKey must be a 32-hex-character key fingerprint");
  }
  return { id, registry, version, channel, acceptPublisherKey: accept };
}

/** What `registry.install` needs wired: the owner's HITL gate, the fetch bag, an extensions dir and Vault. */
function installDeps(o: RegistryRpcOptions): {
  ownerGate: RegistryOwnerGate;
  fetch: RegistryFetchBag;
  extensionsDir: string;
  vault: NimbusVault;
} {
  const ownerGate = o.ownerGate;
  if (ownerGate === undefined) {
    throw new RpcMethodError(-32603, "registry.install requires the owner's HITL gate");
  }
  const fetch = requireFetch(o.fetch);
  if (o.extensionsDir === undefined || o.extensionsDir.trim() === "" || o.vault === undefined) {
    throw new RpcMethodError(
      -32603,
      "Gateway is not configured with an extensions directory and Vault",
    );
  }
  return { ownerGate, fetch, extensionsDir: o.extensionsDir, vault: o.vault };
}

async function handleInstall(
  rec: Record<string, unknown> | undefined,
  o: RegistryRpcOptions,
): Promise<Hit> {
  const { id, registry, version, channel, acceptPublisherKey } = installParams(rec);
  const { ownerGate, fetch, extensionsDir, vault } = installDeps(o);
  // Fresh before acting (I48): a revocation published since the last hourly fetch should refuse
  // this install. Unreachable: proceed on stored state and tell the owner how old it is.
  const note = trustFeedNote(await freshenTrustFeed(o.trustFeed, o.db, Date.now()));
  try {
    const installed = await installFromRegistry(
      {
        db: o.db,
        extensionsDir,
        vault,
        fetch,
        // The same HITL action as a local install; the request now also names the registry.
        approve: (request) =>
          ownerGate({
            type: "extension.install",
            payload: { ...request, ...(note === undefined ? {} : { trustFeedNote: note }) },
          }),
      },
      {
        id,
        ...(registry !== undefined && { registry }),
        ...(version !== undefined && { version }),
        ...(channel !== undefined && { channel }),
        ...(acceptPublisherKey !== undefined && { acceptPublisherKey }),
      },
    );
    emitGatewayEvent("extension.stateChanged", {
      extensionId: installed.id,
      action: "install",
      ok: true,
    });
    return {
      kind: "hit",
      value: {
        id: installed.id,
        version: installed.version,
        sourceRegistry: installed.sourceRegistry,
        rootFingerprint: installed.rootFingerprint,
        publisher: installed.publisher,
        installPath: installed.installPath,
        treeDigest: installed.treeDigest,
      },
    };
  } catch (e) {
    emitGatewayEvent("extension.stateChanged", {
      extensionId: id,
      action: "install",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    // A trust block (I48) is a registry-class refusal like the others, not invalid params.
    if (e instanceof RegistryError || e instanceof RpcMethodError || e instanceof TrustBlockError) {
      throw e;
    }
    // A refusal AFTER the owner was involved is internal-class, like `extension.install`'s.
    throw new RpcMethodError(
      e instanceof ExtensionInstallNotApprovedError ? -32603 : -32602,
      e instanceof Error ? e.message : String(e),
    );
  }
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

type RefreshResult = {
  name: string;
  ok: boolean;
  error?: string;
  sequence?: number;
  extensionCount?: number;
};

async function handleRefresh(
  rec: Record<string, unknown> | undefined,
  o: RegistryRpcOptions,
): Promise<Hit> {
  const fetch = requireFetch(o.fetch);
  let targets: RegistryRow[];
  // The owner's registries only, by design: `refresh` maintains the owner's list (what `registry
  // list` shows), and the built-in registry is fetched and verified on every use instead.
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
  // Each registry is fetched, verified and recorded on its own row, so they refresh concurrently;
  // one failing never affects another, and results keep the targets' order.
  const results = await Promise.all(
    targets.map(async (reg): Promise<RefreshResult> => {
      try {
        const index = await fetchVerifiedIndex({ ...fetch, db: o.db }, reg);
        return {
          name: reg.name,
          ok: true,
          sequence: index.sequence,
          extensionCount: Object.keys(index.extensions).length,
        };
      } catch (e) {
        return {
          name: reg.name,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
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

/** Versions of an entry, semver-newest first (across channels). */
function versionsNewestFirst(entry: RegistryExtensionEntry): Array<[string, RegistryVersionEntry]> {
  return Object.entries(entry.versions).sort(([a], [b]) => Bun.semver.order(b, a));
}

async function handleSearch(
  rec: Record<string, unknown> | undefined,
  o: RegistryRpcOptions,
): Promise<Hit> {
  const needle = stringParam(rec, "query").toLowerCase();
  const read = await readIndexes({ ...requireFetch(o.fetch), db: o.db }, listRegistries(o.db));
  const results: Array<{
    registry: string;
    id: string;
    name: string;
    publisherId: string;
    latestStable: string | null;
    latestBeta: string | null;
    /** I48: the publisher key is revoked, or the newest offered version is taken down. */
    blocked: boolean;
    /** R6: the current Nimbus verification lists the index's key for this publisher. */
    verifiedPublisher: VerifiedPublisher | null;
  }> = [];
  for (const { reg, index } of read.ok) {
    for (const [id, entry] of Object.entries(index.extensions)) {
      const versions = versionsNewestFirst(entry);
      const newest = versions[0];
      if (newest === undefined) continue;
      const name = newest[1].name;
      const hay = [id, name, entry.publisher.id].map((v) => v.toLowerCase());
      if (!hay.some((h) => h.includes(needle))) continue;
      const latestStable = versions.find(([, v]) => v.channel === "stable")?.[0] ?? null;
      const latestBeta = versions.find(([, v]) => v.channel === "beta")?.[0] ?? null;
      const offered = latestStable ?? latestBeta ?? newest[0];
      const subject = {
        extensionId: id,
        version: offered,
        publisherId: entry.publisher.id,
        keyFingerprint: publisherKeyFingerprint(entry.publisher.key),
        source: { registry: reg.name, rootFingerprint: reg.rootFingerprint },
      };
      const blocked = blocksFor(o.db, subject).length > 0;
      results.push({
        registry: reg.name,
        id,
        name,
        publisherId: entry.publisher.id,
        latestStable,
        latestBeta,
        blocked,
        verifiedPublisher: verifiedPublisherFor(o.db, subject),
      });
    }
  }
  return { kind: "hit", value: { results, errors: read.errors } };
}

/**
 * Where users report an extension of the registry `found` resolved (spec § 6.11): its signed
 * index's `reportUrl` when that is a valid `https:` URL, else — for the built-in official registry
 * only — the baked one; otherwise `null`. Always the extension's OWN registry, so a third-party
 * extension is never reported to Nimbus's repository.
 */
function reportUrlOf(found: ResolvedEntry, o: RegistryRpcOptions): string | null {
  const fromIndex = readRegistryReportUrl(found.index);
  if (fromIndex !== undefined) return fromIndex;
  if (found.reg.name !== BUILTIN_REGISTRY_NAME) return null;
  return builtinRegistryOf(o.fetch ?? {})?.reportUrl ?? null;
}

async function handleInfo(
  rec: Record<string, unknown> | undefined,
  o: RegistryRpcOptions,
): Promise<Hit> {
  const id = stringParam(rec, "id");
  const registryName = rec?.["registry"] === undefined ? undefined : stringParam(rec, "registry");
  const found = await resolveRegistryEntry(
    { ...requireFetch(o.fetch), db: o.db },
    id,
    registryName,
  );
  // `reportOnly`: the report destination comes from the signed index alone, so an extension whose
  // newest manifest is missing or fails its hash (the case most worth reporting) still has one.
  if (rec?.["reportOnly"] === true) {
    return {
      kind: "hit",
      value: { registry: found.reg.name, id, reportUrl: reportUrlOf(found, o) },
    };
  }
  const entry = found.entry;
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
      reportUrl: reportUrlOf(found, o),
      verifiedPublisher: verifiedPublisherFor(o.db, {
        publisherId: entry.publisher.id,
        keyFingerprint: publisherKeyFingerprint(entry.publisher.key),
        source: { registry: found.reg.name, rootFingerprint: found.reg.rootFingerprint },
      }),
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
      case "registry.install":
        return await handleInstall(rec, o);
      case "registry.search":
        return await handleSearch(rec, o);
      case "registry.info":
        return await handleInfo(rec, o);
      default:
        return { kind: "miss" };
    }
  } catch (e) {
    if (e instanceof RegistryError || e instanceof TrustBlockError) {
      throw new RpcMethodError(-32000, e.message);
    }
    throw e;
  }
}
