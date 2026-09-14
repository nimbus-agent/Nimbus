# `nimbus explain last` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `nimbus explain last` — a CLI-only X-ray of the most recent `nimbus ask`, reporting what was put in front of the model, what was not, and why.

**Architecture:** An in-memory bounded ring (`AskExplainRecorder`) is written once per `runAsk` invocation, including its throw path. The local-context route records a per-candidate pool with score components threaded up from `local-index.ts`; the agent tool-calling route collects tool calls in process via the existing `agentRequestContext` `AsyncLocalStorage`. A CLI-only `ask.explainLast` IPC method reads the ring. Nothing is written to disk; `"ask"` is added to the LAN denylist.

**Tech Stack:** Bun 1.2+, TypeScript strict (`no any`), `bun:test`, Biome, JSON-RPC 2.0 over a unix/named-pipe socket.

**Spec:** [`docs/superpowers/specs/2026-09-14-nimbus-explain-last-design.md`](../specs/2026-09-14-nimbus-explain-last-design.md) — read it first; this plan argues from it and cites its section numbers.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **No schema migration, no new invariant, no new egress class, no HITL action type.** If a task seems to need one, stop and re-read the spec.
- **No new Tauri allowlist entry.** `ALLOWED_METHODS` count is unchanged and asserted.
- **Cross-platform paths:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Commit after every task.** Never commit on `main` — this work is on `dev/asafgolombek/explain-last`.
- **Run `bun run preflight:fast` before declaring any task done.** If it fails, fix locally.
- **Honesty rules are requirements, not polish.** A score-less candidate renders `n/a (direct query)`, never `0.00`. Scores from different `scoringFormula` values are never compared. The report says "given to the model", never "read by the model".
- The ring holds **10** records. `LOCAL_CONTEXT_TOTAL_PROBE_LIMIT` is **100**; `resolveLocalContextItemLimit()` defaults to **8**.

---

### Task 1: Thread score components onto `RankedIndexItem`

Spec §2.1, §2.2. Without this, "how each item was ranked and why" has no data.

**Files:**
- Modify: `packages/gateway/src/index/ranked-item.ts` (type-only module — add fields ONLY, no runtime logic; it is coverage-floor exact-path-excluded and adding logic silently bypasses the floor)
- Modify: `packages/gateway/src/index/local-index.ts` (`rowToRankedItem` ~:174, `dedupeRankedByCanonicalUrl` ~:193, FTS scoring ~:622, hybrid scoring ~:693)
- Test: `packages/gateway/src/index/local-index.score-components.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `RankedIndexItem.matchScore?: number`, `.recencyComponent?: number`, `.servicePriorityComponent?: number`, `.scoringFormula?: "hybrid_rrf" | "fts_rank"`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/local-index.score-components.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { LocalIndex } from "./local-index.ts";

// D30: any non-test file value-importing Database must name ensureFullSqlite. Tests do it too,
// so a fresh contributor copying this file into src/ does not reintroduce issue #1029.
ensureFullSqlite();

function seed(): LocalIndex {
  const db = new Database(":memory:");
  const idx = new LocalIndex(db);
  idx.migrate();
  // `upsertIndexedItem` is a STANDALONE function in `item-store.ts` taking the Database —
  // `LocalIndex` has no such method, so `idx.upsertIndexedItem(...)` is a TypeError at runtime.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/api#1",
    title: "rate limiting for the api",
    bodyPreview: "add a redis rate limiter",
    modifiedAt: Date.now(),
  });
  return idx;
}

describe("score components survive onto RankedIndexItem (spec §2.1)", () => {
  test("the FTS path reports fts_rank and all three components", () => {
    const idx = seed();
    const [item] = idx.searchRanked({ name: "rate", limit: 5 });
    expect(item).toBeDefined();
    expect(item?.scoringFormula).toBe("fts_rank");
    expect(typeof item?.matchScore).toBe("number");
    expect(typeof item?.recencyComponent).toBe("number");
    expect(typeof item?.servicePriorityComponent).toBe("number");
  });

  test("the components reconstruct the composite score (0.5/0.3/0.2)", () => {
    const idx = seed();
    const [item] = idx.searchRanked({ name: "rate", limit: 5 });
    const recomposed =
      0.5 * (item?.matchScore ?? 0) +
      0.3 * (item?.recencyComponent ?? 0) +
      0.2 * (item?.servicePriorityComponent ?? 0);
    // Exact, not approximate: these are the same floats compositeSearchScore combined.
    expect(recomposed).toBeCloseTo(item?.score ?? -1, 12);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/gateway/src/index/local-index.score-components.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined` for `scoringFormula`.

- [ ] **Step 3: Add the optional fields to the type**

In `packages/gateway/src/index/ranked-item.ts`, extend the type (leave the existing header comment intact):

```ts
export type RankedIndexItem = NimbusItem & {
  score: number;
  indexPrimaryKey: string;
  indexedType: string;
  canonicalUrl?: string;
  duplicates?: readonly string[];
  semanticSnippet?: string;
  bm25Rank?: number | null;
  vectorRank?: number | null;
  /**
   * The three inputs `compositeSearchScore` folded into `score`, kept so `nimbus explain last`
   * can say WHY an item ranked where it did (spec §2.1).
   *
   * `matchScore` is deliberately NOT named `bm25Score`: on the hybrid path it is the min-max
   * normalised RRF score, and on the FTS path it is a normalised rank POSITION
   * (`1 - i/(n-1)`) — `normalizeBm25LowerIsBetter` is not called on either (spec §2.2).
   * `scoringFormula` is what tells a renderer which scores may be compared with which.
   *
   * All four are optional because candidates from the raw-SQL repo-slug pass have none of
   * them — no score was ever computed for those rows (spec §2.4).
   */
  matchScore?: number;
  recencyComponent?: number;
  servicePriorityComponent?: number;
  scoringFormula?: "hybrid_rrf" | "fts_rank";
};
```

- [ ] **Step 4: Carry the components through the two scoring sites**

In `packages/gateway/src/index/local-index.ts`, add a components type near `rowToRankedItem`:

```ts
type ScoreComponents = {
  matchScore: number;
  recencyComponent: number;
  servicePriorityComponent: number;
  scoringFormula: "hybrid_rrf" | "fts_rank";
};
```

Give `rowToRankedItem` a fourth parameter and spread it onto the item it already builds:

```ts
function rowToRankedItem(
  row: ItemRow,
  score: number,
  duplicates?: readonly string[],
  components?: ScoreComponents,
): RankedIndexItem {
  // ...existing body, unchanged, then on the object literal add:
  //   ...(components ?? {}),
}
```

Widen `dedupeRankedByCanonicalUrl`'s input and forward the components at all three
`rowToRankedItem(row, score)` call sites inside it:

```ts
function dedupeRankedByCanonicalUrl(
  scored: Array<{ row: ItemRow; score: number; components?: ScoreComponents }>,
): RankedIndexItem[] {
  // ...unchanged, but every `rowToRankedItem(row, score)` becomes
  //    `rowToRankedItem(row, score, undefined, components)`
}
```

At the FTS site (~:622), attach them to each scored entry:

```ts
const scored = rows.map((row, i) => {
  const mod = Number(row.modified_at);
  const rec = recencyScore(mod, now);
  const sp = servicePriorityScore(row.service, priorities);
  const bm = normBm25[i] ?? 0.5;
  const comp = compositeSearchScore(bm, rec, sp);
  return {
    row,
    score: comp,
    components: {
      matchScore: bm,
      recencyComponent: rec,
      servicePriorityComponent: sp,
      scoringFormula: "fts_rank" as const,
    },
  };
});
```

At the hybrid site (~:693), pass them into `rowToRankedItem`'s new parameter:

```ts
const base = rowToRankedItem(row, comp, h.duplicates, {
  matchScore: nr,
  recencyComponent: rec,
  servicePriorityComponent: sp,
  scoringFormula: "hybrid_rrf",
});
```

- [ ] **Step 5: Run the test and the existing index suite**

Run: `bun test packages/gateway/src/index/`
Expected: PASS, including the pre-existing `local-index` tests — the fields are additive and optional, so no existing consumer changes.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/ranked-item.ts packages/gateway/src/index/local-index.ts packages/gateway/src/index/local-index.score-components.test.ts
git commit -m "feat(index): keep the three score components on RankedIndexItem"
```

---

### Task 2: The record types and the bounded ring

Spec §4.1, §9. No wiring yet — this task is the data structure and its honesty about emptiness.

**Files:**
- Create: `packages/gateway/src/engine/ask-explain-types.ts` (type-only)
- Create: `packages/gateway/src/engine/ask-explain-recorder.ts`
- Test: `packages/gateway/src/engine/ask-explain-recorder.test.ts`

**Interfaces:**
- Consumes: Task 1's `RankedIndexItem` fields (for `LocalCandidate`).
- Produces: `AskExplainRecord`, `LocalCandidate`, `CollectedToolCall`, `CandidateOutcome`, and `class AskExplainRecorder` with `record(r: AskExplainRecord): void` and `last(): AskExplainRecord | undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/engine/ask-explain-recorder.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AskExplainRecorder, ASK_EXPLAIN_RING_SIZE } from "./ask-explain-recorder.ts";
import type { AskExplainRecord } from "./ask-explain-types.ts";

function rec(question: string): AskExplainRecord {
  return {
    askedAt: 1_700_000_000_000,
    durationMs: 10,
    question,
    source: "local",
    persona: "standard",
    modelRoute: { provider: "ollama", model: "llama3.2", isLocal: true },
    classifier: { called: false, reason: "local preference" },
    route: "empty_index",
  };
}

describe("AskExplainRecorder", () => {
  test("last() is undefined before anything is recorded — the caller must be able to say so", () => {
    expect(new AskExplainRecorder().last()).toBeUndefined();
  });

  test("last() returns the most recent record", () => {
    const r = new AskExplainRecorder();
    r.record(rec("first"));
    r.record(rec("second"));
    expect(r.last()?.question).toBe("second");
  });

  test("the ring is bounded and evicts oldest-first", () => {
    const r = new AskExplainRecorder();
    for (let i = 0; i < ASK_EXPLAIN_RING_SIZE + 3; i++) r.record(rec(`q${String(i)}`));
    expect(r.size()).toBe(ASK_EXPLAIN_RING_SIZE);
    expect(r.last()?.question).toBe(`q${String(ASK_EXPLAIN_RING_SIZE + 2)}`);
    // The first three are gone, not merely unreachable.
    expect(r.all().some((x) => x.question === "q0")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/gateway/src/engine/ask-explain-recorder.test.ts`
Expected: FAIL — `Cannot find module './ask-explain-recorder.ts'`.

- [ ] **Step 3: Write the types**

Create `packages/gateway/src/engine/ask-explain-types.ts`:

```ts
// Type-only module: NO executable runtime logic. Coverage-floor excluded like `ranked-item.ts`;
// runtime logic here would silently bypass the floor. Put logic in ask-explain-recorder.ts.

/** Why a candidate did or did not reach the model. Order matters — see spec §4.6. */
export type CandidateOutcome =
  | "shown"
  /** Ranked outside the top K of the primary probe, so it never entered `byId` at all. */
  | "cut: probe slice"
  /** In `byId`, dropped by the final cap. */
  | "cut: over cap"
  /** In `byId` and inside the budget by arrival order, displaced by per-service round-robin. */
  | "cut: service fairness";

export type ContributingPass =
  | { readonly kind: "primary-hybrid" }
  | { readonly kind: "quoted"; readonly query: string }
  | { readonly kind: "repo-slug"; readonly slug: string }
  | { readonly kind: "fallback-term"; readonly term: string };

export type LocalCandidate = {
  readonly sourceId: string;
  readonly service: string;
  readonly indexedType: string;
  readonly title: string;
  /** Absent for repo-slug rows: that projection does not select modified_at (spec §2.4). */
  readonly modifiedAt?: number;
  /** Absent for repo-slug rows: no score was ever computed for them (spec §2.4). */
  readonly score?: number;
  readonly matchScore?: number;
  readonly recencyComponent?: number;
  readonly servicePriorityComponent?: number;
  readonly scoringFormula?: "hybrid_rrf" | "fts_rank";
  readonly pass: ContributingPass;
  readonly outcome: CandidateOutcome;
};

export type CollectedToolCall = {
  readonly toolId: string;
  readonly service: string;
  readonly status: "ok" | "error";
  readonly durationMs: number;
  /** Already `redactAuditPayload`-scrubbed by the collector (spec §4.5). */
  readonly paramsJson: string | null;
  /** Present only for `searchLocalIndex` calls, which rank internally (spec §2.5). */
  readonly ranking?: {
    readonly totalMatches: number;
    readonly itemsInWindow: number;
    readonly sourceSummary: ReadonlyArray<{ service: string; type: string; count: number }>;
  };
};

export type BaseExplainRecord = {
  readonly askedAt: number;
  readonly durationMs: number;
  readonly question: string;
  /**
   * `local` means "some client on this machine's socket". A cli/desktop split is NOT derivable:
   * only the MCP adapter ever calls `session.declareKind`, so a plain `nimbus ask` arrives
   * undeclared. `chatops` is a fact — gateway-main binds that path with `clientId: "chatops"`.
   * Spec §4.3.
   */
  readonly source: "chatops" | "local";
  readonly persona: string;
  /**
   * OPTIONAL, deliberately: the `empty_index` route and a failure at the classification stage
   * never resolve a model at all. Requiring this would force the recorder to fabricate
   * `{ provider: "none", model: "none", isLocal: true }` — inventing a route that did not
   * happen, in a report whose entire purpose is not doing that. Absent means "no model route
   * was resolved", and the renderer says so.
   */
  readonly modelRoute?: { readonly provider: string; readonly model: string; readonly isLocal: boolean };
  readonly classifier:
    | { readonly called: false; readonly reason: string }
    | {
        readonly called: true;
        readonly intent: string;
        readonly confidence: number;
        readonly entities: Readonly<Record<string, string>>;
        readonly destination: string;
      };
  /** Set when the local router threw and the turn silently re-ran on the agent (spec §4.2). */
  readonly fallbackFromLocalRouter?: { readonly error: string };
};

export type AskExplainRecord = BaseExplainRecord &
  (
    | { readonly route: "empty_index" }
    | {
        readonly route: "local_context";
        readonly searchTerms: string;
        readonly fallbackTermFired?: string;
        readonly truncation: { readonly shown: number; readonly total: number; readonly atLeast: boolean };
        readonly pool: readonly LocalCandidate[];
        readonly discardedTail: ReadonlyArray<{ service: string; type: string; count: number }>;
      }
    | { readonly route: "agent_tools"; readonly toolCalls: readonly CollectedToolCall[] }
    | { readonly route: "plan_dispatch"; readonly plan: string }
    | {
        readonly route: "failed";
        readonly stage: "classification" | "retrieval" | "model";
        readonly error: string;
      }
  );
```

- [ ] **Step 4: Write the ring**

Create `packages/gateway/src/engine/ask-explain-recorder.ts`:

```ts
import type { AskExplainRecord } from "./ask-explain-types.ts";

/**
 * In memory only, and deliberately so: persisting this would write every question the user asks,
 * with its retrieval trace, to an index that is not encrypted at rest (spec §6.1).
 */
export const ASK_EXPLAIN_RING_SIZE = 10;

export class AskExplainRecorder {
  readonly #ring: AskExplainRecord[] = [];

  record(r: AskExplainRecord): void {
    this.#ring.push(r);
    while (this.#ring.length > ASK_EXPLAIN_RING_SIZE) this.#ring.shift();
  }

  /** `undefined` when nothing has been recorded — the CLI says so rather than printing empty. */
  last(): AskExplainRecord | undefined {
    return this.#ring.at(-1);
  }

  all(): readonly AskExplainRecord[] {
    return [...this.#ring];
  }

  size(): number {
    return this.#ring.length;
  }
}
```

- [ ] **Step 5: Exclude the type-only file from the coverage floor**

`ask-explain-types.ts` is a NEW type-only file and is **not** excluded by anything yet. A
type-only file emits no `SF:` lcov record, so it must be listed explicitly or the floor audit
trips on it. Add to `scripts/coverage-floor/exclusions.ts`, beside the existing
`packages/gateway/src/index/ranked-item.ts` entry (~:270):

```ts
  { kind: "exact", path: "packages/gateway/src/engine/ask-explain-types.ts" },
```

Verify the file stays type-only — moving runtime logic into it would silently bypass the floor,
which is exactly what `ranked-item.ts`'s header warns about.

- [ ] **Step 6: Run the test**

Run: `bun test packages/gateway/src/engine/ask-explain-recorder.test.ts && bun run audit:coverage-floor`
Expected: PASS (3 tests); the floor audit does not name the new file.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/engine/ask-explain-types.ts packages/gateway/src/engine/ask-explain-recorder.ts packages/gateway/src/engine/ask-explain-recorder.test.ts scripts/coverage-floor/exclusions.ts
git commit -m "feat(engine): add the ask-explain record types and bounded ring"
```

---

### Task 3: Classify candidate outcomes

Spec §4.6. Pure function, no wiring — this is the piece most likely to be got subtly wrong, so it is tested alone.

**Files:**
- Create: `packages/gateway/src/engine/ask-explain-outcome.ts`
- Test: `packages/gateway/src/engine/ask-explain-outcome.test.ts`

**Interfaces:**
- Consumes: `CandidateOutcome` from Task 2.
- Produces: `classifyCandidateOutcome(args: { sourceId: string; inById: boolean; byIdPosition: number; shownIds: ReadonlySet<string>; limit: number }): CandidateOutcome`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/engine/ask-explain-outcome.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifyCandidateOutcome } from "./ask-explain-outcome.ts";

const shown = new Set(["a", "b"]);
const base = { shownIds: shown, limit: 8 } as const;

describe("classifyCandidateOutcome (spec §4.6)", () => {
  test("an item in the final selection is shown", () => {
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "a", inById: true, byIdPosition: 0 }),
    ).toBe("shown");
  });

  test("an item that never entered byId was cut by the probe slice", () => {
    // This is the LARGEST discard: the primary probe fetches 100 and only the top 8 are merged.
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "z", inById: false, byIdPosition: -1 }),
    ).toBe("cut: probe slice");
  });

  test("an item inside the budget by arrival order but not selected was displaced by fairness", () => {
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "c", inById: true, byIdPosition: 2 }),
    ).toBe("cut: service fairness");
  });

  test("an item beyond the budget by arrival order was cut by the cap", () => {
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "d", inById: true, byIdPosition: 20 }),
    ).toBe("cut: over cap");
  });

  test("a multi-pass item merged by a later pass is never 'cut: probe slice'", () => {
    // Primary rank 15 (outside the slice) but also matched a quoted term, so it IS in byId.
    // Its fate is decided by byId, not by the probe (spec §4.6, multi-pass reconciliation).
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "a", inById: true, byIdPosition: 30 }),
    ).toBe("shown");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/gateway/src/engine/ask-explain-outcome.test.ts`
Expected: FAIL — `Cannot find module './ask-explain-outcome.ts'`.

- [ ] **Step 3: Write the classifier**

Create `packages/gateway/src/engine/ask-explain-outcome.ts`:

```ts
import type { CandidateOutcome } from "./ask-explain-types.ts";

/**
 * Decide why a candidate did or did not reach the model, in the order the pipeline applies.
 *
 * `byIdPosition` is a position in INSERTION order, not score order: `capPerService` receives
 * `[...byId.values()]` and `bucketByService` groups "in input order", and the pipeline never
 * sorts globally by score (spec §2.3). So there is no "would have been admitted under a naive
 * top-K by score" — that ordering does not exist anywhere in the code, and phrasing the
 * fairness branch in those terms would be fiction.
 */
export function classifyCandidateOutcome(args: {
  sourceId: string;
  /** Whether the candidate was merged into `byId` by any pass. */
  inById: boolean;
  /** Index within `[...byId.values()]`, or -1 when `inById` is false. */
  byIdPosition: number;
  shownIds: ReadonlySet<string>;
  limit: number;
}): CandidateOutcome {
  if (args.shownIds.has(args.sourceId)) return "shown";
  if (!args.inById) return "cut: probe slice";
  return args.byIdPosition < args.limit ? "cut: service fairness" : "cut: over cap";
}
```

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/src/engine/ask-explain-outcome.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/ask-explain-outcome.ts packages/gateway/src/engine/ask-explain-outcome.test.ts
git commit -m "feat(engine): classify ask-explain candidate outcomes against insertion order"
```

---

### Task 4: Capture the local-context candidate pool

Spec §4.4, §2.4, §2.5. `buildLocalIndexedContext` currently discards everything it computes.

**Files:**
- Modify: `packages/gateway/src/engine/run-ask.ts` (`buildLocalIndexedContext` ~:482–585; `githubIssueContextItemsForRepo` ~:440)
- Test: `packages/gateway/src/engine/ask-explain-local-capture.test.ts`

**Interfaces:**
- Consumes: Task 2's `LocalCandidate` / `ContributingPass`, Task 3's `classifyCandidateOutcome`, Task 1's score fields.
- Produces: `buildLocalIndexedContext` returns an added `explain` field:
  `{ searchTerms: string; fallbackTermFired?: string; pool: LocalCandidate[]; discardedTail: Array<{service,type,count}> }`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/engine/ask-explain-local-capture.test.ts`. It drives the real
`buildLocalIndexedContext` through `runAsk`'s local path against an in-memory index:

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { buildLocalIndexedContextForTest } from "./run-ask.ts";

ensureFullSqlite();

function seedMany(n: number): LocalIndex {
  const db = new Database(":memory:");
  const idx = new LocalIndex(db);
  idx.migrate();
  for (let i = 0; i < n; i++) {
    // Standalone function taking the Database — not a LocalIndex method (see Task 1).
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: `slack:${String(i)}`,
      title: `rate limiting note ${String(i)}`,
      bodyPreview: "throttling discussion",
      modifiedAt: Date.now() - i * 1000,
    });
  }
  return idx;
}

describe("local-context capture (spec §4.4)", () => {
  test("the pool is wider than what reached the model, and names the probe-slice cut", async () => {
    // 40 matches, context limit 8 — so 32 are cut, and the cut that dominates is the slice
    // the primary probe applies BEFORE the cap and BEFORE fairness ever run.
    const out = await buildLocalIndexedContextForTest(seedMany(40), "rate limiting");
    expect(out).toBeDefined();
    const pool = out?.explain.pool ?? [];
    expect(pool.length).toBeGreaterThan(8);
    expect(pool.filter((c) => c.outcome === "shown").length).toBeLessThanOrEqual(8);
    expect(pool.some((c) => c.outcome === "cut: probe slice")).toBe(true);
  });

  test("every candidate names the pass that contributed it", () => {
    // Guards the §2.2 non-comparability story: without a pass, a renderer cannot know which
    // scores may be compared with which.
    return buildLocalIndexedContextForTest(seedMany(12), "rate limiting").then((out) => {
      for (const c of out?.explain.pool ?? []) expect(c.pass.kind).toBeTruthy();
    });
  });

  test("the discarded tail is grouped by service and type", async () => {
    const out = await buildLocalIndexedContextForTest(seedMany(40), "rate limiting");
    const tail = out?.explain.discardedTail ?? [];
    expect(tail.length).toBeGreaterThan(0);
    expect(tail[0]?.service).toBe("slack");
    expect(tail[0]?.type).toBe("message");
  });

  test("a SHOWN candidate carries real score components, not undefined", async () => {
    // THE regression guard for this task. `byId` holds `Omit<LocalContextItem,"rank">`, and
    // `formatContextItem` drops score/components/scoringFormula — so an implementation that
    // reads them off a byId value yields undefined for every candidate, every row renders
    // "n/a (direct query)", and Task 1 is silently defeated. The other tests in this file all
    // pass in that world, because they assert on pass and outcome only.
    const out = await buildLocalIndexedContextForTest(seedMany(40), "rate limiting");
    const shown = (out?.explain.pool ?? []).filter((c) => c.outcome === "shown");
    expect(shown.length).toBeGreaterThan(0);
    for (const c of shown) {
      expect(c.scoringFormula).toBeDefined();
      expect(typeof c.score).toBe("number");
      expect(typeof c.matchScore).toBe("number");
      expect(typeof c.recencyComponent).toBe("number");
      expect(typeof c.servicePriorityComponent).toBe("number");
    }
  });

  test("title comes from RankedIndexItem.name — there is no .title on that type", async () => {
    const out = await buildLocalIndexedContextForTest(seedMany(5), "rate limiting");
    for (const c of out?.explain.pool ?? []) {
      expect(c.title).toContain("rate limiting note");
      expect(c.sourceId).not.toBe("undefined");
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/gateway/src/engine/ask-explain-local-capture.test.ts`
Expected: FAIL — `buildLocalIndexedContextForTest` is not exported from `run-ask.ts`.

- [ ] **Step 3: Capture the pool inside `buildLocalIndexedContext`**

In `packages/gateway/src/engine/run-ask.ts`:

1. Import the new helpers:

```ts
import { classifyCandidateOutcome } from "./ask-explain-outcome.ts";
import type { ContributingPass, LocalCandidate } from "./ask-explain-types.ts";
import { buildContextWindow } from "./context-ranker.ts";
```

2. **`byId` does not hold `RankedIndexItem`, and this is the trap in this task.** There are TWO
   adders, keyed differently, and the ranked one *discards every score*:

```ts
// The REAL existing code (run-ask.ts:491-505):
const byId = new Map<string, Omit<LocalContextItem, "rank">>();
const addRankedResults = (items: RankedIndexItem[]): void => {
  for (const item of items) {
    if (!byId.has(item.indexPrimaryKey)) {
      byId.set(item.indexPrimaryKey, formatContextItem(localIndex, item)); // <- scores GONE
    }
  }
};
const addContextItems = (items: Array<Omit<LocalContextItem, "rank">>): void => {
  for (const item of items) {
    if (!byId.has(item.sourceId)) byId.set(item.sourceId, item);
  }
};
```

`formatContextItem` returns `{ sourceId: item.indexPrimaryKey, service, indexedType, title:
cleanContextText(item.name), preview?, url? }` — **no `score`, no components, no
`scoringFormula`**. So reading score fields off a `byId` value yields `undefined` for every
candidate, every row renders `n/a (direct query)`, and Task 1 is silently defeated. The key
spaces DO align (`sourceId === indexPrimaryKey`), so `byIdOrder.indexOf(sourceId)` is sound —
only the score fields are lost.

Also note `RankedIndexItem` has **`.indexPrimaryKey` and `.name`**, never `.sourceId`/`.title`.

Keep a PARALLEL map of the original ranked items, and record the pass in both adders:

```ts
const passById = new Map<string, ContributingPass>();
const rankedById = new Map<string, RankedIndexItem>();

const addRankedResults = (items: RankedIndexItem[], pass: ContributingPass): void => {
  for (const item of items) {
    if (!byId.has(item.indexPrimaryKey)) {
      byId.set(item.indexPrimaryKey, formatContextItem(localIndex, item));
      passById.set(item.indexPrimaryKey, pass);
      // The scores survive ONLY here — formatContextItem drops them.
      rankedById.set(item.indexPrimaryKey, item);
    }
  }
};

const addContextItems = (
  items: Array<Omit<LocalContextItem, "rank">>,
  pass: ContributingPass,
): void => {
  for (const item of items) {
    if (!byId.has(item.sourceId)) {
      byId.set(item.sourceId, item);
      passById.set(item.sourceId, pass);
      // Deliberately NOT added to rankedById: these rows were never scored (spec §2.4).
    }
  }
};
```

Update the four call sites: `{ kind: "primary-hybrid" }`,
`{ kind: "quoted", query: quotedQuery }`, `{ kind: "repo-slug", slug: repoSlug }` (on
`addContextItems`), and `{ kind: "fallback-term", term }`. Record the fired fallback term in a
`let fallbackTermFired: string | undefined` set inside the fallback loop.

3. After `contextItems` is computed, build the pool over the UNION of the full primary probe and
   `byId` — not just what reached the cap:

```ts
const shownIds = new Set(contextItems.map((i) => i.sourceId));
const byIdOrder = [...byId.keys()];
const limit = resolveLocalContextItemLimit();

const outcomeFor = (id: string, inById: boolean): CandidateOutcome =>
  classifyCandidateOutcome({
    sourceId: id,
    inById,
    byIdPosition: inById ? byIdOrder.indexOf(id) : -1,
    shownIds,
    limit,
  });

/** A candidate that WAS scored: read the components off the preserved RankedIndexItem. */
const fromRanked = (
  item: RankedIndexItem,
  pass: ContributingPass,
  inById: boolean,
): LocalCandidate => ({
  sourceId: item.indexPrimaryKey,
  service: item.service,
  indexedType: item.indexedType,
  title: cleanContextText(item.name),
  ...(item.modifiedAt === undefined ? {} : { modifiedAt: item.modifiedAt }),
  ...(item.scoringFormula === undefined
    ? {}
    : {
        score: item.score,
        matchScore: item.matchScore,
        recencyComponent: item.recencyComponent,
        servicePriorityComponent: item.servicePriorityComponent,
        scoringFormula: item.scoringFormula,
      }),
  pass,
  outcome: outcomeFor(item.indexPrimaryKey, inById),
});

/**
 * A candidate that was NEVER scored — the raw-SQL repo-slug rows. Score fields are left ABSENT,
 * never 0: rendering an absent score as zero would claim it ranked last when in fact it was
 * never ranked (spec §2.4).
 */
const fromContext = (
  item: Omit<LocalContextItem, "rank">,
  pass: ContributingPass,
): LocalCandidate => ({
  sourceId: item.sourceId,
  service: item.service,
  indexedType: item.indexedType,
  title: item.title,
  pass,
  outcome: outcomeFor(item.sourceId, true),
});

const pool: LocalCandidate[] = [];
const seen = new Set<string>();
for (const [id, ctxItem] of byId) {
  seen.add(id);
  const pass = passById.get(id) ?? { kind: "primary-hybrid" as const };
  const ranked = rankedById.get(id);
  pool.push(ranked === undefined ? fromContext(ctxItem, pass) : fromRanked(ranked, pass, true));
}
for (const item of primary) {
  if (seen.has(item.indexPrimaryKey)) continue;
  seen.add(item.indexPrimaryKey);
  pool.push(fromRanked(item, { kind: "primary-hybrid" }, false));
}

// Group the discarded tail by service + type.
//
// Spec §2.5 suggested reusing `buildContextWindow`. DO NOT: its cap is
// `Math.min(200, Math.max(1, Math.floor(maxItems)))`, so passing 0 to summarise EVERYTHING
// clamps to 1 — it would keep the first discarded row as an "item" and silently omit it from
// the summary. It would also need an unsound cast, since LocalCandidate is not a
// RankedIndexItem. Ten honest lines beat a reused function used off-contract.
const tail = new Map<string, { service: string; type: string; count: number }>();
for (const c of pool) {
  if (c.outcome === "shown") continue;
  const key = JSON.stringify([c.service, c.indexedType]);
  const hit = tail.get(key);
  if (hit === undefined) {
    tail.set(key, { service: c.service, type: c.indexedType, count: 1 });
  } else {
    hit.count += 1;
  }
}
const discardedTail = [...tail.values()].sort((a, b) => b.count - a.count);
```

4. Add `explain` to the returned object alongside `text` and `truncation`:

```ts
explain: {
  searchTerms,
  ...(fallbackTermFired === undefined ? {} : { fallbackTermFired }),
  pool,
  discardedTail,
},
```

5. Export a thin test seam at the bottom of the file:

```ts
/** Test seam: `buildLocalIndexedContext` is module-private and has no other entry point. */
export const buildLocalIndexedContextForTest = buildLocalIndexedContext;
```

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/src/engine/ask-explain-local-capture.test.ts packages/gateway/src/engine/run-ask.test.ts`
Expected: PASS — including the existing `run-ask` suite, since `explain` is additive.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/engine/run-ask.ts packages/gateway/src/engine/ask-explain-local-capture.test.ts
git commit -m "feat(engine): capture the local-context candidate pool for explain"
```

---

### Task 5: Collect agent-route tool calls in process

Spec §4.5, §2.5. A `session_id`-keyed join cannot work — a plain `nimbus ask` logs `session_id` NULL.

**Files:**
- Modify: `packages/gateway/src/engine/agent-request-context.ts` (add the collector field)
- Modify: `packages/gateway/src/engine/agent.ts` (~:47–80, the tool wrapper that already writes `tool_call_log`)
- Test: `packages/gateway/src/engine/ask-explain-tool-collect.test.ts`

**Interfaces:**
- Consumes: Task 2's `CollectedToolCall`.
- Produces: `AgentRequestContext.explainToolCalls?: CollectedToolCall[]`, and
  `recordExplainToolCall(call: CollectedToolCall): void` exported from `agent-request-context.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/engine/ask-explain-tool-collect.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  agentRequestContext,
  getExplainToolCalls,
  recordExplainToolCall,
} from "./agent-request-context.ts";

describe("in-process tool collection (spec §4.5)", () => {
  test("calls are collected per turn, with no session id involved", () => {
    // The whole point: a plain `nimbus ask` passes no session, so agent.ts logs session_id NULL
    // and a time-window join would conflate concurrent asks.
    agentRequestContext.run({}, () => {
      recordExplainToolCall({
        toolId: "searchLocalIndex",
        service: "nimbus",
        status: "ok",
        durationMs: 12,
        paramsJson: '{"name":"rate"}',
      });
      expect(getExplainToolCalls()).toHaveLength(1);
      expect(getExplainToolCalls()?.[0]?.toolId).toBe("searchLocalIndex");
    });
  });

  test("two concurrent turns do not see each other's calls", async () => {
    const turn = (id: string): Promise<readonly unknown[]> =>
      new Promise((resolve) => {
        agentRequestContext.run({}, () => {
          recordExplainToolCall({
            toolId: id,
            service: "nimbus",
            status: "ok",
            durationMs: 1,
            paramsJson: null,
          });
          setTimeout(() => resolve(getExplainToolCalls() ?? []), 5);
        });
      });
    const [a, b] = await Promise.all([turn("toolA"), turn("toolB")]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("recording outside a turn is a no-op, never a throw", () => {
    expect(() =>
      recordExplainToolCall({
        toolId: "x",
        service: "y",
        status: "ok",
        durationMs: 0,
        paramsJson: null,
      }),
    ).not.toThrow();
    expect(getExplainToolCalls()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/gateway/src/engine/ask-explain-tool-collect.test.ts`
Expected: FAIL — `recordExplainToolCall` is not exported.

- [ ] **Step 3: Add the collector to the request context**

In `packages/gateway/src/engine/agent-request-context.ts`, add the field and two accessors. Mirror
the existing lazy-creation comment for `negationDisclosures` — same reason, same shape:

```ts
import type { CollectedToolCall } from "./ask-explain-types.ts";

export type AgentRequestContext = {
  sessionId?: string | undefined;
  negationDisclosures?: string[];
  /**
   * Tool calls made during THIS turn, for `nimbus explain last` (spec §4.5).
   *
   * Collected here rather than joined out of `tool_call_log`: `agent.ts` writes
   * `getAgentRequestSessionId() ?? null`, and a plain `nimbus ask` passes no session — so the
   * rows land with `session_id` NULL and a time-window join would conflate concurrent asks.
   * Created lazily, exactly as `negationDisclosures` is.
   */
  explainToolCalls?: CollectedToolCall[];
};

export function recordExplainToolCall(call: CollectedToolCall): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) return; // outside a turn: a diagnostic must never break the caller
  (store.explainToolCalls ??= []).push(call);
}

export function getExplainToolCalls(): readonly CollectedToolCall[] | undefined {
  return agentRequestContext.getStore()?.explainToolCalls;
}
```

- [ ] **Step 4: Push from the tool wrapper**

In `packages/gateway/src/engine/agent.ts`, in the wrapper that already computes `envelope`,
`status`, `calledAt` and calls `writeToolCallLog`, add a sibling push on BOTH the success and
error arms. Redact with the same helper the write path uses, so the two cannot disagree about
what is safe to show:

Add ONE import. **Do not add a `redactAuditPayload` import** — `agent.ts:8` already has it, from
`../audit/format-audit-payload.ts` (there is no `db/redact-audit-payload.ts`), and a second one
is a duplicate-identifier compile error:

```ts
import { recordExplainToolCall } from "./agent-request-context.ts";
// redactAuditPayload is ALREADY imported at agent.ts:8 — reuse it, do not re-import.

// ...in both arms, beside the existing writeToolCallLog call:
recordExplainToolCall({
  toolId: tool,
  service,
  status,
  durationMs: Date.now() - calledAt,
  paramsJson: input === undefined ? null : redactAuditPayload(input, 2048),
  ...(tool === "searchLocalIndex" && rankingFromResult !== undefined
    ? { ranking: rankingFromResult }
    : {}),
});
```

Where `rankingFromResult` is read from the tool's own return value on the success arm only — the
`searchLocalIndex` tool already returns `totalMatches`, `itemsInWindow` and `sourceSummary`
(spec §2.5), so this is a read, not a recomputation. Guard it with a real type check, not a cast:

```ts
function readRanking(raw: unknown): CollectedToolCall["ranking"] | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r["totalMatches"] !== "number" || typeof r["itemsInWindow"] !== "number") {
    return undefined;
  }
  const summary = Array.isArray(r["sourceSummary"]) ? r["sourceSummary"] : [];
  return {
    totalMatches: r["totalMatches"],
    itemsInWindow: r["itemsInWindow"],
    sourceSummary: summary.flatMap((g) =>
      g !== null && typeof g === "object" &&
      typeof (g as Record<string, unknown>)["service"] === "string"
        ? [g as { service: string; type: string; count: number }]
        : [],
    ),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/engine/ask-explain-tool-collect.test.ts packages/gateway/src/engine/agent.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/engine/agent-request-context.ts packages/gateway/src/engine/agent.ts packages/gateway/src/engine/ask-explain-tool-collect.test.ts
git commit -m "feat(engine): collect agent tool calls in process for explain"
```

---

### Task 6: Wire the recorder around `runAsk`

Spec §4.2, §4.3. Covers all four routes, the failure path, the local→agent fallback, the classifier destination, and `source`.

**Files:**
- Modify: `packages/gateway/src/engine/run-ask.ts` (`runAsk` ~:634, `classifyIntentForAskWithLocalFallback` ~:217, `answerConversationally` ~:163)
- Modify: `packages/gateway/src/engine/run-conversational-agent.ts` (~:218 — surface the fallback)
- Modify: `packages/gateway/src/platform/assemble.ts` (construct one recorder), `packages/gateway/src/platform/types.ts`, `packages/gateway/src/gateway-main.ts` (pass it)
- Test: `packages/gateway/src/engine/ask-explain-wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: `RunAskParams.explainRecorder?: AskExplainRecorder`; `PlatformServices.askExplainRecorder: AskExplainRecorder`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/engine/ask-explain-wiring.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AskExplainRecorder } from "./ask-explain-recorder.ts";
import { runAsk } from "./run-ask.ts";
import { makeRunAskParams } from "./run-ask.test-helpers.ts"; // see Step 3

describe("recorder wiring (spec §4.2)", () => {
  test("a failed ask is recorded, so explain last cannot show the previous success", async () => {
    const r = new AskExplainRecorder();
    await runAsk(makeRunAskParams({ input: "ok question", explainRecorder: r }));
    await runAsk(makeRunAskParams({ input: "boom", explainRecorder: r, throwAt: "model" })).catch(
      () => undefined,
    );
    const last = r.last();
    expect(last?.route).toBe("failed");
    expect(last?.question).toBe("boom");
    // The defect this guards: recording only on success leaves `explain last` showing the
    // PREVIOUS successful ask at the moment the user most needs the truth.
    expect(last?.question).not.toBe("ok question");
  });

  test("source is chatops when the gateway bound that clientId, local otherwise", async () => {
    const r = new AskExplainRecorder();
    await runAsk(makeRunAskParams({ input: "q", explainRecorder: r, clientId: "chatops" }));
    expect(r.last()?.source).toBe("chatops");
    await runAsk(makeRunAskParams({ input: "q", explainRecorder: r, clientId: "sock-17" }));
    expect(r.last()?.source).toBe("local");
  });

  test("a local-router failure that fell back to the agent is recorded as such", async () => {
    const r = new AskExplainRecorder();
    await runAsk(
      makeRunAskParams({ input: "q", explainRecorder: r, localRouterThrows: "connect ECONNREFUSED" }),
    );
    expect(r.last()?.fallbackFromLocalRouter?.error).toContain("ECONNREFUSED");
    expect(r.last()?.route).toBe("agent_tools");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/gateway/src/engine/ask-explain-wiring.test.ts`
Expected: FAIL — `Cannot find module './run-ask.test-helpers.ts'`.

- [ ] **Step 3: Write the test helper**

Create `packages/gateway/src/engine/run-ask.test-helpers.ts` building a `RunAskParams` over an
in-memory `LocalIndex` with injected fakes for `llmRouter`, `conversationalAgent` and `classify`.
Use **dependency injection, never `mock.module`** — `mock.module` is process-global and leaks
across the combined `bun test packages/cli/src` run on CI Linux. Honour `throwAt`,
`localRouterThrows` and `clientId` by making the injected fake throw or record accordingly.

- [ ] **Step 4: Capture the classifier destination without changing `classifyIntent`**

In `classifyIntentForAskWithLocalFallback`, wrap the closure it ALREADY builds — do not widen
`classifyIntent`'s exported return type, which has its own tests:

```ts
let classifierDestination: string | undefined;
const policy: ClassifierEgressPolicy = {
  enforceAirGap: router?.enforcesAirGap() ?? false,
  generate:
    router === undefined
      ? undefined
      : async (opts) => {
          const res = await router.generate(opts);
          // `classifyIntent` obtains an LlmGenerateResult and returns only ClassifiedIntent
          // (router.ts:185). Capturing at this seam touches one function (spec §4.3).
          classifierDestination = res.provider;
          return res;
        },
};
```

Return `{ classified, classifierDestination }` from this function and thread it into the record.

- [ ] **Step 5: Wrap `runAsk`'s body**

Rename the existing body to `runAskInner` and make `runAsk` a wrapper that records exactly once
on every path, success or throw:

```ts
export async function runAsk(
  p: RunAskParams,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const startedAt = Date.now();
  const partial: ExplainPartial = { stage: "classification" };
  try {
    const out = await runAskInner(p, partial);
    p.explainRecorder?.record(buildExplainRecord(p, partial, startedAt, undefined));
    return out;
  } catch (e) {
    p.explainRecorder?.record(buildExplainRecord(p, partial, startedAt, e));
    throw e;
  }
}
```

`ExplainPartial` is a single MUTABLE record threaded into `runAskInner` and filled as the turn
progresses (`stage`, route, classifier verdict, local `explain` payload, fallback error). One
record passed to the arms, never per-arm closures — the same rule the I35 gate learned: state a
single exit point must write belongs in ONE place, or it is two places for it to go missing.

`source` is `p.clientId === "chatops" ? "chatops" : "local"` (spec §4.3).

- [ ] **Step 6: Surface the fallback from `runConversationalAgent`**

In `run-conversational-agent.ts` at the local-router catch (~:228), add the caught error to the
returned result (`fallbackFromLocalRouter: { error: String(e) }`) alongside the existing
`toolless` discriminator, and have `answerConversationally` copy it into `ExplainPartial`.

- [ ] **Step 7: Construct one recorder and pass it**

In `platform/assemble.ts` build `new AskExplainRecorder()` once, expose it on `PlatformServices`
(`platform/types.ts`), and add `explainRecorder: platform.askExplainRecorder` to **both**
`runAsk` call sites in `gateway-main.ts` — the `setAgentInvokeHandler` one (~:190) and the
ChatOps `bindAskEngine` one (~:225). Missing the second would make every ChatOps ask invisible,
which is the exact case `source` exists to disclose.

- [ ] **Step 8: Run the tests**

Run: `bun test packages/gateway/src/engine/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/engine packages/gateway/src/platform packages/gateway/src/gateway-main.ts
git commit -m "feat(engine): record an explain entry on every runAsk path"
```

---

### Task 7: The IPC method, its route, and the LAN denylist entry

Spec §3.1, §3.2. **The LAN entry is the security-relevant half of this task — do not skip it.**

**Files:**
- Modify: `packages/gateway/src/ipc/diagnostics-rpc.ts` (context type ~:49, handler, switch ~:725)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (`tryDispatchDiagnosticsRpc` ~:1817, `assertDiagnosticsRpcAccess` ~:97)
- Modify: `packages/gateway/src/ipc/server/options.ts` (`askExplainRecorder?`)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (`FORBIDDEN_OVER_LAN`)
- Test: `packages/gateway/src/ipc/diagnostics-rpc.test.ts` (extend), `packages/gateway/src/security-invariants.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `AskExplainRecorder`.
- Produces: IPC method `ask.explainLast`, params `null`, result
  `{ record: AskExplainRecord } | { record: null; reason: "no_ask_since_start" }`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/security-invariants.test.ts`, inside the existing
`describe("I5 — LAN method allowlist is intrinsic to LanServer", ...)`:

```ts
test("FORBIDDEN_OVER_LAN blocks the whole ask namespace (explain last carries the owner's question)", async () => {
  const src = await read("packages/gateway/src/ipc/lan-rpc.ts");
  expect(src).toMatch(/"ask"/);
  const { checkLanMethodAllowed } = await import("./ipc/lan-rpc.ts");
  const peer = { peerId: "peer:x", writeAllowed: true };
  // checkLanMethodAllowed is a DENYLIST: everything not named is ALLOWED. Without the "ask"
  // entry this method ships reachable by any paired peer, handing them the owner's question
  // text and the titles of the owner's indexed items (spec §3.2).
  expect(() => checkLanMethodAllowed("ask.explainLast", peer)).toThrow(/ERR_METHOD_NOT_ALLOWED/);
});
```

Add to `packages/gateway/src/ipc/diagnostics-rpc.test.ts`:

```ts
describe("ask.explainLast", () => {
  test("reports the empty state rather than an empty report", async () => {
    const r = await dispatchDiagnosticsRpc("ask.explainLast", null, makeCtxWithRecorder(new AskExplainRecorder()));
    expect(r).toEqual({ kind: "hit", value: { record: null, reason: "no_ask_since_start" } });
  });

  test("returns the most recent record", async () => {
    const rec = new AskExplainRecorder();
    rec.record(sampleRecord("why is checkout slow?"));
    const r = await dispatchDiagnosticsRpc("ask.explainLast", null, makeCtxWithRecorder(rec));
    expect((r as { value: { record: { question: string } } }).value.record.question).toBe(
      "why is checkout slow?",
    );
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test packages/gateway/src/security-invariants.test.ts packages/gateway/src/ipc/diagnostics-rpc.test.ts`
Expected: FAIL — no `"ask"` in `lan-rpc.ts`; `dispatchDiagnosticsRpc` returns `{kind:"miss"}`.

- [ ] **Step 3: Add the LAN denylist entry**

In `packages/gateway/src/ipc/lan-rpc.ts`, add to `FORBIDDEN_OVER_LAN`, beside the other
whole-namespace entries:

```ts
  // `nimbus explain last` — the WHOLE namespace, matching exec/computer/media/fleet/toolgen.
  // The record carries the owner's question VERBATIM and the titles of items retrieved from the
  // owner's private index, so a peer asking "explain the last ask" would receive the OWNER's ask.
  // This set is a DENYLIST — everything not named here is allowed — so the entry is what makes
  // the exclusion real. There are no read verbs in this namespace worth preserving.
  "ask",
```

- [ ] **Step 4: Add the handler and its route**

In `diagnostics-rpc.ts`: add `readonly askExplainRecorder?: AskExplainRecorder;` to
`DiagnosticsRpcContext`, add the handler, and add the `case` to the switch:

```ts
function rpcAskExplainLast(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const rec = ctx.askExplainRecorder?.last();
  if (rec === undefined) {
    // Deliberately NOT an empty report: the ring is in memory only, so "nothing since the
    // gateway started" is a different statement from "no ask ever happened" (spec §4.1).
    return { kind: "hit", value: { record: null, reason: "no_ask_since_start" } };
  }
  return { kind: "hit", value: { record: rec } };
}
```

In `dispatchers.ts`, route it — **a handler without this entry compiles, unit-tests green, and
returns `Method not found` over a real socket**:

```ts
const wantsAskExplain = method === "ask.explainLast";
if (!wantsConfig && !wantsTelemetry && !wantsDiagnostics && !wantsAskExplain) {
  return diagnosticsRpcSkipped;
}
```

Pass `wantsAskExplain` through to `assertDiagnosticsRpcAccess` and return early there: unlike the
`index.*` diagnostics, this method reads the in-memory ring and needs **no** `localIndex` and no
`dataDir`, so it must not inherit that requirement. Add the recorder to `ctxBase` from
`ctx.options.askExplainRecorder`, and add the field to `options.ts`. Pass it from
`platform/assemble.ts` where the IPC server is created.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/ipc/ packages/gateway/src/security-invariants.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc packages/gateway/src/platform
git commit -m "feat(ipc): add CLI-only ask.explainLast and forbid the ask namespace over LAN"
```

---

### Task 8: The CLI command and its renderers

Spec §9, §5. Two substantial renderers; two route lines.

**Files:**
- Create: `packages/cli/src/commands/explain.ts`, `packages/cli/src/commands/explain-format.ts`
- Modify: `packages/cli/src/index.ts` (`COMMAND_HANDLERS`)
- Test: `packages/cli/src/commands/explain-format.test.ts`

**Interfaces:**
- Consumes: the `ask.explainLast` result from Task 7.
- Produces: `runExplain(args: string[]): Promise<void>`, `formatExplain(record, opts): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/explain-format.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatExplain } from "./explain-format.ts";

const base = {
  askedAt: 1_700_000_000_000,
  durationMs: 342,
  question: "what did we decide about rate limiting?",
  source: "local" as const,
  persona: "standard",
  modelRoute: { provider: "ollama", model: "llama3.2", isLocal: true },
  classifier: { called: false as const, reason: "local preference" },
};

describe("formatExplain honesty rules (spec §5)", () => {
  test("a score-less candidate renders n/a, never 0.00", () => {
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "rate limiting",
      truncation: { shown: 1, total: 1, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "x", service: "github", indexedType: "pr", title: "Add redis rate limiter",
          pass: { kind: "repo-slug", slug: "acme/api" }, outcome: "shown",
        },
      ],
    });
    expect(out).toContain("n/a (direct query)");
    expect(out).not.toContain("0.00");
  });

  test("a pool mixing two formulas carries the non-comparability disclosure", () => {
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "rate",
      truncation: { shown: 2, total: 2, atLeast: false },
      discardedTail: [],
      pool: [
        { sourceId: "a", service: "slack", indexedType: "message", title: "a",
          score: 0.8, matchScore: 0.9, recencyComponent: 0.8, servicePriorityComponent: 0.5,
          scoringFormula: "hybrid_rrf", pass: { kind: "primary-hybrid" }, outcome: "shown" },
        { sourceId: "b", service: "slack", indexedType: "message", title: "b",
          score: 0.7, matchScore: 0.7, recencyComponent: 0.7, servicePriorityComponent: 0.5,
          scoringFormula: "fts_rank", pass: { kind: "fallback-term", term: "rate" }, outcome: "shown" },
      ],
    });
    expect(out).toMatch(/not comparable/i);
  });

  test("the agent route says ranking happened per tool call, not that nothing ranked", () => {
    const out = formatExplain({
      ...base,
      route: "agent_tools",
      toolCalls: [
        { toolId: "searchLocalIndex", service: "nimbus", status: "ok", durationMs: 12,
          paramsJson: '{"name":"rate"}',
          ranking: { totalMatches: 41, itemsInWindow: 8, sourceSummary: [] } },
      ],
    });
    expect(out).toMatch(/per tool call/i);
    expect(out).not.toMatch(/nothing ranked anything/i);
  });

  test("never claims the model READ what it was given", () => {
    const out = formatExplain({
      ...base, route: "local_context", searchTerms: "x",
      truncation: { shown: 8, total: 41, atLeast: false }, discardedTail: [], pool: [],
    });
    expect(out).toContain("Given to the model");
    expect(out).not.toMatch(/read by the model/i);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/cli/src/commands/explain-format.test.ts`
Expected: FAIL — `Cannot find module './explain-format.ts'`.

- [ ] **Step 3: Write the formatter**

Create `packages/cli/src/commands/explain-format.ts` rendering the header (timestamp, duration,
`source`), the route line and its reason, model route, classifier verdict, and then per route:

- `local_context` — search terms, fallback fired, `Given to the model: N of M matching items`,
  then the pool **grouped by `pass`**, each group labelled with its `scoringFormula`. Emit
  `n/a (direct query)` where `scoringFormula` is absent. Emit the non-comparability line when the
  pool contains more than one distinct `scoringFormula`. Then the discarded tail.
- `agent_tools` — the lead line ("the model chose which tools to call; each `searchLocalIndex`
  call ranked internally, but nothing ranked across the turn"), then one line per call.
- `plan_dispatch` / `empty_index` / `failed` — the route line plus the common fields; for
  `failed`, the stage and error.

- [ ] **Step 4: Write the command**

Two functions, matching the `index health` pattern exactly: `COMMAND_HANDLERS` is typed
`(args: string[]) => Promise<void> | void` (`cli/src/index.ts:92`), and `index-cmd.ts:617`
bridges to its client-taking implementation with `withGatewayIpc((c) => runIndexHealth(c, tail))`.
Follow that — do not hand-roll connect/disconnect.

Create `packages/cli/src/commands/explain.ts`:

```ts
/** Registered in COMMAND_HANDLERS; matches the `(args: string[])` CommandHandler signature. */
export async function runExplainCmd(args: string[]): Promise<void> {
  await withGatewayIpc((c) => runExplain(c, args));
}

/** The client-taking implementation, exported separately so unit tests need no live gateway. */
export async function runExplain(client: IPCClient, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "last") {
    throw new Error("usage: nimbus explain last [--json]");
  }
  const res = await client.call<ExplainLastResult>("ask.explainLast", null);
  if (args.includes("--json")) {
    console.log(JSON.stringify(res, undefined, 2));
    return;
  }
  if (res.record === null) {
    // The ring is in memory only. Saying "no ask recorded since the gateway started" is a
    // different and honest claim; printing an empty report would imply no ask ever happened.
    process.stdout.write("No ask recorded since the gateway started.\n");
    return;
  }
  process.stdout.write(formatExplain(res.record));
}
```

Register it in `packages/cli/src/index.ts`'s `COMMAND_HANDLERS` as `explain: runExplainCmd` —
the `args`-only function, never `runExplain`, whose arity does not match `CommandHandler`.

**Candidate ordering is part of the contract, not the renderer's whim:** group by contributing
pass, and sort by `score` descending *within* each group. Never sort across groups by score —
that is precisely the cross-formula comparison §2.2 forbids. Score-less (repo-slug) candidates
form their own group, ordered as the index returned them (`modified_at DESC`).

- [ ] **Step 5: Run the tests**

Run: `bun test packages/cli/src/commands/explain-format.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/explain.ts packages/cli/src/commands/explain-format.ts packages/cli/src/commands/explain-format.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): add nimbus explain last"
```

---

### Task 9: E2E over a real socket, and the docs

Spec §3.1, §8. **This task is what catches a handler added without a dispatcher route** — a unit test calling the sub-dispatcher directly cannot.

**Files:**
- Create: `packages/gateway/test/e2e/explain-last.e2e.test.ts`
- Modify: `docs/cli-reference.md`, `docs/roadmap.md` (the v0.1.1 batch row), `docs/CHANGELOG.md`, `CLAUDE.md` + `GEMINI.md` (both mirror — update together)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the failing E2E test**

Create `packages/gateway/test/e2e/explain-last.e2e.test.ts`. **Use the existing fixture**
`join(import.meta.dir, "_fixtures", "gateway-runner.ts")` — the same one
`tail-stream.e2e.test.ts` uses. It already handles the fresh temp dir, Windows named pipes
(`\\.\pipe\...`) vs unix sockets, and cleanup on exit; hand-rolling a spawn here would
reintroduce every cross-platform path bug it already solves. Then:

```ts
test("explain last reports the empty state on a fresh gateway, then the ask", async () => {
  // Over a REAL socket: this is the only layer that catches a handler wired into
  // diagnostics-rpc.ts but never added to tryDispatchDiagnosticsRpc's match — that returns
  // "Method not found" live while 60+ unit tests calling the sub-dispatcher stay green.
  const empty = await client.call("ask.explainLast", null);
  expect(empty).toEqual({ record: null, reason: "no_ask_since_start" });

  await client.call("engine.ask", { input: "what is indexed?" }).catch(() => undefined);

  const after = await client.call<{ record: { question: string } | null }>("ask.explainLast", null);
  expect(after.record?.question).toBe("what is indexed?");
});
```

**Note the tree:** this lives under `packages/gateway/test/e2e/`, not `src/` — a gateway-spawning
test in `test/integration/` fails on Linux CI, where only the E2E job wraps the run in D-Bus and
without it the Vault fails and the gateway never binds.

- [ ] **Step 2: Run it to make sure it fails, then passes**

Run: `bun test packages/gateway/test/e2e/explain-last.e2e.test.ts`
Expected: FAIL first if the route is missing (`Method not found: ask.explainLast`), PASS once
Task 7 Step 4's routing entry is in place.

- [ ] **Step 3: Update the docs**

- `docs/cli-reference.md` — add the `nimbus explain last [--json]` entry.
- `docs/roadmap.md` — mark the v0.1.1 batch row shipped, and record §6's three deferrals with
  their reasons (durable table / `explain list` / negation + `indexCountFor` capture).
- `docs/CHANGELOG.md` — a dated entry naming the design doc by file name.
- `CLAUDE.md` **and** `GEMINI.md` — both mirror each other; update together or the drift gate fires.

State plainly in the roadmap row which of the row's original promises had no substrate:
"connector rate-limited" as a discard reason, and "queried vs. answered from cache". Do not
quietly drop them (spec §5).

- [ ] **Step 4: Run the full gate set**

Run: `bun run preflight`
Expected: green. If `audit:doc-refs` fails, a path cited in the docs does not resolve — fix the
path, not the gate.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/test/e2e/explain-last.e2e.test.ts docs CLAUDE.md GEMINI.md
git commit -m "test(e2e): prove explain last over a real socket; document the command"
```

---

## Self-review notes

**Spec coverage.** §2.1→T1, §2.2→T1+T8, §2.3→T3, §2.4→T1+T4+T8, §2.5→T4+T5, §3.1→T7+T9,
§3.2→T7, §4.1→T2, §4.2→T6, §4.3→T6, §4.4→T4, §4.5→T5, §4.6→T3, §5→T8, §6→T9 (deferrals recorded),
§7→all, §8→T1–T9, §9→T2+T8.

**Deliberately deferred (spec §6), do not implement:** the durable `ask_explain` table,
`nimbus explain list` / `explain <n>`, and capture of negation predicates / `indexCountFor`.

**The three highest-risk steps**, called out so a reviewer gates them hardest:

1. **Task 7 Step 3** — the `FORBIDDEN_OVER_LAN` entry. It is a *denylist*; the spec's first draft
   had this backwards, and without the entry the method ships reachable by any paired peer,
   carrying the owner's question text.
2. **Task 7 Step 4** — the `tryDispatchDiagnosticsRpc` routing entry. A handler without it is
   green in every unit test and `Method not found` over a real socket. Task 9's E2E is the only
   layer that catches it.
3. **Task 4 Step 3** — the `rankedById` parallel map. `byId` holds
   `Omit<LocalContextItem, "rank">`, and `formatContextItem` **drops every score field**, so
   reading components off a `byId` value yields `undefined` for every candidate, renders every
   row as `n/a (direct query)`, and silently defeats Task 1 entirely. The "a SHOWN candidate
   carries real score components" test exists solely to make that failure loud — without it the
   whole file passes in the broken world.

**Fixed in review, worth not regressing:** `upsertIndexedItem` is a standalone function in
`item-store.ts`, not a `LocalIndex` method; `redactAuditPayload` lives in
`audit/format-audit-payload.ts` and is already imported by `agent.ts`; `RankedIndexItem` carries
`.indexPrimaryKey`/`.name`, never `.sourceId`/`.title`; `COMMAND_HANDLERS` entries take
`args: string[]` only; `modelRoute` is optional because `empty_index` and classification-stage
failures resolve no model.
