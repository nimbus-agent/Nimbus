import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { SynthesizedAnswer } from "./answer-synthesizer.ts";
import { type TribalCluster, TribalClusterStore } from "./cluster-store.ts";
import { captureToKnowledgeBase, type WriteGateDeps } from "./tribal-write-gate.ts";

function freshStore(): TribalClusterStore {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, 39);
  const s = new TribalClusterStore(d);
  s.upsertOccurrence({
    clusterId: "k1",
    question: "how do I deploy?",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 1000,
  });
  return s;
}

const draft: SynthesizedAnswer = {
  title: "Deploying",
  bodyMarkdown: "Run deploy",
  citations: [{ itemId: "slack:C1:1", channelId: "C1", url: "https://s/1" }],
};

type Submitted = { type: string; payload: Record<string, unknown> };

function deps(over: Partial<WriteGateDeps> = {}): {
  deps: WriteGateDeps;
  submitted: Submitted[];
  store: TribalClusterStore;
} {
  const submitted: Submitted[] = [];
  const store = over.store ?? freshStore();
  const d: WriteGateDeps = {
    cfg: { notion: { databaseId: "db_cfg" } },
    synthesize: async () => draft,
    submitAction: async (action) => {
      submitted.push(action);
      return { status: "approved", result: { pageRef: "notion:pg1" } };
    },
    store,
    cooldownDays: 30,
    now: () => 5000,
    ...over,
  };
  return { deps: d, submitted, store };
}

function clusterFrom(store: TribalClusterStore): TribalCluster {
  const c = store.get("k1");
  if (c === undefined) throw new Error("seed missing");
  return c;
}

test("writes the config destination — a caller could not inject a different database", async () => {
  const { deps: d, submitted, store } = deps();
  const r = await captureToKnowledgeBase(d, clusterFrom(store), "notion");
  expect(r).toEqual({ ok: true, pageRef: "notion:pg1" });
  expect(submitted).toHaveLength(1);
  expect(submitted[0]?.type).toBe("notion.knowledge.write");
  expect(submitted[0]?.payload["mcpToolId"]).toBe("notion_kb_append");
  expect(submitted[0]?.payload["databaseId"]).toBe("db_cfg"); // from config, never caller input
  expect(store.get("k1")?.status).toBe("captured");
  expect(store.get("k1")?.capturedPageRef).toBe("notion:pg1");
});

test("unconfigured target → not_configured, submitAction never called", async () => {
  const { deps: d, submitted, store } = deps({ cfg: {} });
  const r = await captureToKnowledgeBase(d, clusterFrom(store), "notion");
  expect(r).toEqual({ ok: false, error: "not_configured" });
  expect(submitted).toHaveLength(0);
  expect(store.get("k1")?.status).toBe("pending");
});

test("both targets configured + no --target → target_ambiguous", async () => {
  const {
    deps: d,
    submitted,
    store,
  } = deps({
    cfg: { notion: { databaseId: "db" }, confluence: { spaceKey: "ENG", parentPageId: "9" } },
  });
  const r = await captureToKnowledgeBase(d, clusterFrom(store), undefined);
  expect(r).toEqual({ ok: false, error: "target_ambiguous" });
  expect(submitted).toHaveLength(0);
});

test("single configured target + no --target → uses it", async () => {
  const { deps: d, submitted, store } = deps();
  const r = await captureToKnowledgeBase(d, clusterFrom(store), undefined);
  expect(r).toEqual({ ok: true, pageRef: "notion:pg1" });
  expect(submitted[0]?.type).toBe("notion.knowledge.write");
});

test("HITL rejected → no markCaptured, error rejected", async () => {
  const { deps: d, store } = deps({
    submitAction: async () => ({ status: "rejected" }),
  });
  const r = await captureToKnowledgeBase(d, clusterFrom(store), "notion");
  expect(r).toEqual({ ok: false, error: "rejected" });
  expect(store.get("k1")?.status).toBe("pending");
});

test("approved but no pageRef → write_failed, not captured", async () => {
  const { deps: d, store } = deps({
    submitAction: async () => ({ status: "approved" }),
  });
  const r = await captureToKnowledgeBase(d, clusterFrom(store), "notion");
  expect(r).toEqual({ ok: false, error: "write_failed" });
  expect(store.get("k1")?.status).toBe("pending");
});

test("confluence target builds the space/parent payload from config", async () => {
  const {
    deps: d,
    submitted,
    store,
  } = deps({
    cfg: { confluence: { spaceKey: "ENG", parentPageId: "9999" } },
  });
  const r = await captureToKnowledgeBase(d, clusterFrom(store), "confluence");
  expect(r.ok).toBe(true);
  expect(submitted[0]?.type).toBe("confluence.knowledge.write");
  expect(submitted[0]?.payload["mcpToolId"]).toBe("confluence_kb_append");
  expect(submitted[0]?.payload["spaceKey"]).toBe("ENG");
  expect(submitted[0]?.payload["parentPageId"]).toBe("9999");
});

test("requested target not configured (other one is) → not_configured", async () => {
  const {
    deps: d,
    submitted,
    store,
  } = deps({
    cfg: { confluence: { spaceKey: "ENG", parentPageId: "9" } },
  });
  const r = await captureToKnowledgeBase(d, clusterFrom(store), "notion");
  expect(r).toEqual({ ok: false, error: "not_configured" });
  expect(submitted).toHaveLength(0);
});

test("citations are serialized into the payload as citationsJson", async () => {
  const { deps: d, submitted, store } = deps();
  await captureToKnowledgeBase(d, clusterFrom(store), "notion");
  const json = submitted[0]?.payload["citationsJson"];
  expect(typeof json).toBe("string");
  expect(JSON.parse(json as string)).toEqual(draft.citations);
});
