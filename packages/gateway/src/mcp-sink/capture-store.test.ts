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

  test("pruneRejected deletes by decided_at, never other states", () => {
    store.insert(note("cap_a", 1000));
    db.run(
      "INSERT INTO capture (id, kind, state, payload_json, payload_bytes, session_id, created_at, decided_at) VALUES ('cap_r', 'term', 'rejected', '{}', 2, 's', 1, 5000)",
    );
    expect(store.pruneRejected(4000)).toBe(0);
    expect(store.pruneRejected(6000)).toBe(1);
    expect(store.get("cap_r")).toBeUndefined();
    expect(store.get("cap_a")).toBeDefined();
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
