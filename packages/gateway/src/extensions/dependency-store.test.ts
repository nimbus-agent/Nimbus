import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { clearDeps, forwardDeps, recordInstall, reverseDeps } from "./dependency-store.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 31);
});
afterEach(() => {
  db.close();
});

describe("dependency-store", () => {
  it("recordInstall + forwardDeps round-trip", () => {
    recordInstall(
      db,
      "com.example.foo",
      "1.0.0",
      [
        { id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" },
        { id: "com.shared.crypto", range: "^2.0.0", resolvedVersion: "2.4.1" },
      ],
      1_700_000_000_000,
    );
    const fwd = forwardDeps(db, "com.example.foo");
    expect(fwd).toHaveLength(2);
    expect(fwd.map((d) => d.id).sort()).toEqual(["com.shared.crypto", "com.shared.utils"]);
    expect(fwd.find((d) => d.id === "com.shared.utils")?.range).toBe("^1.0.0");
  });

  it("reverseDeps lists every dependent of an id", () => {
    recordInstall(
      db,
      "com.example.foo",
      "1.0.0",
      [{ id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" }],
      1,
    );
    recordInstall(
      db,
      "com.example.bar",
      "2.0.0",
      [{ id: "com.shared.utils", range: "^1.2.0", resolvedVersion: "1.5.0" }],
      2,
    );
    const rev = reverseDeps(db, "com.shared.utils");
    expect(rev.map((r) => r.extensionId).sort()).toEqual(["com.example.bar", "com.example.foo"]);
    expect(rev.find((r) => r.extensionId === "com.example.bar")?.range).toBe("^1.2.0");
  });

  it("clearDeps removes only rows for the given extension", () => {
    recordInstall(
      db,
      "com.example.foo",
      "1.0.0",
      [{ id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" }],
      1,
    );
    recordInstall(
      db,
      "com.example.bar",
      "2.0.0",
      [{ id: "com.shared.utils", range: "^1.2.0", resolvedVersion: "1.5.0" }],
      2,
    );
    clearDeps(db, "com.example.foo");
    expect(forwardDeps(db, "com.example.foo")).toHaveLength(0);
    expect(forwardDeps(db, "com.example.bar")).toHaveLength(1);
  });

  it("recordInstall is idempotent on PRIMARY KEY conflict (no throw, last write wins)", () => {
    recordInstall(
      db,
      "com.example.foo",
      "1.0.0",
      [{ id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" }],
      1,
    );
    recordInstall(
      db,
      "com.example.foo",
      "1.0.0",
      [{ id: "com.shared.utils", range: "^1.2.0", resolvedVersion: "1.5.0" }],
      2,
    );
    const fwd = forwardDeps(db, "com.example.foo");
    expect(fwd).toHaveLength(1);
    expect(fwd[0]?.range).toBe("^1.2.0");
  });
});
