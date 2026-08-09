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

test("with no model, extraction yields ZERO themes — never a guess", () => {
  // There is no snippet fallback and deliberately so: glossary can pick a
  // snippet because it already knows the term, but here DISCOVERY is the task,
  // so there is nothing to look up. Inventing themes from keywords would
  // fabricate findings from a single incidental mention.
  return extractThemes(EPICS, {}).then((themes) => {
    expect(themes).toEqual([]);
  });
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
  const themes = await extractThemes(EPICS, { llm });
  expect(themes).toEqual([
    { label: "third-party rate limits", sourceItemIds: ["jira:A", "jira:B"] },
    { label: "vendor quota approval", sourceItemIds: ["jira:B"] },
  ]);
});

test("drops a source the model invented, keeping the theme", async () => {
  // The model must not be able to attribute a theme to an epic that was never
  // in its prompt — that would fabricate corroboration, and corroboration IS
  // the confidence score.
  const llm = {
    complete: async () =>
      JSON.stringify({ themes: [{ label: "rate limits", sources: ["jira:A", "jira:NOPE"] }] }),
  };
  const themes = await extractThemes(EPICS, { llm });
  expect(themes).toEqual([{ label: "rate limits", sourceItemIds: ["jira:A"] }]);
});

test("drops a theme left with no valid source at all", async () => {
  const llm = {
    complete: async () => JSON.stringify({ themes: [{ label: "ghost", sources: ["jira:NOPE"] }] }),
  };
  expect(await extractThemes(EPICS, { llm })).toEqual([]);
});

test("malformed model output yields no themes rather than throwing", async () => {
  const llm = { complete: async () => "not json at all" };
  expect(await extractThemes(EPICS, { llm })).toEqual([]);
});

test("a null completion yields no themes", async () => {
  const llm = { complete: async () => null };
  expect(await extractThemes(EPICS, { llm })).toEqual([]);
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
  expect(await extractThemes(EPICS, { llm })).toEqual([
    { label: "rate limits", sourceItemIds: ["jira:A"] },
  ]);
});

test("an empty epic batch never calls the model", async () => {
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      return "{}";
    },
  };
  expect(await extractThemes([], { llm })).toEqual([]);
  expect(calls).toBe(0);
});
