import type { Database } from "bun:sqlite";

import { RpcMethodError } from "./server/rpc-error.ts";

export type GetSessionTranscriptParams = {
  readonly sessionId: string;
  readonly limit?: number;
};

export type TranscriptTurn = {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
  readonly auditLogId?: number;
};

export type SessionTranscriptResult = {
  readonly sessionId: string;
  readonly turns: readonly TranscriptTurn[];
  readonly hasMore: boolean;
};

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  if (raw < MIN_LIMIT) return MIN_LIMIT;
  if (raw > MAX_LIMIT) return MAX_LIMIT;
  return Math.trunc(raw);
}

function actionToRole(actionType: string): "user" | "assistant" | undefined {
  if (actionType === "engine.askUser") return "user";
  if (actionType === "engine.askAssistant") return "assistant";
  return undefined;
}

function parseDetailsText(actionJson: string | null): string {
  if (actionJson === null) return "[redacted]";
  try {
    const parsed = JSON.parse(actionJson) as { text?: unknown };
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    // fall through
  }
  return "[redacted]";
}

export function createGetSessionTranscriptHandler(
  db: Database,
): (params: unknown) => Promise<SessionTranscriptResult> {
  return async (params): Promise<SessionTranscriptResult> => {
    if (typeof params !== "object" || params === null) {
      throw new RpcMethodError(-32602, "engine.getSessionTranscript requires params object");
    }
    const sid = (params as { sessionId?: unknown }).sessionId;
    if (typeof sid !== "string" || sid.length === 0) {
      throw new RpcMethodError(-32602, "engine.getSessionTranscript requires non-empty sessionId");
    }
    const limit = clampLimit((params as { limit?: unknown }).limit);

    const stmt = db.prepare(
      `SELECT id, action_type, timestamp, action_json
       FROM audit_log
       WHERE session_id = ?
       ORDER BY timestamp ASC, id ASC
       LIMIT ?`,
    );
    type Row = {
      id: number;
      action_type: string;
      timestamp: number;
      action_json: string | null;
    };
    // db.prepare() statements are not released by db.close() (#969).
    let rows: Row[];
    try {
      rows = stmt.all(sid, limit + 1) as Row[];
    } finally {
      stmt.finalize();
    }

    const hasMore = rows.length > limit;
    const used = hasMore ? rows.slice(0, limit) : rows;

    const turns: TranscriptTurn[] = [];
    for (const r of used) {
      const role = actionToRole(r.action_type);
      if (role === undefined) continue;
      turns.push({
        role,
        text: parseDetailsText(r.action_json),
        timestamp: r.timestamp,
        auditLogId: r.id,
      });
    }
    return { sessionId: sid, turns, hasMore };
  };
}
