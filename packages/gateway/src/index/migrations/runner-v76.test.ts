import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function withDb(fn: (db: Database) => void): void {
  const db = new Database(":memory:");
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function insertStatement(
  db: Database,
  role: string,
  scopeRegistry: string | null,
  scopeRootFingerprint: string | null,
  kind = "key.revoke",
): void {
  db.run(
    `INSERT INTO trust_statement (statement_id, kind, statement_json, signer_fingerprint, signer_role,
       scope_registry, scope_root_fingerprint, source, publisher_id, key_fingerprint, first_seen_at)
     VALUES (?, ?, '{}', 'f', ?, ?, ?, 'feed', 'acme', 'k', 1)`,
    [
      `${role}-${String(scopeRegistry)}-${String(scopeRootFingerprint)}-${kind}`,
      kind,
      role,
      scopeRegistry,
      scopeRootFingerprint,
    ],
  );
}

describe("V76 migration — trust layer", () => {
  test("CURRENT_SCHEMA_VERSION is at least 76", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(76);
  });

  test("existing registry and run-grant rows survive with the new defaults", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 75);
      db.run(
        `INSERT INTO extension_registry (name, url, root_key, root_fingerprint, last_sequence, last_generated_at, added_at, last_fetched_at)
         VALUES ('acme', 'https://r.example/', 'k', 'f', 5, '2026-10-01T00:00:00Z', 1, NULL)`,
      );
      db.run(
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('acme/x', '1.0.0', '/p', 'm', 'e', 1, 1, 1)`,
      );
      db.run(
        `INSERT INTO extension_run_grant (extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at)
         VALUES ('acme/x', 'ext_acme_x', '1.0.0', 'd', '{}', 0, 1)`,
      );
      runIndexedSchemaMigrations(db, 76);
      expect(
        db.query("SELECT last_sequence, last_index_sha256 FROM extension_registry").get(),
      ).toEqual({ last_sequence: 5, last_index_sha256: null });
      expect(db.query("SELECT trust_ack_json FROM extension_run_grant").get()).toEqual({
        trust_ack_json: "[]",
      });
      expect(db.query("SELECT publisher_key_fingerprint FROM extension").get()).toEqual({
        publisher_key_fingerprint: null,
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 76 });
    });
  });

  test("the built-in registry state gains a nullable hash floor", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 76);
      db.run(
        `INSERT INTO builtin_registry_state (name, root_key, last_sequence) VALUES ('nimbus-official', 'k', 1)`,
      );
      expect(db.query("SELECT last_index_sha256 FROM builtin_registry_state").get()).toEqual({
        last_index_sha256: null,
      });
      db.run(
        `INSERT INTO trust_feed_state (name, root_key, last_sequence, last_document_sha256, last_generated_at)
         VALUES ('nimbus-trust', 'k', 1, 'h', '2026-10-01T00:00:00Z')`,
      );
    });
  });

  test("a statement's scope is set exactly when a registry signed it", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 76);
      insertStatement(db, "registry", "acme", "fp");
      insertStatement(db, "nimbus", null, null);
      insertStatement(db, "publisher", null, null);
      expect(() => insertStatement(db, "registry", null, null)).toThrow();
      expect(() => insertStatement(db, "registry", "acme", null)).toThrow();
      expect(() => insertStatement(db, "nimbus", "acme", "fp")).toThrow();
      expect(() => insertStatement(db, "nimbus", "acme", null)).toThrow();
      expect(() => insertStatement(db, "publisher", null, "fp")).toThrow();
      expect(() => insertStatement(db, "root", null, null)).toThrow();
    });
  });

  test("an unknown statement kind is refused", () => {
    withDb((db) => {
      runIndexedSchemaMigrations(db, 76);
      insertStatement(db, "nimbus", null, null, "extension.takedown");
      expect(() => insertStatement(db, "nimbus", null, null, "key.unrevoke")).toThrow();
    });
  });
});
