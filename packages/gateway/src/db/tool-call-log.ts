import type { Database } from "bun:sqlite";

import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { dbRun } from "./write.ts";

export const MAX_ENVELOPE_BYTES = 65_536;
/** Byte budget for stored params JSON — larger than redactAuditPayload's 4096 default so typical params survive. */
export const MAX_PARAMS_JSON_BYTES = 16_384;

export interface ToolCallLogEntry {
  sessionId: string | null;
  toolId: string;
  service: string;
  calledAt: number;
  durationMs: number;
  resultEnvelope: string;
  status: "ok" | "error";
  params?: unknown;
}

export interface ToolCallLogReadEntry extends ToolCallLogEntry {
  id: number;
  params: unknown;
}

export interface ToolCallLogFilter {
  since?: number;
  until?: number;
  limit?: number;
  sessionId?: string;
  toolId?: string;
  status?: "ok" | "error";
  cursor?: { calledAt: number; id: number } | undefined;
}

export interface ToolCallLogReadResult {
  toolCalls: ToolCallLogReadEntry[];
  hasMore: boolean;
  nextCursor: { calledAt: number; id: number } | null;
}

function parseParamsJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Redact params and guarantee the result is always valid JSON (or SQL NULL when params
 * is undefined). If redactAuditPayload truncates mid-JSON (producing an invalid string),
 * a visible sentinel `{"truncated":true}` is stored so the loss is explicit on read,
 * never silently dropped to null.
 */
function redactedParamsJson(params: unknown): string {
  const s = redactAuditPayload(params, MAX_PARAMS_JSON_BYTES);
  try {
    JSON.parse(s);
    return s; // valid JSON within budget
  } catch {
    // redaction truncated mid-JSON → store a VALID sentinel so the loss is visible
    return JSON.stringify({ truncated: true });
  }
}

function truncateEnvelope(envelope: string): string {
  const total = Buffer.byteLength(envelope, "utf8");
  if (total <= MAX_ENVELOPE_BYTES) return envelope;
  const marker = `...[truncated, ${String(total)} bytes total]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBudget = MAX_ENVELOPE_BYTES - markerBytes;
  const head = Buffer.from(envelope, "utf8").subarray(0, headBudget).toString("utf8");
  return `${head}${marker}`;
}

const INSERT_SQL = `
INSERT INTO tool_call_log
  (session_id, tool_id, service, called_at, duration_ms, result_envelope, status, params_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

export function writeToolCallLog(db: Database, entry: ToolCallLogEntry): void {
  try {
    // Compute envelope + redacted params INSIDE the try: audit logging is strictly best-effort,
    // so redaction/serialization throwing on pathological input (e.g. a circular ref) must never
    // break the caller's tool call.
    const envelope = truncateEnvelope(entry.resultEnvelope);
    const paramsJson = entry.params === undefined ? null : redactedParamsJson(entry.params);
    dbRun(db, INSERT_SQL, [
      entry.sessionId,
      entry.toolId,
      entry.service,
      entry.calledAt,
      entry.durationMs,
      envelope,
      entry.status,
      paramsJson,
    ]);
  } catch {
    // Best-effort. The two wiring sites are not allowed to throw because of
    // an audit-write failure — the user's tool call must still complete.
  }
}

export function readToolCallLog(db: Database, filter: ToolCallLogFilter): ToolCallLogReadResult {
  const limit = clampLimit(filter.limit);
  const where: string[] = [];
  const args: Array<string | number | null> = [];

  if (filter.since !== undefined) {
    where.push("called_at >= ?");
    args.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push("called_at <= ?");
    args.push(filter.until);
  }
  if (filter.sessionId !== undefined) {
    if (filter.sessionId === "") {
      where.push("session_id IS NULL");
    } else {
      where.push("session_id = ?");
      args.push(filter.sessionId);
    }
  }
  if (filter.toolId !== undefined) {
    where.push("tool_id = ?");
    args.push(filter.toolId);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.cursor !== undefined) {
    where.push("(called_at > ? OR (called_at = ? AND id > ?))");
    args.push(filter.cursor.calledAt, filter.cursor.calledAt, filter.cursor.id);
  }

  const whereClause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const sql = `
SELECT id, session_id, tool_id, service, called_at, duration_ms, result_envelope, status, params_json
FROM tool_call_log
${whereClause}
ORDER BY called_at ASC, id ASC
LIMIT ?
`.trim();

  type Row = {
    id: number;
    session_id: string | null;
    tool_id: string;
    service: string;
    called_at: number;
    duration_ms: number;
    result_envelope: string;
    status: "ok" | "error";
    params_json: string | null;
  };

  const rows = db.query(sql).all(...args, limit + 1) as Row[];
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;

  const toolCalls: ToolCallLogReadEntry[] = visible.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    toolId: r.tool_id,
    service: r.service,
    calledAt: r.called_at,
    durationMs: r.duration_ms,
    resultEnvelope: r.result_envelope,
    status: r.status,
    params: parseParamsJson(r.params_json),
  }));

  const last = toolCalls.at(-1);
  const nextCursor =
    hasMore && last !== undefined ? { calledAt: last.calledAt, id: last.id } : null;
  return { toolCalls, hasMore, nextCursor };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return 100;
  if (!Number.isInteger(raw) || raw < 1) return 100;
  if (raw > 1_000) return 1_000;
  return raw;
}
