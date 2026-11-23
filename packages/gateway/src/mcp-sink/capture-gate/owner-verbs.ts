import { appendAuditEntry } from "../../db/audit-chain.ts";
import { deleteEvidenceCitingItem } from "../../decisions/decision-store.ts";
import { deleteItemByPrimaryKey } from "../../index/item-store.ts";
import { revokeCaptureNative } from "../capture-native.ts";
import { actionTypeOfPayload } from "../capture-store.ts";
import { CaptureError, type CaptureState } from "../capture-types.ts";
import type { CaptureCaller, CaptureGateDeps } from "./contract.ts";
import { requireId, requireOwner } from "./shared.ts";

// ---- revoke (spec § 5.3) -------------------------------------------------------------------------

export function revokeCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): { id: string; state: "revoked" } {
  requireOwner(caller);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  if (row.kind === "action") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      "an executed action cannot be undone; reject a proposed one with `nimbus captures reject`",
    );
  }
  if (row.state === "revoked") return { id, state: "revoked" };
  if (row.state !== "live" && row.state !== "accepted") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${id} is ${row.state}; only a live note or an accepted capture can be revoked`,
    );
  }
  const from = row.state;
  const now = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.markRevoked(id, from, now);
    if (!won) return; // lost a race to another revoke: nothing to write
    if (from === "accepted" && row.nativeRef !== null) {
      revokeCaptureNative(
        deps.db,
        { id, kind: row.kind, nativeRef: row.nativeRef },
        deps.store.countAcceptedWithNativeRef(row.nativeRef, id) > 0,
      );
    }
    if (row.itemId !== null) {
      // No evidence row may keep pointing at an item that is about to disappear (spec § 5.3).
      deleteEvidenceCitingItem(deps.db, row.itemId);
      deleteItemByPrimaryKey(deps.db, row.itemId);
    }
    appendAuditEntry(deps.db, {
      actionType: "capture.revoke",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        captureId: id,
        kind: row.kind,
        nativeRef: row.nativeRef,
        outcome: "revoked",
      }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (!won && deps.store.get(id)?.state !== "revoked") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
  }
  return { id, state: "revoked" };
}

// ---- purge (an action row's owner deletion path) -------------------------------------------------

/** Action states with no further transition: the only ones `purgeCapture` deletes. */
const PURGEABLE_ACTION_STATES: ReadonlySet<CaptureState> = new Set([
  "executed",
  "failed",
  "rejected",
  "expired",
]);

/**
 * Delete a FINISHED action capture's row, and with it the agent's verbatim input. Revoke cannot do
 * this: an action has no `revoked` state and V69 ties a NULL payload to that state. What it does
 * NOT do, by construction: undo the action (it already ran, or never will), or remove the executor's
 * own redacted audit row for it — the audit chain is append-only. No capability check, like reject:
 * the owner can always delete what is stored about them.
 */
export function purgeCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): { id: string; state: "purged" } {
  requireOwner(caller);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  if (row.kind !== "action") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${id} is a ${row.kind}; only an action is purged — use \`nimbus captures revoke\``,
    );
  }
  if (!PURGEABLE_ACTION_STATES.has(row.state)) {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      row.state === "proposed"
        ? `capture ${id} is proposed; reject it with \`nimbus captures reject\` first`
        : `capture ${id} is ${row.state}; only a finished action can be purged`,
    );
  }
  const now = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.deleteFinishedAction(id, row.state);
    if (!won) return;
    appendAuditEntry(deps.db, {
      actionType: "capture.purge",
      hitlStatus: "not_required",
      // Never the payload: removing it is the point.
      actionJson: JSON.stringify({
        captureId: id,
        kind: row.kind,
        actionType: actionTypeOfPayload(row.payloadJson),
        priorState: row.state,
        outcome: "purged",
      }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (!won) throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
  return { id, state: "purged" };
}
