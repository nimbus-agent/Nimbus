/**
 * Phase 28 AD4: the reader behind `audit.proveByProposer` and `audit.listByDoor`. It READS the two
 * tamper-evident ledgers (the audit log and the egress ledger) and writes nothing.
 *
 * What it may conclude: these proposals were recorded, the owner's gate decided this many, and the
 * two ledgers agree capture by capture. What it may not: which program sent them. Every label is
 * the client's own claim (`labelsVerified: false`), and is returned only in the escaped form the
 * approval prompt uses (`escapeUnverifiedLine`).
 *
 * Rows are classified by an ANCHORED match of the prefix the executor writes (`classifyAuditRow`),
 * never by a substring or a parse of the whole row: a row cut by the audit cap is not JSON, and an
 * unanchored match could be forged by an input object that carries the same text. Parsing is in
 * TypeScript, never `json_extract`.
 *
 * The completeness check (design D-7 of the AD4 plan) compares the ledgers per CAPTURE and loads
 * each checked capture's whole history, so a window never truncates a capture's own rows.
 */
import type { Database } from "bun:sqlite";
import { BOOT_MARKER_METHOD } from "../egress/egress-boot-marker.ts";
import { AGENT_SOURCE_PREFIX } from "../egress/egress-record.ts";
import { coverageForWindow } from "../egress/egress-verify.ts";
import { escapeUnverifiedLine } from "../engine/proposer-block.ts";
import { redactAuditPayload } from "./format-audit-payload.ts";

// ---- constants ---------------------------------------------------------------------------------

/** Matched audit rows (or egress rows) one proof reads before the scan is cut. A guess, stated as one. */
export const PROOF_MAX_ROWS = 50_000;
/** Audit rows one `listByDoor` call examines before the scan is cut. */
export const LIST_MAX_SCAN = 100_000;
const LIST_LIMIT_DEFAULT = 100;
const LIST_PAGE = 500;
const LIST_LIMIT_MAX = 1_000;

/** The doors a row can be shown under; `other` is everything the gateway does not mark (never claimed as the owner's). */
export const DOORS = ["agent", "model", "workflow", "other"] as const;
export type Door = (typeof DOORS)[number];

/** Every way the two ledgers can disagree about a capture. */
export const MISMATCH_CODES = [
  "audit_row_without_egress_row",
  "egress_row_without_audit_row",
  "status_differs",
  "result_status_differs",
  "duplicate_dispatch",
  "duplicate_accept",
  "duplicate_outcome",
  "missing_outcome",
  "executed_without_approval",
  "rejected_with_approval",
  "label_changed",
  "accept_missing",
] as const;
export type MismatchCode = (typeof MISMATCH_CODES)[number];

/** Why a proof is `indeterminate` (any one is enough). */
export type IndeterminateCause =
  | "mismatch"
  | "unreadable_row"
  | "scan_cut"
  | "audit_chain_broken"
  | "egress_chain_broken"
  | "coverage_none";

// ---- row classification -------------------------------------------------------------------------

/** A JSON string's body: any run of non-quote, non-backslash characters and escapes. */
const STR = String.raw`(?:[^"\\]|\\.)*`;
/** The keys `auditPayload` writes BEFORE `action`: a standing-rule link, then the bound write's digests. */
const LEADING = String.raw`\{(?:"standingRule":\{[^{}]*\},)?(?:"(?:boundValuesSha256|diffSha256|filesSha256)":"[0-9a-f]{64}",)*"action":\{"type":"(${STR})"`;
const GATE_RE = new RegExp(
  String.raw`^${LEADING},"proposer":\{"door":"agent","captureId":"(cap_[0-9a-f]{32})"(?:,"label":(null|"${STR}"),"labelSource":"(declared|kit)")?\}`,
);
const SUB_STEP_RE = new RegExp(
  String.raw`^\{"onBehalfOf":\{"door":"agent","captureId":"(cap_[0-9a-f]{32})"\},"action":\{"type":"(${STR})"`,
);
const MODEL_RE = new RegExp(String.raw`^${LEADING},"origin":"model"[,}]`);
// Only a workflow run's action carries a `provenance` key, and only right after the type; this
// module names no provenance kind (static D44(a) confines that literal).
const WORKFLOW_RE = new RegExp(String.raw`^${LEADING},"provenance":\{"kind":"[a-z_]+"`);
const OUTCOME_CUT_RE = new RegExp(
  String.raw`^\{"captureId":"(cap_[0-9a-f]{32})"(?:,"actionType":"${STR}")?,"outcome":"(${STR})"`,
);

export type RowClass =
  | {
      readonly door: "agent";
      readonly subStep: false;
      readonly captureId: string;
      readonly type: string;
      /** The client's own label; `undefined` on a row written before AD4 (the two-field projection). */
      readonly label: string | null | undefined;
      readonly labelSource: "declared" | "kit" | undefined;
      readonly legacyProjection: boolean;
    }
  | {
      readonly door: "agent";
      readonly subStep: true;
      readonly captureId: string;
      readonly type: string;
    }
  | { readonly door: "model" | "workflow" | "other" };

function decodeString(quoted: string): string | undefined {
  try {
    const v: unknown = JSON.parse(quoted);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which door an executor audit row came through, from its PREFIX only (design D-6). A proposer
 * object inside an input sits later in the row and can never match. Anything the gateway does not
 * mark is `other`.
 */
export function classifyAuditRow(_actionType: string, actionJson: string): RowClass {
  const gate = GATE_RE.exec(actionJson);
  if (gate !== null) {
    const type = decodeString(`"${gate[1] ?? ""}"`);
    const rawLabel = gate[3];
    const label = rawLabel === undefined || rawLabel === "null" ? null : decodeString(rawLabel);
    // A label or type that does not decode is not a row the gateway wrote.
    if (type === undefined || label === undefined) return { door: "other" };
    const source = gate[4];
    return {
      door: "agent",
      subStep: false,
      captureId: gate[2] ?? "",
      type,
      label: rawLabel === undefined ? undefined : label,
      labelSource: source === "declared" || source === "kit" ? source : undefined,
      legacyProjection: rawLabel === undefined,
    };
  }
  const sub = SUB_STEP_RE.exec(actionJson);
  if (sub !== null) {
    const type = decodeString(`"${sub[2] ?? ""}"`);
    return type === undefined
      ? { door: "other" }
      : { door: "agent", subStep: true, captureId: sub[1] ?? "", type };
  }
  if (MODEL_RE.test(actionJson)) return { door: "model" };
  if (WORKFLOW_RE.test(actionJson)) return { door: "workflow" };
  return { door: "other" };
}

// ---- the lifecycle rows -------------------------------------------------------------------------

interface AuditRow {
  readonly id: number;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly actionJson: string;
  readonly timestamp: number;
}

interface Lifecycle {
  readonly captureId: string;
  readonly kind: string | undefined;
  readonly actionType: string | undefined;
  readonly outcome: string | undefined;
  readonly clientLabel: string | null | undefined;
  readonly hasLabelSource: boolean;
  readonly labelSource: "declared" | "kit" | undefined;
  readonly connection: string | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Parse a `capture.*` row; a row the audit cap cut is read from its prefix, anything else is unreadable. */
function parseLifecycle(actionType: string, actionJson: string): Lifecycle | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(actionJson);
  } catch {
    const cut = OUTCOME_CUT_RE.exec(actionJson);
    if (cut === null || actionType !== "capture.action.outcome") return undefined;
    return {
      captureId: cut[1] ?? "",
      kind: undefined,
      actionType: undefined,
      outcome: cut[2],
      clientLabel: undefined,
      hasLabelSource: false,
      labelSource: undefined,
      connection: undefined,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  const captureId = str(o["captureId"]);
  const label = o["clientLabel"];
  const source = o["labelSource"];
  return {
    captureId: captureId ?? "",
    kind: str(o["kind"]),
    actionType: str(o["actionType"]),
    outcome: str(o["outcome"]),
    clientLabel: typeof label === "string" || label === null ? label : undefined,
    hasLabelSource: source === "declared" || source === "kit",
    labelSource: source === "declared" || source === "kit" ? source : undefined,
    connection: str(o["connection"]),
  };
}

/** A label as the executor's audit row holds it: through the same redaction. */
function redactLabel(label: string | null): string | null {
  const v: unknown = JSON.parse(redactAuditPayload(label));
  return typeof v === "string" ? v : null;
}

// ---- the reads ----------------------------------------------------------------------------------

interface EgressRow {
  readonly id: number;
  readonly timestamp: number;
  readonly sourceId: string;
  readonly method: string;
  readonly hitlStatus: string;
  readonly resultStatus: string;
}

/** The audit rows of the agent door: every `capture.*` row and every row that names a capture id. */
function readAuditRows(db: Database, maxRows: number): { rows: AuditRow[]; cut: boolean } {
  // One row past the cap says the scan was cut. The statement always runs to completion: an early
  // exit from an iterator would leave the cached statement open.
  const found = db
    .query<AuditPageRow, [number]>(
      `SELECT id, action_type, hitl_status, action_json, timestamp FROM audit_log
     WHERE action_type LIKE 'capture.%' OR action_json LIKE '%"captureId":"cap\\_%' ESCAPE '\\'
     ORDER BY id ASC LIMIT ?`,
    )
    .all(maxRows + 1);
  const rows: AuditRow[] = found.slice(0, maxRows).map((r) => ({
    id: r.id,
    actionType: r.action_type,
    hitlStatus: r.hitl_status,
    actionJson: r.action_json,
    timestamp: r.timestamp,
  }));
  return { rows, cut: found.length > maxRows };
}

interface AuditPageRow {
  readonly id: number;
  readonly action_type: string;
  readonly hitl_status: string;
  readonly action_json: string;
  readonly timestamp: number;
}

/** Every `agent:<captureId>` row of the task class (served by `idx_egress_ledger_source`). */
function readEgressRows(db: Database, maxRows: number): { rows: EgressRow[]; cut: boolean } {
  const upper = `${AGENT_SOURCE_PREFIX.slice(0, -1)}${String.fromCharCode(
    AGENT_SOURCE_PREFIX.charCodeAt(AGENT_SOURCE_PREFIX.length - 1) + 1,
  )}`;
  const found = db
    .query<
      {
        id: number;
        timestamp: number;
        source_id: string;
        method: string;
        hitl_status: string;
        result_status: string;
      },
      [string, string, number]
    >(
      `SELECT id, timestamp, source_id, method, hitl_status, result_status FROM egress_ledger
     WHERE source_type = 'task' AND source_id >= ? AND source_id < ? ORDER BY id ASC LIMIT ?`,
    )
    .all(AGENT_SOURCE_PREFIX, upper, maxRows + 1);
  const rows: EgressRow[] = found.slice(0, maxRows).map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    sourceId: r.source_id,
    method: r.method,
    hitlStatus: r.hitl_status,
    resultStatus: r.result_status,
  }));
  return { rows, cut: found.length > maxRows };
}

/**
 * The newest prune's CUTOFF: the `before` value its tombstone's summary records, never the run time
 * (the prune deletes rows older than `before`, so only those may lack an egress row). `payload_summary`
 * is not a hashed field, so it is read fail-closed: a summary that does not parse to a finite number
 * exempts nothing, and a `before` later than the tombstone's own timestamp is that timestamp.
 */
function pruneCutoff(db: Database): number | undefined {
  const rows = db
    .query<{ timestamp: number; payload_summary: string }, []>(
      `SELECT timestamp, payload_summary FROM egress_ledger WHERE source_type = 'prune' AND method = 'egress.prune'`,
    )
    .all();
  let cutoff: number | undefined;
  for (const r of rows) {
    let before: unknown;
    try {
      before = (JSON.parse(r.payload_summary) as { before?: unknown }).before;
    } catch {
      continue;
    }
    if (typeof before !== "number" || !Number.isFinite(before)) continue;
    const effective = Math.min(before, r.timestamp);
    cutoff = cutoff === undefined ? effective : Math.max(cutoff, effective);
  }
  return cutoff;
}

function newestBootMarker(db: Database): number | undefined {
  const row = db
    .query<{ t: number | null }, [string]>(
      `SELECT MAX(timestamp) AS t FROM egress_ledger WHERE source_type = 'boot' AND method = ?`,
    )
    .get(BOOT_MARKER_METHOD);
  return row?.t ?? undefined;
}

// ---- the per-capture model ---------------------------------------------------------------------

interface GateRec {
  readonly type: string;
  readonly hitl: string;
  readonly timestamp: number;
  readonly subStep: boolean;
  readonly label: string | null | undefined;
}

interface Recorded {
  readonly row: AuditRow;
  readonly life: Lifecycle;
}

interface History {
  readonly id: string;
  submit?: Recorded;
  readonly accepts: Recorded[];
  readonly outcomes: Recorded[];
  readonly rejects: AuditRow[];
  readonly expires: AuditRow[];
  readonly gates: GateRec[];
  readonly egress: EgressRow[];
}

function newHistory(id: string): History {
  return { id, accepts: [], outcomes: [], rejects: [], expires: [], gates: [], egress: [] };
}

interface Model {
  readonly captures: Map<string, History>;
  readonly refusedSubmits: Recorded[];
  unreadable: number;
}

function historyOf(m: Model, id: string): History {
  let h = m.captures.get(id);
  if (h === undefined) {
    h = newHistory(id);
    m.captures.set(id, h);
  }
  return h;
}

const CAPTURE_ID_RE = /^cap_[0-9a-f]{32}$/;

function addLifecycle(m: Model, r: AuditRow): void {
  const life = parseLifecycle(r.actionType, r.actionJson);
  if (life === undefined) {
    m.unreadable += 1;
    return;
  }
  if (!CAPTURE_ID_RE.test(life.captureId)) {
    // The one lifecycle row with no capture id is a submit the gate refused.
    if (r.actionType === "capture.submit" && life.kind === "action") {
      m.refusedSubmits.push({ row: r, life });
    }
    return;
  }
  const h = historyOf(m, life.captureId);
  switch (r.actionType) {
    case "capture.submit":
      h.submit = { row: r, life };
      break;
    case "capture.action.accept":
      h.accepts.push({ row: r, life });
      break;
    case "capture.action.outcome":
      h.outcomes.push({ row: r, life });
      break;
    case "capture.reject":
      h.rejects.push(r);
      break;
    case "capture.action.expire":
      h.expires.push(r);
      break;
    default:
      break;
  }
}

function buildModel(auditRows: readonly AuditRow[], egressRows: readonly EgressRow[]): Model {
  const m: Model = { captures: new Map(), refusedSubmits: [], unreadable: 0 };
  for (const r of auditRows) {
    if (r.actionType.startsWith("capture.")) {
      addLifecycle(m, r);
      continue;
    }
    const c = classifyAuditRow(r.actionType, r.actionJson);
    if (c.door !== "agent") continue;
    historyOf(m, c.captureId).gates.push({
      type: c.type,
      hitl: r.hitlStatus,
      timestamp: r.timestamp,
      subStep: c.subStep,
      label: c.subStep ? undefined : c.label,
    });
  }
  for (const e of egressRows) {
    const id = e.sourceId.slice(AGENT_SOURCE_PREFIX.length);
    if (!CAPTURE_ID_RE.test(id)) {
      m.unreadable += 1;
      continue;
    }
    historyOf(m, id).egress.push(e);
  }
  return m;
}

/** The type of the write itself: the first gate row that is not a sub-step, else what the lifecycle rows name. */
function writeTypeOf(h: History): string | undefined {
  return (
    h.gates.find((g) => !g.subStep)?.type ??
    h.accepts[0]?.life.actionType ??
    h.submit?.life.actionType
  );
}

/** The client's label for grouping: the submit row's, else the accept row's, else a gate row's. */
function labelOf(h: History): { label: string | null; source: "declared" | "kit" } {
  const accept = h.accepts.find((a) => a.life.clientLabel !== undefined);
  const gate = h.gates.find((g) => !g.subStep && g.label !== undefined);
  const raw = h.submit?.life.clientLabel ?? accept?.life.clientLabel ?? gate?.label ?? null;
  const source = accept?.life.labelSource ?? "declared";
  return { label: raw, source };
}

// ---- the proof ---------------------------------------------------------------------------------

export interface ChainStatus {
  readonly ok: boolean;
  readonly reason?: string | undefined;
}

export interface ProposerGroup {
  /** The client's own label, ESCAPED for display; `null` when the client sent none. */
  readonly label: string | null;
  readonly labelSource: "declared" | "kit";
  readonly proposed: number;
  readonly refusedAtSubmit: number;
  readonly approved: number;
  readonly declined: number;
  readonly executed: number;
  readonly failed: number;
  readonly expired: number;
  readonly waiting: number;
  readonly dispatches: number;
  /** How many distinct connections sent this label (an id lasts one process start). */
  readonly connections: number;
}

export interface Mismatch {
  readonly code: MismatchCode;
  readonly captureId: string;
}

export interface ProposerProof {
  /** Always false: every label is the client's own claim. */
  readonly labelsVerified: false;
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
  readonly groups: readonly ProposerGroup[];
  readonly scanCut: boolean;
  readonly completeness: {
    readonly status: "ok" | "indeterminate";
    readonly causes: readonly IndeterminateCause[];
    readonly mismatches: readonly Mismatch[];
    readonly checkedCaptures: number;
    readonly unreadableRows: number;
    readonly notChecked: {
      /** Proposals accepted before this version recorded the label source. */
      readonly preVersionCaptures: number;
      /** Gate rows older than the newest egress prune's cutoff. */
      readonly prunedGateRows: number;
    };
  };
}

export interface ProofOptions {
  readonly sinceMs?: number | undefined;
  readonly untilMs?: number | undefined;
  /** Keep only the groups whose label is this (the stored text or its escaped form). */
  readonly byLabel?: string | undefined;
  /** Result of the audit chain verify, run by the caller. */
  readonly audit: ChainStatus;
  /** Result of the egress chain verify, run by the caller. */
  readonly egress: ChainStatus;
  readonly maxRows?: number | undefined;
}

interface Window {
  readonly since: number;
  readonly until: number;
}

const inWindow = (w: Window, t: number): boolean => t >= w.since && t <= w.until;

interface Counters {
  proposed: number;
  refusedAtSubmit: number;
  approved: number;
  declined: number;
  executed: number;
  failed: number;
  expired: number;
  waiting: number;
  dispatches: number;
  readonly connections: Set<string>;
}

function counters(): Counters {
  return {
    proposed: 0,
    refusedAtSubmit: 0,
    approved: 0,
    declined: 0,
    executed: 0,
    failed: 0,
    expired: 0,
    waiting: 0,
    dispatches: 0,
    connections: new Set(),
  };
}

/** The counts of one window, grouped by (label, label source). */
function countGroups(m: Model, w: Window): ProposerGroup[] {
  const byKey = new Map<
    string,
    { label: string | null; source: "declared" | "kit"; c: Counters }
  >();
  const groupFor = (label: string | null, source: "declared" | "kit"): Counters => {
    const key = `${source}\u0000${label === null ? "n" : `s${label}`}`;
    let g = byKey.get(key);
    if (g === undefined) {
      g = { label, source, c: counters() };
      byKey.set(key, g);
    }
    return g.c;
  };
  for (const h of m.captures.values()) {
    const { label, source } = labelOf(h);
    const writeType = writeTypeOf(h);
    const c = groupFor(label, source);
    countCaptureEvents(h, w, writeType, c);
  }
  for (const r of m.refusedSubmits) {
    if (!inWindow(w, r.row.timestamp) || r.row.hitlStatus !== "rejected") continue;
    const c = groupFor(r.life.clientLabel ?? null, "declared");
    c.refusedAtSubmit += 1;
    if (r.life.connection !== undefined) c.connections.add(r.life.connection);
  }
  const groups: ProposerGroup[] = [];
  for (const g of byKey.values()) {
    const c = g.c;
    const touched =
      c.proposed +
      c.refusedAtSubmit +
      c.approved +
      c.declined +
      c.executed +
      c.failed +
      c.expired +
      c.waiting +
      c.dispatches;
    if (touched === 0) continue;
    groups.push({
      label: g.label === null ? null : escapeUnverifiedLine(g.label),
      labelSource: g.source,
      proposed: c.proposed,
      refusedAtSubmit: c.refusedAtSubmit,
      approved: c.approved,
      declined: c.declined,
      executed: c.executed,
      failed: c.failed,
      expired: c.expired,
      waiting: c.waiting,
      dispatches: c.dispatches,
      connections: c.connections.size,
    });
  }
  return groups.sort(compareGroups);
}

function compareGroups(a: ProposerGroup, b: ProposerGroup): number {
  const la = a.label ?? "";
  const lb = b.label ?? "";
  if (a.label === null && b.label !== null) return -1;
  if (a.label !== null && b.label === null) return 1;
  if (la !== lb) return la < lb ? -1 : 1;
  return a.labelSource < b.labelSource ? -1 : a.labelSource > b.labelSource ? 1 : 0;
}

function countCaptureEvents(
  h: History,
  w: Window,
  writeType: string | undefined,
  c: Counters,
): void {
  if (h.submit !== undefined && inWindow(w, h.submit.row.timestamp)) {
    const isAction = h.submit.life.kind === "action";
    if (isAction && h.submit.life.outcome === "proposed") {
      c.proposed += 1;
      const terminal = h.accepts.length + h.rejects.length + h.expires.length > 0;
      if (!terminal) c.waiting += 1;
    }
    if (isAction && h.submit.life.connection !== undefined)
      c.connections.add(h.submit.life.connection);
  }
  for (const a of h.accepts) {
    if (inWindow(w, a.row.timestamp) && a.life.connection !== undefined)
      c.connections.add(a.life.connection);
  }
  for (const g of h.gates) {
    if (!g.subStep && g.hitl === "approved" && inWindow(w, g.timestamp)) c.approved += 1;
  }
  for (const r of h.rejects) {
    if (inWindow(w, r.timestamp) && actionRejectKind(r) === "action") c.declined += 1;
  }
  for (const o of h.outcomes) {
    if (!inWindow(w, o.row.timestamp)) continue;
    if (o.life.outcome === "rejected") c.declined += 1;
    else if (o.life.outcome === "executed") c.executed += 1;
    else if (o.life.outcome === "failed") c.failed += 1;
  }
  for (const e of h.expires) if (inWindow(w, e.timestamp)) c.expired += 1;
  for (const e of h.egress) {
    if (inWindow(w, e.timestamp) && e.resultStatus === "authorized" && e.method === writeType) {
      c.dispatches += 1;
    }
  }
}

/** `capture.reject` names the kind of the capture it rejected. */
function actionRejectKind(r: AuditRow): string | undefined {
  return parseLifecycle(r.actionType, r.actionJson)?.kind;
}

// ---- the completeness check (D-7) ---------------------------------------------------------------

interface CheckCtx {
  readonly cutoff: number | undefined;
  readonly newestBoot: number | undefined;
}

interface CheckResult {
  readonly mismatches: Mismatch[];
  readonly checked: boolean;
  readonly preVersion: boolean;
  readonly prunedGateRows: number;
}

const keyOf = (type: string, status: string): string => `${type}\u0000${status}`;

/** E1: the audit gate rows against the egress rows, as multisets of (type, status). */
function pairLedgers(h: History, gates: readonly GateRec[], found: Set<MismatchCode>): void {
  const unmatchedEgress = new Map<string, EgressRow[]>();
  for (const e of h.egress) {
    const k = keyOf(e.method, e.hitlStatus);
    unmatchedEgress.set(k, [...(unmatchedEgress.get(k) ?? []), e]);
    const blocked = e.resultStatus === "blocked";
    if (blocked !== (e.hitlStatus === "rejected")) found.add("result_status_differs");
  }
  const unmatchedAudit: GateRec[] = [];
  for (const g of gates) {
    const k = keyOf(g.type, g.hitl);
    const list = unmatchedEgress.get(k);
    if (list === undefined || list.length === 0) unmatchedAudit.push(g);
    else list.pop();
  }
  for (const g of unmatchedAudit) {
    const sameType = [...unmatchedEgress.entries()].find(
      ([k, list]) => list.length > 0 && k.startsWith(`${g.type}\u0000`),
    );
    if (sameType === undefined) {
      found.add("audit_row_without_egress_row");
    } else {
      found.add("status_differs");
      sameType[1].pop();
    }
  }
  for (const list of unmatchedEgress.values()) {
    if (list.length > 0) found.add("egress_row_without_audit_row");
  }
}

/** E2 and L2: one approval and one dispatch at most, and the outcome agrees with the gate. */
function checkApprovals(h: History, gates: readonly GateRec[], found: Set<MismatchCode>): void {
  const writeType = writeTypeOf(h);
  const approved = gates.filter(
    (g) => !g.subStep && g.type === writeType && g.hitl === "approved",
  ).length;
  const dispatched = h.egress.filter(
    (e) => e.method === writeType && e.resultStatus === "authorized",
  ).length;
  if (approved > 1 || dispatched > 1) found.add("duplicate_dispatch");
  const last = h.outcomes.at(-1)?.life.outcome;
  if (last === "executed" && approved !== 1) found.add("executed_without_approval");
  if (last === "rejected" && approved !== 0) found.add("rejected_with_approval");
}

/** L1: one accept, then exactly one outcome (an accept older than the newest boot marker has had its reconcile). */
function checkLifecycle(h: History, ctx: CheckCtx, found: Set<MismatchCode>): void {
  if (h.accepts.length > 1) found.add("duplicate_accept");
  if (h.outcomes.length > 1) found.add("duplicate_outcome");
  const accept = h.accepts[0];
  if (
    accept !== undefined &&
    h.outcomes.length === 0 &&
    ctx.newestBoot !== undefined &&
    accept.row.timestamp < ctx.newestBoot
  ) {
    found.add("missing_outcome");
  }
}

/** L3: the submit row, the accept row and every gate row carry one label, after the same redaction. */
function checkLabels(h: History, found: Set<MismatchCode>): void {
  const seen = new Set<string | null>();
  if (h.submit !== undefined && h.submit.life.clientLabel !== undefined) {
    seen.add(redactLabel(h.submit.life.clientLabel));
  }
  for (const a of h.accepts) {
    if (a.life.clientLabel !== undefined) seen.add(redactLabel(a.life.clientLabel));
  }
  for (const g of h.gates) {
    if (!g.subStep && g.label !== undefined) seen.add(g.label);
  }
  if (seen.size > 1) found.add("label_changed");
}

function checkCapture(h: History, ctx: CheckCtx): CheckResult {
  const found = new Set<MismatchCode>();
  const hasRows = h.gates.length > 0 || h.egress.length > 0;
  if (h.accepts.length === 0) {
    // Rows of an agent action with no accept row at all: the accept row is missing.
    if (hasRows) found.add("accept_missing");
    pairLedgers(h, h.gates, found);
    return result(h, found, true, false, 0);
  }
  if (!h.accepts.some((a) => a.life.hasLabelSource)) {
    return { mismatches: [], checked: false, preVersion: true, prunedGateRows: 0 };
  }
  const cutoff = ctx.cutoff;
  const exempt = cutoff === undefined ? [] : h.gates.filter((g) => g.timestamp < cutoff);
  const gates = h.gates.filter((g) => !exempt.includes(g));
  pairLedgers(h, gates, found);
  // A capture with a gate row the prune made unverifiable cannot say whether its approval is single.
  if (exempt.length === 0) checkApprovals(h, gates, found);
  checkLifecycle(h, ctx, found);
  checkLabels(h, found);
  // A capture whose every gate row the prune made unverifiable was not checked against the ledger.
  const wholly = h.gates.length > 0 && exempt.length === h.gates.length;
  return result(h, found, !wholly, false, exempt.length);
}

function result(
  h: History,
  found: ReadonlySet<MismatchCode>,
  checked: boolean,
  preVersion: boolean,
  prunedGateRows: number,
): CheckResult {
  return {
    mismatches: [...found].map((code) => ({ code, captureId: h.id })),
    checked,
    preVersion,
    prunedGateRows,
  };
}

/** The captures to check: those with an accept, a gate row or an egress row inside the window (D-7). */
function selectCaptures(m: Model, w: Window): History[] {
  const picked: History[] = [];
  for (const h of m.captures.values()) {
    const touched =
      h.accepts.some((a) => inWindow(w, a.row.timestamp)) ||
      h.gates.some((g) => inWindow(w, g.timestamp)) ||
      h.egress.some((e) => inWindow(w, e.timestamp));
    if (touched) picked.push(h);
  }
  return picked;
}

/**
 * `nimbus prove --by-proposer`: the agent door's actions grouped by the client's own label, with
 * the completeness check of both ledgers. Reads only. See the file header for what it may conclude.
 */
export function proveByProposer(db: Database, opts: ProofOptions): ProposerProof {
  const maxRows = opts.maxRows ?? PROOF_MAX_ROWS;
  const w: Window = { since: opts.sinceMs ?? 0, until: opts.untilMs ?? Number.MAX_SAFE_INTEGER };
  const audit = readAuditRows(db, maxRows);
  const egress = readEgressRows(db, maxRows);
  const model = buildModel(audit.rows, egress.rows);
  const ctx: CheckCtx = { cutoff: pruneCutoff(db), newestBoot: newestBootMarker(db) };

  const mismatches: Mismatch[] = [];
  let checked = 0;
  let preVersion = 0;
  let pruned = 0;
  for (const h of selectCaptures(model, w)) {
    const r = checkCapture(h, ctx);
    mismatches.push(...r.mismatches);
    if (r.checked) checked += 1;
    if (r.preVersion) preVersion += 1;
    pruned += r.prunedGateRows;
  }

  const scanCut = audit.cut || egress.cut;
  const coverage = coverageForWindow(db, { since: opts.sinceMs, until: opts.untilMs });
  const causes: IndeterminateCause[] = [];
  if (mismatches.length > 0) causes.push("mismatch");
  if (model.unreadable > 0) causes.push("unreadable_row");
  if (scanCut) causes.push("scan_cut");
  if (!opts.audit.ok) causes.push("audit_chain_broken");
  if (!opts.egress.ok) causes.push("egress_chain_broken");
  if (coverage.task === "none") causes.push("coverage_none");

  const wanted = opts.byLabel;
  const groups = countGroups(model, w).filter(
    (g) => wanted === undefined || g.label === wanted || g.label === escapeUnverifiedLine(wanted),
  );
  return {
    labelsVerified: false,
    sinceMs: opts.sinceMs ?? null,
    untilMs: opts.untilMs ?? null,
    groups,
    scanCut,
    completeness: {
      status: causes.length === 0 ? "ok" : "indeterminate",
      causes,
      mismatches,
      checkedCaptures: checked,
      unreadableRows: model.unreadable,
      notChecked: { preVersionCaptures: preVersion, prunedGateRows: pruned },
    },
  };
}

// ---- the door view -----------------------------------------------------------------------------

export interface DoorRow {
  readonly id: number;
  readonly timestamp: number;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly door: Door;
  /** True for a before-state read, prepare read or discard run on behalf of an agent's action. */
  readonly subStep: boolean;
  readonly captureId?: string;
  /** The client's own label, ESCAPED; absent on a row written before AD4. */
  readonly label?: string | null;
  readonly labelSource?: "declared" | "kit";
  /** The gateway's reason for a rejection, escaped. */
  readonly reason?: string;
}

export interface DoorListing {
  readonly labelsVerified: false;
  readonly rows: readonly DoorRow[];
  /** True when the scan stopped at its cap before reaching the end of the log. */
  readonly scanCut: boolean;
}

export interface ListByDoorOptions {
  readonly door: Door;
  readonly byLabel?: string | undefined;
  readonly sinceMs?: number | undefined;
  readonly untilMs?: number | undefined;
  readonly limit?: number | undefined;
  readonly maxScan?: number | undefined;
}

function reasonOf(actionJson: string): string | undefined {
  try {
    const v = (JSON.parse(actionJson) as { hitlRejectReason?: unknown }).hitlRejectReason;
    return typeof v === "string" ? escapeUnverifiedLine(v) : undefined;
  } catch {
    return undefined;
  }
}

/** `nimbus audit --door`: the newest audit rows that came through one door, newest first. */
export function listByDoor(db: Database, opts: ListByDoorOptions): DoorListing {
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Math.floor(opts.limit ?? LIST_LIMIT_DEFAULT)));
  const maxScan = opts.maxScan ?? LIST_MAX_SCAN;
  const stmt = db.query<AuditPageRow, [number, number, number, number]>(
    `SELECT id, action_type, hitl_status, action_json, timestamp FROM audit_log
     WHERE timestamp >= ? AND timestamp <= ? AND id < ? ORDER BY id DESC LIMIT ?`,
  );
  const since = opts.sinceMs ?? 0;
  const until = opts.untilMs ?? Number.MAX_SAFE_INTEGER;
  const rows: DoorRow[] = [];
  let scanned = 0;
  let before = Number.MAX_SAFE_INTEGER;
  // Pages of the log, newest first. Each statement runs to completion (no early exit from an iterator).
  for (;;) {
    const page = stmt.all(since, until, before, Math.min(LIST_PAGE, maxScan - scanned + 1));
    if (page.length === 0) return { labelsVerified: false, rows, scanCut: false };
    for (const r of page) {
      if (scanned >= maxScan) return { labelsVerified: false, rows, scanCut: true };
      scanned += 1;
      before = r.id;
      const row = doorRowOf(r, opts);
      if (row === undefined) continue;
      rows.push(row);
      if (rows.length >= limit) return { labelsVerified: false, rows, scanCut: false };
    }
  }
}

function doorRowOf(r: AuditPageRow, opts: ListByDoorOptions): DoorRow | undefined {
  const c = classifyAuditRow(r.action_type, r.action_json);
  if (c.door !== opts.door) return undefined;
  const base = {
    id: r.id,
    timestamp: r.timestamp,
    actionType: r.action_type,
    hitlStatus: r.hitl_status,
  };
  const reason = reasonOf(r.action_json);
  const extra = reason === undefined ? {} : { reason };
  if (c.door !== "agent") return { ...base, door: c.door, subStep: false, ...extra };
  if (c.subStep) {
    if (opts.byLabel !== undefined) return undefined;
    return { ...base, door: "agent", subStep: true, captureId: c.captureId, ...extra };
  }
  const escaped =
    c.label === undefined || c.label === null ? c.label : escapeUnverifiedLine(c.label);
  if (
    opts.byLabel !== undefined &&
    c.label !== opts.byLabel &&
    escaped !== opts.byLabel &&
    escaped !== escapeUnverifiedLine(opts.byLabel)
  ) {
    return undefined;
  }
  return {
    ...base,
    door: "agent",
    subStep: false,
    captureId: c.captureId,
    ...(escaped === undefined ? {} : { label: escaped }),
    ...(c.labelSource === undefined ? {} : { labelSource: c.labelSource }),
    ...extra,
  };
}
