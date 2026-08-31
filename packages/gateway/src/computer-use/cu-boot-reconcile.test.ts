import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ORPHANED_SESSION_REASON, reconcileOrphanedSessions } from "./cu-boot-reconcile.ts";
import { insertSession, listOpenSessions, updateSessionState } from "./cu-store.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  return db;
}

function seed(db: Database, id: string, openedAt = 1_000): void {
  insertSession(db, { id, lane: "browser", envelopeJson: "{}", openedAt });
}

function auditRows(
  db: Database,
): Array<{ action_type: string; hitl_status: string; action_json: string }> {
  return db
    .query<{ action_type: string; hitl_status: string; action_json: string }, []>(
      `SELECT action_type, hitl_status, action_json FROM audit_log ORDER BY id ASC`,
    )
    .all();
}

function sessionRow(
  db: Database,
  id: string,
): { closed_at: number | null; close_reason: string | null } | null {
  return db
    .query<{ closed_at: number | null; close_reason: string | null }, [string]>(
      `SELECT closed_at, close_reason FROM cu_session WHERE id = ?`,
    )
    .get(id);
}

describe("reconcileOrphanedSessions", () => {
  test("closes every session left open by a previous process", async () => {
    const db = makeDb();
    seed(db, "s1", 10);
    seed(db, "s2", 20);
    const out = reconcileOrphanedSessions(db, { now: () => 5_000 });
    expect(out.reconciled).toBe(2);
    expect(out.sessionIds).toEqual(["s1", "s2"]);
    for (const id of ["s1", "s2"]) {
      expect(sessionRow(db, id)).toEqual({
        closed_at: 5_000,
        close_reason: ORPHANED_SESSION_REASON,
      });
    }
    db.close();
  });

  test("the reason is NOT terminated_target_lost", () => {
    // The browser genuinely is gone, but `terminated_target_lost` is assigned by `runAction` when a
    // LIVE session's lane dies under it — it implies the gate OBSERVED the loss and stopped an
    // action. Nothing observed anything here: the process that held the session is not the process
    // writing this row, and the audit log is the only place the distinction can be recovered.
    const db = makeDb();
    seed(db, "s1");
    reconcileOrphanedSessions(db, { now: () => 5_000 });
    expect(sessionRow(db, "s1")?.close_reason).toBe("orphaned_by_gateway_restart");
    expect(sessionRow(db, "s1")?.close_reason).not.toBe("terminated_target_lost");
    db.close();
  });

  test("leaves an ALREADY-CLOSED session untouched", async () => {
    const db = makeDb();
    seed(db, "closed-already");
    updateSessionState(db, "closed-already", { closedAt: 42, closeReason: "owner" });
    const out = reconcileOrphanedSessions(db, { now: () => 5_000 });
    expect(out.reconciled).toBe(0);
    // Its ORIGINAL reason and timestamp survive — a reconciliation must never overwrite a real one.
    expect(sessionRow(db, "closed-already")).toEqual({ closed_at: 42, close_reason: "owner" });
    db.close();
  });

  test("is IDEMPOTENT — a second run finds nothing and writes nothing", () => {
    const db = makeDb();
    seed(db, "s1");
    reconcileOrphanedSessions(db, { now: () => 5_000 });
    const afterFirst = auditRows(db).length;
    const second = reconcileOrphanedSessions(db, { now: () => 9_000 });
    expect(second.reconciled).toBe(0);
    expect(auditRows(db)).toHaveLength(afterFirst);
    expect(sessionRow(db, "s1")?.closed_at).toBe(5_000);
    db.close();
  });

  test("an empty table is a no-op, not an error", () => {
    const db = makeDb();
    expect(reconcileOrphanedSessions(db, { now: () => 1 })).toEqual({
      reconciled: 0,
      sessionIds: [],
    });
    expect(auditRows(db)).toHaveLength(0);
    db.close();
  });

  test("appends one chained computer.session audit row per reconciled session", () => {
    const db = makeDb();
    seed(db, "s1", 77);
    reconcileOrphanedSessions(db, { now: () => 5_000 });
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action_type).toBe("computer.session");
    // `rejected`, never `not_required` — on this action type `not_required` would read as "this ran
    // without needing approval", which is precisely what it must not say.
    expect(rows[0]?.hitl_status).toBe("rejected");
    const payload = JSON.parse(rows[0]?.action_json as string) as Record<string, unknown>;
    expect(payload["outcome"]).toBe(ORPHANED_SESSION_REASON);
    expect(payload["sessionId"]).toBe("s1");
    expect(payload["lane"]).toBe("browser");
    expect(payload["openedAt"]).toBe(77);
  });

  test("closes the ROW before appending the audit entry, so a failed append cannot double-close", () => {
    // The ordering claim, red-proved: with `audit_log` unavailable the reconciliation throws, but
    // the row is already closed — so the NEXT boot finds nothing to reconcile rather than closing
    // it a second time under a new timestamp.
    const db = makeDb();
    seed(db, "s1");
    db.run("DROP TABLE audit_log");
    expect(() => reconcileOrphanedSessions(db, { now: () => 5_000 })).toThrow();
    expect(sessionRow(db, "s1")?.closed_at).toBe(5_000);
    db.close();
  });
});

describe("listOpenSessions", () => {
  test("returns only rows with closed_at IS NULL, oldest first", () => {
    const db = makeDb();
    seed(db, "new", 300);
    seed(db, "old", 100);
    seed(db, "done", 200);
    updateSessionState(db, "done", { closedAt: 250, closeReason: "owner" });
    expect(listOpenSessions(db).map((r) => r.id)).toEqual(["old", "new"]);
    db.close();
  });

  test("carries the lane and open time a reconciliation records", () => {
    const db = makeDb();
    seed(db, "s1", 4_242);
    expect(listOpenSessions(db)[0]).toEqual({ id: "s1", lane: "browser", openedAt: 4_242 });
    db.close();
  });
});
