import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pickDemoSymbol } from "./demo-symbol.ts";

let db: Database;

/**
 * Mirrors what filesystem-v2-sync + graph-populator actually write:
 * `metadata.file` is ROOT-RELATIVE (graph-populator joins it onto repoRoot),
 * `metadata.repoRoot` is already `resolve()`d (parseNimbusTomlFilesystemRoots
 * expands every root before sync ever sees it), `graph_entity.id` is TEXT (not
 * an autoincrement integer), and the label is `"<name> — <file>"`.
 */
function seedSymbol(
  id: string,
  file: string,
  repoRoot: string,
  name: string,
  line: number | null,
): void {
  const meta: Record<string, unknown> = {};
  if (line !== null) {
    meta["excerptStartLine"] = line;
  }
  db.run("INSERT INTO item (id, metadata) VALUES (?, ?)", [id, JSON.stringify(meta)]);
  db.run(
    "INSERT INTO graph_entity (id, external_id, type, label, metadata) VALUES (?, ?, ?, ?, ?)",
    [
      `ge:${id}`,
      id,
      "symbol",
      `${name} — ${file}`,
      JSON.stringify({ file, repoRoot: resolve(repoRoot), name }),
    ],
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run("CREATE TABLE item (id TEXT PRIMARY KEY, metadata TEXT)");
  db.run(
    "CREATE TABLE graph_entity (id TEXT PRIMARY KEY, external_id TEXT, type TEXT, label TEXT, metadata TEXT)",
  );
});

test("returns a root-relative symbol location under the requested repo root", () => {
  seedSymbol("i1", "src/auth.ts", "/repo", "verifyToken", 42);
  expect(pickDemoSymbol(db, "/repo")).toEqual({
    file: "src/auth.ts",
    line: 42,
    name: "verifyToken",
  });
});

test("ignores symbols belonging to a different repo root", () => {
  seedSymbol("i1", "src/x.ts", "/other", "somethingElse", 7);
  expect(pickDemoSymbol(db, "/repo")).toBeNull();
});

test("matches the root regardless of separator style or trailing slash", () => {
  // The caller may hand over the raw nimbus.toml spelling while the index holds
  // the resolved one. Plain string equality would miss and init would silently
  // print no demo line.
  seedSymbol("i1", "src/auth.ts", "/repo", "verifyToken", 42);
  expect(pickDemoSymbol(db, "/repo/")?.name).toBe("verifyToken");
});

test("skips a symbol with no usable start line rather than returning line 0", () => {
  seedSymbol("i1", "a.ts", "/repo", "noLine", null);
  seedSymbol("i2", "b.ts", "/repo", "hasLine", 10);
  expect(pickDemoSymbol(db, "/repo")?.name).toBe("hasLine");
});

test("prefers the shortest label so the suggestion is a plain name", () => {
  seedSymbol("i1", "src/deeply/nested/module.ts", "/repo", "aVeryLongSymbolName", 5);
  seedSymbol("i2", "app.ts", "/repo", "main", 3);
  expect(pickDemoSymbol(db, "/repo")?.name).toBe("main");
});

test("returns null on an empty index instead of throwing", () => {
  expect(pickDemoSymbol(db, "/repo")).toBeNull();
});

test("returns null when the graph tables are absent instead of throwing", () => {
  // `init` runs against a gateway whose index may predate the graph migration;
  // a throw here would turn a cosmetic suggestion into a failed command.
  const bare = new Database(":memory:");
  expect(pickDemoSymbol(bare, "/repo")).toBeNull();
});
