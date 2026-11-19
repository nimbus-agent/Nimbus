import type { Database } from "bun:sqlite";

import { serviceFreshness } from "../agents/_lib/briefing-queries.ts";
import { renderCascadeSection } from "../agents/_lib/incident-render.ts";
import { renderInvestigation } from "../agents/_lib/investigation-render.ts";
import { scanDebt } from "../debt/debt-scan.ts";
import { type ConfiguredRoot, DEBT_DEFAULTS } from "../debt/debt-types.ts";
import { type GitHistoryReader, readGitHistory } from "../debt/git-history.ts";
import { IncidentError } from "../incident/assemble.ts";
import { type CascadeGroup, groupOf } from "../incident/cascade.ts";
import { type CascadeInfo, readCascade } from "../incident/cascade-read.ts";
import { listFindings } from "../incident/finding-store.ts";
import type { IncidentEngine } from "../incident/incident-engine.ts";
import { resolveIncidentRef } from "../incident/incident-id.ts";
import type { IncidentRecordV1 } from "../incident/incident-record-types.ts";
import {
  getById,
  getByTriggerItem,
  listRecords,
  type RecordRow,
  versionsOf,
} from "../incident/incident-store.ts";
import { investigateRecord } from "../incident/investigate.ts";
import { type Remediation, RemediationError } from "../incident/remediation.ts";
import { readTimeline } from "../incident/timeline-read.ts";
import { TRIGGER_SERVICES } from "../incident/trigger-sources.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { RunbookError, type Runbooks } from "../runbook/runbook-run.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `incident.*` (Phase 10 IC3): the incident records the engine assembled from the local index.
 *
 *   incident.list { open?, service?, source?, limit? } -> { status, records, sources }
 *   incident.get { id }                                -> { record, reason? }
 *   incident.assemble { id }                           -> { outcome, record }
 *   incident.timeline { id, version? }                 -> { recordId, version, currentVersion, events, notes }   (IC4)
 *   incident.investigate { id }                        -> { investigation, markdown }                            (IC9a)
 *   incident.proposals { id }                          -> { recordId, version, advisory, proposals, unavailable }  (IC5a)
 *   incident.remediate { id, proposalId }              -> { proposalId, actionId, status, reason?, nonHuman, undoable }  (IC5a)
 *   incident.dryRun { id, proposalId }                 -> { proposalId, toolId, before, prediction, label }  (Phase 17 dry run)
 *   incident.undo { actionId }                         -> { actionId, status, reason?, nonHuman }  (IC5a)
 *   incident.advisory {}                               -> { advisory }  (IC5a)
 *   incident.advisorySet { on }                        -> { advisory }  (IC5a)
 *   incident.debt { since?, untouched?, minIncidents?, limit? } -> DebtResult   (IC7b; runs `git log` under debt/, never from incident/)
 *   incident.findings { all?, limit? }                -> { findings }   (IC8; the radar's and the anomaly baseline's findings, read only)
 *   incident.runbooks { id, runbook? }                 -> { recordId, version, advisory, runbooks, errors }   (IC6)
 *   incident.runbookRun { id, runbook, step }          -> { runbook, step, kind, actionId, status, reason?, nonHuman, result? }   (IC6)
 *   incident.runbookDone { id, runbook, step }         -> { runbook, step, status: "done" }   (IC6)
 *
 * `incident.get` also answers a live `cascade` (IC4: where this record stands among the open records of the
 * same 30-minute window) and `incident.list { cascade: true }` also answers the open `groups`; both are derived
 * at call time from the open records and the declared `depends_on`, never stored.
 *
 * The three IC6 methods list, run and mark the steps of the owner's own runbooks (`<configDir>/runbooks/*.toml`);
 * `runbookRun` runs ONE step through the same human-only executor as `remediate`, on THIS connection, so they are
 * never renderer-callable either.
 *
 * ALL FIFTEEN serve only a connection whose DECLARED kind is `cli` or `ui` (`requireOwnerKind`, called first by
 * every handler, before any query runs): a record holds capped titles of items from several services, and the
 * kind is the connection's (`ctx.getClientKind`), never a param. The whole namespace is LAN-forbidden (I5). The
 * renderer (I7) may call exactly five reads: `list`, `get`, `timeline` (IC10a), `proposals` and `findings` (IC10b);
 * `assemble` never. Of the five IC5a methods (`proposals`, `remediate`, `undo`, `advisory`, `advisorySet`), four can
 * START an action or flip the advisory switch and are never renderer-callable (the renderer can already answer a
 * consent prompt); `proposals` is the read, and from a `ui` connection it stores new proposals but revives none
 * (only the owner's terminal listing does). `remediate` and `undo` run the stored proposal through the LOCAL
 * owner execute() on THIS connection (`caller.clientId`), human answers only; advisory mode refuses them first.
 */
export class IncidentRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface IncidentRpcCtx {
  readonly db: Database;
  readonly engine: Pick<IncidentEngine, "assembleNow">;
  /** The declared `depends_on` of every configured service, read fresh per call (the cascade, IC4). */
  readonly dependsOn: () => ReadonlyMap<string, readonly string[]>;
  /** The declared service configs (IC9a: a service's `sentry_projects`), read fresh per call; absent = unreadable. */
  readonly serviceConfigs?: () => ReadonlyMap<string, ServiceConfig>;
  /** A clock for tests; the gateway uses `Date.now`. */
  readonly now?: () => number;
  /** IC5a: the remediation service (proposals, remediate, undo, the advisory switch). Absent: those methods refuse. */
  readonly remediation?: Remediation;
  /** IC6: the owner's runbooks (list, run one step, mark a check done). Absent: those methods refuse. */
  readonly runbooks?: Runbooks;
  /**
   * `incident.debt` (IC7b): the owner's own `[[filesystem.roots]]`, read fresh per call, and the git reader
   * (default: the real one in `debt/git-history.ts`). Absent: the method answers `ERR_DEBT_UNAVAILABLE`.
   */
  readonly debt?: {
    readonly roots: () => readonly ConfiguredRoot[];
    readonly git?: GitHistoryReader;
    readonly now?: () => number;
  };
}

export type IncidentRpcCaller = { readonly kind: ClientKind; readonly clientId?: string };

export const INCIDENT_LIST_DEFAULT = 50;
export const INCIDENT_LIST_MAX = 200;
const OWNER_KINDS: ReadonlySet<ClientKind> = new Set<ClientKind>(["cli", "ui"]);

/** True for a connection that declared `cli` or `ui`. The ONE owner-kind test (also used by `oncall.handoff`'s records). */
export function isOwnerKind(kind: ClientKind): boolean {
  return OWNER_KINDS.has(kind);
}

/** The ONE owner-kind check; loosening the reads later is a change to this function alone. */
export function requireOwnerKind(kind: ClientKind): void {
  if (!isOwnerKind(kind)) {
    throw new IncidentRpcError(
      -32000,
      "ERR_INCIDENT_FORBIDDEN_CLIENT: incident records are served only to the owner's own surfaces (the CLI and the desktop), on a connection that declared its kind",
    );
  }
}

export type IncidentSummary = {
  readonly id: string;
  readonly triggerItemId: string;
  readonly triggerService: string;
  readonly service: string | null;
  readonly title: string;
  readonly severity: string | null;
  readonly status: string;
  readonly openedAtMs: number | null;
  readonly version: number;
  readonly assembledAtMs: number;
  readonly checkedAtMs: number;
};

export function summaryOf(r: RecordRow): IncidentSummary {
  return {
    id: r.id,
    triggerItemId: r.trigger_item_id,
    triggerService: r.trigger_service,
    service: r.service,
    title: r.title,
    severity: r.severity,
    status: r.status,
    openedAtMs: r.opened_at_ms,
    version: r.version,
    assembledAtMs: r.assembled_at_ms,
    checkedAtMs: r.checked_at_ms,
  };
}

function requireKeys(
  method: string,
  params: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new IncidentRpcError(-32602, `${method} requires an object payload`);
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!allowed.includes(key)) {
      throw new IncidentRpcError(-32602, `${method}: unknown parameter "${key}"`);
    }
  }
  return p;
}

function parseId(method: string, p: Record<string, unknown>): string {
  const raw = p["id"];
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 256) {
    throw new IncidentRpcError(-32602, `${method}: id must be a non-empty string`);
  }
  return raw.trim();
}

type ListParams = {
  readonly cascade: boolean;
  readonly open: boolean;
  readonly service: string | undefined;
  readonly source: string | undefined;
  readonly limit: number;
};

function parseList(raw: unknown): ListParams {
  const p = requireKeys("incident.list", raw, ["open", "service", "source", "limit", "cascade"]);
  const cascade = p["cascade"];
  if (cascade !== undefined && typeof cascade !== "boolean") {
    throw new IncidentRpcError(-32602, "incident.list: cascade must be a boolean");
  }
  const open = p["open"];
  if (open !== undefined && typeof open !== "boolean") {
    throw new IncidentRpcError(-32602, "incident.list: open must be a boolean");
  }
  const service = p["service"];
  if (
    service !== undefined &&
    (typeof service !== "string" || service === "" || service.length > 128)
  ) {
    throw new IncidentRpcError(-32602, "incident.list: service must be a non-empty string");
  }
  const source = p["source"];
  if (
    source !== undefined &&
    (typeof source !== "string" || !TRIGGER_SERVICES.includes(source as never))
  ) {
    throw new IncidentRpcError(
      -32602,
      `incident.list: source must be one of ${TRIGGER_SERVICES.join(", ")}`,
    );
  }
  const limit = p["limit"] ?? INCIDENT_LIST_DEFAULT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > INCIDENT_LIST_MAX
  ) {
    throw new IncidentRpcError(
      -32602,
      `incident.list: limit must be an integer 1..${String(INCIDENT_LIST_MAX)}`,
    );
  }
  return {
    cascade: cascade === true,
    open: open === true,
    service: service as string | undefined,
    source: source as string | undefined,
    limit,
  };
}

function list(ctx: IncidentRpcCtx, raw: unknown): unknown {
  const f = parseList(raw);
  const records = listRecords(ctx.db, {
    limit: f.limit,
    ...(f.open ? { open: true } : {}),
    ...(f.service === undefined ? {} : { service: f.service }),
    ...(f.source === undefined ? {} : { source: f.source }),
  });
  const sources = serviceFreshness(ctx.db, TRIGGER_SERVICES).map((s) => ({
    service: s.id,
    connected: s.connected,
    lastSyncMs: s.lastSyncMs,
  }));
  let status: "ok" | "none" | "no_data" = "ok";
  if (records.length === 0) {
    const hasRecords = ctx.db.query("SELECT 1 AS n FROM incident_record LIMIT 1").get() !== null;
    status = !hasRecords && !sources.some((s) => s.connected) ? "no_data" : "none";
  }
  const base = { status, records: records.map(summaryOf), sources };
  return f.cascade ? { ...base, groups: cascadeGroups(ctx) } : base;
}

type CascadeMemberOut = CascadeGroup["members"][number] & Partial<CascadeInfo>;

function groupOut(
  g: CascadeGroup,
  info: ReadonlyMap<string, CascadeInfo>,
): Omit<CascadeGroup, "members"> & { readonly members: readonly CascadeMemberOut[] } {
  return {
    ...g,
    members: g.members.map((m) => ({ ...m, ...(info.get(m.recordId) ?? {}) })),
  };
}

/** The open cascade groups, or `null` when the open records could not be read (the caller says so). */
function cascadeGroups(ctx: IncidentRpcCtx): unknown {
  try {
    const view = readCascade(ctx.db, ctx.dependsOn());
    return view.groups.map((g) => groupOut(g, view.info));
  } catch {
    return null;
  }
}

/** Where one record stands in the live cascade, with the block as `incident show` prints it. */
function cascadeOf(ctx: IncidentRpcCtx, recordId: string): unknown {
  try {
    const view = readCascade(ctx.db, ctx.dependsOn());
    const group = groupOf(view.groups, recordId);
    if (group === null) return null;
    const me = group.members.find((m) => m.recordId === recordId);
    return {
      status: "ok",
      role: me?.role ?? "downstream",
      rootRecordId: group.root,
      group: groupOut(group, view.info),
      truncated: view.truncated,
      markdown: renderCascadeSection(group, recordId, view.info, view.truncated),
    };
  } catch {
    return { status: "unavailable" };
  }
}

function ambiguous(candidates: readonly string[]): IncidentRpcError {
  return new IncidentRpcError(
    -32602,
    `ERR_INCIDENT_AMBIGUOUS: that id names more than one item (${candidates.join(", ")}); use the full item id`,
  );
}

function notATrigger(itemId: string): IncidentRpcError {
  return new IncidentRpcError(
    -32602,
    `ERR_INCIDENT_NOT_A_TRIGGER: ${itemId} is not a PagerDuty incident, Jira Service Management alert, Sentry issue or data-quality item`,
  );
}

function parseRecord(row: RecordRow): IncidentRecordV1 | null {
  try {
    return JSON.parse(row.record_json) as IncidentRecordV1;
  } catch {
    return null;
  }
}

function get(ctx: IncidentRpcCtx, raw: unknown): unknown {
  const ref = resolveIncidentRef(
    ctx.db,
    parseId("incident.get", requireKeys("incident.get", raw, ["id"])),
  );
  if (ref.kind === "ambiguous") throw ambiguous(ref.candidates);
  if (ref.kind === "not_a_trigger") throw notATrigger(ref.itemId);
  if (ref.kind === "none") return { record: null, reason: "no_item" };
  if (ref.kind === "item") {
    return { record: null, reason: "not_assembled", triggerItemId: ref.triggerItemId };
  }
  const row = getById(ctx.db, ref.recordId);
  if (row === null) return { record: null, reason: "no_item" };
  const stillIndexed =
    ctx.db.query("SELECT 1 AS n FROM item WHERE id = ?").get(row.trigger_item_id) !== null;
  return {
    record: {
      summary: summaryOf(row),
      record: parseRecord(row),
      markdown: row.markdown,
      versions: versionsOf(ctx.db, row.id).map((v) => ({
        version: v.version,
        assembledAtMs: v.assembled_at_ms,
        sha256: v.record_sha256,
      })),
      triggerStillIndexed: stillIndexed,
      cascade: cascadeOf(ctx, row.id),
    },
  };
}

function timeline(ctx: IncidentRpcCtx, raw: unknown): unknown {
  const p = requireKeys("incident.timeline", raw, ["id", "version"]);
  const version = p["version"];
  if (
    version !== undefined &&
    (typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > 1_000_000)
  ) {
    throw new IncidentRpcError(-32602, "incident.timeline: version must be a positive integer");
  }
  const ref = resolveIncidentRef(ctx.db, parseId("incident.timeline", p));
  if (ref.kind === "ambiguous") throw ambiguous(ref.candidates);
  if (ref.kind === "not_a_trigger") throw notATrigger(ref.itemId);
  if (ref.kind !== "record") {
    throw new IncidentRpcError(-32602, "ERR_INCIDENT_NOT_FOUND: no record is stored for that id");
  }
  try {
    const out = readTimeline(ctx.db, ref.recordId, version);
    return {
      recordId: out.recordId,
      version: out.version,
      currentVersion: out.currentVersion,
      events: out.timeline.events,
      notes: out.timeline.notes,
    };
  } catch (e) {
    if (e instanceof IncidentError) throw new IncidentRpcError(-32602, `${e.code}: ${e.message}`);
    throw e;
  }
}

function readServiceConfigs(ctx: IncidentRpcCtx): ReadonlyMap<string, ServiceConfig> | null {
  try {
    return ctx.serviceConfigs === undefined ? null : ctx.serviceConfigs();
  } catch {
    return null;
  }
}

/**
 * `incident.investigate` (IC9a): reads the index for what surrounds one record (Sentry issues of the service,
 * other open records, linked Nimbus actions). A trigger item with no stored record is assembled first, as
 * `incident.assemble` does (an index-only pass). Makes no live call; see `incident/investigate.ts`.
 */
async function investigate(ctx: IncidentRpcCtx, raw: unknown): Promise<unknown> {
  const ref = resolveIncidentRef(
    ctx.db,
    parseId("incident.investigate", requireKeys("incident.investigate", raw, ["id"])),
  );
  if (ref.kind === "ambiguous") throw ambiguous(ref.candidates);
  if (ref.kind === "not_a_trigger") throw notATrigger(ref.itemId);
  if (ref.kind === "none") {
    throw new IncidentRpcError(-32602, "ERR_INCIDENT_NOT_FOUND: nothing indexed has that id");
  }
  let recordId: string;
  if (ref.kind === "record") {
    recordId = ref.recordId;
  } else {
    try {
      await ctx.engine.assembleNow(ref.triggerItemId);
    } catch (e) {
      if (e instanceof IncidentError) throw new IncidentRpcError(-32602, `${e.code}: ${e.message}`);
      throw e;
    }
    const row = getByTriggerItem(ctx.db, ref.triggerItemId);
    if (row === null) {
      throw new IncidentRpcError(-32602, "ERR_INCIDENT_NOT_FOUND: no record was stored");
    }
    recordId = row.id;
  }
  const investigation = investigateRecord(ctx.db, {
    recordId,
    nowMs: (ctx.now ?? Date.now)(),
    serviceConfigs: readServiceConfigs(ctx),
  });
  if (investigation === null) {
    throw new IncidentRpcError(-32602, "ERR_INCIDENT_NOT_FOUND: no record is stored for that id");
  }
  return { investigation, markdown: renderInvestigation(investigation) };
}

function boundedInt(
  method: string,
  p: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const v = p[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) {
    throw new IncidentRpcError(-32602, `${method}: ${key} must be an integer 1..${String(max)}`);
  }
  return v;
}

/** `incident.debt` (IC7b): never reaches git with a param; the integers only filter in TypeScript. */
async function debt(ctx: IncidentRpcCtx, raw: unknown): Promise<unknown> {
  const m = "incident.debt";
  const p = requireKeys(m, raw, ["since", "untouched", "minIncidents", "limit"]);
  const input = {
    sinceDays: boundedInt(m, p, "since", DEBT_DEFAULTS.sinceDays, 3650),
    untouchedDays: boundedInt(m, p, "untouched", DEBT_DEFAULTS.untouchedDays, 3650),
    minIncidents: boundedInt(m, p, "minIncidents", DEBT_DEFAULTS.minIncidents, 50),
    limit: boundedInt(m, p, "limit", DEBT_DEFAULTS.limit, INCIDENT_LIST_MAX),
  };
  const d = ctx.debt;
  if (d === undefined) {
    throw new IncidentRpcError(
      -32000,
      "ERR_DEBT_UNAVAILABLE: the debt scan is not wired on this gateway",
    );
  }
  return scanDebt(
    ctx.db,
    { ...input, nowMs: (d.now ?? Date.now)() },
    d.roots(),
    d.git ?? ((root) => readGitHistory(root)),
  );
}

async function assemble(ctx: IncidentRpcCtx, raw: unknown): Promise<unknown> {
  const ref = resolveIncidentRef(
    ctx.db,
    parseId("incident.assemble", requireKeys("incident.assemble", raw, ["id"])),
  );
  if (ref.kind === "ambiguous") throw ambiguous(ref.candidates);
  if (ref.kind === "not_a_trigger") throw notATrigger(ref.itemId);
  if (ref.kind === "none") {
    throw new IncidentRpcError(-32602, "ERR_INCIDENT_NOT_FOUND: nothing indexed has that id");
  }
  try {
    const out = await ctx.engine.assembleNow(ref.triggerItemId);
    if (out.outcome === "missing") {
      throw new IncidentRpcError(
        -32602,
        "ERR_INCIDENT_NOT_FOUND: the trigger item is no longer in the index",
      );
    }
    const row = getByTriggerItem(ctx.db, ref.triggerItemId);
    if (row === null) {
      throw new IncidentRpcError(-32602, "ERR_INCIDENT_NOT_FOUND: no record was stored");
    }
    return { outcome: out.outcome, record: summaryOf(row) };
  } catch (e) {
    if (e instanceof IncidentError) {
      throw new IncidentRpcError(-32602, `${e.code}: ${e.message}`);
    }
    throw e;
  }
}

export const FINDINGS_LIST_DEFAULT = 50;
export const FINDINGS_LIST_MAX = 500;

/** `incident.findings`: open findings first (newest first), then with `all` the cleared ones. Read only. */
function findings(ctx: IncidentRpcCtx, raw: unknown): unknown {
  const p = requireKeys("incident.findings", raw, ["all", "limit"]);
  const all = p["all"];
  if (all !== undefined && typeof all !== "boolean") {
    throw new IncidentRpcError(-32602, "incident.findings: all must be a boolean");
  }
  const limit = p["limit"] ?? FINDINGS_LIST_DEFAULT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > FINDINGS_LIST_MAX
  ) {
    throw new IncidentRpcError(
      -32602,
      `incident.findings: limit must be an integer 1..${String(FINDINGS_LIST_MAX)}`,
    );
  }
  const rows = listFindings(ctx.db, { all: all === true, limit });
  return {
    findings: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      key: r.finding_key,
      service: r.service,
      detail: JSON.parse(r.detail_json) as unknown,
      openedAtMs: r.opened_at_ms,
      lastSeenAtMs: r.last_seen_at_ms,
      clearedAtMs: r.cleared_at_ms,
    })),
  };
}

function remediationOf(ctx: IncidentRpcCtx): Remediation {
  if (ctx.remediation === undefined) {
    throw new IncidentRpcError(
      -32000,
      "ERR_REMEDIATION_UNAVAILABLE: this gateway has no remediation service",
    );
  }
  return ctx.remediation;
}

/** A remediation refusal as the owner reads it: `<CODE>: <message>`, a params error. */
async function remediationCall<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof RemediationError) {
      throw new IncidentRpcError(-32602, `${e.code}: ${e.message}`);
    }
    if (e instanceof IncidentError) throw new IncidentRpcError(-32602, `${e.code}: ${e.message}`);
    throw e;
  }
}

function runbooksOf(ctx: IncidentRpcCtx): Runbooks {
  if (ctx.runbooks === undefined) {
    throw new IncidentRpcError(
      -32000,
      "ERR_RUNBOOK_UNAVAILABLE: this gateway has no runbook service",
    );
  }
  return ctx.runbooks;
}

/** A runbook refusal as the owner reads it: `<CODE>: <message>`, a params error. */
async function runbookCall<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof RunbookError) throw new IncidentRpcError(-32602, `${e.code}: ${e.message}`);
    throw e;
  }
}

function parseRunbookName(method: string, p: Record<string, unknown>): string {
  const raw = p["runbook"];
  if (typeof raw !== "string" || raw === "" || raw.length > 64) {
    throw new IncidentRpcError(-32602, `${method}: runbook must be a non-empty string`);
  }
  return raw;
}

function parseStep(method: string, p: Record<string, unknown>): number {
  const raw = p["step"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 50) {
    throw new IncidentRpcError(-32602, `${method}: step must be an integer 1..50`);
  }
  return raw;
}

function parseProposalId(method: string, p: Record<string, unknown>): string {
  const raw = p["proposalId"];
  if (typeof raw !== "string" || raw === "" || raw.length > 64) {
    throw new IncidentRpcError(-32602, `${method}: proposalId must be a non-empty string`);
  }
  return raw;
}

function parseActionId(p: Record<string, unknown>): string {
  const raw = p["actionId"];
  if (typeof raw !== "string" || raw === "" || raw.length > 64) {
    throw new IncidentRpcError(-32602, "incident.undo: actionId must be a non-empty string");
  }
  return raw;
}

function callerClient(method: string, caller: IncidentRpcCaller): string {
  if (caller.clientId === undefined || caller.clientId === "") {
    throw new IncidentRpcError(-32602, `${method}: no connection to ask the owner on`);
  }
  return caller.clientId;
}

export async function dispatchIncidentRpc(
  method: string,
  params: unknown,
  ctx: IncidentRpcCtx,
  caller: IncidentRpcCaller,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<IncidentRpcCtx, unknown>(method, params, ctx, {
    "incident.list": (raw) => {
      requireOwnerKind(caller.kind);
      return list(ctx, raw);
    },
    "incident.get": (raw) => {
      requireOwnerKind(caller.kind);
      return get(ctx, raw);
    },
    "incident.timeline": (raw) => {
      requireOwnerKind(caller.kind);
      return timeline(ctx, raw);
    },
    "incident.investigate": async (raw) => {
      requireOwnerKind(caller.kind);
      return investigate(ctx, raw);
    },
    "incident.debt": async (raw) => {
      requireOwnerKind(caller.kind);
      return debt(ctx, raw);
    },
    "incident.findings": (raw) => {
      requireOwnerKind(caller.kind);
      return findings(ctx, raw);
    },
    "incident.assemble": async (raw) => {
      requireOwnerKind(caller.kind);
      return assemble(ctx, raw);
    },
    "incident.proposals": async (raw) => {
      requireOwnerKind(caller.kind);
      const id = parseId("incident.proposals", requireKeys("incident.proposals", raw, ["id"]));
      // Only the owner's terminal listing revives a denied or expired proposal; the desktop's read does not.
      const revive = caller.kind === "cli";
      return remediationCall(() => remediationOf(ctx).proposals(id, { revive }));
    },
    "incident.remediate": async (raw) => {
      requireOwnerKind(caller.kind);
      const p = requireKeys("incident.remediate", raw, ["id", "proposalId"]);
      const id = parseId("incident.remediate", p);
      const proposalId = parseProposalId("incident.remediate", p);
      const clientId = callerClient("incident.remediate", caller);
      return remediationCall(() => remediationOf(ctx).remediate({ ref: id, proposalId, clientId }));
    },
    "incident.dryRun": async (raw) => {
      requireOwnerKind(caller.kind);
      const p = requireKeys("incident.dryRun", raw, ["id", "proposalId"]);
      const id = parseId("incident.dryRun", p);
      const proposalId = parseProposalId("incident.dryRun", p);
      const clientId = callerClient("incident.dryRun", caller);
      return remediationCall(() => remediationOf(ctx).dryRun({ ref: id, proposalId, clientId }));
    },
    "incident.undo": async (raw) => {
      requireOwnerKind(caller.kind);
      const p = requireKeys("incident.undo", raw, ["actionId"]);
      const actionId = parseActionId(p);
      const clientId = callerClient("incident.undo", caller);
      return remediationCall(() => remediationOf(ctx).undo({ actionId, clientId }));
    },
    "incident.runbooks": async (raw) => {
      requireOwnerKind(caller.kind);
      const p = requireKeys("incident.runbooks", raw, ["id", "runbook"]);
      const id = parseId("incident.runbooks", p);
      const only =
        p["runbook"] === undefined ? undefined : parseRunbookName("incident.runbooks", p);
      return await runbookCall(() => runbooksOf(ctx).list(id, only));
    },
    "incident.runbookRun": async (raw) => {
      requireOwnerKind(caller.kind);
      const p = requireKeys("incident.runbookRun", raw, ["id", "runbook", "step"]);
      const id = parseId("incident.runbookRun", p);
      const runbook = parseRunbookName("incident.runbookRun", p);
      const step = parseStep("incident.runbookRun", p);
      const clientId = callerClient("incident.runbookRun", caller);
      return await runbookCall(() => runbooksOf(ctx).run({ ref: id, runbook, step, clientId }));
    },
    "incident.runbookDone": async (raw) => {
      requireOwnerKind(caller.kind);
      const p = requireKeys("incident.runbookDone", raw, ["id", "runbook", "step"]);
      const id = parseId("incident.runbookDone", p);
      const runbook = parseRunbookName("incident.runbookDone", p);
      const step = parseStep("incident.runbookDone", p);
      return await runbookCall(() => runbooksOf(ctx).done({ ref: id, runbook, step }));
    },
    "incident.advisory": async (raw) => {
      requireOwnerKind(caller.kind);
      requireKeys("incident.advisory", raw, []);
      return { advisory: remediationOf(ctx).advisory() };
    },
    "incident.advisorySet": async (raw) => {
      requireOwnerKind(caller.kind);
      const p = requireKeys("incident.advisorySet", raw, ["on"]);
      if (typeof p["on"] !== "boolean") {
        throw new IncidentRpcError(-32602, "incident.advisorySet: on must be a boolean");
      }
      return { advisory: remediationOf(ctx).setAdvisory(p["on"]) };
    },
  });
}
