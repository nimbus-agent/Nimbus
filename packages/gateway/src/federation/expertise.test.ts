import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { scoreExpertise } from "./expertise.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
});
afterEach(() => db.close());

function insertItem(id: string, title: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES (?, 'github', 'pull_request', ?, ?, ?, 1, 1)`,
    [id, id, title, title],
  );
}

test("returns 'none' when nothing matches", () => {
  const r = scoreExpertise(db, { query: "auth.ts race condition", purpose: "who-knows" });
  expect(r.rank).toBe("none");
  expect(Object.keys(r)).toEqual(["rank"]); // NO item content in the payload
});

test("more matches => higher rank", () => {
  for (let i = 0; i < 12; i++) insertItem(`github:pr${i}`, "fix auth.ts race condition");
  const r = scoreExpertise(db, { query: "auth.ts", purpose: "who-knows" });
  expect(r.rank).toBe("high");
});

test("returns 'medium' for 3-9 matches", () => {
  for (let i = 0; i < 5; i++) insertItem(`github:pr${i}`, "fix auth race condition");
  const r = scoreExpertise(db, { query: "auth race condition", purpose: "who-knows" });
  expect(r.rank).toBe("medium");
});

test("returns 'low' for 1-2 matches", () => {
  insertItem("github:pr0", "fix auth race condition");
  const r = scoreExpertise(db, { query: "auth race condition", purpose: "who-knows" });
  expect(r.rank).toBe("low");
});

test("returns 'none' when every token is shorter than 3 chars", () => {
  insertItem("github:pr0", "fix auth race condition");
  const r = scoreExpertise(db, { query: "a b", purpose: "who-knows" });
  expect(r.rank).toBe("none");
});

test("treats LIKE metacharacters in a token literally (no wildcard probing)", () => {
  insertItem("github:pr0", "auth_ts race"); // literal underscore in content
  insertItem("github:pr1", "authXts race"); // would match if _ were a wildcard
  const r = scoreExpertise(db, { query: "auth_ts", purpose: "who-knows" });
  // Only the literal "auth_ts" row matches -> 1 match -> "low" (not "medium"/2 if _ were a wildcard)
  expect(r.rank).toBe("low");
});
