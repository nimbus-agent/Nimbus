# `nimbus negotiate` Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `nimbus negotiate` agent that assembles a cited contribution brief for a person over a time window, from evidence already in the local index.

**Architecture:** Request-scoped and HITL-free, following `why` / `expert` / `catchup`. Six independent lanes fan out through `AgentCoordinator`, each a bounded SQL query over existing rows. No migration, no new table, no background pass. Every number is computed in SQL; `emitBriefWithSynthesis` writes only the narrative around them.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:sqlite`, Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-12-nimbus-negotiate-agent-design.md`
**Review response:** `docs/superpowers/specs/2026-08-12-nimbus-negotiate-agent-design-review-response.md`

## Global Constraints

- **No `any`.** `unknown` for external data. TypeScript strict.
- **Bound-param SQL only** (I9). Production (`src/` non-test) writes go through `dbRun`/`dbExec` (I14) — **this agent writes nothing**; every query is a read. Test files seeding fixtures with `db.run(...)` is correct and intentional.
- **No migration, no SQL DDL.** If you find yourself writing `CREATE TABLE`, stop — something is wrong.
- **No new `GapCategory` value.** The type ships from `@nimbus-dev/sdk` and the existing five are `missing_entity_type`, `missing_relation_emit`, `missing_connector`, `missing_user_identity`, `empty_index`. Anything that does not fit one of those belongs in a typed brief field rendered as prose, not a gap note.
- **Read-only and HITL-free.** No `ToolExecutor` import, no `HITL_REQUIRED` reference, no connector call. The agent opens nothing and fetches nothing.
- **Never commit on `main`.** Work lands on `dev/asafgolombek/negotiate-agent`, already checked out.
- **Run `bun run preflight:fast` before every commit.** Chain gates with `&&`, never `;` — a `;` lets a failing gate through to the commit.
- **Coverage floor is 85% line / 80% branch per file**, measured against a **full-suite** lcov (`bash scripts/coverage-floor/build-lcov.sh` then `bun run audit:coverage-floor`). A scoped per-directory istanbul run under-reports badly and must not be used to answer a floor question.
- **`bun run typecheck:tests` before pushing** — advisory on Windows, gating on CI-Linux; read the "N new" line.
- **Editor diagnostics have been stale every time in this project.** Mid-edit "declared but never read" and argument-count warnings are noise; `bun run typecheck` (0 errors) and the suites are authoritative.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `packages/gateway/src/agents/_lib/negotiate-types.ts` | `NegotiateInput`, `NegotiateBrief` and its section types | Create |
| `packages/gateway/src/agents/negotiate.ts` | `runNegotiate` + `emitNegotiateBrief`; subject resolution; six lanes | Create |
| `packages/gateway/src/agents/negotiate.test.ts` | Per-lane unit tests | Create |
| `packages/gateway/src/ipc/agents-rpc.ts` | `handleNegotiate`, `AGENTS_RPC_HANDLERS` entry, `HTTP_EXCLUDED_AGENT_METHODS` entry | Modify |
| `packages/gateway/src/config/nimbus-toml.ts` | `[negotiate]` block for the personal-docs opt-in | Modify |
| `packages/cli/src/commands/negotiate.ts` | `nimbus negotiate` CLI | Create |
| `packages/cli/src/index.ts` | Command registry entry | Modify |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | `ALLOWED_METHODS` + the `105 → 106` count assertion | Modify |
| `packages/gateway/test/e2e/scenarios/negotiate.e2e.test.ts` | Brief sections, notification, zero HITL | Create |
| `docs/connectors/…` / `docs/cli-reference.md` / `docs/CHANGELOG.md` | Documentation | Modify |

## Facts resolved at plan time

The spec left three questions open. All three are now answered — do not re-derive them:

1. **Review state** lives at the `review` item's `metadata.state`, written from `review["state"]` in `upsertReview` and **nullable**. GitHub emits `approved`, `changes_requested`, `commented`, `dismissed`. The lane needs a null arm.
2. **Decisions can be unattributable.** `obsidian-sync.ts` and `teams-sync.ts` set no `authorId` at all, so a `decision_record` mined from those sources resolves to an item with `author_id IS NULL`. The gap note is **required**, not conditional.
3. **Ownership staleness is citable.** `ownership_pass_state.last_pass_at` exists (nullable `INTEGER`).

## Reference signatures

Copied from the tree; use these exactly.

```ts
// agents/_lib/self-person.ts
resolveSelfPerson(db, { override?, runGit?, osUsername? }): Promise<{ personId: string | null; source: "override" | "git" | "os" | "unresolved" }>

// agents/_lib/gap-notes.ts
detectEmptyIndex(db): GapNote | null

// engine/coordinator.ts — used exactly as agents/catchup.ts does
new AgentCoordinator({ sessionId, parentId, depth: 1, toolCallCount: { value: 0 } })
const tasks: SubTask[] = [{ taskType: "agent_step", prompt: "", execute: async () => ({ text: JSON.stringify(out), tokensIn: 0, tokensOut: 0 }) }]
await coordinator.run(tasks)  // results carry .status ("done") and .text

// agents/_lib/emit-brief.ts
emitBriefWithSynthesis({ sessionId, briefReadyMethod, briefErrorMethod, notify, llm?, buildBrief }): Promise<{ sessionId: string }>

// @nimbus-dev/sdk — GapCategory is exactly these five
"missing_entity_type" | "missing_relation_emit" | "missing_connector" | "missing_user_identity" | "empty_index"
```

---

## Task 1: Brief types, subject resolution, and an honest empty brief

**Files:**

- Create: `packages/gateway/src/agents/_lib/negotiate-types.ts`
- Create: `packages/gateway/src/agents/negotiate.ts`
- Create: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Consumes: `resolveSelfPerson`, `detectEmptyIndex`, `AgentCoordinator`, `emitBriefWithSynthesis`.
- Produces: `runNegotiate(input: NegotiateInput, ctx: NegotiateContext): Promise<NegotiateBrief>` and `emitNegotiateBrief(input, ctx): Promise<{ sessionId: string }>`. Later tasks add lanes by appending to the `SubTask[]` and filling one section of `NegotiateBrief`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/negotiate.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { runNegotiate } from "./negotiate.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function ctxFor(db: Database) {
  return { db, notify: () => {}, sessionId: "negotiate-test-1" };
}

test("an empty index yields an empty_index gap, not zeroes", async () => {
  const db = freshDb();
  const brief = await runNegotiate(
    { sinceMs: 90 * 24 * 60 * 60 * 1000, mePersonIdOverride: "person:me" },
    ctxFor(db),
  );
  expect(brief.gaps.map((g) => g.category)).toContain("empty_index");
  db.close();
});

test("an unresolved subject yields missing_user_identity", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  const brief = await runNegotiate(
    { sinceMs: 1000, runGitOverride: async () => null, osUsernameOverride: "" },
    ctxFor(db),
  );
  expect(brief.gaps.map((g) => g.category)).toContain("missing_user_identity");
  expect(brief.subject.personId).toBeNull();
  db.close();
});

test("the brief states its window and subject", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  const brief = await runNegotiate(
    { sinceMs: 5000, mePersonIdOverride: "person:me" },
    ctxFor(db),
  );
  expect(brief.kind).toBe("negotiate");
  expect(brief.query.sinceMs).toBe(5000);
  expect(brief.subject.personId).toBe("person:me");
  expect(brief.subject.source).toBe("override");
  expect(brief.generatedAt).toBeGreaterThan(0);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: FAIL — module `./negotiate.ts` does not exist.

- [ ] **Step 3: Write the brief types**

Create `packages/gateway/src/agents/_lib/negotiate-types.ts`:

```typescript
import type { GapNote } from "@nimbus-dev/sdk";

import type { GitRunner } from "./self-person.ts";

/** Request params. `personId` targets someone other than the local user (see spec § 3.2). */
export type NegotiateInput = {
  readonly sinceMs?: number;
  /** `--person <id>`: brief a different subject. Same-machine callers only (spec § 3.1). */
  readonly personId?: string;
  readonly mePersonIdOverride?: string;
  readonly runGitOverride?: GitRunner;
  readonly osUsernameOverride?: string;
};

export type NegotiateSubject = {
  readonly personId: string | null;
  readonly source: "override" | "git" | "os" | "unresolved" | "explicit";
  readonly displayName: string | null;
  /** True when `--person` named someone other than the resolved local user. */
  readonly isOther: boolean;
};

/**
 * Coverage for an aggregate computed over a subset. `total` is the denominator the
 * aggregate SHOULD have covered; `covered` is what it actually did. Rendered only
 * when `covered < total` — spec § 5.B, matching `decisions`' conditional note.
 */
export type NegotiateCoverage = {
  readonly covered: number;
  readonly total: number;
};

export type NegotiateBrief = {
  readonly kind: "negotiate";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: { readonly sinceMs: number };
  readonly subject: NegotiateSubject;
  /** Sources the brief drew on, including whether personal documents were configured (§ 5.F). */
  readonly sources: {
    readonly personalDocsConfigured: boolean;
    readonly personalDocsConfigKey: string;
  };
};
```

- [ ] **Step 4: Write the agent shell**

Create `packages/gateway/src/agents/negotiate.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";

import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import { detectEmptyIndex } from "./_lib/gap-notes.ts";
import type { NegotiateBrief, NegotiateInput, NegotiateSubject } from "./_lib/negotiate-types.ts";
import { resolveSelfPerson } from "./_lib/self-person.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

const DEFAULT_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SINCE_MS = 365 * 24 * 60 * 60 * 1000;

export type NegotiateContext = {
  db: Database;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

const PERSONAL_DOCS_CONFIG_KEY = "[negotiate] personal_sources";

function safeOsUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

function unresolvedIdentityGap(): GapNote {
  return {
    category: "missing_user_identity",
    detail:
      "Could not resolve the subject — no override / git email / OS username matched a known person.",
    remediation:
      "Set `[user] me_person_id` in your active profile's nimbus.toml, or run `nimbus people search <you>` to find your person id.",
  };
}

export async function runNegotiate(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<NegotiateBrief> {
  const start = performance.now();
  const sinceMs = Math.min(input.sinceMs ?? DEFAULT_SINCE_MS, MAX_SINCE_MS);
  const gaps: GapNote[] = [];

  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) gaps.push(empty);

  const subject = await resolveSubject(ctx.db, input);
  if (subject.personId === null) gaps.push(unresolvedIdentityGap());

  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { sinceMs },
    subject,
    sources: {
      personalDocsConfigured: false,
      personalDocsConfigKey: PERSONAL_DOCS_CONFIG_KEY,
    },
  };
}

async function resolveSubject(db: Database, input: NegotiateInput): Promise<NegotiateSubject> {
  if (input.personId !== undefined && input.personId.length > 0) {
    return {
      personId: input.personId,
      source: "explicit",
      displayName: personDisplayNameOrNull(db, input.personId),
      isOther: true,
    };
  }
  const resolution = await resolveSelfPerson(db, {
    ...(input.mePersonIdOverride === undefined ? {} : { override: input.mePersonIdOverride }),
    ...(input.runGitOverride === undefined ? {} : { runGit: input.runGitOverride }),
    osUsername: input.osUsernameOverride ?? safeOsUsername(),
  });
  return {
    personId: resolution.personId,
    source: resolution.source,
    displayName:
      resolution.personId === null ? null : personDisplayNameOrNull(db, resolution.personId),
    isOther: false,
  };
}

function personDisplayNameOrNull(db: Database, personId: string): string | null {
  const row = db.query("SELECT display_name FROM person WHERE id = ?").get(personId) as
    | { display_name: string | null }
    | null;
  return row?.display_name ?? null;
}

export function emitNegotiateBrief(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "negotiate.briefReady",
    briefErrorMethod: "negotiate.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runNegotiate(input, ctx),
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write the failing test for the unconditional absent-evidence note**

Spec § 5.D: incidents resolved, on-call shifts and deploys triggered do not exist in the index at
all. The brief names them **unconditionally**, so an empty section is never read as zero. This note
does not turn off — a reader inferring "handled no incidents" from silence is the failure this agent
most needs to prevent.

```typescript
test("the brief always names the evidence that does not exist", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.unavailableEvidence).toEqual([
    "incidents resolved",
    "on-call shifts",
    "deploys triggered",
  ]);
  db.close();
});
```

- [ ] **Step 7: Implement the absent-evidence note**

Add to `NegotiateBrief` in `_lib/negotiate-types.ts`:

```typescript
  /**
   * Evidence the index cannot supply at all (spec § 5.D). Rendered unconditionally so an
   * empty section is never read as a zero. Deliberately NOT a GapNote: these are not gaps
   * in this run, they are permanent limits of the index.
   */
  readonly unavailableEvidence: readonly string[];
```

and in `negotiate.ts`:

```typescript
const UNAVAILABLE_EVIDENCE: readonly string[] = Object.freeze([
  "incidents resolved",
  "on-call shifts",
  "deploys triggered",
]);
```

returned as `unavailableEvidence: UNAVAILABLE_EVIDENCE` from `runNegotiate`.

- [ ] **Step 8: Implement the lane-failure mechanism (the TEST lives in Task 2)**

Spec § 4: a failed lane degrades to a gap note, **never a silent zero**. A brief that renders `0`
for a lane that threw is a lie, and it is the shape most likely to pass review unnoticed.

**Task 1 has no lanes yet**, so there is nothing here to make fail — the test belongs with the first
real lane and is specified in Task 2. Task 1 builds only the mechanism:

- Every lane-backed field on `NegotiateBrief` is declared `… | null` and **initialised to `null`**
  before the coordinator runs, so "the lane failed" is distinguishable from "the lane ran and found
  nothing" (`0`). Later tasks add their fields under that same rule.
- When `coordinator.run(tasks)` returns a result whose `status !== "done"` — or whose `text` cannot
  be decoded — push a `GapNote` naming the lane, leaving that field at `null`. Use category
  `missing_connector` (an existing value; do **not** add a new `GapCategory`) and put the lane name
  in `detail` so the Task 2 test can match on it.

Wire this now even though no lane exercises it, because Task 2 onwards depends on the shape.

- [ ] **Step 9: Register the brief with the deterministic renderer**

**Task 1 cannot compile without this.** `agents/_lib/synthesize.ts` defines `SynthInput` as a CLOSED
union (`:52`) and `deterministicRender` ends in `assertNeverBrief(brief)` (`:99`). `toolNameFor`
(`:102`) is the same shape. So adding a brief kind requires three edits there, and omitting them is a
typecheck failure, not a silent gap:

1. add `NegotiateBrief` to the `SynthInput` union;
2. add `if (brief.kind === "negotiate") return renderNegotiate(brief);` to `deterministicRender`;
3. add `if (brief.kind === "negotiate") return "agents.negotiate";` to `toolNameFor`.

Write `renderNegotiate` in `packages/gateway/src/agents/_lib/render.ts` — **that is where the
`render*` functions live, not `synthesize.ts`**, which only dispatches to them — following their
style. **This
function is the deliverable** — the Markdown a person reads and may hand to a manager. Task 1's
version renders only what Task 1 produces: the subject (naming them explicitly when
`subject.isOther`), the window and generation time, the gap notes, and the unconditional
`unavailableEvidence` list. **Each later lane task extends it**, and a lane whose field is `null`
renders as "could not be computed", never as `0`.

Add a test asserting the no-LLM path produces usable Markdown:

```typescript
test("renders deterministically with no LLM configured", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  let captured: { brief: string } | undefined;
  await emitNegotiateBrief(
    { mePersonIdOverride: "person:me" },
    {
      db,
      sessionId: "s1",
      notify: (method, params) => {
        if (method === "negotiate.briefReady") captured = params as { brief: string };
      },
    },
  );
  expect(captured?.brief ?? "").toContain("incidents resolved");
  db.close();
});
```

`synthesize` already falls back to `deterministicRender` when `llm` is undefined, when it returns
empty, and when it throws (`synthesize.ts:132-154`) — this test pins that the negotiate path
actually reaches it, which matters because the no-LLM path is a documented trap in this codebase.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 11: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/agents/ && \
git commit -m "feat(agents): negotiate shell, deterministic render, absent-evidence note"
```

---

## Task 2: PR lanes — authored and reviewed

> **Every lane task from here also extends `renderNegotiate`** in `agents/_lib/render.ts` with
> its own section. A lane field left at `null` — meaning the lane failed — must render as "could not
> be computed", never as `0`. That distinction is the whole point of the nullable fields Task 1
> introduced, and it is lost the moment a renderer prints `?? 0`.

**Files:**

- Modify: `packages/gateway/src/agents/negotiate.ts`
- Modify: `packages/gateway/src/agents/_lib/negotiate-types.ts`
- Test: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Consumes: Task 1's `runNegotiate` and `NegotiateBrief`.
- Produces: `brief.authoredPrs: { count, merged, stats: { additions, deletions, changedFiles } | null, statsCoverage: NegotiateCoverage }` and `brief.reviewedPrs: { count, approved, changesRequested, otherOrUnknown }`.

**Context:** `person --authored--> pr` and `person --reviewed--> pr` edges both exist (the latter shipped in #1159). PR size stats live in the PR item's `metadata` as `additions` / `deletions` / `changed_files` / `commits`, present **only** where the enrichment pass has run — hence the coverage field. Review state is at the `review` item's `metadata.state` and is **nullable**.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/agents/negotiate.test.ts`:

```typescript
import { upsertIndexedItem } from "../index/item-store.ts";

function seedPr(
  db: Database,
  num: number,
  authorId: string | null,
  extraMeta: Record<string, unknown> = {},
): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: `acme/app#${String(num)}`,
    title: `PR title ${String(num)}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId,
    metadata: { repo: "acme/app", number: num, merged: true, ...extraMeta },
  });
}

function seedReview(db: Database, num: number, reviewerId: string, state: string | null): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: `acme/app#${String(num)}#review-${String(num)}`,
    title: `Review on acme/app#${String(num)}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: reviewerId,
    metadata: { repo: "acme/app", pr_number: num, review_id: num, state },
  });
}

test("authored PRs are counted, with stats coverage when only some are enriched", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedPr(db, 1, "person:me", { additions: 100, deletions: 20, changed_files: 3 });
  seedPr(db, 2, "person:me"); // no stats
  seedPr(db, 3, "person:other");

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.authoredPrs.count).toBe(2);
  expect(brief.authoredPrs.statsCoverage).toEqual({ covered: 1, total: 2 });
  expect(brief.authoredPrs.stats?.additions).toBe(100);
  db.close();
});

test("reviewed PRs split by state, with a null-state arm", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedPr(db, 1, "person:author");
  seedPr(db, 2, "person:author");
  seedPr(db, 3, "person:author");
  seedReview(db, 1, "person:me", "approved");
  seedReview(db, 2, "person:me", "changes_requested");
  seedReview(db, 3, "person:me", null);

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.reviewedPrs.count).toBe(3);
  expect(brief.reviewedPrs.approved).toBe(1);
  expect(brief.reviewedPrs.changesRequested).toBe(1);
  expect(brief.reviewedPrs.otherOrUnknown).toBe(1);
  db.close();
});

test("stats coverage is complete when every authored PR is enriched", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedPr(db, 1, "person:me", { additions: 10, deletions: 1, changed_files: 1 });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.authoredPrs.statsCoverage).toEqual({ covered: 1, total: 1 });
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: FAIL — `brief.authoredPrs` is undefined.

- [ ] **Step 3: Add the section types**

Append to `_lib/negotiate-types.ts`, and add both fields to `NegotiateBrief`:

```typescript
export type NegotiateAuthoredPrs = {
  readonly count: number;
  readonly merged: number;
  readonly stats: { readonly additions: number; readonly deletions: number; readonly changedFiles: number } | null;
  readonly statsCoverage: NegotiateCoverage;
};

export type NegotiateReviewedPrs = {
  readonly count: number;
  readonly approved: number;
  readonly changesRequested: number;
  /** `commented`, `dismissed`, or a null `metadata.state` — counted, never dropped. */
  readonly otherOrUnknown: number;
};
```

- [ ] **Step 4: Implement both lanes**

In `negotiate.ts`, add these two functions and wire them through `AgentCoordinator` exactly as `catchup.ts` does — build a `SubTask[]`, `await coordinator.run(tasks)`, then decode each `r.text` with `JSON.parse` when `r.status === "done"`, pushing a gap note for any lane that did not complete.

```typescript
function laneAuthoredPrs(db: Database, personId: string, sinceMs: number): NegotiateAuthoredPrs {
  const cutoff = Date.now() - sinceMs;
  const rows = db
    .query(
      `SELECT i.metadata AS metadata
         FROM graph_relation r
         JOIN graph_entity pe  ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity pre ON pre.id = r.to_id  AND pre.type = 'pr'
         JOIN item i           ON i.id = pre.external_id
        WHERE r.type = 'authored' AND pe.external_id = ? AND i.modified_at >= ?`,
    )
    .all(personId, cutoff) as Array<{ metadata: string }>;

  let merged = 0;
  let covered = 0;
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const row of rows) {
    let meta: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable metadata contributes to neither the merged count nor stats coverage.
      continue;
    }
    if (meta["merged"] === true) merged += 1;
    const a = meta["additions"];
    if (typeof a === "number") {
      covered += 1;
      additions += a;
      const d = meta["deletions"];
      if (typeof d === "number") deletions += d;
      const c = meta["changed_files"];
      if (typeof c === "number") changedFiles += c;
    }
  }
  return {
    count: rows.length,
    merged,
    stats: covered === 0 ? null : { additions, deletions, changedFiles },
    statsCoverage: { covered, total: rows.length },
  };
}

function laneReviewedPrs(db: Database, personId: string, sinceMs: number): NegotiateReviewedPrs {
  const cutoff = Date.now() - sinceMs;
  const rows = db
    .query(
      `SELECT json_extract(i.metadata, '$.state') AS state
         FROM item i
        WHERE i.service = 'github'
          AND i.type = 'review'
          AND i.author_id = ?
          AND i.modified_at >= ?
          AND json_valid(i.metadata)`,
    )
    .all(personId, cutoff) as Array<{ state: string | null }>;

  let approved = 0;
  let changesRequested = 0;
  let otherOrUnknown = 0;
  for (const r of rows) {
    if (r.state === "approved") approved += 1;
    else if (r.state === "changes_requested") changesRequested += 1;
    else otherOrUnknown += 1;
  }
  return { count: rows.length, approved, changesRequested, otherOrUnknown };
}
```

**`json_valid(i.metadata)` in the WHERE clause is required**, not decorative: `json_extract` raises `SQLiteError: malformed JSON` on unparseable text, and an unguarded call in a WHERE clause kills the query for every row, not just the bad one. Measured on bun 1.3.14 / SQLite 3.53.0 — do not remove it.

**On indexes, and why this plan adds none.** `item` carries indexes on `service`, `type`,
`modified_at` and `resolve_key` — **not** on `author_id` (verified). So the reviewed-PR and writing
lanes filter on an unindexed column after an indexed narrowing. That is deliberate for now: adding
an index means a migration, which this plan forbids, and the lanes narrow hard first
(`service = 'github' AND type = 'review'`) before any JSON parsing, so the row set reaching
`json_extract` is small on a personal index. If profiling on a large index shows otherwise, an
`item(author_id)` index is a separate, deliberate migration — not something to slip into this PR.

- [ ] **Step 5: Write the lane-failure test — the first real lane makes this testable**

Task 1 built the mechanism (nullable lane fields, a gap note when a lane does not complete) but had
no lane to exercise it. This task has two, so the test lands here.

```typescript
test("a lane that throws yields a gap note, not a zero", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  // Break a table the authored-PR lane depends on so that lane throws.
  db.run("DROP TABLE graph_relation");

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.authoredPrs).toBeNull();
  expect(brief.gaps.some((g) => g.detail.toLowerCase().includes("lane"))).toBe(true);
  db.close();
});
```

**Red-prove it:** make the lane swallow its own error and return zeroes instead of rethrowing.
The test must FAIL on `expect(brief.authoredPrs).toBeNull()` — receiving an object of zeroes. Restore.
A lane that reports `0` for a query that threw is the exact defect this test exists to catch, and it
is invisible to every other test in the suite.

- [ ] **Step 6: Run to verify the tests pass**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/agents/ && \
git commit -m "feat(agents): negotiate authored and reviewed PR lanes"
```

---

## Task 3: Tickets lane

**Files:**

- Modify: `packages/gateway/src/agents/negotiate.ts`, `_lib/negotiate-types.ts`
- Test: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Produces: `brief.tickets: { opened: number; closedByAuthoredPr: number }`.

**Context:** `person --opened--> issue` gives tickets opened. Tickets closed by your work traverse `person --authored--> pr --resolves--> issue`. The `resolves` edge is emitted by `syncPrGraph` from issue references in the PR body.

- [ ] **Step 1: Write the failing test**

```typescript
test("tickets counts opened, and closed via an authored PR's resolves edge", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);

  // Issue must exist BEFORE the PR: syncPrGraph only wires `resolves` against
  // issue entities already present at PR-sync time.
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#issue-7",
    title: "Login broken",
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: "person:me",
    metadata: { repo: "acme/app", number: 7 },
  });
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #7",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: "person:me",
    metadata: { repo: "acme/app", number: 1 },
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.tickets.opened).toBe(1);
  expect(brief.tickets.closedByAuthoredPr).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts -t "tickets"`
Expected: FAIL — `brief.tickets` is undefined.

- [ ] **Step 3: Add the type and implement**

```typescript
export type NegotiateTickets = {
  readonly opened: number;
  readonly closedByAuthoredPr: number;
};
```

```typescript
function laneTickets(db: Database, personId: string, sinceMs: number): NegotiateTickets {
  const cutoff = Date.now() - sinceMs;
  const opened = db
    .query(
      `SELECT COUNT(*) AS n
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'issue'
         JOIN item i          ON i.id = ie.external_id
        WHERE r.type = 'opened' AND pe.external_id = ? AND i.modified_at >= ?`,
    )
    .get(personId, cutoff) as { n: number };

  const closed = db
    .query(
      `SELECT COUNT(DISTINCT res.to_id) AS n
         FROM graph_relation auth
         JOIN graph_entity pe   ON pe.id = auth.from_id AND pe.type = 'person'
         JOIN graph_entity pre  ON pre.id = auth.to_id  AND pre.type = 'pr'
         JOIN item pri          ON pri.id = pre.external_id
         JOIN graph_relation res ON res.from_id = pre.id AND res.type = 'resolves'
        WHERE auth.type = 'authored' AND pe.external_id = ? AND pri.modified_at >= ?`,
    )
    .get(personId, cutoff) as { n: number };

  return { opened: opened.n, closedByAuthoredPr: closed.n };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/agents/ && \
git commit -m "feat(agents): negotiate tickets lane"
```

---

## Task 4: Ownership lane, and the unmapped-git-identity gap

**Files:**

- Modify: `packages/gateway/src/agents/negotiate.ts`, `_lib/negotiate-types.ts`
- Test: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Produces: `brief.ownership: { services: string[]; directories: string[]; lastPassAt: number | null; truncated: boolean }`.

**Context — read this before writing the query.** `ownership/owner-identity.ts` `resolveOwner` maps a blame email to a `person` row via `findPersonByCanonicalEmail`. An email that does **not** match yields an owner entity keyed `git:<email>` which is **never inserted into the `person` table**. So the `owns` graph mixes person-keyed and `git:`-keyed entities, and querying by person id silently omits every contribution made under an unmapped alias — a second machine, an old address, a GitHub `noreply`. **An undercount in this brief is the worst failure this agent can have** (spec § 5.A0).

`maxOwnersPerPath` bounds owners per path, not paths per owner, so aggregate to directory and service level with an explicit `LIMIT` — never list files. The lane reads precomputed `owns` edges and must **not** touch `git_blame_line`.

- [ ] **Step 1: Write the failing test**

```typescript
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";

test("ownership reports services and cites the pass timestamp", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  db.run("INSERT INTO ownership_pass_state (id, last_pass_at) VALUES (1, 1700000000000)");
  const me = upsertGraphEntity(db, { type: "person", externalId: "person:me", label: "Me" });
  const svc = upsertGraphEntity(db, { type: "service", externalId: "svc:api", label: "api" });
  upsertGraphRelation(db, me, svc, "owns", Date.now(), 0.8);

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.ownership.services).toEqual(["api"]);
  expect(brief.ownership.lastPassAt).toBe(1700000000000);
  db.close();
});

// THE UNDERCOUNT GUARD. Without it, work under an unmapped git alias vanishes silently.
test("an unmapped git identity for the self subject raises a named gap", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
    "person:me",
    "Me",
    "me@work.example",
  ]);
  // Ownership recorded under a DIFFERENT, unmapped email — exactly what resolveOwner emits.
  const ghost = upsertGraphEntity(db, {
    type: "person",
    externalId: "git:me@personal.example",
    label: "me@personal.example",
  });
  const svc = upsertGraphEntity(db, { type: "service", externalId: "svc:api", label: "api" });
  upsertGraphRelation(db, ghost, svc, "owns", Date.now(), 0.9);

  const brief = await runNegotiate(
    { runGitOverride: async () => "me@personal.example", osUsernameOverride: "" },
    ctxFor(db),
  );

  const gap = brief.gaps.find((g) => g.detail.includes("unmapped git identity"));
  expect(gap).toBeDefined();
  expect(gap?.category).toBe("missing_user_identity");
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts -t "ownership"`
Expected: FAIL — `brief.ownership` is undefined.

- [ ] **Step 3: Add the type**

```typescript
export type NegotiateOwnership = {
  readonly services: string[];
  readonly directories: string[];
  /** `ownership_pass_state.last_pass_at`; null when the pass has never run. */
  readonly lastPassAt: number | null;
  /** True when the LIMIT clipped the result — rendered so a partial list never reads as complete. */
  readonly truncated: boolean;
};
```

- [ ] **Step 4: Implement the lane and the gap**

```typescript
const OWNERSHIP_LIMIT = 50;

function laneOwnership(db: Database, personId: string): NegotiateOwnership {
  const rows = db
    .query(
      `SELECT te.type AS target_type, te.label AS label
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity te ON te.id = r.to_id
        WHERE r.type = 'owns'
          AND pe.external_id = ?
          AND te.type IN ('service', 'directory')
        ORDER BY r.weight DESC
        LIMIT ?`,
    )
    .all(personId, OWNERSHIP_LIMIT + 1) as Array<{ target_type: string; label: string }>;

  const truncated = rows.length > OWNERSHIP_LIMIT;
  const kept = truncated ? rows.slice(0, OWNERSHIP_LIMIT) : rows;
  const state = db.query("SELECT last_pass_at FROM ownership_pass_state WHERE id = 1").get() as
    | { last_pass_at: number | null }
    | null;

  return {
    services: kept.filter((r) => r.target_type === "service").map((r) => r.label),
    directories: kept.filter((r) => r.target_type === "directory").map((r) => r.label),
    lastPassAt: state?.last_pass_at ?? null,
    truncated,
  };
}

/**
 * Spec § 5.A0. `resolveOwner` emits `git:<email>` for a blame email with no `person` row, so
 * ownership recorded under an unmapped alias is attributed to a separate entity and would vanish
 * from this brief. For the SELF subject we know the git email `resolveSelfPerson` used, so we can
 * name the gap precisely instead of carrying a generic caveat.
 */
function detectUnmappedGitIdentity(db: Database, gitEmail: string | null): GapNote | null {
  if (gitEmail === null || gitEmail.trim() === "") return null;
  const row = db
    .query(
      `SELECT 1 AS n FROM graph_entity
        WHERE type = 'person' AND external_id = ? LIMIT 1`,
    )
    .get(`git:${gitEmail.trim().toLowerCase()}`) as { n?: number } | null;
  if (row === null) return null;
  return {
    category: "missing_user_identity",
    detail:
      "Some of your ownership is recorded under an unmapped git identity and is not counted here.",
    remediation:
      "Add that git email to your person record so blame lines written under it are attributed to you.",
  };
}
```

Call `detectUnmappedGitIdentity` only when the subject resolved via `git` (`subject.source === "git"`)
or when a git email is otherwise known — for an `explicit` `--person` subject the alias set is
unknowable.

**For the `--person` case, report a fact, never a guess.** Add a count of `git:`-prefixed owner
entities present in the index:

```typescript
function countUnmappedOwnerIdentities(db: Database): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM graph_entity
        WHERE type = 'person' AND external_id LIKE 'git:%'`,
    )
    .get() as { n: number };
  return row.n;
}
```

Surface it on `brief.ownership` as `unmappedIdentitiesInIndex: number`, rendered as "N git identities
in this index are not mapped to a person; ownership attributed to them is not counted here."

**Do NOT attempt to match those entities to the subject by name or email substring.** It was
suggested, and it is the wrong trade here: a heuristic that guesses which aliases belong to a person
produces attribution errors in a document that may influence someone's compensation, and a wrong
attribution is worse than an acknowledged gap. The count is a true statement about the index; a
substring match would be a claim about a person.

- [ ] **Step 5: Run to verify the tests pass**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Red-prove the undercount guard**

Temporarily make `detectUnmappedGitIdentity` return `null` unconditionally. Run:

`bun test packages/gateway/src/agents/negotiate.test.ts -t "unmapped git identity"`

Expected: that test **FAILS** (`gap` is `undefined`). Restore. If it passes without the detector, the test is not exercising the gap and must be fixed before continuing — this is the single defect this task exists to prevent.

- [ ] **Step 7: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/agents/ && \
git commit -m "feat(agents): negotiate ownership lane with unmapped-identity gap"
```

---

## Task 5: Decisions lane

**Files:**

- Modify: `packages/gateway/src/agents/negotiate.ts`, `_lib/negotiate-types.ts`
- Test: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Produces: `brief.decisions: { authored: number; unattributable: number }`.

**Context:** `decision_record.source_item_id` joins to `item`, and the item's `author_id` gives the decision's author. **Nothing in `decisions/` reads `author_id` today — this join is new.** Resolved at plan time: `obsidian-sync.ts` and `teams-sync.ts` set no `authorId`, so decisions mined from those sources have a null author. The `unattributable` count is **required**, so those rows are reported rather than silently dropped.

- [ ] **Step 1: Write the failing test**

```typescript
test("decisions counts authored and reports unattributable separately", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();

  upsertIndexedItem(db, {
    service: "slack", type: "message", externalId: "C1/1.1", title: "we decided X",
    bodyPreview: "", modifiedAt: now, syncedAt: now, authorId: "person:me", metadata: {},
  });
  upsertIndexedItem(db, {
    service: "obsidian", type: "obsidian_note", externalId: "note-1", title: "we decided Y",
    bodyPreview: "", modifiedAt: now, syncedAt: now, authorId: null, metadata: {},
  });

  for (const [id, src] of [["d1", "slack:C1/1.1"], ["d2", "obsidian:note-1"]] as const) {
    db.run(
      `INSERT INTO decision_record
         (id, source_item_id, status, cue_tier, cue_text, priority, confidence, decided_at, updated_at)
       VALUES (?, ?, 'extracted', 'explicit', 'we decided', 1, 0.8, ?, ?)`,
      [id, src, now, now],
    );
  }

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.decisions.authored).toBe(1);
  expect(brief.decisions.unattributable).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts -t "decisions"`
Expected: FAIL — `brief.decisions` is undefined.

- [ ] **Step 3: Add the type and implement**

```typescript
export type NegotiateDecisions = {
  readonly authored: number;
  /** Decisions whose source item has no author — counted, never dropped (spec § 8.2). */
  readonly unattributable: number;
};
```

```typescript
function laneDecisions(db: Database, personId: string, sinceMs: number): NegotiateDecisions {
  const cutoff = Date.now() - sinceMs;
  const authored = db
    .query(
      `SELECT COUNT(*) AS n
         FROM decision_record d
         JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.decided_at >= ? AND i.author_id = ?`,
    )
    .get(cutoff, personId) as { n: number };

  const unattributable = db
    .query(
      `SELECT COUNT(*) AS n
         FROM decision_record d
         JOIN item i ON i.id = d.source_item_id
        WHERE d.status = 'extracted' AND d.decided_at >= ? AND i.author_id IS NULL`,
    )
    .get(cutoff) as { n: number };

  return { authored: authored.n, unattributable: unattributable.n };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/agents/ && \
git commit -m "feat(agents): negotiate decisions lane"
```

---

## Task 6: Writing lane and the `[negotiate]` personal-docs gate

**Files:**

- Modify: `packages/gateway/src/agents/negotiate.ts`, `_lib/negotiate-types.ts`
- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/agents/negotiate.test.ts`, `packages/gateway/src/config/nimbus-toml.test.ts`

**Interfaces:**

- Produces: `brief.writing: { docs: number; notes: number; messages: number }`, and `brief.sources.personalDocsConfigured` becomes real rather than hardcoded `false`.

**Context:** work artifacts only by default. Personal sources are included only when named in a `[negotiate]` block, following the `[glossary.terms]` precedent — configuration IS the consent (spec § 3.3). The brief names the config key when nothing is configured, so an empty section reads "not enabled" rather than "nothing found" (§ 5.F).

- [ ] **Step 1: Write the failing config test**

Add to `packages/gateway/src/config/nimbus-toml.test.ts`, matching that file's existing style:

```typescript
test("[negotiate] personal_sources parses a service list", () => {
  const parsed = parseNimbusNegotiateToml(
    '[negotiate]\npersonal_sources = ["obsidian", "notion"]\n',
  );
  expect(parsed.personalSources).toEqual(["obsidian", "notion"]);
});

test("[negotiate] absent yields an empty list, not undefined", () => {
  expect(parseNimbusNegotiateToml("").personalSources).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts -t "negotiate"`
Expected: FAIL — `parseNimbusNegotiateToml` is not exported.

- [ ] **Step 3: Implement the config section**

In `config/nimbus-toml.ts`, follow the existing `parseNimbusTomlUserSection` / `parseNimbusUserToml` /
`loadNimbusUserFromPath` / `loadNimbusUserFromConfigDir` quartet exactly — read that block first and
mirror its shape:

```typescript
export type NimbusNegotiateToml = {
  personalSources: string[];
};

export const DEFAULT_NIMBUS_NEGOTIATE_TOML: NimbusNegotiateToml = { personalSources: [] };
```

Parse `personal_sources` as a string array using whichever array helper the file already uses for
list-valued keys — **check the file and reuse it; do not hand-roll a parser.**

**Two malformed-input rules, both fail-safe toward excluding:**

- **Non-string or blank entries are dropped at parse time**, not passed through to a query. Add a
  test: `personal_sources = ["obsidian", "", 42]` yields `["obsidian"]`.
- **An unrecognised service name needs no special handling and must not throw.** The lane uses it in
  a bound `IN (...)` list, so a service that is not configured simply matches no rows. That is the
  correct behaviour — a typo silently includes nothing rather than silently including everything.
  Add a test proving a bogus service name yields zero extra rows and no error.

- [ ] **Step 4: Write the failing writing-lane test**

```typescript
test("writing counts work artifacts and reports personal docs as not enabled", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "confluence", type: "page", externalId: "p1", title: "Design doc",
    bodyPreview: "", modifiedAt: now, syncedAt: now, authorId: "person:me", metadata: {},
  });
  upsertIndexedItem(db, {
    service: "slack", type: "message", externalId: "C1/2.2", title: "hello",
    bodyPreview: "", modifiedAt: now, syncedAt: now, authorId: "person:me", metadata: {},
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.writing.docs).toBe(1);
  expect(brief.writing.messages).toBe(1);
  expect(brief.sources.personalDocsConfigured).toBe(false);
  expect(brief.sources.personalDocsConfigKey).toBe("[negotiate] personal_sources");
  db.close();
});
```

- [ ] **Step 5: Implement the lane**

```typescript
export type NegotiateWriting = {
  readonly docs: number;
  readonly notes: number;
  readonly messages: number;
};
```

```typescript
const DOC_TYPES = ["page", "document"] as const;
const NOTE_TYPES = ["obsidian_note"] as const;
const MESSAGE_TYPES = ["message"] as const;

function countAuthoredByType(
  db: Database,
  personId: string,
  cutoff: number,
  types: readonly string[],
): number {
  const placeholders = types.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM item
        WHERE author_id = ? AND modified_at >= ? AND type IN (${placeholders})`,
    )
    .get(personId, cutoff, ...types) as { n: number };
  return row.n;
}

function laneWriting(db: Database, personId: string, sinceMs: number): NegotiateWriting {
  const cutoff = Date.now() - sinceMs;
  return {
    docs: countAuthoredByType(db, personId, cutoff, DOC_TYPES),
    notes: countAuthoredByType(db, personId, cutoff, NOTE_TYPES),
    messages: countAuthoredByType(db, personId, cutoff, MESSAGE_TYPES),
  };
}
```

Thread the parsed `personalSources` into `NegotiateContext` and set
`sources.personalDocsConfigured = personalSources.length > 0`. When it is empty, the note lane
excludes personal services; the brief's rendered prose names the config key.

- [ ] **Step 6: Run both suites**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts packages/gateway/src/config/nimbus-toml.test.ts`
Expected: PASS.

- [ ] **Step 7: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/agents/ packages/gateway/src/config/ && \
git commit -m "feat(agents): negotiate writing lane and [negotiate] personal-docs gate"
```

---

## Task 7: IPC registration, HTTP exclusion, Tauri allowlist

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts`
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`
- Test: `packages/gateway/src/ipc/agents-rpc.test.ts`

**Interfaces:**

- Consumes: `emitNegotiateBrief` from Task 1.
- Produces: IPC method `agents.negotiate`; notification `negotiate.briefReady`.

**Context — the exclusion is load-bearing.** `HTTP_AGENT_NAMES` is **derived** from `AGENTS_RPC_HANDLERS` specifically so the two cannot drift. Adding a handler therefore **auto-exposes** it at `POST /v1/agents/{agent}` unless it is named in `HTTP_EXCLUDED_AGENT_METHODS`. `agents.negotiate` must be excluded: combined with `--person`, HTTP exposure would let any holder of the `agents` token assemble a contribution dossier on any indexed person without the owner initiating it (spec § 3.1).

- [ ] **Step 1: Write the failing tests**

```typescript
test("agents.negotiate is NOT on the HTTP agent surface", () => {
  expect(HTTP_AGENT_NAMES).not.toContain("negotiate");
});

test("POST /v1/agents/negotiate is refused", async () => {
  // Drive the test HTTP server the way the neighbouring route tests in this file do —
  // reuse their helper rather than standing up a second server. Assert the request is
  // rejected (not served), matching how agents.preflight and agents.premortem behave.
});
```

Read the existing HTTP route tests in this file first and mirror their harness exactly; the second test must exercise the real route, not the derived list.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/ipc/agents-rpc.test.ts -t "negotiate"`
Expected: FAIL — the handler does not exist, so the name is absent for the wrong reason. After Step 3 adds the handler *without* the exclusion, the first test fails for the right reason.

- [ ] **Step 3: Add the handler, the map entry, and the exclusion**

```typescript
async function handleNegotiate(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireNegotiateParams(params);
  return await emitNegotiateBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("negotiate"),
    personalSources: negotiatePersonalSources(ctx),
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}
```

**`personalSources` is not optional here.** Task 6 adds it to `NegotiateContext`; omitting it would
silently disable the personal-docs opt-in for every IPC caller while `nimbus.toml` still claims to
enable it — consent expressed and then ignored. Resolve it the way neighbouring handlers reach
config (`handleOwnership` uses `ctx.configDir`): load the `[negotiate]` section from the config dir,
defaulting to an empty list when `ctx.configDir` is undefined.

Write `requireNegotiateParams` beside the file's other `require*Params` validators, following their
shape: accept an optional `sinceMs` (number) and optional `personId` (non-empty string), reject
anything else, and bound `personId`'s length the way the neighbouring validators bound their string
inputs. Add `"agents.negotiate": handleNegotiate` to `AGENTS_RPC_HANDLERS`, and add
`"agents.negotiate"` to `HTTP_EXCLUDED_AGENT_METHODS` **in the same commit** — a commit that adds the
handler without the exclusion publishes the route.

- [ ] **Step 4: Update the Tauri allowlist**

In `packages/ui/src-tauri/src/gateway_bridge.rs`, add `"agents.negotiate"` to `ALLOWED_METHODS` in
its correct alphabetical position (between `"agents.janitor"` and `"agents.ownership"`), and update
the count assertion in `allowlist_exact_size` from `105` to `106`.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/ipc/agents-rpc.test.ts`
Expected: PASS.

- [ ] **Step 6: Red-prove the exclusion**

Temporarily remove `"agents.negotiate"` from `HTTP_EXCLUDED_AGENT_METHODS`. Run the suite.
Expected: **both** negotiate HTTP tests FAIL. Restore. If only one fails, the other is not testing
what it claims.

- [ ] **Step 7: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/ipc/ packages/ui/src-tauri/src/gateway_bridge.rs && \
git commit -m "feat(ipc): register agents.negotiate, excluded from the HTTP surface"
```

---

## Task 8: CLI command

**Files:**

- Create: `packages/cli/src/commands/negotiate.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/commands/negotiate.test.ts`

**Interfaces:**

- Consumes: IPC `agents.negotiate` and the `negotiate.briefReady` notification from Task 7.

**Context:** use the shared `runAgentBriefCli` helper (`packages/cli/src/commands/_agent-brief-cli.ts`),
which takes `{ kind, guard, json, params, timeoutMs?, onResult?, beforeCall? }` and handles connect,
notification wait, and rendering. Follow `packages/cli/src/commands/owners.ts` as the closest model —
including that it **hard-rejects an unrecognised flag** rather than ignoring it, and uses `flagValue`
for value-taking flags.

- [ ] **Step 1: Write the failing arg-parser test**

```typescript
import { expect, test } from "bun:test";
import { parseNegotiateArgs } from "./negotiate.ts";

test("parses --since, --person and --json", () => {
  const a = parseNegotiateArgs(["--since", "90d", "--person", "person:bob", "--json"]);
  expect(a.since).toBe("90d");
  expect(a.person).toBe("person:bob");
  expect(a.json).toBe(true);
});

test("defaults are empty and non-json", () => {
  const a = parseNegotiateArgs([]);
  expect(a.since).toBeUndefined();
  expect(a.person).toBeUndefined();
  expect(a.json).toBe(false);
});

test("an unrecognised flag is rejected, never ignored", () => {
  expect(() => parseNegotiateArgs(["--persn", "x"])).toThrow(/Unrecognised flag/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/src/commands/negotiate.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the command**

Mirror `owners.ts`: a `USAGE` constant, `parseNegotiateArgs` rejecting unknown `--` flags, and
`runNegotiateCommand` calling `runAgentBriefCli` with `kind: "negotiate"`, a `guard` narrowing the
`findings` payload structurally, `json` from the parsed args, and `params` carrying `sinceMs`
(parsed from the duration string) and `personId` when given. Respect `NO_COLOR`. The `USAGE` string
is canonical — the docs copy it, not the other way round:

```text
Usage: nimbus negotiate [--since <duration>] [--person <id>] [--json]
  --since    window to summarise, e.g. 90d (default 90d, max 365d)
  --person   brief a different person by id (defaults to you)
```

- [ ] **Step 4: Register the command**

In `packages/cli/src/index.ts`, add `negotiate: runNegotiateCommand` to the command registry beside
`owners` and `"pre-mortem"`.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/cli/src/commands/negotiate.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/cli/src/ && \
git commit -m "feat(cli): nimbus negotiate command"
```

---

## Task 9: E2E scenario

**Files:**

- Create: `packages/gateway/test/e2e/scenarios/negotiate.e2e.test.ts`

**Context:** follow `packages/gateway/test/e2e/scenarios/premortem.e2e.test.ts` as the closest model.
The agent queries the local index, so no connector mocking is needed.

- [ ] **Step 1: Write the scenario**

Seed a person, two authored PRs (one enriched with stats), one review, one issue, and an ownership
edge through the **real** writers (`upsertIndexedItem`, `upsertGraphEntity`, `upsertGraphRelation`) —
never hand-rolled `INSERT INTO graph_entity`. Then assert:

1. `emitNegotiateBrief` emits `negotiate.briefReady` with a non-empty `brief` string and a
   `findings` object whose `kind` is `"negotiate"`.
2. The brief's Markdown contains the subject and the window.
3. **Zero HITL fires** — structurally, that `agents/negotiate.ts` source imports neither
   `ToolExecutor` nor references `HITL_REQUIRED`.
4. The absent-evidence note (§ 5.D) is present unconditionally: incidents resolved, on-call and
   deploys triggered are named as unavailable, so an empty section is never read as zero.

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/test/e2e/scenarios/negotiate.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Preflight and commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/test/ && \
git commit -m "test(agents): negotiate e2e scenario"
```

---

## Task 10: Documentation

**Files:**

- Modify: `docs/cli-reference.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add the CLI reference entry**

Copy the `USAGE` constant from `packages/cli/src/commands/negotiate.ts` **verbatim** — that constant
is canonical. Document the three limits the brief itself states:

- ownership counts only blame lines whose git email maps to a known person, so work under an
  unmapped alias is not counted;
- PR size statistics exist only where the enrichment pass has run, so aggregates carry their
  coverage;
- incidents resolved, on-call shifts and deploys triggered are not available at all.

State plainly that `--person` briefs another person from locally indexed data, and that the command
is not reachable over the HTTP API.

- [ ] **Step 2: Add the changelog entry**

Add to `docs/CHANGELOG.md` under the current unreleased heading. **Read the two entries above yours
first and match their format exactly** — this file has a strict house style.

- [ ] **Step 3: Verify the doc gates**

```bash
bun run lint:markdown && grep -rn "file:///" docs/ || echo "clean"
```

`file:///` links resolve on Windows and 404 on Linux under the link checker; this repo has been bitten
by exactly that.

- [ ] **Step 4: Commit**

```bash
bun run preflight:fast && git add docs/ && git commit -m "docs: nimbus negotiate and its stated limits"
```

---

## Final verification before pushing

- [ ] **Full suites**

Run: `bun test packages/gateway/src/agents packages/gateway/src/ipc packages/cli/src/commands`
Expected: PASS.

- [ ] **Test typecheck** — `bun run typecheck:tests`, read the "**N new**" line; it must be **0**.

- [ ] **Coverage floor** — `bash scripts/coverage-floor/build-lcov.sh && bun run audit:coverage-floor`.
  A scoped per-directory istanbul run is **not** a substitute; it under-reports badly. Expect
  pre-existing violations in `platform/linux.ts` and `ipc/server/socket-listeners.ts` on a Windows
  host — check `git diff --name-only` before believing any violation is yours.

- [ ] **Full preflight** — `bun run preflight`. It fail-fasts, so a green run must reach the end.

- [ ] **Open the PR.** The title carries the conventional-commit type, because release-please parses
  the squash subject and local commit messages are discarded on merge:

```text
feat(agents): nimbus negotiate — a cited contribution brief
```

Put the reasoning in the PR description; it becomes the permanent commit body. Do **not** include a
bare `Release-As:` trailer.
