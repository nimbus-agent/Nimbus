import { appendAuditEntry } from "../db/audit-chain.ts";
import { serviceOf } from "../engine/service-of.ts";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import { type ActionAcceptResult, acceptAction, actionDestinationVerdict } from "./capture-act.ts";
import type { CaptureCapability } from "./capture-capability.ts";
import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";
import {
  type ActionDefinitionCheck,
  CAPTURE_ITEM_SERVICE,
  CAPTURE_ITEM_TYPE,
  type CaptureCaller,
  type CaptureGateDeps,
  HOUR_MS,
} from "./capture-gate/contract.ts";
import { missingItem, requireId, requireOwner } from "./capture-gate/shared.ts";
import {
  auditedStep,
  notifyActionProposed,
  refuseAudited,
  refuseConnectionFull,
  refuseKindNotAllowed,
  refuseQueueFull,
  refuseUnaudited,
  type SubmitContext,
  type SubmitResult,
  writeSubmittedCapture,
} from "./capture-gate/submit-support.ts";
import {
  assertAcceptable,
  renderAcceptedItem,
  resolveLinkEndpoints,
  writeCaptureNative,
} from "./capture-native.ts";
import { FINISHED_RETENTION_MS } from "./capture-store.ts";
import {
  type ActDeps,
  type ActionBasis,
  type ActionVerdict,
  CaptureError,
  type CaptureRow,
  isCaptureKind,
  type NativeValidatedCapture,
  NO_BASIS_CLASS,
  type ValidatedCapture,
} from "./capture-types.ts";
import {
  PAYLOAD_MAX_BYTES,
  referencedItemIds,
  sanitizeClientLabel,
  sanitizeLabelSource,
  validateCapturePayload,
} from "./capture-validate.ts";

// The gate's public surface is unchanged: the pieces that moved out are re-exported here, so every
// importer (ipc/capture-rpc.ts, ipc/approvals-rpc.ts, the tests) keeps naming `capture-gate.ts`.
export {
  type ActionDefinitionCheck,
  type ActionProposalRow,
  CAPTURE_ITEM_SERVICE,
  CAPTURE_ITEM_TYPE,
  type CaptureCaller,
  type CaptureDetail,
  type CaptureGateDeps,
  type CaptureMineView,
  type CaptureStateView,
  type CaptureStatus,
  type CaptureSummary,
} from "./capture-gate/contract.ts";
export { purgeCapture, revokeCapture } from "./capture-gate/owner-verbs.ts";
export {
  captureMine,
  captureStateFor,
  captureStatus,
  getCapture,
  listActionProposals,
  listCaptures,
} from "./capture-gate/reads.ts";
export type { SubmitResult } from "./capture-gate/submit-support.ts";

/**
 * Invariant I28 — the ONE door by which content from an MCP client enters Nimbus (spec § 5).
 * Submit takes all four kinds: a note goes live at once, a decision/term/link is stored PROPOSED.
 * Submit runs a FIXED order; read it top to bottom in `submitCapture`. Static D32(b) confines the
 * callers of `submitCapture`/`revokeCapture`/`acceptCapture`/`rejectCapture`/`purgeCapture` to
 * `ipc/capture-rpc.ts`.
 */
const ATTEMPT_MULTIPLIER = 4;
/** Agent door AD2: how many unexpired proposed actions ONE connection may hold (never above `actionMaxPending`). */
const PER_CONNECTION_ACTIONS = 3;

type ActionCapture = Extract<ValidatedCapture, { readonly kind: "action" }>;

/** Step 1's refusals: the sink off, or an action while the act door is off. Unaudited. */
function requireSubmitCapability(
  deps: CaptureGateDeps,
  cap: CaptureCapability,
  input: unknown,
): void {
  if (!cap.enabled)
    refuseUnaudited(deps, "ERR_CAPTURE_DISABLED", `the capture sink is off (${cap.reason})`);
  const rawKind =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["kind"]
      : undefined;
  if (rawKind === "action" && !cap.actionEnabled) {
    refuseUnaudited(deps, "ERR_CAPTURE_DISABLED", "the act door is off (mcp_action or kinds)");
  }
}

/** The params object, or an audited refusal (the first audited step: bounded by step 3). */
function requireSubmitParams(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  input: unknown,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    refuseAudited(deps, caller, "unknown", null, "ERR_CAPTURE_INVALID", "params must be an object");
  }
  return input as Record<string, unknown>;
}

/**
 * Step 5a's size rule: the validator accepts an action up to its structural bound, and only a
 * proposal whose verdict marks a bound row may keep more than the ordinary cap. Runs before the
 * destination, the configured and the definition checks, so an oversized proposal costs no I/O.
 */
function requireActionSize(ctx: SubmitContext, v: ActionCapture, boundInput: boolean): void {
  if (boundInput) return;
  if (Buffer.byteLength(JSON.stringify(v.payload), "utf8") > PAYLOAD_MAX_BYTES) {
    refuseAudited(
      ctx.deps,
      ctx.caller,
      "action",
      ctx.clientLabel,
      "ERR_CAPTURE_INVALID",
      `payload exceeds ${String(PAYLOAD_MAX_BYTES)} bytes`,
    );
  }
}

/** The fixed detail of a suspended tool at submit; it echoes nothing stored or listed. */
const SUSPENDED_AT_SUBMIT =
  "was approved for agents but its definition changed; it stays refused until the owner approves it again by name";

/**
 * Step 5a: the action type is proposable now, and on what basis. A `suspended` verdict is its own
 * audited refusal (`ERR_AGENT_TOOL_SUSPENDED`); denied and unknown are `NOT_PROPOSABLE`. A
 * proposable verdict with no basis is ALWAYS refused (`agent_no_basis`, fail closed: a basis-less
 * verdict would be lax everywhere after it; a user-MCP type carries `approved` like every
 * other). Returns the verdict's basis and whether its row may carry a payload
 * over the ordinary cap.
 */
function requireProposable(
  ctx: SubmitContext,
  v: ActionCapture,
  classified: ActionVerdict | undefined,
): { readonly basis: ActionBasis; readonly boundInput: boolean } {
  const verdict = classified ?? { kind: "unknown" as const };
  if (verdict.kind === "proposable") {
    if (verdict.basis === undefined) {
      refuseAudited(
        ctx.deps,
        ctx.caller,
        "action",
        ctx.clientLabel,
        "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
        `${v.payload.actionType} cannot be proposed (${NO_BASIS_CLASS})`,
      );
    }
    return { basis: verdict.basis, boundInput: verdict.boundInput === true };
  }
  if (verdict.kind === "suspended") {
    refuseAudited(
      ctx.deps,
      ctx.caller,
      "action",
      ctx.clientLabel,
      "ERR_AGENT_TOOL_SUSPENDED",
      `${v.payload.actionType} ${SUSPENDED_AT_SUBMIT}`,
    );
  }
  refuseAudited(
    ctx.deps,
    ctx.caller,
    "action",
    ctx.clientLabel,
    "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    `${v.payload.actionType} cannot be proposed (${verdict.kind === "denied" ? verdict.class : "unknown action type"})`,
  );
}

/** Step 5a's second refusal: the destination is one the proposal's basis may never post to. */
function requireDestinationAllowed(
  ctx: SubmitContext,
  v: ActionCapture,
  basis: ActionBasis | undefined,
): void {
  const reason = actionDestinationVerdict(ctx.deps, v.payload.actionType, v.payload.input, basis);
  if (reason !== undefined) {
    refuseAudited(
      ctx.deps,
      ctx.caller,
      "action",
      ctx.clientLabel,
      "ERR_CAPTURE_ACTION_REFUSED",
      reason,
    );
  }
}

/** Step 5b's refusal: the action's connector is not configured on this machine. */
function requireConfigured(
  ctx: SubmitContext,
  v: ActionCapture,
  configured: boolean | undefined,
): void {
  if (configured !== true) {
    refuseAudited(
      ctx.deps,
      ctx.caller,
      "action",
      ctx.clientLabel,
      "ERR_CAPTURE_CONNECTOR_UNCONFIGURED",
      `${serviceOf(v.payload.actionType)} is not configured on this machine`,
    );
  }
}

/** The fixed detail when the definition check cannot run or throws. */
const DEFINITION_UNCHECKED = "its definition could not be checked now";

/**
 * Step 5c, for an `approved` basis only and LAST of the action checks: the connector is listed once
 * and the approved tool's definition compared with the owner's. An absent check, a throw and a
 * failed answer all refuse; nothing is queued.
 */
async function requireDefinitionVerified(
  ctx: SubmitContext,
  v: ActionCapture,
  basis: ActionBasis | undefined,
): Promise<void> {
  if (basis !== "approved") return;
  const type = v.payload.actionType;
  let outcome: ActionDefinitionCheck;
  try {
    outcome = (await ctx.deps.verifyActionDefinition?.(type)) ?? {
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_UNCHECKED,
    };
  } catch {
    outcome = {
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_UNCHECKED,
    };
  }
  if (!outcome.ok) {
    refuseAudited(
      ctx.deps,
      ctx.caller,
      "action",
      ctx.clientLabel,
      outcome.code,
      `${type}: ${outcome.detail}`,
    );
  }
}

export async function submitCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  input: unknown,
): Promise<SubmitResult> {
  // 1. Capability (config + live org policy, fail-closed).
  const cap = deps.capability();
  requireSubmitCapability(deps, cap, input);
  // 2. Client kind: only a declared `mcp` connection submits.
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "submit") {
    refuseUnaudited(
      deps,
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      `a ${caller.kind} client cannot submit captures`,
    );
  }
  // 3. Gateway-wide attempt limit, BEFORE any validation.
  const now = deps.now();
  if (!deps.limiter.tryAcquire(now, cap.config.maxPerHour * ATTEMPT_MULTIPLIER)) {
    refuseUnaudited(deps, "ERR_CAPTURE_RATE_LIMITED", "too many capture attempts this hour");
  }
  const params = requireSubmitParams(deps, caller, input);
  const clientLabel = sanitizeClientLabel(params["clientLabel"]);
  const kindRaw = params["kind"];
  // 4. Kind allowed by config AND supported by this gateway version.
  if (!isCaptureKind(kindRaw) || !cap.kinds.includes(kindRaw)) {
    refuseKindNotAllowed(deps, caller, kindRaw, clientLabel);
  }
  const labelSource = sanitizeLabelSource(params["labelSource"], clientLabel);
  const ctx: SubmitContext = { deps, caller, kind: kindRaw, clientLabel, labelSource };
  // 5. Whitelist rebuild, per kind.
  const v = auditedStep(ctx, () => validateCapturePayload(kindRaw, params["payload"], now));
  // 5a + 5b + 5c. An action must be proposable now (and on what basis), its destination allowed for
  //    that basis, its connector configured, and, for an owner-approved tool, its listed definition
  //    unchanged. The definition check lists the connector, so it is LAST: every other refusal above
  //    it is free of connector I/O. Everything after these awaits stays synchronous through the
  //    write, so a concurrent submit cannot slip past the caps.
  let basis: ActionBasis | undefined;
  if (v.kind === "action") {
    const proposed = requireProposable(ctx, v, deps.classifyAction?.(v.payload.actionType));
    basis = proposed.basis;
    requireActionSize(ctx, v, proposed.boundInput);
    requireDestinationAllowed(ctx, v, basis);
    requireConfigured(ctx, v, await deps.isServiceConfigured?.(serviceOf(v.payload.actionType)));
    await requireDefinitionVerified(ctx, v, basis);
  }
  // 6. Referenced items exist (a capture item only while live/accepted); a link's endpoints must
  //    also be graph-linkable NOW, so a proposal that can never be accepted is not queued.
  const missing = missingItem(deps, referencedItemIds(v));
  if (missing !== undefined) {
    refuseAudited(
      deps,
      caller,
      kindRaw,
      clientLabel,
      "ERR_CAPTURE_UNKNOWN_ITEM",
      `no indexed item ${missing}`,
    );
  }
  if (v.kind === "link") {
    auditedStep(ctx, () => resolveLinkEndpoints(deps.db, v.payload.fromItemId, v.payload.toItemId));
  }
  // 7. Durable hourly cap — read from the table, survives restarts.
  if (deps.store.countCreatedSince(now - HOUR_MS) >= cap.config.maxPerHour) {
    refuseAudited(
      deps,
      caller,
      kindRaw,
      clientLabel,
      "ERR_CAPTURE_RATE_LIMITED",
      "hourly capture cap reached",
    );
  }
  // 8. Pending cap — proposals only; a note is never pending. Actions and native proposals are
  //    bounded separately, and an expired action never counts.
  const queueFull =
    v.kind === "action"
      ? deps.store.countPendingActions(now) >= cap.config.actionMaxPending
      : v.kind !== "note" && deps.store.countPendingNative() >= cap.config.maxPending;
  if (queueFull) refuseQueueFull(ctx, v, cap);
  // 8b. Per-connection cap — one connection cannot take the whole action queue (agent door AD2).
  if (v.kind === "action") {
    const perConnection = Math.min(PER_CONNECTION_ACTIONS, cap.config.actionMaxPending);
    if (deps.store.countPendingActionsBySession(caller.clientId, now) >= perConnection) {
      refuseConnectionFull(ctx, perConnection);
    }
  }

  // 9 + 10. One transaction: capture row, item (notes only), audit.
  const written = writeSubmittedCapture(ctx, v, cap, now, basis);
  if (v.kind === "action") notifyActionProposed(deps, now);
  return written;
}

// ---- accept / reject (spec § 5.2) ---------------------------------------------------------------

/** Re-validate a stored payload: the stored JSON is already rebuilt, so this only re-types it. */
function storedPayload(row: CaptureRow): NativeValidatedCapture {
  if (row.payloadJson === null) {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${row.id} has no payload`);
  }
  const v = validateCapturePayload(row.kind, JSON.parse(row.payloadJson) as unknown, row.createdAt);
  if (v.kind === "action") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${row.id} is an action, not a native kind`,
    );
  }
  return v;
}

export function acceptCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
  act?: ActDeps,
): { id: string; state: "accepted"; nativeRef: string } | Promise<ActionAcceptResult> {
  // 1. Capability: switching the sink off FREEZES the queue (reject and revoke still work).
  const cap = deps.capability();
  if (!cap.enabled) {
    throw new CaptureError(
      "ERR_CAPTURE_DISABLED",
      `the capture sink is off (${cap.reason}); accepting is frozen, rejecting and revoking still work`,
    );
  }
  // 2. Owner only.
  requireOwner(caller);
  // 3. Must be proposed.
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  // An action takes the act door: its own fixed order, claim and terminal state (capture-act.ts).
  if (row.kind === "action") return acceptAction(deps, caller, row, act);
  if (row.state !== "proposed") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${id} is ${row.state}; only a proposed capture can be accepted`,
    );
  }
  const v = storedPayload(row);
  // 4. Referenced items still exist (they may have been deleted since submit).
  const missing = missingItem(deps, referencedItemIds(v));
  if (missing !== undefined) {
    throw new CaptureError(
      "ERR_CAPTURE_UNKNOWN_ITEM",
      `no indexed item ${missing}; the capture stays proposed`,
    );
  }
  // 5. Kind-specific precondition (the owner's nimbus.toml term wins; link endpoints still graphed).
  const link = assertAcceptable(deps.db, v);
  // 6. ONE transaction: native row, state, capture item, audit. Any failure rolls all of it back.
  const now = deps.now();
  const itemId = itemPrimaryKey(CAPTURE_ITEM_SERVICE, id);
  const text = renderAcceptedItem(v);
  let nativeRef = "";
  deps.db.transaction(() => {
    nativeRef = writeCaptureNative(deps.db, { captureId: id, itemId, v, link, nowMs: now });
    if (!deps.store.markAccepted(id, itemId, nativeRef, now)) {
      throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
    }
    upsertIndexedItem(deps.db, {
      service: CAPTURE_ITEM_SERVICE,
      type: CAPTURE_ITEM_TYPE,
      externalId: id,
      title: text.title,
      body: text.body,
      modifiedAt: now,
      syncedAt: now,
      metadata: {
        captureKind: row.kind,
        captureId: id,
        agentAuthored: true,
        clientLabel: row.clientLabel,
        nativeRef,
      },
    });
    appendAuditEntry(deps.db, {
      actionType: "capture.accept",
      // I4: no consent gate ran — the owner's own command is the decision. `approved` is
      // reserved for rows a gate earned (i04-hitl-status.test.ts APPROVED_ROW_IS_EARNED).
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ captureId: id, kind: row.kind, nativeRef, outcome: "accepted" }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  deps.scheduleEmbedding?.(itemId);
  return { id, state: "accepted", nativeRef };
}

export function rejectCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): { id: string; state: "rejected" } {
  // No capability check: the owner can always drain the queue (spec § 8.2).
  requireOwner(caller);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  if (row.state !== "proposed") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${id} is ${row.state}; only a proposed capture can be rejected`,
    );
  }
  const now = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.markRejected(id, now);
    if (!won) return;
    appendAuditEntry(deps.db, {
      actionType: "capture.reject",
      hitlStatus: "rejected",
      actionJson: JSON.stringify({ captureId: id, kind: row.kind, outcome: "rejected" }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (!won) throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
  deps.store.pruneFinished(now - FINISHED_RETENTION_MS);
  return { id, state: "rejected" };
}

// ---- owner reads ---------------------------------------------------------------------------------
