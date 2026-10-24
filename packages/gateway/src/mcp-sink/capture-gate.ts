import type { Database } from "bun:sqlite";

import { appendAuditEntry } from "../db/audit-chain.ts";
import { deleteEvidenceCitingItem } from "../decisions/decision-store.ts";
import { serviceOf } from "../engine/service-of.ts";
import { deleteItemByPrimaryKey, itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import type { ClientKind } from "../ipc/server/client-kind.ts";
import { type ActionAcceptResult, acceptAction, expireDueActionsAudited } from "./capture-act.ts";
import type { CaptureCapability } from "./capture-capability.ts";
import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";
import {
  assertAcceptable,
  captureNativeStatus,
  type NativeStatus,
  renderAcceptedItem,
  resolveLinkEndpoints,
  revokeCaptureNative,
  writeCaptureNative,
} from "./capture-native.ts";
import type { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import {
  actionTypeOfPayload,
  type CaptureListOrder,
  type CaptureStore,
  FINISHED_RETENTION_MS,
} from "./capture-store.ts";
import {
  type ActDeps,
  type ActionPayload,
  type ActionVerdict,
  CaptureError,
  type CaptureErrorCode,
  type CaptureKind,
  type CaptureRow,
  type CaptureState,
  isCaptureKind,
  isCaptureState,
  type NativeValidatedCapture,
  type ValidatedCapture,
} from "./capture-types.ts";
import {
  referencedItemIds,
  sanitizeClientLabel,
  validateCapturePayload,
} from "./capture-validate.ts";

/**
 * Invariant I28 — the ONE door by which content from an MCP client enters Nimbus (spec § 5).
 * Submit takes all four kinds: a note goes live at once, a decision/term/link is stored PROPOSED.
 * Submit runs a FIXED order; read it top to bottom in `submitCapture`. Static D32(b) confines the
 * callers of `submitCapture`/`revokeCapture`/`acceptCapture`/`rejectCapture`/`purgeCapture` to
 * `ipc/capture-rpc.ts`.
 */
export const CAPTURE_ITEM_SERVICE = "nimbus";
export const CAPTURE_ITEM_TYPE = "capture";
const HOUR_MS = 3_600_000;
const ATTEMPT_MULTIPLIER = 4;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

export interface CaptureGateDeps {
  readonly db: Database;
  readonly store: CaptureStore;
  capability(): CaptureCapability;
  readonly limiter: CaptureAttemptLimiter;
  readonly refusals: CaptureRefusalCounter;
  newId(): string;
  now(): number;
  scheduleEmbedding?(itemId: string): void;
  /** The act door's proposability verdict (spec § 7 step 5a). Absent → every action refuses. */
  classifyAction?(actionType: string): ActionVerdict;
  /** Whether the action's connector is configured on this machine (step 5b). Absent → refuses. */
  isServiceConfigured?(service: string): Promise<boolean>;
  /** The action types `capture.status` advertises as proposable now. */
  listProposableActionTypes?(): Promise<readonly string[]>;
}

export interface CaptureCaller {
  readonly clientId: string;
  readonly kind: ClientKind;
}

export interface CaptureSummary {
  readonly id: string;
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly title: string;
  readonly clientLabel: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly expiresAt: number | null;
}

export type CaptureDetail = CaptureSummary & {
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly itemId: string | null;
  readonly nativeRef: string | null;
  readonly nativeStatus: NativeStatus | null;
  readonly outcomeRef: string | null;
  readonly errorCode: string | null;
};

export interface CaptureStatus {
  readonly enabled: boolean;
  readonly kinds: readonly CaptureKind[];
  readonly pending: number;
  readonly maxPending: number;
  readonly maxPerHour: number;
  readonly refusedSinceStart: Readonly<Record<string, number>>;
  readonly actionEnabled: boolean;
  readonly proposableActionTypes: readonly string[];
  readonly actionPending: number;
  readonly actionMaxPending: number;
  readonly actionTtlHours: number;
  readonly actionExpiringWithinHour: number;
  readonly disabledReason?: string;
}

export interface CaptureStateView {
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly expiresAt?: number;
  readonly outcomeRef?: string;
  readonly errorCode?: string;
}

// ---- helpers -------------------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new CaptureError("ERR_CAPTURE_INVALID", "params must be an object");
  }
  return v as Record<string, unknown>;
}

/** Steps 1–3 refuse without an audit row: counted instead, so the attempt limit stays a bound. */
function refuseUnaudited(deps: CaptureGateDeps, code: CaptureErrorCode, detail: string): never {
  deps.refusals.bump(code);
  throw new CaptureError(code, detail);
}

/** Steps 4–8 refuse WITH an audit row — their rate is bounded by step 3. */
function refuseAudited(
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
    actionJson: JSON.stringify({ kind, clientLabel, outcome: code }),
    timestamp: deps.now(),
    sessionId: caller.clientId,
  });
  throw new CaptureError(code, detail);
}

function requireOwner(caller: CaptureCaller): void {
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "owner") {
    throw new CaptureError(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      `a ${caller.kind} client cannot review captures`,
    );
  }
}

function requireId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("cap_")) {
    throw new CaptureError("ERR_CAPTURE_INVALID", "id must be a capture id (cap_…)");
  }
  return raw;
}

function missingItem(deps: CaptureGateDeps, ids: readonly string[]): string | undefined {
  for (const id of ids) {
    const exists = deps.db.query("SELECT 1 FROM item WHERE id = ?").get(id) !== null;
    if (!exists) return id;
    const st = deps.store.stateOfItem(id);
    if (st !== undefined && st !== "live" && st !== "accepted") return id;
  }
  return undefined;
}

function titleOf(row: CaptureRow): string {
  if (row.payloadJson === null) return "(revoked)";
  const p = JSON.parse(row.payloadJson) as Record<string, unknown>;
  if (row.kind === "action") {
    const a = p as Partial<ActionPayload>;
    return `${String(a.actionType)}: ${String(a.summary)}`.slice(0, 120);
  }
  if (row.kind === "link") {
    const rel = typeof p["relation"] === "string" ? p["relation"] : "link";
    const from = typeof p["fromItemId"] === "string" ? p["fromItemId"] : "";
    const to = typeof p["toItemId"] === "string" ? p["toItemId"] : "";
    return `${rel}: ${from} → ${to}`.slice(0, 120);
  }
  const t = p["title"] ?? p["statement"] ?? p["term"];
  return typeof t === "string" ? t.slice(0, 120) : "";
}

function summarize(row: CaptureRow): CaptureSummary {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    title: titleOf(row),
    clientLabel: row.clientLabel,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
  };
}

// ---- submit (spec § 5.1) -------------------------------------------------------------------------

/** Who is submitting what, once step 4 has fixed the kind: every audited refusal names these. */
interface SubmitContext {
  readonly deps: CaptureGateDeps;
  readonly caller: CaptureCaller;
  readonly kind: CaptureKind;
  readonly clientLabel: string | null;
}

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

function refuseKindNotAllowed(
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
function auditedStep<T>(ctx: SubmitContext, step: () => T): T {
  try {
    return step();
  } catch (e) {
    if (e instanceof CaptureError)
      refuseAudited(ctx.deps, ctx.caller, ctx.kind, ctx.clientLabel, e.code, e.message);
    throw e;
  }
}

/** Step 5a's refusal: the action type is not proposable now. */
function requireProposable(
  ctx: SubmitContext,
  v: ActionCapture,
  classified: ActionVerdict | undefined,
): void {
  const verdict = classified ?? { kind: "unknown" as const };
  if (verdict.kind !== "proposable") {
    refuseAudited(
      ctx.deps,
      ctx.caller,
      "action",
      ctx.clientLabel,
      "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      `${v.payload.actionType} cannot be proposed (${verdict.kind === "denied" ? verdict.class : "unknown action type"})`,
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

/** Step 8's refusal: the action queue or the native-proposal queue is full. */
function refuseQueueFull(ctx: SubmitContext, v: ValidatedCapture, cap: CaptureCapability): never {
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

export async function submitCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  input: unknown,
): Promise<{ id: string; state: CaptureState; expiresAt?: number }> {
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
  const ctx: SubmitContext = { deps, caller, kind: kindRaw, clientLabel };
  // 5. Whitelist rebuild, per kind.
  const v = auditedStep(ctx, () => validateCapturePayload(kindRaw, params["payload"], now));
  // 5a + 5b. An action must be proposable now and its connector configured. Everything after this
  //    await stays synchronous through the write, so a concurrent submit cannot slip past the caps.
  if (v.kind === "action") {
    requireProposable(ctx, v, deps.classifyAction?.(v.payload.actionType));
    requireConfigured(ctx, v, await deps.isServiceConfigured?.(serviceOf(v.payload.actionType)));
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

  // 9 + 10. One transaction: capture row, item (notes only), audit.
  return writeSubmittedCapture(ctx, v, cap, now);
}

/**
 * Steps 9 + 10: one transaction — capture row, item (notes only), audit. An audit failure rolls all
 * of it back. A proposal gets no item, no native row and no embedding until accept (spec § 4.3).
 */
function writeSubmittedCapture(
  ctx: SubmitContext,
  v: ValidatedCapture,
  cap: CaptureCapability,
  now: number,
): { id: string; state: CaptureState; expiresAt?: number } {
  const { deps, caller, kind, clientLabel } = ctx;
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
        payloadBytes,
        clientLabel,
        outcome: proposal ? "proposed" : "captured",
      }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (itemId !== null) deps.scheduleEmbedding?.(itemId);
  return expiresAt === null ? { id, state } : { id, state, expiresAt };
}

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
      // reserved for rows a gate earned (security-invariants.test.ts APPROVED_ROW_IS_EARNED).
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

export function listCaptures(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  paramsRaw: unknown,
): { captures: CaptureSummary[] } {
  requireOwner(caller);
  expireDueActionsAudited(deps, deps.now(), caller.clientId);
  const p = paramsRaw === undefined ? {} : asRecord(paramsRaw);
  const state = p["state"];
  const kind = p["kind"];
  const order = p["order"];
  const limit = p["limit"] ?? LIST_LIMIT_DEFAULT;
  if (state !== undefined && !isCaptureState(state))
    throw new CaptureError("ERR_CAPTURE_INVALID", "unknown state");
  if (kind !== undefined && !isCaptureKind(kind))
    throw new CaptureError("ERR_CAPTURE_INVALID", "unknown kind");
  if (order !== undefined && order !== "asc" && order !== "desc")
    throw new CaptureError("ERR_CAPTURE_INVALID", "order must be asc or desc");
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIST_LIMIT_MAX
  ) {
    throw new CaptureError(
      "ERR_CAPTURE_INVALID",
      `limit must be an integer 1..${String(LIST_LIMIT_MAX)}`,
    );
  }
  const filter: {
    state?: CaptureState;
    kind?: CaptureKind;
    limit: number;
    order?: CaptureListOrder;
  } = { limit };
  if (state !== undefined) filter.state = state;
  if (kind !== undefined) filter.kind = kind;
  if (order !== undefined) filter.order = order;
  return { captures: deps.store.list(filter).map(summarize) };
}

export function getCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): CaptureDetail {
  requireOwner(caller);
  expireDueActionsAudited(deps, deps.now(), caller.clientId);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  return {
    ...summarize(row),
    payload: row.payloadJson === null ? null : (JSON.parse(row.payloadJson) as unknown),
    payloadBytes: row.payloadBytes,
    itemId: row.itemId,
    nativeRef: row.nativeRef,
    nativeStatus:
      row.state === "accepted" && row.nativeRef !== null
        ? captureNativeStatus(deps.db, { id: row.id, kind: row.kind, nativeRef: row.nativeRef })
        : null,
    outcomeRef: row.outcomeRef,
    errorCode: row.errorCode,
  };
}

/** `capture.state` (spec § 10): the agent polls a capture whose id it holds — never its payload. */
export function captureStateFor(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): CaptureStateView {
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "submit") {
    throw new CaptureError(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      "capture.state is for MCP clients; the owner uses captures.get",
    );
  }
  const id = requireId(idRaw);
  expireDueActionsAudited(deps, deps.now(), caller.clientId);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  return {
    kind: row.kind,
    state: row.state,
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
    ...(row.outcomeRef === null ? {} : { outcomeRef: row.outcomeRef }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  };
}

export async function captureStatus(deps: CaptureGateDeps): Promise<CaptureStatus> {
  const now = deps.now();
  expireDueActionsAudited(deps, now, "capture-status");
  const cap = deps.capability();
  const types = cap.actionEnabled ? ((await deps.listProposableActionTypes?.()) ?? []) : [];
  const base = {
    enabled: cap.enabled,
    kinds: cap.enabled ? cap.kinds : [],
    pending: deps.store.countPendingNative(),
    maxPending: cap.config.maxPending,
    maxPerHour: cap.config.maxPerHour,
    refusedSinceStart: deps.refusals.snapshot(),
    actionEnabled: cap.actionEnabled,
    proposableActionTypes: types.slice(0, 200),
    actionPending: deps.store.countPendingActions(now),
    actionExpiringWithinHour: deps.store.countPendingActionsExpiringBy(now, now + HOUR_MS),
    actionMaxPending: cap.config.actionMaxPending,
    actionTtlHours: cap.config.actionTtlHours,
  };
  return cap.enabled ? base : { ...base, disabledReason: cap.reason };
}
