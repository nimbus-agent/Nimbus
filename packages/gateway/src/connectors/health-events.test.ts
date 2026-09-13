import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { setGatewayEventBroadcast } from "../ipc/gateway-events.ts";
import { createMemoryIndexDb } from "./connector-sync-test-helpers.ts";
import { transitionHealth } from "./health.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

function captured(): Array<{ method: string; params: Record<string, unknown> }> {
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  setGatewayEventBroadcast((method, params) => seen.push({ method, params }));
  return seen;
}

describe("connector.healthChanged", () => {
  test("emits the DESKTOP's field names, so ConnectorGrid can patch a row", () => {
    const db: Database = createMemoryIndexDb();
    const seen = captured();
    transitionHealth(db, "github", { type: "persistent_error", error: "boom" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("connector.healthChanged");
    const p = seen[0]?.params as Record<string, unknown>;
    // `name`/`health`, never `connectorId`/`toState`.
    expect(p["name"]).toBe("github");
    // `error` is the derived STATE; `persistent_error` is the EVENT type and must never appear.
    expect(p["health"]).toBe("error");
    expect(p["health"]).not.toBe("persistent_error");
  });

  test("an unchanged state still emits — from === to is a real, recorded transition", () => {
    // `transitionHealth` has no early return when the state does not change, so a repeat failure
    // while already degraded appends history and emits. Suppressing it would hide repeated
    // failures from the one reader who wants them.
    const db: Database = createMemoryIndexDb();
    transitionHealth(db, "github", { type: "transient_error", error: "a", attempt: 1 });
    const seen = captured();
    transitionHealth(db, "github", { type: "transient_error", error: "b", attempt: 2 });
    expect(seen).toHaveLength(1);
    const p = seen[0]?.params as Record<string, unknown>;
    expect(p["fromState"]).toBe("degraded");
    expect(p["health"]).toBe("degraded");
  });

  test("a throwing subscriber leaves the transition COMMITTED", () => {
    const db: Database = createMemoryIndexDb();
    setGatewayEventBroadcast(() => {
      throw new Error("subscriber exploded");
    });
    expect(() => transitionHealth(db, "github", { type: "unauthenticated" })).not.toThrow();
    const row = db
      .query("SELECT health_state FROM sync_state WHERE connector_id = ?")
      .get("github") as { health_state: string } | null;
    expect(row?.health_state).toBe("unauthenticated");
  });

  test("a failed COMMIT rolls back the transition AND emits nothing", () => {
    // A same-connection `COUNT(*)` cannot tell "written, uncommitted" from "committed" on
    // bun:sqlite — a connection reads its own uncommitted writes, so that mechanism can't
    // distinguish the emit sitting inside `db.transaction(...)` from sitting after it (proven by
    // hand against a throwaway `bun:sqlite` transaction outside this file: a `COUNT(*)` taken
    // from *inside* the closure, right after the INSERT, already reads 1).
    //
    // A COMMIT-time failure can. Add a column to `connector_health_history` — this fresh
    // in-memory db only, no production migration touched — carrying a DEFERRABLE FK that is
    // guaranteed to be violated by any row `appendHistory` inserts (it never sets the column, so
    // it takes the default, which points at a table with no matching row). DEFERRABLE means
    // SQLite does NOT check it at the INSERT — only at COMMIT. So `appendHistory`'s insert
    // SUCCEEDS, the closure returns normally, and only then does `db.transaction(...)()`'s own
    // COMMIT fail and roll back everything the closure did, including the earlier
    // `upsertHealthRow` write.
    //
    // That is exactly the window the ordering rule defends: an emit placed INSIDE the closure
    // runs to completion before the COMMIT is even attempted, so it fires — 1 emit, despite the
    // rollback. An emit placed AFTER `db.transaction(...)()` returns never runs at all, because
    // the COMMIT failure throws out of that call before reaching the next line — 0 emits.
    const db: Database = createMemoryIndexDb();
    db.exec(`
      CREATE TABLE health_events_test_fk_sentinel (id INTEGER PRIMARY KEY);
      ALTER TABLE connector_health_history
        ADD COLUMN test_only_fk_ref INTEGER NOT NULL DEFAULT 999
          REFERENCES health_events_test_fk_sentinel(id) DEFERRABLE INITIALLY DEFERRED;
    `);
    const seen = captured();
    expect(() => transitionHealth(db, "github", { type: "sync_success" })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(seen).toEqual([]);
    // No row at all — even the `INSERT OR IGNORE` that creates it rolled back.
    const row = db.query("SELECT 1 FROM sync_state WHERE connector_id = ?").get("github");
    expect(row).toBeNull();
  });

  test("a configured/not_configured change EMITS, despite the early return", () => {
    // `transitionHealth` returns early for these two before ever reaching the main transaction,
    // so an emit placed only after that transaction is unreachable for them — and these are the
    // transitions `nimbus connector auth` produces, the ones a user is most likely watching for.
    const db: Database = createMemoryIndexDb();
    transitionHealth(db, "github", { type: "sync_success" }); // create the row
    // V56's `configured` column DEFAULTs to 1 for a freshly-created row (the migration's own
    // rationale: a row only ever exists because the connector actually ran), so drive it to 0
    // first — otherwise the "configured" event below is the no-op the next test covers.
    transitionHealth(db, "github", { type: "not_configured" });
    const seen = captured();
    transitionHealth(db, "github", { type: "configured" });
    expect(seen).toHaveLength(1);
    const p = seen[0]?.params as Record<string, unknown>;
    expect(p["name"]).toBe("github");
    expect(p["reason"]).toBe("credential configured");
    // Pins the auth round trip: `fromState` must be the externally VISIBLE previous state
    // (`not_configured`), never the untouched `health_state` column (`healthy`) — a reader would
    // otherwise see `healthy -> healthy` for exactly the transition this event exists to surface.
    expect(p["fromState"]).toBe("not_configured");
    expect(p["health"]).toBe("healthy");
  });

  test("a configured event that changes NOTHING emits nothing", () => {
    // `applyConfiguredFlag` no-ops when the flag already matches; the emit must respect that
    // guard rather than firing on every auth check. Reaching that guard (as opposed to its
    // `current === null` guard, which fires for ANY event on a connector with no row yet) needs a
    // real row already sitting in the target state — `sync_success` creates one with
    // `configured = 1` (V56's default), which already IS "configured", so the `configured` event
    // below is the no-op under test.
    const db: Database = createMemoryIndexDb();
    transitionHealth(db, "github", { type: "sync_success" });
    const seen = captured();
    transitionHealth(db, "github", { type: "configured" });
    expect(seen).toEqual([]);
  });

  test("a non-state-changing event type emits nothing", () => {
    // `skipped_offline` appends history but is explicitly not a health CHANGE.
    const db: Database = createMemoryIndexDb();
    const seen = captured();
    transitionHealth(db, "github", { type: "skipped_offline" });
    expect(seen).toEqual([]);
  });
});
