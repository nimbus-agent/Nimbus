import { describe, expect, test } from "bun:test";
import { bagEmbed, captureLlm, makeMemory, migratedDb } from "./episodic.test-helpers.ts";
import { PENDING_TEXT_MAX, PENDING_TURNS_PER_SESSION_MAX, SUMMARY_MAX } from "./episodic-store.ts";

function storeOf() {
  const db = migratedDb();
  return { db, ...makeMemory({ db, llm: captureLlm(null) }) };
}

type Store = ReturnType<typeof storeOf>["store"];

function finish(store: Store, name: string, now: number, embedding: Float32Array | null) {
  return store.finishSession({
    sessionId: name,
    summary: name,
    turnCount: 1,
    startedAt: 1,
    endedAt: 1,
    now,
    embedding,
  });
}

describe("EpisodicStore", () => {
  test("records turns, trims text, and keeps only the newest turns of a session", () => {
    const { store } = storeOf();
    for (let i = 0; i < PENDING_TURNS_PER_SESSION_MAX + 5; i++) {
      store.recordTurn(
        "s",
        { ownerText: `q${i}`, answerText: "x".repeat(PENDING_TEXT_MAX + 50) },
        i,
      );
    }
    const turns = store.pendingTurns("s");
    expect(turns).toHaveLength(PENDING_TURNS_PER_SESSION_MAX);
    expect(turns[0]?.ownerText).toBe("q5");
    expect(turns[0]?.answerText).toHaveLength(PENDING_TEXT_MAX);
    store.recordTurn("t", { ownerText: "other", answerText: "a" }, 1);
    expect(store.pendingTurns("t")).toHaveLength(1);
  });

  test("idleSessions finds sessions whose newest turn is older than the cutoff, oldest first", () => {
    const { store } = storeOf();
    store.recordTurn("old", { ownerText: "a", answerText: "b" }, 10);
    store.recordTurn("mid", { ownerText: "a", answerText: "b" }, 20);
    store.recordTurn("mid", { ownerText: "a", answerText: "b" }, 90);
    store.recordTurn("new", { ownerText: "a", answerText: "b" }, 100);
    expect(store.idleSessions(50, 10)).toEqual(["old"]);
    expect(store.idleSessions(95, 10)).toEqual(["old", "mid"]);
    expect(store.idleSessions(1000, 1)).toEqual(["old"]);
  });

  test("finishSession stores the summary, drops the pending turns and caps the summary", () => {
    const { store } = storeOf();
    store.recordTurn("s", { ownerText: "a", answerText: "b" }, 5);
    const id = store.finishSession({
      sessionId: "s",
      summary: "z".repeat(SUMMARY_MAX + 10),
      turnCount: 1,
      startedAt: 5,
      endedAt: 5,
      now: 9,
      embedding: bagEmbed("hello"),
    });
    expect(id).toMatch(/^mem_[0-9a-f]{16}$/);
    expect(store.pendingTurns("s")).toEqual([]);
    const [m] = store.list(10);
    expect(m?.summary).toHaveLength(SUMMARY_MAX);
    expect(m?.embedded).toBe(true);
    expect(store.count()).toBe(1);
  });

  test("recall ranks by cosine, honours the floor and topK, and skips rows with no vector", () => {
    const { store } = storeOf();
    finish(store, "deploy pipeline rollback", 1, bagEmbed("deploy pipeline rollback"));
    finish(store, "lunch plans for friday", 2, bagEmbed("lunch plans for friday"));
    finish(store, "no vector here deploy", 3, null);
    const hits = store.recall(bagEmbed("deploy rollback pipeline"), 3, 0.35);
    expect(hits.map((h) => h.summary)).toEqual(["deploy pipeline rollback"]);
    expect(hits[0]?.similarity).toBeGreaterThan(0.9);
    expect(store.recall(bagEmbed("deploy"), 1, 0).length).toBe(1);
    // A vector of another length is skipped, never compared.
    expect(store.recall(new Float32Array(8), 3, -1)).toEqual([]);
  });

  test("forget, forgetAll and pruneOlderThan remove memories and pending turns", () => {
    const { store } = storeOf();
    const a = finish(store, "a", 10, null);
    finish(store, "b", 50, null);
    store.recordTurn("p1", { ownerText: "x", answerText: "y" }, 5);
    store.recordTurn("p2", { ownerText: "x", answerText: "y" }, 60);
    expect(store.pruneOlderThan(30)).toBe(1);
    expect(store.count()).toBe(1);
    expect(store.pendingTurns("p1")).toEqual([]);
    expect(store.pendingTurns("p2")).toHaveLength(1);
    expect(store.forget(a)).toBe(false);
    expect(store.forgetAll()).toBe(1);
    expect(store.count()).toBe(0);
    expect(store.pendingCount()).toBe(0);
    store.recordTurn("p3", { ownerText: "x", answerText: "y" }, 1);
    store.dropAllPending();
    expect(store.pendingCount()).toBe(0);
    store.recordTurn("p4", { ownerText: "x", answerText: "y" }, 1);
    store.dropPending("p4");
    expect(store.pendingCount()).toBe(0);
  });
});
