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

const ins = (db: Database, context: string, ns: string, form: string): unknown =>
  dbRun(
    db,
    "INSERT INTO connector_write_k8s_grant (context, namespace, server, credential_form, approved_at) VALUES (?, ?, 'h:443', ?, 1)",
    [context, ns, form],
  );

describe("V86 migration — the Kubernetes approved (context, namespace) grants", () => {
  test("a V85 database migrates and gains the empty grant table (nothing approved)", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 85);
      runIndexedSchemaMigrations(db, 86);
      expect(cols(db, "connector_write_k8s_grant")).toEqual([
        "context",
        "namespace",
        "server",
        "credential_form",
        "approved_at",
      ]);
      expect(db.query("SELECT COUNT(*) AS n FROM connector_write_k8s_grant").get()).toEqual({
        n: 0,
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 86 });
    } finally {
      db.close();
    }
  });

  test("the key is (context, namespace) and the credential form is closed", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 86);
      ins(db, "prod", "shop", "token");
      ins(db, "prod", "other", "token");
      ins(db, "staging", "shop", "client-certificate");
      expect(() => ins(db, "prod", "shop", "token")).toThrow();
      expect(() => ins(db, "x", "y", "exec")).toThrow();
      expect(() => ins(db, "x", "y", "basic")).toThrow();
    } finally {
      db.close();
    }
  });

  test("the registered maximum and the current schema are at least 86, and agree", () => {
    expect(maxRegisteredIndexedSchemaVersion()).toBeGreaterThanOrEqual(86);
    expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
  });
});
