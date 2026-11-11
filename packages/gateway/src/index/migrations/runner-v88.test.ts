import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { dbRun } from "../../db/write.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

function cols(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function insertRule(db: Database, over: Record<string, unknown> = {}): void {
  const r = {
    id: "sr_0123456789abcdef",
    created_at: 1_000,
    workflow_id: "wf1",
    workflow_sha256: "a".repeat(64),
    step_index: 1,
    action_type: "gmail.thread.archive",
    tool_id: "gmail_thread_archive",
    scope_json: "{}",
    window_json: null,
    expires_at: 2_000,
    max_actions: 10,
    actions_used: 0,
    approval_audit_id: 1,
    ...over,
  };
  dbRun(
    db,
    `INSERT INTO standing_rule (id, created_at, workflow_id, workflow_sha256, step_index, action_type,
       tool_id, scope_json, window_json, expires_at, max_actions, actions_used, approval_audit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.created_at,
      r.workflow_id,
      r.workflow_sha256,
      r.step_index,
      r.action_type,
      r.tool_id,
      r.scope_json,
      r.window_json,
      r.expires_at,
      r.max_actions,
      r.actions_used,
      r.approval_audit_id,
    ] as never,
  );
}

describe("V88 migration — standing approval rules", () => {
  test("a V87 database migrates and gains the two empty rule tables", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 87);
      runIndexedSchemaMigrations(db, 88);
      expect(cols(db, "standing_rule")).toEqual([
        "id",
        "created_at",
        "workflow_id",
        "workflow_sha256",
        "step_index",
        "action_type",
        "tool_id",
        "scope_json",
        "window_json",
        "expires_at",
        "max_actions",
        "actions_used",
        "paused_at",
        "revoked_at",
        "last_fired_at",
        "approval_audit_id",
      ]);
      expect(cols(db, "standing_rule_fire")).toEqual([
        "fire_id",
        "rule_id",
        "fired_at",
        "action_type",
        "matched_scope_sha256",
      ]);
      expect(db.query("SELECT COUNT(*) AS n FROM standing_rule").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 88 });
    } finally {
      db.close();
    }
  });

  test("the table constraints hold: ceiling 1..500, counter within it, expiry after creation", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 88);
      insertRule(db);
      expect(() => insertRule(db, { id: "sr_2", max_actions: 0 })).toThrow();
      expect(() => insertRule(db, { id: "sr_3", max_actions: 501 })).toThrow();
      expect(() => insertRule(db, { id: "sr_4", actions_used: 11 })).toThrow();
      expect(() => insertRule(db, { id: "sr_5", expires_at: 1_000 })).toThrow();
      expect(() => insertRule(db, { id: "sr_6", step_index: -1 })).toThrow();
      expect(() => insertRule(db)).toThrow();
    } finally {
      db.close();
    }
  });

  test("the fire index exists and the registered maximum agrees with the current schema", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 88);
      const names = (
        db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(names).toContain("idx_standing_rule_fire_rule");
      expect(maxRegisteredIndexedSchemaVersion()).toBeGreaterThanOrEqual(88);
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
    } finally {
      db.close();
    }
  });
});
