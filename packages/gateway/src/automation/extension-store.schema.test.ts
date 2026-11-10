/** `extension-store.ts` at older schema versions: each column is read and written only where it exists. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  getExtensionKind,
  insertExtensionRow,
  isInstalledAsDependency,
  listExtensions,
  listInstalledAsDependencyIds,
  selectExtensionVersion,
  setExtensionPublisherKeyFingerprint,
  setExtensionTreeDigest,
  setInstalledAsDependency,
  updateExtensionRowVersion,
} from "./extension-store.ts";

function dbAt(version: number): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, version);
  return db;
}

const ROW = {
  id: "ext.a",
  version: "1.0.0",
  install_path: "/e/ext.a",
  manifest_hash: "aa",
  entry_hash: "bb",
  installed_at: 1,
  last_verified_at: 1,
};

describe("insert and list at each schema generation", () => {
  test("before V66 there is no tree digest: listed as null, setting one throws", () => {
    const db = dbAt(65);
    insertExtensionRow(db, ROW);
    expect(listExtensions(db)[0]).toMatchObject({
      id: "ext.a",
      tree_digest: null,
      source_registry: null,
      publisher_key_fingerprint: null,
      kind: "extension",
    });
    expect(() => setExtensionTreeDigest(db, "ext.a", "d")).toThrow("schema v66+");
    // The update statement must not name a column the schema lacks.
    expect(updateExtensionRowVersion(db, "ext.a", "1.1.0", "m2", "e2", 5)).toBe(true);
    expect(listExtensions(db)[0]).toMatchObject({ version: "1.1.0", manifest_hash: "m2" });
    expect(updateExtensionRowVersion(db, "ext.missing", "1", "m", "e", 1)).toBe(false);
    db.close();
  });

  test("at V66 a digest is stored at insert and cleared by a version change unless passed", () => {
    const db = dbAt(66);
    insertExtensionRow(db, { ...ROW, tree_digest: "digest-1" });
    expect(listExtensions(db)[0]?.tree_digest).toBe("digest-1");
    expect(listExtensions(db)[0]?.kind).toBe("extension");
    updateExtensionRowVersion(db, "ext.a", "1.1.0", "m2", "e2", 5);
    expect(listExtensions(db)[0]?.tree_digest).toBeNull();
    updateExtensionRowVersion(db, "ext.a", "1.2.0", "m3", "e3", 6, "digest-3");
    expect(listExtensions(db)[0]?.tree_digest).toBe("digest-3");
    expect(setExtensionTreeDigest(db, "ext.a", "digest-4")).toBe(true);
    expect(setExtensionTreeDigest(db, "ext.none", "x")).toBe(false);
    expect(selectExtensionVersion(db, "ext.a")).toBe("1.2.0");
    expect(selectExtensionVersion(db, "ext.none")).toBeNull();
    db.close();
  });

  test("the publisher key fingerprint needs V76 and is stored from there", () => {
    const old = dbAt(75);
    insertExtensionRow(old, ROW);
    expect(() => setExtensionPublisherKeyFingerprint(old, "ext.a", "fp")).toThrow("schema v76+");
    old.close();
    const db = dbAt(77);
    insertExtensionRow(db, ROW);
    expect(setExtensionPublisherKeyFingerprint(db, "ext.a", "fp")).toBe(true);
    expect(listExtensions(db)[0]?.publisher_key_fingerprint).toBe("fp");
    expect(setExtensionPublisherKeyFingerprint(db, "ext.a", null)).toBe(true);
    expect(setExtensionPublisherKeyFingerprint(db, "ext.none", "fp")).toBe(false);
    db.close();
  });
});

describe("the dependency marker before V78", () => {
  test("is absent: reads are empty or false and a write throws", () => {
    const db = dbAt(77);
    insertExtensionRow(db, ROW);
    expect(listInstalledAsDependencyIds(db)).toEqual([]);
    expect(isInstalledAsDependency(db, "ext.a")).toBe(false);
    expect(() => setInstalledAsDependency(db, "ext.a", true)).toThrow("schema v78+");
    db.close();
  });

  test("from V78 the marked ids are listed sorted", () => {
    const db = dbAt(78);
    insertExtensionRow(db, { ...ROW, id: "ext.b" });
    insertExtensionRow(db, ROW);
    setInstalledAsDependency(db, "ext.b", true);
    setInstalledAsDependency(db, "ext.a", true);
    expect(listInstalledAsDependencyIds(db)).toEqual(["ext.a", "ext.b"]);
    setInstalledAsDependency(db, "ext.a", false);
    expect(listInstalledAsDependencyIds(db)).toEqual(["ext.b"]);
    expect(isInstalledAsDependency(db, "ext.none")).toBe(false);
    db.close();
  });
});

describe("below V10", () => {
  test("every accessor is inert", () => {
    const db = new Database(":memory:");
    expect(getExtensionKind(db, "x")).toBeUndefined();
    expect(selectExtensionVersion(db, "x")).toBeNull();
    expect(updateExtensionRowVersion(db, "x", "1", "m", "e", 1)).toBe(false);
    db.close();
  });
});
