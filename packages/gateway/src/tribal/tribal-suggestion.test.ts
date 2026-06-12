import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalClusterStore } from "./cluster-store.ts";
import { postSuggestion } from "./tribal-suggestion.ts";

test("posts to originating channel and marks suggested", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 39);
  const store = new TribalClusterStore(db);
  const c = store.upsertOccurrence({
    clusterId: "k1",
    question: "how to deploy?",
    vec: null,
    channelId: "C1",
    platform: "slack",
    now: 1000,
  });
  const sent: { target: unknown; text: string }[] = [];
  await postSuggestion(
    { send: async (target, text) => void sent.push({ target, text }), store, now: () => 1500 },
    c,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.target).toEqual({ kind: "originating", platform: "slack", channelId: "C1" });
  expect(sent[0]?.text).toContain("nimbus tribal capture k1");
  expect(store.get("k1")?.status).toBe("suggested");
});
