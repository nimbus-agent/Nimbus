import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import {
  deleteExtensionById,
  listExtensions,
  setExtensionEnabled,
} from "../../automation/extension-store.ts";
import { deleteConnectorHealthRow } from "../../connectors/health.ts";
import { dispatchAutoUpdateRpc } from "../../extensions/auto-update-rpc.ts";
import { clearDeps, reverseDeps } from "../../extensions/dependency-store.ts";
import { deriveExtensionServiceId } from "../../extensions/extension-service-id.ts";
import { deleteObservationFilesFor } from "../../extensions/observation/observation-ingest.ts";
import { orphanedDependencies } from "../../extensions/orphaned-dependencies.ts";
import { getRunGrant } from "../../extensions/run-grant-store.ts";
import { removeExtensionVersionStore } from "../../extensions/version-store.ts";
import { asRecord } from "../connector-rpc-shared.ts";
import { emitGatewayEvent } from "../gateway-events.ts";
import {
  type AutomationCtx,
  type AutomationHandler,
  AutomationRpcError,
  type Hit,
  requireString,
  stopExtensionBestEffort,
} from "./shared.ts";

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
 * stage root, then the `ext_` health row a refused or failed spawn recorded, then its pending
 * observation files — after the stop, so a stopping wrapper's final window goes too. (A file that
 * still lands later names an extension that is no longer installed, and ingest rejects it.)
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
  if (serviceId === undefined) return;
  deleteConnectorHealthRow(ctx.db, serviceId);
  if (ctx.observationDir !== undefined) deleteObservationFilesFor(ctx.observationDir, serviceId);
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

export const EXTENSION_LIFECYCLE_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
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
};
