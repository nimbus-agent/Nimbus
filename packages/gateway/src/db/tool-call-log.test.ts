import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOL_CALL_LOG_V29_SCHEMA_SQL } from "../index/tool-call-log-v29-sql.ts";
import { TOOL_CALL_PARAMS_V42_SQL } from "../index/tool-call-params-v42-sql.ts";
import {
  MAX_ENVELOPE_BYTES,
  MAX_PARAMS_JSON_BYTES,
  readToolCallLog,
  type ToolCallLogEntry,
  writeToolCallLog,
} from "./tool-call-log.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(TOOL_CALL_LOG_V29_SCHEMA_SQL);
  db.exec(TOOL_CALL_PARAMS_V42_SQL);
  return db;
}

function entry(over: Partial<ToolCallLogEntry> = {}): ToolCallLogEntry {
  return {
    sessionId: "s-1",
    toolId: "github_repo_pr_list",
    service: "github",
    calledAt: 1_000,
    durationMs: 50,
    resultEnvelope: '<tool_output service="github" tool="github_repo_pr_list">[]</tool_output>',
    status: "ok",
    ...over,
  };
}

describe("writeToolCallLog + readToolCallLog", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("write+read round-trip preserves all fields", () => {
    writeToolCallLog(db, entry());
    const result = readToolCallLog(db, {});
    expect(result.toolCalls).toHaveLength(1);
    const row = result.toolCalls[0];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error("unreachable");
    expect(row.sessionId).toBe("s-1");
    expect(row.toolId).toBe("github_repo_pr_list");
    expect(row.service).toBe("github");
    expect(row.calledAt).toBe(1_000);
    expect(row.durationMs).toBe(50);
    expect(row.resultEnvelope).toContain("<tool_output");
    expect(row.status).toBe("ok");
    expect(typeof row.id).toBe("number");
  });

  test("nullable session_id round-trip", () => {
    writeToolCallLog(db, entry({ sessionId: null }));
    const result = readToolCallLog(db, {});
    expect(result.toolCalls[0]?.sessionId).toBeNull();
  });

  test("status='error' write+read round-trip", () => {
    const errEnvelope = '<tool_output service="github" tool="x">{"error":"boom"}</tool_output>';
    writeToolCallLog(db, entry({ status: "error", resultEnvelope: errEnvelope }));
    const result = readToolCallLog(db, {});
    expect(result.toolCalls[0]?.status).toBe("error");
    expect(result.toolCalls[0]?.resultEnvelope).toContain('"error":"boom"');
  });

  test("envelope at exactly 64 KiB is NOT truncated", () => {
    const head = '<tool_output service="x" tool="y">';
    const tail = "</tool_output>";
    const fillerLen = MAX_ENVELOPE_BYTES - head.length - tail.length;
    const envelope = `${head}${"a".repeat(fillerLen)}${tail}`;
    expect(Buffer.byteLength(envelope, "utf8")).toBe(MAX_ENVELOPE_BYTES);
    writeToolCallLog(db, entry({ resultEnvelope: envelope }));
    const result = readToolCallLog(db, {});
    expect(result.toolCalls[0]?.resultEnvelope).toBe(envelope);
    expect(result.toolCalls[0]?.resultEnvelope).not.toContain("[truncated,");
  });

  test("envelope over 64 KiB is truncated with grep-able marker", () => {
    const huge = "x".repeat(100_000);
    const envelope = `<tool_output service="x" tool="y">${huge}</tool_output>`;
    writeToolCallLog(db, entry({ resultEnvelope: envelope }));
    const stored = readToolCallLog(db, {}).toolCalls[0]?.resultEnvelope ?? "";
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    expect(stored).toContain("...[truncated,");
    expect(stored).toContain(`${Buffer.byteLength(envelope, "utf8")} bytes total]`);
  });

  test("filter by sessionId returns only the matching session", () => {
    writeToolCallLog(db, entry({ sessionId: "s-A", calledAt: 100 }));
    writeToolCallLog(db, entry({ sessionId: "s-B", calledAt: 200 }));
    const result = readToolCallLog(db, { sessionId: "s-A" });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.sessionId).toBe("s-A");
  });

  test("sessionId='' sentinel returns ONLY rows with NULL session_id", () => {
    writeToolCallLog(db, entry({ sessionId: null, calledAt: 100 }));
    writeToolCallLog(db, entry({ sessionId: "s-1", calledAt: 200 }));
    const result = readToolCallLog(db, { sessionId: "" });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.sessionId).toBeNull();
  });

  test("omitted sessionId returns rows from all sessions including NULL", () => {
    writeToolCallLog(db, entry({ sessionId: null, calledAt: 100 }));
    writeToolCallLog(db, entry({ sessionId: "s-1", calledAt: 200 }));
    const result = readToolCallLog(db, {});
    expect(result.toolCalls).toHaveLength(2);
  });

  test("filter by toolId returns only the matching tool", () => {
    writeToolCallLog(db, entry({ toolId: "t-A", calledAt: 100 }));
    writeToolCallLog(db, entry({ toolId: "t-B", calledAt: 200 }));
    const result = readToolCallLog(db, { toolId: "t-A" });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolId).toBe("t-A");
  });

  test("filter by status returns only the matching status", () => {
    writeToolCallLog(db, entry({ status: "ok", calledAt: 100 }));
    writeToolCallLog(db, entry({ status: "error", calledAt: 200 }));
    const result = readToolCallLog(db, { status: "error" });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.status).toBe("error");
  });

  test("filter by since/until applies inclusive bounds on called_at", () => {
    writeToolCallLog(db, entry({ calledAt: 100 }));
    writeToolCallLog(db, entry({ calledAt: 200 }));
    writeToolCallLog(db, entry({ calledAt: 300 }));
    const result = readToolCallLog(db, { since: 150, until: 250 });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.calledAt).toBe(200);
  });

  test("default limit is 100", () => {
    for (let i = 0; i < 200; i++) writeToolCallLog(db, entry({ calledAt: i }));
    const result = readToolCallLog(db, {});
    expect(result.toolCalls).toHaveLength(100);
    expect(result.hasMore).toBe(true);
  });

  test("limit honored up to 1000", () => {
    for (let i = 0; i < 1500; i++) writeToolCallLog(db, entry({ calledAt: i }));
    const result = readToolCallLog(db, { limit: 1000 });
    expect(result.toolCalls).toHaveLength(1000);
    expect(result.hasMore).toBe(true);
  });

  test("ordering: called_at ASC, id ASC (deterministic across same-millisecond rows)", () => {
    writeToolCallLog(db, entry({ calledAt: 200 }));
    writeToolCallLog(db, entry({ calledAt: 100 }));
    writeToolCallLog(db, entry({ calledAt: 200 }));
    const result = readToolCallLog(db, {});
    expect(result.toolCalls.map((r) => r.calledAt)).toEqual([100, 200, 200]);
    expect(result.toolCalls.map((r) => r.id)).toEqual([2, 1, 3]);
  });

  test("pagination across hasMore using composite cursor", () => {
    for (let i = 0; i < 250; i++) writeToolCallLog(db, entry({ calledAt: i }));
    const page1 = readToolCallLog(db, { limit: 100 });
    expect(page1.toolCalls).toHaveLength(100);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    if (page1.nextCursor === null) throw new Error("unreachable");
    const page2 = readToolCallLog(db, { limit: 100, cursor: page1.nextCursor });
    expect(page2.toolCalls).toHaveLength(100);
    expect(page2.toolCalls[0]?.calledAt).toBe(100);
    expect(page2.hasMore).toBe(true);
  });

  test("pagination is correct across same-millisecond rows", () => {
    writeToolCallLog(db, entry({ calledAt: 100 }));
    writeToolCallLog(db, entry({ calledAt: 200 }));
    writeToolCallLog(db, entry({ calledAt: 200 }));
    writeToolCallLog(db, entry({ calledAt: 300 }));
    writeToolCallLog(db, entry({ calledAt: 400 }));
    const page1 = readToolCallLog(db, { limit: 3 });
    expect(page1.toolCalls.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toEqual({ calledAt: 200, id: 3 });

    const page2 = readToolCallLog(db, { limit: 3, cursor: page1.nextCursor ?? undefined });
    expect(page2.toolCalls.map((r) => r.id)).toEqual([4, 5]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  test("final page reports hasMore=false, nextCursor=null", () => {
    for (let i = 0; i < 50; i++) writeToolCallLog(db, entry({ calledAt: i }));
    const result = readToolCallLog(db, { limit: 100 });
    expect(result.toolCalls).toHaveLength(50);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  test("cursor + since combine without conflict", () => {
    for (let i = 0; i < 10; i++) writeToolCallLog(db, entry({ calledAt: 100 + i * 100 }));
    const page1 = readToolCallLog(db, { since: 200, limit: 5 });
    expect(page1.toolCalls.map((r) => r.calledAt)).toEqual([200, 300, 400, 500, 600]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    if (page1.nextCursor === null) throw new Error("unreachable");
    const page2 = readToolCallLog(db, { since: 200, limit: 5, cursor: page1.nextCursor });
    expect(page2.toolCalls.map((r) => r.calledAt)).toEqual([700, 800, 900, 1_000]);
    expect(page2.hasMore).toBe(false);
  });

  test("empty table returns empty result with hasMore=false, nextCursor=null", () => {
    const result = readToolCallLog(db, {});
    expect(result.toolCalls).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  test("write swallows DiskFullError-shaped errors gracefully (does not throw)", () => {
    db.close();
    const tmpDir = mkdtempSync(join(tmpdir(), "tool-call-log-ro-"));
    const dbPath = join(tmpDir, "ro.sqlite");
    const seed = new Database(dbPath);
    seed.exec(TOOL_CALL_LOG_V29_SCHEMA_SQL);
    seed.exec(TOOL_CALL_PARAMS_V42_SQL);
    seed.close();
    const ro = new Database(dbPath, { readonly: true });
    expect(() => writeToolCallLog(ro, entry())).not.toThrow();
    ro.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("persists params (secret-redacted) and reads them back", () => {
    const db = freshDb();
    writeToolCallLog(
      db,
      entry({ params: { query: "from:boss", token: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }),
    );
    const { toolCalls } = readToolCallLog(db, {});
    const p = toolCalls[0]?.params as { query?: string; token?: string };
    expect(p.query).toBe("from:boss");
    expect(p.token).toBe("[REDACTED]"); // secret stripped at write time
  });

  test("params is null when not supplied", () => {
    const db = freshDb();
    writeToolCallLog(db, entry()); // entry() has no params
    const { toolCalls } = readToolCallLog(db, {});
    expect(toolCalls[0]?.params).toBeNull();
  });

  test("params survive a session-scoped read (collectSession shape)", () => {
    const db = freshDb();
    writeToolCallLog(db, entry({ sessionId: "sess-A", params: { channel: "#eng", limit: 10 } }));
    const { toolCalls } = readToolCallLog(db, { sessionId: "sess-A", limit: 1000 });
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0]?.params as { channel?: string } | undefined)?.channel).toBe("#eng");
  });

  test("params over budget store VALID sentinel {truncated:true}, never null", () => {
    // A blob large enough to guarantee redactAuditPayload exceeds MAX_PARAMS_JSON_BYTES
    // and truncates mid-JSON (producing invalid JSON).
    const db = freshDb();
    writeToolCallLog(db, entry({ params: { blob: "x".repeat(40_000) } }));
    const { toolCalls } = readToolCallLog(db, {});
    const p = toolCalls[0]?.params;
    // Must NOT be null — the sentinel must survive the round-trip.
    expect(p).not.toBeNull();
    // Must be the truncation sentinel, not the (invalid) truncated blob.
    expect(p).toEqual({ truncated: true });
  });

  test("MAX_PARAMS_JSON_BYTES is exported and larger than the 4096 redactAuditPayload default", () => {
    expect(MAX_PARAMS_JSON_BYTES).toBeGreaterThan(4096);
  });
});
