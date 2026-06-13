import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

test("V39 creates tribal_clusters with the expected columns", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 39);
  const cols = (db.query("PRAGMA table_info(tribal_clusters)").all() as { name: string }[]).map(
    (r) => r.name,
  );
  for (const c of [
    "cluster_id",
    "representative_question",
    "representative_vec",
    "occurrence_count",
    "first_seen",
    "last_seen",
    "status",
    "channel_id",
    "platform",
    "suggested_at",
    "cooldown_until",
    "captured_page_ref",
  ]) {
    expect(cols).toContain(c);
  }
});

test("V39 is idempotent", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 39);
  runIndexedSchemaMigrations(db, 39);
  expect(db.query("SELECT count(*) AS n FROM tribal_clusters").get()).toEqual({ n: 0 });
});
