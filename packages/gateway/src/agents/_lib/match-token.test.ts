import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { resolveMatchToken, symbolExistsLocally } from "./match-token.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("resolveMatchToken", () => {
  it("uses the graph_entity symbol label when one resolves", () => {
    const db = freshDb();
    db.run("INSERT INTO graph_entity (id, type, label, external_id) VALUES (?, 'symbol', ?, ?)", [
      "e1",
      "src/auth.ts",
      "sym:src/auth.ts",
    ]);
    const r = resolveMatchToken(db, "C:\\\\repo\\\\src\\\\auth.ts");
    expect(r.token).toBe("src/auth.ts");
    expect(r.entityId).toBe("e1");
    db.close();
  });

  it("resolves via the exact label branch when fileArg equals a stored label", () => {
    const db = freshDb();
    db.run("INSERT INTO graph_entity (id, type, label, external_id) VALUES (?, 'symbol', ?, ?)", [
      "e2",
      "src/auth.ts",
      "sym:src/auth.ts",
    ]);
    const r = resolveMatchToken(db, "src/auth.ts");
    expect(r.token).toBe("src/auth.ts");
    expect(r.entityId).toBe("e2");
    db.close();
  });

  it("falls back to the basename when no entity resolves", () => {
    const db = freshDb();
    const r = resolveMatchToken(db, "/Users/bob/project/src/auth.ts");
    expect(r.token).toBe("auth.ts");
    expect(r.entityId).toBeNull();
    db.close();
  });
});

describe("symbolExistsLocally", () => {
  it("is true when a matching symbol exists, false otherwise", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e1','symbol','src/auth.ts','x')",
    );
    expect(symbolExistsLocally(db, "src/auth.ts")).toBe(true);
    expect(symbolExistsLocally(db, "gone.ts")).toBe(false);
    db.close();
  });
});
