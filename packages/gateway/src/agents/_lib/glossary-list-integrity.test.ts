import { describe, expect, test } from "bun:test";
import type { GlossaryBrief, GlossaryEntry } from "./glossary-types.ts";
import { renderGlossary } from "./render.ts";
import { reservedBlocksFor, reservedHeadingsFor } from "./reserved-sections.ts";

/**
 * F31 — `glossary` list mode shipped a synthesis that kept the term names and mention counts and
 * dropped EVERY definition, provenance, service spread, date range and cited source, replacing
 * them with two content-free framing sentences (one of which was wrong about what `main` is).
 *
 * I31 did not fail. It permits this by construction: the reserved `## Gaps` section survived, and
 * `CLAUDE.md` records the bound precisely — glossary "requires a phrase only in `term` mode for
 * `entries[0]`". That run was `mode: "list"`, so no phrase was required at all and the body was
 * entirely at the model's discretion.
 *
 * The gap is that for glossary in list mode THE DATA IS THE BRIEF. There is no prose worth
 * preserving in an entry table, which is why the audit points at the withhold-and-re-attach
 * mechanism rather than at a phrase check: a glossary without definitions is a word-frequency
 * table, and prose *about* the data is not a substitute for it.
 *
 * Part (b): the list is ordered by `score` (manual definitions first) while showing only
 * `docFreq`, so the one visible number contradicts the visible order — `whyPeek` (6) sat below
 * three terms with 3 — and no sort key was stated. That is what invites a reader, or a model, to
 * call it "by frequency".
 */

function entry(over: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return {
    term: "whyPeek",
    definition: "The hover surface that shows why a line is the way it is.",
    definitionSource: "llm",
    docFreq: 6,
    serviceSpread: 2,
    firstSeenAt: 1_700_000_000_000,
    lastSeenAt: 1_700_500_000_000,
    topSources: [],
    synonyms: [],
    nearMisses: [],
    score: 0.9,
    ...over,
  };
}

function listBrief(entries: GlossaryEntry[]): GlossaryBrief {
  return {
    kind: "glossary",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 12,
    gaps: [],
    query: { term: null, limit: 15 },
    mode: "list",
    entries,
    matchedVia: null,
    suggestions: [],
  } as unknown as GlossaryBrief;
}

describe("glossary list entries are withheld from the model (F31a)", () => {
  test("the terms table is a reserved section for glossary", () => {
    expect(reservedHeadingsFor(listBrief([entry()]))).toContain("## Terms");
  });

  test("the reserved block carries the DEFINITIONS, not just the counts", () => {
    // The whole finding: the counts came through faithfully and the definitions did not. If the
    // withheld block does not contain them, re-attaching it changes nothing.
    const blocks = reservedBlocksFor(listBrief([entry()]));
    const joined = blocks.map((b) => b.markdown).join("\n");
    expect(joined).toContain("whyPeek");
    expect(joined).toContain("The hover surface that shows why a line is the way it is.");
  });

  test("omitReserved leaves the entry table out of what the model sees", () => {
    const brief = listBrief([entry()]);
    const withheld = renderGlossary(brief, { omitReserved: true });
    expect(withheld).not.toContain("The hover surface that shows why a line is the way it is.");
  });

  test("the canonical render still carries it, so the reader loses nothing", () => {
    const brief = listBrief([entry()]);
    const full = renderGlossary(brief);
    expect(full).toContain("The hover surface that shows why a line is the way it is.");
  });

  test("an entry with no definition renders without inventing one", () => {
    // A term can be consolidated with no definition. The reserved block must say so rather than
    // leave a bullet that reads as if the definition were empty prose.
    const full = renderGlossary(listBrief([entry({ definition: null, definitionSource: null })]));
    expect(full).toContain("whyPeek");
    expect(full).not.toContain("undefined");
    expect(full).not.toContain("null");
  });
});

describe("the list states what it is ranked by (F31b)", () => {
  test("the rendered order shows the score it is actually sorted on", () => {
    // `whyPeek` (6 mentions, score 0.9) above `read-only` (3 mentions, score 0.95) is exactly the
    // shape that looked like a bug: the only visible number went the wrong way.
    const full = renderGlossary(
      listBrief([
        entry({ term: "read-only", docFreq: 3, score: 0.95 }),
        entry({ term: "whyPeek", docFreq: 6, score: 0.9 }),
      ]),
    );
    expect(full).toContain("0.95");
    expect(full).toContain("0.9");
  });

  test("it names the sort key, so the order is not read as frequency", () => {
    const full = renderGlossary(listBrief([entry()]));
    expect(full.toLowerCase()).toContain("ranked by");
  });
});
