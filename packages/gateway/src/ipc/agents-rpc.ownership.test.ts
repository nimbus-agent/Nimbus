import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function makeCtx(db: Database) {
  return { db, notify: () => {} };
}

describe("dispatchAgentsRpc — agents.ownership", () => {
  test("accepts an empty payload (summary mode)", async () => {
    const out = await dispatchAgentsRpc("agents.ownership", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
  });

  test("accepts a path", async () => {
    const out = await dispatchAgentsRpc(
      "agents.ownership",
      { path: "src/a.ts" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("accepts a service", async () => {
    const out = await dispatchAgentsRpc(
      "agents.ownership",
      { service: "checkout" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("rejects path and service together", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.ownership",
        { path: "src/a.ts", service: "checkout" },
        makeCtx(freshDb()),
      ),
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("rejects a non-string path", async () => {
    await expect(
      dispatchAgentsRpc("agents.ownership", { path: 5 }, makeCtx(freshDb())),
    ).rejects.toThrow(/-?32602|path must be/);
  });

  test("rejects an over-length path", async () => {
    await expect(
      dispatchAgentsRpc("agents.ownership", { path: "x".repeat(2049) }, makeCtx(freshDb())),
    ).rejects.toThrow();
  });

  test("rejects an over-length service", async () => {
    await expect(
      dispatchAgentsRpc("agents.ownership", { service: "s".repeat(65) }, makeCtx(freshDb())),
    ).rejects.toThrow();
  });
});
