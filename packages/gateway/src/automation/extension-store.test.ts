import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  deleteExtensionById,
  getExtensionKind,
  insertExtensionRow,
  isInstalledAsDependency,
  listExtensions,
  selectExtensionInstallPath,
  setExtensionEnabled,
  setExtensionKind,
  setInstalledAsDependency,
  touchExtensionVerifiedAt,
} from "./extension-store.ts";

describe("extension-store", () => {
  test("empty when schema below v10", () => {
    const db = new Database(":memory:");
    expect(listExtensions(db)).toEqual([]);
    expect(setExtensionEnabled(db, "x", true)).toBe(false);
    expect(selectExtensionInstallPath(db, "x")).toBeNull();
    expect(deleteExtensionById(db, "x")).toBeNull();
    touchExtensionVerifiedAt(db, "x", Date.now());
  });

  test("insert list enable delete", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const t = Date.now();
    insertExtensionRow(db, {
      id: "ext.a",
      version: "1.0.0",
      install_path: "/e/ext.a",
      manifest_hash: "aa",
      entry_hash: "bb",
      installed_at: t,
      last_verified_at: t,
    });
    expect(listExtensions(db)).toHaveLength(1);
    expect(selectExtensionInstallPath(db, "ext.a")).toBe("/e/ext.a");
    expect(setExtensionEnabled(db, "ext.a", false)).toBe(true);
    expect(listExtensions(db)[0]?.enabled).toBe(0);
    touchExtensionVerifiedAt(db, "ext.a", t + 1);
    expect(listExtensions(db)[0]?.last_verified_at).toBe(t + 1);
    expect(deleteExtensionById(db, "ext.a")).toBe("/e/ext.a");
    expect(listExtensions(db)).toHaveLength(0);
  });

  test("insertExtensionRow throws below v10", () => {
    const db = new Database(":memory:");
    expect(() =>
      insertExtensionRow(db, {
        id: "x",
        version: "1",
        install_path: "/p",
        manifest_hash: "a",
        entry_hash: "b",
        installed_at: 0,
        last_verified_at: 0,
      }),
    ).toThrow(/v10/);
  });

  test("setInstalledAsDependency round-trips", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    insertExtensionRow(db, {
      id: "ext.dep",
      version: "1.0.0",
      install_path: "/e/ext.dep",
      manifest_hash: "aa",
      entry_hash: "bb",
      installed_at: 1,
      last_verified_at: 1,
    });
    expect(isInstalledAsDependency(db, "ext.dep")).toBe(false);
    setInstalledAsDependency(db, "ext.dep", true);
    expect(isInstalledAsDependency(db, "ext.dep")).toBe(true);
    setInstalledAsDependency(db, "ext.dep", false);
    expect(isInstalledAsDependency(db, "ext.dep")).toBe(false);
  });

  function insertRow(db: Database, id: string, kind?: "extension" | "starter-pack"): void {
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: `/e/${id}`,
      manifest_hash: "aa",
      entry_hash: "bb",
      installed_at: 1,
      last_verified_at: 1,
      ...(kind === undefined ? {} : { kind }),
    });
  }

  test("kind is written at insert, read back by listExtensions and getExtensionKind, and updatable", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    insertRow(db, "ext.code");
    insertRow(db, "ext.pack", "starter-pack");
    expect(listExtensions(db).map((r) => [r.id, r.kind])).toEqual([
      ["ext.code", "extension"],
      ["ext.pack", "starter-pack"],
    ]);
    expect(getExtensionKind(db, "ext.pack")).toBe("starter-pack");
    expect(getExtensionKind(db, "ext.code")).toBe("extension");
    expect(getExtensionKind(db, "ext.none")).toBeUndefined();
    setExtensionKind(db, "ext.pack", "extension");
    expect(getExtensionKind(db, "ext.pack")).toBe("extension");
  });

  test("below V79 every row reads as an extension, and setExtensionKind is a no-op", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 78);
    insertRow(db, "ext.old", "starter-pack");
    expect(listExtensions(db).map((r) => r.kind)).toEqual(["extension"]);
    expect(getExtensionKind(db, "ext.old")).toBe("extension");
    setExtensionKind(db, "ext.old", "starter-pack");
    expect(getExtensionKind(db, "ext.old")).toBe("extension");
    expect(getExtensionKind(new Database(":memory:"), "ext.old")).toBeUndefined();
  });
});
