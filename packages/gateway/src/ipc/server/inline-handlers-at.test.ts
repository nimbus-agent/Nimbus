import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { agentRequestContext } from "../../engine/agent-request-context.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ClientSession } from "../session.ts";
import type { ServerCtx } from "./context.ts";
import { dispatchAgentInvoke, rpcIndexSearchRanked } from "./inline-handlers.ts";

function makeIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

function makeCtx(localIndex: LocalIndex): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "0.0.0-test", localIndex },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now() - 5_000,
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined as never,
    getClientKind: () => "unknown",
  };
}

// Instants far in the past of the real clock, so `at` never trips the future check.
const BASE = Date.UTC(2026, 0, 1);
const AT = "2026-01-01T00:00:01Z"; // BASE + 1000 ms

function seedPrs(idx: LocalIndex): void {
  const put = (ext: string, title: string, opened: number, at: number): void =>
    upsertIndexedItem(idx.rawDb, {
      service: "github",
      type: "pr",
      externalId: ext,
      title,
      modifiedAt: at,
      syncedAt: at,
      metadata: { state: "open", opened_at_ms: opened },
    });
  put("seed", "unrelated", BASE - 10, BASE);
  put("old", "payment-service retry", BASE + 100, BASE + 200);
  put("late", "payment-service rewrite", BASE + 1200, BASE + 1300);
}

describe("rpcIndexSearchRanked - at (Phase 10 IC1)", () => {
  test("with envelope the answer is as of T, carries asOf, and the disclosure joins the notes", async () => {
    const idx = makeIndex();
    seedPrs(idx);
    const r = (await rpcIndexSearchRanked(makeCtx(idx), {
      name: "payment-service",
      at: AT,
      envelope: true,
    })) as {
      items: Array<{ id: string; asOf?: unknown }>;
      notes: string[];
      asOf: { atMs: number; zone: string; historyStartMs: number | null; gapCount: number };
    };
    expect(r.items.map((i) => i.id)).toEqual(["old"]);
    expect(r.items[0]?.asOf).toBeDefined();
    expect(r.asOf.atMs).toBe(BASE + 1000);
    expect(r.asOf.historyStartMs).toBe(BASE);
    expect(r.asOf.gapCount).toBe(0);
    expect(r.notes.some((n) => n.startsWith("As of 2026-01-01T00:00:01.000Z"))).toBe(true);
    expect(r.notes).toContain("## Gaps");
  });

  test("a keyword gap is counted in the disclosure", async () => {
    const idx = makeIndex();
    seedPrs(idx);
    idx.rawDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES ('github:gap', 'github', 'review', 'gap', 'payment-service flaky', ?, 1, '{}')`,
      [BASE + 1100],
    );
    const r = (await rpcIndexSearchRanked(makeCtx(idx), {
      name: "payment-service",
      at: AT,
      envelope: true,
    })) as { items: Array<{ id: string }>; asOf: { gapCount: number }; notes: string[] };
    expect(r.items.map((i) => i.id)).toEqual(["old"]);
    expect(r.asOf.gapCount).toBe(1);
    expect(r.notes.join("\n")).toContain("1 item could not be placed");
  });

  test("a browse (no name) answers as of T too, and an unmatchable name has no gaps", async () => {
    const idx = makeIndex();
    seedPrs(idx);
    const browse = (await rpcIndexSearchRanked(makeCtx(idx), {
      service: "github",
      at: AT,
      envelope: true,
    })) as { items: Array<{ id: string }> };
    expect(browse.items.map((i) => i.id).sort()).toEqual(["old", "seed"]);
    const none = (await rpcIndexSearchRanked(makeCtx(idx), {
      name: "!!!",
      at: AT,
      envelope: true,
    })) as { items: unknown[]; asOf: { gapCount: number } };
    expect(none.items).toEqual([]);
    expect(none.asOf.gapCount).toBe(0);
  });

  test("at without envelope is refused with -32602", async () => {
    const ctx = makeCtx(makeIndex());
    await expect(rpcIndexSearchRanked(ctx, { name: "x", at: AT })).rejects.toMatchObject({
      rpcCode: -32602,
    });
    await expect(rpcIndexSearchRanked(ctx, { name: "x", at: AT, envelope: "yes" })).rejects.toThrow(
      /envelope/,
    );
  });

  test("a bad, non-string or future at is refused with -32602", async () => {
    const ctx = makeCtx(makeIndex());
    for (const at of ["last tuesday", "", 5, "2999-01-01T00:00Z"]) {
      await expect(
        rpcIndexSearchRanked(ctx, { name: "x", at, envelope: true }),
      ).rejects.toMatchObject({ rpcCode: -32602 });
    }
  });

  test("no at: the response keeps its shape (no asOf key) and the bare array is unchanged", async () => {
    const ctx = makeCtx(makeIndex());
    const r = (await rpcIndexSearchRanked(ctx, { name: "alpha", envelope: true })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(r).sort()).toEqual(["items", "notes", "retrieval"]);
    expect(Array.isArray(await rpcIndexSearchRanked(ctx, { name: "alpha" }))).toBe(true);
  });
});

describe("dispatchAgentInvoke - at (Phase 10 IC1)", () => {
  const session = { writeNotification: () => {} } as unknown as ClientSession;

  function ctxWithHandler(handler: (p: unknown) => Promise<{ reply: string }>): ServerCtx {
    const ctx = makeCtx(makeIndex());
    return { ...ctx, getAgentInvokeHandler: () => handler as never };
  }

  test("a usable at puts pointInTimeMs on the payload and the request store", async () => {
    let payload: Record<string, unknown> | undefined;
    let storeAt: number | undefined;
    const ctx = ctxWithHandler(async (p) => {
      payload = p as Record<string, unknown>;
      storeAt = agentRequestContext.getStore()?.pointInTimeMs;
      return { reply: "ok" };
    });
    await dispatchAgentInvoke(ctx, session, "c1", { input: "q", at: AT });
    expect(payload?.["pointInTimeMs"]).toBe(BASE + 1000);
    expect(storeAt).toBe(BASE + 1000);
  });

  test("no at leaves the payload and the store without the key", async () => {
    let payload: Record<string, unknown> | undefined;
    let store: object | undefined;
    const ctx = ctxWithHandler(async (p) => {
      payload = p as Record<string, unknown>;
      store = agentRequestContext.getStore();
      return { reply: "ok" };
    });
    await dispatchAgentInvoke(ctx, session, "c1", { input: "q" });
    expect(Object.hasOwn(payload ?? {}, "pointInTimeMs")).toBe(false);
    expect(Object.hasOwn(store ?? {}, "pointInTimeMs")).toBe(false);
    await dispatchAgentInvoke(ctx, session, "c1", { input: "q", at: null });
    expect(Object.hasOwn(payload ?? {}, "pointInTimeMs")).toBe(false);
  });

  test("a bad, non-string or future at is refused with -32602 BEFORE the agent runs", async () => {
    let ran = false;
    const ctx = ctxWithHandler(async () => {
      ran = true;
      return { reply: "ok" };
    });
    for (const at of ["last tuesday", "", 5, "2999-01-01T00:00Z"]) {
      await expect(
        dispatchAgentInvoke(ctx, session, "c1", { input: "q", at }),
      ).rejects.toMatchObject({
        rpcCode: -32602,
      });
    }
    expect(ran).toBe(false);
  });

  test("the handler's asOfMs echo reaches the caller", async () => {
    const ctx = ctxWithHandler(async () => ({ reply: "ok", asOfMs: BASE + 1000 }) as never);
    const r = (await dispatchAgentInvoke(ctx, session, "c1", { input: "q", at: AT })) as {
      asOfMs: number;
    };
    expect(r.asOfMs).toBe(BASE + 1000);
  });
});
