import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { LocalIndex } from "../local-index.ts";

test("V40 seeds the lineage relation types", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const names = db
    .query<{ name: string }, []>("SELECT name FROM graph_relation_type")
    .all()
    .map((r) => r.name);
  expect(names).toContain("upstream_refs");
  expect(names).toContain("derived_from");
  expect(names).toContain("monitors");
});
