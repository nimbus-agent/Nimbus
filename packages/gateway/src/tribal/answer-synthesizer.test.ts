import { expect, test } from "bun:test";
import { type SynthDeps, type SynthSource, synthesizeAnswer } from "./answer-synthesizer.ts";
import type { TribalCluster } from "./cluster-store.ts";

function cluster(): TribalCluster {
  return {
    clusterId: "k1",
    representativeQuestion: "how do I deploy the gateway?",
    representativeVec: null,
    occurrenceCount: 3,
    firstSeen: 1000,
    lastSeen: 2000,
    status: "suggested",
    channelId: "C1",
    platform: "slack",
    suggestedAt: 1500,
    cooldownUntil: null,
    capturedPageRef: null,
  };
}

test("synthesizes title + body + citations from allowlisted sources", async () => {
  const sources: SynthSource[] = [
    { itemId: "slack:C1:1", channelId: "C1", url: "https://s/1", text: "run nimbus deploy" },
    { itemId: "slack:C1:2", channelId: "C1", url: null, text: "then verify health" },
  ];
  const deps: SynthDeps = {
    gatherSources: () => sources,
    watchChannels: new Set(["C1"]),
    llm: async (_prompt, srcs) => ({
      title: "Deploying the gateway",
      bodyMarkdown: `Steps:\n\n- ${srcs.map((s) => s.text).join("\n- ")}`,
    }),
  };
  const out = await synthesizeAnswer(deps, cluster());
  expect(out.title).toBe("Deploying the gateway");
  expect(out.bodyMarkdown).toContain("run nimbus deploy");
  expect(out.citations).toEqual([
    { itemId: "slack:C1:1", channelId: "C1", url: "https://s/1" },
    { itemId: "slack:C1:2", channelId: "C1", url: null },
  ]);
});

test("a source outside watch_channels is excluded from citations AND from the llm input", async () => {
  const sources: SynthSource[] = [
    { itemId: "slack:C1:1", channelId: "C1", url: null, text: "watched" },
    { itemId: "slack:CX:9", channelId: "C_LEAK", url: null, text: "LEAKED-PRIVATE" },
  ];
  let sawLeak = false;
  const deps: SynthDeps = {
    gatherSources: () => sources,
    watchChannels: new Set(["C1"]),
    llm: async (_prompt, srcs) => {
      if (srcs.some((s) => s.text.includes("LEAKED"))) sawLeak = true;
      return { title: "T", bodyMarkdown: "B" };
    },
  };
  const out = await synthesizeAnswer(deps, cluster());
  expect(sawLeak).toBe(false);
  expect(out.citations.map((c) => c.channelId)).toEqual(["C1"]);
});
