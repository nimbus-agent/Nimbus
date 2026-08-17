# Brief Honesty Contract — PR 1 (structural layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally impossible for an LLM rewrite to drop a built-in brief's whole-section disclosures, across all fourteen brief kinds, and record the property as security invariant I31.

**Architecture:** A brief's disclosure-only sections (`## Gaps` everywhere, plus `negotiate`'s `## Sources` and `## Evidence not available from the index`) are never sent to the model. Each `render*` function gains an optional `{ omitReserved: true }` that suppresses them; a sibling `reservedBlocksFor(brief)` builds the same blocks from the same brief data using the same builders. `synthesize()` prompts with the body, strips any reserved heading the model emitted anyway, and re-attaches the canonical blocks verbatim before the honesty contract is checked. Neither half is recovered by parsing the rendered markdown, so untrusted brief content cannot break extraction.

**Tech Stack:** Bun 1.2+ · TypeScript strict (no `any`) · `bun:test` · Biome

**Spec:** `docs/superpowers/specs/2026-08-17-brief-honesty-contract-design.md` — read it before starting; this plan implements its Layer 1 and its invariant section only.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Branch:** work on `dev/asafgolombek/brief-honesty-contract`. Never commit on `main`. Verify with `git rev-parse --abbrev-ref HEAD` before the first commit.
- **Worktree:** `C:\gitrep\Nimbus\.claude\worktrees\brief-honesty-contract` (deps already installed).
- **Cross-platform:** build paths with `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Coverage floor:** every new file must reach ≥85% line and ≥80% branch. That gate is CI-Linux-authoritative.
- **Out of scope for this PR:** Layer 2 (the derived phrase guard, `brief-disclosures.ts`, the seven interleaved disclosures). That is PR 2 and gets its own plan. Do not start it here.
- **Existing behaviour must not change when synthesis is off.** `renderX(brief)` with no options must stay byte-identical, so every existing render test passes unmodified. If an existing test needs editing, stop — something is wrong.

---

### Task 1: Extract the shared Markdown section parser

`brief-contract.ts` owns the only `##`-section scanner in the agents tree. The strip step needs the same parse. Extract it so there is exactly one, then add `stripSections` beside it.

**Files:**

- Create: `packages/gateway/src/agents/_lib/markdown-sections.ts`
- Create: `packages/gateway/src/agents/_lib/markdown-sections.test.ts`
- Modify: `packages/gateway/src/agents/_lib/brief-contract.ts:1-57` (delete `normalize` + `sectionBody`, import them instead)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `normalizeSectionText(s: string): string`
  - `sectionBody(markdown: string, heading: string): string | undefined`
  - `stripSections(markdown: string, headings: readonly string[]): string`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/markdown-sections.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { normalizeSectionText, sectionBody, stripSections } from "./markdown-sections.ts";

describe("normalizeSectionText", () => {
  test("strips emphasis, collapses whitespace and lowercases", () => {
    expect(normalizeSectionText("  **Gaps**   and\n_caveats_ ")).toBe("gaps and caveats");
  });
});

describe("sectionBody", () => {
  test("returns the body under a level-2 heading, up to the next same-or-higher heading", () => {
    const md = "## Tickets\n\nrow one\n\n### Note\n\nnested\n\n## Ownership\n\nother";
    expect(sectionBody(md, "Tickets")).toContain("row one");
    expect(sectionBody(md, "Tickets")).toContain("nested");
    expect(sectionBody(md, "Tickets")).not.toContain("other");
  });

  test("matches a heading by normalized prefix, not equality", () => {
    expect(sectionBody("## Ownership — services: checkout\n\nbody", "Ownership")).toContain("body");
  });

  test("a demoted heading does not open a section", () => {
    expect(sectionBody("### Tickets\n\nbody", "Tickets")).toBeUndefined();
  });
});

describe("stripSections", () => {
  test("removes a named level-2 section and its body", () => {
    const md = "# Brief\n\nkeep me\n\n## Gaps\n\n- invented\n\n## Next\n\nalso keep";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).toContain("keep me");
    expect(out).toContain("also keep");
    expect(out).not.toContain("invented");
    expect(out).not.toContain("## Gaps");
  });

  test("removes a near-miss heading, because matching is a prefix", () => {
    const out = stripSections("body\n\n## Gaps and caveats\n\n- invented", ["## Gaps"]);
    expect(out).not.toContain("invented");
  });

  test("keeps a deeper heading nested inside a stripped section out of the output", () => {
    const md = "body\n\n## Gaps\n\n- one\n\n### Detail\n\n- two\n\n## Keep\n\nkept";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).not.toContain("two");
    expect(out).toContain("kept");
  });

  test("is a no-op when no heading matches, and when the list is empty", () => {
    expect(stripSections("## Other\n\nbody", ["## Gaps"])).toContain("body");
    expect(stripSections("## Gaps\n\nbody", [])).toContain("body");
  });

  test("strips a heading carrying trailing punctuation or an extra clause", () => {
    expect(stripSections("body\n\n## Gaps:\n\n- x", ["## Gaps"])).not.toContain("- x");
    expect(stripSections("body\n\n## Gaps & Caveats\n\n- x", ["## Gaps"])).not.toContain("- x");
  });

  test("does NOT strip a demoted heading — only level 2 opens a section", () => {
    expect(stripSections("body\n\n### Gaps\n\n- x", ["## Gaps"])).toContain("- x");
  });
});

describe("fenced code blocks", () => {
  test("a heading inside a fence does not open a section", () => {
    const md = "## Real\n\n```md\n## Tickets\nnot a heading\n```\n\nstill under Real";
    expect(sectionBody(md, "Real")).toContain("still under Real");
    expect(sectionBody(md, "Tickets")).toBeUndefined();
  });

  test("a heading inside a fence is not stripped", () => {
    const md = "body\n\n```md\n## Gaps\n```\n\ntail";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).toContain("## Gaps");
    expect(out).toContain("tail");
  });

  test("a tilde fence counts too", () => {
    const md = "body\n\n~~~\n## Gaps\n~~~\n\ntail";
    expect(stripSections(md, ["## Gaps"])).toContain("tail");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/markdown-sections.test.ts`
Expected: FAIL — module `./markdown-sections.ts` does not exist.

- [ ] **Step 3: Create the module**

Create `packages/gateway/src/agents/_lib/markdown-sections.ts`:

```typescript
/**
 * The ONE Markdown section scanner in the agents tree.
 *
 * Two consumers depend on this parse and must not have separate copies of it:
 * `brief-contract.ts` (which locates a section to check a required phrase inside it)
 * and `synthesize.ts` (which strips a reserved section a model emitted anyway).
 * Sibling guards built on separate copies of one scan share a blind spot and get
 * fixed in only one of them.
 */

/**
 * Strip markdown emphasis and collapse whitespace so a model that re-formats a
 * phrase is not treated as one that DELETED it. Without this the contract guard
 * rejects every real synthesis and the feature ships inert.
 */
export function normalizeSectionText(s: string): string {
  return s.replace(/[_*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const HEADING_RE = /^(#+)\s+(.+)$/;
const FENCE_RE = /^\s*(?:```|~~~)/;

/** The `#` run and normalized text of a heading line, or `undefined` if it is not one. */
function headingOf(line: string): { level: number; text: string } | undefined {
  const m = HEADING_RE.exec(line);
  if (m === null) return undefined;
  const hashes = m[1];
  if (hashes === undefined) return undefined;
  return { level: hashes.length, text: normalizeSectionText(m[2] ?? "") };
}

/**
 * Normalized comparison text for a caller-supplied heading, accepting either form.
 *
 * `brief-contract.ts` passes bare text (`"Tickets"`); the reserved registry stores the
 * literal a renderer emits (`"## Gaps"`). Both must compare equal to a heading LINE's text,
 * which `headingOf` has already stripped of its `#` run — without this, a registry entry
 * would compare `"## gaps"` against `"gaps"` and never match, leaving the strip step
 * silently inert.
 */
function headingTextOf(heading: string): string {
  return normalizeSectionText(heading.replace(/^#+\s*/, ""));
}

/**
 * Every heading line OUTSIDE a fenced code block, with its index and level.
 *
 * Fence tracking matters because the markdown being scanned is the model's output, and a
 * rewrite can legitimately contain a fenced example that includes a `##` line — echoed, for
 * instance, out of a glossary definition quoted verbatim from a source document. Treating
 * that as a section boundary would strip real content from the brief. It narrows, but does
 * not eliminate, the bound recorded on `stripSections`: an UNfenced echoed heading is still
 * indistinguishable from one the model authored.
 */
function headingLines(lines: readonly string[]): { index: number; level: number; text: string }[] {
  const out: { index: number; level: number; text: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = headingOf(line);
    if (h !== undefined) out.push({ index: i, level: h.level, text: h.text });
  }
  return out;
}

/**
 * Body text under `## <heading>`, up to the next heading of the SAME OR HIGHER level
 * (same or fewer `#` characters) — not a heading at a deeper level.
 *
 * Heading match is a normalized PREFIX, not equality: `render.ts` documents headings
 * rendered as `## Ownership — services: checkout`, and exact matching would report that
 * section missing and reject an otherwise-correct synthesis.
 *
 * OPENING a section requires EXACTLY `##`. These are two separate rules and it is worth
 * keeping them apart, because conflating them left a hole here once: the level check in the
 * LOOP exists so a rewrite that adds sub-structure (a `### Note` inside `## Tickets`) does
 * not truncate the body at that sub-heading and report a false "dropped required phrase".
 * That argument is about where a section ENDS. It says nothing about what may START one,
 * and matching every `#`-run let a rewrite satisfy a required `## Tickets` with a
 * `### Tickets` demoted under a different section — or match an unrelated earlier
 * `### Tickets` sub-note (`findIndex` takes the first hit) and read the disclaimer out of
 * the wrong body entirely.
 */
export function sectionBody(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const target = headingTextOf(heading);
  const heads = headingLines(lines);
  const start = heads.find((h) => h.level === 2 && h.text.startsWith(target));
  if (start === undefined) return undefined;
  const end = heads.find((h) => h.index > start.index && h.level <= start.level);
  return lines.slice(start.index + 1, end?.index ?? lines.length).join("\n");
}

/**
 * Every level-2 section whose heading matches one of `headings`, removed along with its
 * body — including any deeper sub-headings nested inside it, which end at the next
 * same-or-higher heading exactly as `sectionBody` defines it.
 *
 * Used on the MODEL's output, which is untrusted markdown: a rewrite that invents a
 * `## Gaps` section must not end up beside the canonical one. Matching is the same
 * normalized prefix `sectionBody` uses, so `## Gaps:` and `## Gaps & Caveats` are caught
 * too — an end-anchored equality would leave those near-misses standing.
 *
 * DEMOTED headings are deliberately NOT stripped. Only `##` opens a section here, matching
 * the rule `sectionBody` enforces for the contract guard, and for the same asymmetry: a
 * `### Gaps` the model nested under some other section is fabrication of the general kind
 * (which the synthesis instructions address), whereas widening the strip to deeper levels
 * would start deleting the sub-structure the end-of-section rule exists to permit.
 *
 * BOUND: this cannot distinguish a heading the model invented from one it faithfully echoed
 * out of quoted brief content. Fence tracking in `headingLines` removes the fenced case; an
 * unfenced echo is still stripped, so a synthesized brief may lose a fragment of a quoted
 * definition. It can never lose a disclosure — the canonical block is re-attached either way.
 */
export function stripSections(markdown: string, headings: readonly string[]): string {
  if (headings.length === 0) return markdown;
  const targets = headings.map(headingTextOf);
  const lines = markdown.split("\n");
  const heads = headingLines(lines);
  const drop = new Set<number>();
  for (const h of heads) {
    if (h.level !== 2) continue;
    if (!targets.some((t) => h.text.startsWith(t))) continue;
    const end = heads.find((x) => x.index > h.index && x.level <= 2);
    for (let i = h.index; i < (end?.index ?? lines.length); i++) drop.add(i);
  }
  return lines
    .filter((_, i) => !drop.has(i))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/agents/_lib/markdown-sections.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Re-point `brief-contract.ts` at the shared parser**

In `packages/gateway/src/agents/_lib/brief-contract.ts`, delete the local `normalize` function (lines 8-15) and the local `sectionBody` function (lines 17-57), and add the import at the top of the file:

```typescript
import { normalizeSectionText, sectionBody } from "./markdown-sections.ts";
```

Then update the two uses inside `contractViolations` — `normalize(body)` and `normalize(phrase)` become `normalizeSectionText(body)` and `normalizeSectionText(phrase)`.

- [ ] **Step 6: Run the existing contract tests to verify nothing regressed**

Run: `bun test packages/gateway/src/agents/_lib/brief-contract.test.ts`
Expected: PASS, unchanged — this is a pure move. If any test fails, the extraction changed behaviour and must be corrected, not the test.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/agents/_lib/markdown-sections.ts packages/gateway/src/agents/_lib/markdown-sections.test.ts packages/gateway/src/agents/_lib/brief-contract.ts
git commit -m "extract the shared markdown section parser"
```

---

### Task 2: Thread `omitReserved` through the fourteen renderers

Give every renderer the ability to omit its reserved sections, and export the block builders so Task 3 can call the same functions. The default call path must stay byte-identical.

**Files:**

- Modify: `packages/gateway/src/agents/_lib/render.ts` (all fourteen `render*` exports, plus `renderGaps` and the negotiate section builders)
- Create: `packages/gateway/src/agents/_lib/render.reserved.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces:
  - `export type RenderOpts = { readonly omitReserved?: boolean }`
  - every existing `renderX(brief)` gains an optional second parameter: `renderX(brief: XBrief, opts?: RenderOpts): string`
  - `export function renderGaps(gaps: GapNote[]): string` (was module-private)
  - `export function renderNegotiateSources(sources: NegotiateBrief["sources"]): string` (was module-private)
  - `export function renderNegotiateEvidenceSection(unavailableEvidence: readonly string[]): string` (new; extracted from the inline array in `renderNegotiate`)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/render.reserved.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { ExpertBrief, GapNote } from "./findings.ts";
import { renderExpert, renderGaps, renderNegotiateEvidenceSection } from "./render.ts";

const GAP: GapNote = {
  category: "empty_index",
  detail: "No items in the local index yet.",
  remediation: "Run `nimbus connector sync <service>`.",
};

const EXPERT_WITH_GAPS: ExpertBrief = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { topicOrFile: "src/x.ts" },
  ranked: [],
};

describe("renderExpert with omitReserved", () => {
  test("the default render is unchanged and carries the Gaps section", () => {
    const full = renderExpert(EXPERT_WITH_GAPS);
    expect(full).toContain("## Gaps");
    expect(full).toContain("No items in the local index yet.");
  });

  test("omitReserved suppresses the Gaps section and nothing else", () => {
    const body = renderExpert(EXPERT_WITH_GAPS, { omitReserved: true });
    expect(body).not.toContain("## Gaps");
    expect(body).not.toContain("No items in the local index yet.");
    expect(body).toContain("# Expert: src/x.ts");
    expect(body).toContain("_no people matched_");
  });

  test("omitReserved is a no-op on a brief with no gap notes", () => {
    const noGaps: ExpertBrief = { ...EXPERT_WITH_GAPS, gaps: [] };
    expect(renderExpert(noGaps, { omitReserved: true })).toBe(renderExpert(noGaps));
  });
});

describe("exported block builders", () => {
  test("renderGaps is callable directly and produces the canonical block", () => {
    expect(renderGaps([GAP])).toContain("## Gaps");
    expect(renderGaps([GAP])).toContain("No items in the local index yet.");
    expect(renderGaps([])).toBe("");
  });

  test("renderNegotiateEvidenceSection renders the unavailable-evidence list", () => {
    const section = renderNegotiateEvidenceSection(["on-call shifts"]);
    expect(section).toContain("## Evidence not available from the index");
    expect(section).toContain("- on-call shifts");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/render.reserved.test.ts`
Expected: FAIL — `renderGaps` and `renderNegotiateEvidenceSection` are not exported, and `renderExpert` takes one argument.

- [ ] **Step 3: Add `RenderOpts` and the reserved-suppression helper**

In `packages/gateway/src/agents/_lib/render.ts`, directly above the existing `renderGaps` (line 39), add:

```typescript
/**
 * `omitReserved` produces the SYNTHESIZABLE half of a brief: everything except the
 * disclosure-only sections, which `synthesize.ts` re-attaches verbatim after the model
 * has run so a rewrite cannot drop them (invariant I31).
 *
 * An optional parameter rather than a changed return type: the default call stays
 * byte-identical, so every existing render test and the brief-shape snapshot are
 * untouched by this feature.
 */
export type RenderOpts = { readonly omitReserved?: boolean };

function reserved(markdown: string, opts: RenderOpts | undefined): string {
  return opts?.omitReserved === true ? "" : markdown;
}
```

Change `renderGaps` from `function renderGaps(` to `export function renderGaps(` (line 39).

- [ ] **Step 4: Thread the option through all fourteen renderers**

Each renderer takes `opts?: RenderOpts` as its last parameter and wraps its gaps expression. The eleven that use the `[..., gaps, footer].filter(...)` shape change identically — `renderExpert` shown in full, the rest follow the same two edits (signature, and wrapping the `renderGaps(...)` call):

```typescript
export function renderExpert(brief: ExpertBrief, opts?: RenderOpts): string {
  const header = `# Expert: ${brief.query.topicOrFile}`;
  const topHeading = `## Top ${brief.ranked.length}`;
  const body =
    brief.ranked.length === 0
      ? "_no people matched_"
      : brief.ranked.map(renderExpertFinding).join("\n");
  const gaps = reserved(renderGaps(brief.gaps), opts);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", topHeading, "", body, gaps, footer].filter((s) => s !== "").join("\n");
}
```

Apply the same two edits to: `renderImpact`, `renderCatchup`, `renderGhost`, `renderConflict`, `renderHuddle`, `renderJanitor`, `renderPreflight`, `renderOwnership`, `renderDecisions`, `renderPremortem`.

`renderWhy` and `renderGlossary` use the `if (gaps !== "") lines.push(gaps)` shape; the same wrap works because a suppressed block is `""`:

```typescript
const gaps = reserved(renderGaps(brief.gaps), opts);
if (gaps !== "") lines.push(gaps);
```

- [ ] **Step 5: Extract negotiate's evidence section and thread its three reserved blocks**

In `render.ts`, change `renderNegotiateSources` (line 882) from `function` to `export function`. Add, immediately after it:

```typescript
/**
 * The unconditional list of evidence classes this agent structurally cannot measure.
 * Extracted from `renderNegotiate`'s inline array so `reserved-sections.ts` can build the
 * identical block from the identical input — the two halves of a split brief must be the
 * same function on the same data, never two renderings that could drift.
 *
 * Takes the field rather than the whole brief, matching `renderNegotiateSources(brief.sources)`
 * beside it: a whole-brief parameter would force every caller and test to construct (or cast)
 * a full `NegotiateBrief` to exercise one list.
 */
export function renderNegotiateEvidenceSection(unavailableEvidence: readonly string[]): string {
  return ["## Evidence not available from the index", "", ...unavailableEvidence.map((e) => `- ${e}`)].join(
    "\n",
  );
}
```

Then in `renderNegotiate` (line 946), change the signature to `export function renderNegotiate(brief: NegotiateBrief, opts?: RenderOpts): string` and replace the three reserved expressions:

```typescript
  const sources = reserved(renderNegotiateSources(brief.sources), opts);
  const evidence = reserved(renderNegotiateEvidenceSection(brief.unavailableEvidence), opts);
  const gaps = reserved(renderGaps(brief.gaps), opts);
```

Delete the old inline `const evidence = [...].join("\n")` array it replaces. The `.filter((s) => s !== "")` at the end of the return already drops suppressed blocks.

- [ ] **Step 6: Run the new test and every existing render test**

Run: `bun test packages/gateway/src/agents/_lib/render.reserved.test.ts packages/gateway/src/agents/_lib/render.test.ts packages/gateway/src/agents/_lib/render.why.test.ts packages/gateway/src/agents/_lib/render.premortem.test.ts packages/gateway/src/agents/_lib/render.decisions.test.ts packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS. The existing files must pass **unmodified** — if one needs editing, the default render changed and the edit is in the wrong place.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/agents/_lib/render.ts packages/gateway/src/agents/_lib/render.reserved.test.ts
git commit -m "let every renderer omit its reserved disclosure sections"
```

---

### Task 3: The reserved registry and block builder

**Files:**

- Create: `packages/gateway/src/agents/_lib/reserved-sections.ts`
- Create: `packages/gateway/src/agents/_lib/reserved-sections.test.ts`

**Interfaces:**

- Consumes: `renderGaps`, `renderNegotiateSources`, `renderNegotiateEvidenceSection`, `RenderOpts` (Task 2).
- Produces:
  - `export type ReservedBlock = { readonly heading: string; readonly markdown: string }`
  - `export const RESERVED_HEADINGS_BY_KIND: Readonly<Record<SynthInput["kind"], readonly string[]>>`
  - `export function reservedHeadingsFor(brief: SynthInput): readonly string[]`
  - `export function reservedBlocksFor(brief: SynthInput): readonly ReservedBlock[]`
  - `export function joinReserved(body: string, blocks: readonly ReservedBlock[]): string`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/reserved-sections.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { ExpertBrief, GapNote } from "./findings.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import {
  joinReserved,
  RESERVED_HEADINGS_BY_KIND,
  reservedBlocksFor,
  reservedHeadingsFor,
} from "./reserved-sections.ts";

const GAP: GapNote = { category: "empty_index", detail: "No items in the local index yet." };

const EXPERT: ExpertBrief = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { topicOrFile: "src/x.ts" },
  ranked: [],
};

describe("RESERVED_HEADINGS_BY_KIND", () => {
  test("every kind reserves the Gaps section", () => {
    for (const headings of Object.values(RESERVED_HEADINGS_BY_KIND)) {
      expect(headings).toContain("## Gaps");
    }
  });

  test("negotiate additionally reserves its two disclosure sections", () => {
    expect(RESERVED_HEADINGS_BY_KIND.negotiate).toEqual([
      "## Sources",
      "## Evidence not available from the index",
      "## Gaps",
    ]);
  });

  test("covers exactly the fourteen brief kinds", () => {
    expect(Object.keys(RESERVED_HEADINGS_BY_KIND).sort()).toEqual([
      "catchup",
      "conflict",
      "decisions",
      "expert",
      "ghost",
      "glossary",
      "huddle",
      "impact",
      "janitor",
      "negotiate",
      "ownership",
      "preflight",
      "premortem",
      "why",
    ]);
  });
});

describe("reservedBlocksFor", () => {
  test("builds the Gaps block from the brief's gap notes", () => {
    const blocks = reservedBlocksFor(EXPERT);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.heading).toBe("## Gaps");
    expect(blocks[0]?.markdown).toContain("No items in the local index yet.");
  });

  test("returns nothing for a brief with no gap notes", () => {
    expect(reservedBlocksFor({ ...EXPERT, gaps: [] })).toEqual([]);
  });
});

describe("reservedHeadingsFor", () => {
  test("reads the registry by the brief's kind", () => {
    expect(reservedHeadingsFor(EXPERT)).toEqual(["## Gaps"]);
  });
});

describe("joinReserved", () => {
  test("appends blocks after the body, separated by a blank line", () => {
    const out = joinReserved("# Brief\n\nbody\n", [{ heading: "## Gaps", markdown: "## Gaps\n\n- one" }]);
    expect(out).toBe("# Brief\n\nbody\n\n## Gaps\n\n- one");
  });

  test("returns the body untouched when there is nothing reserved", () => {
    expect(joinReserved("# Brief\n", [])).toBe("# Brief\n");
  });

  test("preserves the order blocks are given in", () => {
    const out = joinReserved("body", [
      { heading: "## Sources", markdown: "## Sources\n\na" },
      { heading: "## Gaps", markdown: "## Gaps\n\nb" },
    ]);
    expect(out.indexOf("## Sources")).toBeLessThan(out.indexOf("## Gaps"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/reserved-sections.test.ts`
Expected: FAIL — module `./reserved-sections.ts` does not exist.

- [ ] **Step 3: Create the module**

Create `packages/gateway/src/agents/_lib/reserved-sections.ts`:

```typescript
import type { SynthInput } from "./brief-kinds.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import {
  renderGaps,
  renderNegotiateEvidenceSection,
  renderNegotiateSources,
} from "./render.ts";

/** A disclosure-only section held back from the model and re-attached verbatim (I31). */
export type ReservedBlock = { readonly heading: string; readonly markdown: string };

export const GAPS_HEADING = "## Gaps";
export const NEGOTIATE_SOURCES_HEADING = "## Sources";
export const NEGOTIATE_EVIDENCE_HEADING = "## Evidence not available from the index";

/**
 * Which sections are disclosure-only, per brief kind.
 *
 * Typed as a TOTAL `Record` over the union's `kind` literals, not a lookup with a default:
 * a fifteenth brief kind is then a COMPILE error here rather than a silent empty list that
 * would hand that kind's gap notes to the model with nothing said about it.
 *
 * Per-kind rather than one global list so a future kind that legitimately wants a `##
 * Sources` section of its own is not silently gagged by `negotiate`'s reservation.
 */
export const RESERVED_HEADINGS_BY_KIND: Readonly<Record<SynthInput["kind"], readonly string[]>> =
  Object.freeze({
    expert: [GAPS_HEADING],
    impact: [GAPS_HEADING],
    catchup: [GAPS_HEADING],
    ghost: [GAPS_HEADING],
    conflict: [GAPS_HEADING],
    huddle: [GAPS_HEADING],
    janitor: [GAPS_HEADING],
    preflight: [GAPS_HEADING],
    why: [GAPS_HEADING],
    glossary: [GAPS_HEADING],
    decisions: [GAPS_HEADING],
    ownership: [GAPS_HEADING],
    premortem: [GAPS_HEADING],
    negotiate: [NEGOTIATE_SOURCES_HEADING, NEGOTIATE_EVIDENCE_HEADING, GAPS_HEADING],
  });

export function reservedHeadingsFor(brief: SynthInput): readonly string[] {
  return RESERVED_HEADINGS_BY_KIND[brief.kind];
}

/**
 * The reserved blocks for this brief, built from the brief's own data by the SAME builders
 * the renderer uses — never recovered by scanning the rendered markdown.
 *
 * That distinction is the whole point. Brief content is not trusted markdown:
 * `renderGlossaryEntry` interpolates a definition at the start of a line, and in `snippet`
 * mode that definition is quoted verbatim from an indexed Slack message or Notion page. A
 * definition containing a `## Gaps` line would make a first-match scan extract the wrong
 * region. Constructing removes the class instead of hardening a scan against it.
 *
 * A block is present only when it has content: a brief with no gap notes reserves nothing,
 * which is why `renderGaps([])` returning `""` is checked rather than assumed.
 */
export function reservedBlocksFor(brief: SynthInput): readonly ReservedBlock[] {
  const blocks: ReservedBlock[] = [];
  if (brief.kind === "negotiate") {
    const negotiate: NegotiateBrief = brief;
    blocks.push({
      heading: NEGOTIATE_SOURCES_HEADING,
      markdown: renderNegotiateSources(negotiate.sources).trim(),
    });
    blocks.push({
      heading: NEGOTIATE_EVIDENCE_HEADING,
      markdown: renderNegotiateEvidenceSection(negotiate).trim(),
    });
  }
  const gaps = renderGaps(brief.gaps).trim();
  if (gaps !== "") blocks.push({ heading: GAPS_HEADING, markdown: gaps });
  return blocks;
}

/** Body first, then each reserved block, one blank line between. Order is preserved. */
export function joinReserved(body: string, blocks: readonly ReservedBlock[]): string {
  if (blocks.length === 0) return body;
  return [body.trimEnd(), ...blocks.map((b) => b.markdown.trim())].join("\n\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/agents/_lib/reserved-sections.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/reserved-sections.ts packages/gateway/src/agents/_lib/reserved-sections.test.ts
git commit -m "add the reserved-section registry and block builder"
```

---

### Task 4: Wire the reserved path into `synthesize()`

**Files:**

- Modify: `packages/gateway/src/agents/_lib/synthesize.ts` (`deterministicRender`, `synthesize`, `SynthesisProvenance`, `SYNTHESIS_INSTRUCTIONS`, new footer)
- Modify: `packages/gateway/src/agents/_lib/synthesize.test.ts` (append new tests; change nothing existing)

**Interfaces:**

- Consumes: `RenderOpts` (Task 2); `reservedBlocksFor`, `reservedHeadingsFor`, `joinReserved` (Task 3); `stripSections` (Task 1).
- Produces: `SynthesisProvenance` gains `{ attempted: false; reason: "reserved_extraction_failed" }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/agents/_lib/synthesize.test.ts`:

```typescript
const EXPERT_WITH_GAPS: ExpertBrief = {
  ...EXPERT_FIXTURE,
  gaps: [
    {
      category: "empty_index",
      detail: "No items in the local index yet.",
      remediation: "Run `nimbus connector sync <service>`.",
    },
  ],
};

describe("synthesize — reserved disclosure sections (I31)", () => {
  test("a rewrite that omits the Gaps section still ships it verbatim", async () => {
    const runner = fixedRunner(okAttempt("# Expert\n\nA readable rewrite with no gaps section."));
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.markdown).toContain("## Gaps");
    expect(out.markdown).toContain("No items in the local index yet.");
    expect(out.provenance).toMatchObject({ attempted: true, used: true });
  });

  test("a fabricated Gaps section is stripped and the canonical one appears exactly once", async () => {
    const runner = fixedRunner(
      okAttempt("# Expert\n\nbody\n\n## Gaps\n\n- nothing is wrong at all\n"),
    );
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.markdown).not.toContain("nothing is wrong at all");
    expect(out.markdown).toContain("No items in the local index yet.");
    expect(out.markdown.match(/^## Gaps/gm)).toHaveLength(1);
  });

  test("a near-miss heading is stripped too", async () => {
    const runner = fixedRunner(okAttempt("# Expert\n\nbody\n\n## Gaps and caveats\n\n- invented\n"));
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.markdown).not.toContain("invented");
    expect(out.markdown).toContain("No items in the local index yet.");
  });

  test("the reserved sections are not in the prompt", async () => {
    const seen: string[] = [];
    const runner = capturingRunner(okAttempt("# rewritten"), seen);
    await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(seen[0]).not.toContain("## Gaps");
  });

  test("an empty rewrite is discarded, not padded out by the reserved blocks", async () => {
    const runner = fixedRunner(okAttempt("   "));
    const out = await synthesize(EXPERT_WITH_GAPS, { runner });
    expect(out.provenance).toEqual({ attempted: true, used: false, reason: "empty_result" });
    expect(out.markdown).toContain("_no people matched_");
  });

  test("a brief with no gap notes is byte-identical to before", async () => {
    const runner = fixedRunner(okAttempt("# LLM-rewritten Markdown"));
    const out = await synthesize(EXPERT_FIXTURE, { runner });
    expect(out.markdown).toBe("# LLM-rewritten Markdown\n\n_Synthesized by test-model (local)._\n");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/agents/_lib/synthesize.test.ts`
Expected: FAIL on the first four new tests — the Gaps section is currently passed to the model, so the rewrite replaces it and the disclosure is gone.

- [ ] **Step 3: Add the imports, the provenance variant and the footer**

In `packages/gateway/src/agents/_lib/synthesize.ts`, add to the imports:

```typescript
import { stripSections } from "./markdown-sections.ts";
import type { RenderOpts } from "./render.ts";
import { joinReserved, reservedBlocksFor, reservedHeadingsFor } from "./reserved-sections.ts";
```

Change the first arm of `SynthesisProvenance` (line 52):

```typescript
  | { attempted: false; reason: "disabled" | "no_eligible_provider" | "reserved_extraction_failed" }
```

Add beside the other footer helpers:

```typescript
const RESERVED_EXTRACTION_FAILED_FOOTER =
  "_Rendered deterministically — the brief's reserved disclosure sections could not be isolated, so no rewrite was attempted._";

/**
 * Label the case where a renderer did not honour `omitReserved` — a new brief kind, or a new
 * disclosure section added to an existing renderer without routing it through the flag. The
 * reserved content would otherwise have gone to the model unguarded while everything looked
 * healthy, so this path fails closed and says so. Distinct from every other footer for the
 * reason recorded on `withDeterministicFooter`: conflating these was a real defect once.
 */
function withReservedExtractionFailedFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${RESERVED_EXTRACTION_FAILED_FOOTER}\n`;
}
```

- [ ] **Step 4: Thread `opts` through `deterministicRender`**

Change `deterministicRender` (line 69) to take and forward render options:

```typescript
function deterministicRender(brief: SynthInput, opts?: RenderOpts): string {
  if (brief.kind === "expert") return renderExpert(brief, opts);
  if (brief.kind === "impact") return renderImpact(brief, opts);
  if (brief.kind === "catchup") return renderCatchup(brief, opts);
  if (brief.kind === "ghost") return renderGhost(brief, opts);
  if (brief.kind === "conflict") return renderConflict(brief, opts);
  if (brief.kind === "janitor") return renderJanitor(brief, opts);
  if (brief.kind === "preflight") return renderPreflight(brief, opts);
  if (brief.kind === "why") return renderWhy(brief, opts);
  if (brief.kind === "glossary") return renderGlossary(brief, opts);
  if (brief.kind === "decisions") return renderDecisions(brief, opts);
  if (brief.kind === "ownership") return renderOwnership(brief, opts);
  if (brief.kind === "huddle") return renderHuddle(brief, opts);
  if (brief.kind === "premortem") return renderPremortem(brief, opts);
  if (brief.kind === "negotiate") return renderNegotiate(brief, opts);
  return assertNeverBrief(brief);
}
```

- [ ] **Step 5: Split the brief, assert, and prompt with the body**

In `synthesize`, immediately after the `opts.runner === undefined` early return, insert:

```typescript
  // The synthesizable half and the reserved half, each CONSTRUCTED from the brief — never
  // recovered by parsing `deterministic`. See `reserved-sections.ts` for why that matters.
  const body = deterministicRender(brief, { omitReserved: true });
  const reservedBlocks = reservedBlocksFor(brief);

  // Fail closed if a renderer ignored `omitReserved`: identical output with reserved content
  // present means the suppression did not happen, and prompting with `body` would hand the
  // disclosure to the model. Deliberately NOT a heading scan of `body` — brief content is
  // untrusted markdown (a quoted glossary definition can contain a `## Gaps` line), and a
  // scan would switch synthesis off on the strength of what a source document happens to say.
  // Comparing two renders of the same brief tests our code and nothing else.
  if (reservedBlocks.length > 0 && body === deterministic) {
    return {
      markdown: withReservedExtractionFailedFooter(deterministic),
      provenance: { attempted: false, reason: "reserved_extraction_failed" },
    };
  }
```

Then change the prompt to use `body` in place of `deterministic`:

```typescript
    "Deterministic fallback rendering (use as a structural template — do not copy verbatim):",
    body,
```

- [ ] **Step 6: Reassemble before the contract check**

Replace the `contractViolations` block and the final return (lines 259-275) with:

```typescript
  // Strip any reserved section the model emitted anyway, then re-attach the canonical blocks.
  // The strip runs on the MODEL's markdown — untrusted, hence the shared parser — while the
  // blocks come from the brief. The contract guard then inspects the artifact the reader
  // actually receives, not an intermediate.
  const reassembled = joinReserved(
    stripSections(attempt.markdown, reservedHeadingsFor(brief)),
    reservedBlocks,
  );

  const violations = contractViolations(brief, reassembled);
  if (violations.length > 0) {
    return {
      markdown: withDiscardedSynthesisFooter(deterministic, "contract_violation"),
      provenance: {
        attempted: true,
        used: false,
        reason: "contract_violation",
        violations,
      },
    };
  }

  return {
    markdown: withProvenanceFooter(reassembled, attempt.model, attempt.remote),
    provenance: { attempted: true, used: true, model: attempt.model, remote: attempt.remote },
  };
```

Leave the `attempt.markdown.trim().length === 0` check exactly where it is, above this block. It must stay on the raw model output: after reassembly an empty rewrite would be a non-empty document consisting only of the reserved blocks, and would pass a check applied later.

- [ ] **Step 7: Update the synthesis instructions**

In `SYNTHESIS_INSTRUCTIONS` (line 278), replace the GapNote bullet with:

```typescript
  "- Do not write a `Gaps`, `Sources`, or `Evidence not available from the index` section: they are appended verbatim after your rewrite. The JSON still lists them so your prose does not contradict them.",
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/_lib/synthesize.test.ts packages/gateway/src/agents/_lib/synthesize.ownership.test.ts`
Expected: PASS, including every pre-existing test unmodified.

- [ ] **Step 9: Red-prove the guard by reverting it**

Temporarily change step 5's prompt line back from `body` to `deterministic`, then run:

Run: `bun test packages/gateway/src/agents/_lib/synthesize.test.ts`
Expected: FAIL on "a rewrite that omits the Gaps section still ships it verbatim" — proving the test detects the unguarded state rather than passing regardless.

Restore the line, re-run, confirm PASS. A guard whose test passes with the guard removed proves nothing; this step is the proof, not the green run.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/agents/_lib/synthesize.ts packages/gateway/src/agents/_lib/synthesize.test.ts
git commit -m "hold reserved disclosure sections out of synthesis and re-attach them"
```

---

### Task 5: Anti-inertness and untrusted-content tests

A registry that names a heading no renderer emits is a guard that cannot fire. These tests prove the mechanism is wired to live text, and pin the behaviour that motivated building it by construction.

**Files:**

- Create: `packages/gateway/src/agents/_lib/reserved-sections.coverage.test.ts`
- Modify: `packages/gateway/src/agents/_lib/synthesize.ts` (add the `deterministicRenderForTest` export in Step 2)

**Interfaces:**

- Consumes: everything from Tasks 2-4.
- Produces: `export const deterministicRenderForTest` (test-facing alias of the private `deterministicRender`).

- [ ] **Step 1: Write the test**

Create `packages/gateway/src/agents/_lib/reserved-sections.coverage.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { GapNote } from "./findings.ts";
import type { GlossaryBrief } from "./glossary-types.ts";
import { renderGlossary } from "./render.ts";
import { RESERVED_HEADINGS_BY_KIND, reservedBlocksFor } from "./reserved-sections.ts";
import { synthesize } from "./synthesize.ts";
import type { SynthesisAttempt, SynthesisRunner } from "./synthesis-llm.ts";

function fixedRunner(attempt: SynthesisAttempt): SynthesisRunner {
  return { run: async (_prompt: string) => attempt };
}

const GAP: GapNote = { category: "empty_index", detail: "GAP-DETAIL-SENTINEL" };

/**
 * A glossary definition quoted verbatim from an indexed source that happens to contain a
 * Markdown heading. This is the input a scan-the-rendered-markdown splitter would mis-handle.
 */
const HOSTILE_GLOSSARY: GlossaryBrief = {
  kind: "glossary",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  mode: "term",
  matchedVia: "term",
  suggestions: [],
  query: { term: "SLO" },
  entries: [
    {
      term: "SLO",
      definition: "A service level objective.\n\n## Gaps\n\n- injected by the source document",
      definitionSource: "snippet",
      docFreq: 3,
      serviceSpread: 1,
      firstSeenAt: 0,
      lastSeenAt: 0,
      synonyms: [],
      nearMisses: [],
      topSources: [],
    },
  ],
};

describe("the reserved registry is wired to text that actually renders", () => {
  test("the Gaps heading every kind reserves is the heading renderGaps emits", () => {
    const blocks = reservedBlocksFor({ ...HOSTILE_GLOSSARY, gaps: [GAP] });
    const gapsBlock = blocks.find((b) => b.heading === "## Gaps");
    expect(gapsBlock?.markdown.startsWith("## Gaps")).toBe(true);
  });

  test("every registry entry is a level-2 heading", () => {
    for (const headings of Object.values(RESERVED_HEADINGS_BY_KIND)) {
      for (const h of headings) {
        expect(h.startsWith("## ")).toBe(true);
        expect(h.startsWith("### ")).toBe(false);
      }
    }
  });
});

describe("untrusted brief content cannot break extraction", () => {
  test("a definition containing a `## Gaps` line does not suppress synthesis", async () => {
    const runner = fixedRunner({
      ok: true,
      markdown: "# Glossary\n\nSLO means a service level objective.",
      model: "test-model",
      remote: false,
    });
    const out = await synthesize(HOSTILE_GLOSSARY, { runner });

    // Synthesis ran — it was not refused by a false extraction failure.
    expect(out.provenance).toMatchObject({ attempted: true, used: true });
    // The real gap note survived, exactly once.
    expect(out.markdown).toContain("GAP-DETAIL-SENTINEL");
    expect(out.markdown.match(/^## Gaps/gm)).toHaveLength(1);
  });

  test("the deterministic render is untouched by any of this", () => {
    const full = renderGlossary(HOSTILE_GLOSSARY);
    expect(full).toContain("GAP-DETAIL-SENTINEL");
    expect(full).toContain("injected by the source document");
  });
});
```

- [ ] **Step 2: Add the all-fourteen-kinds table test**

One `expert` fixture proves the wiring for `expert`. The risk this task exists to close is a
renderer that accepts `RenderOpts` and ignores it — which compiles, and which the runtime
assertion only catches once someone runs that agent. Cover every kind at test time instead.

Append to the same file:

```typescript
import type { SynthInput } from "./brief-kinds.ts";
import { deterministicRenderForTest } from "./synthesize.ts";

/**
 * One minimal brief per kind, each carrying the SAME sentinel gap note.
 *
 * Build each from its type — `findings.ts` for expert / impact / catchup / ghost / conflict /
 * huddle / janitor / preflight, and `{why,glossary,decisions,ownership,premortem,negotiate}-types.ts`
 * for the rest. `render.test.ts`, `render.why.test.ts`, `render.premortem.test.ts` and
 * `render.decisions.test.ts` already contain valid fixtures for most kinds — copy from those
 * rather than inventing field values, and add the sentinel gap note to each. Do NOT reach for
 * a cast to satisfy the compiler: a fixture that is not a real brief proves nothing about a
 * real one.
 */
const ALL_KINDS: readonly SynthInput[] = [
  /* expert, impact, catchup, ghost, conflict, huddle, janitor, preflight,
     why, glossary, decisions, ownership, premortem, negotiate */
];

describe("every renderer honours omitReserved", () => {
  test("the table covers all fourteen kinds exactly once", () => {
    expect(ALL_KINDS).toHaveLength(14);
    expect(new Set(ALL_KINDS.map((b) => b.kind)).size).toBe(14);
  });

  for (const brief of ALL_KINDS) {
    test(`${brief.kind}: the full render carries the Gaps section and the body does not`, () => {
      const full = deterministicRenderForTest(brief);
      const body = deterministicRenderForTest(brief, { omitReserved: true });
      expect(full).toContain("## Gaps");
      expect(full).toContain("GAP-DETAIL-SENTINEL");
      expect(body).not.toContain("## Gaps");
      expect(body).not.toContain("GAP-DETAIL-SENTINEL");
      expect(body).not.toBe(full);
    });
  }

  test("negotiate also withholds its two other reserved sections", () => {
    const negotiate = ALL_KINDS.find((b) => b.kind === "negotiate");
    if (negotiate === undefined) throw new Error("negotiate fixture missing from ALL_KINDS");
    const body = deterministicRenderForTest(negotiate, { omitReserved: true });
    expect(body).not.toContain("## Sources");
    expect(body).not.toContain("## Evidence not available from the index");
    expect(deterministicRenderForTest(negotiate)).toContain("## Sources");
  });
});
```

This needs `deterministicRender` to be reachable from a test. In
`packages/gateway/src/agents/_lib/synthesize.ts`, export it under a test-facing alias beside
the existing definition rather than making the private helper public:

```typescript
/** Test-only re-export: the all-kinds `omitReserved` table test in
 *  `reserved-sections.coverage.test.ts` must exercise the real dispatch, not a copy of it. */
export const deterministicRenderForTest = deterministicRender;
```

- [ ] **Step 3: Run the tests**

Run: `bun test packages/gateway/src/agents/_lib/reserved-sections.coverage.test.ts`
Expected: PASS, 14 per-kind tests plus the four others. If `GlossaryBrief` or `GlossaryEntry`
requires fields not listed in the hostile fixture, add them from `glossary-types.ts` rather
than casting.

- [ ] **Step 4: Red-prove the table**

Pick any one renderer — `renderPremortem` is a good choice, being the most recently added —
and temporarily revert its gaps line from `reserved(renderGaps(brief.gaps), opts)` back to
`renderGaps(brief.gaps)`.

Run: `bun test packages/gateway/src/agents/_lib/reserved-sections.coverage.test.ts`
Expected: FAIL on `premortem: the full render carries the Gaps section and the body does not`,
and on nothing else. That single-kind failure is the proof the table has per-kind resolution
rather than passing on one representative. Restore the line and re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/reserved-sections.coverage.test.ts packages/gateway/src/agents/_lib/synthesize.ts
git commit -m "prove every renderer honours omitReserved and hostile content is harmless"
```

---

### Task 6: Record invariant I31

**Files:**

- Modify: `docs/SECURITY-INVARIANTS.md` (new I31 section; trim the I29 honesty clause; renumber the worked example at line 677)
- Modify: `packages/gateway/src/security-invariants.test.ts` (new I31 describe block)
- Modify: `CLAUDE.md` (I31 bullet; roster line; I29 bullet trim)
- Modify: `GEMINI.md` (identical edits — these two must stay mirrored)
- Modify: `docs/roadmap.md:918` (the A0 entry's coverage claim)
- Modify: `docs/CHANGELOG.md`

**Interfaces:**

- Consumes: everything from Tasks 2-4.
- Produces: nothing.

- [ ] **Step 1: Write the failing invariant test**

Append to `packages/gateway/src/security-invariants.test.ts`:

```typescript
describe("I31 — disclosure integrity: a synthesized brief never says less than the deterministic one", () => {
  test("I31: a rewrite that drops every reserved section still ships them", async () => {
    const { synthesize } = await import("./agents/_lib/synthesize.ts");
    const brief = {
      kind: "expert" as const,
      agentVersion: 1,
      generatedAt: 0,
      latencyMs: 0,
      gaps: [{ category: "empty_index" as const, detail: "I31-DISCLOSURE-SENTINEL" }],
      query: { topicOrFile: "src/x.ts" },
      ranked: [],
    };
    const runner = {
      run: async (_prompt: string) => ({
        ok: true as const,
        markdown: "# Expert\n\nEverything is fine and nothing is missing.",
        model: "test-model",
        remote: false,
      }),
    };
    const out = await synthesize(brief, { runner });
    expect(out.markdown).toContain("I31-DISCLOSURE-SENTINEL");
  });

  test("I31: the reserved registry is total over the brief union", async () => {
    // A fifteenth brief kind must be a compile error in `reserved-sections.ts`, not a silent
    // empty list. The runtime half of that claim: the registry has one entry per kind the
    // synthesize dispatch handles.
    const { RESERVED_HEADINGS_BY_KIND } = await import("./agents/_lib/reserved-sections.ts");
    const src = await read("packages/gateway/src/agents/_lib/synthesize.ts");
    const dispatched = [...src.matchAll(/brief\.kind === "([a-z]+)"/g)].map((m) => m[1]);
    const kinds = new Set(dispatched);
    expect(Object.keys(RESERVED_HEADINGS_BY_KIND).sort()).toEqual([...kinds].sort());
  });

  test("I31: reserved blocks are constructed, never recovered by parsing the render", async () => {
    // The anti-pattern this invariant forbids. `reserved-sections.ts` must not scan rendered
    // markdown for its own headings — that is what makes untrusted brief content harmless.
    const src = await read("packages/gateway/src/agents/_lib/reserved-sections.ts");
    expect(src).not.toContain("sectionBody");
    expect(src).not.toContain("stripSections");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t I31`
Expected: FAIL if the wiring from Tasks 2-4 is incomplete; PASS once it is. Confirm the first test genuinely fails against unguarded code by temporarily reverting the prompt line as in Task 4 Step 9.

Note: `read()` is the existing helper in this file — check its definition near the top and match how neighbouring tests call it.

- [ ] **Step 3: Add the I31 section to `docs/SECURITY-INVARIANTS.md`**

Add a `## I31 — Disclosure integrity` section after the I30 section, containing:

- **Statement:** a brief that reaches a reader never says less than the deterministic render promised. Reserved disclosure sections are constructed by the renderer and re-attached verbatim, never passed through the model; a rewrite that drops one is discarded in favour of the deterministic brief; if the reserved set cannot be isolated, no rewrite is attempted.
- **Wiring site:** `packages/gateway/src/agents/_lib/synthesize.ts` `synthesize()`, the sole place a brief's final markdown is produced. Supporting modules: `reserved-sections.ts` (registry + builders), `markdown-sections.ts` (the one parser), `brief-contract.ts` (the phrase layer).
- **Anti-patterns:** rendering a disclosure section into the synthesizable body instead of routing it through `omitReserved`; adding a brief kind without a `RESERVED_HEADINGS_BY_KIND` entry; recovering reserved blocks by scanning rendered markdown instead of constructing them; an anchor phrase that ordinary prose can satisfy.
- **Compliance recipe:** a new disclosure that is a whole section goes in the registry and through `omitReserved`; a new interleaved disclosure goes through the Layer 2 constants (PR 2).
- **Known bound, stated not hidden:** the strip step runs on the model's output and cannot tell a hallucinated `## Gaps` from one faithfully echoed out of quoted brief content, so a synthesized brief may drop a fragment of a quoted definition that happens to contain a reserved heading. This can only lose quoted body text, never a disclosure, and never affects the deterministic brief.

- [ ] **Step 4: Trim the I29 clause and renumber the worked example**

In `docs/SECURITY-INVARIANTS.md`:

1. In the I29 section, delete the sentence describing the `requiredPhrases` honesty guard and its negotiate-only coverage. Replace it with a one-line cross-reference: the honesty guard is invariant I31.
2. At line 677, the worked example "how to add an invariant" uses `I31` as its illustrative next-free number for a hypothetical sub-agent-scope defense. Change every `I31` in that example to `I32`, and update its parenthetical to read "the next free number after the current ceiling `I31`; note `I28` is reserved, not free". A how-to that names a number already in use is exactly the drift this file exists to prevent.

- [ ] **Step 5: Mirror the bullets into `CLAUDE.md` and `GEMINI.md`**

In **both** files, identically:

1. Change the roster line "Invariants through I30 (I28 reserved); schema V53" to "Invariants through I31 (I28 reserved); schema V53".
2. Change "Each live invariant (I1–I27, I29, I30)" to "Each live invariant (I1–I27, I29–I31)".
3. In the I29 bullet, delete the trailing clause beginning "A `requiredPhrases` honesty guard discards…" through "…is not yet protected", and its `agents/_lib/brief-contract.ts` file reference.
4. Add an I31 bullet after I30:

```markdown
- **I31** — disclosure integrity: a synthesized brief never says less than the deterministic render promised. Disclosure-only sections (`## Gaps` for all fourteen brief kinds, plus `negotiate`'s `## Sources` and `## Evidence not available from the index`) are CONSTRUCTED by the renderer and re-attached verbatim, never passed to the model — so a rewrite cannot drop them, by construction rather than by check; a reserved section the model invents anyway is stripped before re-attachment; and if a renderer fails to honour `omitReserved`, no rewrite is attempted at all (fail-closed). Interleaved disclosures that cannot be held back are checked by anchor phrase against constants shared with the render sites · `agents/_lib/{synthesize,reserved-sections,markdown-sections,brief-contract}.ts`
```

- [ ] **Step 6: Update the roadmap and changelog**

In `docs/roadmap.md:918` (the A0 delivered entry), replace the passage stating that `requiredPhrases` "guards only `negotiate`'s seven null-lane disclaimers" and that every other kind "is **not yet protected**" with the current state: whole-section disclosures are now structurally protected across all fourteen kinds under invariant I31, and the remaining interleaved disclosures are PR 2's scope. Do not delete the honesty accounting — narrow it to what is still true.

Add a `docs/CHANGELOG.md` entry under the current unreleased heading describing the change and naming I31.

- [ ] **Step 7: Verify the mirrored files did not drift**

Run: `bun run audit:status-drift && bun run audit:doc-refs && bun run audit:invariants`
Expected: PASS on all three. `audit:status-drift` is the gate that holds `CLAUDE.md` and `GEMINI.md` in agreement; `audit:doc-refs` checks the file paths cited in the new I31 prose actually exist; `audit:invariants` is the static structure auditor that runs ahead of the test suite.

- [ ] **Step 8: Commit**

```bash
git add docs/SECURITY-INVARIANTS.md packages/gateway/src/security-invariants.test.ts CLAUDE.md GEMINI.md docs/roadmap.md docs/CHANGELOG.md
git commit -m "record disclosure integrity as invariant I31"
```

---

### Task 7: Full verification

**Files:** none modified unless a gate fails.

- [ ] **Step 1: Run the whole agents test tree**

Run: `bun test packages/gateway/src/agents`
Expected: PASS, no test file edited that this plan did not name.

- [ ] **Step 2: Confirm the brief-shape snapshot did NOT change**

Run: `bun test scripts/agent-brief-shape.test.ts`
Expected: PASS without regenerating. The default render is byte-identical and a new `reason` string value does not alter a `path:type` signature. If it fails, stop and read the diff — a shape change here is a real wire-contract change for `@nimbus-dev/client`, not a snapshot to refresh.

- [ ] **Step 3: Run the static gates**

Run: `bun run preflight:fast`
Expected: PASS. Do not pipe the output through `head`/`tail` — a pipe masks the exit code and has reported "exit 0" over a failing preflight before.

- [ ] **Step 4: Run the Linux-authoritative coverage gate**

Run: `bun run verify:docker`
Expected: PASS, including `audit:coverage-floor` for the three new source files (`markdown-sections.ts`, `reserved-sections.ts`, and the changed regions of `render.ts` / `synthesize.ts`) at ≥85% line and ≥80% branch. The coverage floor is CI-Linux-authoritative; a local pass is not evidence.

- [ ] **Step 5: Full preflight**

Run: `bun run preflight`
Expected: PASS.

- [ ] **Step 6: Open the PR**

The PR title is the commit message — put the conventional-commit type there, and the reasoning in the description:

- Title: `feat(agents): hold brief disclosure sections out of LLM synthesis (I31)`
- Description: the problem (A0 shipped synthesis default-on with the honesty guard covering 1 of 14 kinds), the approach (construct, don't parse), what is closed (both 0.86 ceilings, every truncation count, the ownership accountability disclaimer), what remains (PR 2, the seven interleaved disclosures), and a link to the spec.
- Check the description for unbalanced parentheses before opening — an unbalanced `(` in a PR body has silently dropped commits from the generated changelog twice.

---

## Self-Review

**Spec coverage.** Layer 1 of the spec maps to Tasks 1-5; the invariant section maps to Task 6; the documentation section maps to Task 6 Steps 3-6; the testing section maps to Tasks 1-5 plus Task 7. The spec's Layer 2 (`brief-disclosures.ts`, the seven interleaved disclosures, the anchor table) is explicitly out of scope here and stated as such in Global Constraints — it needs its own plan after this lands.

**Deferred items carried forward to PR 2's plan:** the anchor table; the "anchors are not satisfiable by ordinary prose" test; the incidents/decisions independence test; an accepted-paraphrase test proving a rewrite that *keeps* an anchor passes (so the guard is not merely rejecting everything); and the glossary list-mode `— authored` suffix (deferred in the spec with its mechanical reason).

**Considered and deliberately not planned:** a static `D`-rule in `scripts/structure-audit/check-nimbus-invariants.ts` asserting registry completeness and `RenderOpts` on every renderer. Half of it is already stronger at compile time — `RESERVED_HEADINGS_BY_KIND` is a total `Record` over `SynthInput["kind"]`, so a fifteenth kind fails to compile, which no source scan can beat. The other half (a renderer that accepts `RenderOpts` and ignores it) is not expressible as a signature scan at all, and is covered directly by Task 5's per-kind table plus the runtime fail-closed assertion.

**Type consistency.** `RenderOpts` is defined in Task 2 and consumed in Task 4. `ReservedBlock`, `RESERVED_HEADINGS_BY_KIND`, `reservedBlocksFor`, `reservedHeadingsFor` and `joinReserved` are defined in Task 3 and consumed in Task 4. `normalizeSectionText`, `sectionBody` and `stripSections` are defined in Task 1 and consumed in Tasks 1 and 4. `reserved_extraction_failed` is introduced once, in Task 4 Step 3, and used once, in Task 4 Step 5.
