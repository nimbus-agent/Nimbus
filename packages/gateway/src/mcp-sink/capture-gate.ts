import type { Database } from "bun:sqlite";

import { appendAuditEntry } from "../db/audit-chain.ts";
import { deleteItemByPrimaryKey, itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import type { ClientKind } from "../ipc/server/client-kind.ts";
import type { CaptureCapability } from "./capture-capability.ts";
import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";
import {
  assertAcceptable,
  renderAcceptedItem,
  resolveLinkEndpoints,
  writeCaptureNative,
} from "./capture-native.ts";
import type { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import { type CaptureStore, REJECTED_RETENTION_MS } from "./capture-store.ts";
import {
  CaptureError,
  type CaptureErrorCode,
  type CaptureKind,
  type CaptureRow,
  type CaptureState,
  isCaptureKind,
  isCaptureState,
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
 * callers of `submitCapture`/`revokeCapture`/`acceptCapture`/`rejectCapture` to
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
}

export type CaptureDetail = CaptureSummary & {
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly itemId: string | null;
  readonly nativeRef: string | null;
};

export interface CaptureStatus {
  readonly enabled: boolean;
  readonly kinds: readonly CaptureKind[];
  readonly pending: number;
  readonly maxPending: number;
  readonly maxPerHour: number;
  readonly refusedSinceStart: Readonly<Record<string, number>>;
  readonly disabledReason?: string;
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
  };
}

// ---- submit (spec § 5.1) -------------------------------------------------------------------------

export function submitCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  input: unknown,
): { id: string; state: CaptureState } {
  // 1. Capability (config + live org policy, fail-closed).
  const cap = deps.capability();
  if (!cap.enabled)
    refuseUnaudited(deps, "ERR_CAPTURE_DISABLED", `the capture sink is off (${cap.reason})`);
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
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    refuseAudited(deps, caller, "unknown", null, "ERR_CAPTURE_INVALID", "params must be an object");
  }
  const params = input as Record<string, unknown>;
  const clientLabel = sanitizeClientLabel(params["clientLabel"]);
  const kindRaw = params["kind"];
  const kindName = typeof kindRaw === "string" ? kindRaw.slice(0, 20) : "unknown";
  // 4. Kind allowed by config AND supported by this gateway version.
  if (!isCaptureKind(kindRaw) || !cap.kinds.includes(kindRaw)) {
    refuseAudited(
      deps,
      caller,
      kindName,
      clientLabel,
      "ERR_CAPTURE_KIND_NOT_ALLOWED",
      `kind ${kindName} is not enabled`,
    );
  }
  // 5. Whitelist rebuild, per kind.
  let v: ValidatedCapture;
  try {
    v = validateCapturePayload(kindRaw, params["payload"], now);
  } catch (e) {
    if (e instanceof CaptureError)
      refuseAudited(deps, caller, kindRaw, clientLabel, e.code, e.message);
    throw e;
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
    try {
      resolveLinkEndpoints(deps.db, v.payload.fromItemId, v.payload.toItemId);
    } catch (e) {
      if (e instanceof CaptureError)
        refuseAudited(deps, caller, kindRaw, clientLabel, e.code, e.message);
      throw e;
    }
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
  // 8. Pending cap — proposals only; a note is never pending.
  const proposal = v.kind !== "note";
  if (proposal && deps.store.countByState("proposed") >= cap.config.maxPending) {
    refuseAudited(
      deps,
      caller,
      kindRaw,
      clientLabel,
      "ERR_CAPTURE_QUEUE_FULL",
      `the review queue is full (${String(cap.config.maxPending)} proposals await the owner)`,
    );
  }

  // 9 + 10. One transaction: capture row, item (notes only), audit. An audit failure rolls all of it
  //    back. A proposal gets no item, no native row and no embedding until accept (spec § 4.3).
  const id = deps.newId();
  const itemId = proposal ? null : itemPrimaryKey(CAPTURE_ITEM_SERVICE, id);
  const payloadJson = JSON.stringify(v.payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const state: CaptureState = proposal ? "proposed" : "live";
  deps.db.transaction(() => {
    deps.store.insert({
      id,
      kind: kindRaw,
      state,
      itemId,
      payloadJson,
      payloadBytes,
      clientLabel,
      sessionId: caller.clientId,
      createdAt: now,
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
          captureKind: kindRaw,
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
        kind: kindRaw,
        payloadBytes,
        clientLabel,
        outcome: proposal ? "proposed" : "captured",
      }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (itemId !== null) deps.scheduleEmbedding?.(itemId);
  return { id, state };
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
  if (row.state === "revoked") return { id, state: "revoked" };
  if (row.state !== "live") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${id} is ${row.state}; only a live note can be revoked in this version`,
    );
  }
  const now = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.markRevoked(id, "live", now);
    if (!won) return; // lost a race to another revoke: nothing to write
    if (row.itemId !== null) deleteItemByPrimaryKey(deps.db, row.itemId);
    appendAuditEntry(deps.db, {
      actionType: "capture.revoke",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ captureId: id, kind: row.kind, outcome: "revoked" }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (!won && deps.store.get(id)?.state !== "revoked") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
  }
  return { id, state: "revoked" };
}

// ---- accept / reject (spec § 5.2) ---------------------------------------------------------------

/** Re-validate a stored payload: the stored JSON is already rebuilt, so this only re-types it. */
function storedPayload(row: CaptureRow): ValidatedCapture {
  if (row.payloadJson === null) {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${row.id} has no payload`);
  }
  return validateCapturePayload(row.kind, JSON.parse(row.payloadJson) as unknown, row.createdAt);
}

export function acceptCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): { id: string; state: "accepted"; nativeRef: string } {
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
  // 5. Kind-specific precondition (owner's veto/config wins; link endpoints still graphed).
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
  deps.store.pruneRejected(now - REJECTED_RETENTION_MS);
  return { id, state: "rejected" };
}

// ---- owner reads ---------------------------------------------------------------------------------

export function listCaptures(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  paramsRaw: unknown,
): { captures: CaptureSummary[] } {
  requireOwner(caller);
  const p = paramsRaw === undefined ? {} : asRecord(paramsRaw);
  const state = p["state"];
  const kind = p["kind"];
  const limit = p["limit"] ?? LIST_LIMIT_DEFAULT;
  if (state !== undefined && !isCaptureState(state))
    throw new CaptureError("ERR_CAPTURE_INVALID", "unknown state");
  if (kind !== undefined && !isCaptureKind(kind))
    throw new CaptureError("ERR_CAPTURE_INVALID", "unknown kind");
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
  const filter: { state?: CaptureState; kind?: CaptureKind; limit: number } = { limit };
  if (state !== undefined) filter.state = state;
  if (kind !== undefined) filter.kind = kind;
  return { captures: deps.store.list(filter).map(summarize) };
}

export function getCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): CaptureDetail {
  requireOwner(caller);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  return {
    ...summarize(row),
    payload: row.payloadJson === null ? null : (JSON.parse(row.payloadJson) as unknown),
    payloadBytes: row.payloadBytes,
    itemId: row.itemId,
    nativeRef: row.nativeRef,
  };
}

export function captureStatus(deps: CaptureGateDeps): CaptureStatus {
  const cap = deps.capability();
  const base = {
    enabled: cap.enabled,
    kinds: cap.enabled ? cap.kinds : [],
    pending: deps.store.countByState("proposed"),
    maxPending: cap.config.maxPending,
    maxPerHour: cap.config.maxPerHour,
    refusedSinceStart: deps.refusals.snapshot(),
  };
  return cap.enabled ? base : { ...base, disabledReason: cap.reason };
}
