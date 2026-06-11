import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

test("agents.janitor returns a sessionId and emits janitor.briefReady", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const seen: string[] = [];
  const out = await dispatchAgentsRpc(
    "agents.janitor",
    { resourceRef: "i-12345", idleDays: 7 },
    { db, notify: (m) => seen.push(m) },
  );
  expect(out.kind).toBe("hit");
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toContain("janitor.briefReady");
});

test("agents.janitor rejects a missing resourceRef", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  await expect(dispatchAgentsRpc("agents.janitor", {}, { db, notify: () => {} })).rejects.toThrow();
});
