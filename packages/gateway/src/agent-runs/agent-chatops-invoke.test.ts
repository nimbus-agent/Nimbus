// packages/gateway/src/agent-runs/agent-chatops-invoke.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { buildChatopsAgentInvoker } from "./agent-chatops-invoke.ts";

/** Mirrors `freshDb()` in agent-http-invoke.test.ts / ipc/agents-rpc.test.ts. */
function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("buildChatopsAgentInvoker", () => {
  test("returns the brief markdown from briefReady", async () => {
    const db = freshDb();
    const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 });
    const r = await invoke("glossary", { term: "SLO" });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.markdown).toContain("## Gaps");
  });

  test("works with NO llm configured — the criterion that proves the inversion is fixed", async () => {
    // router: undefined is the same as [agents].synthesis = "off". A deterministic brief must still
    // come back. A slice that only works with a model configured has not delivered this row.
    const db = freshDb();
    const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 });
    expect((await invoke("glossary", { term: "SLO" })).ok).toBe(true);
  });

  test("an excluded agent is refused without dispatching", async () => {
    const db = freshDb();
    const r = await buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 })(
      "premortem",
      {},
    );
    expect(r).toEqual({ ok: false, detail: expect.stringContaining("premortem") });
  });

  test("a validator -32602 comes back as its own message", async () => {
    const db = freshDb();
    const r = await buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 })("expert", {
      topicOrFile: "",
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.detail).toContain("chars after trim");
  });

  test("times out rather than hanging the channel", async () => {
    const db = freshDb();
    const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1 });
    const r = await invoke("huddle", {});
    if (!r.ok) expect(r.detail).toContain("timed out");
  });
});
