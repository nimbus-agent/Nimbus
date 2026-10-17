import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { approveExtensionRun, revokeExtensionRun } from "../extensions/approve-run.ts";
import { type AutoUpdateRpcDeps, dispatchAutoUpdateRpc } from "../extensions/auto-update-rpc.ts";
import { clearDeps, forwardDeps, reverseDeps } from "../extensions/dependency-store.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import {
  PRE_T2_DISABLE_REASON,
  preT2DisabledIds,
  preT2DisableMessage,
  signatureDisabledRegistry,
  signatureDisableMessage,
} from "../extensions/hard-disable.ts";
import {
  ExtensionInstallNotApprovedError,
  installExtensionFromLocalDirectory,
} from "../extensions/install-from-local.ts";
import type { PublisherKeyFetcher } from "../extensions/registry-client.ts";
import { ExtensionRunGrantError } from "../extensions/run-grant-error.ts";
import {
  type ExtensionRunGrantRow,
  getRunGrant,
  listRunGrants,
} from "../extensions/run-grant-store.ts";
import { extensionRunFields } from "../extensions/run-state.ts";
import { syncPublisherKeys } from "../extensions/sync.ts";
import { computeExtensionTreeDigest } from "../extensions/tree-digest.ts";
import { verifyOneExtensionStrict } from "../extensions/verify-extensions.ts";
import type { SignatureDisableReason } from "../extensions/verify-signature.ts";
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
  /** Deletes the `ext.<serviceId>` sandbox leaf. Best-effort, never throws. */
  removeExtensionSandbox(serviceId: string): Promise<void>;
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

interface AutomationCtx {
  db: Database;
  extensionsDir?: string;
  mesh?: AutomationRpcExtensionMeshHandle;
  vault?: NimbusVault;
  fetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
  autoUpdate?: AutoUpdateRpcDeps;
  ownerGate?: AutomationOwnerGate;
  runGrantEnv?: ExtensionRunGrantEnv;
  /** `[extensions] runtime` and not demo-rooted; absent means the default, `true`. */
  runtimeEnabled?: boolean;
}

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

  "extension.sync": async (rec, ctx) => handleExtensionSync(rec, ctx),

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
    emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "enable", ok });
    return { kind: "hit", value: { ok } };
  },

  "extension.disable": async (rec, ctx) => {
    const id = requireString(rec, "id");
    const ok = setExtensionEnabled(ctx.db, id, false);
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
      if (!force) {
        const rdeps = reverseDeps(ctx.db, id);
        if (rdeps.length > 0) {
          const blockers = rdeps.map((r) => ({ id: r.extensionId, range: r.range }));
          const blockerDesc = blockers.map((b) => `${b.id} (${b.range})`).join(", ");
          throw new AutomationRpcError(
            -32603,
            `reverse_dep_blocked: Cannot remove ${id}: required by ${blockerDesc}. Pass --force to override.`,
          );
        }
      }

      // Read BEFORE the delete takes the grant with it: the sandbox leaf is named by its service id.
      const grant = getRunGrant(ctx.db, id);
      const installPath = deleteExtensionById(ctx.db, id);
      if (installPath === null) {
        throw new AutomationRpcError(-32602, "Extension not found");
      }
      clearDeps(ctx.db, id);
      // The row and grant are gone first, so no new spawn can verify; then the live child is stopped
      // and its sandbox leaf removed, and only THEN the install dir — never delete code a running
      // child still has open.
      if (ctx.mesh !== undefined) {
        await stopExtensionBestEffort(ctx.mesh, id);
        if (grant !== null) await ctx.mesh.removeExtensionSandbox(grant.service_id);
      }
      try {
        rmSync(installPath, { recursive: true, force: true });
      } catch {
        /* row already removed; best-effort filesystem cleanup */
      }
      emitGatewayEvent("extension.stateChanged", { extensionId: id, action: "remove", ok: true });
      return { kind: "hit", value: { ok: true } };
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
    disabled_reason?: typeof PRE_T2_DISABLE_REASON | SignatureDisableReason;
    needs_reinstall?: boolean;
    signature_disabled?: boolean;
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
function decorateExtensionList(
  rows: readonly ExtensionRow[],
  grants: ReadonlyMap<string, ExtensionRunGrantRow>,
  isRunning: (id: string) => boolean,
): ExtensionListItem[] {
  const preT2 = new Set(preT2DisabledIds());
  const signature = new Map(signatureDisabledRegistry.list().map((e) => [e.id, e.reason]));
  return rows.map((r) => {
    const run = extensionRunFields(r, grants.get(r.id) ?? null, isRunning(r.id));
    if (preT2.has(r.id)) {
      return { ...r, ...run, disabled_reason: PRE_T2_DISABLE_REASON, needs_reinstall: true };
    }
    const reason = signature.get(r.id);
    if (reason !== undefined) {
      return { ...r, ...run, disabled_reason: reason, signature_disabled: true };
    }
    return { ...r, ...run };
  });
}

function isRunningIn(ctx: AutomationCtx, id: string): boolean {
  return ctx.mesh?.isExtensionRunning(id) ?? false;
}

function handleExtensionList(rec: Record<string, unknown> | undefined, ctx: AutomationCtx): Hit {
  const filter = rec !== undefined && typeof rec["filter"] === "string" ? rec["filter"] : "";
  const grants = new Map(listRunGrants(ctx.db).map((g) => [g.extension_id, g]));
  const all = decorateExtensionList(listExtensions(ctx.db), grants, (id) => isRunningIn(ctx, id));
  const filtered =
    filter === "needs-reinstall" || filter === "needs_reinstall"
      ? all.filter((e) => e.needs_reinstall === true)
      : all;
  return { kind: "hit", value: { extensions: filtered } };
}

function handleExtensionInfo(rec: Record<string, unknown> | undefined, ctx: AutomationCtx): Hit {
  const id = requireString(rec, "id");
  const row = listExtensions(ctx.db).find((r) => r.id === id);
  if (row === undefined) {
    throw new AutomationRpcError(-32602, "Extension not found");
  }
  const fwd = forwardDeps(ctx.db, row.id);
  const rev = reverseDeps(ctx.db, row.id);
  const run = extensionRunFields(row, getRunGrant(ctx.db, row.id), isRunningIn(ctx, row.id));
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
        message: signatureDisableMessage(row.id, row.version, signatureReason),
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
 * `_prev/`, and this run's cached auto-update check.
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
    const extRoot = dirname(row.install_path);
    const prevDir = join(extRoot, "_prev");
    if (existsSync(prevDir)) {
      const entries = readdirSync(prevDir).sort();
      const last = entries[entries.length - 1];
      if (last !== undefined) {
        prevVersion = last;
      }
    }
  } catch {
    // Best-effort — info still surfaces the row even if _prev/ probe failed.
  }
  return { prevVersion, cachedUpdate: ctx.autoUpdate?.cache.get(row.id) ?? null };
}

async function handleExtensionSync(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  if (ctx.vault === undefined) {
    throw new AutomationRpcError(-32603, "Gateway is not configured with a vault");
  }
  if (ctx.fetcher === undefined) {
    throw new AutomationRpcError(-32603, "Gateway is not configured with a publisher key fetcher");
  }
  const dryRun = rec !== undefined && typeof rec["dryRun"] === "boolean" ? rec["dryRun"] : false;
  try {
    const result = await syncPublisherKeys({
      vault: ctx.vault,
      db: ctx.db,
      fetcher: ctx.fetcher,
      enforceAirGap: ctx.enforceAirGap ?? false,
      dryRun,
    });
    return { kind: "hit", value: result as unknown as Record<string, unknown> };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AutomationRpcError(-32603, msg);
  }
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
  try {
    const installed = await installExtensionFromLocalDirectory({
      db: ctx.db,
      extensionsDir: dir,
      sourcePath,
      ...(ctx.vault !== undefined && { vault: ctx.vault }),
      ...(ctx.fetcher !== undefined && { fetcher: ctx.fetcher }),
      ...(ctx.enforceAirGap !== undefined && { enforceAirGap: ctx.enforceAirGap }),
      ...(publisherKeyPath !== undefined && publisherKeyPath !== "" && { publisherKeyPath }),
      approve: (request) => ownerGate({ type: "extension.install", payload: { ...request } }),
    });
    return {
      kind: "hit",
      value: {
        id: installed.id,
        version: installed.version,
        installPath: installed.installPath,
        manifestHash: installed.manifestHash,
        entryHash: installed.entryHash,
        treeDigest: installed.treeDigest,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AutomationRpcError(
      e instanceof ExtensionInstallNotApprovedError ? -32603 : -32602,
      msg,
    );
  }
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
  return { kind: "hit", value: { id, treeDigest, changed: true } };
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

/**
 * Approve an installed extension to RUN (extension-runtime § 4.4): a second, separate approval from
 * install, asked under `extension.run`. The lazy mesh spawns it on first use, re-verifying first.
 */
async function handleExtensionApproveRun(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const id = requireString(rec, "id");
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
    });
    // `list`/`info` now carry runState, so a connected client must hear that it moved — as it
    // already does for install/enable/disable/remove/update. An unchanged re-approval moved nothing.
    if (out.changed) {
      emitGatewayEvent("extension.stateChanged", {
        extensionId: id,
        action: "approveRun",
        ok: true,
      });
    }
    return { kind: "hit", value: out };
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
  try {
    const out = await revokeExtensionRun(
      ctx.db,
      id,
      mesh === undefined ? undefined : (x) => mesh.stopExtensionClient(x),
    );
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
  fetcher?: PublisherKeyFetcher;
  enforceAirGap?: boolean;
  autoUpdate?: AutoUpdateRpcDeps;
  ownerGate?: AutomationOwnerGate;
  runGrantEnv?: ExtensionRunGrantEnv;
  extensionsRuntimeEnabled?: boolean;
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
    ...(options.fetcher !== undefined && { fetcher: options.fetcher }),
    ...(options.enforceAirGap !== undefined && { enforceAirGap: options.enforceAirGap }),
    ...(options.autoUpdate !== undefined && { autoUpdate: options.autoUpdate }),
    ...(options.ownerGate !== undefined && { ownerGate: options.ownerGate }),
    ...(options.runGrantEnv !== undefined && { runGrantEnv: options.runGrantEnv }),
    ...(options.extensionsRuntimeEnabled !== undefined && {
      runtimeEnabled: options.extensionsRuntimeEnabled,
    }),
  };
  return await handler(asRecord(options.params), ctx);
}
