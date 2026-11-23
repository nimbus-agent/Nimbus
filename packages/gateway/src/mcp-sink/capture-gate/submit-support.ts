import { appendAuditEntry } from "../../db/audit-chain.ts";
import { itemPrimaryKey, upsertIndexedItem } from "../../index/item-store.ts";
import type { CaptureCapability } from "../capture-capability.ts";
import {
  type ActionBasis,
  CaptureError,
  type CaptureErrorCode,
  type CaptureKind,
  type CaptureState,
  type LabelSource,
  type ValidatedCapture,
} from "../capture-types.ts";
import {
  CAPTURE_ITEM_SERVICE,
  CAPTURE_ITEM_TYPE,
  type CaptureCaller,
  type CaptureGateDeps,
  HOUR_MS,
} from "./contract.ts";

/** Steps 1–3 refuse without an audit row: counted instead, so the attempt limit stays a bound. */
export function refuseUnaudited(
  deps: CaptureGateDeps,
  code: CaptureErrorCode,
  detail: string,
): never {
  deps.refusals.bump(code);
  throw new CaptureError(code, detail);
}

/** Steps 4–8 refuse WITH an audit row — their rate is bounded by step 3. */
export function refuseAudited(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  kind: string,
  clientLabel: string | null,
  code: CaptureErrorCode,
  detail: string,
): never {
  appendAuditEntry(deps.db, {
    actionType: "capture.submit",
    hitlStatus: "rejected",
    actionJson: JSON.stringify({ kind, clientLabel, connection: caller.clientId, outcome: code }),
    timestamp: deps.now(),
    sessionId: caller.clientId,
  });
  throw new CaptureError(code, detail);
}

// ---- submit (spec § 5.1) -------------------------------------------------------------------------

/** Who is submitting what, once step 4 has fixed the kind: every audited refusal names these. */
export interface SubmitContext {
  readonly deps: CaptureGateDeps;
  readonly caller: CaptureCaller;
  readonly kind: CaptureKind;
  readonly clientLabel: string | null;
  /** Display only (D-AD-13): stored and shown, never read by a step of this gate. */
  readonly labelSource: LabelSource;
}

export function refuseKindNotAllowed(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  kindRaw: unknown,
  clientLabel: string | null,
): never {
  const kindName = typeof kindRaw === "string" ? kindRaw.slice(0, 20) : "unknown";
  refuseAudited(
    deps,
    caller,
    kindName,
    clientLabel,
    "ERR_CAPTURE_KIND_NOT_ALLOWED",
    `kind ${kindName} is not enabled`,
  );
}

/** Runs one step; a `CaptureError` it throws becomes an audited refusal, anything else rethrows. */
export function auditedStep<T>(ctx: SubmitContext, step: () => T): T {
  try {
    return step();
  } catch (e) {
    if (e instanceof CaptureError)
      refuseAudited(ctx.deps, ctx.caller, ctx.kind, ctx.clientLabel, e.code, e.message);
    throw e;
  }
}

/** Step 8b's refusal: this connection already holds its share of the action queue (AD2). */
export function refuseConnectionFull(ctx: SubmitContext, held: number): never {
  refuseAudited(
    ctx.deps,
    ctx.caller,
    ctx.kind,
    ctx.clientLabel,
    "ERR_CAPTURE_QUEUE_FULL",
    `this connection already has ${String(held)} proposed actions waiting for the owner`,
  );
}

/** Step 8's refusal: the action queue or the native-proposal queue is full. */
export function refuseQueueFull(
  ctx: SubmitContext,
  v: ValidatedCapture,
  cap: CaptureCapability,
): never {
  refuseAudited(
    ctx.deps,
    ctx.caller,
    ctx.kind,
    ctx.clientLabel,
    "ERR_CAPTURE_QUEUE_FULL",
    v.kind === "action"
      ? `${String(cap.config.actionMaxPending)} proposed actions already await the owner`
      : `the review queue is full (${String(cap.config.maxPending)} proposals await the owner)`,
  );
}

/** What `submitCapture` returns. */
export type SubmitResult = {
  id: string;
  state: CaptureState;
  expiresAt?: number;
};

/** The count-only hook: after commit, and a failing toast never fails a submit. */
export function notifyActionProposed(deps: CaptureGateDeps, now: number): void {
  try {
    deps.onActionProposed?.(deps.store.countPendingActions(now));
  } catch {
    // a missed notification loses nothing: `nimbus approvals` and `nimbus doctor` show the queue
  }
}

/**
 * Steps 9 + 10: one transaction — capture row, item (notes only), audit. An audit failure rolls all
 * of it back. A proposal gets no item, no native row and no embedding until accept (spec § 4.3).
 */
export function writeSubmittedCapture(
  ctx: SubmitContext,
  v: ValidatedCapture,
  cap: CaptureCapability,
  now: number,
  basis: ActionBasis | undefined,
): SubmitResult {
  const { deps, caller, kind, clientLabel, labelSource } = ctx;
  const proposal = v.kind !== "note";
  const id = deps.newId();
  const itemId = proposal ? null : itemPrimaryKey(CAPTURE_ITEM_SERVICE, id);
  const payloadJson = JSON.stringify(v.payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const state: CaptureState = proposal ? "proposed" : "live";
  const expiresAt = v.kind === "action" ? now + cap.config.actionTtlHours * HOUR_MS : null;
  deps.db.transaction(() => {
    deps.store.insert({
      id,
      kind,
      state,
      itemId,
      payloadJson,
      payloadBytes,
      clientLabel,
      labelSource,
      sessionId: caller.clientId,
      createdAt: now,
      expiresAt,
    });
    if (v.kind === "note") {
      const payload = v.payload;
      upsertIndexedItem(deps.db, {
        service: CAPTURE_ITEM_SERVICE,
        type: CAPTURE_ITEM_TYPE,
        externalId: id,
        title: payload.title,
        body: payload.body,
        modifiedAt: now,
        syncedAt: now,
        metadata: {
          captureKind: kind,
          captureId: id,
          agentAuthored: true,
          clientLabel,
          tags: payload.tags,
          relatesTo: payload.relatesTo,
        },
      });
    }
    appendAuditEntry(deps.db, {
      actionType: "capture.submit",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        captureId: id,
        kind,
        ...(v.kind === "action" ? { actionType: v.payload.actionType } : {}),
        ...(v.kind === "action" && basis !== undefined ? { basis } : {}),
        payloadBytes,
        clientLabel,
        // AD4 (OR-AD-20): the submitting connection's id, so a report can count connections per label.
        connection: caller.clientId,
        outcome: proposal ? "proposed" : "captured",
      }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (itemId !== null) deps.scheduleEmbedding?.(itemId);
  if (expiresAt === null) return { id, state };
  return { id, state, expiresAt };
}
