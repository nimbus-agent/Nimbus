import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

function makeCtx(db: Database) {
  return {
    db,
    notify: mock(() => {}),
  };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("dispatchAgentsRpc — agents.glossary", () => {
  test("returns a sessionId with no argument", async () => {
    const out = await dispatchAgentsRpc("agents.glossary", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
  });

  test("accepts a term", async () => {
    const out = await dispatchAgentsRpc("agents.glossary", { term: "CDR" }, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
  });

  test("rejects a non-string term", async () => {
    await expect(
      dispatchAgentsRpc("agents.glossary", { term: 5 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects a non-positive limit", async () => {
    await expect(
      dispatchAgentsRpc("agents.glossary", { limit: 0 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });
});
