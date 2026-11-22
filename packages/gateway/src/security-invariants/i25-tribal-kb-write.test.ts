import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalClusterStore } from "../tribal/cluster-store.ts";
import { captureToKnowledgeBase } from "../tribal/tribal-write-gate.ts";

describe("I25 — a tribal KB capture writes only the config destination, behind the owner's HITL gate", () => {
  function seededStore(): TribalClusterStore {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 39);
    const store = new TribalClusterStore(db);
    store.upsertOccurrence({
      clusterId: "k1",
      question: "how do I deploy?",
      vec: null,
      channelId: "C1",
      platform: "slack",
      now: 1000,
    });
    return store;
  }

  const draft = {
    title: "Deploying",
    bodyMarkdown: "Run deploy",
    citations: [] as { itemId: string; channelId: string; url: string | null }[],
  };

  test("(a) the destination is the config databaseId — never a caller value", async () => {
    const submitted: { type: string; payload: Record<string, unknown> }[] = [];
    const store = seededStore();
    const cluster = store.get("k1");
    expect(cluster).toBeDefined();
    const r = await captureToKnowledgeBase(
      {
        cfg: { notion: { databaseId: "db_cfg" } },
        synthesize: async () => draft,
        submitAction: async (action) => {
          submitted.push(action);
          return { status: "approved", result: { pageRef: "notion:pg1" } };
        },
        store,
        cooldownDays: 30,
        now: () => 5000,
      },
      cluster!,
      "notion",
    );
    expect(r).toEqual({ ok: true, pageRef: "notion:pg1" });
    expect(submitted[0]?.type).toBe("notion.knowledge.write");
    expect(submitted[0]?.payload["databaseId"]).toBe("db_cfg");
    expect(store.get("k1")?.status).toBe("captured");
  });

  test("(b) an unconfigured target fails closed (not_configured) and never submits an action", async () => {
    let submitCalls = 0;
    const store = seededStore();
    const r = await captureToKnowledgeBase(
      {
        cfg: {},
        synthesize: async () => draft,
        submitAction: async () => {
          submitCalls += 1;
          return { status: "approved", result: { pageRef: "x" } };
        },
        store,
        cooldownDays: 30,
        now: () => 5000,
      },
      store.get("k1")!,
      "notion",
    );
    expect(r).toEqual({ ok: false, error: "not_configured" });
    expect(submitCalls).toBe(0);
    expect(store.get("k1")?.status).toBe("pending");
  });

  test("(c) a rejected HITL leaves the cluster uncaptured", async () => {
    const store = seededStore();
    const r = await captureToKnowledgeBase(
      {
        cfg: { notion: { databaseId: "db_cfg" } },
        synthesize: async () => draft,
        submitAction: async () => ({ status: "rejected" }),
        store,
        cooldownDays: 30,
        now: () => 5000,
      },
      store.get("k1")!,
      "notion",
    );
    expect(r).toEqual({ ok: false, error: "rejected" });
    expect(store.get("k1")?.status).toBe("pending");
  });

  test("(d) D19 confines the KB-write tool ids to the write-gate + connector sites", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D19-tribal-kb-write");
  });
});
