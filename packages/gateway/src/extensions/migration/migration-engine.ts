/**
 * The migration state machine that moves an existing user of a bundled connector to its signed
 * extension (Readwise unbundling spec § 7.2, § 7.3). One row per legacy service in
 * `connector_migration` (`migration-store.ts`):
 *
 *   (none | failed | awaiting_approval with its stage missing)
 *        --evaluate: fetch + verify + stage-->        awaiting_approval   (legacy service paused)
 *        --evaluate: fetch or verify fails-->         failed              (legacy service paused)
 *   awaiting_approval --evaluate: stage tampered-->   failed
 *   awaiting_approval --accept: one `extension.migrate` prompt, approved-->
 *        install + run grant (legacy Vault key) + sync registration + resume --> approved
 *   awaiting_approval --accept: any check after the prompt fails--> failed (install undone)
 *   awaiting_approval --decline-->                    declined            (items kept, still paused)
 *
 * `approved` and `declined` are terminal: evaluation never prepares either again. Prepare writes
 * only the staged tree and the row (plus the fetch's own anti-rollback and egress rows) — no
 * `extension` row, no Vault publisher key, no install audit row — so nothing the owner has not
 * agreed to shows up in `nimbus extension list`.
 *
 * Every dependency that decides WHETHER a migration happens is injected — the built-in registry
 * (`BUILTIN_REGISTRY`, `null` in production until gateway PR 7), the continuity table (empty in
 * production until then) and the bundled-connector predicate — so with the production defaults
 * `evaluate()` is a no-op, and tests drive a fixture entry whose legacy id is not bundled.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { publisherKeyFingerprint, RegistryError } from "@nimbus-dev/registry-format";
import type { Logger } from "pino";

import { deleteExtensionById, listExtensions } from "../../automation/extension-store.ts";
import { BUNDLED_CONNECTORS } from "../../connectors/bundled-connector-registry.ts";
import {
  defaultSyncIntervalMsForService,
  normalizeConnectorServiceId,
} from "../../connectors/connector-catalog.ts";
import { transitionHealth } from "../../connectors/health.ts";
import { setPaused, upsertSchedulerRegistration } from "../../sync/scheduler-store.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { approveMigratedExtensionRun, type ExtensionRunGate } from "../approve-run.ts";
import { CONTINUITY_TABLE, type ContinuityEntry } from "../continuity/continuity-table.ts";
import { clearDeps } from "../dependency-store.ts";
import { sortedNames } from "../extension-credentials.ts";
import {
  type ExtensionRunGrantEnv,
  type ResolvedRunGrants,
  resolveExtensionRunGrants,
} from "../extension-run-grants.ts";
import { extensionSpawnPolicyForGrants } from "../extension-runtime.ts";
import { deriveExtensionServiceId } from "../extension-service-id.ts";
import { type ExtensionInstallApprover, extensionInstallDirectory } from "../install-from-local.ts";
import {
  type ExtensionManifest,
  extensionEntryRelPath,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "../manifest.ts";
import { isStrictlyInside } from "../path-containment.ts";
import {
  BUILTIN_REGISTRY,
  BUILTIN_REGISTRY_NAME,
  type BuiltinRegistryConfig,
  builtinRegistryRow,
} from "../registry/builtin-registry.ts";
import {
  fetchVerifiedRegistryPackage,
  type InstallFromRegistryDeps,
  installVerifiedRegistryPackage,
  type VerifiedRegistryPackage,
} from "../registry/install-from-registry.ts";
import type { RegistryFetchDeps } from "../registry/registry-fetch.ts";
import { computeExtensionTreeDigest } from "../tree-digest.ts";
import { migrationRedactionRoots, redactMigrationPaths } from "./migration-redact.ts";
import {
  finishMigration,
  getMigration,
  getMigrationByLegacyService,
  listMigrations,
  type MigrationRow,
  recordMigrationFailed,
  recordMigrationPrepared,
  reopenDeclinedMigration,
} from "./migration-store.ts";

export type { MigrationRow, MigrationState } from "./migration-store.ts";

/** The I2 action type the one migration decision is asked under. */
export const EXTENSION_MIGRATE_ACTION_TYPE = "extension.migrate" as const;

export type MigrationErrorCode =
  | "ERR_EXTENSION_MIGRATION_NOT_FOUND"
  | "ERR_EXTENSION_MIGRATION_NOT_PENDING"
  | "ERR_EXTENSION_MIGRATION_BUSY"
  | "ERR_EXTENSION_MIGRATION_NOT_APPROVED"
  | "ERR_EXTENSION_MIGRATION_FAILED"
  | "ERR_EXTENSION_MIGRATION_RUNTIME_DISABLED"
  | "ERR_EXTENSION_MIGRATION_NO_REGISTRY"
  | "ERR_EXTENSION_MIGRATION_BUNDLED";

/** A refusal from the migration engine. The code leads the message, so a CLI shows it. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  constructor(code: MigrationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MigrationError";
    this.code = code;
  }
}

/**
 * What the owner is shown under `extension.migrate`. Field names avoid every word the consent and
 * audit redactors mask (`key`, `token`, `credential`, `auth`, …): the publisher key's fingerprint is
 * `fingerprint`, as in the install and run prompts. No Vault key and no secret appear anywhere.
 */
export interface MigrationConsentPayload {
  readonly migrationId: string;
  readonly extensionId: string;
  readonly summary: string;
  readonly publisher: { readonly id: string; readonly fingerprint: string };
  readonly version: string;
  readonly network: string;
  /** Present only when the sandbox cannot confine the policy the extension will run under. */
  readonly sandbox?: string;
  readonly readTools: string;
  readonly knownLoss: string;
}

export type MigrationConsent = (payload: MigrationConsentPayload) => Promise<boolean>;

/**
 * The one way to turn the owner's HITL gate into the migration consent: asks under
 * `extension.migrate` (I2 frozen set, never delegable — I20) and nothing else.
 */
export function migrationConsentViaGate(gate: ExtensionRunGate): MigrationConsent {
  return (payload) => gate({ type: EXTENSION_MIGRATE_ACTION_TYPE, payload: { ...payload } });
}

export interface MigrationEngine {
  /** Boot: prepare every configured continuity entry with no approved or declined row. */
  evaluate(): Promise<void>;
  /**
   * `nimbus connector migrate retry`: like `evaluate`, and also re-prepares a DECLINED row (spec
   * § 7.2 step 6, "the command to change their mind, which re-runs Prepare"). Approved rows stay.
   */
  retry(): Promise<void>;
  accept(id: string, consent: MigrationConsent): Promise<MigrationRow>;
  decline(id: string): MigrationRow;
  list(): readonly MigrationRow[];
}

export interface MigrationEngineDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  /** Staging lives under `<dataDir>/migrations/<migration id>/`. */
  readonly dataDir: string;
  readonly extensionsDir: string;
  readonly fetch: Omit<RegistryFetchDeps, "db" | "builtin">;
  /** Absent means the baked `BUILTIN_REGISTRY`; `null` means none (evaluate is then a no-op). */
  readonly builtin?: BuiltinRegistryConfig | null;
  /** Absent means the production `CONTINUITY_TABLE`. */
  readonly continuityTable?: readonly ContinuityEntry[];
  /**
   * Whether a legacy service id is still a bundled connector compiled into this gateway. Absent
   * means the real bundled registry. Such an entry is skipped entirely, so bundled sync and
   * extension sync never both run for one account (spec § 5).
   */
  readonly isBundledConnector?: (serviceId: string) => boolean;
  readonly env: ExtensionRunGrantEnv;
  /** `[extensions] runtime` (and not demo-rooted). `false` refuses accept before the prompt. */
  readonly runtimeEnabled: boolean;
  readonly sandbox: {
    canConfine(policy: ReturnType<typeof extensionSpawnPolicyForGrants>): string | null;
  };
  /** The extension sync registrar (PR 3). */
  readonly extensionSync: { refresh(extensionId: string): void };
  /**
   * The sync scheduler: `resume` clears `paused` AND transitions health; `syncableFor` is how
   * accept checks that the extension took over the LEGACY id (never its own `ext_` id).
   */
  readonly scheduler: {
    resume(serviceId: string): void;
    syncableFor(serviceId: string): unknown;
  };
  readonly now: () => number;
  readonly newId?: () => string;
  readonly logger?: Pick<Logger, "info" | "warn">;
  /**
   * Test seam for the install step; production uses `installVerifiedRegistryPackage`. Never passed
   * in production: `platform/migration-boot.ts` builds the deps field by field, and an I44 source
   * pin confines the name to this file.
   */
  readonly installVerified?: typeof installVerifiedRegistryPackage;
  /**
   * Test seam for removing an undone install's tree; production uses `rmSync`. Same confinement as
   * `installVerified`.
   */
  readonly removeInstallTree?: (path: string) => void;
}

// ---- paused reasons ------------------------------------------------------------------------------

const RETRY = "`nimbus connector migrate retry`";

/** The paused reason while the owner's decision is pending (the brief's wording, verbatim). */
export function awaitingApprovalReason(displayName: string, migrationId: string): string {
  return `${displayName} moved to an extension — run \`nimbus connector migrate accept ${migrationId}\` or answer it in the desktop app`;
}

function failedReason(error: string): string {
  return error.includes(RETRY) ? error : `${error} — run ${RETRY}`;
}

/** The failure text for an extension id that is already installed (prepare and accept share it). */
function alreadyInstalledText(extensionId: string): string {
  return `${extensionId} already installed — remove it, then ${RETRY}`;
}

/** The text a failed prepare records: the already-installed wording, else the error's own message. */
function prepareFailureText(entry: ContinuityEntry, e: unknown): string {
  if (e instanceof RegistryError && e.code === "ERR_REGISTRY_ALREADY_INSTALLED") {
    return alreadyInstalledText(entry.extensionId);
  }
  return e instanceof Error ? e.message : String(e);
}

function declinedReason(displayName: string): string {
  return `${displayName} stays off: moving it to an extension was declined (your items are kept) — run ${RETRY} to change your mind`;
}

const DEFAULT_PAUSED_INTERVAL_MS = 600_000;

function intervalFor(serviceId: string): number {
  const known = normalizeConnectorServiceId(serviceId);
  return known === null ? DEFAULT_PAUSED_INTERVAL_MS : defaultSyncIntervalMsForService(known);
}

/**
 * The ONE way the migration pauses a legacy service. Upserts the `scheduler_state` row first —
 * `setPaused` alone is an UPDATE and silently does nothing when no row exists — then sets
 * `paused = 1` and records the reason on the health row, where `connector status`, `nimbus doctor`
 * and the desktop read it. An existing row keeps its cursor and interval.
 */
export function pauseLegacyService(
  db: Database,
  serviceId: string,
  reason: string,
  now: number = Date.now(),
): void {
  upsertSchedulerRegistration(db, serviceId, intervalFor(serviceId), now, false);
  setPaused(db, serviceId, true);
  transitionHealth(db, serviceId, { type: "paused", reason });
}

// ---- the consent payload -------------------------------------------------------------------------

function displayNameOf(entry: ContinuityEntry): string {
  return entry.displayName ?? entry.legacyServiceId;
}

/** True per OS: on Windows the AppContainer network grant is all-or-nothing (spec § 7.2 step 4). */
function networkLine(platform: NodeJS.Platform, hosts: readonly string[]): string {
  if (hosts.length === 0) return "no network access";
  const list = hosts.join(", ");
  return platform === "win32"
    ? `network access (Windows cannot limit this to ${list})`
    : `network access to ${list}`;
}

function buildConsentPayload(
  row: MigrationRow,
  entry: ContinuityEntry,
  manifest: ExtensionManifest,
  platform: NodeJS.Platform,
  confineRefusal: string | null,
): MigrationConsentPayload {
  const name = displayNameOf(entry);
  const network = networkLine(platform, entry.expectedPermissions.network);
  const credentialNames = sortedNames(entry.credentials).join(", ");
  return {
    migrationId: row.id,
    extensionId: entry.extensionId,
    summary: `${name} moved out of the built-in set and is now an extension from the official Nimbus registry. Keep it? It needs the same access as before: ${network}, your existing ${name} ${credentialNames}.`,
    publisher: {
      id: manifest.publisher?.id ?? "unsigned",
      fingerprint: publisherKeyFingerprint(entry.publisherKey),
    },
    version: manifest.version,
    network,
    ...(confineRefusal === null
      ? {}
      : { sandbox: `sync will stay paused until the sandbox is fixed: ${confineRefusal}` }),
    readTools: `${name}'s live read tools now need your approval per call and are not offered to the model unless you run \`nimbus extension approve ${entry.extensionId} --model\`; questions are still answered from your index.`,
    knownLoss:
      "A few rare items may not carry over: items dated before 1970, or whose metadata is larger than 64 KiB.",
  };
}

// ---- verification against the continuity table --------------------------------------------------

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort((p, q) => (p < q ? -1 : 1));
  const y = [...b].sort((p, q) => (p < q ? -1 : 1));
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function resolveGrantsOrNull(
  manifest: ExtensionManifest,
  root: string,
  env: ExtensionRunGrantEnv,
): ResolvedRunGrants | null {
  try {
    return resolveExtensionRunGrants(manifest.permissions, root, env);
  } catch {
    return null;
  }
}

/**
 * The first field in which the verified package differs from the baked continuity entry, or
 * `null`. Spec § 7.3: a migration only ever re-enables Nimbus-signed code with the same access the
 * owner already granted the built-in connector — never wider permissions or another credential.
 */
function driftFrom(
  entry: ContinuityEntry,
  manifest: ExtensionManifest,
  publisherKey: string,
  rootFingerprint: string,
  root: string,
  env: ExtensionRunGrantEnv,
): string | null {
  if (manifest.id !== entry.extensionId) return "id";
  if (rootFingerprint !== entry.sourceRootFingerprint) return "sourceRootFingerprint";
  if (publisherKey !== entry.publisherKey || manifest.publisher?.key !== entry.publisherKey) {
    return "publisherKey";
  }
  const grants = resolveGrantsOrNull(manifest, root, env);
  if (grants === null) return "permissions";
  const expected = entry.expectedPermissions;
  if (
    !sameSet(
      grants.network,
      expected.network.map((h) => h.toLowerCase()),
    )
  ) {
    return "permissions.network";
  }
  if (!sameSet(grants.read, expected.read)) return "permissions.read";
  if (!sameSet(grants.write, expected.write)) return "permissions.write";
  if (!sameSet(Object.keys(manifest.credentials ?? {}), Object.keys(entry.credentials))) {
    return "credentials";
  }
  if (manifest.sync === undefined || !sameSet(manifest.sync.itemTypes, entry.itemTypes)) {
    return "sync.itemTypes";
  }
  return null;
}

function driftError(entry: ContinuityEntry, field: string): string {
  return `the official ${displayNameOf(entry)} extension does not match what this release expects (${field} differs); nothing was staged`;
}

// ---- staging -------------------------------------------------------------------------------------

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function digestOrNull(root: string): string | null {
  try {
    return computeExtensionTreeDigest(root);
  } catch {
    return null;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type StageCheck =
  | { readonly kind: "intact"; readonly root: string }
  | { readonly kind: "missing" }
  | { readonly kind: "tampered" };

const TAMPERED =
  "the staged package changed after it was verified (tree digest mismatch); it was deleted";
const MISSING = "the staged package is missing";

// ---- the engine ----------------------------------------------------------------------------------

export function createMigrationEngine(deps: MigrationEngineDeps): MigrationEngine {
  const db = deps.db;
  const table = deps.continuityTable ?? CONTINUITY_TABLE;
  const builtin = deps.builtin === undefined ? BUILTIN_REGISTRY : deps.builtin;
  const isBundled =
    deps.isBundledConnector ?? ((id: string) => Object.hasOwn(BUNDLED_CONNECTORS, id));
  const newId = deps.newId ?? randomUUID;
  const install = deps.installVerified ?? installVerifiedRegistryPackage;
  const migrationsRoot = join(deps.dataDir, "migrations");
  /**
   * Every error text the engine stores or throws is path-free: it reaches the row, the health row's
   * paused reason (`nimbus doctor`, `connector.listStatus`, the desktop) and the refusal message.
   */
  const redactRoots = migrationRedactionRoots([deps.dataDir, deps.extensionsDir, migrationsRoot]);
  const pathFree = (text: string): string => redactMigrationPaths(text, redactRoots);
  /** Legacy service ids with a prepare or an accept in flight in THIS process. */
  const busy = new Set<string>();
  let evaluating: Promise<void> | null = null;
  let retrying: Promise<void> | null = null;

  const stageDirFor = (id: string): string => {
    if (!SAFE_ID.test(id)) throw new Error("migration id is not a safe path segment");
    return join(migrationsRoot, id);
  };

  /** Removes a migration's own staging directory — derived from its id, never a stored path. */
  const removeStage = (id: string): void => {
    try {
      rmSync(stageDirFor(id), { recursive: true, force: true });
    } catch (e) {
      deps.logger?.warn(
        { migrationId: id, err: e instanceof Error ? e.message : String(e) },
        "migration staging directory could not be removed",
      );
    }
  };

  const checkStage = (row: MigrationRow): StageCheck => {
    const stagePath = row.stagePath;
    if (stagePath === null || !SAFE_ID.test(row.id)) return { kind: "missing" };
    if (!isStrictlyInside(stageDirFor(row.id), stagePath)) return { kind: "tampered" };
    if (!existsSync(stagePath)) return { kind: "missing" };
    const live = digestOrNull(stagePath);
    return live !== null && live === row.treeDigest
      ? { kind: "intact", root: stagePath }
      : { kind: "tampered" };
  };

  const entryFor = (row: MigrationRow): ContinuityEntry | undefined =>
    table.find(
      (e) => e.legacyServiceId === row.legacyServiceId && e.extensionId === row.extensionId,
    );

  const installDeps = (
    reg: BuiltinRegistryConfig,
    approve: ExtensionInstallApprover,
  ): InstallFromRegistryDeps => ({
    db,
    extensionsDir: deps.extensionsDir,
    vault: deps.vault,
    fetch: { ...deps.fetch, builtin: reg },
    approve,
  });

  /** Every credential the entry maps is non-blank in the Vault. The value is never kept. */
  const legacyConfigured = async (entry: ContinuityEntry): Promise<boolean> => {
    const keys = Object.values(entry.credentials);
    if (keys.length === 0) return false;
    for (const key of keys) {
      const v = await deps.vault.get(key); // NOSONAR S9382: sequential, a handful of keys
      if (v === null || v.trim() === "") return false;
    }
    return true;
  };

  const markFailed = (entry: ContinuityEntry, id: string, rawError: string): void => {
    const error = pathFree(rawError);
    removeStage(id);
    const written = recordMigrationFailed(
      db,
      {
        id,
        legacyServiceId: entry.legacyServiceId,
        extensionId: entry.extensionId,
        error,
      },
      deps.now(),
    );
    // Refused: the row reached a terminal state meanwhile (the owner declined). Never pause on its
    // behalf — that state's own reason stands.
    if (written) pauseLegacyService(db, entry.legacyServiceId, failedReason(error), deps.now());
  };

  const prepare = async (
    entry: ContinuityEntry,
    reg: BuiltinRegistryConfig,
    existing: MigrationRow | undefined,
  ): Promise<void> => {
    const id = existing?.id ?? newId();
    removeStage(id);
    // Prepare never installs: an approver that refuses makes that structural, not a convention.
    const refuse: ExtensionInstallApprover = () => Promise.resolve(false);
    let pkg: VerifiedRegistryPackage;
    try {
      pkg = await fetchVerifiedRegistryPackage(
        installDeps(reg, refuse),
        { id: entry.extensionId, registry: BUILTIN_REGISTRY_NAME },
        stageDirFor(id),
      );
    } catch (e) {
      markFailed(entry, id, prepareFailureText(entry, e));
      return;
    }
    const drift = driftFrom(
      entry,
      pkg.manifest,
      pkg.publisherKey,
      pkg.rootFingerprint,
      pkg.sourceRoot,
      deps.env,
    );
    const treeDigest = drift === null ? digestOrNull(pkg.sourceRoot) : null;
    if (drift !== null || treeDigest === null) {
      markFailed(
        entry,
        id,
        drift === null ? "the staged package could not be digested" : driftError(entry, drift),
      );
      return;
    }
    const written = recordMigrationPrepared(
      db,
      {
        id,
        legacyServiceId: entry.legacyServiceId,
        extensionId: entry.extensionId,
        version: pkg.version,
        treeDigest,
        stagePath: pkg.sourceRoot,
      },
      deps.now(),
    );
    if (!written) {
      // The row reached a terminal state while the package was fetched: nothing staged for it may
      // remain, and the legacy service is not paused on its behalf.
      removeStage(id);
      return;
    }
    pauseLegacyService(
      db,
      entry.legacyServiceId,
      awaitingApprovalReason(displayNameOf(entry), id),
      deps.now(),
    );
  };

  /**
   * `reopen` is `migrate retry`'s: it also re-prepares a DECLINED row (spec § 7.2 step 6, the
   * owner changing their mind). Boot evaluation never does, so a decline is never re-prompted.
   */
  const evaluateOne = async (
    entry: ContinuityEntry,
    reg: BuiltinRegistryConfig,
    reopen: boolean,
  ): Promise<void> => {
    if (isBundled(entry.legacyServiceId)) {
      deps.logger?.info(
        { legacyServiceId: entry.legacyServiceId, extensionId: entry.extensionId },
        "connector migration skipped: the bundled connector is still part of this gateway",
      );
      return;
    }
    const skips = (row: MigrationRow | undefined): boolean =>
      row?.state === "approved" || (row?.state === "declined" && !reopen);
    if (busy.has(entry.legacyServiceId)) return;
    if (skips(getMigrationByLegacyService(db, entry.legacyServiceId))) return;
    if (!(await legacyConfigured(entry))) return;
    if (busy.has(entry.legacyServiceId)) return;
    busy.add(entry.legacyServiceId);
    try {
      // Re-read under `busy`: a decline (or an accept) can land while the Vault read above awaits.
      const existing = getMigrationByLegacyService(db, entry.legacyServiceId);
      if (skips(existing)) return;
      if (existing?.state === "declined" && !reopenDeclinedMigration(db, existing.id, deps.now())) {
        return;
      }
      if (existing?.state === "awaiting_approval" && existing.extensionId === entry.extensionId) {
        const stage = checkStage(existing);
        if (stage.kind === "intact") return;
        if (stage.kind === "tampered") {
          removeStage(existing.id);
          finishMigration(db, existing.id, "failed", TAMPERED, deps.now());
          pauseLegacyService(db, entry.legacyServiceId, failedReason(TAMPERED), deps.now());
          return;
        }
      }
      await prepare(entry, reg, existing);
    } finally {
      busy.delete(entry.legacyServiceId);
    }
  };

  const runEvaluate = async (reopen: boolean): Promise<void> => {
    if (builtin === null) return;
    for (const entry of table) {
      try {
        await evaluateOne(entry, builtin, reopen); // NOSONAR S9382: sequential by design, one fetch at a time
      } catch (e) {
        deps.logger?.warn(
          {
            legacyServiceId: entry.legacyServiceId,
            err: e instanceof Error ? e.message : String(e),
          },
          "connector migration evaluation failed",
        );
      }
    }
  };

  const requirePending = (id: string): MigrationRow => {
    const row = getMigration(db, id);
    if (row === undefined) {
      throw new MigrationError("ERR_EXTENSION_MIGRATION_NOT_FOUND", `no migration "${id}"`);
    }
    if (row.state !== "awaiting_approval") {
      throw new MigrationError(
        "ERR_EXTENSION_MIGRATION_NOT_PENDING",
        `migration "${id}" is ${row.state}, not awaiting approval`,
      );
    }
    if (busy.has(row.legacyServiceId)) {
      throw new MigrationError(
        "ERR_EXTENSION_MIGRATION_BUSY",
        `migration "${id}" is already being prepared or answered`,
      );
    }
    return row;
  };

  /** Fails an accepted row: stage deleted, row `failed`, legacy service still paused, error thrown. */
  const failAccept = (row: MigrationRow, rawError: string): never => {
    const error = pathFree(rawError);
    removeStage(row.id);
    finishMigration(db, row.id, "failed", error, deps.now());
    pauseLegacyService(db, row.legacyServiceId, failedReason(error), deps.now());
    throw new MigrationError("ERR_EXTENSION_MIGRATION_FAILED", error);
  };

  const requireIntactStage = (row: MigrationRow): string => {
    const stage = checkStage(row);
    if (stage.kind === "intact") return stage.root;
    return failAccept(row, stage.kind === "missing" ? MISSING : TAMPERED);
  };

  const readStagedManifest = (row: MigrationRow, root: string): ExtensionManifest => {
    const p = resolveExtensionManifestPath(root);
    if (p === undefined) return failAccept(row, "the staged package has no manifest");
    try {
      return parseExtensionManifestJson(readFileSync(p, "utf8"));
    } catch (e) {
      return failAccept(
        row,
        `the staged manifest could not be read: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const removeTree =
    deps.removeInstallTree ?? ((p: string): void => rmSync(p, { recursive: true, force: true }));

  const undoInstall = (extensionId: string, installPath: string): void => {
    // The same undo `installVerifiedRegistryPackage` performs on an entry-hash mismatch. The rows
    // go first: with no extension row (and so no grant) the leftover files can never run, sync or
    // be listed.
    clearDeps(db, extensionId);
    deleteExtensionById(db, extensionId);
    // Best effort: on Windows a file still held open (an antivirus scan, an indexer) makes this throw
    // EBUSY/EPERM. That must not skip what the caller does next — unregistering the syncable and
    // failing the row — or the migration would stay `awaiting_approval` with its sync registered.
    try {
      removeTree(installPath);
    } catch (e) {
      // The local log names the path (it never leaves the machine), so the owner can find it.
      deps.logger?.warn(
        { extensionId, installPath, err: e instanceof Error ? e.message : String(e) },
        "an undone migration install could not be removed from disk; it has no row and cannot run",
      );
    }
  };

  /**
   * A previous accept's undo could not remove its files (M1: the rows go first, so they can never
   * run). Left there, the next install would refuse on its destination. The caller has already
   * refused an installed id, so there is no extension row for the id: the directory is that leftover
   * and nothing else can use it, so it is removed here — before the
   * prompt, so the owner is never asked a question that cannot succeed. If it still cannot be
   * removed, the row fails with a message that names the extension and what to do, never the path.
   */
  const clearLeftoverInstall = (row: MigrationRow, entry: ContinuityEntry): void => {
    const dir = extensionInstallDirectory(deps.extensionsDir, entry.extensionId);
    if (!existsSync(dir)) return;
    try {
      removeTree(dir);
    } catch (e) {
      deps.logger?.warn(
        {
          extensionId: entry.extensionId,
          installPath: dir,
          err: e instanceof Error ? e.message : String(e),
        },
        "a leftover migration install could not be removed",
      );
    }
    if (!existsSync(dir)) return;
    failAccept(
      row,
      `files from an earlier attempt to install ${entry.extensionId} are still in the Nimbus extensions directory and could not be removed (another program may have them open) — close it or restart the computer, delete the "${entry.extensionId}" folder in the extensions directory if it is still there, then run \`nimbus connector migrate retry\``,
    );
  };

  /**
   * Spec § 7.2 step 5: the extension must write into the EXISTING legacy namespace, so items are
   * updated in place and never duplicated. The registrar binds through its own continuity table;
   * this checks the outcome rather than trusting that both tables agree: nothing may hold the
   * legacy id before the refresh, the refresh must register a syncable under it, and none under the
   * extension's own `ext_` id. Throws otherwise.
   */
  const registerUnderLegacyId = (row: MigrationRow, entry: ContinuityEntry): void => {
    const codeServerId = deriveExtensionServiceId(entry.extensionId);
    if (deps.scheduler.syncableFor(row.legacyServiceId) !== undefined) {
      throw new Error(
        `another syncable already uses ${row.legacyServiceId}, so the extension could not take over its sync`,
      );
    }
    deps.extensionSync.refresh(entry.extensionId);
    if (deps.scheduler.syncableFor(codeServerId) !== undefined) {
      throw new Error(
        `the extension's sync registered under its own id ${codeServerId} instead of ${row.legacyServiceId}, which would duplicate your items`,
      );
    }
    if (deps.scheduler.syncableFor(row.legacyServiceId) === undefined) {
      throw new Error(`the extension's sync was not registered under ${row.legacyServiceId}`);
    }
  };

  /** What must hold before an accept does anything: a known entry, a registry, the runtime, no bundle. */
  const requireAcceptable = (
    row: MigrationRow,
  ): { entry: ContinuityEntry; reg: BuiltinRegistryConfig } => {
    const entry = entryFor(row);
    if (entry === undefined) {
      return failAccept(row, "this release no longer migrates this connector");
    }
    if (builtin === null) {
      throw new MigrationError(
        "ERR_EXTENSION_MIGRATION_NO_REGISTRY",
        "this gateway has no built-in official registry; nothing was changed",
      );
    }
    if (!deps.runtimeEnabled) {
      throw new MigrationError(
        "ERR_EXTENSION_MIGRATION_RUNTIME_DISABLED",
        "the extension runtime is off on this gateway (`[extensions] runtime = false`, or a demo gateway); nothing was changed",
      );
    }
    if (isBundled(row.legacyServiceId)) {
      throw new MigrationError(
        "ERR_EXTENSION_MIGRATION_BUNDLED",
        `${row.legacyServiceId} is still a built-in connector of this gateway; nothing was changed`,
      );
    }
    return { entry, reg: builtin };
  };

  /**
   * Installs the verified staged package with the migration approver and checks the installed tree
   * against the digest verified at prepare. Any failure fails the row (an install that landed but
   * differs is undone first).
   */
  const installStaged = async (
    row: MigrationRow,
    entry: ContinuityEntry,
    reg: BuiltinRegistryConfig,
    staged: { root: string; manifest: ExtensionManifest; rootFingerprint: string },
  ): Promise<Awaited<ReturnType<typeof installVerifiedRegistryPackage>>> => {
    const { root, manifest, rootFingerprint } = staged;
    const entryPath = resolve(root, extensionEntryRelPath(manifest));
    if (!isStrictlyInside(root, entryPath) || !existsSync(entryPath)) {
      return failAccept(row, "the staged package has no entry file");
    }
    const pkg: VerifiedRegistryPackage = {
      id: entry.extensionId,
      version: manifest.version,
      sourceRoot: root,
      manifest,
      publisherKey: entry.publisherKey,
      entryHash: sha256File(entryPath),
      reg: builtinRegistryRow(db, reg),
      rootFingerprint,
    };
    // The owner's `extension.migrate` answer IS the install consent (spec § 7.2 step 4: one
    // approval covers install + run grant + credential grant). This approver exists only here,
    // after that answer was `true`; it is never exported and never built anywhere else.
    const approvedByMigrationConsent: ExtensionInstallApprover = () => Promise.resolve(true);
    let installed: Awaited<ReturnType<typeof installVerifiedRegistryPackage>>;
    try {
      installed = await install(installDeps(reg, approvedByMigrationConsent), pkg, "stable");
    } catch (e) {
      return failAccept(
        row,
        `the extension could not be installed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const installedRow = listExtensions(db).find((r) => r.id === entry.extensionId);
    if (installedRow?.tree_digest !== row.treeDigest || installed.treeDigest !== row.treeDigest) {
      undoInstall(entry.extensionId, installed.installPath);
      return failAccept(
        row,
        "the installed files differ from the verified package (tree digest mismatch); the install was undone",
      );
    }
    return installed;
  };

  const acceptLocked = async (
    row: MigrationRow,
    consent: MigrationConsent,
  ): Promise<MigrationRow> => {
    const { entry, reg: builtinReg } = requireAcceptable(row);
    const root = requireIntactStage(row);
    const manifest = readStagedManifest(row, root);
    const rootFingerprint = publisherKeyFingerprint(builtinReg.rootKey);
    const drift = driftFrom(entry, manifest, entry.publisherKey, rootFingerprint, root, deps.env);
    if (drift !== null) return failAccept(row, driftError(entry, drift));
    const grants = resolveGrantsOrNull(manifest, root, deps.env);
    if (grants === null) return failAccept(row, driftError(entry, "permissions"));
    const confineRefusal = deps.sandbox.canConfine(
      extensionSpawnPolicyForGrants(
        deriveExtensionServiceId(entry.extensionId),
        grants,
        deps.env.runtimeReadPaths,
      ),
    );

    // An extension id another migration (or the owner) already installed is not ours to replace, and
    // a later failure of this accept would undo THAT install. Refused before the prompt, with the
    // wording prepare uses (B9); the undo below therefore only ever removes what this accept made.
    if (listExtensions(db).some((r) => r.id === entry.extensionId)) {
      return failAccept(row, alreadyInstalledText(entry.extensionId));
    }
    clearLeftoverInstall(row, entry);
    const approved = await consent(
      buildConsentPayload(row, entry, manifest, deps.env.platform, confineRefusal),
    );
    if (!approved) {
      throw new MigrationError(
        "ERR_EXTENSION_MIGRATION_NOT_APPROVED",
        `moving ${row.legacyServiceId} to ${entry.extensionId} was not approved; nothing was changed`,
      );
    }

    // The prompt may have been open for a while: what is installed must be what was verified.
    requireIntactStage(row);
    const installed = await installStaged(row, entry, builtinReg, {
      root,
      manifest,
      rootFingerprint,
    });
    try {
      await approveMigratedExtensionRun(
        {
          db,
          env: deps.env,
          runtimeEnabled: deps.runtimeEnabled,
          now: deps.now,
          continuityTable: table,
        },
        entry.extensionId,
      );
    } catch (e) {
      undoInstall(entry.extensionId, installed.installPath);
      return failAccept(
        row,
        `the run approval could not be recorded: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // From here the extension is installed and granted. Any failure undoes both (the grant goes
    // with the extension row), unregisters whatever the registrar registered, fails the row and
    // leaves the legacy service paused — never a half-approved migration.
    try {
      registerUnderLegacyId(row, entry);
      deps.scheduler.resume(row.legacyServiceId);
      if (!finishMigration(db, row.id, "approved", null, deps.now())) {
        throw new Error("the migration row changed while it was being approved");
      }
    } catch (e) {
      undoInstall(entry.extensionId, installed.installPath);
      try {
        deps.extensionSync.refresh(entry.extensionId); // the row is gone: this unregisters it
      } catch {
        // Best effort: the extension's row and grant are gone, so it can never sync or spawn.
      }
      return failAccept(
        row,
        `${e instanceof Error ? e.message : String(e)}; the install was undone`,
      );
    }
    removeStage(row.id);
    const done = getMigration(db, row.id);
    if (done === undefined) throw new Error("the migration row disappeared");
    return done;
  };

  return {
    evaluate() {
      if (evaluating !== null) return evaluating;
      evaluating = runEvaluate(false).finally(() => {
        evaluating = null;
      });
      return evaluating;
    },

    async retry() {
      // After any evaluation already in flight, so the two never prepare one entry at once.
      if (evaluating !== null) await evaluating;
      if (retrying !== null) return retrying;
      retrying = runEvaluate(true).finally(() => {
        retrying = null;
      });
      return retrying;
    },

    async accept(id, consent) {
      const row = requirePending(id);
      busy.add(row.legacyServiceId);
      try {
        return await acceptLocked(row, consent);
      } finally {
        busy.delete(row.legacyServiceId);
      }
    },

    decline(id) {
      const row = requirePending(id);
      // The store's guarded UPDATE is the arbiter: a row another writer already moved is not ours
      // to decline, so nothing else (stage, pause) changes and no success is reported.
      if (!finishMigration(db, row.id, "declined", null, deps.now())) {
        throw new MigrationError(
          "ERR_EXTENSION_MIGRATION_NOT_PENDING",
          `migration "${row.id}" changed while it was being declined; nothing was changed`,
        );
      }
      removeStage(row.id);
      const entry = entryFor(row);
      pauseLegacyService(
        db,
        row.legacyServiceId,
        declinedReason(entry === undefined ? row.legacyServiceId : displayNameOf(entry)),
        deps.now(),
      );
      const done = getMigration(db, row.id);
      if (done === undefined) throw new Error("the migration row disappeared");
      return done;
    },

    list() {
      return listMigrations(db);
    },
  };
}
