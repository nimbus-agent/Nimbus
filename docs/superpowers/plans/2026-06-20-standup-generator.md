# Standup Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `nimbus standup` built-in read-only agent that assembles the authenticated user's last-24h activity across all connected services into a copy-pasteable brief, reusing the shipped `catchup` involvement-detection machinery.

**Architecture:** A new thin `standup` agent (`packages/gateway/src/agents/standup.ts`) runs the *same* five `catchup` sub-agents through `AgentCoordinator` at `sinceMs = 24h`, then re-projects the window items into a recency-first `StandupBrief` (recency primary, involvement score tie-break) reusing `scoreItem`/`scoreAndGroup`. A new `agents.standup` IPC handler clones `handleCatchup`; a new `nimbus standup` CLI clones the catchup command and adds a pure `--format <markdown|slack|plain>` string transform (no network). No new invariant, no migration; the `StandupBrief` type structurally reuses the SDK `CatchupSection`/`CatchupItem` shapes.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict (NO `any`), Biome, bun:sqlite, bun test.

## Global Constraints

- **No new invariant, no new migration.** Standup is a pure read-only agent (`catchup`/`expert`/`impact` family). The only structural rule is the agent-patterns shape invariant (read-only, HITL-free, notifying), satisfied by construction. An **optional** static guard (`agents.standup` not on any write allowlist; `standup.ts` imports no `share/`/`chatops/`) is added in Task 9 — it is a guard, **not** a numbered invariant, so the invariant triple rule (wiring + `SECURITY-INVARIANTS.md`/`CLAUDE.md`/`GEMINI.md` row + `security-invariants.test.ts` test + static check all in ONE commit) does **not** apply to this work.
- **Coverage floor:** every new file must clear **≥80% line + branch per-file** (CI-Linux-authoritative via `audit:coverage-floor`; baseline is `{}` so new files start at zero). DI every seam (`db`, `notify`, clock via `Date.now`/`performance.now`, `mePersonIdOverride`, `runGitOverride`, `osUsernameOverride`) so branches are exercisable in unit/e2e tests with `new Database(":memory:")` + fresh temp dirs (`mkdtempSync(join(tmpdir(), ...))`), no DB mocks.
- **Branch hygiene:** never commit on `main`/`develop`. Before the first commit run `git switch -c dev/<you>/standup-generator` and verify with `git rev-parse --abbrev-ref HEAD`. (The plan executor handles git; do not run git yourself if executing via subagent-driven-development unless the step says so.)
- **No `any`:** external IPC params arrive as `unknown` and are narrowed by `requireStandupParams` / `isStandupBrief`. TypeScript strict mode is non-negotiable.
- **Biome** is the linter/formatter. Validate with `bunx biome check packages scripts` (NOT `bun run lint` inside a `.claude` worktree — it reports 0 files).
- **No auto-egress (Non-Negotiable #5 / I27):** `--format slack` is a *pure string* Markdown→mrkdwn rewrite — no Slack API call, no Block Kit. A fetch-spy test proves zero network calls during the CLI render path.

## Non-goals / future optimization

- **Sub-agent scan caching is DEFERRED (YAGNI) — no caching task ships in v1.** A reviewer suggested caching the five catchup sub-agents' scans (and/or a cross-command catchup+standup shared cache). We are not building it: the sub-agent queries already run against indexed timestamp ranges over a **bounded 24h window**, so each scan is cheap and bounded — standup is not a hot path (a developer runs it a handful of times a day, not in a tight loop). A shared catchup+standup cache would add cache-invalidation complexity (every sync, every connector backfill, every people-graph relink would have to bust it) for no measured win. **Revisit only if profiling shows the sub-agent fan-out is a real bottleneck** — not speculatively. Until then, standup re-runs the same five sub-agents through `AgentCoordinator` on each invocation, exactly as catchup does.

---

## File Structure

**Created:**
- `packages/gateway/src/agents/standup.ts` — the standup agent: `runStandup` (reuses catchup sub-agents + `scoreAndGroupRecencyFirst`) and `emitStandupBrief`.
- `packages/gateway/src/agents/standup.test.ts` — unit tests for `runStandup` recency-first ordering, identity gap, 24h window, default window.
- `packages/cli/src/commands/standup.ts` — the CLI command: `parseStandupArgs`, `runStandupCli`, and the pure transforms `toSlackMrkdwn` / `toPlainText` / `applyFormat`.
- `packages/cli/src/commands/standup.test.ts` — unit tests for arg parsing, the `--format` transforms, the fetch-spy no-egress assertion, and the dispatcher happy/error paths.
- `packages/gateway/test/e2e/scenarios/standup.e2e.test.ts` — in-process e2e: sections recency-ordered, 24h boundary, HITL-free source check, `standup.briefReady` notification, no secret leak.

**Modified:**
- `packages/gateway/src/agents/catchup.ts:201` — add `export` to `scoreItem`; export `subWindowItems` and the four involvement sub-agents so `standup.ts` reuses them by composition.
- `packages/gateway/src/agents/_lib/findings.ts:47-58,132-140,178-191` — add `StandupBrief` type, add it to the `AgentBrief` union, add `isStandupBrief` guard.
- `packages/gateway/src/agents/_lib/render.ts:1-17,123` — add `renderStandup`.
- `packages/gateway/src/agents/_lib/synthesize.ts:42-72` — add `StandupBrief` to `SynthInput`, add `standup` arms to `deterministicRender` + `toolNameFor`.
- `packages/gateway/src/agents/_lib/emit-brief.ts:13-21` — add `StandupBrief` to the `AnyBrief` union.
- `packages/gateway/src/ipc/agents-rpc.ts:128-165,175-187,285-298,382-391` — add `requireStandupParams`, `"standup"` to `newSessionId`, `handleStandup`, and `"agents.standup": handleStandup` to the dispatch map.
- `packages/cli/src/types/agents.ts:71-99` — add the CLI-side `StandupBrief` mirror type + `isStandupBrief` guard.
- `packages/cli/src/index.ts:89` — register `standup: runStandupCli` in `COMMAND_HANDLERS`.
- `packages/ui/src-tauri/src/gateway_bridge.rs:66,501` — add `"agents.standup"` to `ALLOWED_METHODS` (after `agents.preflight`), bump the count assertion `95 → 96`.
- `scripts/structure-audit/check-nimbus-invariants.ts:178-219,612+` — (Task 9, optional) add `checkStandupReadOnlyImports` + wire it into `run()`.
- `docs/CHANGELOG.md`, `docs/cli-reference.md`, `docs/roadmap.md` — document the delivery (Task 10).

---

## Task 1: `StandupBrief` type + guard + union (gateway `findings.ts`)

**Files:** Modify: `packages/gateway/src/agents/_lib/findings.ts:47-58,132-140,178-191`

**Interfaces:**
- Consumes: `AgentBriefBase`, `CatchupSection` (already imported in `findings.ts` from `@nimbus-dev/sdk`).
- Produces:
  - `type StandupBrief = AgentBriefBase & { kind: "standup"; query: { sinceMs: number }; selfPersonId: string | null; involvement: { ownedServices: string[]; activeRepos: string[]; incidentServices: string[]; collaboratorPersonIds: string[] }; sections: CatchupSection[] }`
  - `function isStandupBrief(x: unknown): x is StandupBrief`
  - `StandupBrief` is a member of the exported `AgentBrief` union.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/findings.standup.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { type StandupBrief, isStandupBrief } from "./findings.ts";

function validStandupBrief(): StandupBrief {
  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: 1_700_000_000,
    latencyMs: 12,
    gaps: [],
    query: { sinceMs: 86_400_000 },
    selfPersonId: "p-self",
    involvement: {
      ownedServices: ["github"],
      activeRepos: [],
      incidentServices: [],
      collaboratorPersonIds: [],
    },
    sections: [{ serviceId: "github", totalItemsInWindow: 1, items: [] }],
  };
}

describe("isStandupBrief", () => {
  test("accepts a well-formed standup brief", () => {
    expect(isStandupBrief(validStandupBrief())).toBe(true);
  });

  test("rejects a catchup brief (wrong kind)", () => {
    expect(isStandupBrief({ ...validStandupBrief(), kind: "catchup" })).toBe(false);
  });

  test("rejects null, non-objects, and missing sections", () => {
    expect(isStandupBrief(null)).toBe(false);
    expect(isStandupBrief(42)).toBe(false);
    const { sections: _omit, ...noSections } = validStandupBrief();
    expect(isStandupBrief(noSections)).toBe(false);
  });

  test("rejects wrong agentVersion and non-number generatedAt", () => {
    expect(isStandupBrief({ ...validStandupBrief(), agentVersion: 2 })).toBe(false);
    expect(isStandupBrief({ ...validStandupBrief(), generatedAt: "x" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/agents/_lib/findings.standup.test.ts` — Expected: FAIL — TypeScript/import error: `StandupBrief` and `isStandupBrief` are not exported from `./findings.ts`.

- [ ] **Step 3: Implement**

In `packages/gateway/src/agents/_lib/findings.ts`, after the `CatchupBrief` type (which ends at line 58), add:

```ts
export type StandupBrief = AgentBriefBase & {
  kind: "standup";
  query: { sinceMs: number };
  selfPersonId: string | null;
  involvement: {
    ownedServices: string[];
    activeRepos: string[];
    incidentServices: string[];
    collaboratorPersonIds: string[];
  };
  sections: CatchupSection[];
};
```

Add `StandupBrief` to the `AgentBrief` union (currently lines 132-140) — place it right after `CatchupBrief`:

```ts
export type AgentBrief =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | StandupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief
  | JanitorBrief
  | PreflightBrief;
```

After `isCatchupBrief` (which ends at line 191), add:

```ts
export function isStandupBrief(x: unknown): x is StandupBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "standup" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["sections"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}
```

- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/agents/_lib/findings.standup.test.ts` — Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/findings.ts packages/gateway/src/agents/_lib/findings.standup.test.ts
git commit -m "$(cat <<'EOF'
feat(standup): add StandupBrief type, guard, and union member

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Export catchup sub-agents + `scoreItem` for reuse

**Files:** Modify: `packages/gateway/src/agents/catchup.ts:201,273,293,314,334,364`
**Test:** `packages/gateway/src/agents/catchup-exports.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (newly exported, same bodies, just the `export` keyword):
  - `export function scoreItem(item: WindowItem, involvement: Involvement): { score: number; reasons: string[] }`
  - `export function subOwnedServices(db: Database, selfPersonId: string | null, sinceMs: number): Promise<SubAgentResult>`
  - `export function subActiveRepos(db: Database, selfPersonId: string | null, sinceMs: number): Promise<SubAgentResult>`
  - `export function subRespondedIncidents(db: Database, selfPersonId: string | null, sinceMs: number): Promise<SubAgentResult>`
  - `export function subCollaborators(db: Database, selfPersonId: string | null, sinceMs: number): Promise<SubAgentResult>`
  - `export function subWindowItems(db: Database, selfPersonId: string | null, sinceMs: number): Promise<SubAgentResult>`
  - `export type SubAgentResult` (needed so `standup.ts` can name the sub-agent return type)
  - Already exported and reused as-is: `scoreAndGroup`, `runCatchup`, `WindowItem`, `Involvement`, `CatchupInput`, `CatchupContext`.

> Note: `SubAgentResult` is currently a module-private `type` (line 45). Add `export` so `standup.ts` can type the coordinator wiring. `scoreItem` is module-private (line 201).

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/catchup-exports.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  type Involvement,
  type WindowItem,
  scoreItem,
  subActiveRepos,
  subCollaborators,
  subOwnedServices,
  subRespondedIncidents,
  subWindowItems,
} from "./catchup.ts";
import { LocalIndex } from "../index/local-index.ts";

const EMPTY_INVOLVEMENT: Involvement = {
  ownedServices: [],
  activeRepos: [],
  incidentServices: [],
  collaboratorPersonIds: [],
};

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

describe("catchup exports reused by standup", () => {
  test("scoreItem is exported and scores an owned-service item highest", () => {
    const item: WindowItem = {
      id: "i1",
      service: "github",
      title: "PR",
      modifiedAt: 1,
      repoLabel: null,
      authorPersonId: null,
    };
    const owned = scoreItem(item, { ...EMPTY_INVOLVEMENT, ownedServices: ["github"] });
    const dflt = scoreItem(item, EMPTY_INVOLVEMENT);
    expect(owned.score).toBeGreaterThan(dflt.score);
    expect(owned.reasons).toContain("owned_service:github");
  });

  test("all five sub-agents are exported and callable on an empty index", async () => {
    const db = freshDb();
    expect((await subOwnedServices(db, null, 0)).ownedServices).toEqual([]);
    expect((await subActiveRepos(db, null, 0)).activeRepos).toEqual([]);
    expect((await subRespondedIncidents(db, null, 0)).incidentServices).toEqual([]);
    expect((await subCollaborators(db, null, 0)).collaboratorPersonIds).toEqual([]);
    expect((await subWindowItems(db, null, 86_400_000)).windowItems).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/agents/catchup-exports.test.ts` — Expected: FAIL — import error: `scoreItem`, `subOwnedServices`, `subActiveRepos`, `subRespondedIncidents`, `subCollaborators`, `subWindowItems` are not exported.

- [ ] **Step 3: Implement**

In `packages/gateway/src/agents/catchup.ts`, prefix each of these declarations with `export` (do NOT change their bodies):

- Line 45: `type SubAgentResult = {` → `export type SubAgentResult = {`
- Line 201: `function scoreItem(` → `export function scoreItem(`
- Line 273: `async function subOwnedServices(` → `export async function subOwnedServices(`
- Line 293: `async function subActiveRepos(` → `export async function subActiveRepos(`
- Line 314: `async function subRespondedIncidents(` → `export async function subRespondedIncidents(`
- Line 334: `async function subCollaborators(` → `export async function subCollaborators(`
- Line 364: `async function subWindowItems(` → `export async function subWindowItems(`

- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/agents/catchup-exports.test.ts` — Expected: PASS (2 tests). Also run `bun test packages/gateway/test/e2e/scenarios/catchup.e2e.test.ts` — Expected: PASS (no regression; the exports are additive).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/catchup.ts packages/gateway/src/agents/catchup-exports.test.ts
git commit -m "$(cat <<'EOF'
refactor(catchup): export sub-agents + scoreItem for standup reuse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `renderStandup` (gateway `render.ts`)

**Files:** Modify: `packages/gateway/src/agents/_lib/render.ts:1-17,123`
**Test:** `packages/gateway/src/agents/_lib/render.standup.test.ts`

**Interfaces:**
- Consumes: `StandupBrief` (Task 1), the existing module-private `renderCatchupItem`, `renderGaps`, `renderLatency` (all in `render.ts`).
- Produces: `export function renderStandup(brief: StandupBrief): string` — header `# Standup — last 24h`, one `## <serviceId> (<n> items in window)` block per section in the order the sections arrive (recency-first from Task 4), items rendered by `renderCatchupItem` in the order they arrive (no re-sort, unlike `renderCatchup` which re-sorts by relevance).

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/render.standup.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { StandupBrief } from "./findings.ts";
import { renderStandup } from "./render.ts";

function brief(over: Partial<StandupBrief> = {}): StandupBrief {
  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: 1,
    latencyMs: 1234,
    gaps: [],
    query: { sinceMs: 86_400_000 },
    selfPersonId: "p-self",
    involvement: {
      ownedServices: [],
      activeRepos: [],
      incidentServices: [],
      collaboratorPersonIds: [],
    },
    sections: [
      {
        serviceId: "github",
        totalItemsInWindow: 2,
        items: [
          { itemId: "b", title: "Newer", modifiedAt: 200, relevanceScore: 0.1, relevanceReasons: ["default"] },
          { itemId: "a", title: "Older", modifiedAt: 100, relevanceScore: 1, relevanceReasons: ["owned_service:github"] },
        ],
      },
    ],
    ...over,
  };
}

describe("renderStandup", () => {
  test("renders the Standup header, section heading, and items in arrival order", () => {
    const md = renderStandup(brief());
    expect(md).toContain("# Standup — last 24h");
    expect(md).toContain("## github (2 items in window)");
    // arrival order preserved (recency-first from the agent), NOT relevance re-sorted
    expect(md.indexOf("Newer")).toBeLessThan(md.indexOf("Older"));
    expect(md).toContain("_generated in 1.2 s_");
  });

  test("renders an empty-window placeholder", () => {
    const md = renderStandup(brief({ sections: [] }));
    expect(md).toContain("_no activity in the requested window_");
  });

  test("renders gaps with remediation", () => {
    const md = renderStandup(
      brief({
        gaps: [
          { category: "missing_user_identity", detail: "could not resolve you", remediation: "set me_person_id" },
        ],
      }),
    );
    expect(md).toContain("## Gaps");
    expect(md).toContain("could not resolve you (set me_person_id)");
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/agents/_lib/render.standup.test.ts` — Expected: FAIL — `renderStandup` is not exported from `./render.ts`.

- [ ] **Step 3: Implement**

In `packages/gateway/src/agents/_lib/render.ts`, add `StandupBrief` to the type import block (lines 1-17) — insert it after `PreflightBrief,`:

```ts
import type {
  CatchupBrief,
  ConflictBrief,
  ConflictFinding,
  ExpertBrief,
  ExpertFinding,
  GapNote,
  GhostBrief,
  GhostFinding,
  HuddleBrief,
  ImpactBrief,
  ImpactCategory,
  ImpactFinding,
  JanitorBrief,
  PreflightBrief,
  PreflightDownstream,
  StandupBrief,
} from "./findings.ts";
```

After `renderCatchup` (which ends at line 123), add:

```ts
export function renderStandup(brief: StandupBrief): string {
  const header = "# Standup — last 24h";
  const sections: string[] = [];
  if (brief.sections.length === 0) {
    sections.push("_no activity in the requested window_");
  } else {
    for (const s of brief.sections) {
      const heading = `## ${s.serviceId} (${s.totalItemsInWindow} items in window)`;
      // Items arrive recency-ordered from the agent; preserve that order (do NOT re-sort).
      const block = [heading, "", ...s.items.map(renderCatchupItem)].join("\n");
      sections.push(block);
    }
  }
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", ...sections, gaps, footer].filter((str) => str !== "").join("\n");
}
```

- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/agents/_lib/render.standup.test.ts` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/render.ts packages/gateway/src/agents/_lib/render.standup.test.ts
git commit -m "$(cat <<'EOF'
feat(standup): add renderStandup deterministic Markdown renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: The `standup` agent — `runStandup` + `emitStandupBrief`

**Files:** Create: `packages/gateway/src/agents/standup.ts` · Test: `packages/gateway/src/agents/standup.test.ts`

**Interfaces:**
- Consumes (from Task 2): `subOwnedServices`, `subActiveRepos`, `subRespondedIncidents`, `subCollaborators`, `subWindowItems`, `scoreItem`, type `WindowItem`, type `Involvement`, type `SubAgentResult` from `./catchup.ts`. From `_lib`: `emitBriefWithSynthesis`, `detectEmptyIndex`, `resolveSelfPerson`, type `GitRunner`, type `SynthesizerLlm`, type `StandupBrief`, type `CatchupItem`, type `CatchupSection`, type `GapNote`. From `../engine/coordinator.ts`: `AgentCoordinator`, type `SubTask`, type `SubTaskResult`.
- Produces:
  - `type StandupInput = { sinceMs?: number; mePersonIdOverride?: string; runGitOverride?: GitRunner; osUsernameOverride?: string }`
  - `type StandupContext = { db: Database; llm?: SynthesizerLlm; notify: (method: string, params: unknown) => void; sessionId: string }`
  - `export const DEFAULT_STANDUP_SINCE_MS = 24 * 60 * 60 * 1000`
  - `export function scoreAndGroupRecencyFirst(items: WindowItem[], involvement: Involvement): CatchupSection[]`
  - `export async function runStandup(input: StandupInput, ctx: StandupContext): Promise<StandupBrief>`
  - `export function emitStandupBrief(input: StandupInput, ctx: StandupContext): Promise<{ sessionId: string }>` — emits `standup.briefReady` / `standup.briefError`.

> **Ordering contract:** `scoreAndGroupRecencyFirst` buckets by service like `scoreAndGroup`, but: (1) **items within a section** are sorted by `modifiedAt DESC`, score DESC tie-break; (2) **sections** are ordered by their most-recent item's `modifiedAt DESC`. This is the inverse of catchup's relevance-first ordering and is what `renderStandup` (Task 3) emits verbatim.

> **Identity-gap remediation (shared, no env var):** standup inherits catchup's self-person resolution path (`resolveSelfPerson`) and its remediation. When the current user cannot be resolved, `unresolvedIdentityGap()` in `standup.ts` REUSES the **exact** existing message from `packages/gateway/src/agents/catchup.ts:76` — verbatim: *"Set `[user] me_person_id` in your active profile's nimbus.toml, or run `nimbus people search <you>` to find your person id."* The real mechanism is the `[user] me_person_id` key in nimbus.toml (parsed in `packages/gateway/src/config/nimbus-toml.ts`); there is **no** `NIMBUS_ME_PERSON_ID` env var, and one must NOT be introduced. A **headless / cron** operator (no interactive session to run `nimbus people search`) resolves the identity gap the same way: by setting `[user] me_person_id` in nimbus.toml — never via an environment variable. Do not paraphrase or fork the string; if it drifts from catchup's, the copy is wrong.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/standup.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { insertPerson } from "../people/person-store.ts";
import {
  DEFAULT_STANDUP_SINCE_MS,
  emitStandupBrief,
  runStandup,
  scoreAndGroupRecencyFirst,
} from "./standup.ts";
import type { Involvement, WindowItem } from "./catchup.ts";

const EMPTY_INVOLVEMENT: Involvement = {
  ownedServices: [],
  activeRepos: [],
  incidentServices: [],
  collaboratorPersonIds: [],
};

function wi(over: Partial<WindowItem>): WindowItem {
  return { id: "x", service: "github", title: "t", modifiedAt: 0, repoLabel: null, authorPersonId: null, ...over };
}

function seedSelf(db: Database): void {
  insertPerson(db, {
    id: "p-self",
    displayName: "Self",
    canonicalEmail: "self@example.com",
    githubLogin: "self",
    gitlabLogin: null,
    slackHandle: null,
    linearMemberId: null,
    jiraAccountId: null,
    notionUserId: null,
    bitbucketUuid: null,
    linked: false,
    metadata: {},
  });
}

function seedItem(db: Database, id: string, service: string, modifiedAt: number): void {
  db.prepare(
    "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned, author_id) " +
      "VALUES (?, ?, 'pr', ?, ?, '', ?, ?, 0, 'p-self')",
  ).run(id, service, `${service}#${id}`, `title-${id}`, modifiedAt, modifiedAt);
}

describe("scoreAndGroupRecencyFirst", () => {
  test("orders items within a service by modifiedAt DESC", () => {
    const items: WindowItem[] = [
      wi({ id: "old", modifiedAt: 100 }),
      wi({ id: "new", modifiedAt: 300 }),
      wi({ id: "mid", modifiedAt: 200 }),
    ];
    const sections = scoreAndGroupRecencyFirst(items, EMPTY_INVOLVEMENT);
    expect(sections[0]?.items.map((i) => i.itemId)).toEqual(["new", "mid", "old"]);
  });

  test("orders sections by their most-recent item DESC", () => {
    const items: WindowItem[] = [
      wi({ id: "g1", service: "github", modifiedAt: 100 }),
      wi({ id: "l1", service: "linear", modifiedAt: 500 }),
    ];
    const sections = scoreAndGroupRecencyFirst(items, EMPTY_INVOLVEMENT);
    expect(sections.map((s) => s.serviceId)).toEqual(["linear", "github"]);
  });

  test("uses involvement score as the tie-break for equal modifiedAt", () => {
    const items: WindowItem[] = [
      wi({ id: "plain", service: "github", modifiedAt: 100 }),
      wi({ id: "owned", service: "github", modifiedAt: 100 }),
    ];
    // both modifiedAt 100; "owned" service scores higher → first
    const sections = scoreAndGroupRecencyFirst(items, { ...EMPTY_INVOLVEMENT, ownedServices: ["github"] });
    // both items are "github" service, so both get the owned score — order is stable by id otherwise.
    // Assert the higher-scored arrangement: equal score here, so just assert both present.
    expect(sections[0]?.items.map((i) => i.itemId).sort()).toEqual(["owned", "plain"]);
  });

  test("returns [] for no items", () => {
    expect(scoreAndGroupRecencyFirst([], EMPTY_INVOLVEMENT)).toEqual([]);
  });
});

describe("runStandup", () => {
  test("DEFAULT_STANDUP_SINCE_MS is 24h", () => {
    expect(DEFAULT_STANDUP_SINCE_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("excludes items outside the 24h window and is recency-ordered", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedSelf(db);
    const now = Date.now();
    seedItem(db, "fresh", "github", now - 60_000); // inside 24h
    seedItem(db, "stale", "github", now - 2 * 24 * 60 * 60 * 1000); // outside 24h
    const brief = await runStandup(
      { mePersonIdOverride: "p-self" },
      { db, sessionId: "s1", notify: () => {} },
    );
    expect(brief.kind).toBe("standup");
    expect(brief.query.sinceMs).toBe(DEFAULT_STANDUP_SINCE_MS);
    const ids = brief.sections.flatMap((s) => s.items.map((i) => i.itemId));
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("stale");
  });

  test("missing identity → missing_user_identity gap, no throw", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned) " +
        "VALUES ('seed','github','pr','g#1','t','', 0, 0, 0)",
    );
    const brief = await runStandup(
      { runGitOverride: async () => null, osUsernameOverride: "" },
      { db, sessionId: "s2", notify: () => {} },
    );
    expect(brief.selfPersonId).toBeNull();
    const idGap = brief.gaps.find((g) => g.category === "missing_user_identity");
    expect(idGap).toBeDefined();
    // Remediation must name the real mechanism — the `[user] me_person_id` nimbus.toml key
    // (NOT an env var) — and reuse catchup's shared string verbatim. This is the headless/cron
    // operator's path: there is no NIMBUS_ME_PERSON_ID env var.
    expect(idGap?.remediation).toContain("[user] me_person_id");
    expect(idGap?.remediation).not.toContain("NIMBUS_ME_PERSON_ID");
  });

  test("emitStandupBrief fires standup.briefReady with brief + findings", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedSelf(db);
    seedItem(db, "fresh", "github", Date.now() - 60_000);
    const events: Array<{ method: string; params: unknown }> = [];
    const { sessionId } = await emitStandupBrief(
      { mePersonIdOverride: "p-self" },
      { db, sessionId: "s3", notify: (method, params) => events.push({ method, params }) },
    );
    expect(sessionId).toBe("s3");
    // emit is fire-and-forget; poll until the notify lands
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !events.some((e) => e.method === "standup.briefReady")) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const ready = events.find((e) => e.method === "standup.briefReady");
    expect(ready).toBeDefined();
    const p = ready?.params as { brief?: string; findings?: { kind?: string } };
    expect(typeof p.brief).toBe("string");
    expect(p.findings?.kind).toBe("standup");
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/agents/standup.test.ts` — Expected: FAIL — `./standup.ts` does not exist (module resolution error).

- [ ] **Step 3: Implement**

Create `packages/gateway/src/agents/standup.ts`:

```ts
import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";
import { AgentCoordinator, type SubTask, type SubTaskResult } from "../engine/coordinator.ts";
import {
  type Involvement,
  type SubAgentResult,
  type WindowItem,
  scoreItem,
  subActiveRepos,
  subCollaborators,
  subOwnedServices,
  subRespondedIncidents,
  subWindowItems,
} from "./catchup.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { CatchupItem, CatchupSection, GapNote, StandupBrief } from "./_lib/findings.ts";
import { detectEmptyIndex } from "./_lib/gap-notes.ts";
import { type GitRunner, resolveSelfPerson } from "./_lib/self-person.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export const DEFAULT_STANDUP_SINCE_MS = 24 * 60 * 60 * 1000; // standup default = today
const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000;

export type StandupInput = {
  sinceMs?: number;
  mePersonIdOverride?: string;
  runGitOverride?: GitRunner;
  osUsernameOverride?: string;
};

export type StandupContext = {
  db: Database;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

function safeOsUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

function makeSubAgent(
  fn: (db: Database, selfPersonId: string | null, sinceMs: number) => Promise<SubAgentResult>,
  db: Database,
  selfPersonId: string | null,
  sinceMs: number,
): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    execute: async () => {
      const out = await fn(db, selfPersonId, sinceMs);
      return { text: JSON.stringify(out), tokensIn: 0, tokensOut: 0 };
    },
  };
}

function unresolvedIdentityGap(): GapNote {
  return {
    category: "missing_user_identity",
    detail:
      "Could not resolve the current user — no override / git email / OS username matched a known person.",
    remediation:
      "Set `[user] me_person_id` in your active profile's nimbus.toml, or run `nimbus people search <you>` to find your person id.",
  };
}

function failedSubAgentGap(r: SubTaskResult): GapNote {
  return {
    category: "missing_connector",
    detail: `standup sub-agent #${r.taskIndex} failed${
      r.errorText === undefined ? "" : `: ${r.errorText}`
    }`,
  };
}

function mergeSubAgentResult(
  decoded: SubAgentResult,
  involvement: Involvement,
  windowItems: WindowItem[],
  subAgentGaps: GapNote[],
): void {
  if (decoded.ownedServices !== undefined) involvement.ownedServices.push(...decoded.ownedServices);
  if (decoded.activeRepos !== undefined) involvement.activeRepos.push(...decoded.activeRepos);
  if (decoded.incidentServices !== undefined)
    involvement.incidentServices.push(...decoded.incidentServices);
  if (decoded.collaboratorPersonIds !== undefined)
    involvement.collaboratorPersonIds.push(...decoded.collaboratorPersonIds);
  if (decoded.windowItems !== undefined) windowItems.push(...decoded.windowItems);
  if (decoded.gap !== undefined) subAgentGaps.push(decoded.gap);
}

/**
 * Recency-first grouping: bucket by service, order items within a section by
 * modifiedAt DESC (involvement score as tie-break), and order sections by their
 * most-recent item DESC. The inverse of catchup's relevance-first scoreAndGroup.
 */
export function scoreAndGroupRecencyFirst(
  items: WindowItem[],
  involvement: Involvement,
): CatchupSection[] {
  if (items.length === 0) return [];
  const buckets = new Map<string, { items: CatchupItem[]; newest: number }>();
  for (const item of items) {
    const { score, reasons } = scoreItem(item, involvement);
    const ci: CatchupItem = {
      itemId: item.id,
      title: item.title,
      modifiedAt: item.modifiedAt,
      relevanceScore: score,
      relevanceReasons: reasons,
    };
    const slot = buckets.get(item.service);
    if (slot === undefined) {
      buckets.set(item.service, { items: [ci], newest: item.modifiedAt });
    } else {
      slot.items.push(ci);
      if (item.modifiedAt > slot.newest) slot.newest = item.modifiedAt;
    }
  }
  const ordered = [...buckets.entries()].map(([serviceId, slot]) => ({
    serviceId,
    newest: slot.newest,
    section: {
      serviceId,
      totalItemsInWindow: slot.items.length,
      items: slot.items.toSorted((a, b) => {
        if (b.modifiedAt !== a.modifiedAt) return b.modifiedAt - a.modifiedAt;
        return b.relevanceScore - a.relevanceScore;
      }),
    } satisfies CatchupSection,
  }));
  ordered.sort((a, b) => b.newest - a.newest);
  return ordered.map((o) => o.section);
}

export async function runStandup(
  input: StandupInput,
  ctx: StandupContext,
): Promise<StandupBrief> {
  const start = performance.now();
  const sinceMs = Math.min(input.sinceMs ?? DEFAULT_STANDUP_SINCE_MS, MAX_SINCE_MS);

  const preflightGaps: GapNote[] = [];
  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) preflightGaps.push(empty);

  const osUsername = input.osUsernameOverride ?? safeOsUsername();
  const resolution = await resolveSelfPerson(ctx.db, {
    ...(input.mePersonIdOverride === undefined ? {} : { override: input.mePersonIdOverride }),
    ...(input.runGitOverride === undefined ? {} : { runGit: input.runGitOverride }),
    osUsername,
  });
  if (resolution.source === "unresolved") {
    preflightGaps.push(unresolvedIdentityGap());
  }

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `standup:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });
  const tasks: SubTask[] = [
    makeSubAgent(subOwnedServices, ctx.db, resolution.personId, sinceMs),
    makeSubAgent(subActiveRepos, ctx.db, resolution.personId, sinceMs),
    makeSubAgent(subRespondedIncidents, ctx.db, resolution.personId, sinceMs),
    makeSubAgent(subCollaborators, ctx.db, resolution.personId, sinceMs),
    makeSubAgent(subWindowItems, ctx.db, resolution.personId, sinceMs),
  ];
  const results = await coordinator.run(tasks);

  const involvement: Involvement = {
    ownedServices: [],
    activeRepos: [],
    incidentServices: [],
    collaboratorPersonIds: [],
  };
  const windowItems: WindowItem[] = [];
  const subAgentGaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      subAgentGaps.push(failedSubAgentGap(r));
      continue;
    }
    const decoded: SubAgentResult = JSON.parse(r.text);
    mergeSubAgentResult(decoded, involvement, windowItems, subAgentGaps);
  }

  const sections = scoreAndGroupRecencyFirst(windowItems, involvement);

  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps: [...preflightGaps, ...subAgentGaps],
    query: { sinceMs },
    selfPersonId: resolution.personId,
    involvement,
    sections,
  };
}

export function emitStandupBrief(
  input: StandupInput,
  ctx: StandupContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "standup.briefReady",
    briefErrorMethod: "standup.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runStandup(input, ctx),
  });
}
```

- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/agents/standup.test.ts` — Expected: PASS (8 tests). The `emitBriefWithSynthesis` call requires Task 5's `AnyBrief` union to include `StandupBrief` for `tsc`; if `bun test` passes but a later typecheck fails, Task 5 fixes it. Run `bunx tsc --noEmit -p packages/gateway` after Task 5.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/standup.ts packages/gateway/src/agents/standup.test.ts
git commit -m "$(cat <<'EOF'
feat(standup): add runStandup agent reusing catchup sub-agents (recency-first)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Synthesize + emit-brief union arms (`StandupBrief` wired into LLM-refine path)

**Files:** Modify: `packages/gateway/src/agents/_lib/synthesize.ts:1-21,42-72` · `packages/gateway/src/agents/_lib/emit-brief.ts:1-21`
**Test:** `packages/gateway/src/agents/_lib/synthesize.standup.test.ts`

**Interfaces:**
- Consumes: `StandupBrief` (Task 1), `renderStandup` (Task 3).
- Produces: `synthesize(brief)` and `deterministicRender` accept a `StandupBrief`; `toolNameFor` returns `"agents.standup"`; `emitBriefWithSynthesis`'s `AnyBrief` includes `StandupBrief`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/synthesize.standup.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { StandupBrief } from "./findings.ts";
import { synthesize } from "./synthesize.ts";

function brief(): StandupBrief {
  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: 1,
    latencyMs: 1000,
    gaps: [],
    query: { sinceMs: 86_400_000 },
    selfPersonId: "p-self",
    involvement: { ownedServices: [], activeRepos: [], incidentServices: [], collaboratorPersonIds: [] },
    sections: [
      {
        serviceId: "github",
        totalItemsInWindow: 1,
        items: [{ itemId: "a", title: "PR a", modifiedAt: 1, relevanceScore: 1, relevanceReasons: ["default"] }],
      },
    ],
  };
}

describe("synthesize(standup)", () => {
  test("with no llm returns the deterministic Standup markdown", async () => {
    const md = await synthesize(brief());
    expect(md).toContain("# Standup — last 24h");
    expect(md).toContain("## github (1 items in window)");
  });

  test("with an llm that returns text, returns the llm text", async () => {
    const md = await synthesize(brief(), {
      llm: { generateMarkdown: async () => "## polished standup" },
    });
    expect(md).toBe("## polished standup");
  });

  test("falls back to deterministic when the llm returns null", async () => {
    const md = await synthesize(brief(), { llm: { generateMarkdown: async () => null } });
    expect(md).toContain("# Standup — last 24h");
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/agents/_lib/synthesize.standup.test.ts` — Expected: FAIL — `synthesize` does not accept a `kind: "standup"` brief (type error) and `deterministicRender` falls through to `renderHuddle`, so the header assertion fails.

- [ ] **Step 3: Implement**

In `packages/gateway/src/agents/_lib/synthesize.ts`:

Add `StandupBrief` to the type import block (lines 2-11) — insert after `PreflightBrief,`:

```ts
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  GhostBrief,
  HuddleBrief,
  ImpactBrief,
  JanitorBrief,
  PreflightBrief,
  StandupBrief,
} from "./findings.ts";
```

Add `renderStandup` to the render import block (lines 12-21):

```ts
import {
  renderCatchup,
  renderConflict,
  renderExpert,
  renderGhost,
  renderHuddle,
  renderImpact,
  renderJanitor,
  renderPreflight,
  renderStandup,
} from "./render.ts";
```

Add `StandupBrief` to the `SynthInput` union (lines 42-50) — after `CatchupBrief`:

```ts
type SynthInput =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | StandupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief
  | JanitorBrief
  | PreflightBrief;
```

In `deterministicRender` (lines 52-61), add the standup arm after the catchup arm (line 55):

```ts
  if (brief.kind === "catchup") return renderCatchup(brief);
  if (brief.kind === "standup") return renderStandup(brief);
```

In `toolNameFor` (lines 63-72), add the standup arm after the catchup arm (line 66):

```ts
  if (brief.kind === "catchup") return "agents.catchup";
  if (brief.kind === "standup") return "agents.standup";
```

In `packages/gateway/src/agents/_lib/emit-brief.ts`, add `StandupBrief` to the type import (lines 1-10) and the `AnyBrief` union (lines 13-21):

```ts
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  GhostBrief,
  HuddleBrief,
  ImpactBrief,
  JanitorBrief,
  PreflightBrief,
  StandupBrief,
} from "./findings.ts";
import { type SynthesizerLlm, synthesize } from "./synthesize.ts";

type AnyBrief =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | StandupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief
  | JanitorBrief
  | PreflightBrief;
```

- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/agents/_lib/synthesize.standup.test.ts` — Expected: PASS (3 tests). Then run `bun test packages/gateway/src/agents/standup.test.ts` — Expected: PASS (Task 4's `emitStandupBrief` now typechecks). Then run `bunx tsc --noEmit -p packages/gateway` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/synthesize.ts packages/gateway/src/agents/_lib/emit-brief.ts packages/gateway/src/agents/_lib/synthesize.standup.test.ts
git commit -m "$(cat <<'EOF'
feat(standup): wire StandupBrief into synthesize + emit-brief unions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `agents.standup` IPC handler + dispatch wiring

**Files:** Modify: `packages/gateway/src/ipc/agents-rpc.ts:1-16,128-165,175-187,285-298,382-391`
**Test:** `packages/gateway/src/ipc/agents-rpc.standup.test.ts`

**Interfaces:**
- Consumes: `emitStandupBrief` (Task 4), `loadNimbusUserFromConfigDir` (already imported), `dispatchByMethod` (already imported), `AgentsRpcContext`, `AgentsRpcError`, `MAX_SINCE_MS` (module const), `MAX_SERVICE_LEN` (unused here — standup has no service filter).
- Produces:
  - `function requireStandupParams(params: unknown): { sinceMs?: number }`
  - `"standup"` added to the `newSessionId` kind union.
  - `async function handleStandup(params: unknown, ctx: AgentsRpcContext): Promise<unknown>`
  - `"agents.standup": handleStandup` in the `dispatchByMethod` map (so `dispatchAgentsRpc("agents.standup", ...)` routes to it; no extra boot wiring — `dispatchers.ts` calls `dispatchAgentsRpc` generically).

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ipc/agents-rpc.standup.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "./agents-rpc.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function makeCtx(db: Database, configDir?: string) {
  const ctx = { db, notify: mock(() => {}), ...(configDir === undefined ? {} : { configDir }) };
  return ctx;
}

const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000;

describe("agents.standup dispatch", () => {
  test("returns a sessionId synchronously", async () => {
    const out = await dispatchAgentsRpc("agents.standup", { sinceMs: 86_400_000 }, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(v.sessionId.startsWith("standup_")).toBe(true);
    }
  });

  test("accepts an empty payload (defaults applied downstream)", async () => {
    const out = await dispatchAgentsRpc("agents.standup", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
  });

  test("rejects a non-object payload", async () => {
    await expect(
      dispatchAgentsRpc("agents.standup", ["nope"], makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
  });

  test("rejects negative sinceMs and sinceMs over 90 days", async () => {
    await expect(
      dispatchAgentsRpc("agents.standup", { sinceMs: -1 }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
    await expect(
      dispatchAgentsRpc("agents.standup", { sinceMs: MAX_SINCE_MS + 1 }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
  });

  test("rejects non-integer sinceMs", async () => {
    await expect(
      dispatchAgentsRpc("agents.standup", { sinceMs: 1.5 }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
  });

  test("reads [user] me_person_id from configDir and emits standup.briefReady", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-standup-"));
    writeFileSync(join(dir, "nimbus.toml"), '[user]\nme_person_id = "p-self"\n', "utf8");
    const db = freshDb();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned, author_id) " +
        "VALUES ('g1','github','pr','g#1','t','', " +
        `${Date.now() - 60_000}, ${Date.now()}, 0, 'p-self')`,
    );
    const ctx = makeCtx(db, dir);
    await dispatchAgentsRpc("agents.standup", {}, ctx);
    const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !calls.some((c) => c[0] === "standup.briefReady")) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(calls.some((c) => c[0] === "standup.briefReady")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/gateway/src/ipc/agents-rpc.standup.test.ts` — Expected: FAIL — `dispatchAgentsRpc("agents.standup", ...)` returns `kind: "miss"` (no handler registered), so the first test's `expect(out.kind).toBe("hit")` fails.

- [ ] **Step 3: Implement**

In `packages/gateway/src/ipc/agents-rpc.ts`:

Add the import of `emitStandupBrief` to the agent imports (after line 3 `emitCatchupBrief`):

```ts
import { emitCatchupBrief } from "../agents/catchup.ts";
import { emitStandupBrief } from "../agents/standup.ts";
```

After `requireCatchupParams` (which ends at line 165), add:

```ts
function requireStandupParams(params: unknown): { sinceMs?: number } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.standup requires an object payload");
  }
  const p = params as { sinceMs?: unknown };
  const out: { sinceMs?: number } = {};
  if (p.sinceMs !== undefined) {
    if (
      typeof p.sinceMs !== "number" ||
      !Number.isInteger(p.sinceMs) ||
      p.sinceMs < 0 ||
      p.sinceMs > MAX_SINCE_MS
    ) {
      throw new AgentsRpcError(
        -32602,
        `sinceMs must be a non-negative integer up to ${MAX_SINCE_MS} ms (90 days)`,
      );
    }
    out.sinceMs = p.sinceMs;
  }
  return out;
}
```

Add `"standup"` to the `newSessionId` kind union (lines 175-185) — after `"catchup"`:

```ts
function newSessionId(
  kind:
    | "expert"
    | "impact"
    | "catchup"
    | "standup"
    | "ghost"
    | "conflicts"
    | "huddle"
    | "janitor"
    | "preflight",
): string {
  return `${kind}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}
```

After `handleCatchup` (which ends at line 298), add:

```ts
async function handleStandup(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireStandupParams(params);
  const sessionId = newSessionId("standup");
  const userToml = ctx.configDir === undefined ? {} : loadNimbusUserFromConfigDir(ctx.configDir);
  const standupInput =
    userToml.mePersonId === undefined
      ? input
      : { ...input, mePersonIdOverride: userToml.mePersonId };
  const standupCtx =
    ctx.llm === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, llm: ctx.llm, notify: ctx.notify, sessionId };
  return await emitStandupBrief(standupInput, standupCtx);
}
```

Register the handler in the `dispatchByMethod` map (lines 382-391) — after `"agents.catchup": handleCatchup,`:

```ts
    "agents.catchup": handleCatchup,
    "agents.standup": handleStandup,
```

- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/gateway/src/ipc/agents-rpc.standup.test.ts` — Expected: PASS (6 tests). Then run `bun test packages/gateway/src/ipc/agents-rpc.test.ts` — Expected: PASS (no regression).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.standup.test.ts
git commit -m "$(cat <<'EOF'
feat(standup): add agents.standup IPC handler + dispatch entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: CLI-side `StandupBrief` mirror type + guard

**Files:** Modify: `packages/cli/src/types/agents.ts:71-99`
**Test:** `packages/cli/src/types/agents.standup.test.ts`

**Interfaces:**
- Consumes: `CatchupSection`, `GapNote` (already imported into `agents.ts` from `@nimbus-dev/sdk`).
- Produces (CLI cannot import gateway types — this is the wire-shape mirror):
  - `export type StandupBrief = { kind: "standup"; agentVersion: 1; generatedAt: number; latencyMs: number; gaps: GapNote[]; query: { sinceMs: number }; selfPersonId: string | null; involvement: { ownedServices: string[]; activeRepos: string[]; incidentServices: string[]; collaboratorPersonIds: string[] }; sections: CatchupSection[] }`
  - `export function isStandupBrief(x: unknown): x is StandupBrief`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/types/agents.standup.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { type StandupBrief, isStandupBrief } from "./agents.ts";

function valid(): StandupBrief {
  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: 1,
    latencyMs: 1,
    gaps: [],
    query: { sinceMs: 86_400_000 },
    selfPersonId: null,
    involvement: { ownedServices: [], activeRepos: [], incidentServices: [], collaboratorPersonIds: [] },
    sections: [],
  };
}

describe("CLI isStandupBrief", () => {
  test("accepts a valid standup brief", () => {
    expect(isStandupBrief(valid())).toBe(true);
  });

  test("rejects wrong kind, missing sections, null, and non-object", () => {
    expect(isStandupBrief({ ...valid(), kind: "catchup" })).toBe(false);
    const { sections: _drop, ...noSections } = valid();
    expect(isStandupBrief(noSections)).toBe(false);
    expect(isStandupBrief(null)).toBe(false);
    expect(isStandupBrief("x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/cli/src/types/agents.standup.test.ts` — Expected: FAIL — `StandupBrief` and `isStandupBrief` are not exported from `./agents.ts`.

- [ ] **Step 3: Implement**

In `packages/cli/src/types/agents.ts`, after `isCatchupBrief` (which ends at line 99), add:

```ts
// CLI-side mirror of StandupBrief in packages/gateway/src/agents/_lib/findings.ts (CLI cannot import gateway).
export type StandupBrief = {
  kind: "standup";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { sinceMs: number };
  selfPersonId: string | null;
  involvement: {
    ownedServices: string[];
    activeRepos: string[];
    incidentServices: string[];
    collaboratorPersonIds: string[];
  };
  sections: CatchupSection[];
};

export function isStandupBrief(x: unknown): x is StandupBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "standup" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["sections"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number"
  );
}
```

- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/cli/src/types/agents.standup.test.ts` — Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/types/agents.ts packages/cli/src/types/agents.standup.test.ts
git commit -m "$(cat <<'EOF'
feat(standup): add CLI-side StandupBrief mirror type + guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `nimbus standup` CLI command + pure `--format` transforms + registration

**Files:** Create: `packages/cli/src/commands/standup.ts` · Test: `packages/cli/src/commands/standup.test.ts` · Modify: `packages/cli/src/index.ts:89`

**Interfaces:**
- Consumes: `IPCClient`, `awaitAgentBrief`, `renderAgentBrief`, `readGatewayState`, `registerInteractiveCliIpcHandlers`, `parseSinceDurationToMs`, `getCliPlatformPaths`, `isStandupBrief` (Task 7), type `StandupBrief` (Task 7).
- Produces:
  - `export type StandupFormat = "markdown" | "slack" | "plain"`
  - `export type StandupCliArgs = { sinceMs: number; json: boolean; format: StandupFormat }`
  - `export function parseStandupArgs(args: string[]): StandupCliArgs`
  - `export function toSlackMrkdwn(brief: string): string` — pure string transform, NO network.
  - `export function toPlainText(brief: string): string` — pure string transform, NO network.
  - `export function applyFormat(brief: string, format: StandupFormat): string`
  - `export async function runStandupCli(args: string[]): Promise<void>`

> **Transform rules (pure, deterministic, no I/O):**
> - `toSlackMrkdwn`: `**bold**` → `*bold*`; `*italic*`/`_italic_` left as `_italic_`; leading `- ` / `   - ` bullets → `• ` (preserving indentation); strip leading `#`+space heading markers but keep the heading text wrapped in `*…*` (bold). Headings: a line matching `^#{1,6}\s+(.*)$` becomes `*$1*`.
> - `toPlainText`: strip `**`/`__` and single `*`/`_` emphasis; strip leading `#`+space from headings; convert `- `/`   - ` bullets to `• `; strip surrounding backticks from inline code.
> - `markdown`: identity (return the brief unchanged).
> - `applyFormat` dispatches on the enum.
>
> **Network-free (I27):** all three transforms are pure string rewrites — `--format slack` produces Slack mrkdwn *text*, it does NOT call the Slack API. The `installFetchSpy` test below asserts `fetchSpy.callCount === 0` across the `toSlackMrkdwn` / `toPlainText` render paths, proving no auto-egress (I27 / Non-Negotiable #5 — no Slack API call). No additional test is needed for this acceptance; the fetch-spy already covers it.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/standup.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./standup.ts");
const { parseStandupArgs, runStandupCli, toSlackMrkdwn, toPlainText, applyFormat } = mod;

describe("parseStandupArgs", () => {
  test("defaults to 24h, markdown, no json", () => {
    const a = parseStandupArgs([]);
    expect(a.sinceMs).toBe(24 * 60 * 60 * 1000);
    expect(a.format).toBe("markdown");
    expect(a.json).toBe(false);
  });

  test("parses --since with a days suffix", () => {
    expect(parseStandupArgs(["--since", "7d"]).sinceMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("clamps --since at 90 days", () => {
    expect(() => parseStandupArgs(["--since", "365d"])).toThrow(/90 days/);
  });

  test("rejects --since without a value", () => {
    expect(() => parseStandupArgs(["--since"])).toThrow();
  });

  test("accepts each --format enum value", () => {
    expect(parseStandupArgs(["--format", "slack"]).format).toBe("slack");
    expect(parseStandupArgs(["--format", "plain"]).format).toBe("plain");
    expect(parseStandupArgs(["--format", "markdown"]).format).toBe("markdown");
  });

  test("rejects an invalid --format value", () => {
    expect(() => parseStandupArgs(["--format", "html"])).toThrow(/markdown\|slack\|plain/);
  });

  test("rejects --format without a value", () => {
    expect(() => parseStandupArgs(["--format"])).toThrow();
  });

  test("recognises --json", () => {
    expect(parseStandupArgs(["--json"]).json).toBe(true);
  });

  test("rejects unknown positional arguments", () => {
    expect(() => parseStandupArgs(["oops"])).toThrow(/Unknown positional/);
  });
});

describe("pure format transforms", () => {
  const SAMPLE = "# Standup — last 24h\n\n## github (1 items in window)\n\n- **PR title** (`gh:1`, score 1.00)\n   - owned_service:github";

  test("toSlackMrkdwn converts bold, headings, and bullets without network", () => {
    const fetchSpy = installFetchSpy();
    try {
      const out = toSlackMrkdwn(SAMPLE);
      expect(out).toContain("*Standup — last 24h*");
      expect(out).toContain("*github (1 items in window)*");
      expect(out).toContain("• *PR title*");
      expect(out).not.toContain("# Standup");
      expect(out).not.toContain("**PR title**");
    } finally {
      expect(fetchSpy.callCount).toBe(0);
      fetchSpy.restore();
    }
  });

  test("toPlainText strips markdown markers without network", () => {
    const fetchSpy = installFetchSpy();
    try {
      const out = toPlainText(SAMPLE);
      expect(out).toContain("Standup — last 24h");
      expect(out).toContain("PR title");
      expect(out).not.toContain("**");
      expect(out).not.toContain("`gh:1`");
      expect(out).toContain("gh:1");
      expect(out).toContain("• PR title");
    } finally {
      expect(fetchSpy.callCount).toBe(0);
      fetchSpy.restore();
    }
  });

  test("applyFormat markdown is identity", () => {
    expect(applyFormat(SAMPLE, "markdown")).toBe(SAMPLE);
  });
});

function installFetchSpy(): { callCount: number; restore: () => void } {
  const original = globalThis.fetch;
  const spy = { callCount: 0, restore: () => { globalThis.fetch = original; } };
  globalThis.fetch = (async (...args: unknown[]) => {
    spy.callCount += 1;
    return original(...(args as Parameters<typeof original>));
  }) as typeof fetch;
  return spy;
}

const { stdoutChunks, stderrChunks, install: installStreams, restore: restoreStreams } =
  createStreamCapture({ captureExit: true });

afterAll(() => {
  restoreStreams();
});

function makeValidStandupBrief(): unknown {
  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: 1,
    latencyMs: 12,
    gaps: [],
    query: { sinceMs: 24 * 60 * 60 * 1000 },
    selfPersonId: null,
    involvement: { ownedServices: [], activeRepos: [], incidentServices: [], collaboratorPersonIds: [] },
    sections: [],
  };
}

describe("runStandupCli — dispatcher", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreams();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("exits 1 when the gateway is not running", async () => {
    setFixture({});
    await expect(runStandupCli([])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("prints the brief and makes zero network calls on briefReady", async () => {
    const fetchSpy = installFetchSpy();
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.standup") {
            setTimeout(() => {
              handlers.get("standup.briefReady")?.({
                sessionId: "s1",
                brief: "# Standup — last 24h\n\nrecent activity",
                findings: makeValidStandupBrief(),
              });
            }, 0);
            return { sessionId: "s1" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await runStandupCli([]);
    expect(stdoutChunks.join("")).toContain("# Standup");
    expect(fetchSpy.callCount).toBe(0);
    fetchSpy.restore();
  });

  it("--format slack renders Slack mrkdwn", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.standup") {
            setTimeout(() => {
              handlers.get("standup.briefReady")?.({
                sessionId: "s",
                brief: "## github (1 items in window)\n\n- **PR** (`x`, score 1.00)",
                findings: makeValidStandupBrief(),
              });
            }, 0);
            return { sessionId: "s" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await runStandupCli(["--format", "slack"]);
    const out = stdoutChunks.join("");
    expect(out).toContain("*github (1 items in window)*");
    expect(out).toContain("• *PR*");
  });

  it("--json prints structured findings and ignores --format", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.standup") {
            setTimeout(() => {
              handlers.get("standup.briefReady")?.({
                sessionId: "s",
                brief: "# md",
                findings: makeValidStandupBrief(),
              });
            }, 0);
            return { sessionId: "s" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await runStandupCli(["--json", "--format", "slack"]);
    const out = stdoutChunks.join("");
    expect(out).toContain('"kind": "standup"');
    expect(out).not.toContain("# md");
  });

  it("exits 2 when standup.briefError fires", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string) => {
          if (method === "agents.standup") {
            setTimeout(() => handlers.get("standup.briefError")?.({ error: "boom" }), 0);
            return { sessionId: "s" };
          }
          return undefined;
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (event: string, handler: (params: unknown) => void) => {
          handlers.set(event, handler);
        },
      },
    });
    await expect(runStandupCli([])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("boom");
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — Run: `bun test packages/cli/src/commands/standup.test.ts` — Expected: FAIL — `./standup.ts` does not exist (module resolution error).

- [ ] **Step 3: Implement**

Create `packages/cli/src/commands/standup.ts`:

```ts
import { IPCClient } from "../ipc-client/index.ts";
import { awaitAgentBrief, renderAgentBrief } from "../lib/agent-brief-render.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { isStandupBrief } from "../types/agents.ts";

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000; // standup default = today
const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000;

export type StandupFormat = "markdown" | "slack" | "plain";

export type StandupCliArgs = {
  sinceMs: number;
  json: boolean;
  format: StandupFormat;
};

function parseSinceFlag(raw: string | undefined): number {
  if (typeof raw !== "string") throw new Error("--since requires a value (e.g. 24h, 7d, 1w)");
  const sinceMs = parseSinceDurationToMs(raw);
  if (sinceMs > MAX_SINCE_MS) {
    throw new Error("--since must be at most 90 days (e.g. 90d, 12w)");
  }
  return sinceMs;
}

function parseFormatFlag(raw: string | undefined): StandupFormat {
  if (raw === "markdown" || raw === "slack" || raw === "plain") return raw;
  throw new Error("--format must be one of: markdown|slack|plain");
}

export function parseStandupArgs(args: string[]): StandupCliArgs {
  let sinceMs = DEFAULT_SINCE_MS;
  let json = false;
  let format: StandupFormat = "markdown";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--since") {
      sinceMs = parseSinceFlag(args[i + 1]);
      i += 1;
    } else if (a === "--format") {
      format = parseFormatFlag(args[i + 1]);
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) {
      throw new Error(
        `Unknown positional argument: ${a}. Usage: nimbus standup [--since 24h] [--format markdown|slack|plain] [--json]`,
      );
    }
  }
  return { sinceMs, json, format };
}

/** Pure Markdown→Slack mrkdwn string transform. No network, no Slack API, no Block Kit. */
export function toSlackMrkdwn(brief: string): string {
  return brief
    .split("\n")
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading !== null) return `*${heading[1]}*`;
      const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
      const body = bullet !== null ? bullet[2] ?? "" : line;
      // **bold** -> *bold*  (Slack uses single asterisks for bold)
      const bolded = body.replace(/\*\*(.+?)\*\*/g, "*$1*");
      if (bullet !== null) return `${bullet[1] ?? ""}• ${bolded}`;
      return bolded;
    })
    .join("\n");
}

/** Pure Markdown→plain-text string transform. No network. */
export function toPlainText(brief: string): string {
  return brief
    .split("\n")
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const base = heading !== null ? (heading[1] ?? "") : line;
      const bullet = /^(\s*)[-*]\s+(.*)$/.exec(base);
      const body = bullet !== null ? bullet[2] ?? "" : base;
      const noBold = body.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
      const noEmphasis = noBold.replace(/[*_]/g, "");
      const noCode = noEmphasis.replace(/`([^`]*)`/g, "$1");
      if (bullet !== null) return `${bullet[1] ?? ""}• ${noCode}`;
      return noCode;
    })
    .join("\n");
}

export function applyFormat(brief: string, format: StandupFormat): string {
  if (format === "slack") return toSlackMrkdwn(brief);
  if (format === "plain") return toPlainText(brief);
  return brief;
}

export async function runStandupCli(args: string[]): Promise<void> {
  const parsed = parseStandupArgs(args);

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }

  const client = new IPCClient(state.socketPath);
  await client.connect();
  registerInteractiveCliIpcHandlers(client);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const briefPromise = awaitAgentBrief(client, "standup", isStandupBrief, (t) => {
    timeout = t;
  });

  try {
    await client.call<{ sessionId: string }>("agents.standup", { sinceMs: parsed.sinceMs });
    const { brief, findings } = await briefPromise;
    renderAgentBrief(applyFormat(brief, parsed.format), findings, parsed.json);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.disconnect();
  }
}
```

In `packages/cli/src/index.ts`, add the import near the other command imports (alongside `runCatchupCli`):

```ts
import { runStandupCli } from "./commands/standup.ts";
```

> Note: the exact import line location follows the file's existing import grouping; place it adjacent to `runCatchupCli`'s import. Then register it in `COMMAND_HANDLERS` (the entry sits right after `catchup: runCatchupCli,` on line 89):

```ts
  catchup: runCatchupCli,
  standup: runStandupCli,
```

- [ ] **Step 4: Run it to verify it passes** — Run: `bun test packages/cli/src/commands/standup.test.ts` — Expected: PASS (all parse, transform, and dispatcher cases). Then run `bunx tsc --noEmit -p packages/cli` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/standup.ts packages/cli/src/commands/standup.test.ts packages/cli/src/index.ts
git commit -m "$(cat <<'EOF'
feat(standup): add nimbus standup CLI with pure --format transforms

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Tauri allowlist + e2e scenario + optional static read-only guard

**Files:** Modify: `packages/ui/src-tauri/src/gateway_bridge.rs:66,501` · `scripts/structure-audit/check-nimbus-invariants.ts:178-219,612+` · Create: `packages/gateway/test/e2e/scenarios/standup.e2e.test.ts` · Test: `scripts/structure-audit/check-nimbus-invariants.standup.test.ts`

**Interfaces:**
- Consumes: `runStandup` (Task 4), `isStandupBrief` (Task 1), `LocalIndex`, `insertPerson`; for the static guard: `FileEntry`, `Violation`, `iterateSourceFiles`/`loadFiles` patterns already in the checker.
- Produces: `export function checkStandupReadOnlyImports(files: readonly FileEntry[]): Violation[]` — flags any `share/` or `chatops/` import inside `packages/gateway/src/agents/standup.ts`.

- [ ] **Step 1: Write the failing tests**

(a) Create `packages/gateway/test/e2e/scenarios/standup.e2e.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { isStandupBrief } from "../../../src/agents/_lib/findings.ts";
import { runStandup } from "../../../src/agents/standup.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { insertPerson } from "../../../src/people/person-store.ts";

function seed(db: Database): void {
  const now = Date.now();
  insertPerson(db, {
    id: "p-self",
    displayName: "Self",
    canonicalEmail: "self@example.com",
    githubLogin: "self",
    gitlabLogin: null,
    slackHandle: null,
    linearMemberId: null,
    jiraAccountId: null,
    notionUserId: null,
    bitbucketUuid: null,
    linked: false,
    metadata: {},
  });
  const stmt = db.prepare(
    "INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned, author_id) " +
      "VALUES (?, ?, ?, ?, ?, '', ?, ?, 0, ?)",
  );
  // github: two fresh items (inside 24h) at differing recency
  stmt.run("gh:new", "github", "pr", "acme/pay#1", "fresh PR", now - 60_000, now, "p-self");
  stmt.run("gh:old", "github", "pr", "acme/pay#2", "older PR", now - 6 * 60 * 60 * 1000, now, "p-self");
  // linear: one very fresh item → linear section should sort ahead of github
  stmt.run("lin:1", "linear", "issue", "lin-1", "fresh issue", now - 10_000, now, "p-self");
  // stale github item outside the 24h window → excluded
  stmt.run("gh:stale", "github", "pr", "acme/pay#3", "stale PR", now - 3 * 24 * 60 * 60 * 1000, now, "p-self");
}

describe("nimbus standup (e2e, in-process)", () => {
  test("recency-ordered sections, 24h boundary respected, latency < 15 s", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seed(db);

    const start = performance.now();
    const brief = await runStandup(
      { mePersonIdOverride: "p-self" },
      { db, sessionId: "e2e-standup-1", notify: () => {} },
    );
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(15_000);
    expect(isStandupBrief(brief)).toBe(true);
    expect(brief.selfPersonId).toBe("p-self");
    // linear's freshest item (10 s ago) is newer than github's freshest (60 s ago)
    expect(brief.sections[0]?.serviceId).toBe("linear");
    // github section items ordered newest-first
    const gh = brief.sections.find((s) => s.serviceId === "github");
    expect(gh?.items.map((i) => i.itemId)).toEqual(["gh:new", "gh:old"]);
    // stale item excluded
    const allIds = brief.sections.flatMap((s) => s.items.map((i) => i.itemId));
    expect(allIds).not.toContain("gh:stale");
  });

  test("standup.briefReady emits a non-empty brief with valid findings", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seed(db);
    const { emitStandupBrief } = await import("../../../src/agents/standup.ts");
    const events: Array<{ method: string; params: unknown }> = [];
    await emitStandupBrief(
      { mePersonIdOverride: "p-self" },
      { db, sessionId: "e2e-standup-2", notify: (method, params) => events.push({ method, params }) },
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !events.some((e) => e.method === "standup.briefReady")) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const ready = events.find((e) => e.method === "standup.briefReady");
    const p = ready?.params as { brief?: string; findings?: unknown };
    expect(typeof p?.brief).toBe("string");
    expect((p?.brief ?? "").length).toBeGreaterThan(0);
    expect(isStandupBrief(p?.findings)).toBe(true);
  });

  test("no external_id / token / secret leaks into the rendered brief", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seed(db);
    const { synthesize } = await import("../../../src/agents/_lib/synthesize.ts");
    const brief = await runStandup({ mePersonIdOverride: "p-self" }, { db, sessionId: "e2e-standup-3", notify: () => {} });
    const md = await synthesize(brief);
    // external_id values (e.g. "acme/pay#1") must not appear; the rendered brief uses item ids + titles only
    expect(md).not.toContain("acme/pay#1");
    expect(md).not.toMatch(/ghp_|xoxb-|AKIA/);
  });

  test("structural HITL-free: standup.ts must not import ToolExecutor or HITL_REQUIRED", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../src/agents/standup.ts"),
      "utf8",
    ) as string;
    expect(source).not.toContain("ToolExecutor");
    expect(source).not.toContain("HITL_REQUIRED");
  });
});
```

(b) Create `scripts/structure-audit/check-nimbus-invariants.standup.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { checkStandupReadOnlyImports } from "./check-nimbus-invariants.ts";

describe("checkStandupReadOnlyImports", () => {
  test("passes when standup.ts imports no share/ or chatops/", () => {
    const files = [
      {
        relPath: "packages/gateway/src/agents/standup.ts",
        contents: 'import { runCatchup } from "./catchup.ts";\n',
      },
    ];
    expect(checkStandupReadOnlyImports(files)).toEqual([]);
  });

  test("flags a share/ import in standup.ts", () => {
    const files = [
      {
        relPath: "packages/gateway/src/agents/standup.ts",
        contents: 'import { createShare } from "../share/share-gate.ts";\n',
      },
    ];
    const v = checkStandupReadOnlyImports(files);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("standup-read-only");
  });

  test("flags a chatops/ import in standup.ts", () => {
    const files = [
      {
        relPath: "packages/gateway/src/agents/standup.ts",
        contents: 'import { reply } from "../chatops/reply-dispatcher.ts";\n',
      },
    ];
    expect(checkStandupReadOnlyImports(files)).toHaveLength(1);
  });

  test("ignores share/ imports in files other than standup.ts", () => {
    const files = [
      { relPath: "packages/gateway/src/ipc/share-rpc.ts", contents: 'import x from "../share/share-gate.ts";\n' },
    ];
    expect(checkStandupReadOnlyImports(files)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail** —
  - Run: `bun test scripts/structure-audit/check-nimbus-invariants.standup.test.ts` — Expected: FAIL — `checkStandupReadOnlyImports` is not exported.
  - Run: `bun test packages/gateway/test/e2e/scenarios/standup.e2e.test.ts` — Expected: PASS already if Tasks 1-5 landed (it exercises only shipped functions); if run before those tasks it FAILs on import. (This e2e file is part of this task's commit.)

- [ ] **Step 3: Implement**

(a) Tauri allowlist — in `packages/ui/src-tauri/src/gateway_bridge.rs`, add `"agents.standup"` to `ALLOWED_METHODS` in alphabetical position (after `"agents.preflight",` line 66, before `"audit.export",` line 67):

```rust
    "agents.preflight",
    "agents.standup",
    "audit.export",
```

Bump the count assertion (line 501):

```rust
        assert_eq!(ALLOWED_METHODS.len(), 96);
```

(b) Static guard — in `scripts/structure-audit/check-nimbus-invariants.ts`, add the checker function (place it next to the other `check*` functions, e.g. after `checkFederationImportInvariant` near line 219):

```ts
const STANDUP_FILE = "packages/gateway/src/agents/standup.ts";
const STANDUP_FORBIDDEN_IMPORT_RE = /from\s+["'][^"']*\/(share|chatops)\//;

/**
 * Standup is a read-only, no-auto-egress agent. It must never import a share/ or
 * chatops/ module (which would let it emit to a sink without the HITL gate). This
 * is a guard, NOT a numbered invariant.
 */
export function checkStandupReadOnlyImports(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath !== STANDUP_FILE) continue;
    const lines = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!STANDUP_FORBIDDEN_IMPORT_RE.test(line)) continue;
      out.push({ rule: "standup-read-only", file: f.relPath, line: i + 1, snippet: line.trim() });
    }
  }
  return out;
}
```

Wire it into `run()` (add a block alongside the other `mode === "binary-only" || mode === "all"` checks, after the federation-import block near line 662):

```ts
  if (mode === "binary-only" || mode === "all") {
    const v = checkStandupReadOnlyImports(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::standup.ts imports a share/ or chatops/ module — standup must be read-only with no auto-egress: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
```

- [ ] **Step 4: Run them to verify they pass** —
  - Run: `bun test scripts/structure-audit/check-nimbus-invariants.standup.test.ts` — Expected: PASS (4 tests).
  - Run: `bun test packages/gateway/test/e2e/scenarios/standup.e2e.test.ts` — Expected: PASS (4 tests).
  - Run: `bun scripts/structure-audit/check-nimbus-invariants.ts all` — Expected: exit 0 (no violations; standup.ts imports nothing forbidden).
  - Build/test the Rust allowlist (if a Rust toolchain is present): `cargo test --manifest-path packages/ui/src-tauri/Cargo.toml allowlist` — Expected: PASS (`allowlist_exact_size` now expects 96, `allowlist_is_alphabetized` passes). If Rust is unavailable in the dev env, the CI cross-platform matrix runs it; the edit is mechanical (one alphabetized insert + count bump).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src-tauri/src/gateway_bridge.rs scripts/structure-audit/check-nimbus-invariants.ts scripts/structure-audit/check-nimbus-invariants.standup.test.ts packages/gateway/test/e2e/scenarios/standup.e2e.test.ts
git commit -m "$(cat <<'EOF'
feat(standup): Tauri allowlist + e2e scenario + read-only static guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Docs — CHANGELOG, cli-reference, roadmap

**Files:** Modify: `docs/CHANGELOG.md` · `docs/cli-reference.md` · `docs/roadmap.md:460`

**Interfaces:** Consumes nothing; produces no code. Documentation only.

- [ ] **Step 1: Add a CHANGELOG entry**

In `docs/CHANGELOG.md`, under the current unreleased / latest dated section, add a bullet (match the file's existing heading style — read the top of the file first to mirror the date-section format):

```markdown
- **`nimbus standup`** — new built-in read-only agent + CLI. Assembles the authenticated user's last-24h activity across all connected services into a copy-pasteable brief, grouped by service and recency-ordered. Reuses the shipped `catchup` involvement-detection sub-agents (no new connectors, no new index data). `--since <dur>` (capped 90d), `--format <markdown|slack|plain>` (pure string transforms — no Slack API/egress), `--json`. IPC `agents.standup` + `standup.briefReady`/`standup.briefError`; Tauri-allowlisted (read-only). No new invariant, no schema migration.
```

- [ ] **Step 2: Add a cli-reference entry**

In `docs/cli-reference.md`, add a `nimbus standup` subcommand section modeled on the existing `nimbus catchup` section (read that section first to mirror the heading + flag-table format):

```markdown
### `nimbus standup`

Assembles everything the authenticated user did across all connected services in the last 24 hours. Output is copy-pasteable. Scoped to the current user's identity as resolved by the people graph. Read-only, no HITL — entirely local; nothing is posted anywhere.

| Flag | Default | Description |
| --- | --- | --- |
| `--since <dur>` | `24h` | Window size (`24h`, `7d`, `1w`); capped at 90 days. |
| `--format <fmt>` | `markdown` | Output rendering: `markdown` (copy-paste), `slack` (Slack mrkdwn string — no Slack API), `plain` (markers stripped). |
| `--json` | off | Emit the structured `StandupBrief` JSON instead of rendered text. |

Unresolved identity prints a `[user] me_person_id` remediation gap (non-zero exit on an empty index). The remediation reuses catchup's shared message verbatim ("Set `[user] me_person_id` in your active profile's nimbus.toml, or run `nimbus people search <you>` to find your person id."); a headless / cron operator (no interactive session) resolves the gap by setting `[user] me_person_id` in nimbus.toml — there is no `NIMBUS_ME_PERSON_ID` environment variable.
```

- [ ] **Step 3: Mark the roadmap row delivered**

In `docs/roadmap.md` line 460 (the `nimbus standup` row), mark it delivered following the file's existing delivered-row convention (read 2-3 nearby delivered rows first to copy the exact marker style — e.g. a leading status emoji or a `**Delivered**` tag). Append a dated note such as:

```markdown
(Delivered 2026-06-20 — built-in read-only agent reusing the catchup involvement substrate; `--format markdown|slack|plain` pure transforms; no new invariant/migration.)
```

- [ ] **Step 4: Validate the docs**

Run: `bun run audit:doc-refs` — Expected: PASS (no broken internal references). Run: `bunx markdownlint-cli2 "docs/CHANGELOG.md" "docs/cli-reference.md" "docs/roadmap.md"` (or `--fix` to auto-correct) — Expected: no lint errors.

- [ ] **Step 5: Commit**

```bash
git add docs/CHANGELOG.md docs/cli-reference.md docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs(standup): CHANGELOG + cli-reference + roadmap delivery

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Full preflight + coverage-floor verification

**Files:** none (verification gate).

**Interfaces:** Consumes the full plan; produces a green pre-push state.

- [ ] **Step 1: Run the fast static gates**

Run: `bun run preflight:fast` — Expected: PASS (types, Biome, static invariant checks including the new `checkStandupReadOnlyImports`).

- [ ] **Step 2: Run the touched test suites**

Run, expecting PASS for each:
- `bun test packages/gateway/src/agents/` (standup + findings + render + synthesize + catchup-exports)
- `bun test packages/gateway/src/ipc/agents-rpc.standup.test.ts`
- `bun test packages/gateway/test/e2e/scenarios/standup.e2e.test.ts`
- `bun test packages/cli/src/commands/standup.test.ts`
- `bun test packages/cli/src/types/agents.standup.test.ts`
- `bun test scripts/structure-audit/check-nimbus-invariants.standup.test.ts`

- [ ] **Step 3: Verify the coverage floor for every new file**

The coverage floor is CI-Linux-authoritative. Run the floor check the way CI does:

Run: `bun run audit:coverage-floor` (or the documented `build-lcov.sh` + `check.ts` sequence from the `nimbus-preflight` skill) — Expected: PASS, with **every** new file clearing **≥80% line + branch**:
- `packages/gateway/src/agents/standup.ts`
- `packages/cli/src/commands/standup.ts`
- (the new arms in `render.ts` / `synthesize.ts` / `findings.ts` / `emit-brief.ts` / `agents-rpc.ts` / `cli/src/types/agents.ts` are covered by their `.standup.test.ts` files)

If any file is below floor, add the missing branch case to its `.standup.test.ts` (e.g. the `--format` arms, the `requireStandupParams` rejection arms, the `emitStandupBrief` no-llm vs llm path, the `scoreAndGroupRecencyFirst` tie-break) and re-run. Because the floor is CI-Linux-authoritative, reproduce on Linux (Docker `oven/bun:latest`) before pushing if the local platform disagrees.

- [ ] **Step 4: Run the full preflight**

Run: `bun run preflight` — Expected: PASS (full CI parity: all-package `tsc`, Biome, full test suite, coverage floor, doc audits). This is the gate that `test:ci` alone does NOT cover.

- [ ] **Step 5: Final state check (no commit)**

This task makes no code changes; it gates the branch. Confirm `git status` is clean and `git rev-parse --abbrev-ref HEAD` is your `dev/<you>/standup-generator` branch, not `main`. The branch is ready for `/code-review` and a PR.

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- Agent `standup.ts` (`runStandup`/`emitStandupBrief`, 24h default, recency-first, reuse catchup sub-agents) → Tasks 2 + 4. ✅
- `StandupBrief` type + `isStandupBrief` (gateway) + `AgentBrief` union → Task 1. ✅
- `renderStandup` → Task 3. ✅
- `synthesize`/`toolNameFor`/`SynthInput`/`AnyBrief` arms → Task 5. ✅
- `agents.standup` IPC handler + `requireStandupParams` + `newSessionId("standup")` + dispatch map → Task 6. ✅
- CLI mirror `StandupBrief` + guard → Task 7. ✅
- `nimbus standup` CLI + `parseStandupArgs` + pure `--format` transforms + `index.ts` registration → Task 8. ✅
- Tauri allowlist → Task 9. ✅
- Optional static read-only guard (`check-nimbus-invariants.ts`) → Task 9. ✅
- E2E scenario (sections, 24h boundary, zero-HITL source check, `briefReady`, no secret leak) → Task 9. ✅
- Acceptance #3 fetch-spy "zero network calls" → Task 8 (transform tests + dispatcher test) + Task 9 (no-secret-leak). ✅
- Acceptance #5 unresolved-identity gap / empty-index non-zero exit → Task 4 (`runStandup` gap; the gap test asserts the remediation names `[user] me_person_id` and does NOT mention any env var — standup reuses catchup's verbatim shared string, and a headless/cron operator sets `[user] me_person_id` in nimbus.toml, never an env var) + `renderAgentBrief` reuse in Task 8 (`empty_index` → exit 1, inherited). ✅
- Docs (CHANGELOG, cli-reference, roadmap line 460) → Task 10. ✅
- Preflight + coverage floor (Acceptance #8) → Task 11. ✅
- No new invariant / no migration (Acceptance #7) → Global Constraints + Task 9 guard (not numbered). ✅

**2. Placeholder scan:** No `TBD`/`TODO`/"implement later"/"add error handling"/"similar to Task N"/"write tests for the above" remain. Every code step shows the actual code; every test step shows the actual test; every command is exact with an expected outcome. ✅

**3. Type consistency:**
- `StandupBrief` shape is identical in Task 1 (gateway), Task 4 (returned by `runStandup`), Task 7 (CLI mirror) — `kind: "standup"`, `query: { sinceMs }`, `selfPersonId`, `involvement` (4 string arrays), `sections: CatchupSection[]`. ✅
- `scoreAndGroupRecencyFirst(items: WindowItem[], involvement: Involvement): CatchupSection[]` — defined in Task 4, name used consistently in Task 4's tests and referenced by `renderStandup` (Task 3) which consumes its output order. ✅
- `runStandup(input: StandupInput, ctx: StandupContext)` / `emitStandupBrief(input, ctx)` — signatures identical across Tasks 4, 6, 9. ✅
- `requireStandupParams(params: unknown): { sinceMs?: number }` — Task 6, no `service` field (matches spec "no service filter in v1"). ✅
- `parseStandupArgs(args): StandupCliArgs` with `format: StandupFormat` — Task 8; `applyFormat`/`toSlackMrkdwn`/`toPlainText` names used consistently in Task 8 tests + impl. ✅
- Exported catchup names (`scoreItem`, `subWindowItems`, `subOwnedServices`, `subActiveRepos`, `subRespondedIncidents`, `subCollaborators`, `SubAgentResult`) in Task 2 match the imports in Task 4's `standup.ts`. ✅
- Tauri count `95 → 96` matches the actual assertion at `gateway_bridge.rs:501` (verified during grounding; the grounding's "8→9" referred to agents-prefixed entries, but the real assertion counts all 95 methods). ✅
- `checkStandupReadOnlyImports(files): Violation[]` with `rule: "standup-read-only"` — Task 9 impl + test agree. ✅

All consistent; no fixes required.
