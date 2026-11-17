import type { Database } from "bun:sqlite";

import { serviceFreshness } from "../agents/_lib/briefing-queries.ts";
import { renderCascadeSection } from "../agents/_lib/incident-render.ts";
import { scanDebt } from "../debt/debt-scan.ts";
import { type ConfiguredRoot, DEBT_DEFAULTS } from "../debt/debt-types.ts";
import { type GitHistoryReader, readGitHistory } from "../debt/git-history.ts";
import { IncidentError } from "../incident/assemble.ts";
import { type CascadeGroup, groupOf } from "../incident/cascade.ts";
import { type CascadeInfo, readCascade } from "../incident/cascade-read.ts";
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
import { readTimeline } from "../incident/timeline-read.ts";
import { TRIGGER_SERVICES } from "../incident/trigger-sources.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `incident.*` (Phase 10 IC3): the incident records the engine assembled from the local index.
 *
 *   incident.list { open?, service?, source?, limit? } -> { status, records, sources }
 *   incident.get { id }                                -> { record, reason? }
 *   incident.assemble { id }                           -> { outcome, record }
 *   incident.timeline { id, version? }                 -> { recordId, version, currentVersion, events, notes }   (IC4)
 *   incident.debt { since?, untouched?, minIncidents?, limit? } -> DebtResult   (IC7b; runs `git log` under debt/, never from incident/)
 *
 * `incident.get` also answers a live `cascade` (IC4: where this record stands among the open records of the
 * same 30-minute window) and `incident.list { cascade: true }` also answers the open `groups`; both are derived
 * at call time from the open records and the declared `depends_on`, never stored.
 *
 * ALL FOUR serve only a connection whose DECLARED kind is `cli` or `ui` (`requireOwnerKind`, called first by
 * every handler, before any query runs): a record holds capped titles of items from several services, and the
 * kind is the connection's (`ctx.getClientKind`), never a param. The whole namespace is LAN-forbidden (I5) and
 * is NOT renderer-callable (I7): the desktop gets `list` and `get` at a later slice, `assemble` never.
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

export type IncidentRpcCaller = { readonly kind: ClientKind };

export const INCIDENT_LIST_DEFAULT = 50;
export const INCIDENT_LIST_MAX = 200;
const OWNER_KINDS: ReadonlySet<ClientKind> = new Set<ClientKind>(["cli", "ui"]);

/** The ONE owner-kind check; loosening the reads later is a change to this function alone. */
export function requireOwnerKind(kind: ClientKind): void {
  if (!OWNER_KINDS.has(kind)) {
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
    "incident.debt": async (raw) => {
      requireOwnerKind(caller.kind);
      return debt(ctx, raw);
    },
    "incident.assemble": async (raw) => {
      requireOwnerKind(caller.kind);
      return assemble(ctx, raw);
    },
  });
}
