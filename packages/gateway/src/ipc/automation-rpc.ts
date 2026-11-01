import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import pino, { type Logger } from "pino";
import {
  deleteExtensionById,
  type ExtensionRow,
  listExtensions,
  setExtensionEnabled,
  setExtensionTreeDigest,
} from "../automation/extension-store.ts";
import {
  countItemsMatchingGraphPredicate,
  listCandidateGraphRelations,
  parseGraphPredicate,
} from "../automation/graph-predicate.ts";
import {
  supportsAffectedServiceFilter,
  watcherConditionKind,
} from "../automation/watcher-condition-kinds.ts";
import { listWatcherHistory } from "../automation/watcher-history.ts";
import {
  deleteWatcher,
  insertWatcher,
  listWatchers,
  setWatcherEnabled,
} from "../automation/watcher-store.ts";
import { listWorkflowRuns } from "../automation/workflow-run-history.ts";
import {
  deleteWorkflowByName,
  listWorkflows,
  upsertWorkflowByName,
} from "../automation/workflow-store.ts";
import {
  type ExtensionManifestReader,
  readInstalledManifest,
} from "../connectors/extension-sync/extension-identity.ts";
import { deleteConnectorHealthRow } from "../connectors/health.ts";
import {
  approveExtensionRun,
  currentRunCredentials,
  readVerifiedManifest,
  revokeExtensionRun,
} from "../extensions/approve-run.ts";
import { type AutoUpdateRpcDeps, dispatchAutoUpdateRpc } from "../extensions/auto-update-rpc.ts";
import {
  type ConnectorRequirementDeps,
  type ConnectorRequirementInput,
  type ConnectorRequirementStatus,
  type ConnectorRequirementStatusesFn,
  connectorRequirementStatusesByExtension,
  installedConnectorRequirementStatuses,
  installedConnectorRequirements,
} from "../extensions/connector-requirements.ts";
import type { ContinuityEntry } from "../extensions/continuity/continuity-table.ts";
import { clearDeps, forwardDeps, reverseDeps } from "../extensions/dependency-store.ts";
import {
  CREDENTIAL_POST_CONSENT_CODES,
  type CredentialReadDeps,
  ExtensionCredentialError,
  extensionCredentialStatus,
  setExtensionCredential,
} from "../extensions/extension-credential-set.ts";
import type { ReachRunner } from "../extensions/extension-reach.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import { deriveExtensionServiceId } from "../extensions/extension-service-id.ts";
import {
  PRE_T2_DISABLE_REASON,
  preT2DisabledIds,
  preT2DisableMessage,
  RECOVERED_PENDING_REHASH_REASON,
  recoveredPendingRehashMessage,
  recoveredPendingRehashRegistry,
  signatureDisabledRegistry,
  signatureDisableMessage,
} from "../extensions/hard-disable.ts";
import {
  ExtensionInstallNotApprovedError,
  installExtensionFromLocalDirectory,
  installedKindOf,
  isPromotedInstall,
  reportIncompleteRollback,
} from "../extensions/install-from-local.ts";
import {
  EvalApprovalDenied,
  evaluateInstalledExtensions,
  type InstalledEvalDeps,
} from "../extensions/installed-eval.ts";
import { orphanedDependencies, unneededDependencies } from "../extensions/orphaned-dependencies.ts";
import { ExtensionRunGrantError } from "../extensions/run-grant-error.ts";
import {
  type ExtensionRunGrantRow,
  getRunGrant,
  listRunGrants,
} from "../extensions/run-grant-store.ts";
import { extensionRunFields } from "../extensions/run-state.ts";
import { computeExtensionTreeDigest } from "../extensions/tree-digest.ts";
import {
  blockSubjectForInstalled,
  blocksForInstalled,
  type TrustBlock,
} from "../extensions/trust/trust-blocks.ts";
import {
  type VerifiedPublisher,
  verifiedPublisherFor,
} from "../extensions/trust/verified-publisher.ts";
import { verifyOneExtensionStrict } from "../extensions/verify-extensions.ts";
import type { SignatureDisableReason } from "../extensions/verify-signature.ts";
import { newestPrevVersion, removeExtensionVersionStore } from "../extensions/version-store.ts";
import type { NimbusVault } from "../vault/index.ts";
import { asRecord } from "./connector-rpc-shared.ts";
import { emitGatewayEvent } from "./gateway-events.ts";
import { requireTrimmedStringField } from "./rpc-params.ts";

export class AutomationRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
    this.name = "AutomationRpcError";
  }
}

type Hit = { kind: "hit"; value: unknown };

/** `rec[key]`, trimmed, or `Missing or invalid <key>` as an `AutomationRpcError`. */
function requireString(rec: Record<string, unknown> | undefined, key: string): string {
  return requireTrimmedStringField(rec, key, AutomationRpcError);
}

function requireNumber(rec: Record<string, unknown> | undefined, key: string): number {
  if (rec === undefined) {
    throw new AutomationRpcError(-32602, `Missing or invalid ${key}`);
  }
  const v = rec[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AutomationRpcError(-32602, `Missing or invalid ${key}`);
  }
  return v;
}

function handleValidateCondition(rec: Record<string, unknown> | undefined, db: Database): Hit {
  const graphPredicateJson = requireString(rec, "graphPredicateJson");
  const sinceMs = requireNumber(rec, "sinceMs");
  const parsed = parseGraphPredicate(graphPredicateJson);
  if (!parsed.ok) {
    throw new AutomationRpcError(-32602, parsed.error);
  }
  return {
    kind: "hit",
    value: {
      matchCount: countItemsMatchingGraphPredicate({ db, predicate: parsed.predicate, sinceMs }),
    },
  };
}

export interface AutomationRpcExtensionMeshHandle {
  /** Stops the extension's live client; keyed on the extension id, so it works after the grant is gone. */
  stopExtensionClient(extensionId: string): Promise<void>;
  /** Whether the mesh holds a live client for the extension — `list`/`info`'s `running` state. */
  isExtensionRunning(extensionId: string): boolean;
  /** Deletes the extension's stage root (and its old `ext.<serviceId>` leaf). Best-effort, never throws. */
  removeExtensionSandbox(serviceId: string): Promise<void>;
}

/**
 * The extension sync host's lifecycle hooks (`platform/register-extension-sync.ts`): every handler
 * that changes whether an extension may sync calls `refresh`, and `extension.remove` unregisters and
 * purges under the extension's INDEX id before its row and grant are deleted. Absent ⇒ no extension
 * sync host is running (tests, or a gateway that never built one).
 */
export interface AutomationRpcExtensionSyncHandle {
  refresh(extensionId: string): void;
  /** The id `refresh` registered the extension's sync under; `undefined` when it holds none. */
  syncServiceIdFor(extensionId: string): string | undefined;
  unregister(extensionId: string): void;
  purgeBeforeRemove(extensionId: string): Promise<unknown>;
}

/**
 * The local owner's HITL gate, as the executor runs it (`ToolExecutor.gate`): resolves `true` only
 * for "proceed". Built per call by the server dispatcher with the caller's own consent channel, so
 * the prompt reaches the client that asked.
 */
export type AutomationOwnerGate = (action: {
  type: string;
  payload: Record<string, unknown>;
}) => Promise<boolean>;

/** What `extension.eval` needs beyond the DB, Vault and owner gate; the extras are test seams. */
export type AutomationEvalDeps = Pick<
  InstalledEvalDeps,
  "sandboxDir" | "runtimeReadPaths" | "canConfine" | "createClient" | "verify" | "load" | "run"
>;

interface AutomationCtx {
  db: Database;
  extensionsDir?: string;
  mesh?: AutomationRpcExtensionMeshHandle;
  vault?: NimbusVault;
  autoUpdate?: AutoUpdateRpcDeps;
  ownerGate?: AutomationOwnerGate;
  runGrantEnv?: ExtensionRunGrantEnv;
  /** The sandbox runner the run approval describes network reach from. */
  sandboxRunner?: ReachRunner;
  evalDeps?: AutomationEvalDeps;
  /** `[extensions] runtime` and not demo-rooted; absent means the default, `true`. */
  runtimeEnabled?: boolean;
  extensionSync?: AutomationRpcExtensionSyncHandle;
  /** The composition's continuity table; absent means the production default. */
  continuityTable?: readonly ContinuityEntry[];
  /** Test seam: stands in for `connectorRequirementStatuses`; production never passes it. */
  requirementStatuses?: ConnectorRequirementStatusesFn;
  /** Test seam: where an incomplete install rollback is warned; absent means this module's logger. */
  logger?: Pick<Logger, "warn">;
}

const automationRpcLog = pino({
  name: "automation-rpc",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

type AutomationHandler = (
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
) => Hit | Promise<Hit>;

/**
 * Does this `conditionJson` carry a `filter.affectedService`?
 *
 * Deliberately narrow, and deliberately NOT a general condition-JSON validator: `conditionJson`
 * has always been stored as an opaque string here, and tightening that wholesale would reject
 * rows this endpoint accepts today. Unparseable JSON, a non-object filter, or a non-string
 * `affectedService` all answer `false` and leave the pre-existing behaviour exactly as it was —
 * the only NEW rejection is the one case that is provably inert: a real `affectedService` string
 * on a condition kind whose items have no graph entity to match it against.
 */
function declaresAffectedServiceFilter(conditionJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(conditionJson);
  } catch {
    return false;
  }
  const cond = asRecord(parsed);
  const filter = cond === undefined ? undefined : asRecord(cond["filter"]);
  return filter !== undefined && typeof filter["affectedService"] === "string";
}

/** `extension.remove` without `force`: refuses while another installed extension depends on `id`. */
function refuseRemoveWithDependents(db: Database, id: string): void {
  const rdeps = reverseDeps(db, id);
  if (rdeps.length > 0) {
    const blockers = rdeps.map((r) => ({ id: r.extensionId, range: r.range }));
    const blockerDesc = blockers.map((b) => `${b.id} (${b.range})`).join(", ");
    throw new AutomationRpcError(
      -32603,
      `reverse_dep_blocked: Cannot remove ${id}: required by ${blockerDesc}. Pass --force to override.`,
    );
  }
}

/**
 * `extension.remove`, once the row and grant are gone: stops the live child, then removes its
 * stage root, then the `ext_` health row a refused or failed spawn recorded — in that order.
 */
async function stopAndCleanUpRemovedExtension(
  ctx: AutomationCtx,
  id: string,
  serviceId: string | undefined,
): Promise<void> {
  if (ctx.mesh !== undefined) {
    await stopExtensionBestEffort(ctx.mesh, id);
    if (serviceId !== undefined) await ctx.mesh.removeExtensionSandbox(serviceId);
  }
  if (serviceId !== undefined) deleteConnectorHealthRow(ctx.db, serviceId);
}

/** `extension.remove`, last: the install dir and version store. Best-effort; the row is gone. */
function removeExtensionFiles(ctx: AutomationCtx, id: string, installPath: string): void {
  try {
    rmSync(installPath, { recursive: true, force: true });
    if (ctx.extensionsDir !== undefined) removeExtensionVersionStore(ctx.extensionsDir, id);
  } catch {
    /* row already removed; best-effort filesystem cleanup */
  }
}

const AUTOMATION_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
  "watcher.list": (_rec, ctx) => ({
    kind: "hit",
    value: { watchers: listWatchers(ctx.db) },
  }),

  "watcher.create": (rec, ctx) => {
    const graphPredicateJson =
      rec !== undefined && typeof rec["graphPredicateJson"] === "string"
        ? rec["graphPredicateJson"]
        : null;
    const name = requireString(rec, "name");
    const conditionType = requireString(rec, "conditionType");
    const kind = watcherConditionKind(conditionType);
    if (kind === undefined) {
      throw new AutomationRpcError(
        -32602,
        `Unsupported conditionType "${conditionType}" — the watcher engine cannot evaluate it`,
      );
    }
    const conditionJson = requireString(rec, "conditionJson");
    if (declaresAffectedServiceFilter(conditionJson) && !supportsAffectedServiceFilter(kind)) {
      throw new AutomationRpcError(
        -32602,
        `conditionType "${conditionType}" does not support a filter.affectedService — ` +
          "no graph entity carries an affected service for it, so the watcher could never fire",
      );
    }
    const id = insertWatcher(ctx.db, {
      name,
      enabled: 1,
      condition_type: conditionType,
      condition_json: conditionJson,
      action_type: requireString(rec, "actionType"),
      action_json: requireString(rec, "actionJson"),
      created_at: Date.now(),
      graph_predicate_json: graphPredicateJson,
    });
    return { kind: "hit", value: { id } };
  },

  "watcher.delete": (rec, ctx) => {
    deleteWatcher(ctx.db, requireString(rec, "id"));
    return { kind: "hit", value: { ok: true } };
  },

  "watcher.pause": (rec, ctx) => ({
    kind: "hit",
    value: { ok: setWatcherEnabled(ctx.db, requireString(rec, "id"), false) },
  }),

  "watcher.resume": (rec, ctx) => ({
    kind: "hit",
    value: { ok: setWatcherEnabled(ctx.db, requireString(rec, "id"), true) },
  }),

  "watcher.listCandidateRelations": () => ({
    kind: "hit",
    value: { relations: listCandidateGraphRelations() },
  }),

  "watcher.validateCondition": (rec, ctx) => handleValidateCondition(rec, ctx.db),

  "watcher.listHistory": (rec, ctx) => ({
    kind: "hit",
    value: listWatcherHistory(ctx.db, {
      watcherId: requireString(rec, "watcherId"),
      limit: requireNumber(rec, "limit"),
    }),
  }),

  "extension.list": (rec, ctx) => handleExtensionList(rec, ctx),

  "extension.info": (rec, ctx) => handleExtensionInfo(rec, ctx),

  "extension.eval": (rec, ctx) => handleExtensionEval(rec, ctx),

  "extension.install": async (rec, ctx) => {
    const sourcePath = requireString(rec, "sourcePath");
    try {
      const out = await handleExtensionInstall(rec, ctx);
      const value = asRecord(out.value);
      const installedId =
        value !== undefined && typeof value["id"] === "string" ? value["id"] : sourcePath;
      emitGatewayEvent("extension.stateChanged", {
        extensionId: installedId,
        action: "install",
        ok: true,
      });
      return out;
    } catch (e) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: sourcePath,
        action: "install",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  "extension.rehash": async (rec, ctx) => handleExtensionRehash(rec, ctx),

  "extension.approveRun": async (rec, ctx) => handleExtensionApproveRun(rec, ctx),

  "extension.revokeRun": async (rec, ctx) => handleExtensionRevokeRun(rec, ctx),

  "extension.credentialSet": async (rec, ctx) => handleExtensionCredentialSet(rec, ctx),

  "extension.credentialStatus": async (rec, ctx) => handleExtensionCredentialStatus(rec, ctx),

  "extension.checkForUpdates": async (rec, ctx) =>
    handleAutoUpdateRpc("extension.checkForUpdates", rec, ctx),

  "extension.update": async (rec, ctx) => {
    // Soft extraction, not `requireString`: a missing `id` is today a normal `cache_miss` result
    // from `dispatchAutoUpdateRpc`, never a thrown error — throwing here on that same input would
    // be a behaviour change this task must not make.
    const id = rec !== undefined && typeof rec["id"] === "string" ? rec["id"] : "";
    try {
      const out = await handleAutoUpdateRpc("extension.update", rec, ctx);
      const value = asRecord(out.value);
      const applied = value?.["applied"] === true;
      // A non-applied outcome (`cache_miss`, `signature_failed`, `user_rejected`, …) never
      // throws — it's a normal `{applied:false, reason}` result from `resolveUpdateTarget` /
      // `applyUpdateUnderMutex` — so the reason has to be read off the success value here, not
      // assumed to be absent because we're in the try branch rather than the catch.
      const reason =
        !applied && value !== undefined && typeof value["reason"] === "string"
          ? value["reason"]
          : undefined;
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "update",
        ok: applied,
        ...(reason !== undefined && { error: reason }),
      });
      return out;
    } catch (e) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "update",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  "extension.enable": (rec, ctx) => {
    const id = requireString(rec, "id");
    const ok = setExtensionEnabled(ctx.db, id, true);
    if (ok) ctx.extensionSync?.refresh(id);
    emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "enable", ok });
    return { kind: "hit", value: { ok } };
  },

  "extension.disable": async (rec, ctx) => {
    const id = requireString(rec, "id");
    const ok = setExtensionEnabled(ctx.db, id, false);
    // Unregistered before the stop, so no scheduled sync spawns it again; items are kept.
    if (ok) ctx.extensionSync?.refresh(id);
    if (ok && ctx.mesh !== undefined) {
      // After the row reads disabled, so a concurrent spawn's verifier already refuses, and awaited
      // so the reply means the child is gone. A stop failure never fails the disable.
      await stopExtensionBestEffort(ctx.mesh, id);
    }
    emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "disable", ok });
    return { kind: "hit", value: { ok } };
  },

  "extension.remove": async (rec, ctx) => {
    const id = requireString(rec, "id");
    const force = rec?.["force"] === true;

    try {
      if (!force) refuseRemoveWithDependents(ctx.db, id);

      // Read BEFORE the delete takes the grant with it: the stage root is named by its service id.
      // With no grant (revoked earlier, or never approved) it is derived, since a revoke or an
      // earlier spawn may still have left a stage behind.
      const serviceId = extensionServiceIdForCleanup(getRunGrant(ctx.db, id)?.service_id, id);
      // Plan decision 7: the ONE removal path for an extension-backed connector. Sync is
      // unregistered (no new run starts) and the live client stopped (an in-flight run's next
      // page call fails, so it cannot write items back after the purge); then items, scheduler,
      // health and credentials go under the INDEX id — read from the row and grant, so this
      // precedes their delete. The client is stopped again below, after the row is gone.
      if (ctx.extensionSync !== undefined && listExtensions(ctx.db).some((r) => r.id === id)) {
        ctx.extensionSync.unregister(id);
        if (ctx.mesh !== undefined) await stopExtensionBestEffort(ctx.mesh, id);
        await ctx.extensionSync.purgeBeforeRemove(id);
      }
      // Before `clearDeps`, which takes this id's forward edges that the walk starts from. It never
      // reads this id's own row, so it also precedes the delete; a failure offers nothing rather
      // than leave the removal half done.
      const orphaned = orphanedDependenciesOrNone(ctx.db, id);
      const installPath = deleteExtensionById(ctx.db, id);
      if (installPath === null) {
        throw new AutomationRpcError(-32602, "Extension not found");
      }
      clearDeps(ctx.db, id);
      // The row and grant are gone first, so no new spawn can verify; then the live child is stopped
      // and its stage root removed, and only THEN the install dir — never delete code a running
      // child still has open.
      await stopAndCleanUpRemovedExtension(ctx, id, serviceId);
      removeExtensionFiles(ctx, id, installPath);
      emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "remove", ok: true });
      return { kind: "hit", value: { ok: true, orphanedDependencies: orphaned } };
    } catch (e) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "remove",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  "workflow.list": (_rec, ctx) => ({
    kind: "hit",
    value: { workflows: listWorkflows(ctx.db) },
  }),

  "workflow.save": (rec, ctx) => {
    const description =
      rec !== undefined && typeof rec["description"] === "string" ? rec["description"] : null;
    const id = upsertWorkflowByName(
      ctx.db,
      requireString(rec, "name"),
      description,
      requireString(rec, "stepsJson"),
      Date.now(),
    );
    return { kind: "hit", value: { id } };
  },

  "workflow.delete": (rec, ctx) => ({
    kind: "hit",
    value: { ok: deleteWorkflowByName(ctx.db, requireString(rec, "name")) },
  }),

  "workflow.listRuns": (rec, ctx) => ({
    kind: "hit",
    value: listWorkflowRuns(ctx.db, {
      workflowName: requireString(rec, "workflowName"),
      limit: requireNumber(rec, "limit"),
    }),
  }),
};

/** The removal's orphan offer; a walk that throws offers nothing and never fails the removal. */
export function orphanedDependenciesOrNone(
  db: Database,
  removedId: string,
  walk: (db: Database, removedId: string) => string[] = orphanedDependencies,
): string[] {
  try {
    return walk(db, removedId);
  } catch {
    return [];
  }
}

/**
 * The service id whose stage root `extension.remove` deletes: the grant's stored id, else the one
 * `approveRun` would derive. `undefined` only for a manifest id that yields no valid service id —
 * which could never have been approved, so it never had a stage.
 */
function extensionServiceIdForCleanup(
  granted: string | undefined,
  extensionId: string,
): string | undefined {
  if (granted !== undefined) return granted;
  try {
    return deriveExtensionServiceId(extensionId);
  } catch {
    return undefined;
  }
}

/** Stops an extension's live client; a stop failure is swallowed — the row decision already stands. */
async function stopExtensionBestEffort(
  mesh: AutomationRpcExtensionMeshHandle,
  id: string,
): Promise<void> {
  try {
    await mesh.stopExtensionClient(id);
  } catch {
    // The spawn path re-verifies the row and grant before every spawn, so a missed stop cannot
    // outlive the next spawn attempt; failing the lifecycle call would only strand the row.
  }
}

type ExtensionListItem = ExtensionRow &
  ReturnType<typeof extensionRunFields> & {
    /** R6: the current Nimbus verification lists the key that verified this copy (null otherwise). */
    verifiedPublisher: VerifiedPublisher | null;
    disabled_reason?:
      | typeof PRE_T2_DISABLE_REASON
      | typeof RECOVERED_PENDING_REHASH_REASON
      | SignatureDisableReason;
    needs_reinstall?: boolean;
    signature_disabled?: boolean;
    /** Installed only as a dependency and no edge names it now; the owner removes it. */
    orphaned?: true;
  };

/**
 * Attach the reason an extension is disabled, where the gateway knows one.
 *
 * Two independent registries, and they must stay independent on the wire. `needs_reinstall` is the
 * PRE-T2 flag and drives `--filter needs-reinstall`; a failed Ed25519 check gets `signature_disabled`
 * instead, because the remedies differ (I16) and quietly widening the filter would change what that
 * flag has meant since T2 PR 1.
 *
 * They cannot both apply in practice — the pre-T2 pass runs first and leaves those rows `enabled = 0`,
 * and the signature pass only iterates rows that are still `enabled = 1` — but pre-T2 is checked first
 * regardless rather than relying on that ordering.
 */
/**
 * The trust blocks applying to an installed row (I48), for display. A manifest that no longer reads
 * gives `[]` here; the spawn path refuses such a row on its own checks.
 */
function trustBlocksOf(db: Database, row: ExtensionRow): TrustBlock[] {
  try {
    return blocksForInstalled(db, row, readVerifiedManifest(row));
  } catch {
    return [];
  }
}

/**
 * The verified publisher of an installed copy (R6), from the same subject its trust blocks use. No
 * badge unless the copy still matches the manifest and entry hashes recorded at install
 * (`verifyOneExtensionStrict`) — a durable check, unlike the per-boot signature registry, which a
 * restart clears and which a hash-only boot failure never marks — and none for a copy this boot's
 * signature check disabled, or whose manifest no longer reads.
 */
function verifiedPublisherOf(db: Database, row: ExtensionRow): VerifiedPublisher | null {
  if (preT2DisabledIds().includes(row.id) || signatureDisabledRegistry.has(row.id)) return null;
  // R6 as amended 2026-10-27: a local-path copy's manifest signature does not bind its entry file.
  if (row.source_registry == null) return null;
  try {
    if (!verifyOneExtensionStrict(row)) return null;
    return verifiedPublisherFor(db, blockSubjectForInstalled(row, readVerifiedManifest(row)));
  } catch {
    return null;
  }
}

/**
 * The publisher the copy's hash-checked manifest declares (id and PUBLIC key), for display: the CLI
 * renders the id, a short key and the badge from it. Absent for an unsigned copy, or one whose
 * manifest no longer reads.
 */
function publisherOf(row: ExtensionRow): { publisher?: { id: string; key: string } } {
  try {
    const p = readVerifiedManifest(row).publisher;
    return p === undefined ? {} : { publisher: { id: p.id, key: p.key } };
  } catch {
    return {};
  }
}

function decorateExtensionList(
  db: Database,
  rows: readonly ExtensionRow[],
  grants: ReadonlyMap<string, ExtensionRunGrantRow>,
  isRunning: (id: string) => boolean,
): ExtensionListItem[] {
  const preT2 = new Set(preT2DisabledIds());
  const unneeded = new Set(unneededDependencies(db));
  const signature = new Map(signatureDisabledRegistry.list().map((e) => [e.id, e.reason]));
  return rows.map((r) => {
    const run = {
      ...extensionRunFields(r, grants.get(r.id) ?? null, isRunning(r.id), trustBlocksOf(db, r)),
      verifiedPublisher: verifiedPublisherOf(db, r),
      ...publisherOf(r),
      ...(unneeded.has(r.id) ? { orphaned: true as const } : {}),
    };
    if (preT2.has(r.id)) {
      return { ...r, ...run, disabled_reason: PRE_T2_DISABLE_REASON, needs_reinstall: true };
    }
    const reason = signature.get(r.id);
    if (reason !== undefined) {
      return { ...r, ...run, disabled_reason: reason, signature_disabled: true };
    }
    if (recoveredPendingRehashRegistry.has(r.id)) {
      return { ...r, ...run, disabled_reason: RECOVERED_PENDING_REHASH_REASON };
    }
    return { ...r, ...run };
  });
}

function isRunningIn(ctx: AutomationCtx, id: string): boolean {
  return ctx.mesh?.isExtensionRunning(id) ?? false;
}

/** What requirement status reads, or undefined without a Vault (tests, demo): nothing is computed. */
function requirementDeps(ctx: AutomationCtx): ConnectorRequirementDeps | undefined {
  return ctx.vault === undefined
    ? undefined
    : { db: ctx.db, vault: ctx.vault, ...continuityTableOf(ctx) };
}

/** A manifest reader that reads each installed copy's manifest at most once. */
function memoManifestReader(): ExtensionManifestReader {
  const seen = new Map<string, ReturnType<ExtensionManifestReader>>();
  return (row) => {
    if (!seen.has(row.id)) seen.set(row.id, readInstalledManifest(row));
    return seen.get(row.id);
  };
}

/**
 * `requires` for each of `rows`, keyed by id: whether each connector its manifest requires is
 * connected (`[]` when it requires none), in one pass — every manifest is read once and every
 * distinct connector's status computed once, however many rows require it. A row is absent from
 * the map without a Vault, when its manifest no longer reads, or when the computation failed: its
 * `requires` is then omitted, never an error. A failed Vault read is that connector's `unknown`.
 */
async function requiresByExtension(
  ctx: AutomationCtx,
  rows: readonly ExtensionRow[],
): Promise<ReadonlyMap<string, ConnectorRequirementStatus[]>> {
  const deps = requirementDeps(ctx);
  if (deps === undefined) return new Map();
  const read = memoManifestReader();
  const required: ConnectorRequirementInput[] = [];
  const none: string[] = [];
  for (const row of rows) {
    const own = installedConnectorRequirements(row, read);
    if (own === undefined) continue;
    if (own.length === 0) none.push(row.id);
    required.push(...own);
  }
  const out = await connectorRequirementStatusesByExtension(
    { ...deps, readManifest: read },
    required,
    ctx.requirementStatuses,
  );
  for (const id of none) out.set(id, []);
  return out;
}

/** Whether the caller asked for connector-requirement status (`includeRequires: true`). */
function wantsRequires(rec: Record<string, unknown> | undefined): boolean {
  return rec?.["includeRequires"] === true;
}

function withRequires<T extends { id: string }>(
  item: T,
  requires: ReadonlyMap<string, ConnectorRequirementStatus[]>,
): T & { requires?: ConnectorRequirementStatus[] } {
  const own = requires.get(item.id);
  return own === undefined ? item : { ...item, requires: own };
}

async function handleExtensionList(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const filter = rec !== undefined && typeof rec["filter"] === "string" ? rec["filter"] : "";
  const grants = new Map(listRunGrants(ctx.db).map((g) => [g.extension_id, g]));
  const all = decorateExtensionList(ctx.db, listExtensions(ctx.db), grants, (id) =>
    isRunningIn(ctx, id),
  );
  const filtered =
    filter === "needs-reinstall" || filter === "needs_reinstall"
      ? all.filter((e) => e.needs_reinstall === true)
      : all;
  // Opt-in: the desktop polls this method and shows no requirements, and each connector's status
  // is Vault reads (a `secret-tool` spawn apiece on Linux). Once per call when asked, not per item.
  const requires = wantsRequires(rec) ? await requiresByExtension(ctx, filtered) : new Map();
  const extensions = filtered.map((item) => withRequires(item, requires));
  // `nimbus doctor` stays quiet about unapproved extensions when approving one would be refused.
  return {
    kind: "hit",
    value: { extensions, runtimeEnabled: ctx.runtimeEnabled ?? true },
  };
}

async function handleExtensionInfo(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const row = listExtensions(ctx.db).find((r) => r.id === id);
  if (row === undefined) {
    throw new AutomationRpcError(-32602, "Extension not found");
  }
  const fwd = forwardDeps(ctx.db, row.id);
  const rev = reverseDeps(ctx.db, row.id);
  const requires = wantsRequires(rec)
    ? (await requiresByExtension(ctx, [row])).get(row.id)
    : undefined;
  const run = {
    ...extensionRunFields(
      row,
      getRunGrant(ctx.db, row.id),
      isRunningIn(ctx, row.id),
      trustBlocksOf(ctx.db, row),
    ),
    verifiedPublisher: verifiedPublisherOf(ctx.db, row),
    ...publisherOf(row),
    ...(requires === undefined ? {} : { requires }),
  };
  const preT2 = new Set(preT2DisabledIds());
  if (preT2.has(row.id)) {
    return {
      kind: "hit",
      value: {
        extension: {
          ...row,
          ...run,
          disabled_reason: PRE_T2_DISABLE_REASON,
          needs_reinstall: true,
          forwardDeps: fwd,
          reverseDeps: rev,
        },
        message: preT2DisableMessage(row.id, row.version),
      },
    };
  }

  // I16: the startup signature pass records WHY it hard-disabled a row. Until 2026-09-10 the only
  // production reader was a count in `diag.snapshot`, so `extension info` showed a signature
  // failure as a bare `enabled = 0` — indistinguishable from an extension the owner turned off.
  const signatureReason = signatureDisabledRegistry.reasonFor(row.id);
  if (signatureReason !== undefined) {
    return {
      kind: "hit",
      value: {
        extension: {
          ...row,
          ...run,
          ...resolveExtensionInfoExtras(row, ctx),
          disabled_reason: signatureReason,
          signature_disabled: true,
          forwardDeps: fwd,
          reverseDeps: rev,
        },
        message: signatureDisableMessage(row.id, row.version, signatureReason, row.source_registry),
      },
    };
  }

  if (recoveredPendingRehashRegistry.has(row.id)) {
    return {
      kind: "hit",
      value: {
        extension: {
          ...row,
          ...run,
          ...resolveExtensionInfoExtras(row, ctx),
          disabled_reason: RECOVERED_PENDING_REHASH_REASON,
          forwardDeps: fwd,
          reverseDeps: rev,
        },
        message: recoveredPendingRehashMessage(row.id, row.version),
      },
    };
  }

  return {
    kind: "hit",
    value: {
      extension: {
        ...row,
        ...run,
        ...resolveExtensionInfoExtras(row, ctx),
        forwardDeps: fwd,
        reverseDeps: rev,
      },
    },
  };
}

/**
 * The two fields `extension.info` resolves from outside the DB row: the newest directory under
 * `prev/`, and this run's cached auto-update check.
 *
 * Extracted so the signature-disabled branch above shares them. It was written as an early return
 * placed ABOVE the inline probe, which meant attaching a reason silently dropped both fields from
 * a response that had always carried them — surfacing a reason has to WIDEN the shape, never
 * narrow it. (The pre-T2 branch omits them too, and is left alone: that is shipped behaviour for a
 * different population of rows, not something to change while fixing this.)
 */
function resolveExtensionInfoExtras(
  row: ExtensionRow,
  ctx: AutomationCtx,
): { prevVersion: string | null; cachedUpdate: unknown } {
  let prevVersion: string | null = null;
  try {
    if (ctx.extensionsDir !== undefined) {
      prevVersion = newestPrevVersion(ctx.extensionsDir, row.id) ?? null;
    }
  } catch {
    // Best-effort — info still surfaces the row even if the prev/ probe failed.
  }
  return { prevVersion, cachedUpdate: ctx.autoUpdate?.cache.get(row.id) ?? null };
}

async function handleExtensionInstall(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const sourcePath = requireString(rec, "sourcePath");
  const dir = ctx.extensionsDir;
  if (dir === undefined || dir.trim() === "") {
    throw new AutomationRpcError(-32603, "Gateway is not configured with an extensions directory");
  }
  // Non-Negotiable 2: the consent gate lives in the executor. Without one this REFUSES rather than
  // installing on a client-side prompt the gateway never saw — that was the whole of install's
  // consent before this gate existed, and `--yes` skipped it.
  const ownerGate = ctx.ownerGate;
  if (ownerGate === undefined) {
    throw new AutomationRpcError(-32603, "extension.install requires the owner's HITL gate");
  }
  const publisherKeyPath =
    rec !== undefined && typeof rec["publisherKeyPath"] === "string"
      ? rec["publisherKeyPath"].trim()
      : undefined;
  let installed: Awaited<ReturnType<typeof installExtensionFromLocalDirectory>>;
  try {
    installed = await installExtensionFromLocalDirectory({
      db: ctx.db,
      extensionsDir: dir,
      sourcePath,
      ...(ctx.vault !== undefined && { vault: ctx.vault }),
      ...continuityTableOf(ctx),
      ...(ctx.requirementStatuses !== undefined && {
        requirementStatuses: ctx.requirementStatuses,
      }),
      ...(publisherKeyPath !== undefined && publisherKeyPath !== "" && { publisherKeyPath }),
      approve: (request) => ownerGate({ type: "extension.install", payload: { ...request } }),
    });
  } catch (e) {
    // A rollback that left packages behind is warned and named in the refusal (never swallowed).
    const note = reportIncompleteRollback(ctx.logger ?? automationRpcLog, sourcePath, e);
    const msg = `${e instanceof Error ? e.message : String(e)}${note}`;
    throw new AutomationRpcError(
      e instanceof ExtensionInstallNotApprovedError ? -32603 : -32602,
      msg,
    );
  }
  // A dependency kept by an explicit install: nothing was copied or approved, only its marker moved.
  if (isPromotedInstall(installed)) {
    return {
      kind: "hit",
      value: {
        id: installed.id,
        version: installed.version,
        promoted: true,
        ...(installed.sourceRegistry === undefined
          ? {}
          : { sourceRegistry: installed.sourceRegistry, channel: installed.channel }),
      },
    };
  }
  // After the install has landed, and outside its error handling: this never throws, and a
  // failure only leaves the field out — requirement status never fails an install.
  const deps = requirementDeps(ctx);
  const connectorRequirements =
    deps === undefined
      ? undefined
      : await installedConnectorRequirementStatuses(deps, [installed.id], ctx.requirementStatuses);
  return {
    kind: "hit",
    value: {
      id: installed.id,
      version: installed.version,
      installPath: installed.installPath,
      manifestHash: installed.manifestHash,
      entryHash: installed.entryHash,
      treeDigest: installed.treeDigest,
      kind: installedKindOf(ctx.db, installed.id),
      ...(connectorRequirements === undefined ? {} : { connectorRequirements }),
    },
  };
}

/**
 * Adopt the bytes now under an extension's install path as its trusted tree, by recording their
 * digest. That is exactly what an install approves, so it is gated as one: the owner is asked
 * under the `extension.install` action type, over the digest that will be stored.
 *
 * Refused, without prompting, when the manifest or entry no longer match their install-time
 * hashes — that is tampering or a half-applied update, and adopting it would launder the change;
 * the fix is a reinstall. The tree is hashed again after approval and must still match what the
 * owner saw, so bytes that change during the prompt are never the ones adopted.
 */
async function handleExtensionRehash(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const ownerGate = ctx.ownerGate;
  if (ownerGate === undefined) {
    throw new AutomationRpcError(-32603, "extension.rehash requires the owner's HITL gate");
  }
  const row = listExtensions(ctx.db).find((r) => r.id === id);
  if (row === undefined) {
    throw new AutomationRpcError(-32602, "Extension not found");
  }
  if (!verifyOneExtensionStrict(row)) {
    throw new AutomationRpcError(
      -32602,
      `ERR_EXTENSION_REHASH_MISMATCH: ${id}'s manifest or entry no longer matches what was installed; reinstall it instead`,
    );
  }
  const treeDigest = digestOrRefuse(row.install_path);
  if (treeDigest === row.tree_digest) {
    return { kind: "hit", value: { id, treeDigest, changed: false } };
  }
  const approved = await ownerGate({
    type: "extension.install",
    payload: {
      id,
      version: row.version,
      installPath: row.install_path,
      adopt: "rehash",
      treeDigest,
      previousTreeDigest: row.tree_digest,
    },
  });
  if (!approved) {
    throw new AutomationRpcError(
      -32603,
      `ERR_EXTENSION_REHASH_NOT_APPROVED: rehash of ${id} was not approved`,
    );
  }
  if (digestOrRefuse(row.install_path) !== treeDigest) {
    throw new AutomationRpcError(
      -32603,
      `ERR_EXTENSION_REHASH_CHANGED: ${id}'s files changed while approval was pending; nothing was adopted`,
    );
  }
  setExtensionTreeDigest(ctx.db, id, treeDigest);
  // A crash-recovered extension was left disabled so that adopting its files is the owner's act;
  // this approval is that act.
  if (recoveredPendingRehashRegistry.has(id)) {
    setExtensionEnabled(ctx.db, id, true);
    recoveredPendingRehashRegistry.unmark(id);
  }
  // A new digest leaves the run grant stale: its sync is unregistered and paused for re-approval
  // (and a crash-recovered extension re-enabled above is considered again).
  ctx.extensionSync?.refresh(id);
  return { kind: "hit", value: { id, treeDigest, changed: true } };
}

const EVAL_MAX_IDS = 50;

/** `ids`: 1–50 non-empty strings, else -32602. Checked before anything else, so before consent. */
function requireEvalIds(rec: Record<string, unknown> | undefined): string[] {
  const raw = rec?.["ids"];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > EVAL_MAX_IDS ||
    !raw.every((x): x is string => typeof x === "string" && x.trim() !== "")
  ) {
    throw new AutomationRpcError(
      -32602,
      `Missing or invalid ids (1 to ${EVAL_MAX_IDS} extension ids)`,
    );
  }
  return raw.map((x) => x.trim());
}

/**
 * Evaluate installed extensions' eval suites (invariant I49): one `extension.eval` approval from
 * the LOCAL owner for the whole call, never delegable. Everything is verified before the prompt.
 */
async function handleExtensionEval(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const ids = requireEvalIds(rec);
  // An owner who switched the extension runtime off should not have extension code executed by
  // another door, sandboxed or not: refused before any verification or prompt.
  if (ctx.runtimeEnabled === false) {
    throw new AutomationRpcError(
      -32603,
      "ERR_EXTENSION_EVAL_RUNTIME_DISABLED: the extension runtime is off on this gateway (`[extensions] runtime = false` in nimbus.toml); nothing was evaluated",
    );
  }
  const { ownerGate, runGrantEnv, evalDeps, vault } = ctx;
  if (
    ownerGate === undefined ||
    runGrantEnv === undefined ||
    evalDeps === undefined ||
    vault === undefined
  ) {
    throw new AutomationRpcError(
      -32603,
      "extension.eval requires the owner's HITL gate, the extension environment, the Vault and a sandbox",
    );
  }
  try {
    const results = await evaluateInstalledExtensions(ids, {
      ...evalDeps,
      db: ctx.db,
      vault,
      env: runGrantEnv,
      ownerGate,
    });
    return { kind: "hit", value: { results } };
  } catch (e) {
    if (e instanceof EvalApprovalDenied) throw new AutomationRpcError(-32603, e.message);
    throw e;
  }
}

/** A refusal that happened AFTER the owner was involved is an internal-class error, like rehash's. */
const RUN_GRANT_POST_CONSENT: ReadonlySet<string> = new Set([
  "ERR_EXTENSION_RUN_NOT_APPROVED",
  "ERR_EXTENSION_RUN_CHANGED",
]);

function runGrantRpcError(e: unknown): unknown {
  if (!(e instanceof ExtensionRunGrantError)) return e;
  if (e.code === "ERR_EXTENSION_NOT_FOUND") {
    return new AutomationRpcError(-32602, "Extension not found");
  }
  return new AutomationRpcError(RUN_GRANT_POST_CONSENT.has(e.code) ? -32603 : -32602, e.message);
}

/** The composition's table for a binding call; absent leaves the callee's production default. */
function continuityTableOf(ctx: AutomationCtx): { continuityTable?: readonly ContinuityEntry[] } {
  return ctx.continuityTable === undefined ? {} : { continuityTable: ctx.continuityTable };
}

/**
 * Approve an installed extension to RUN (extension-runtime § 4.4): a second, separate approval from
 * install, asked under `extension.run`. The lazy mesh spawns it on first use, re-verifying first.
 */
async function handleExtensionApproveRun(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  // Validated before the `try`: inside it a malformed parameter would announce a failed approval.
  const rawModelAccess = rec?.["modelAccess"];
  if (rawModelAccess !== undefined && typeof rawModelAccess !== "boolean") {
    throw new AutomationRpcError(-32602, "Invalid params: 'modelAccess' must be a boolean");
  }
  const ownerGate = ctx.ownerGate;
  if (ownerGate === undefined) {
    throw new AutomationRpcError(-32603, "extension.approveRun requires the owner's HITL gate");
  }
  const env = ctx.runGrantEnv;
  if (env === undefined) {
    throw new AutomationRpcError(
      -32603,
      "Gateway is not configured to resolve extension run grants",
    );
  }
  try {
    const out = await approveExtensionRun(id, {
      db: ctx.db,
      env,
      gate: ownerGate,
      runtimeEnabled: ctx.runtimeEnabled ?? true,
      now: Date.now,
      modelAccess: rawModelAccess === true,
      evidence: {
        ...(ctx.sandboxRunner === undefined ? {} : { sandbox: ctx.sandboxRunner }),
        homeDir: homedir(),
      },
      ...continuityTableOf(ctx),
    });
    // Registers its sync under the index id (or resumes a stale-grant pause) once the grant is live.
    ctx.extensionSync?.refresh(id);
    // Where that sync now lives (a bound extension's is its legacy id, not `serviceId`), so the CLI
    // can say when registration paused it. Absent when no sync was registered.
    const syncServiceId = ctx.extensionSync?.syncServiceIdFor(id);
    // `list`/`info` now carry runState, so a connected client must hear that it moved — as it
    // already does for install/enable/disable/remove/update. An unchanged re-approval moved nothing.
    if (out.changed) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "approveRun",
        ok: true,
      });
    }
    return {
      kind: "hit",
      value: syncServiceId === undefined ? out : { ...out, syncServiceId },
    };
  } catch (e) {
    emitGatewayEvent("extension.stateChanged", {
      extensionId: id,
      action: "approveRun",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    throw runGrantRpcError(e);
  }
}

async function handleExtensionRevokeRun(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const mesh = ctx.mesh;
  // Read before the revoke deletes the grant: the stage root is named by its service id.
  const serviceId = getRunGrant(ctx.db, id)?.service_id;
  try {
    const out = await revokeExtensionRun(
      ctx.db,
      id,
      mesh === undefined ? undefined : (x) => mesh.stopExtensionClient(x),
    );
    // After the stop, the stages go too: a later re-approval starts from nothing a previous run
    // left, and a revoked extension leaves no copy of its code in the sandbox root.
    // Revoke stops sync and keeps items (spec § 8.3).
    if (out.revoked) ctx.extensionSync?.refresh(id);
    if (out.revoked && mesh !== undefined && serviceId !== undefined) {
      await mesh.removeExtensionSandbox(serviceId);
    }
    if (out.revoked) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "revokeRun",
        ok: true,
      });
    }
    return { kind: "hit", value: out };
  } catch (e) {
    throw runGrantRpcError(e);
  }
}

function credentialRpcError(e: unknown): unknown {
  if (!(e instanceof ExtensionCredentialError)) return e;
  return new AutomationRpcError(
    CREDENTIAL_POST_CONSENT_CODES.has(e.code) ? -32603 : -32602,
    e.message,
  );
}

/**
 * The grant and binding lookups both credential methods share. The live derivation binds through
 * the SAME composed table as the trust check (C7), so neither can fall back to the baked default.
 */
function credentialReadDeps(ctx: AutomationCtx): Omit<CredentialReadDeps, "vault"> {
  return {
    readGrant: (x) => getRunGrant(ctx.db, x),
    liveCredentials: (x) => currentRunCredentials(ctx.db, x, ctx.continuityTable),
    ...continuityTableOf(ctx),
  };
}

function requireCredentialVault(ctx: AutomationCtx, method: string): NimbusVault {
  if (ctx.vault === undefined) {
    throw new AutomationRpcError(-32603, `${method} requires the Vault`);
  }
  return ctx.vault;
}

function requireInstalledExtension(ctx: AutomationCtx, id: string): void {
  if (!listExtensions(ctx.db).some((r) => r.id === id)) {
    throw new AutomationRpcError(-32602, "Extension not found");
  }
}

/**
 * Set one credential an approved extension declares (CLI-only, LAN-forbidden, refused in a demo
 * root). The Vault key comes from the run grant, never from the caller; the owner is asked once,
 * under `vault.set`. A running extension is stopped after the write, so it takes effect on its next start. The value is read here and passed straight to the Vault — it never appears in
 * the gate payload, the response, an error message or the audit row.
 */
async function handleExtensionCredentialSet(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const name = requireString(rec, "name");
  const value = rec?.["value"];
  if (typeof value !== "string") {
    throw new AutomationRpcError(-32602, "Invalid params: 'value' must be a string");
  }
  const gate = ctx.ownerGate;
  if (gate === undefined) {
    throw new AutomationRpcError(-32603, "extension.credentialSet requires the owner's HITL gate");
  }
  const vault = requireCredentialVault(ctx, "extension.credentialSet");
  requireInstalledExtension(ctx, id);
  try {
    const out = await setExtensionCredential(
      { vault, gate, ...credentialReadDeps(ctx) },
      { extensionId: id, name, value },
    );
    // A live `mesh:ext:` child keeps the env it was spawned with. Stopping it makes the next use
    // re-spawn — re-verifying and reading the new value; nothing else picks the change up.
    if (ctx.mesh !== undefined) await stopExtensionBestEffort(ctx.mesh, id);
    return { kind: "hit", value: out };
  } catch (e) {
    throw credentialRpcError(e);
  }
}

/** Which declared credentials hold a non-blank Vault value. Names only — never a value or key. */
async function handleExtensionCredentialStatus(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
  const vault = requireCredentialVault(ctx, "extension.credentialStatus");
  requireInstalledExtension(ctx, id);
  try {
    const out = await extensionCredentialStatus({ vault, ...credentialReadDeps(ctx) }, id);
    return { kind: "hit", value: out };
  } catch (e) {
    throw credentialRpcError(e);
  }
}

function digestOrRefuse(installPath: string): string {
  try {
    return computeExtensionTreeDigest(installPath);
  } catch (e) {
    throw new AutomationRpcError(-32602, e instanceof Error ? e.message : String(e));
  }
}

async function handleAutoUpdateRpc(
  method: "extension.checkForUpdates" | "extension.update",
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  if (ctx.autoUpdate === undefined) {
    throw new AutomationRpcError(-32603, "Gateway is not configured with auto-update support");
  }
  const value = await dispatchAutoUpdateRpc(method, rec ?? {}, ctx.autoUpdate);
  return { kind: "hit", value };
}

export async function dispatchAutomationRpc(options: {
  method: string;
  params: unknown;
  db: Database;
  extensionsDir?: string;
  mesh?: AutomationRpcExtensionMeshHandle;
  vault?: NimbusVault;
  autoUpdate?: AutoUpdateRpcDeps;
  ownerGate?: AutomationOwnerGate;
  runGrantEnv?: ExtensionRunGrantEnv;
  sandboxRunner?: ReachRunner;
  evalDeps?: AutomationEvalDeps;
  extensionsRuntimeEnabled?: boolean;
  extensionSync?: AutomationRpcExtensionSyncHandle;
  continuityTable?: readonly ContinuityEntry[];
  /** Test seam: stands in for `connectorRequirementStatuses`; production never passes it. */
  requirementStatuses?: ConnectorRequirementStatusesFn;
  /** Test seam: where an incomplete install rollback is warned; absent means this module's logger. */
  logger?: Pick<Logger, "warn">;
}): Promise<Hit | { kind: "miss" }> {
  const handler = AUTOMATION_HANDLERS[options.method];
  if (handler === undefined) {
    return { kind: "miss" };
  }
  const ctx: AutomationCtx = {
    db: options.db,
    ...(options.extensionsDir !== undefined && { extensionsDir: options.extensionsDir }),
    ...(options.mesh !== undefined && { mesh: options.mesh }),
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(options.autoUpdate !== undefined && { autoUpdate: options.autoUpdate }),
    ...(options.ownerGate !== undefined && { ownerGate: options.ownerGate }),
    ...(options.runGrantEnv !== undefined && { runGrantEnv: options.runGrantEnv }),
    ...(options.sandboxRunner !== undefined && { sandboxRunner: options.sandboxRunner }),
    ...(options.evalDeps !== undefined && { evalDeps: options.evalDeps }),
    ...(options.extensionsRuntimeEnabled !== undefined && {
      runtimeEnabled: options.extensionsRuntimeEnabled,
    }),
    ...(options.extensionSync !== undefined && { extensionSync: options.extensionSync }),
    ...(options.continuityTable !== undefined && { continuityTable: options.continuityTable }),
    ...(options.requirementStatuses !== undefined && {
      requirementStatuses: options.requirementStatuses,
    }),
    ...(options.logger !== undefined && { logger: options.logger }),
  };
  return await handler(asRecord(options.params), ctx);
}
