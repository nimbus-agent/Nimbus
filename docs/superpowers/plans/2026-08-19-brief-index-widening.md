# Brief Index Widening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a research brief draw on every indexed item type — pull requests, builds, issues, docs — instead of only `web_clip`, and make each citation say what kind of thing it is.

**Architecture:** The search widening is a deletion: `IndexSearchQuery.itemType` is optional, so dropping it from the brief search in `assemble.ts` searches everything through the same hybrid path. The real work is the citation shape — `SourceRef` gains two *additive* optional fields (`itemType`, `itemId`) while `kind` and `clipId` keep their current meanings, so already-saved briefs stay true and the two repos can land in either order.

**Tech Stack:** TypeScript (strict), Bun runtime, `bun:test`, Biome. SQLite-backed local index with BM25 + vector hybrid search.

**Spec:** `docs/superpowers/specs/2026-08-19-brief-index-widening-design.md`

## Global Constraints

- **`kind` keeps exactly two members** — `"source" | "clip"`. Never add a third. It is persisted in saved `research_brief` items; a new member fails validation in readers that predate it.
- **`clipId` is populated only for `nimbus:web_clip` hits.** Its docblock says it is a clip id; a PR id in that field is a lie `brief-save.ts` would persist.
- **`itemType` is an arbitrary string, never an enum.** Connectors are added independently; an enum breaks on somebody else's release.
- **`MAX_INDEX_HITS` stays 8.** Out of scope for this plan.
- **Gap copy keeps its three-way split** — search-failed / no-hits / keyword-only must stay separately distinguishable. Only the noun changes.
- **No `any`.** TypeScript strict; use `unknown` plus a guard at boundaries.
- Gates: `bun run typecheck`, `bun run lint`, `bun test packages/gateway`.

---

### Task 1: The citation shape carries a type and a generic id

**Files:**
- Modify: `packages/gateway/src/briefs/brief-types.ts:2-10` (`SourceRef`)
- Modify: `packages/gateway/src/briefs/brief-registry.ts:4-9` (`IndexHit`), `:79-92` (the `C{n}` loop)
- Test: `packages/gateway/src/briefs/brief-registry.test.ts`

**Interfaces:**
- Consumes: nothing — first task.
- Produces: `IndexHit.itemType: string` (**required**, not optional — the producer always knows it); `SourceRef.itemType?: string`; `SourceRef.itemId?: string`. Task 2 supplies `itemType` from `assemble.ts`; Task 5 may read it in the prompt.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/briefs/brief-registry.test.ts` inside `describe("buildRegistry", …)`:

```ts
  test("a non-clip index hit gets itemId and itemType, and NO clipId", async () => {
    const { registry } = await buildRegistry(runWith(true, ["a"]), async () => ({
      hits: [
        {
          itemId: "nimbus:pull_request:acme/web/482",
          itemType: "pull_request",
          title: "Drop the legacy worker pool",
          url: "https://github.test/acme/web/pull/482",
          snippet: "the pool is replaced by",
        },
      ],
      semanticAvailable: true,
    }));
    const ref = registry.get("C1")?.ref;
    expect(ref?.kind).toBe("clip");
    expect(ref?.itemType).toBe("pull_request");
    expect(ref?.itemId).toBe("nimbus:pull_request:acme/web/482");
    // The whole point: `clipId` says "clip", so a PR must not claim one.
    expect(ref?.clipId).toBeUndefined();
  });

  test("a web_clip index hit still gets clipId, plus the new fields", async () => {
    const { registry } = await buildRegistry(runWith(true, ["a"]), async () => ({
      hits: [
        {
          itemId: "nimbus:clip:aa",
          itemType: "web_clip",
          title: "Saved",
          url: "https://z.test",
          snippet: "snip",
        },
      ],
      semanticAvailable: true,
    }));
    const ref = registry.get("C1")?.ref;
    expect(ref?.clipId).toBe("nimbus:clip:aa");
    expect(ref?.itemId).toBe("nimbus:clip:aa");
    expect(ref?.itemType).toBe("web_clip");
  });

  test("an itemType this build has never heard of is carried through verbatim", async () => {
    const { registry } = await buildRegistry(runWith(true, ["a"]), async () => ({
      hits: [
        {
          itemId: "nimbus:slack_message:C123/1699",
          itemType: "slack_message",
          title: "standup",
          url: null,
          snippet: "we are blocked on",
        },
      ],
      semanticAvailable: true,
    }));
    // Connectors land upstream on their own schedule. Never an enum.
    expect(registry.get("C1")?.ref.itemType).toBe("slack_message");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/briefs/brief-registry.test.ts`
Expected: FAIL. The new fixtures pass `itemType` to a type that has no such property, so this fails at typecheck/compile before any assertion runs.

- [ ] **Step 3: Widen the two types**

In `packages/gateway/src/briefs/brief-types.ts`, replace the `SourceRef` declaration:

```ts
/** A validated citation. `quote`, when present, is a span taken from the cited body. */
export type SourceRef = {
  /**
   * `"source"` = a page the client fed. `"clip"` = an item from the user's INDEX —
   * historically only clips, hence the name, which is kept because it is persisted
   * in every saved `research_brief`. Read `itemType` for what the item actually is.
   */
  kind: "source" | "clip";
  title: string;
  url?: string;
  /**
   * The `nimbus:clip:<sha256>` item id. Present only for a `nimbus:web_clip` hit —
   * NOT for every kind: "clip" ref. A non-clip index hit sets `itemId` and leaves
   * this absent, so a reader that trusts the name is never lied to.
   */
  clipId?: string;
  /** The index item id for ANY indexed hit, whatever its type. */
  itemId?: string;
  /** The indexed item's type, verbatim. Arbitrary string — never validated as an enum. */
  itemType?: string;
  /** <= MAX_QUOTE_CHARS, verbatim from the cited body (see quote-verify.ts). */
  quote?: string;
};
```

In `packages/gateway/src/briefs/brief-registry.ts`, replace the `IndexHit` declaration:

```ts
export type IndexHit = {
  readonly itemId: string;
  /** The item's type, e.g. `web_clip`, `pull_request`. Required: the producer always knows it. */
  readonly itemType: string;
  readonly title: string;
  readonly url: string | null;
  readonly snippet: string;
};
```

- [ ] **Step 4: Populate the new fields**

In `packages/gateway/src/briefs/brief-registry.ts`, replace the body of the `for (const hit of hits)` loop:

```ts
  for (const hit of hits) {
    m += 1;
    const token = `C${m}`;
    registry.set(token, {
      token,
      ref: {
        kind: "clip",
        title: clipTitle(hit.title),
        itemId: hit.itemId,
        itemType: hit.itemType,
        // `clipId` is the NARROW, legacy field: only a real clip may claim it.
        ...(hit.itemType === "web_clip" ? { clipId: hit.itemId } : {}),
        ...(hit.url === null ? {} : { url: clipUrl(hit.url) }),
      },
      body: hit.snippet,
    });
  }
```

- [ ] **Step 5: Fix the pre-existing fixtures through one helper**

`itemType` is required, so every existing `IndexHit` literal in the test file no longer compiles. Do **not** hand-edit each one — add a single factory at the top of the file and route the literals through it, so the next required field is a one-line change instead of a sweep:

```ts
function mockHit(overrides: Partial<IndexHit> = {}): IndexHit {
  return {
    itemId: "nimbus:clip:aa",
    itemType: "web_clip",
    title: "Saved",
    url: "https://z.test",
    snippet: "snip",
    ...overrides,
  };
}
```

Import the type for it: `import type { IndexHit } from "./brief-registry.ts";`

Then rewrite the existing hit literals as `mockHit(...)` calls — in `"adds index hits as C1..Cm with clip citations"`, `"caps index hits at MAX_INDEX_HITS"` (its `Array.from` becomes `mockHit({ itemId: \`nimbus:clip:${i}\`, title: \`C${i}\`, url: null, snippet: "s" })`), and any other the compiler flags. Search for `itemId:` to find them all.

Leave the three tests you wrote in Step 1 as explicit literals: they are *about* the field combinations, so spelling each one out is the point.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/briefs/brief-registry.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 7: Typecheck the whole gateway**

Run: `bun run typecheck`
Expected: PASS. If `assemble.ts` errors because its `IndexSearch` no longer satisfies the type, leave it — Task 2 fixes it. Note the error and continue.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/briefs/brief-types.ts packages/gateway/src/briefs/brief-registry.ts packages/gateway/src/briefs/brief-registry.test.ts
git commit -m "feat(briefs): a citation can say what kind of item it cites"
```

---

### Task 2: The brief search stops filtering to web_clip

**Files:**
- Modify: `packages/gateway/src/platform/assemble.ts:1997-2016`
- Test: `packages/gateway/src/briefs/brief-registry.test.ts` (already covers the mapping); typecheck is the real gate here

**Interfaces:**
- Consumes: `IndexHit.itemType` from Task 1.
- Produces: a `briefSearch` that returns hits of every type.

> **Do NOT write `h.itemType ?? "unknown"`.** `RankedIndexItem` extends `NimbusItem`, whose
> `itemType: ItemType` is **required and non-nullable** (`@nimbus-dev/sdk/dist/types.d.ts:14`),
> and `rowToRankedItem` builds it unconditionally from `String(row.type)`
> (`local-index.ts:161,179`) — `String()` cannot yield null or undefined. A fallback here
> would be dead code that fabricates a type value, and the SDK is explicit about why that is
> worse than nothing: *"The one thing consumers must never do is rewrite an unrecognised type
> to a recognised one — that is data corruption"* (`item-types.ts:18-21`). A fabricated
> `"unknown"` would also reach the clipper's UI and render as a real type label.
>
> Note also that `RankedIndexItem` carries **two** identical type fields — `itemType` from
> `NimbusItem` and its own `indexedType`, both `String(row.type)`. Use `itemType`: it is the
> SDK-canonical name and the one `IndexHit` mirrors. They are the same value; do not "fix"
> one to the other later.

- [ ] **Step 1: Drop the filter and map the type through**

In `packages/gateway/src/platform/assemble.ts`, replace the `briefSearch` definition:

```ts
  const briefSearch: IndexSearch = async (query, limit) => {
    // NO itemType filter: a brief draws on the whole index. `IndexSearchQuery.itemType`
    // is optional and the SQL applies it only when set, so omitting it is the widening.
    const hits = await localIndex.searchRankedAsync(
      { name: query, limit },
      { semantic: true, contextChunks: 2 },
    );
    return {
      // NOTE: RankedIndexItem extends the SDK's NimbusItem, whose title field is `name`
      // — there is no `title` and no `body_preview` on it (see index/ranked-item.ts and
      // @nimbus-dev/sdk types.d.ts). The only body text available here is the matched
      // chunk in `semanticSnippet`, which is absent on the BM25 fallback path.
      hits: hits.map((h) => ({
        itemId: h.indexPrimaryKey,
        itemType: h.itemType,
        title: h.name,
        url: h.url ?? h.canonicalUrl ?? null,
        snippet: h.semanticSnippet ?? h.name,
      })),
      // A hit with no vectorRank anywhere means the hybrid path did not run.
      semanticAvailable: hits.some((h) => h.vectorRank !== undefined && h.vectorRank !== null),
    };
  };
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors. This is the gate: it proves `RankedIndexItem.itemType` exists and satisfies `IndexHit.itemType`.

- [ ] **Step 3: Run the brief suite**

Run: `bun test packages/gateway/src/briefs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(briefs): search the whole index, not only web clips"
```

---

### Task 3: The gap copy stops saying "clips" about a search that is not only clips

**Files:**
- Modify: `packages/gateway/src/briefs/brief-gaps.ts:33-50`
- Test: `packages/gateway/src/briefs/brief-gaps.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — pure string change.
- Produces: three reworded gap strings. The clipper matches gaps by equality only against `synthesis.disclosure`, so nothing downstream pins these.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/briefs/brief-gaps.test.ts` inside `describe("buildServerGaps", …)`:

```ts
  test("the index gaps describe the whole index, not only clips", () => {
    const failed = buildServerGaps({ ...base, useIndex: true, searchFailed: true });
    const empty = buildServerGaps({ ...base, useIndex: true, indexHits: 0 });
    const keyword = buildServerGaps({
      ...base,
      useIndex: true,
      indexHits: 3,
      semanticAvailable: false,
    });
    for (const g of [...failed, ...empty, ...keyword]) {
      expect(g.toLowerCase()).not.toContain("saved clips");
    }
  });

  test("a broken search and an empty result stay DIFFERENT statements", () => {
    const failed = buildServerGaps({ ...base, useIndex: true, searchFailed: true }).join(" ");
    const empty = buildServerGaps({ ...base, useIndex: true, indexHits: 0 }).join(" ");
    expect(failed).not.toEqual(empty);
    // Only one of these is the user's problem, and it is not the empty one.
    expect(failed).toContain("error");
    expect(empty.toLowerCase()).toContain("matched");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/briefs/brief-gaps.test.ts`
Expected: FAIL on the first test — the current strings contain "saved clips".

- [ ] **Step 3: Reword the three strings**

In `packages/gateway/src/briefs/brief-gaps.ts`, replace the `if (input.useIndex)` block:

```ts
  if (input.useIndex) {
    if (input.searchFailed) {
      // NEVER launder a broken index into "your corpus had nothing relevant". They are
      // completely different statements and only one of them is the user's problem.
      gaps.push(
        "Your index could not be searched (the local index returned an error), so this report draws only on the sources you selected.",
      );
    } else if (input.indexHits === 0) {
      gaps.push(
        "Nothing in your index matched this question, so the report draws only on the sources you selected.",
      );
    } else if (!input.semanticAvailable) {
      gaps.push(
        "Index recall was keyword-only (semantic search unavailable); relevant indexed items may be under-represented.",
      );
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/briefs/brief-gaps.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/briefs/brief-gaps.ts packages/gateway/src/briefs/brief-gaps.test.ts
git commit -m "fix(briefs): the index gaps no longer say clips about the whole index"
```

---

### Task 4: A mixed-type brief survives end to end

**Files:**
- Modify: `packages/gateway/src/briefs/brief-test-server.ts`
- Test: `packages/gateway/src/briefs/brief-e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: the compatibility guarantee the clipper's spec depends on.

- [ ] **Step 1: Read the harness before changing it**

Run: `grep -n "web_clip\|IndexSearch\|search" packages/gateway/src/briefs/brief-test-server.ts`

The test server injects the `IndexSearch` the e2e run uses. Note how it builds hits; you are adding `itemType` to those literals and making at least two of them differ.

- [ ] **Step 2: Write the failing test**

Add to `packages/gateway/src/briefs/brief-e2e.test.ts`, following the file's existing run-a-brief pattern (reuse its helper for create → sources → run → poll rather than hand-rolling a second one):

```ts
  test("a brief whose index hits span several types cites each with its own itemType", async () => {
    // Two DIFFERENT types, one of them unknown to this build, plus a real clip.
    const hits = [
      {
        itemId: "nimbus:pull_request:acme/web/482",
        itemType: "pull_request",
        title: "Drop the legacy worker pool",
        url: "https://github.test/acme/web/pull/482",
        snippet: "the pool is replaced by a bounded queue",
      },
      {
        itemId: "nimbus:slack_message:C123/1699",
        itemType: "slack_message",
        title: "standup",
        url: null,
        snippet: "we are blocked on the worker pool",
      },
      {
        itemId: "nimbus:clip:aa",
        itemType: "web_clip",
        title: "Bounded queues",
        url: "https://z.test",
        snippet: "a bounded queue drops work",
      },
    ];
    const report = await runBriefWithIndexHits(hits); // harness helper from Step 3
    const cited = report.findings.flatMap((f) => f.citations).filter((c) => c.kind === "clip");
    const types = new Set(cited.map((c) => c.itemType));
    expect(types.size).toBeGreaterThan(1);
    // The unknown type is carried, not dropped and not rejected.
    expect(cited.some((c) => c.itemType === "slack_message")).toBe(true);
    // Only the real clip claims clipId.
    for (const c of cited) {
      if (c.itemType !== "web_clip") expect(c.clipId).toBeUndefined();
    }
  });
```

- [ ] **Step 3: Teach the harness to serve typed hits**

In `brief-test-server.ts`, add `itemType` to every hit literal it already builds, and expose the helper the test above calls — a function that starts the server with a given hit list injected as its `IndexSearch`, runs one brief through create → sources → run → poll, and returns the finished `Report`. Name it `runBriefWithIndexHits(hits: IndexHit[]): Promise<Report>` and export it from the test server module so the e2e file imports it rather than redefining the flow.

Both names in that signature are types this file may not yet import. Add whichever are missing before writing the function, or the harness fails to compile:

```ts
import type { IndexHit } from "./brief-registry.ts";
import type { Report } from "./brief-types.ts";
```

Import the e2e side too: `brief-e2e.test.ts` needs `runBriefWithIndexHits` imported from the test server module.

- [ ] **Step 4: Run the e2e suite**

Run: `bun test packages/gateway/src/briefs/brief-e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun test packages/gateway`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/briefs/brief-test-server.ts packages/gateway/src/briefs/brief-e2e.test.ts
git commit -m "test(briefs): a mixed-type index brief keeps every type it cited"
```

---

### Task 5 (GATED — may end in "no change"): does the model use the type?

Decision 4 of the spec refuses to assume. This task **measures first** and is allowed to end with nothing shipped; that is a successful outcome, not a failed task.

**Files:**
- Modify (only if the measurement says so): `packages/gateway/src/briefs/brief-synthesis.ts:46-53`
- Test: `packages/gateway/src/briefs/brief-synthesis.test.ts`

**Interfaces:**
- Consumes: `SourceRef.itemType` from Task 1.
- Produces: either a `type` key on the prompt's per-source object, or a recorded decision not to add one.

- [ ] **Step 1: Write the prompt-shape test**

```ts
  test("the prompt names each index hit's type when the type is known", () => {
    // Shape is fixed by the spec: ONE key, raw itemType, absent for S{n} entries.
    const prompt = buildPrompt(run, registryWithTypedHit("pull_request"));
    expect(prompt).toContain('"type":"pull_request"');
    // A fed source is the user's own page and needs no type to be understood.
    expect(prompt).not.toMatch(/"token":"S1"[^}]*"type"/);
  });
```

Build `run` and `registryWithTypedHit` with the same `BriefRunController` pattern `brief-registry.test.ts` uses; do not invent a new fixture style.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/briefs/brief-synthesis.test.ts`
Expected: FAIL — no `type` key is emitted today.

- [ ] **Step 3: Add the key**

In `buildPrompt`, replace the `sources` map:

```ts
  const sources = [...registry.values()].map((e) => ({
    token: e.token,
    ...(e.ref.itemType === undefined ? {} : { type: e.ref.itemType }),
    title: e.ref.title,
    url: e.ref.url ?? null,
    text: e.body,
  }));
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/briefs/brief-synthesis.test.ts`
Expected: PASS.

- [ ] **Step 5: Judge whether it earns its tokens — then decide**

Run the full brief suite and read what changed: `bun test packages/gateway/src/briefs`

**Keep it** if attribution behaviour improves or is unchanged and the added prompt cost is a single short key per index hit (it is). **Revert it** — `git checkout packages/gateway/src/briefs/brief-synthesis.ts` and delete the test — if any synthesis test regresses. Write the outcome, either way, into the spec's decision 4 as a status line so the next reader knows it was measured rather than assumed.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/briefs/ docs/superpowers/specs/2026-08-19-brief-index-widening-design.md
git commit -m "feat(briefs): tell the model what kind of item each index hit is"
# or, if reverted:
git commit -m "docs(spec): record that the prompt does not need the item type"
```

---

### Task 6: Land it

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Record the user-facing change**

Add under `## [Unreleased]`, in the `### Changed` section (create it if absent), matching the repo's narrative changelog voice:

```markdown
- **A research brief can draw on everything Nimbus has indexed, not only your saved
  clips.** `useIndex` searched `web_clip` and nothing else, so the pull requests,
  builds and issues the connectors index — the reason to run a local gateway at all —
  were invisible to a brief. The search now covers every indexed type, and each
  citation carries what kind of item it is, so a brief that leans on a pull request
  says so rather than calling it a clip.
```

- [ ] **Step 2: Run every gate one final time**

Run: `bun run typecheck && bun run lint && bun test packages/gateway`
Expected: all PASS. Paste the real output into the PR body; do not summarise it from memory.

- [ ] **Step 3: Commit and push**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): briefs draw on the whole index"
git push -u origin dev/asafgolombek/brief-index-widening
```

- [ ] **Step 4: Open the PR**

Title: `feat(briefs): research briefs draw on the whole index, not only clips`

Body must state: what widened, that `kind`/`clipId` are unchanged and why, the ~5 KB-per-hit bound from the chunker, that no per-type quota was added and why, and the named downstream consumer (`nimbus-web-clipper`, branch `dev/asafgolombek/briefs-over-your-index`).

---

## Self-Review

**Spec coverage:** Decision 1 → Task 2. Decision 2 → Task 1. Decision 3 → Task 3. Decision 4 → Task 5 (gated). Decisions 5, 6 and 8 are recorded rationale with no code to write — Task 5's judgement step and the PR body carry them. Decision 7 (query embedding) is explicitly out of scope. The "unknown itemType must not break validation" test from the Testing section → Task 1 Step 1 and Task 4 Step 2.

**Type consistency:** `IndexHit.itemType` is `string` (required) everywhere — declared in Task 1, produced in Task 2, consumed in Tasks 4 and 5. `SourceRef.itemType`/`itemId` are `string | undefined` everywhere. `runBriefWithIndexHits(hits: IndexHit[]): Promise<Report>` is named identically in Task 4 Steps 2 and 3.

**Known follow-ups, deliberately not tasks:** the query-embedding egress (spec decision 7) and a gap line naming type skew (decision 6) — neither has evidence it is needed yet.
