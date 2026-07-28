import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";

import { dispatchIndexDemoSymbolRpc, IndexDemoSymbolRpcError } from "./index-demo-symbol-rpc.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("CREATE TABLE item (id TEXT PRIMARY KEY, metadata TEXT)");
  db.run(
    "CREATE TABLE graph_entity (id TEXT PRIMARY KEY, external_id TEXT, type TEXT, label TEXT, metadata TEXT)",
  );
  db.run("INSERT INTO item (id, metadata) VALUES ('i1', ?)", [
    JSON.stringify({ excerptStartLine: 42 }),
  ]);
  db.run(
    "INSERT INTO graph_entity (id, external_id, type, label, metadata) VALUES ('ge:i1','i1','symbol',?,?)",
    [
      "verifyToken — src/auth.ts",
      JSON.stringify({ file: "src/auth.ts", repoRoot: resolve("/repo"), name: "verifyToken" }),
    ],
  );
});

test("returns the symbol for a configured root", async () => {
  const out = await dispatchIndexDemoSymbolRpc("index.demoSymbol", { repoRoot: "/repo" }, { db });
  expect(out).toEqual({
    kind: "hit",
    value: { file: "src/auth.ts", line: 42, name: "verifyToken" },
  });
});

test("returns a hit carrying null when the root has no symbols", async () => {
  // A miss would fall through to the next dispatcher and surface as
  // METHOD_NOT_FOUND; "no demo symbol yet" must be a successful null instead.
  const out = await dispatchIndexDemoSymbolRpc("index.demoSymbol", { repoRoot: "/other" }, { db });
  expect(out).toEqual({ kind: "hit", value: null });
});

test("misses on an unrelated method", async () => {
  const out = await dispatchIndexDemoSymbolRpc("index.regraph", { repoRoot: "/repo" }, { db });
  expect(out).toEqual({ kind: "miss" });
});

for (const bad of [undefined, null, [], {}, { repoRoot: "" }, { repoRoot: 3 }]) {
  test(`rejects invalid params with -32602: ${JSON.stringify(bad) ?? "undefined"}`, async () => {
    const thrown = await dispatchIndexDemoSymbolRpc("index.demoSymbol", bad, { db }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(IndexDemoSymbolRpcError);
    expect((thrown as IndexDemoSymbolRpcError).rpcCode).toBe(-32602);
  });
}
