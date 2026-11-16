import type { Database } from "bun:sqlite";

import { serviceFreshness } from "../agents/_lib/briefing-queries.ts";
import { IncidentError } from "../incident/assemble.ts";
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
import { TRIGGER_SERVICES } from "../incident/trigger-sources.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `incident.*` (Phase 10 IC3): the incident records the engine assembled from the local index.
 *
 *   incident.list { open?, service?, source?, limit? } -> { status, records, sources }
 *   incident.get { id }                                -> { record, reason? }
 *   incident.assemble { id }                           -> { outcome, record }
 *
 * ALL THREE serve only a connection whose DECLARED kind is `cli` or `ui` (`requireOwnerKind`, called first by
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
  readonly open: boolean;
  readonly service: string | undefined;
  readonly source: string | undefined;
  readonly limit: number;
};

function parseList(raw: unknown): ListParams {
  const p = requireKeys("incident.list", raw, ["open", "service", "source", "limit"]);
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
    const any = ctx.db.query("SELECT 1 AS n FROM incident_record LIMIT 1").get() !== null;
    status = !any && !sources.some((s) => s.connected) ? "no_data" : "none";
  }
  return { status, records: records.map(summaryOf), sources };
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
    },
  };
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
    "incident.assemble": async (raw) => {
      requireOwnerKind(caller.kind);
      return assemble(ctx, raw);
    },
  });
}
