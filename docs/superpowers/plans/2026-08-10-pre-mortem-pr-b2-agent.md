# pre-mortem PR B2 — Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `nimbus pre-mortem <epic-ref>` — the thirteenth built-in agent — so that V53's theme substrate and `premortem_watcher_proposal` table become reachable, and a user planning an epic gets its comparable history, five structural risks, and a paused watcher they can arm.

**Architecture:** Four read lanes over the already-indexed graph. Lane 1 resolves the epic to its affected services (reusing PR A's `affectedServicesForEpic`). Lane 2 builds an IDF-weighted service-overlap cohort of closed epics. Lane 3 computes five structural risks from cohort rows. Lane 4 reads `premortem_theme` for the cohort's services with no model call. The agent then proposes one paused `incident_opened` watcher per affected service, recording each in `premortem_watcher_proposal` so a deliberate deletion is never resurrected.

**Tech Stack:** Bun v1.2+, TypeScript strict (no `any`), `bun:sqlite`, `bun:test`, Biome, Rust (one Tauri allowlist line).

## Global Constraints

- **No `any`** — `unknown` for external data. TypeScript strict is non-negotiable.
- **I14 — production SQLite writes go through `dbRun`/`dbExec`/`dbStmtRun`.** Task 3 writes rows; it must use those helpers. `*.test.ts` is exempt (the D12 audit does not scan it).
- **I9 — bound-param SQL**; identifiers via `escapeIdentifier`. No string-interpolated values.
- **I2 does NOT apply.** pre-mortem writes local rows only. It must never import `engine/executor.ts` or reference `HITL_REQUIRED`. The safety property is `enabled = 0`, not a gate.
- **D22 rule (d)** — only `packages/gateway/src/ipc/agents-rpc.ts` may import `packages/gateway/src/agents/premortem.ts`. Static-audited (`check-nimbus-invariants.ts:641`). The CLI must reach the agent over IPC, never by import.
- **Read-only except two tables.** The agent may write ONLY `watcher` rows with `enabled = 0` and `premortem_watcher_proposal` rows. Nothing else.
- **Coverage floor** — ≥85% line and ≥80% branch per file. `audit:coverage-floor` is CI-Linux-authoritative; on Windows it reports false violations for `platform/linux.ts` and `ipc/server/socket-listeners.ts` — ignore those two.
- **`typecheck:tests` is ADVISORY on Windows and GATING on CI-Linux.** Run `bun run typecheck:tests` and read the "N new" line before pushing any task that adds a test file. `preflight:fast` being green does not cover this.
- **Commit messages must not contain backticks** (`git commit -m` command-substitutes them).
- **Branch** — `dev/asafgolombek/pre-mortem-pr-b2`, worktree `.claude/worktrees/pre-mortem-pr-b2`. Never commit to `main`.
- **Spec** — `docs/superpowers/specs/2026-08-09-pre-mortem-design.md` (lanes, risks, watcher rules, honesty rules, failure modes) plus `docs/superpowers/specs/2026-08-10-pre-mortem-pr-b-design.md` (the B2 deltas and the DECIDED callout).

## What already exists — consume it, do not rebuild it

Verified against the tree at planning time:

| Symbol | File | Use |
|---|---|---|
| `affectedServicesForEpic(db, epicItemId, epicKey): string[]` | `premortem/epic-services.ts` | Lane 1 and Lane 2 service derivation. Returns `[]` rather than guessing when a hop is missing. |
| `affectedServicesForEpics(...)` | same | batch form for cohort candidates |
| `themesForServices(db, services): PremortemTheme[]` | `premortem/theme-store.ts` | Lane 4. `PremortemTheme = { id, service, label, status, confidence, evidenceCount, lastSeenAt }` |
| `createPremortemRefresher(deps)` | `premortem/premortem-refresh.ts` | backs `--refresh` via the existing `premortem.refresh` IPC |
| `NimbusPremortemToml.maxCohortSize` (10), `.maxCandidateScan` (200) | `config/nimbus-toml.ts:1846` | Lane 2 bounds — **already shipped by PR A; add no config** |
| `insertWatcher`, `deleteWatcher`, `listWatchers` | `automation/watcher-store.ts` | Task 3 extends this file |
| `emitBriefWithSynthesis({ sessionId, briefReadyMethod, briefErrorMethod, notify, llm?, buildBrief })` | `agents/_lib/` | the emitter shape every agent uses |

**`ALLOWED_METHODS.len()` is currently `104`** (`packages/ui/src-tauri/src/gateway_bridge.rs:549`). B2 takes it to **105**. B1 did not change it.

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/premortem/cohort.ts` **(new)** | Candidate scan + IDF-weighted ranking. Nothing else. |
| `packages/gateway/src/premortem/risks.ts` **(new)** | The five structural risk calculators, as pure functions over rows. |
| `packages/gateway/src/premortem/watcher-proposals.ts` **(new)** | Proposal ids, the three re-run rules, the proposal-table tombstone. |
| `packages/gateway/src/automation/watcher-store.ts` **(modify)** | Add `insertWatcherIfAbsent`. |
| `packages/gateway/src/agents/premortem.ts` **(new)** | The four lanes, brief assembly, honesty rules, and the emitter. |
| `packages/gateway/src/ipc/agents-rpc.ts` **(modify)** | `agents.premortem` handler + registration. |
| `packages/ui/src-tauri/src/gateway_bridge.rs` **(modify)** | `ALLOWED_METHODS` 104 → 105 + the count assertion at `:549`. |
| `packages/cli/src/commands/pre-mortem.ts` **(new)** | `nimbus pre-mortem` with hard-rejected unknown flags. |
| docs | agent-patterns invariant amendment, roadmap, cli-reference, CHANGELOG, architecture. |

---

### Task 1: Cohort selection and IDF ranking

**Files:**

- Create: `packages/gateway/src/premortem/cohort.ts`
- Test: `packages/gateway/src/premortem/cohort.test.ts`

**Interfaces:**

- Consumes: `affectedServicesForEpics` from `premortem/epic-services.ts`.
- Produces, for Tasks 2 and 4:

```ts
export type CohortCandidate = {
  itemId: string;
  key: string;
  title: string;
  services: string[];
  createdAtMs: number;
  resolvedAtMs: number;
  statusCategory: "done" | "canceled";
  childCount: number;
  score: number;
};

export type CohortResult = {
  members: CohortCandidate[];
  scannedCount: number;
  oldestResolvedAtMs: number | null;
};

export function selectCohort(
  db: Database,
  targetServices: readonly string[],
  opts: { maxCandidateScan: number; maxCohortSize: number; excludeItemId: string },
): CohortResult;
```

**Why IDF and not overlap count.** A monolithic or ubiquitous service (`api-gateway`, `shared-utils`) appears in nearly every closed epic, so a raw count ranks it above the specific service that actually characterises the work. Each service is weighted `log(N / epicsTouchingService)` over the scanned candidates, and a candidate scores the sum of the weights of services it shares with the target. This is **derived, not configured**: a service present in every candidate earns a weight of ~0 automatically, so no exclusion list exists to drift.

**Candidates are scanned `resolved_at_ms DESC`,** so `maxCandidateScan` truncates the oldest history rather than an arbitrary slice. Without an explicit order the cap takes whatever SQLite returns first, which is neither recent nor stable.

**Jira-only.** Candidates are `metadata.issue_type = 'Epic'` with `status_category` in `('done','canceled')`. Only `connectors/jira-sync.ts` writes `issue_type`; no `linear:project` items are indexed at all.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/premortem/cohort.test.ts`. Seed items with `upsertIndexedItem` and graph edges through the REAL `upsertGraphEntity`/`upsertGraphRelation` — never a hand-rolled `INSERT INTO graph_entity`, which hid three defects in PR A.

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { selectCohort } from "./cohort.ts";
import { seedEpicWithServices } from "./cohort.test-helpers.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("selectCohort", () => {
  test("returns no members when no closed epic shares a service", () => {
    const db = makeDb();
    seedEpicWithServices(db, { key: "OTHER-1", services: ["unrelated"], resolvedAtMs: 1_000 });
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members).toEqual([]);
    expect(out.oldestResolvedAtMs).toBeNull();
  });

  test("a rare shared service outranks a ubiquitous one", () => {
    const db = makeDb();
    // "shared-utils" appears in every candidate -> IDF weight ~0.
    // "billing" appears in one -> high weight.
    for (let i = 0; i < 5; i++) {
      seedEpicWithServices(db, {
        key: `UBI-${i}`,
        services: ["shared-utils"],
        resolvedAtMs: 1_000 + i,
      });
    }
    seedEpicWithServices(db, {
      key: "RARE-1",
      services: ["shared-utils", "billing"],
      resolvedAtMs: 900,
    });

    const out = selectCohort(db, ["shared-utils", "billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });

    expect(out.members[0]?.key).toBe("RARE-1");
    expect(out.members[0]?.score).toBeGreaterThan(out.members[1]?.score ?? 0);
  });

  test("the target epic is never its own cohort member", () => {
    const db = makeDb();
    seedEpicWithServices(db, { key: "TARGET-1", services: ["billing"], resolvedAtMs: 1_000 });
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members.map((m) => m.key)).not.toContain("TARGET-1");
  });

  test("maxCohortSize caps members while scannedCount reports the full scan", () => {
    const db = makeDb();
    for (let i = 0; i < 8; i++) {
      seedEpicWithServices(db, { key: `E-${i}`, services: ["billing"], resolvedAtMs: 1_000 + i });
    }
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 200,
      maxCohortSize: 3,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.members).toHaveLength(3);
    expect(out.scannedCount).toBe(8);
  });

  test("maxCandidateScan truncates the OLDEST history, keeping the newest", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      seedEpicWithServices(db, { key: `E-${i}`, services: ["billing"], resolvedAtMs: 1_000 + i });
    }
    const out = selectCohort(db, ["billing"], {
      maxCandidateScan: 2,
      maxCohortSize: 10,
      excludeItemId: "jira:TARGET-1",
    });
    expect(out.scannedCount).toBe(2);
    expect(out.members.map((m) => m.key).sort()).toEqual(["E-3", "E-4"]);
  });
});
```

Create `packages/gateway/src/premortem/cohort.test-helpers.ts` with a `seedEpicWithServices(db, { key, services, resolvedAtMs })` that inserts the epic item (`type: "issue"`, `metadata: { issue_type: "Epic", status_category: "done" }`), one child issue per service carrying `metadata.parent_key = key`, a PR graph entity per service with `metadata.repo` set, and the `resolves` edge from PR to child — through `upsertGraphEntity` / `upsertGraphRelation`. Read `packages/gateway/src/premortem/epic-services.test.ts` first and mirror exactly how it seeds, so both suites agree on the shape `affectedServicesForEpic` actually queries.

- [ ] **Step 2: Run to confirm they fail**

Run: `bun test packages/gateway/src/premortem/cohort.test.ts`
Expected: FAIL — `Cannot find module ./cohort.ts`.

- [ ] **Step 3: Implement `cohort.ts`**

Query candidates with a bound-parameter `SELECT` over `item` where `json_extract(metadata,'$.issue_type') = 'Epic'` and `json_extract(metadata,'$.status_category') IN ('done','canceled')`, ordered `resolved_at_ms DESC`, `LIMIT ?` bound to `maxCandidateScan`. Guard every `json_extract` with `json_valid(metadata)` — `json_extract` RAISES `malformed JSON` on non-JSON TEXT, and an uncaught raise here kills the whole brief. Derive each candidate's services with `affectedServicesForEpics`, compute IDF weights across the scanned set, score, sort by score DESC then `resolvedAtMs` DESC for a stable order, and slice to `maxCohortSize`. Set `oldestResolvedAtMs` from the scanned set (not the sliced members) so the honesty note reports real history span.

- [ ] **Step 4: Run to confirm they pass**

Run: `bun test packages/gateway/src/premortem/cohort.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/cohort.ts packages/gateway/src/premortem/cohort.test.ts packages/gateway/src/premortem/cohort.test-helpers.ts
git commit -m "feat(premortem): IDF-weighted service-overlap cohort selection"
```

---

### Task 2: The five structural risk calculators

**Files:**

- Create: `packages/gateway/src/premortem/risks.ts`
- Test: `packages/gateway/src/premortem/risks.test.ts`

**Interfaces:**

- Consumes: `CohortCandidate` from Task 1.
- Produces, for Task 4:

```ts
export type RiskKind =
  | "cycle_time"
  | "size_overrun"
  | "review_drag"
  | "incident_coupling"
  | "abandonment";

export type Risk = {
  kind: RiskKind;
  /** Rendered sentence for the brief. */
  summary: string;
  /** Null when the cohort cannot support this risk — the brief prints a named gap. */
  value: number | null;
  /** True when the figure is an expectation about a young epic, not a comparison. */
  expectationOnly: boolean;
};

export function computeRisks(input: {
  cohort: readonly CohortCandidate[];
  targetChildCount: number;
  targetCreatedAtMs: number;
  nowMs: number;
  reviewDragMedianMs: number | null;
  repoReviewMedianMs: number | null;
  incidentCoupledCount: number;
  cohortIsMixedTracker: boolean;
}): Risk[];
```

**Decisions the implementer must not re-litigate:**

1. **Cycle time is an expectation on a young epic, a comparison on an old one.** When `nowMs - targetCreatedAtMs < 86_400_000` (1 day), `expectationOnly` is true and the summary reads *"comparable epics took a median N days"* — never *"N days vs 0 days"*, which reads as an alarming overrun and means nothing. The roadmap's trigger is "when a new Epic is created", so the young case is the common one.
2. **Abandonment is Jira-blind.** Jira folds "Won't Do" into `done` (the distinction lives in `fields.resolution`, which the sync does not fetch), so `canceled` is unreachable there. When `cohortIsMixedTracker` is true the abandonment risk returns `value: null` with a summary naming the blindness — a blended rate across trackers must never be presented as comparable.
3. **Incident coupling reuses the existing `correlates_with` edge and must not invent a second rule.** `graph/graph-populator.ts` pairs a deployment with an incident on the same affected service within a 2-hour window, keyed on service and time — NOT on any link to a child PR of the epic. The summary must therefore say "incidents correlated with deploys of these services during each epic's window" and must not imply the epic caused them.
4. **A risk with no data returns `value: null`, never 0.** Zero means "measured zero"; null means "cannot measure" and the brief renders a named gap.

**Who computes the three inputs this function does not derive itself.** `reviewDragMedianMs`,
`repoReviewMedianMs` and `incidentCoupledCount` require database queries, and `risks.ts` is
deliberately database-free so the calculators stay pure and testable over fixtures. **Task 4 (the
agent) owns those three queries** and passes the results in: PR open→merge medians across the cohort
children's PRs and across the repo over the same indexed window, and the count of cohort epics with
an incident `correlates_with` a deploy in-window. Task 4's implementer must not assume Task 2
provides them. Pass `null` for either median when the cohort has no PRs — `computeRisks` renders that
as a named gap.

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/premortem/risks.test.ts` — pure functions over fixture rows, no database:

```ts
import { describe, expect, test } from "bun:test";
import { computeRisks } from "./risks.ts";
import type { CohortCandidate } from "./cohort.ts";

const DAY = 86_400_000;

function candidate(over: Partial<CohortCandidate> = {}): CohortCandidate {
  return {
    itemId: "jira:E-1",
    key: "E-1",
    title: "epic",
    services: ["billing"],
    createdAtMs: 0,
    resolvedAtMs: 10 * DAY,
    statusCategory: "done",
    childCount: 4,
    score: 1,
    ...over,
  };
}

const BASE = {
  targetChildCount: 4,
  targetCreatedAtMs: 0,
  nowMs: 30 * DAY,
  reviewDragMedianMs: null,
  repoReviewMedianMs: null,
  incidentCoupledCount: 0,
  cohortIsMixedTracker: false,
};

describe("computeRisks", () => {
  test("cycle time on a YOUNG epic is an expectation, not a comparison", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ resolvedAtMs: 24 * DAY })],
      targetCreatedAtMs: 30 * DAY - 3600_000, // one hour old
    });
    const cycle = risks.find((r) => r.kind === "cycle_time");
    expect(cycle?.expectationOnly).toBe(true);
    expect(cycle?.summary).not.toContain("vs 0");
  });

  test("cycle time on an OLD epic compares against elapsed time", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ resolvedAtMs: 24 * DAY })],
      targetCreatedAtMs: 0,
      nowMs: 30 * DAY,
    });
    expect(risks.find((r) => r.kind === "cycle_time")?.expectationOnly).toBe(false);
  });

  test("an empty cohort yields null values, never zero", () => {
    const risks = computeRisks({ ...BASE, cohort: [] });
    for (const r of risks) {
      expect(r.value).toBeNull();
    }
  });

  test("abandonment is suppressed with a stated reason on a mixed-tracker cohort", () => {
    const risks = computeRisks({
      ...BASE,
      cohort: [candidate({ statusCategory: "canceled" })],
      cohortIsMixedTracker: true,
    });
    const ab = risks.find((r) => r.kind === "abandonment");
    expect(ab?.value).toBeNull();
    expect(ab?.summary.toLowerCase()).toContain("jira");
  });

  test("incident coupling never claims causation", () => {
    const risks = computeRisks({ ...BASE, cohort: [candidate()], incidentCoupledCount: 1 });
    const ic = risks.find((r) => r.kind === "incident_coupling");
    expect(ic?.summary).toMatch(/correlat/i);
    expect(ic?.summary).not.toMatch(/caused|because of/i);
  });

  test("all five risks are always returned, in a stable order", () => {
    const risks = computeRisks({ ...BASE, cohort: [candidate()] });
    expect(risks.map((r) => r.kind)).toEqual([
      "cycle_time",
      "size_overrun",
      "review_drag",
      "incident_coupling",
      "abandonment",
    ]);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `bun test packages/gateway/src/premortem/risks.test.ts`
Expected: FAIL — `Cannot find module ./risks.ts`.

- [ ] **Step 3: Implement `risks.ts`**

Pure functions only — no `Database` import in this file. Median helper over a sorted copy. Every summary string names its own basis ("across N comparable epics") so the brief never states a figure whose provenance is invisible.

- [ ] **Step 4: Run to confirm they pass**

Run: `bun test packages/gateway/src/premortem/risks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/risks.ts packages/gateway/src/premortem/risks.test.ts
git commit -m "feat(premortem): five structural risk calculators"
```

---

### Task 3: Paused watcher proposals

**Files:**

- Create: `packages/gateway/src/premortem/watcher-proposals.ts`
- Modify: `packages/gateway/src/automation/watcher-store.ts` (add `insertWatcherIfAbsent`)
- Test: `packages/gateway/src/premortem/watcher-proposals.test.ts`

**Interfaces:**

- Produces, for Task 4:

```ts
export type WatcherProposal = {
  watcherId: string;
  service: string;
  riskKind: "incident_coupling";
  state: "created" | "already_present" | "suppressed";
};

export function proposeWatchers(
  db: Database,
  input: { epicItemId: string; services: readonly string[]; nowMs: number },
): WatcherProposal[];
```

- Adds to `automation/watcher-store.ts`:

```ts
export function insertWatcherIfAbsent(
  db: Database,
  row: Omit<WatcherRow, "last_checked_at" | "last_fired_at" | "graph_predicate_json"> & {
    graph_predicate_json?: string | null;
  },
): boolean;
```

**Context.** `insertWatcher` is a bare `INSERT`, so calling it twice with a content-derived id raises a primary-key constraint error. `insertWatcherIfAbsent` selects by id first and inserts only when absent, returning whether it inserted. It must **never** write `enabled` on an existing row — that is the one place a naive upsert would silently undo a user arming a watcher.

**Only `incident_opened` watchers are proposed.** Per the DECIDED callout in `2026-08-10-pre-mortem-pr-b-design.md`, pre-mortem proposes **no** deploy-failure watcher: a deployment item's `item.service` is the annotate provider slug while the engine matches syncable service ids, so a service-filtered one could never fire post-sync. The deploy-failure risk is still computed and reported by Task 2; it simply proposes nothing, exactly as cycle time, size overrun and review drag do. Do not add one.

**The three re-run rules, all three tested:**

1. **Content-derived id** = a stable hash of (`epicItemId`, `riskKind`, `service`). Running `pre-mortem PROJ-120` twice creates nothing the second time. Use the same hashing approach as `decision_record.id` — read it, do not invent one.
2. **Insert-if-absent; never update `enabled`.** An armed watcher survives a re-run un-paused.
3. **A deleted watcher stays deleted.** Every proposed id is recorded in `premortem_watcher_proposal`. An id present in that table but ABSENT from `watcher` was deliberately deleted and is never re-created; it is reported as `suppressed` so the brief can list it with the command to un-suppress. This is why the table exists rather than deriving proposals on the fly — without it, "never proposed" and "deleted" are indistinguishable.

Watchers are created with `enabled: 0`, `condition_type: "incident_opened"`, `condition_json: JSON.stringify({ filter: { service } })`, `action_type: "notify"`, `action_json: "{}"`.

- [ ] **Step 1: Write the failing tests**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { deleteWatcher, listWatchers, setWatcherEnabled } from "../automation/watcher-store.ts";
import { proposeWatchers } from "./watcher-proposals.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const INPUT = { epicItemId: "jira:PROJ-120", services: ["billing"], nowMs: 1_700_000_000_000 };

describe("proposeWatchers", () => {
  test("creates one paused incident_opened watcher per service", () => {
    const db = makeDb();
    const out = proposeWatchers(db, INPUT);
    expect(out).toHaveLength(1);
    expect(out[0]?.state).toBe("created");
    const w = listWatchers(db)[0];
    expect(w?.enabled).toBe(0);
    expect(w?.condition_type).toBe("incident_opened");
    expect(JSON.parse(w?.condition_json ?? "{}")).toEqual({ filter: { service: "billing" } });
  });

  test("rule 1 — a re-run creates nothing the second time", () => {
    const db = makeDb();
    proposeWatchers(db, INPUT);
    const second = proposeWatchers(db, INPUT);
    expect(listWatchers(db)).toHaveLength(1);
    expect(second[0]?.state).toBe("already_present");
  });

  test("rule 2 — an armed watcher survives a re-run UN-PAUSED", () => {
    const db = makeDb();
    const id = proposeWatchers(db, INPUT)[0]?.watcherId as string;
    setWatcherEnabled(db, id, true);
    proposeWatchers(db, INPUT);
    expect(listWatchers(db)[0]?.enabled).toBe(1);
  });

  test("rule 3 — a deleted watcher stays deleted and is reported suppressed", () => {
    const db = makeDb();
    const id = proposeWatchers(db, INPUT)[0]?.watcherId as string;
    deleteWatcher(db, id);
    const again = proposeWatchers(db, INPUT);
    expect(listWatchers(db)).toHaveLength(0);
    expect(again[0]?.state).toBe("suppressed");
  });

  test("proposes NO deploy-failure watcher", () => {
    const db = makeDb();
    proposeWatchers(db, INPUT);
    expect(listWatchers(db).map((w) => w.condition_type)).not.toContain("deploy_failed");
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `bun test packages/gateway/src/premortem/watcher-proposals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `insertWatcherIfAbsent`, then implement `watcher-proposals.ts`**

Both writes go through `dbRun` (I14). The proposal row is written whenever an id is proposed — including the `already_present` case — so the tombstone record is complete.

- [ ] **Step 4: Run to confirm they pass, plus the existing watcher suite**

Run: `bun test packages/gateway/src/premortem/ packages/gateway/src/automation/`
Expected: PASS, including B1's watcher-engine and condition-kind suites unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/watcher-proposals.ts packages/gateway/src/premortem/watcher-proposals.test.ts packages/gateway/src/automation/watcher-store.ts
git commit -m "feat(premortem): paused incident watcher proposals with deliberate-deletion tombstones"
```

---

### Task 4: The agent

**Files:**

- Create: `packages/gateway/src/agents/premortem.ts`
- Test: `packages/gateway/src/agents/premortem.test.ts`

**Interfaces:**

- Consumes: `selectCohort` (Task 1), `computeRisks` (Task 2), `proposeWatchers` (Task 3), `affectedServicesForEpic` and `themesForServices` (PR A).
- Produces, for Task 5:

```ts
export type PremortemInput = {
  epicRef: string;               // "PROJ-120" or "jira:PROJ-120"
  serviceOverrides?: string[];   // repeatable --service
};
export type PremortemContext = { /* mirror OwnershipContext in agents/ownership.ts */ };
export async function runPremortem(input: PremortemInput, ctx: PremortemContext): Promise<string>;
export function emitPremortemBrief(
  input: PremortemInput,
  ctx: PremortemContext,
): Promise<{ sessionId: string }>;
```

**Read `packages/gateway/src/agents/ownership.ts` first and mirror its shape exactly** — `runOwnership` / `emitOwnershipBrief` at `:201` and `:306`. The emitter is:

```ts
return emitBriefWithSynthesis({
  sessionId: ctx.sessionId,
  briefReadyMethod: "premortem.briefReady",
  briefErrorMethod: "premortem.briefError",
  notify: ctx.notify,
  ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  buildBrief: () => runPremortem(input, ctx),
});
```

**The four lanes, in order.** Lane 1: resolve `epicRef` (accept both `PROJ-120` and `jira:PROJ-120`) to its item; `--service` **overrides derivation entirely**, because a brand-new epic has no children, therefore no PRs, therefore no services, and nothing in the index carries a Jira component or label. Lane 2: `selectCohort`. Lane 3: `computeRisks`. Lane 4: `themesForServices` — no model call on this path.

**Failure modes are named gaps, never silence and never a weaker substitute** (from the 2026-08-09 spec):

| Condition | Brief |
|---|---|
| epic ref not found | hard error |
| no children and no `--service` | gap: cannot determine services. **Name the cause**: a Linear ref says pre-mortem covers Jira epics only and no Linear project items are indexed; a Jira epic with no `parent_key` children says this looks like a company-managed project, pass `--service` or re-run once child PRs land |
| services known, cohort empty | gap: no past epics touching these services closed in the indexed window |
| cohort exists, no themes | structural-only brief + note (pass disabled / never run / no local LLM) |

**There is no project-based fallback cohort.** If service overlap yields nothing the agent says so, rather than silently substituting "other epics in the same project", which would look like an answer while comparing unrelated work.

**Honesty rules, all four:**

1. **Conditional — history span.** Report the observed span of closed epics for the cohort's services ("6 epics, oldest closed 2025-11-03"); when short, point at `nimbus index rebody --service jira --since <days>`. Counted per brief and silent when history is deep.
2. **Conditional — truncated bodies.** Rows with `body_complete = 0` reported as `N of M source(s)`.
3. **Unconditional — the note that never turns off.** *"Comparable" means these epics touched some of the same services. It does not mean they were architecturally or organisationally similar, and these are correlations, not causes.*
4. **Confidence ceiling below 1.0, with its reason stated: no connector indexes ticket comments,** so a blocker argued out entirely in a Jira comment thread is invisible.

Plus two B2-specific statements: **Jira-only** (and team-managed-only for `parent_key`), and **no deploy-failure watcher is proposed**, with the one-line reason.

- [ ] **Step 1: Write the failing tests**

`packages/gateway/src/agents/premortem.test.ts` must cover, each as its own case: a resolved epic producing all four lanes; the no-children-no-`--service` gap naming the company-managed cause; a Linear ref naming the Linear cause; an empty cohort producing a named gap rather than a fallback; a themes-absent brief that still carries all five risks; the unconditional correlation note present in EVERY brief; and that `--service` overrides derivation. Seed graph fixtures through the real `upsertGraphEntity`.

- [ ] **Step 2: Run to confirm they fail**

Run: `bun test packages/gateway/src/agents/premortem.test.ts`

- [ ] **Step 3: Implement `agents/premortem.ts`**

Read-only except through Task 3's `proposeWatchers`. Must NOT import `engine/executor.ts` and must not reference `HITL_REQUIRED`.

- [ ] **Step 4: Run to confirm they pass**

Run: `bun test packages/gateway/src/agents/ packages/gateway/src/premortem/`

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/premortem.ts packages/gateway/src/agents/premortem.test.ts
git commit -m "feat(agents): pre-mortem brief over cohort, risks, themes and watcher proposals"
```

---

### Task 5: IPC, Tauri exposure, CLI, and e2e

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts` (handler + registration)
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS` + assertion at `:549`)
- Create: `packages/cli/src/commands/pre-mortem.ts`
- Test: `packages/cli/src/commands/pre-mortem.test.ts`, `packages/gateway/test/e2e/scenarios/premortem.e2e.test.ts`

**Interfaces:** consumes `emitPremortemBrief` from Task 4.

**Wiring.** Add `handlePremortem` beside `handleOwnership` (`agents-rpc.ts:601`) and register `"agents.premortem": handlePremortem` in the served map (`:633`). **`agents-rpc.ts` is the ONLY file permitted to import `agents/premortem.ts`** — static rule D22(d) at `check-nimbus-invariants.ts:641`. The CLI reaches it over IPC.

**Tauri.** Add `"agents.premortem"` to `ALLOWED_METHODS` and change the assertion at `gateway_bridge.rs:549` from `104` to `105`. **`premortem.refresh` stays OUT** — `gateway_bridge.rs:544` and `:530` already assert that `ownership.refresh` and `decisions.refresh` are excluded, because a method that re-derives an entire graph is not renderer-safe (I7). Follow that precedent; do not add a fourth refresh exposure.

**CLI.** `nimbus pre-mortem <epic-ref> [--service <name>]… [--json] [--refresh]`. Mirror `packages/cli/src/commands/owners.ts`: a canonical `USAGE` const, unknown flags hard-rejected with `Unrecognised flag: …\n${USAGE}`, unexpected positionals rejected. `--service` is **repeatable** — an epic may span several services, and a single-valued flag would force the brand-new-epic case into an artificially narrow cohort. `--refresh` calls `premortem.refresh` and waits before building the brief.

The brief prints each proposed watcher's real UUID with its arming command, `nimbus watch resume <id>` (verified: `packages/cli/src/commands/watch.ts` exposes list/pause/resume, and `watcher.resume` exists at `ipc/automation-rpc.ts:142`).

- [ ] **Step 1: Write the failing CLI + e2e tests**

CLI tests assert flag parsing, repeatable `--service`, and that an unknown flag exits non-zero with USAGE. Use **dependency injection, not `mock.module`** — `mock.module` is process-global and contaminates the combined `bun test packages/cli/src` run on CI-Linux. The e2e (`premortem.e2e.test.ts`) asserts the brief's sections, the `premortem.briefReady` notification, and **zero HITL fires**.

- [ ] **Step 2: Run to confirm they fail**

- [ ] **Step 3: Implement the handler, the allowlist line, and the CLI**

- [ ] **Step 4: Verify, including the Rust allowlist test**

Run: `bun test packages/cli/src/commands/pre-mortem.test.ts packages/gateway/test/e2e/scenarios/premortem.e2e.test.ts`
Then: `cd packages/ui/src-tauri && cargo test gateway_bridge`
Expected: PASS, with the count assertion now at 105.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/agents-rpc.ts packages/ui/src-tauri/src/gateway_bridge.rs packages/cli/src/commands/pre-mortem.ts packages/cli/src/commands/pre-mortem.test.ts packages/gateway/test/e2e/scenarios/premortem.e2e.test.ts
git commit -m "feat(cli): nimbus pre-mortem, with agents.premortem exposed to the renderer"
```

---

### Task 6: Documentation and ship-readiness

**Files:** `.claude/commands/nimbus-agent-patterns.md`, `docs/roadmap.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/architecture.md`

- [ ] **Step 1: Amend the Agent Shape Invariant**

`.claude/commands/nimbus-agent-patterns.md` states every built-in agent is read-only with no write tools in scope. pre-mortem writes paused watcher rows. Amend it deliberately, and state the exception's bounds: pre-mortem writes `watcher` rows with `enabled = 0` and `premortem_watcher_proposal` rows, and nothing else. Record that this is **not** an I2/HITL matter — I2 governs `HITL_REQUIRED_BACKING` action types that leave the machine via `engine/executor.ts`, and a local SQLite insert never enters that gate, exactly as `glossary`, `decisions`, `ownership` and the egress ledger already write local rows without one. The safety property is `enabled = 0`: `listEnabledWatchers` filters on `enabled === 1`, so a paused row cannot fire whoever inserted it.

- [ ] **Step 2: Update the roadmap**

`docs/roadmap.md` — the S1 "Remaining" row and the Phase 7 Wave 5 entry currently describe pre-mortem as both read-only *and* scheduling watchers. Record what was actually built: paused proposals only, `incident_opened` only, and why no deploy-failure watcher exists.

- [ ] **Step 3: `cli-reference.md`, `CHANGELOG.md`, `architecture.md`**

CLI entry for `nimbus pre-mortem`; a dated CHANGELOG entry in the file's `- **YYYY-MM-DD — Title…**` convention; and in architecture.md the `agents.premortem` IPC method plus a note that the V53 tables now have a reader.

- [ ] **Step 4: Ship-readiness**

Run each directly — never piped through `tail`, which reports the pipe's exit status and has already produced a false green on this project:

```bash
bun run preflight:fast
bun run typecheck:tests        # read the "N new" line; ADVISORY on Windows, GATING on CI-Linux
bun test packages/gateway/src/premortem/ packages/gateway/src/agents/ packages/cli/src/commands/pre-mortem.test.ts
bun run preflight              # full gate set before pushing
```

For `audit:coverage-floor`, ignore violations in `platform/linux.ts` and `ipc/server/socket-listeners.ts` — those are Windows-local artifacts of a CI-Linux-authoritative gate. Any violation in a file this branch touches is real.

- [ ] **Step 5: Commit**

```bash
git add .claude/commands/nimbus-agent-patterns.md docs/
git commit -m "docs: record the pre-mortem agent, its watcher exception, and the deploy-watcher decision"
```

---

## Out of scope for B2

- **A deploy-failure watcher** — decided; see the DECIDED callout in the B2 design spec.
- **Reconciling the annotate provider / syncable service vocabularies** — the real fix for the above, and a separate change.
- Semantic cohort selection; a project-based fallback cohort; indexing Jira components/labels; indexing ticket comments; armed watchers or any ChatOps routing; federated cross-team cohorts; a shared harness for the four extraction passes; a deterministic no-LLM theme-discovery fallback.
- Linear support, which needs a connector change to index projects as items.
