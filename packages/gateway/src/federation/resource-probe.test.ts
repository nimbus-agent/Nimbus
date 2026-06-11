import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isValidResourceRef, probeResourceRecency } from "./resource-probe.ts";

function seed(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

test("isValidResourceRef rejects short/empty/wildcard, accepts real refs", () => {
  expect(isValidResourceRef("i-1234567")).toBe(true);
  expect(isValidResourceRef("arn:aws:ec2:us-east-1:1:instance/i-1")).toBe(true);
  expect(isValidResourceRef("123")).toBe(false); // < 4
  expect(isValidResourceRef("a b")).toBe(false); // space
  expect(isValidResourceRef("a%b")).toBe(false); // wildcard
});

test("untouched resource → { touched:false }", () => {
  const db = seed();
  expect(probeResourceRecency(db, { resourceRef: "i-deadbeef" }, () => 1_000_000)).toEqual({
    touched: false,
  });
});

test("touched resource → recency from MAX(modified_at), content-free", () => {
  const db = seed();
  const dayMs = 86_400_000;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES ('x', 'aws', 'note', 'ext-x', 'restart i-deadbeef', 'ssh into i-deadbeef', ?, ?)`,
    [10 * dayMs, 10 * dayMs],
  );
  const now = 13 * dayMs; // 3 days later
  const r = probeResourceRecency(db, { resourceRef: "i-deadbeef" }, () => now);
  expect(r.touched).toBe(true);
  expect(r.lastSeenDaysAgo).toBe(3);
  expect(JSON.stringify(r)).not.toContain("ssh"); // no body leaks
});

test("invalid ref never reports touched (fail-safe)", () => {
  const db = seed();
  expect(probeResourceRecency(db, { resourceRef: "ab" }, () => 1).touched).toBe(false);
});
