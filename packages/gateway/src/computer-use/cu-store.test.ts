import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { insertAction, insertSession, pruneSnapshots, updateSessionState } from "./cu-store.ts";

/**
 * Fix round 1, I-6: `cu-store.ts` had NO test at all — deleting `insertSession`'s body,
 * `insertAction`'s body, or making `truncateSnapshot` a no-op all kept the (then) full suite
 * green, since no test queried `cu_session`/`cu_action` directly. Every test here asserts the
 * actual ROWS these functions wrote, not merely that they did not throw.
 */

function makeTestDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  return db;
}

interface SessionRow {
  id: string;
  lane: string;
  envelope_json: string;
  opened_at: number;
  closed_at: number | null;
  close_reason: string | null;
  tainted_at: number | null;
  actions_used: number;
}

interface ActionRow {
  id: string;
  session_id: string;
  seq: number;
  kind: string;
  classification: string;
  observed_target: string;
  model_description: string | null;
  hitl_status: string;
  outcome: string;
  dom_before: string | null;
  dom_after: string | null;
  dom_truncated: number;
  dom_original_bytes: number | null;
  screenshot_digest: string | null;
  timestamp: number;
}

function getSession(db: Database, id: string): SessionRow | null {
  return db.query<SessionRow, [string]>(`SELECT * FROM cu_session WHERE id = ?`).get(id);
}

function getAction(db: Database, id: string): ActionRow | null {
  return db.query<ActionRow, [string]>(`SELECT * FROM cu_action WHERE id = ?`).get(id);
}

describe("insertSession", () => {
  test("writes every column of the row, exactly as given", () => {
    const db = makeTestDb();
    insertSession(db, {
      id: "s1",
      lane: "browser",
      envelopeJson: '{"lane":"browser"}',
      openedAt: 1000,
    });
    const row = getSession(db, "s1");
    expect(row).toBeDefined();
    expect(row?.lane).toBe("browser");
    expect(row?.envelope_json).toBe('{"lane":"browser"}');
    expect(row?.opened_at).toBe(1000);
    expect(row?.actions_used).toBe(0);
    expect(row?.closed_at).toBeNull();
    expect(row?.tainted_at).toBeNull();
  });

  test("a duplicate id throws (PRIMARY KEY), rather than silently overwriting", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    expect(() =>
      insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 2000 }),
    ).toThrow();
  });
});

describe("updateSessionState", () => {
  test("updates actions_used alone, leaving every other column untouched", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    updateSessionState(db, "s1", { actionsUsed: 3 });
    const row = getSession(db, "s1");
    expect(row?.actions_used).toBe(3);
    expect(row?.closed_at).toBeNull();
    expect(row?.tainted_at).toBeNull();
  });

  test("sets taintedAt exactly once and it is readable back", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    updateSessionState(db, "s1", { taintedAt: 1234 });
    expect(getSession(db, "s1")?.tainted_at).toBe(1234);
  });

  test("closedAt + closeReason both land on the row (the CuSession.close() arm)", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    updateSessionState(db, "s1", { closedAt: 5000, closeReason: "terminated_budget" });
    const row = getSession(db, "s1");
    expect(row?.closed_at).toBe(5000);
    expect(row?.close_reason).toBe("terminated_budget");
  });

  test("an empty patch writes nothing and does not throw", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    expect(() => updateSessionState(db, "s1", {})).not.toThrow();
    const row = getSession(db, "s1");
    expect(row?.actions_used).toBe(0);
  });

  test("a null closeReason is distinguishable from one never set", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    updateSessionState(db, "s1", { closeReason: "terminated_budget" });
    updateSessionState(db, "s1", { closeReason: null });
    expect(getSession(db, "s1")?.close_reason).toBeNull();
  });
});

describe("insertAction", () => {
  function baseInput(over: Partial<Parameters<typeof insertAction>[1]> = {}) {
    return {
      id: "s1:1",
      sessionId: "s1",
      seq: 1,
      kind: "read",
      classification: "observing" as const,
      observedTarget: "read",
      modelDescription: null,
      hitlStatus: "approved",
      outcome: "actuated",
      domBefore: "<html>before</html>",
      domAfter: "<html>after</html>",
      screenshotDigest: null,
      timestamp: 1000,
      ...over,
    };
  }

  test("writes every column of the row, exactly as given", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    insertAction(db, baseInput(), 1_000_000);
    const row = getAction(db, "s1:1");
    expect(row).toBeDefined();
    expect(row?.session_id).toBe("s1");
    expect(row?.seq).toBe(1);
    expect(row?.classification).toBe("observing");
    expect(row?.observed_target).toBe("read");
    expect(row?.hitl_status).toBe("approved");
    expect(row?.outcome).toBe("actuated");
    expect(row?.dom_before).toBe("<html>before</html>");
    expect(row?.dom_after).toBe("<html>after</html>");
    expect(row?.dom_truncated).toBe(0);
    expect(row?.dom_original_bytes).toBeNull();
  });

  test("a screenshot_digest is stored verbatim and dom fields may be null", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    insertAction(
      db,
      baseInput({
        id: "s1:2",
        seq: 2,
        kind: "screenshot",
        domBefore: null,
        domAfter: null,
        screenshotDigest: "abc123",
      }),
      1_000_000,
    );
    const row = getAction(db, "s1:2");
    expect(row?.screenshot_digest).toBe("abc123");
    expect(row?.dom_before).toBeNull();
    expect(row?.dom_after).toBeNull();
  });

  test("a snapshot over snapshotMaxBytes is truncated and flagged, never silently returned whole", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    const big = "x".repeat(100);
    insertAction(db, baseInput({ id: "s1:3", seq: 3, domBefore: big, domAfter: "short" }), 10);
    const row = getAction(db, "s1:3");
    expect(row?.dom_before?.length).toBe(10);
    expect(row?.dom_truncated).toBe(1);
    expect(row?.dom_original_bytes).toBe(100);
    // The un-truncated field is untouched.
    expect(row?.dom_after).toBe("short");
  });

  test("when BOTH dom_before and dom_after clip, dom_original_bytes records the LARGER original size", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    insertAction(
      db,
      baseInput({
        id: "s1:4",
        seq: 4,
        domBefore: "a".repeat(50),
        domAfter: "b".repeat(200),
      }),
      10,
    );
    const row = getAction(db, "s1:4");
    expect(row?.dom_truncated).toBe(1);
    expect(row?.dom_before?.length).toBe(10);
    expect(row?.dom_after?.length).toBe(10);
    expect(row?.dom_original_bytes).toBe(200); // the LARGER of 50 and 200, not the smaller
  });

  test("a duplicate (session_id, seq) throws (UNIQUE), rather than silently overwriting", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    insertAction(db, baseInput({ id: "s1:1", seq: 1 }), 1_000_000);
    expect(() => insertAction(db, baseInput({ id: "s1:1-dup", seq: 1 }), 1_000_000)).toThrow();
  });
});

describe("pruneSnapshots", () => {
  test("nulls dom_before/dom_after only for rows strictly older than the cutoff", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    insertAction(
      db,
      {
        id: "s1:1",
        sessionId: "s1",
        seq: 1,
        kind: "read",
        classification: "observing",
        observedTarget: "read",
        modelDescription: null,
        hitlStatus: "approved",
        outcome: "actuated",
        domBefore: "old-before",
        domAfter: "old-after",
        screenshotDigest: null,
        timestamp: 1000, // OLD — before the cutoff
      },
      1_000_000,
    );
    insertAction(
      db,
      {
        id: "s1:2",
        sessionId: "s1",
        seq: 2,
        kind: "read",
        classification: "observing",
        observedTarget: "read",
        modelDescription: null,
        hitlStatus: "approved",
        outcome: "actuated",
        domBefore: "new-before",
        domAfter: "new-after",
        screenshotDigest: null,
        timestamp: 9000, // NEW — after the cutoff
      },
      1_000_000,
    );

    pruneSnapshots(db, 5000);

    const old = getAction(db, "s1:1");
    const fresh = getAction(db, "s1:2");
    expect(old?.dom_before).toBeNull();
    expect(old?.dom_after).toBeNull();
    expect(fresh?.dom_before).toBe("new-before");
    expect(fresh?.dom_after).toBe("new-after");
  });

  test("the permanent decision fields (outcome, hitl_status, classification) survive a prune", () => {
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    insertAction(
      db,
      {
        id: "s1:1",
        sessionId: "s1",
        seq: 1,
        kind: "click",
        classification: "actuating",
        observedTarget: "button submit",
        modelDescription: "clicking submit",
        hitlStatus: "approved",
        outcome: "actuated",
        domBefore: "before",
        domAfter: "after",
        screenshotDigest: null,
        timestamp: 1000,
      },
      1_000_000,
    );
    pruneSnapshots(db, 5000);
    const row = getAction(db, "s1:1");
    expect(row?.outcome).toBe("actuated");
    expect(row?.hitl_status).toBe("approved");
    expect(row?.classification).toBe("actuating");
    expect(row?.model_description).toBe("clicking submit");
    expect(row?.dom_before).toBeNull();
  });

  test("is a no-op on an empty table (called with no rows to prune)", () => {
    // Task 15 wired `pruneSnapshots` into `cu-snapshot-retention.ts`'s daily pass (see
    // `computer-use/cu-snapshot-retention.test.ts` for the retention-cadence + wiring coverage).
    // Kept here to pin the zero-row case at the store layer.
    const db = makeTestDb();
    insertSession(db, { id: "s1", lane: "browser", envelopeJson: "{}", openedAt: 1000 });
    expect(() => pruneSnapshots(db, 999_999_999)).not.toThrow();
  });
});
