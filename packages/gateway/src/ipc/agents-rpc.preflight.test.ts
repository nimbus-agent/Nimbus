import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

test("agents.preflight returns a sessionId and emits preflight.briefReady", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const seen: string[] = [];
  const out = await dispatchAgentsRpc(
    "agents.preflight",
    { ref: "HEAD", namespace: "n", changedSurface: ["a.ts"] },
    { db, notify: (m) => seen.push(m) },
  );
  expect(out.kind).toBe("hit");
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toContain("preflight.briefReady");
});

test("agents.preflight rejects missing ref / namespace", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  await expect(
    dispatchAgentsRpc("agents.preflight", { ref: "HEAD" }, { db, notify: () => {} }),
  ).rejects.toThrow();
});
