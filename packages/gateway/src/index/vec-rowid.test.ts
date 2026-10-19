import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "./local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "./sqlite-vec-load.ts";
import { nextVecRowid } from "./vec-rowid.ts";

function vecDb(): Database | null {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  if (!isVecLoaded(db)) {
    db.close();
    return null;
  }
  LocalIndex.ensureSchema(db);
  return db;
}
const VEC = (() => {
  const db = vecDb();
  db?.close();
  return db !== null;
})();

describe("nextVecRowid", () => {
  test.skipIf(!VEC)("matches MAX(rowid)+1 of the virtual table, empty and after a delete", () => {
    const db = vecDb();
    if (db === null) throw new Error("unreachable");
    const slow = (): number =>
      Number(
        (db.query("SELECT MAX(rowid) AS m FROM vec_items_384").get() as { m: number | null }).m ??
          0,
      ) + 1;
    expect(nextVecRowid(db, "vec_items_384")).toBe(1);
    const ins = db.prepare("INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))");
    for (const id of [1, 2, 7]) ins.run(BigInt(id), new Float32Array(384));
    ins.finalize();
    expect(nextVecRowid(db, "vec_items_384")).toBe(8);
    expect(nextVecRowid(db, "vec_items_384")).toBe(slow());
    db.run("DELETE FROM vec_items_384 WHERE rowid = 7");
    expect(nextVecRowid(db, "vec_items_384")).toBe(slow());
    expect(nextVecRowid(db, "vec_items_384")).toBe(3);
    db.close();
  });

  test("falls back to the table's own MAX(rowid) when there is no shadow rowid table", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE vec_items_8 (x INTEGER)");
    db.run("INSERT INTO vec_items_8(rowid, x) VALUES (41, 0)");
    expect(nextVecRowid(db, "vec_items_8")).toBe(42);
    db.close();
  });

  test("refuses a table name that is not vec_items_<dims>", () => {
    const db = new Database(":memory:");
    expect(() => nextVecRowid(db, "item; DROP TABLE item")).toThrow(/not a vec_items table/);
    db.close();
  });
});
