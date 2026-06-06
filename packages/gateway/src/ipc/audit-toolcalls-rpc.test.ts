import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { writeToolCallLog } from "../db/tool-call-log.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { TOOL_CALL_LOG_V29_SCHEMA_SQL } from "../index/tool-call-log-v29-sql.ts";
import { AuditRpcError, dispatchAuditRpc } from "./audit-rpc.ts";

function indexCtxFromDb(db: Database): { index: LocalIndex } {
  return {
    index: { getDatabase: () => db } as unknown as LocalIndex,
  };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(TOOL_CALL_LOG_V29_SCHEMA_SQL);
  return db;
}

describe("audit.toolCalls dispatcher branch", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("returns hit envelope with empty result on empty table", async () => {
    const out = await dispatchAuditRpc("audit.toolCalls", {}, indexCtxFromDb(db));
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    const value = out.value as {
      toolCalls: unknown[];
      hasMore: boolean;
      nextCursor: unknown;
    };
    expect(value.toolCalls).toHaveLength(0);
    expect(value.hasMore).toBe(false);
    expect(value.nextCursor).toBeNull();
  });

  test("misses on other audit methods (e.g. audit.foo)", async () => {
    const out = await dispatchAuditRpc("audit.foo", {}, indexCtxFromDb(db));
    expect(out.kind).toBe("miss");
  });

  test("rejects null params with -32602", async () => {
    await expect(dispatchAuditRpc("audit.toolCalls", null, indexCtxFromDb(db))).rejects.toThrow(
      AuditRpcError,
    );
  });

  test("rejects array params with -32602", async () => {
    await expect(dispatchAuditRpc("audit.toolCalls", [], indexCtxFromDb(db))).rejects.toThrow(
      AuditRpcError,
    );
  });

  test("rejects non-string sessionId", async () => {
    await expect(
      dispatchAuditRpc("audit.toolCalls", { sessionId: 42 }, indexCtxFromDb(db)),
    ).rejects.toThrow(AuditRpcError);
  });

  test("rejects non-integer limit", async () => {
    await expect(
      dispatchAuditRpc("audit.toolCalls", { limit: 1.5 }, indexCtxFromDb(db)),
    ).rejects.toThrow(AuditRpcError);
  });

  test("rejects limit < 1 and limit > 1000", async () => {
    await expect(
      dispatchAuditRpc("audit.toolCalls", { limit: 0 }, indexCtxFromDb(db)),
    ).rejects.toThrow(AuditRpcError);
    await expect(
      dispatchAuditRpc("audit.toolCalls", { limit: 1_001 }, indexCtxFromDb(db)),
    ).rejects.toThrow(AuditRpcError);
  });

  test("rejects status not in {'ok','error'}", async () => {
    await expect(
      dispatchAuditRpc("audit.toolCalls", { status: "maybe" }, indexCtxFromDb(db)),
    ).rejects.toThrow(AuditRpcError);
  });

  test("rejects until < since", async () => {
    await expect(
      dispatchAuditRpc("audit.toolCalls", { since: 200, until: 100 }, indexCtxFromDb(db)),
    ).rejects.toThrow(AuditRpcError);
  });

  test("rejects malformed cursor (missing fields, non-integer, negative)", async () => {
    for (const bad of [
      { cursor: {} },
      { cursor: { calledAt: 1 } },
      { cursor: { calledAt: 1, id: 1.5 } },
      { cursor: { calledAt: -1, id: 1 } },
      { cursor: { calledAt: 1, id: -1 } },
      { cursor: "string" },
    ]) {
      await expect(dispatchAuditRpc("audit.toolCalls", bad, indexCtxFromDb(db))).rejects.toThrow(
        AuditRpcError,
      );
    }
  });

  test("default limit is 100", async () => {
    for (let i = 0; i < 200; i++) {
      writeToolCallLog(db, {
        sessionId: "s",
        toolId: "t",
        service: "x",
        calledAt: i,
        durationMs: 0,
        resultEnvelope: '<tool_output service="x" tool="t">[]</tool_output>',
        status: "ok",
      });
    }
    const out = await dispatchAuditRpc("audit.toolCalls", {}, indexCtxFromDb(db));
    if (out.kind !== "hit") throw new Error("unreachable");
    const value = out.value as { toolCalls: unknown[]; hasMore: boolean };
    expect(value.toolCalls).toHaveLength(100);
    expect(value.hasMore).toBe(true);
  });

  test("nextCursor is composite (calledAt, id) of the LAST row when hasMore=true", async () => {
    for (let i = 0; i < 5; i++) {
      writeToolCallLog(db, {
        sessionId: "s",
        toolId: "t",
        service: "x",
        calledAt: i * 100,
        durationMs: 0,
        resultEnvelope: '<tool_output service="x" tool="t">[]</tool_output>',
        status: "ok",
      });
    }
    const out = await dispatchAuditRpc("audit.toolCalls", { limit: 3 }, indexCtxFromDb(db));
    if (out.kind !== "hit") throw new Error("unreachable");
    const value = out.value as {
      toolCalls: Array<{ calledAt: number; id: number }>;
      hasMore: boolean;
      nextCursor: { calledAt: number; id: number } | null;
    };
    expect(value.hasMore).toBe(true);
    expect(value.nextCursor).not.toBeNull();
    if (value.nextCursor === null) throw new Error("unreachable");
    const last = value.toolCalls.at(-1);
    if (last === undefined) throw new Error("unreachable");
    expect(value.nextCursor.calledAt).toBe(last.calledAt);
    expect(value.nextCursor.id).toBe(last.id);
  });

  test("cursor passed back from previous nextCursor advances correctly", async () => {
    for (let i = 0; i < 5; i++) {
      writeToolCallLog(db, {
        sessionId: "s",
        toolId: "t",
        service: "x",
        calledAt: i * 100,
        durationMs: 0,
        resultEnvelope: '<tool_output service="x" tool="t">[]</tool_output>',
        status: "ok",
      });
    }
    const page1 = await dispatchAuditRpc("audit.toolCalls", { limit: 3 }, indexCtxFromDb(db));
    if (page1.kind !== "hit") throw new Error("unreachable");
    const v1 = page1.value as {
      hasMore: boolean;
      nextCursor: { calledAt: number; id: number } | null;
    };
    expect(v1.hasMore).toBe(true);
    if (v1.nextCursor === null) throw new Error("unreachable");
    const page2 = await dispatchAuditRpc(
      "audit.toolCalls",
      { limit: 3, cursor: v1.nextCursor },
      indexCtxFromDb(db),
    );
    if (page2.kind !== "hit") throw new Error("unreachable");
    const v2 = page2.value as {
      toolCalls: Array<{ calledAt: number }>;
      hasMore: boolean;
      nextCursor: unknown;
    };
    expect(v2.toolCalls).toHaveLength(2);
    expect(v2.hasMore).toBe(false);
    expect(v2.nextCursor).toBeNull();
  });

  test("sessionId='' filter returns ONLY rows with NULL session_id", async () => {
    writeToolCallLog(db, {
      sessionId: null,
      toolId: "t",
      service: "x",
      calledAt: 100,
      durationMs: 0,
      resultEnvelope: '<tool_output service="x" tool="t">[]</tool_output>',
      status: "ok",
    });
    writeToolCallLog(db, {
      sessionId: "s-1",
      toolId: "t",
      service: "x",
      calledAt: 200,
      durationMs: 0,
      resultEnvelope: '<tool_output service="x" tool="t">[]</tool_output>',
      status: "ok",
    });
    const out = await dispatchAuditRpc("audit.toolCalls", { sessionId: "" }, indexCtxFromDb(db));
    if (out.kind !== "hit") throw new Error("unreachable");
    const value = out.value as { toolCalls: Array<{ sessionId: string | null }> };
    expect(value.toolCalls).toHaveLength(1);
    expect(value.toolCalls[0]?.sessionId).toBeNull();
  });
});
