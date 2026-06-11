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
    const r = resolveMatchToken(db, "C:\\\\repo\\\\src\\\\auth.ts"); // cross-platform-ok
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
    const r = resolveMatchToken(db, "/Users/bob/project/src/auth.ts"); // cross-platform-ok
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

describe("LIKE wildcard escaping", () => {
  it("underscore in stored label is NOT matched by a token with a different char in its place", () => {
    const db = freshDb();
    // Store a label with a literal underscore.
    db.run(
      "INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e1','symbol','src/a_b.ts','x')",
    );
    // 'src/aXb.ts' must NOT match 'src/a_b.ts' — the _ must be treated as literal.
    expect(symbolExistsLocally(db, "src/aXb.ts")).toBe(false);
    // 'a_b.ts' must match — the same literal underscore is present in both.
    expect(symbolExistsLocally(db, "a_b.ts")).toBe(true);
    db.close();
  });

  it("resolveMatchToken basename with underscore resolves the correct entity, not a wildcard-over-match", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e1','symbol','src/a_b.ts','sym1')",
    );
    db.run(
      "INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e2','symbol','src/aXb.ts','sym2')",
    );
    // Resolving from a path whose basename is 'a_b.ts' must pick entity e1, not e2.
    // (Before the fix, '_' acted as a wildcard and the ORDER BY length/id tie-break made the
    // result non-deterministic across those two rows.)
    const r = resolveMatchToken(db, "project/src/a_b.ts"); // cross-platform-ok
    expect(r.token).toBe("src/a_b.ts");
    expect(r.entityId).toBe("e1");
    db.close();
  });
});
