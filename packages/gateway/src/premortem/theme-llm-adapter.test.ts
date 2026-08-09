import { expect, test } from "bun:test";

import type { DiscoveredEpic } from "./theme-discover.ts";
import { extractThemes } from "./theme-llm-adapter.ts";

const EPICS: DiscoveredEpic[] = [
  {
    itemId: "jira:A",
    epicKey: "PROJ-1",
    title: "Billing v1",
    body: "Stripe capped us at 100 rps, had to batch",
    bodyComplete: true,
    resolvedAtMs: 1,
    modifiedAt: 1,
  },
  {
    itemId: "jira:B",
    epicKey: "PROJ-2",
    title: "Billing v1.5",
    body: "waiting on Twilio quota increase",
    bodyComplete: true,
    resolvedAtMs: 2,
    modifiedAt: 2,
  },
];

test("with no llm supplied at all, extraction reports no-model — never a guess", async () => {
  // There is no snippet fallback and deliberately so: glossary can pick a
  // snippet because it already knows the term, but here DISCOVERY is the task,
  // so there is nothing to look up. Inventing themes from keywords would
  // fabricate findings from a single incidental mention.
  expect(await extractThemes(EPICS, {})).toEqual({ kind: "no-model" });
});

test("parses labels and their attributed sources from the model", async () => {
  const llm = {
    complete: async () =>
      JSON.stringify({
        themes: [
          { label: "third-party rate limits", sources: ["jira:A", "jira:B"] },
          { label: "vendor quota approval", sources: ["jira:B"] },
        ],
      }),
  };
  const outcome = await extractThemes(EPICS, { llm });
  expect(outcome).toEqual({
    kind: "ok",
    themes: [
      { label: "third-party rate limits", sourceItemIds: ["jira:A", "jira:B"] },
      { label: "vendor quota approval", sourceItemIds: ["jira:B"] },
    ],
  });
});

test("drops a source the model invented, keeping the theme", async () => {
  // The model must not be able to attribute a theme to an epic that was never
  // in its prompt — that would fabricate corroboration, and corroboration IS
  // the confidence score.
  const llm = {
    complete: async () =>
      JSON.stringify({ themes: [{ label: "rate limits", sources: ["jira:A", "jira:NOPE"] }] }),
  };
  const outcome = await extractThemes(EPICS, { llm });
  expect(outcome).toEqual({
    kind: "ok",
    themes: [{ label: "rate limits", sourceItemIds: ["jira:A"] }],
  });
});

test("drops a theme left with no valid source at all", async () => {
  const llm = {
    complete: async () => JSON.stringify({ themes: [{ label: "ghost", sources: ["jira:NOPE"] }] }),
  };
  expect(await extractThemes(EPICS, { llm })).toEqual({ kind: "ok", themes: [] });
});

test("duplicate source ids cannot inflate a theme's corroboration", async () => {
  // The evidence COUNT is the confidence score, so a model repeating the same
  // id must not multiply it. Dropping `new Set(...)` in extractThemes must
  // turn this test red.
  const llm = {
    complete: async () =>
      JSON.stringify({
        themes: [{ label: "rate limits", sources: ["jira:A", "jira:A", "jira:A"] }],
      }),
  };
  const outcome = await extractThemes(EPICS, { llm });
  expect(outcome).toEqual({
    kind: "ok",
    themes: [{ label: "rate limits", sourceItemIds: ["jira:A"] }],
  });
});

test("malformed model output yields ok/zero themes — the model ran and produced nothing usable", async () => {
  const llm = { complete: async () => "not json at all" };
  expect(await extractThemes(EPICS, { llm })).toEqual({ kind: "ok", themes: [] });
});

test("a null completion reports no-model — the real no-Ollama case", async () => {
  const llm = { complete: async () => null };
  expect(await extractThemes(EPICS, { llm })).toEqual({ kind: "no-model" });
});

test("an empty-string completion reports no-model", async () => {
  const llm = { complete: async () => "" };
  expect(await extractThemes(EPICS, { llm })).toEqual({ kind: "no-model" });
});

test("a throwing complete() reports no-model — transient failure, not proof no model exists", async () => {
  const llm = {
    complete: async (): Promise<string | null> => {
      throw new Error("ECONNREFUSED");
    },
  };
  expect(await extractThemes(EPICS, { llm })).toEqual({ kind: "no-model" });
});

test("a label that normalizes to nothing is dropped", async () => {
  // "..." survives a `trim() !== ""` check but normalizes to "", which would
  // key a theme on the empty string and surface a blank bullet in the brief.
  const llm = {
    complete: async () =>
      JSON.stringify({
        themes: [
          { label: "...", sources: ["jira:A"] },
          { label: "   ", sources: ["jira:A"] },
          { label: "rate limits", sources: ["jira:A"] },
        ],
      }),
  };
  expect(await extractThemes(EPICS, { llm })).toEqual({
    kind: "ok",
    themes: [{ label: "rate limits", sourceItemIds: ["jira:A"] }],
  });
});

test("an empty epic batch never calls the model, and reports ok/zero — not no-model", async () => {
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      return "{}";
    },
  };
  expect(await extractThemes([], { llm })).toEqual({ kind: "ok", themes: [] });
  expect(calls).toBe(0);
});

test("a very long epic body is truncated in the emitted prompt", async () => {
  const longBody = "x".repeat(50_000);
  let capturedPrompt = "";
  const llm = {
    complete: async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({ themes: [] });
    },
  };
  await extractThemes([{ ...EPICS[0]!, body: longBody }], { llm });
  // The prompt must contain SOME of the body (truncation, not omission) but
  // never the whole 50,000-char string — otherwise a single oversized epic
  // still blows the local model's context window front-truncation was meant
  // to fix.
  expect(capturedPrompt).not.toContain(longBody);
  expect(capturedPrompt.length).toBeLessThan(longBody.length);
});

test("INSTRUCTIONS is placed AFTER the sources, so front-truncation degrades data, not the ask", async () => {
  let capturedPrompt = "";
  const llm = {
    complete: async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({ themes: [] });
    },
  };
  await extractThemes(EPICS, { llm });
  const sourcesIdx = capturedPrompt.indexOf("Sources:");
  const instructionsIdx = capturedPrompt.indexOf("Respond with JSON only");
  expect(sourcesIdx).toBeGreaterThanOrEqual(0);
  expect(instructionsIdx).toBeGreaterThan(sourcesIdx);
});
