import type { Database } from "bun:sqlite";

const VEC_TABLE_RE = /^vec_items_\d+$/;

/**
 * The next free rowid for a `vec_items_<dims>` vec0 table: one past the highest rowid in use, the
 * same value `SELECT MAX(rowid) FROM vec_items_<dims>` gives.
 *
 * That query is not what this reads, because on a vec0 virtual table it is a full scan (measured
 * at 15 ms over 40k vectors, and linear), and both writers call it once per embedded item or per
 * stored session turn, so an embedding backfill was quadratic in the size of the index. vec0 keeps
 * every rowid in a `<table>_rowids` shadow table whose `rowid` is an INTEGER PRIMARY KEY, so its
 * `MAX(rowid)` is a b-tree seek (0.01 ms) and matches the virtual table's own answer, including
 * after a delete.
 *
 * The shadow table is sqlite-vec's storage layout, not a documented interface, so a sqlite-vec that
 * stores rowids differently falls back to the slow query rather than failing the write.
 * `vec-rowid.test.ts` pins the two answers equal against the sqlite-vec version in use.
 */
export function nextVecRowid(db: Database, table: string): number {
  if (!VEC_TABLE_RE.test(table)) {
    throw new Error(`not a vec_items table: ${table}`);
  }
  let row: { m: number | bigint | null } | null;
  try {
    row = db.query(`SELECT MAX(rowid) AS m FROM "${table}_rowids"`).get() as {
      m: number | bigint | null;
    } | null;
  } catch {
    row = db.query(`SELECT MAX(rowid) AS m FROM ${table}`).get() as {
      m: number | bigint | null;
    } | null;
  }
  return Number(row?.m ?? 0) + 1;
}
