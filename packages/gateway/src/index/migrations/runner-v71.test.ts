import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V71 migration — extension registries", () => {
  test("CURRENT_SCHEMA_VERSION is at least 71", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
  });

  test("V71 creates extension_registry and three nullable extension columns", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 71);
      const reg = db.query("PRAGMA table_info(extension_registry)").all() as { name: string }[];
      expect(reg.map((c) => c.name)).toEqual([
        "name",
        "url",
        "root_key",
        "root_fingerprint",
        "last_sequence",
        "last_generated_at",
        "added_at",
        "last_fetched_at",
      ]);
      const ext = db.query("PRAGMA table_info(extension)").all() as {
        name: string;
        notnull: number;
      }[];
      for (const col of ["source_registry", "source_root_fingerprint", "source_channel"]) {
        const c = ext.find((x) => x.name === col);
        expect(c).toBeDefined();
        expect(c?.notnull).toBe(0);
      }
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 71 });
    } finally {
      db.close();
    }
  });

  test("existing extension rows keep NULL source after migration", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 70);
      db.run(
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('com.example.old', '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
      );
      runIndexedSchemaMigrations(db, 71);
      expect(
        db
          .query(
            "SELECT source_registry, source_root_fingerprint, source_channel FROM extension WHERE id = 'com.example.old'",
          )
          .get(),
      ).toEqual({ source_registry: null, source_root_fingerprint: null, source_channel: null });
    } finally {
      db.close();
    }
  });

  test("source_channel admits only stable or beta; url is UNIQUE", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 71);
      db.run(
        `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
         VALUES ('a', '1', '/x', 'm', 'e', 1, 1, 1)`,
      );
      expect(() =>
        db.run("UPDATE extension SET source_channel = 'nightly' WHERE id = 'a'"),
      ).toThrow();
      db.run("UPDATE extension SET source_channel = 'beta' WHERE id = 'a'");
      const ins = (name: string, url: string): void => {
        db.run(
          `INSERT INTO extension_registry (name, url, root_key, root_fingerprint, last_sequence, last_generated_at, added_at)
           VALUES (?, ?, 'k', 'f', 1, 't', 1)`,
          [name, url],
        );
      };
      ins("r1", "https://a.example/");
      expect(() => ins("r2", "https://a.example/")).toThrow();
    } finally {
      db.close();
    }
  });
});
