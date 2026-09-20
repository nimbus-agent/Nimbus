import { describe, expect, test } from "bun:test";
import { bindAliases } from "./alias-binding.ts";

describe("bindAliases", () => {
  test("binds FROM and JOIN aliases", () => {
    const m = bindAliases("SELECT 1 FROM item i JOIN graph_entity e ON e.id = i.id");
    expect(m.get("i")).toBe("item");
    expect(m.get("e")).toBe("graph_entity");
    expect(m.get("item")).toBe("item");
  });

  test("resolves a CTE to the table it selects from", () => {
    const sql =
      "WITH ranked AS (SELECT id, metadata FROM item WHERE type = 'ci_run') SELECT * FROM ranked WHERE rn = 1";
    expect(bindAliases(sql).get("ranked")).toBe("item");
  });

  test("ignores an unknown table", () => {
    expect(bindAliases("SELECT 1 FROM sqlite_master m").get("m")).toBeUndefined();
  });

  test("binds the AS keyword form of an alias", () => {
    const m = bindAliases("SELECT 1 FROM item AS i JOIN graph_relation AS r ON r.id = i.id");
    expect(m.get("i")).toBe("item");
    expect(m.get("r")).toBe("graph_relation");
  });

  test("never binds a reserved word as an alias", () => {
    const m = bindAliases("SELECT 1 FROM item WHERE service IN (__INTERP__)");
    expect(m.get("WHERE")).toBeUndefined();
    expect(m.get("where")).toBeUndefined();
    expect(m.get("item")).toBe("item");
  });

  test("resolves an alias trailing an already-bound CTE name", () => {
    const sql = "WITH ranked AS (SELECT id FROM item) SELECT * FROM ranked r WHERE r.id = 1";
    const m = bindAliases(sql);
    expect(m.get("ranked")).toBe("item");
    expect(m.get("r")).toBe("item");
  });

  test("resolves a CTE that selects from a nested CTE", () => {
    const sql =
      "WITH base AS (SELECT id FROM graph_entity), wrapped AS (SELECT id FROM base) SELECT * FROM wrapped";
    const m = bindAliases(sql);
    expect(m.get("base")).toBe("graph_entity");
    expect(m.get("wrapped")).toBe("graph_entity");
  });

  test("a CTE body that never resolves to a tracked table binds nothing", () => {
    const sql = "WITH x AS (SELECT id FROM sqlite_master) SELECT * FROM x";
    const m = bindAliases(sql);
    expect(m.get("x")).toBeUndefined();
  });

  test("the real preflight.ts CTE resolves ranked to item", () => {
    const sql = `
    WITH ranked AS (
      SELECT
        id, service, type, title, url, modified_at, metadata,
        ROW_NUMBER() OVER (
          PARTITION BY service, COALESCE(
            json_extract(metadata, '$.workflow_name'),
            title,
            COALESCE(json_extract(metadata, '$.headSha'), '') || ':' || COALESCE(json_extract(metadata, '$.branch'), '')
          )
          ORDER BY modified_at DESC
        ) AS rn
      FROM item
      WHERE service IN (__INTERP__)
        AND type = 'ci_run'
        AND json_extract(metadata, '$.branch') = ?
        AND json_extract(metadata, '$.conclusion') IN (__INTERP__)
    )
    SELECT id, title, url, modified_at, metadata FROM ranked WHERE rn = 1
  `;
    expect(bindAliases(sql).get("ranked")).toBe("item");
  });
});
