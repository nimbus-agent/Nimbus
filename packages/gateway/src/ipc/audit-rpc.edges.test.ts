import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeToolCallLog } from "../db/tool-call-log.ts";
import { LocalIndex } from "../index/local-index.ts";
import { AuditRpcError, dispatchAuditRpc } from "./audit-rpc.ts";

/**
 * `audit-rpc.ts` paths the existing suites do not reach: the `toolId`, `status`, `since` and
 * `until` filters of `audit.toolCalls` (accepted values narrowing the result, and each refusal
 * naming its own field), and `audit.verify` refusing to advance its incremental cursor past a
 * broken chain.
 */

const openDbs: Database[] = [];
const sharedDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});
afterAll(() => {
  for (const db of sharedDbs.splice(0)) db.close();
});

/** A fresh index, closed after the current test — or after the file, for `sharedDbs`. */
function index(bucket: Database[] = openDbs): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  bucket.push(db);
  return new LocalIndex(db);
}

/** Four tool calls: two tools, both statuses, called at 100/200/300/400. */
function seededCalls(): LocalIndex {
  const idx = index();
  const calls = [
    { toolId: "gmail_search", status: "ok", calledAt: 100 },
    { toolId: "gmail_search", status: "error", calledAt: 200 },
    { toolId: "jira_get", status: "ok", calledAt: 300 },
    { toolId: "jira_get", status: "error", calledAt: 400 },
  ] as const;
  for (const c of calls) {
    writeToolCallLog(idx.getDatabase(), {
      sessionId: "s1",
      toolId: c.toolId,
      service: c.toolId.split("_")[0] ?? "svc",
      calledAt: c.calledAt,
      durationMs: 1,
      resultEnvelope: "{}",
      status: c.status,
    });
  }
  return idx;
}

type ToolCallsValue = { toolCalls: Array<{ toolId: string; status: string; calledAt: number }> };

async function toolCalls(
  idx: LocalIndex,
  params: Record<string, unknown>,
): Promise<ToolCallsValue> {
  const out = await dispatchAuditRpc("audit.toolCalls", params, { index: idx });
  expect(out.kind).toBe("hit");
  return (out as { kind: "hit"; value: ToolCallsValue }).value;
}

/** One index for every refusal: a refused filter never reaches the query, so nothing reads it. */
let refusalIndex: LocalIndex;
beforeAll(() => {
  refusalIndex = index(sharedDbs);
});

async function refusal(params: Record<string, unknown>): Promise<string> {
  const err: unknown = await dispatchAuditRpc("audit.toolCalls", params, {
    index: refusalIndex,
  }).then(
    (v) => new Error(`resolved: ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuditRpcError);
  expect((err as AuditRpcError).rpcCode).toBe(-32602);
  return (err as AuditRpcError).message;
}

describe("audit.toolCalls — filters", () => {
  test("toolId narrows to that tool", async () => {
    const v = await toolCalls(seededCalls(), { toolId: "jira_get" });
    expect(v.toolCalls.map((c) => c.toolId)).toEqual(["jira_get", "jira_get"]);
  });

  test("status narrows to that outcome", async () => {
    const v = await toolCalls(seededCalls(), { status: "error" });
    expect(v.toolCalls.map((c) => c.status)).toEqual(["error", "error"]);
    expect(v.toolCalls.map((c) => c.calledAt).sort((a, b) => a - b)).toEqual([200, 400]);
  });

  test("since and until bound the window inclusively", async () => {
    const v = await toolCalls(seededCalls(), { since: 200, until: 300 });
    expect(v.toolCalls.map((c) => c.calledAt).sort((a, b) => a - b)).toEqual([200, 300]);
  });

  test("a blank or non-string toolId is refused by name", async () => {
    for (const toolId of ["", 7, null]) {
      expect(await refusal({ toolId })).toBe("audit.toolCalls: toolId must be a non-empty string");
    }
  });

  test("since and until each refuse anything but a non-negative integer, naming themselves", async () => {
    for (const bad of [-1, 1.5, "100"]) {
      expect(await refusal({ since: bad })).toBe(
        "audit.toolCalls: since must be a non-negative integer",
      );
      expect(await refusal({ until: bad })).toBe(
        "audit.toolCalls: until must be a non-negative integer",
      );
    }
  });
});

describe("audit.verify — the incremental cursor", () => {
  test("a broken chain is reported and the verified-through cursor does NOT move past it", async () => {
    const idx = index();
    for (let t = 1; t <= 3; t++) {
      idx.recordAudit({ actionType: "x", hitlStatus: "approved", actionJson: "{}", timestamp: t });
    }
    const first = await dispatchAuditRpc("audit.verify", {}, { index: idx });
    expect((first as { kind: "hit"; value: { ok: boolean } }).value.ok).toBe(true);
    const cursor = idx.getAuditVerifiedThroughId();
    expect(cursor).toBe(3);

    for (let t = 4; t <= 6; t++) {
      idx.recordAudit({ actionType: "x", hitlStatus: "approved", actionJson: "{}", timestamp: t });
    }
    // Rewrite row 6 after the fact, the way a filesystem-write attacker would. Rows 4 and 5 still
    // verify, so the failed run DID get further than the cursor.
    idx.rawDb.run(`UPDATE audit_log SET action_json = ? WHERE id = 6`, ['{"forged":true}']);

    const second = await dispatchAuditRpc("audit.verify", {}, { index: idx });
    expect((second as { kind: "hit"; value: unknown }).value).toMatchObject({
      ok: false,
      firstBreakAtId: 6,
      verifiedRows: 2,
      lastVerifiedId: 5,
    });
    // A failed run writes no cursor at all — not even the partial progress to 5 — so the next run
    // starts from the last point that verified CLEANLY.
    expect(idx.getAuditVerifiedThroughId()).toBe(cursor);
  });
});
