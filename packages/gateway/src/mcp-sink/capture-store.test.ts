import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { CaptureStore, type NewCaptureRow } from "./capture-store.ts";

let db: Database;
let store: CaptureStore;

function note(id: string, createdAt: number, over: Partial<NewCaptureRow> = {}): NewCaptureRow {
  return {
    id,
    kind: "note",
    state: "live",
    itemId: `nimbus:${id}`,
    payloadJson: '{"title":"t"}',
    payloadBytes: 13,
    clientLabel: "claude-code",
    sessionId: "s1",
    createdAt,
    expiresAt: null,
    ...over,
  };
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  store = new CaptureStore(db);
});
afterEach(() => db.close());

describe("CaptureStore", () => {
  test("insert then get round-trips every column", () => {
    store.insert(note("cap_a", 1000));
    expect(store.get("cap_a")).toEqual({
      ...note("cap_a", 1000),
      nativeRef: null,
      decidedAt: null,
      expiresAt: null,
      outcomeRef: null,
      errorCode: null,
    });
    expect(store.get("cap_missing")).toBeUndefined();
  });

  test("list is newest first and filters by state and kind", () => {
    store.insert(note("cap_a", 1000));
    store.insert(note("cap_b", 2000));
    expect(store.list({ limit: 10 }).map((r) => r.id)).toEqual(["cap_b", "cap_a"]);
    expect(store.list({ state: "revoked", limit: 10 })).toEqual([]);
    expect(store.list({ kind: "note", limit: 1 }).map((r) => r.id)).toEqual(["cap_b"]);
  });

  test("counts by state and by creation window", () => {
    store.insert(note("cap_a", 1000));
    store.insert(note("cap_b", 5000));
    expect(store.countByState("live")).toBe(2);
    expect(store.countByState("proposed")).toBe(0);
    expect(store.countCreatedSince(2000)).toBe(1);
  });

  test("stateOfItem finds the capture behind an item id", () => {
    store.insert(note("cap_a", 1000));
    expect(store.stateOfItem("nimbus:cap_a")).toBe("live");
    expect(store.stateOfItem("github:1")).toBeUndefined();
  });

  test("markRevoked clears payload + item, keeps the rest, and refuses a lost race", () => {
    store.insert(note("cap_a", 1000));
    expect(store.markRevoked("cap_a", "live", 9000)).toBe(true);
    const r = store.get("cap_a");
    expect(r).toMatchObject({ state: "revoked", payloadJson: null, itemId: null, decidedAt: 9000 });
    expect(r?.payloadBytes).toBe(13);
    expect(r?.clientLabel).toBe("claude-code");
    expect(store.markRevoked("cap_a", "live", 9001)).toBe(false);
  });

  test("pruneFinished deletes by decided_at, never other states", () => {
    store.insert(note("cap_a", 1000));
    db.run(
      "INSERT INTO capture (id, kind, state, payload_json, payload_bytes, session_id, created_at, decided_at) VALUES ('cap_r', 'term', 'rejected', '{}', 2, 's', 1, 5000)",
    );
    expect(store.pruneFinished(4000)).toBe(0);
    expect(store.pruneFinished(6000)).toBe(1);
    expect(store.get("cap_r")).toBeUndefined();
    expect(store.get("cap_a")).toBeDefined();
  });

  test("markAccepted / markRejected only transition a proposed row", () => {
    store.insert(note("cap_p", 1, { kind: "term", state: "proposed", itemId: null }));
    expect(store.markAccepted("cap_p", "nimbus:cap_p", "wal", 50)).toBe(true);
    expect(store.get("cap_p")).toMatchObject({
      state: "accepted",
      itemId: "nimbus:cap_p",
      nativeRef: "wal",
      decidedAt: 50,
    });
    expect(store.markAccepted("cap_p", "nimbus:cap_p", "wal", 51)).toBe(false);
    expect(store.markRejected("cap_p", 52)).toBe(false);
    store.insert(note("cap_q", 1, { kind: "term", state: "proposed", itemId: null }));
    expect(store.markRejected("cap_q", 60)).toBe(true);
    expect(store.get("cap_q")).toMatchObject({ state: "rejected", decidedAt: 60 });
    expect(store.markRejected("cap_q", 61)).toBe(false);
    expect(store.markAccepted("cap_q", "nimbus:cap_q", "x", 62)).toBe(false);
    expect(store.markAccepted("cap_none", "i", "x", 1)).toBe(false);
  });

  test("countAcceptedWithNativeRef excludes the given id and other states", () => {
    for (const id of ["cap_1", "cap_2", "cap_3"]) {
      store.insert(note(id, 1, { kind: "term", state: "proposed", itemId: null }));
    }
    store.markAccepted("cap_1", "nimbus:cap_1", "wal", 1);
    store.markAccepted("cap_2", "nimbus:cap_2", "wal", 2);
    expect(store.countAcceptedWithNativeRef("wal", "cap_1")).toBe(1);
    expect(store.countAcceptedWithNativeRef("wal", "cap_3")).toBe(2);
    expect(store.countAcceptedWithNativeRef("other", "cap_3")).toBe(0);
  });

  test("a row whose kind or state is unrecognised is rejected on read, not mis-typed", () => {
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run(
      "INSERT INTO capture (id, kind, state, payload_json, payload_bytes, session_id, created_at) VALUES ('cap_x', 'bogus', 'live', '{}', 2, 's', 1)",
    );
    expect(() => store.get("cap_x")).toThrow(/unrecognised capture row/);
  });
  test("stateOfItem reports undefined for an unrecognised stored state", () => {
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run(
      "INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, session_id, created_at) VALUES ('cap_y', 'note', 'bogus', 'nimbus:y', '{}', 2, 's', 1)",
    );
    expect(store.stateOfItem("nimbus:y")).toBeUndefined();
  });
});

describe("action queries (PR 3)", () => {
  function action(id: string, expiresAt: number, state = "proposed"): void {
    new CaptureStore(db).insert({
      id,
      kind: "action",
      state: state as never,
      itemId: null,
      payloadJson: "{}",
      payloadBytes: 2,
      clientLabel: null,
      sessionId: "s",
      createdAt: 1,
      expiresAt,
    });
  }
  test("countPendingActions excludes expired-by-clock rows; the boundary counts as expired", () => {
    action("cap_a", 100);
    action("cap_b", 200);
    const s = new CaptureStore(db);
    expect(s.countPendingActions(99)).toBe(2);
    expect(s.countPendingActions(100)).toBe(1);
  });
  test("countPendingNative excludes actions; countPendingActionsExpiringBy windows", () => {
    action("cap_a", 100);
    const s = new CaptureStore(db);
    s.insert({
      id: "cap_d",
      kind: "decision",
      state: "proposed",
      itemId: null,
      payloadJson: "{}",
      payloadBytes: 2,
      clientLabel: null,
      sessionId: "s",
      createdAt: 1,
      expiresAt: null,
    });
    expect(s.countPendingNative()).toBe(1);
    expect(s.countPendingActionsExpiringBy(50, 100)).toBe(1);
    expect(s.countPendingActionsExpiringBy(50, 99)).toBe(0);
  });
  test("expireDueActions returns exactly the due ids and transitions them", () => {
    action("cap_a", 100);
    action("cap_b", 200);
    const s = new CaptureStore(db);
    expect(s.expireDueActions(150)).toEqual(["cap_a"]);
    expect(s.get("cap_a")?.state).toBe("expired");
    expect(s.get("cap_a")?.decidedAt).toBe(150);
    expect(s.get("cap_b")?.state).toBe("proposed");
    expect(s.expireDueActions(150)).toEqual([]);
  });
  test("claimAction wins once, loses on a moved or expired row", () => {
    action("cap_a", 100);
    const s = new CaptureStore(db);
    expect(s.claimAction("cap_a", 100)).toBe(false); // at the boundary: expired
    expect(s.claimAction("cap_a", 50)).toBe(true);
    expect(s.get("cap_a")?.state).toBe("executing");
    expect(s.claimAction("cap_a", 50)).toBe(false);
  });
  test("finalizeAction only moves an executing row", () => {
    action("cap_a", 100);
    const s = new CaptureStore(db);
    expect(s.finalizeAction("cap_a", "executed", { outcomeRef: "https://x" }, 60)).toBe(false);
    s.claimAction("cap_a", 50);
    expect(s.finalizeAction("cap_a", "executed", { outcomeRef: "https://x" }, 60)).toBe(true);
    expect(s.get("cap_a")).toMatchObject({
      state: "executed",
      outcomeRef: "https://x",
      decidedAt: 60,
    });
  });
  test("failInterruptedActions turns executing into failed/ERR_ACTION_INTERRUPTED", () => {
    action("cap_a", 100);
    const s = new CaptureStore(db);
    s.claimAction("cap_a", 50);
    expect(s.failInterruptedActions(70)).toEqual(["cap_a"]);
    expect(s.get("cap_a")).toMatchObject({ state: "failed", errorCode: "ERR_ACTION_INTERRUPTED" });
  });
  test("pruneFinished also prunes expired, executed and failed actions by decided_at", () => {
    action("cap_e", 100);
    action("cap_x", 100);
    action("cap_f", 100);
    const s = new CaptureStore(db);
    s.expireDueActions(150); // all three expire
    db.run("UPDATE capture SET state='executed', outcome_ref=NULL WHERE id='cap_x'");
    db.run("UPDATE capture SET state='failed', error_code='ERR_ACTION_DISPATCH' WHERE id='cap_f'");
    expect(s.pruneFinished(150)).toBe(0); // decided AT the cutoff: not older than it
    expect(s.pruneFinished(1_000)).toBe(3);
    for (const id of ["cap_e", "cap_x", "cap_f"]) expect(s.get(id)).toBeUndefined();
  });
  test("pruneFinished never touches a proposed or executing action", () => {
    action("cap_p", 100);
    action("cap_x", 100);
    const s = new CaptureStore(db);
    s.claimAction("cap_x", 50);
    expect(s.pruneFinished(10_000)).toBe(0);
    expect(s.get("cap_p")?.state).toBe("proposed");
    expect(s.get("cap_x")?.state).toBe("executing");
  });
  test("deleteFinishedAction deletes only a finished action in the expected state", () => {
    action("cap_x", 100);
    action("cap_p", 100);
    const s = new CaptureStore(db);
    s.claimAction("cap_x", 50);
    // executing is not finished: refused even when it is the expected state
    expect(s.deleteFinishedAction("cap_x", "executing")).toBe(false);
    expect(s.finalizeAction("cap_x", "executed", {}, 60)).toBe(true);
    // a stale expectation (the row moved on) deletes nothing
    expect(s.deleteFinishedAction("cap_x", "failed")).toBe(false);
    expect(s.deleteFinishedAction("cap_x", "executed")).toBe(true);
    expect(s.get("cap_x")).toBeUndefined();
    expect(s.deleteFinishedAction("cap_x", "executed")).toBe(false);
    expect(s.deleteFinishedAction("cap_p", "proposed")).toBe(false);
    expect(s.get("cap_p")?.state).toBe("proposed");
  });
});
