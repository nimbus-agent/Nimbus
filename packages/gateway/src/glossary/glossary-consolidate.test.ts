import { expect, test } from "bun:test";

import { consolidateTerm, pickSnippetDefinition } from "./glossary-consolidate.ts";
import type { GlossaryTerm } from "./glossary-types.ts";

function term(over: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    termKey: "cdr",
    displayTerm: "CDR",
    status: "pending",
    definition: null,
    definitionSource: null,
    docFreq: 5,
    serviceSpread: 2,
    score: 3,
    form: "acronym",
    firstSeenAt: 1,
    lastSeenAt: 2,
    topSources: [],
    synonyms: [],
    nearMisses: [],
    consolidatedAt: null,
    statsVerifiedAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const SNIPPETS = [{ text: "We adopted Change Data Record (CDR) for the sync path." }];

test("happy path returns an llm-sourced definition", async () => {
  const llm = {
    generateJson: async () =>
      JSON.stringify({ isDomainTerm: true, definition: "The per-row change envelope." }),
  };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  expect(out.kind).toBe("defined");
  if (out.kind === "defined") {
    expect(out.source).toBe("llm");
    expect(out.definition).toBe("The per-row change envelope.");
  }
});

test("isDomainTerm false yields a veto", async () => {
  const llm = { generateJson: async () => JSON.stringify({ isDomainTerm: false, definition: "" }) };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  expect(out.kind).toBe("vetoed");
});

test("alsoKnownAs merges with detected acronym expansions", async () => {
  const llm = {
    generateJson: async () =>
      JSON.stringify({ isDomainTerm: true, definition: "d", alsoKnownAs: ["CDR event"] }),
  };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  if (out.kind !== "defined") throw new Error("expected defined");
  expect(out.synonyms).toContain("CDR event");
  expect(out.synonyms).toContain("Change Data Record");
});

test("malformed JSON yields retry, never a veto", async () => {
  const llm = { generateJson: async () => "not json at all" };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  expect(out.kind).toBe("retry");
});

test("empty response yields retry", async () => {
  const llm = { generateJson: async () => "" };
  expect((await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 })).kind).toBe("retry");
});

test("a null response yields retry", async () => {
  const llm = { generateJson: async () => null };
  expect((await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 })).kind).toBe("retry");
});

test("a thrown LLM error yields retry, never a veto", async () => {
  const llm = {
    generateJson: async () => {
      throw new Error("model unavailable");
    },
  };
  expect((await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 })).kind).toBe("retry");
});

test("a hung LLM times out into retry", async () => {
  const llm = { generateJson: () => new Promise<string>(() => undefined) };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 20 });
  expect(out.kind).toBe("retry");
});

test("an abort settles a hung call without waiting for the timeout", async () => {
  const llm = { generateJson: () => new Promise<string>(() => undefined) };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  const started = Date.now();
  const out = await consolidateTerm(term(), SNIPPETS, {
    llm,
    timeoutMs: 30_000,
    signal: controller.signal,
  });

  expect(out.kind).toBe("retry");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("an already-aborted signal returns immediately", async () => {
  const llm = { generateJson: () => new Promise<string>(() => undefined) };
  const controller = new AbortController();
  controller.abort();
  const out = await consolidateTerm(term(), SNIPPETS, {
    llm,
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  expect(out.kind).toBe("retry");
});

test("the signal is forwarded to the provider", async () => {
  let seen: AbortSignal | undefined;
  const controller = new AbortController();
  const llm = {
    generateJson: async (_p: string, signal?: AbortSignal) => {
      seen = signal;
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };
  await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000, signal: controller.signal });
  expect(seen).toBe(controller.signal);
});

test("no LLM falls back to a verbatim snippet definition", async () => {
  const out = await consolidateTerm(term(), SNIPPETS, { timeoutMs: 1000 });
  expect(out.kind).toBe("defined");
  if (out.kind === "defined") {
    expect(out.source).toBe("snippet");
    expect(out.definition).toContain("Change Data Record");
  }
});

test("no LLM and no usable snippet yields retry", async () => {
  const out = await consolidateTerm(term(), [{ text: "unrelated prose" }], { timeoutMs: 1000 });
  expect(out.kind).toBe("retry");
});

test("pickSnippetDefinition returns the sentence containing the term", () => {
  const got = pickSnippetDefinition("CDR", [
    { text: "Nothing here. The CDR is the change envelope. Trailing text." },
  ]);
  expect(got).toBe("The CDR is the change envelope.");
});

test("pickSnippetDefinition returns null when the term is absent", () => {
  expect(pickSnippetDefinition("CDR", [{ text: "no mention" }])).toBe(null);
});

test("the prompt wraps source snippets in a tool-output envelope", async () => {
  let seen = "";
  const llm = {
    generateJson: async (p: string) => {
      seen = p;
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };
  await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  expect(seen).toContain("<tool_output");
});
