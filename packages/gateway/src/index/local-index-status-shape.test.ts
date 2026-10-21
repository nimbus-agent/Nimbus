import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { transitionHealth } from "../connectors/health.ts";
import { LocalIndex } from "./local-index.ts";

function setup(): { idx: LocalIndex; db: Database } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const idx = new LocalIndex(db);
  return { idx, db };
}

describe("LocalIndex.persistedConnectorStatuses — depth + enabled shape (V21)", () => {
  test("fresh connector returns depth='full' and enabled=true", () => {
    const { idx, db } = setup();
    db.run(
      `INSERT INTO scheduler_state
         (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
       VALUES (?, NULL, 60000, NULL, NULL, 'ok', NULL, 0, 0)`,
      ["github"],
    );
    const statuses = idx.persistedConnectorStatuses("github");
    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    expect(s).toBeDefined();
    expect(s!.depth).toBe("full");
    expect(s!.enabled).toBe(true);
  });

  test("enabled=false after pause", () => {
    const { idx, db } = setup();
    db.run(
      `INSERT INTO scheduler_state
         (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
       VALUES (?, NULL, 60000, NULL, NULL, 'ok', NULL, 0, 1)`,
      ["github"],
    );
    const statuses = idx.persistedConnectorStatuses("github");
    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    expect(s).toBeDefined();
    expect(s!.enabled).toBe(false);
  });

  test("reflects persisted depth from sync_state", () => {
    const { idx, db } = setup();
    db.run(
      `INSERT INTO scheduler_state
         (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
       VALUES (?, NULL, 60000, NULL, NULL, 'ok', NULL, 0, 0)`,
      ["github"],
    );
    db.run(
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth) VALUES (?, NULL, NULL, ?)`,
      ["github", "metadata_only"],
    );
    const statuses = idx.persistedConnectorStatuses("github");
    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    expect(s).toBeDefined();
    expect(s!.depth).toBe("metadata_only");
    expect(s!.enabled).toBe(true);
  });
});

describe("LocalIndex.persistedConnectorStatuses: lastError on a paused service", () => {
  function pausedWithStaleError(): { idx: LocalIndex; db: Database } {
    const { idx, db } = setup();
    db.run(
      `INSERT INTO scheduler_state
         (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
       VALUES (?, NULL, 60000, NULL, NULL, 'error', 'old sync failure', 1, 1)`,
      ["readwise"],
    );
    return { idx, db };
  }

  test("a stated pause reason wins over a stale sync error (what connector.listStatus serves)", () => {
    const { idx, db } = pausedWithStaleError();
    transitionHealth(db, "readwise", { type: "paused", reason: "moving to a signed extension" });
    expect(idx.persistedConnectorStatuses("readwise")[0]?.lastError).toBe(
      "moving to a signed extension",
    );
  });

  test("a pause with no stated reason keeps the sync error", () => {
    const { idx, db } = pausedWithStaleError();
    transitionHealth(db, "readwise", { type: "paused" });
    expect(idx.persistedConnectorStatuses("readwise")[0]?.lastError).toBe("old sync failure");
  });
});
