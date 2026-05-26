import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import {
  deleteExtensionById,
  insertExtensionRow,
  listExtensions,
  selectExtensionInstallPath,
  setExtensionEnabled,
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
    expect(listExtensions(db).length).toBe(1);
    expect(selectExtensionInstallPath(db, "ext.a")).toBe("/e/ext.a");
    expect(setExtensionEnabled(db, "ext.a", false)).toBe(true);
    expect(listExtensions(db)[0]?.enabled).toBe(0);
    touchExtensionVerifiedAt(db, "ext.a", t + 1);
    expect(listExtensions(db)[0]?.last_verified_at).toBe(t + 1);
    expect(deleteExtensionById(db, "ext.a")).toBe("/e/ext.a");
    expect(listExtensions(db).length).toBe(0);
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
});
