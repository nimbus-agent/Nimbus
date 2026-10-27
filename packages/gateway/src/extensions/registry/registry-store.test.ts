import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { RegistryError } from "@nimbus-dev/registry-format";
import { listExtensions } from "../../automation/extension-store.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  deleteRegistry,
  getExtensionSource,
  getRegistry,
  insertRegistry,
  listRegistries,
  recordRegistryFetch,
  setExtensionSource,
} from "./registry-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  return db;
}

function addExt(db: Database, id: string): void {
  db.run(
    `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
     VALUES (?, '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
    [id],
  );
}

const base = {
  name: "main",
  url: "https://reg.example/",
  rootKey: "KEY",
  rootFingerprint: "FP",
  lastSequence: 3,
  lastGeneratedAt: "2026-10-18T00:00:00Z",
  addedAt: 100,
  lastIndexSha256: null,
};

describe("registry store: the index hash floor", () => {
  test("insertRegistry alone stores the supplied hash", () => {
    const db = freshDb();
    try {
      insertRegistry(db, { ...base, lastIndexSha256: "hA" });
      expect(getRegistry(db, "main")?.lastIndexSha256).toBe("hA");
    } finally {
      db.close();
    }
  });

  test("a row with no hash adopts one at its sequence; then only that document or a higher sequence", () => {
    const db = freshDb();
    try {
      insertRegistry(db, { ...base, lastSequence: 5 });
      const rec = (seq: number, hash: string) =>
        recordRegistryFetch(db, "main", base.rootKey, seq, "2026-10-19T00:00:00Z", 1, hash);
      expect(rec(5, "hA")).toBe(true);
      expect(getRegistry(db, "main")?.lastIndexSha256).toBe("hA");
      expect(rec(5, "hA")).toBe(true);
      expect(rec(5, "hB")).toBe(false);
      expect(getRegistry(db, "main")?.lastIndexSha256).toBe("hA");
      expect(rec(6, "hB")).toBe(true);
      expect(getRegistry(db, "main")).toMatchObject({ lastSequence: 6, lastIndexSha256: "hB" });
      expect(rec(5, "hA")).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("registry store", () => {
  test("round trip: insert, get, list, record fetch, delete", () => {
    const db = freshDb();
    try {
      expect(listRegistries(db)).toEqual([]);
      insertRegistry(db, base);
      expect(getRegistry(db, "main")).toEqual({ ...base, lastFetchedAt: null });
      recordRegistryFetch(db, "main", base.rootKey, 4, "2026-10-19T00:00:00Z", 200, "h4");
      expect(listRegistries(db)).toEqual([
        {
          ...base,
          lastSequence: 4,
          lastGeneratedAt: "2026-10-19T00:00:00Z",
          lastFetchedAt: 200,
          lastIndexSha256: "h4",
        },
      ]);
      expect(deleteRegistry(db, "main")).toBe(true);
      expect(deleteRegistry(db, "main")).toBe(false);
      expect(getRegistry(db, "main")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("insert refuses a duplicate url and a duplicate name", () => {
    const db = freshDb();
    try {
      insertRegistry(db, base);
      let err: unknown;
      try {
        insertRegistry(db, { ...base, name: "other" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as RegistryError).code).toBe("ERR_REGISTRY_EXISTS");
      expect(() => insertRegistry(db, { ...base, url: "https://other.example/" })).toThrow(
        /ERR_REGISTRY_EXISTS/,
      );
    } finally {
      db.close();
    }
  });

  test("extension source round trip; undefined for a local install", () => {
    const db = freshDb();
    try {
      addExt(db, "a");
      addExt(db, "b");
      setExtensionSource(db, "a", { registry: "main", rootFingerprint: "FP", channel: "beta" });
      expect(getExtensionSource(db, "a")).toEqual({
        registry: "main",
        rootFingerprint: "FP",
        channel: "beta",
      });
      expect(getExtensionSource(db, "b")).toBeUndefined();
      expect(getExtensionSource(db, "missing")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("deleteRegistry leaves extension rows and their source columns intact", () => {
    const db = freshDb();
    try {
      insertRegistry(db, base);
      addExt(db, "a");
      setExtensionSource(db, "a", { registry: "main", rootFingerprint: "FP", channel: "stable" });
      deleteRegistry(db, "main");
      expect(getExtensionSource(db, "a")).toEqual({
        registry: "main",
        rootFingerprint: "FP",
        channel: "stable",
      });
    } finally {
      db.close();
    }
  });

  test("listExtensions returns the three source fields (null for a local install)", () => {
    const db = freshDb();
    try {
      addExt(db, "a");
      addExt(db, "b");
      setExtensionSource(db, "a", { registry: "main", rootFingerprint: "FP", channel: "stable" });
      const rows = listExtensions(db);
      expect(rows[0]).toMatchObject({
        id: "a",
        source_registry: "main",
        source_root_fingerprint: "FP",
        source_channel: "stable",
      });
      expect(rows[1]).toMatchObject({
        id: "b",
        source_registry: null,
        source_root_fingerprint: null,
        source_channel: null,
      });
    } finally {
      db.close();
    }
  });

  test("listExtensions reads NULL source below V71", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 70);
      addExt(db, "a");
      expect(listExtensions(db)[0]).toMatchObject({ id: "a", source_registry: null });
    } finally {
      db.close();
    }
  });
});
