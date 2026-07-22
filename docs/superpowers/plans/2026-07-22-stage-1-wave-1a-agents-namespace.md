# Stage 1 Wave 1a — `agents.*` in `@nimbus-dev/client` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all eight `agents.*` gateway methods reachable from `@nimbus-dev/client` with typed params, typed briefs, and a subscription wrapper that resolves on `briefReady` and rejects on `briefError`.

**Architecture:** Three sequenced PRs across three repos. `nimbus-sdk@1.5.0` becomes the single home for the eight composed brief types and their guards (today duplicated in gateway and CLI). Nimbus de-duplicates onto it. `nimbus-client@0.7.0` then adds a name-generic `subscribeAgentBrief` primitive plus eight promise methods built on it, gated by a conformance fixture generated from real gateway code.

**Tech Stack:** TypeScript 6.x strict, Bun v1.2+, Biome, `bun test`, npm publish for the two libraries.

**Design spec:** [`../specs/2026-07-22-stage-1-wave-1a-agents-namespace-design.md`](../specs/2026-07-22-stage-1-wave-1a-agents-namespace-design.md)

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict mode, non-negotiable.
- **License direction is one-way:** `nimbus-sdk` and `nimbus-client` are MIT; Nimbus is AGPL-3.0. Shared types move **into** the SDK, never out of the gateway into a client.
- **`nimbus-sdk` is dep-free** on its published surface. Add no runtime dependencies.
- **SDK bump is 1.5.0** (minor, purely additive). **Client bump is 0.7.0** (minor).
- **Never commit on `main`.** Every commit lands on a `dev/asafgolombek/<topic>` branch inside a git worktree.
- **`kind` is not the agent name.** `conflicts` emits `kind: "conflict"`. Always read the mapping from `AGENT_KIND`, never derive it from a string.
- **All eight gateway guards use `requireQuery: true`.** The SDK exports that strict variant.
- Nimbus verification is `bun run preflight:fast` after any code change; scoped `bun test <path>` when logic or tests are touched.

---

## File Structure

**`nimbus-sdk`**

- Create `src/agents/brief-composites.ts` — the 8 composed brief types, supporting types, `AgentBrief`, `BriefReadyPayload`, `BriefFor`.
- Create `src/agents/agent-names.ts` — `AGENT_NAMES`, `AgentName`, `AGENT_KIND`.
- Create `src/agents/brief-guards.ts` — the 8 concrete guards.
- Create `src/agents/brief-guards.test.ts`, `src/agents/agent-names.test.ts`.
- Modify `src/index.ts` — re-export all of the above.

**`Nimbus`**

- Modify `packages/gateway/src/agents/_lib/findings.ts` — delete local definitions, re-export from SDK.
- Modify `packages/gateway/src/federation/types.ts` — re-export `ExpertiseRank` from SDK.
- Modify `packages/cli/src/types/agents.ts` — delete local definitions, re-export from SDK.
- Modify `packages/gateway/package.json`, `packages/cli/package.json` — SDK `^1.5.0`.
- Create `scripts/gen-agent-brief-fixtures.ts` — dumps real `briefReady` payloads to JSON.

**`nimbus-client`**

- Create `src/agents.ts` — param types, `AgentBriefEvent`, `subscribeAgentBrief` wiring helpers, `BRIEF_GUARDS`, errors.
- Create `test/agents.test.ts`, `test/agents-conformance.test.ts`.
- Create `test/fixtures/agent-briefs.json` — generated, never hand-edited.
- Modify `src/nimbus-client.ts` — interface + 8 methods + `subscribeAgentBrief` + `runAgent`.
- Modify `src/validate.ts` — `validateAgentSession`.
- Modify `src/mock-client.ts` — parity stubs.
- Modify `src/index.ts`, `test/fixtures/README.md`, `package.json`.

---

## Phase 1 — `nimbus-sdk` 1.5.0

Worktree: `cd /c/gitrep/nimbus-sdk && git worktree add .worktrees/agents-briefs -b dev/asafgolombek/promote-agent-briefs main`

### Task 1: Promote the composed brief types

**Files:**

- Create: `src/agents/brief-composites.ts`
- Create: `src/agents/agent-names.ts`
- Modify: `src/index.ts`
- Test: `src/agents/agent-names.test.ts`

**Interfaces:**

- Consumes: existing `AgentBriefBase`, `CatchupSection`, `ConflictType`, `ExpertFinding`, `ImpactFinding`, `JanitorPeerTouch`, `PreflightDownstream`, `GapNote` from `./brief-types.ts`.
- Produces: `ExpertBrief`, `ImpactBrief`, `CatchupBrief`, `GhostBrief`, `ConflictBrief`, `HuddleBrief`, `JanitorBrief`, `PreflightBrief`, `AgentBrief`, `BriefReadyPayload<B>`, `BriefFor<A>`, `ExpertiseRank`, `ImpactCategory`, `FederatedItemLite`, `GhostFinding`, `ConflictFinding`, `HuddleContribution`, `AGENT_NAMES`, `AgentName`, `AGENT_KIND`.

- [ ] **Step 1: Write the failing test**

Create `src/agents/agent-names.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_KIND, AGENT_NAMES } from "./agent-names.ts";

describe("agent names", () => {
  test("all eight agents are listed", () => {
    expect([...AGENT_NAMES]).toEqual([
      "expert", "impact", "catchup", "ghost",
      "conflicts", "huddle", "janitor", "preflight",
    ]);
  });

  test("conflicts emits the singular kind — the one name that is not its agent", () => {
    expect(AGENT_KIND.conflicts).toBe("conflict");
  });

  test("every other agent's kind equals its name", () => {
    for (const name of AGENT_NAMES) {
      if (name === "conflicts") continue;
      expect(AGENT_KIND[name]).toBe(name);
    }
  });
});

```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/agents/agent-names.test.ts`
Expected: FAIL — `Cannot find module './agent-names.ts'`

- [ ] **Step 3: Create `src/agents/agent-names.ts`**

```ts
/** The eight built-in read-only agents exposed over `agents.*` IPC. */
export const AGENT_NAMES = [
  "expert", "impact", "catchup", "ghost",
  "conflicts", "huddle", "janitor", "preflight",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

/**

 * Agent name → the `kind` discriminant its brief carries.

 *

 * These are NOT interchangeable: the `conflicts` agent emits `kind: "conflict"`
 * (singular). Deriving one from the other rejects every valid conflicts brief.

 */
export const AGENT_KIND = {
  expert: "expert",
  impact: "impact",
  catchup: "catchup",
  ghost: "ghost",
  conflicts: "conflict",
  huddle: "huddle",
  janitor: "janitor",
  preflight: "preflight",
} as const satisfies Record<AgentName, string>;

```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/agents/agent-names.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Create `src/agents/brief-composites.ts`**

Copied verbatim from `packages/gateway/src/agents/_lib/findings.ts:29-148`, with `ExpertiseRank` inlined here rather than imported from the gateway's `federation/types.ts`:

```ts
import type {
  AgentBriefBase,
  CatchupSection,
  ConflictType,
  ExpertFinding,
  ImpactFinding,
  JanitorPeerTouch,
  PreflightDownstream,
} from "./brief-types.ts";
import type { AgentName } from "./agent-names.ts";

/** Expertise confidence band. Mirrored by the gateway's federation layer. */
export type ExpertiseRank = "high" | "medium" | "low" | "none";

export type ImpactCategory =
  | "service" | "pipeline" | "dashboard" | "oncall_rotation" | "downstream_repo";

/** A leak-proof projection of a federated item (no metadata). */
export type FederatedItemLite = {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
};

export type GhostFinding = {
  peerId: string;
  expert: string | null;
  rank: ExpertiseRank;
  context: FederatedItemLite[];
  suggestedContact: string;
};

export type ConflictFinding = {
  peerId: string;
  who: string | null;
  service: string;
  collisionType: ConflictType;
  title: string;
  snippet: string;
  modifiedAt: number;
};

export type HuddleContribution = {
  peerId: string;
  who: string | null;
  prs: FederatedItemLite[];
  tickets: FederatedItemLite[];
  incidents: FederatedItemLite[];
};

export type ExpertBrief = AgentBriefBase & {
  kind: "expert";
  query: { topicOrFile: string };
  ranked: ExpertFinding[];
};

export type ImpactBrief = AgentBriefBase & {
  kind: "impact";
  query: { fileOrPrUrl: string };
  startEntityId: string | null;
  affected: ImpactFinding[];
};

export type CatchupBrief = AgentBriefBase & {
  kind: "catchup";
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

export type GhostBrief = AgentBriefBase & {
  kind: "ghost";
  query: { file: string };
  startEntityId: string | null;
  findings: GhostFinding[];
};

export type ConflictBrief = AgentBriefBase & {
  kind: "conflict";
  query: { file: string };
  startEntityId: string | null;
  collisions: ConflictFinding[];
};

export type HuddleBrief = AgentBriefBase & {
  kind: "huddle";
  query: { sinceMs: number };
  contributions: HuddleContribution[];
};

export type JanitorBrief = AgentBriefBase & {
  kind: "janitor";
  query: { resourceRef: string; idleDays: number };
  idle: boolean;
  proposalSuppressed: boolean;
  cleanupAction: string | null;
  peersClear: number;
  peersTouched: JanitorPeerTouch[];
};

export type PreflightBrief = AgentBriefBase & {
  kind: "preflight";
  query: { ref: string; namespace: string };
  downstreams: PreflightDownstream[];
  anyFailed: boolean;
  anyIncomplete: boolean;
};

export type AgentBrief =
  | ExpertBrief | ImpactBrief | CatchupBrief | GhostBrief
  | ConflictBrief | HuddleBrief | JanitorBrief | PreflightBrief;

/** The payload of a `<agent>.briefReady` notification. */
export type BriefReadyPayload<B extends AgentBrief> = {
  sessionId: string;
  brief: string;
  findings: B;
};

/** Agent name → its brief type. */
export type BriefFor<A extends AgentName> = {
  expert: ExpertBrief;
  impact: ImpactBrief;
  catchup: CatchupBrief;
  ghost: GhostBrief;
  conflicts: ConflictBrief;
  huddle: HuddleBrief;
  janitor: JanitorBrief;
  preflight: PreflightBrief;
}[A];

```

- [ ] **Step 6: Re-export from `src/index.ts`**

Insert immediately after the existing `export type { AgentBriefBase, … } from "./agents/brief-types.ts";` line:

```ts
export { AGENT_KIND, AGENT_NAMES, type AgentName } from "./agents/agent-names";
export type {
  AgentBrief,
  BriefFor,
  BriefReadyPayload,
  CatchupBrief,
  ConflictBrief,
  ConflictFinding,
  ExpertBrief,
  ExpertiseRank,
  FederatedItemLite,
  GhostBrief,
  GhostFinding,
  HuddleBrief,
  HuddleContribution,
  ImpactBrief,
  ImpactCategory,
  JanitorBrief,
  PreflightBrief,
} from "./agents/brief-composites";

```

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: both clean, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/agents/agent-names.ts src/agents/agent-names.test.ts src/agents/brief-composites.ts src/index.ts
git commit -m "feat(agents): promote the composed brief types to the SDK

The eight composed briefs lived in gateway agents/_lib/findings.ts and were
mirrored in cli types/agents.ts. Promote them here so the client can consume
one definition instead of adding a third copy.

ExpertiseRank comes with them: GhostBrief depends on it and it previously
lived in the gateway-internal federation/types.ts.

AGENT_KIND is an explicit table because conflicts emits kind \"conflict\"."

```

---

### Task 2: Add the eight concrete guards

**Files:**

- Create: `src/agents/brief-guards.ts`
- Test: `src/agents/brief-guards.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: `createBriefGuard` from `./guard-factory.ts`; the brief types from Task 1.
- Produces: `isExpertBrief`, `isImpactBrief`, `isCatchupBrief`, `isGhostBrief`, `isConflictBrief`, `isHuddleBrief`, `isJanitorBrief`, `isPreflightBrief`, and `BRIEF_GUARDS`.

- [ ] **Step 1: Write the failing test**

Create `src/agents/brief-guards.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_NAMES } from "./agent-names.ts";
import { BRIEF_GUARDS, isConflictBrief, isExpertBrief } from "./brief-guards.ts";

const base = { agentVersion: 1, generatedAt: 1, latencyMs: 1, gaps: [] };

describe("brief guards", () => {
  test("a well-formed expert brief is accepted", () => {
    expect(isExpertBrief({ ...base, kind: "expert", query: { topicOrFile: "x" }, ranked: [] }))
      .toBe(true);
  });

  test("a brief missing query is rejected — every gateway guard is strict", () => {
    expect(isExpertBrief({ ...base, kind: "expert", ranked: [] })).toBe(false);
  });

  test("the wrong kind is rejected", () => {
    expect(isExpertBrief({ ...base, kind: "impact", query: {}, ranked: [] })).toBe(false);
  });

  test("a conflicts brief carries the singular kind", () => {
    expect(isConflictBrief({ ...base, kind: "conflict", query: { file: "a" }, collisions: [] }))
      .toBe(true);
    expect(isConflictBrief({ ...base, kind: "conflicts", query: { file: "a" }, collisions: [] }))
      .toBe(false);
  });

  test("BRIEF_GUARDS has an entry per agent", () => {
    for (const name of AGENT_NAMES) expect(typeof BRIEF_GUARDS[name]).toBe("function");
  });
});

```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/agents/brief-guards.test.ts`
Expected: FAIL — `Cannot find module './brief-guards.ts'`

- [ ] **Step 3: Create `src/agents/brief-guards.ts`**

All eight use `{ requireQuery: true }`, matching every gateway guard at `findings.ts:150-199`.

```ts
import type { AgentName } from "./agent-names.ts";
import type {
  CatchupBrief, ConflictBrief, ExpertBrief, GhostBrief,
  HuddleBrief, ImpactBrief, JanitorBrief, PreflightBrief,
} from "./brief-composites.ts";
import { createBriefGuard } from "./guard-factory.ts";

const STRICT = { requireQuery: true } as const;

export const isExpertBrief = createBriefGuard<ExpertBrief>(
  "expert", (b) => Array.isArray(b["ranked"]), STRICT);

export const isImpactBrief = createBriefGuard<ImpactBrief>(
  "impact", (b) => Array.isArray(b["affected"]), STRICT);

export const isCatchupBrief = createBriefGuard<CatchupBrief>(
  "catchup", (b) => Array.isArray(b["sections"]), STRICT);

export const isGhostBrief = createBriefGuard<GhostBrief>(
  "ghost", (b) => Array.isArray(b["findings"]), STRICT);

export const isConflictBrief = createBriefGuard<ConflictBrief>(
  "conflict", (b) => Array.isArray(b["collisions"]), STRICT);

export const isHuddleBrief = createBriefGuard<HuddleBrief>(
  "huddle", (b) => Array.isArray(b["contributions"]), STRICT);

export const isJanitorBrief = createBriefGuard<JanitorBrief>(
  "janitor",
  (b) => typeof b["idle"] === "boolean" && Array.isArray(b["peersTouched"]),
  STRICT);

export const isPreflightBrief = createBriefGuard<PreflightBrief>(
  "preflight",
  (b) =>
    Array.isArray(b["downstreams"]) &&
    typeof b["anyFailed"] === "boolean" &&
    typeof b["anyIncomplete"] === "boolean",
  STRICT);

/** Agent name → its guard. Keyed by AGENT name, not by brief `kind`. */
export const BRIEF_GUARDS: { [A in AgentName]: (x: unknown) => boolean } = {
  expert: isExpertBrief,
  impact: isImpactBrief,
  catchup: isCatchupBrief,
  ghost: isGhostBrief,
  conflicts: isConflictBrief,
  huddle: isHuddleBrief,
  janitor: isJanitorBrief,
  preflight: isPreflightBrief,
};

```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/agents/brief-guards.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Re-export from `src/index.ts`**

```ts
export {
  BRIEF_GUARDS, isCatchupBrief, isConflictBrief, isExpertBrief, isGhostBrief,
  isHuddleBrief, isImpactBrief, isJanitorBrief, isPreflightBrief,
} from "./agents/brief-guards";

```

- [ ] **Step 6: Full verification**

Run: `bun test && bun run typecheck && bun run lint && bun run build`
Expected: all pass. Confirm `dist/index.d.ts` now names `ExpertBrief` and `isExpertBrief`:
`grep -c "ExpertBrief" dist/index.d.ts` → non-zero.

- [ ] **Step 7: Commit**

```bash
git add src/agents/brief-guards.ts src/agents/brief-guards.test.ts src/index.ts
git commit -m "feat(agents): export the eight concrete brief guards

All eight use requireQuery: true, matching every gateway guard. The CLI's
expert/impact/catchup guards omitted it; adopting these tightens exactly
those three."

```

---

### Task 3: Release 1.5.0

**Files:**

- Modify: `package.json` (version), `CHANGELOG.md`

- [ ] **Step 1: Bump the version**

In `package.json`: `"version": "1.4.0"` → `"version": "1.5.0"`.

- [ ] **Step 2: Add the CHANGELOG entry**

```markdown
## 1.5.0

### Added

- The eight composed agent brief types (`ExpertBrief`, `ImpactBrief`,
  `CatchupBrief`, `GhostBrief`, `ConflictBrief`, `HuddleBrief`, `JanitorBrief`,
  `PreflightBrief`), the `AgentBrief` union, and `BriefReadyPayload<B>`.

- Supporting types: `ExpertiseRank`, `ImpactCategory`, `FederatedItemLite`,
  `GhostFinding`, `ConflictFinding`, `HuddleContribution`.

- `AGENT_NAMES`, `AgentName`, `AGENT_KIND` and `BriefFor<A>`.
- The eight concrete guards plus `BRIEF_GUARDS`.

Purely additive; 1.4.x consumers are unaffected.

```

- [ ] **Step 3: Verify, push, open the PR**

Run: `bun test && bun run typecheck && bun run lint && bun run build`
Expected: clean.

```bash
git add package.json CHANGELOG.md && git commit -m "chore(release): 1.5.0"
git push -u origin dev/asafgolombek/promote-agent-briefs
gh pr create --title "feat(agents): promote composed brief types + guards (1.5.0)" --body "Stage 1 Wave 1a, PR 1 of 3. See Nimbus docs/superpowers/specs/2026-07-22-stage-1-wave-1a-agents-namespace-design.md"

```

- [ ] **Step 4: After merge, publish and verify**

```bash
npm view @nimbus-dev/sdk@1.5.0 version
```

Expected: `1.5.0`. **Phase 3 is blocked until this prints.**

---

## Phase 2 — Nimbus de-duplication

Worktree already exists: `.claude/worktrees/stage1-wave1a-agents` on `dev/asafgolombek/stage1-wave1a-agents`.

> **Trap:** use the **worktree** absolute path for every Read/Edit. Editing `C:\gitrep\Nimbus\packages\…` silently edits `main`.

### Task 4: Gateway re-exports from the SDK

**Files:**

- Modify: `packages/gateway/package.json` — `"@nimbus-dev/sdk": "^1.5.0"`
- Modify: `packages/gateway/src/agents/_lib/findings.ts` — delete lines 29-199, replace with re-exports
- Modify: `packages/gateway/src/federation/types.ts:61` — re-export `ExpertiseRank`
- Test: existing `packages/gateway/src/agents/**` suites, unchanged

**Interfaces:**

- Consumes: everything Task 1 and Task 2 produced.
- Produces: no new names. `findings.ts` keeps its exact public surface so no consumer changes.

- [ ] **Step 1: Install the new SDK**

Edit `packages/gateway/package.json` to `"@nimbus-dev/sdk": "^1.5.0"`, then run `bun install`.
Expected: lockfile updates, no errors.

- [ ] **Step 2: Run the agent tests to capture the green baseline**

Run: `bun test packages/gateway/src/agents/`
Expected: PASS. **Record the test count** — it must be identical after the refactor.

- [ ] **Step 3: Replace `findings.ts` body with re-exports**

Replace the whole file with:

```ts
/**

 * Agent brief types and guards.

 *

 * These now live in `@nimbus-dev/sdk` so the gateway, the CLI and
 * `@nimbus-dev/client` share one definition. This module re-exports them so
 * existing gateway imports keep working unchanged.

 */
export type {
  AgentBrief, AgentBriefBase, BriefReadyPayload, CatchupBrief, CatchupItem,
  CatchupSection, ConflictBrief, ConflictFinding, ConflictType, Evidence,
  ExpertBrief, ExpertFinding, ExpertiseRank, FederatedItemLite, GapCategory,
  GapNote, GhostBrief, GhostFinding, HuddleBrief, HuddleContribution,
  ImpactBrief, ImpactCategory, ImpactFinding, JanitorBrief, JanitorPeerTouch,
  PreflightBrief, PreflightDownstream,
} from "@nimbus-dev/sdk";

export {
  isCatchupBrief, isConflictBrief, isExpertBrief, isGhostBrief,
  isHuddleBrief, isImpactBrief, isJanitorBrief, isPreflightBrief,
} from "@nimbus-dev/sdk";

```

- [ ] **Step 4: Re-export `ExpertiseRank` in `federation/types.ts`**

Replace line 61 (`export type ExpertiseRank = "high" | "medium" | "low" | "none";`) with:

```ts
// Canonical definition now lives in @nimbus-dev/sdk (GhostBrief depends on it).
// NOTE: a bare `export type { X } from "…"` re-exports without binding X locally,
// and this module USES ExpertiseRank (the `rank` field on the expertise type).
// So import it and re-export the local binding — two statements, not one.
import type { ExpertiseRank } from "@nimbus-dev/sdk";
// …and near the other exports:
export type { ExpertiseRank };

```

Only `tsc` catches the bare-re-export mistake; `bun test` passes either way. This is why
Step 6's typecheck is load-bearing.

- [ ] **Step 5: Run the tests — the count must match Step 2**

Run: `bun test packages/gateway/src/agents/ && bun test packages/gateway/src/federation/`
Expected: PASS with the same count as Step 2. A changed count means the refactor altered behaviour — stop and investigate.

- [ ] **Step 6: Typecheck AND lint**

Run: `bun run typecheck`
Expected: clean. `bun test` alone does not catch `tsc` failures in this repo.

Run: `bun run --cwd packages/gateway lint`
Expected: exit 0. **Do not skip this.** Biome requires one identifier per line in
`export { … } from` blocks, so a re-export list written the way this plan's snippets
format them (multiple names per line, for readability on the page) fails `lint` — and
therefore fails the mandatory `preflight:fast`. Reformat with
`bunx biome format --write <file>` and confirm the exported-identifier set is unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/package.json packages/gateway/src/agents/_lib/findings.ts packages/gateway/src/federation/types.ts bun.lock
git commit -m "refactor(agents): consume the SDK's brief types in the gateway

findings.ts keeps its public surface; the definitions now come from
@nimbus-dev/sdk@1.5.0. ExpertiseRank moves with GhostBrief."

```

### Task 5: CLI re-exports from the SDK

**Files:**

- Modify: `packages/cli/package.json` — `"@nimbus-dev/sdk": "^1.5.0"`
- Modify: `packages/cli/src/types/agents.ts` — delete lines 25-198, replace with re-exports

- [ ] **Step 1: Capture the green baseline**

Run: `bun test packages/cli/src`
Expected: PASS. Record the count.

- [ ] **Step 2: Replace the CLI type module**

```ts
/**

 * Agent brief types and guards, re-exported from `@nimbus-dev/sdk`.

 *

 * Previously a hand-maintained mirror of gateway `agents/_lib/findings.ts`.
 * Two names the SDK spells differently are kept as aliases so existing CLI
 * imports keep resolving: `GhostContextItem` (SDK `FederatedItemLite`) and
 * `ConflictCollision` (SDK `ConflictFinding`).

 */
export type {
  AgentBrief, AgentBriefBase, BriefReadyPayload, CatchupBrief, CatchupItem,
  CatchupSection, ConflictBrief, ConflictFinding,
  ConflictFinding as ConflictCollision, ConflictType, Evidence,
  ExpertBrief, ExpertFinding, ExpertiseRank,
  FederatedItemLite, FederatedItemLite as GhostContextItem,
  GapCategory, GapNote, GhostBrief, GhostFinding, HuddleBrief,
  HuddleContribution, ImpactBrief, ImpactCategory, ImpactFinding,
  JanitorBrief, JanitorPeerTouch, PreflightBrief, PreflightDownstream,
} from "@nimbus-dev/sdk";

export {
  isCatchupBrief, isConflictBrief, isExpertBrief, isGhostBrief,
  isHuddleBrief, isImpactBrief, isJanitorBrief, isPreflightBrief,
} from "@nimbus-dev/sdk";

```

- [ ] **Step 3: Run the CLI tests — this is where strictness may bite**

Run: `bun test packages/cli/src`

Expected: PASS with the Step 1 count.

**If it fails:** the cause will be one of `isExpertBrief` / `isImpactBrief` / `isCatchupBrief` now requiring `query` where the CLI's local guard did not. Read the failure. If a CLI fixture legitimately has no `query`, apply the documented fallback — keep those three guards local in the CLI and re-export only the types:

```ts
import { createBriefGuard } from "@nimbus-dev/sdk";
import type { CatchupBrief, ExpertBrief, ImpactBrief } from "@nimbus-dev/sdk";

// Intentionally laxer than the SDK's strict guards: these three CLI call sites
// accept briefs without a `query` block. See the Wave 1a design spec, Risks.
export const isExpertBrief = createBriefGuard<ExpertBrief>("expert", (b) =>
  Array.isArray(b["ranked"]));
export const isImpactBrief = createBriefGuard<ImpactBrief>("impact", (b) =>
  Array.isArray(b["affected"]));
export const isCatchupBrief = createBriefGuard<CatchupBrief>("catchup", (b) =>
  Array.isArray(b["sections"]));

```

and drop those three from the `export { … } from "@nimbus-dev/sdk"` list.

- [ ] **Step 4: Typecheck and preflight**

Run: `bun run typecheck && bun run preflight:fast`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json packages/cli/src/types/agents.ts bun.lock
git commit -m "refactor(agents): consume the SDK's brief types in the CLI

Deletes the hand-maintained mirror of gateway findings.ts."

```

### Task 6: Generate the conformance fixture

**Files:**

- Create: `scripts/gen-agent-brief-fixtures.ts`

**Interfaces:**

- Produces: a JSON file mapping each agent name to a real `briefReady` payload, for `nimbus-client`'s conformance gate.

- [ ] **Step 1: Write the generator**

It drives the real `dispatchAgentsRpc` against an in-memory DB and captures what `notify` receives — so the shape comes from gateway code, never from hand-authoring.

```ts
/**

 * Generates the golden agent-brief fixture consumed by nimbus-client's
 * conformance gate. The payloads come from the real dispatchAgentsRpc →
 * emitBriefWithSynthesis path, so the fixture cannot drift from the wire by
 * being written down wrong.

 *

 * Usage: bun run scripts/gen-agent-brief-fixtures.ts > agent-briefs.json

 */
import { Database } from "bun:sqlite";
import { LocalIndex } from "../packages/gateway/src/index/local-index.ts";
import { dispatchAgentsRpc } from "../packages/gateway/src/ipc/agents-rpc.ts";

const PARAMS: Record<string, Record<string, unknown>> = {
  expert: { topicOrFile: "src/payments/charge.ts" },
  impact: { fileOrPrUrl: "src/payments/charge.ts" },
  catchup: { sinceMs: 259_200_000 },
  ghost: { file: "src/payments/charge.ts" },
  conflicts: { file: "src/payments/charge.ts" },
  huddle: { sinceMs: 259_200_000 },
  janitor: { resourceRef: "repo:acme/payments#branch/wip" },
  preflight: { ref: "HEAD", namespace: "payments" },
};

const out: Record<string, unknown> = {};

for (const [agent, params] of Object.entries(PARAMS)) {
  // Same schema bootstrap the agents-rpc tests use (`freshDb()` in agents-rpc.test.ts).
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);

  const payload = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${agent} never emitted`)), 20_000);
    void dispatchAgentsRpc(`agents.${agent}`, params, {
      db,
      notify: (method: string, p: unknown) => {
        if (method === `${agent}.briefReady`) { clearTimeout(timer); resolve(p); }
        if (method === `${agent}.briefError`) {
          clearTimeout(timer);
          reject(new Error(`${agent} errored: ${JSON.stringify(p)}`));
        }
      },
    });
  });

  out[agent] = payload;
  db.close();
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

```

- [ ] **Step 2: Run it and inspect the output**

Windows-safe scratch path (do not use `/tmp`):

```bash
SCRATCH="$HOME/AppData/Local/Temp/claude/C--gitrep-Nimbus/dfb03fe9-a7c3-467f-8b7c-8ba1a779f8ab/scratchpad"
mkdir -p "$SCRATCH"
bun run scripts/gen-agent-brief-fixtures.ts > "$SCRATCH/agent-briefs.json"
node -e "const o=require(process.argv[1]); console.log(Object.keys(o)); console.log(o.conflicts.findings.kind)" "$SCRATCH/agent-briefs.json"

```

Expected: all eight agent names printed, and `conflict` (singular) for the conflicts kind — the live confirmation of the mismatch this plan is built around.

If an agent rejects because an empty index yields no start entity, adjust only that agent's `PARAMS` entry; do not edit the emitted JSON.

- [ ] **Step 3: Commit**

```bash
git add scripts/gen-agent-brief-fixtures.ts
git commit -m "test(agents): add the agent-brief fixture generator

Drives the real dispatchAgentsRpc path so nimbus-client's conformance
fixture is generated from gateway code, never hand-written."

```

- [ ] **Step 4: Preflight, push, open the PR**

Run: `bun run preflight:fast`
Expected: clean.

```bash
git push -u origin dev/asafgolombek/stage1-wave1a-agents
gh pr create --title "refactor(agents): consume SDK brief types; add fixture generator" --body "Stage 1 Wave 1a, PR 2 of 3."

```

---

## Phase 3 — `nimbus-client` 0.7.0

**Blocked until `npm view @nimbus-dev/sdk@1.5.0 version` succeeds.**

Worktree: `cd /c/gitrep/nimbus-client && git worktree add .worktrees/agents-namespace -b dev/asafgolombek/agents-namespace main`

### Task 7: The agent module — params, events, guards

**Files:**

- Create: `src/agents.ts`
- Modify: `package.json` — `"@nimbus-dev/sdk": "^1.5.0"`, then `bun install`
- Test: `test/agents.test.ts` (created in Task 8)

**Interfaces:**

- Produces: `ExpertParams`, `ImpactParams`, `CatchupParams`, `GhostParams`, `ConflictsParams`, `HuddleParams`, `JanitorParams`, `PreflightParams`, `AgentParamsFor<A>`, `AgentBriefEvent<A>`, `AgentBriefError`, `AgentTimeoutError`, `DEFAULT_AGENT_TIMEOUT_MS`, `parseBriefReady`, `parseBriefError`.

- [ ] **Step 1: Create `src/agents.ts`**

Param shapes transcribed from `packages/gateway/src/ipc/agents-rpc.ts:48-370`.

```ts
/**

 * The `agents.*` namespace: eight read-only, never-HITL built-in agents.

 *

 * Each method returns `{ sessionId }` immediately, then the gateway emits
 * EITHER `<agent>.briefReady` OR `<agent>.briefError` for that session. Both
 * must be handled — watching only briefReady turns every agent failure into a
 * timeout that hides the gateway's actual error message.

 */
import { type AgentName, BRIEF_GUARDS, type BriefFor } from "@nimbus-dev/sdk";

export const DEFAULT_AGENT_TIMEOUT_MS = 30_000;

export type ExpertParams = { topicOrFile: string; limit?: number };
export type ImpactParams = { fileOrPrUrl: string; depth?: number; service?: string };
export type CatchupParams = { sinceMs?: number; service?: string };
export type GhostParams = { file: string; namespace?: string; namespaces?: string[] };
export type ConflictsParams = { file: string; namespace?: string; namespaces?: string[] };
export type HuddleParams = { sinceMs?: number; namespace?: string; namespaces?: string[] };
export type JanitorParams = {
  resourceRef: string;
  idleDays?: number;
  cleanupAction?: string;
  allowGaps?: boolean;
};
export type PreflightParams = { ref: string; namespace: string; changedSurface?: string[] };

export type AgentParamsFor<A extends AgentName> = {
  expert: ExpertParams;
  impact: ImpactParams;
  catchup: CatchupParams;
  ghost: GhostParams;
  conflicts: ConflictsParams;
  huddle: HuddleParams;
  janitor: JanitorParams;
  preflight: PreflightParams;
}[A];

export type AgentBriefEvent<A extends AgentName> =
  | { ok: true; sessionId: string; brief: string; findings: BriefFor<A> }
  | { ok: false; sessionId: string; error: string };

/** Thrown when the gateway emits `<agent>.briefError` for our session. */
export class AgentBriefError extends Error {
  readonly agent: AgentName;
  readonly sessionId: string;
  constructor(agent: AgentName, sessionId: string, detail: string) {
    super(`agents.${agent} failed (${sessionId}): ${detail}`);
    this.name = "AgentBriefError";
    this.agent = agent;
    this.sessionId = sessionId;
  }
}

/** Thrown when neither notification arrives within the timeout. */
export class AgentTimeoutError extends Error {
  readonly agent: AgentName;
  readonly sessionId: string;
  constructor(agent: AgentName, sessionId: string, timeoutMs: number) {
    super(`agents.${agent} did not report within ${timeoutMs}ms (${sessionId})`);
    this.name = "AgentTimeoutError";
    this.agent = agent;
    this.sessionId = sessionId;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrow a `<agent>.briefReady` payload, or null if it is malformed. */
export function parseBriefReady<A extends AgentName>(
  agent: A,
  params: unknown,
): AgentBriefEvent<A> | null {
  if (!isRecord(params)) return null;
  const { sessionId, brief, findings } = params;
  if (typeof sessionId !== "string" || typeof brief !== "string") return null;
  if (!BRIEF_GUARDS[agent](findings)) return null;
  return { ok: true, sessionId, brief, findings: findings as BriefFor<A> };
}

/** Narrow a `<agent>.briefError` payload, or null if it is malformed. */
export function parseBriefError<A extends AgentName>(
  params: unknown,
): AgentBriefEvent<A> | null {
  if (!isRecord(params)) return null;
  const { sessionId, error } = params;
  if (typeof sessionId !== "string" || typeof error !== "string") return null;
  return { ok: false, sessionId, error };
}

```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean. If `BriefFor` or `BRIEF_GUARDS` is unresolved, the installed SDK is still 1.4.0 — re-run `bun install`.

- [ ] **Step 3: Commit**

```bash
git add src/agents.ts package.json bun.lock
git commit -m "feat(agents): add agent param types, brief events and payload parsers"

```

### Task 8: `validateAgentSession`

Comes before the client wiring because Task 9 imports it.

**Files:**

- Modify: `src/validate.ts`
- Test: `test/validate.test.ts`

**Interfaces:**

- Produces: `validateAgentSession(method: string, v: unknown): { sessionId: string }`.

- [ ] **Step 1: Add the failing test to `test/validate.test.ts`**

```ts
describe("validateAgentSession", () => {
  test("accepts a well-formed session envelope", () => {
    expect(validateAgentSession("agents.expert", { sessionId: "expert_1_ab" }))
      .toEqual({ sessionId: "expert_1_ab" });
  });

  test("rejects a missing sessionId", () => {
    expect(() => validateAgentSession("agents.expert", {})).toThrow(IpcResponseError);
  });

  test("rejects a non-object", () => {
    expect(() => validateAgentSession("agents.expert", "nope")).toThrow(IpcResponseError);
  });
});

```

Add `validateAgentSession` to that file's existing import from `../src/validate.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/validate.test.ts`
Expected: FAIL — `validateAgentSession is not a function`.

- [ ] **Step 3: Implement it in `src/validate.ts`**

Append, reusing the file's existing `record` and `str` helpers:

```ts
/** `{ sessionId: string }` — the synchronous return of every `agents.*` method. */
export function validateAgentSession(method: string, v: unknown): { sessionId: string } {
  const o = record(method, v);
  return { sessionId: str(method, o, "sessionId") };
}

```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts test/validate.test.ts
git commit -m "feat(agents): validate the agents.* session envelope"

```

### Task 9: `subscribeAgentBrief` + `runAgent`

**Files:**

- Modify: `src/nimbus-client.ts`
- Test: `test/agents.test.ts`

**Interfaces:**

- Consumes: Task 7's exports; `ipc.onNotification` / `offNotification` (`src/ipc-transport.ts:216,226`).
- Produces: `NimbusClient.subscribeAgentBrief`, private `NimbusClient.runAgent`.

- [ ] **Step 1: Write the failing tests**

Create `test/agents.test.ts`. These four cover the spec's four correctness requirements.

```ts
import { describe, expect, test } from "bun:test";
import { AgentBriefError, parseBriefError, parseBriefReady } from "../src/agents.ts";

const base = { agentVersion: 1, generatedAt: 1, latencyMs: 1, gaps: [] };
const expertFindings = { ...base, kind: "expert", query: { topicOrFile: "x" }, ranked: [] };

describe("brief payload parsing", () => {
  test("a well-formed briefReady payload narrows", () => {
    const ev = parseBriefReady("expert", {
      sessionId: "expert_1_ab", brief: "# hi", findings: expertFindings,
    });
    expect(ev?.ok).toBe(true);
    expect(ev?.sessionId).toBe("expert_1_ab");
  });

  test("findings failing the guard is rejected, not passed through", () => {
    expect(parseBriefReady("expert", {
      sessionId: "s", brief: "x", findings: { ...base, kind: "expert", ranked: [] },
    })).toBeNull();
  });

  test("a briefError payload narrows to the failure branch", () => {
    const ev = parseBriefError({ sessionId: "s", error: "index empty" });
    expect(ev).toEqual({ ok: false, sessionId: "s", error: "index empty" });
  });

  test("AgentBriefError carries the gateway message", () => {
    const e = new AgentBriefError("expert", "s", "index empty");
    expect(e.message).toContain("index empty");
    expect(e.agent).toBe("expert");
  });
});

```

- [ ] **Step 2: Run the tests**

Run: `bun test test/agents.test.ts`
Expected: PASS — these pin the contract Task 7 already built, and exist so a later
change to `parseBriefReady` cannot silently loosen guard enforcement. To confirm they
have teeth, temporarily change `parseBriefReady` to `return { ok: true, sessionId, brief,
findings } as never;` without the `BRIEF_GUARDS` check and re-run: the
"findings failing the guard is rejected" test must go red. Revert before continuing.

- [ ] **Step 3: Add the imports to `src/nimbus-client.ts`**

```ts
import type { AgentName, BriefFor } from "@nimbus-dev/sdk";
import {
  type AgentBriefEvent, AgentBriefError, type AgentParamsFor, AgentTimeoutError,
  DEFAULT_AGENT_TIMEOUT_MS, parseBriefError, parseBriefReady,
} from "./agents.js";
import { validateAgentSession } from "./validate.js";

```

- [ ] **Step 4: Add `subscribeAgentBrief` to the `NimbusClient` class**

Place it directly after `subscribeHitl` (which ends at line 256) so the two subscription APIs sit together.

```ts
  /**

   * Observe both completion notifications for one agent.
   *

   * Registers on `<agent>.briefReady` AND `<agent>.briefError`; `dispose()`
   * removes both. Generic over the agent NAME so a ninth agent costs one
   * `AGENT_NAMES` entry rather than a new method.
   */
  subscribeAgentBrief<A extends AgentName>(
    agent: A,
    handler: (ev: AgentBriefEvent<A>) => void,
  ): { dispose(): void } {
    const readyMethod = `${agent}.briefReady`;
    const errorMethod = `${agent}.briefError`;
    const onReady = (params: unknown): void => {
      const ev = parseBriefReady(agent, params);
      if (ev !== null) handler(ev);
    };
    const onError = (params: unknown): void => {
      const ev = parseBriefError<A>(params);
      if (ev !== null) handler(ev);
    };
    this.ipc.onNotification(readyMethod, onReady);
    this.ipc.onNotification(errorMethod, onError);
    return {
      dispose: () => {
        this.ipc.offNotification(readyMethod, onReady);
        this.ipc.offNotification(errorMethod, onError);
      },
    };
  }

  /**

   * Fire an agent and await its brief.
   *

   * Ordering matters: the gateway starts the work before the RPC response is
   * parsed (`emit-brief.ts` fires its async IIFE immediately), so we subscribe
   * FIRST and buffer anything that arrives before `sessionId` is known, then
   * drain the buffer. Without the buffer a fast agent's notification is
   * dropped; without the sessionId filter two concurrent runs swap results.
   */
  private async runAgent<A extends AgentName>(
    agent: A,
    params: AgentParamsFor<A>,
    opts?: { timeoutMs?: number },
  ): Promise<BriefFor<A>> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const buffered: AgentBriefEvent<A>[] = [];
    let sessionId: string | null = null;
    let deliver: ((ev: AgentBriefEvent<A>) => void) | null = null;

    const sub = this.subscribeAgentBrief(agent, (ev) => {
      if (sessionId === null) {
        buffered.push(ev);
        return;
      }
      if (ev.sessionId === sessionId) deliver?.(ev);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const method = `agents.${agent}`;
      const raw = await this.ipc.call<unknown>(method, params);
      const sid = validateAgentSession(method, raw).sessionId;
      sessionId = sid;

      const ev = await new Promise<AgentBriefEvent<A>>((resolve, reject) => {
        deliver = resolve;
        const early = buffered.find((b) => b.sessionId === sid);
        if (early !== undefined) {
          resolve(early);
          return;
        }
        timer = setTimeout(() => {
          reject(new AgentTimeoutError(agent, sid, timeoutMs));
        }, timeoutMs);
      });

      if (!ev.ok) throw new AgentBriefError(agent, ev.sessionId, ev.error);
      return ev.findings;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      sub.dispose();
    }
  }

```

- [ ] **Step 5: Add `subscribeAgentBrief` to the `NimbusClientLike` interface**

Next to `subscribeHitl` at line 179:

```ts
  subscribeAgentBrief<A extends AgentName>(
    agent: A,
    handler: (ev: AgentBriefEvent<A>) => void,
  ): { dispose(): void };

```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: `test/agents.test.ts` passes; typecheck fails **only** on `MockClient` missing `subscribeAgentBrief` — that is the compiler enforcing parity, fixed in Task 10.

- [ ] **Step 7: Commit**

```bash
git add src/nimbus-client.ts test/agents.test.ts
git commit -m "feat(agents): add subscribeAgentBrief and the runAgent correlator

Subscribes before calling and buffers pre-sessionId events, so a fast agent's
notification is never dropped and concurrent runs cannot swap results.
Rejects with the gateway's message on briefError instead of timing out."

```

### Task 10: The eight promise methods + `MockClient` parity

**Files:**

- Modify: `src/nimbus-client.ts` (interface + class)
- Modify: `src/mock-client.ts`
- Test: `test/mock-client.test.ts`

**Interfaces:**

- Produces: `agentsExpert`, `agentsImpact`, `agentsCatchup`, `agentsGhost`, `agentsConflicts`, `agentsHuddle`, `agentsJanitor`, `agentsPreflight` — each `(params, opts?) => Promise<<X>Brief>`.

- [ ] **Step 1: Add the eight methods to the `NimbusClient` class**

```ts
  agentsExpert(p: ExpertParams, o?: { timeoutMs?: number }): Promise<ExpertBrief> {
    return this.runAgent("expert", p, o);
  }
  agentsImpact(p: ImpactParams, o?: { timeoutMs?: number }): Promise<ImpactBrief> {
    return this.runAgent("impact", p, o);
  }
  agentsCatchup(p?: CatchupParams, o?: { timeoutMs?: number }): Promise<CatchupBrief> {
    return this.runAgent("catchup", p ?? {}, o);
  }
  agentsGhost(p: GhostParams, o?: { timeoutMs?: number }): Promise<GhostBrief> {
    return this.runAgent("ghost", p, o);
  }
  agentsConflicts(p: ConflictsParams, o?: { timeoutMs?: number }): Promise<ConflictBrief> {
    return this.runAgent("conflicts", p, o);
  }
  agentsHuddle(p?: HuddleParams, o?: { timeoutMs?: number }): Promise<HuddleBrief> {
    return this.runAgent("huddle", p ?? {}, o);
  }
  agentsJanitor(p: JanitorParams, o?: { timeoutMs?: number }): Promise<JanitorBrief> {
    return this.runAgent("janitor", p, o);
  }
  agentsPreflight(p: PreflightParams, o?: { timeoutMs?: number }): Promise<PreflightBrief> {
    return this.runAgent("preflight", p, o);
  }

```

Add the matching eight signatures to `NimbusClientLike`, and extend the SDK type import with `CatchupBrief, ConflictBrief, ExpertBrief, GhostBrief, HuddleBrief, ImpactBrief, JanitorBrief, PreflightBrief` plus the param types from `./agents.js`.

- [ ] **Step 2: Run typecheck to see the compiler demand Mock parity**

Run: `bun run typecheck`
Expected: FAIL — `Class 'MockClient' incorrectly implements interface 'NimbusClientLike'`, listing the nine missing members. This is the parity gate proving itself.

- [ ] **Step 3: Extend `MockClientFixtures` and implement the stubs**

In `src/mock-client.ts`, add to `MockClientFixtures`:

```ts
  agentBriefs?: Partial<{
    expert: ExpertBrief; impact: ImpactBrief; catchup: CatchupBrief;
    ghost: GhostBrief; conflicts: ConflictBrief; huddle: HuddleBrief;
    janitor: JanitorBrief; preflight: PreflightBrief;
  }>;

```

and to the class:

```ts
  subscribeAgentBrief<A extends AgentName>(
    _agent: A,
    _handler: (ev: AgentBriefEvent<A>) => void,
  ): { dispose(): void } {
    return { dispose: () => {} };
  }

  private brief<A extends AgentName>(agent: A): Promise<BriefFor<A>> {
    const fixture = this.fixtures.agentBriefs?.[agent];
    if (fixture === undefined) {
      return Promise.reject(new Error(`MockClient: no agentBriefs.${agent} fixture configured`));
    }
    return Promise.resolve(fixture as BriefFor<A>);
  }

  async agentsExpert(): Promise<ExpertBrief> { return this.brief("expert"); }
  async agentsImpact(): Promise<ImpactBrief> { return this.brief("impact"); }
  async agentsCatchup(): Promise<CatchupBrief> { return this.brief("catchup"); }
  async agentsGhost(): Promise<GhostBrief> { return this.brief("ghost"); }
  async agentsConflicts(): Promise<ConflictBrief> { return this.brief("conflicts"); }
  async agentsHuddle(): Promise<HuddleBrief> { return this.brief("huddle"); }
  async agentsJanitor(): Promise<JanitorBrief> { return this.brief("janitor"); }
  async agentsPreflight(): Promise<PreflightBrief> { return this.brief("preflight"); }

```

- [ ] **Step 4: Add a mock test to `test/mock-client.test.ts`**

```ts
test("agentsExpert returns the configured fixture", async () => {
  const brief = {
    agentVersion: 1 as const, generatedAt: 1, latencyMs: 1, gaps: [],
    kind: "expert" as const, query: { topicOrFile: "x" }, ranked: [],
  };
  const c = new MockClient({ agentBriefs: { expert: brief } });
  expect(await c.agentsExpert({ topicOrFile: "x" })).toEqual(brief);
});

test("an unconfigured agent rejects with a named reason", async () => {
  await expect(new MockClient().agentsGhost({ file: "a" })).rejects.toThrow("agentBriefs.ghost");
});

```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/nimbus-client.ts src/mock-client.ts test/mock-client.test.ts
git commit -m "feat(agents): add the eight promise methods and MockClient parity"

```

### Task 10b: Behaviour tests for the correlator

> **Added during execution.** Review of Task 9 found that `runAgent`'s ordering, buffering,
> session-correlation and timeout logic had **zero** test coverage: Task 9's tests cover only
> Task 7's pure parsers, and Task 10's `MockClient` is a no-op stub that never calls
> `runAgent`. Without this task the subtlest code in the changeset ships to npm untested, and
> its failure modes — a dropped notification, two concurrent calls resolving each other's
> results, a leaked handler — all pass the rest of the suite.
>
> It must come **after** Task 10: while `runAgent` has no `src/` caller, `tsconfig.json`
> (which excludes tests) needs the `@ts-expect-error`, but `tsconfig.test.json` (which
> includes both) would then flag it as unused. Task 10's real callers dissolve that bind.

**Files:**

- Create: `test/_fake-ipc.ts` (extract the existing harness), `test/agents-wrapper.test.ts`
- Modify: `test/nimbus-client.test.ts` (import the extracted harness)
- **Do not modify anything under `src/`.**

Cover, through the **public** `agentsX` methods rather than by casting to the private one:

1. `subscribeAgentBrief` registers handlers for both `<agent>.briefReady` and
   `<agent>.briefError`, and `dispose()` removes both.

2. **Buffering** — invoke the method *without awaiting*, emit `briefReady` synchronously (the
   client does not yet know its `sessionId`), then await: it must resolve, not time out.

3. **Concurrency** — two `agentsExpert` calls with different session ids; emit both events
   *out of order*; each promise resolves with its own findings.

4. **`briefError`** rejects with `AgentBriefError` carrying the gateway's message.
5. **Timeout** rejects with `AgentTimeoutError` *and* the transport no longer holds the
   handlers afterwards — proving `dispose()` ran on the rejection path.

`test/nimbus-client.test.ts` already defines the `FakeIpc` + `makeClient` harness (it backs
the existing `subscribeHitl` test); extract it rather than duplicating it.

**Red-prove:** for tests 2 and 3, temporarily break the corresponding logic (drop the buffer
drain; drop the `ev.sessionId === sessionId` filter), confirm red, revert, confirm green, and
verify `git diff src/` is empty before committing.

### Task 11: The conformance gate

**Files:**

- Create: `test/fixtures/agent-briefs.json` (copied from Phase 2 Task 6 output)
- Create: `test/agents-conformance.test.ts`
- Modify: `test/fixtures/README.md`

- [ ] **Step 1: Copy the generated fixture in**

```bash
SCRATCH="$HOME/AppData/Local/Temp/claude/C--gitrep-Nimbus/dfb03fe9-a7c3-467f-8b7c-8ba1a779f8ab/scratchpad"
cp "$SCRATCH/agent-briefs.json" test/fixtures/agent-briefs.json

```

Do not hand-edit it. If it is wrong, fix the generator in the Nimbus repo and regenerate.

- [ ] **Step 2: Write the conformance test**

Create `test/agents-conformance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { AGENT_KIND, AGENT_NAMES, BRIEF_GUARDS } from "@nimbus-dev/sdk";
import { parseBriefReady } from "../src/agents.ts";
import golden from "./fixtures/agent-briefs.json" with { type: "json" };

/**

 * The agents.* conformance gate.

 *

 * `parseBriefReady` and the SDK guards hand-transcribe the gateway's
 * notification contract; nothing links them at compile time. This pins them to
 * payloads real gateway code emitted, so a shape change upstream fails here
 * rather than silently yielding a rejected brief in every client.

 *

 * When this fails: regenerate via Nimbus `scripts/gen-agent-brief-fixtures.ts`,
 * then fix the parser or guard. Never edit the fixture to make it pass.

 */
const fixtures = golden as Record<string, { sessionId: string; brief: string; findings: unknown }>;

describe("agents.* briefReady conformance", () => {
  test("the fixture covers all eight agents", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...AGENT_NAMES].sort());
  });

  for (const agent of AGENT_NAMES) {
    describe(agent, () => {
      test("the golden payload parses", () => {
        expect(parseBriefReady(agent, fixtures[agent])).not.toBeNull();
      });

      test("findings passes the SDK guard", () => {
        expect(BRIEF_GUARDS[agent](fixtures[agent]?.findings)).toBe(true);
      });

      test("kind matches AGENT_KIND, not the agent name", () => {
        const f = fixtures[agent]?.findings as Record<string, unknown>;
        expect(f["kind"]).toBe(AGENT_KIND[agent]);
      });

      test("the brief envelope is well-formed", () => {
        const f = fixtures[agent]?.findings as Record<string, unknown>;
        expect(typeof fixtures[agent]?.sessionId).toBe("string");
        expect(typeof fixtures[agent]?.brief).toBe("string");
        expect(f["agentVersion"]).toBe(1);
        expect(Array.isArray(f["gaps"])).toBe(true);
      });
    });
  }
});

```

- [ ] **Step 3: Run it — expect PASS**

Run: `bun test test/agents-conformance.test.ts`
Expected: PASS, 33 tests.

- [ ] **Step 4: RED-PROVE the gate — this step is mandatory**

A gate never observed failing is not a gate. Temporarily break the fixture:

```bash
node -e "const fs=require('fs');const p='test/fixtures/agent-briefs.json';const o=JSON.parse(fs.readFileSync(p));delete o.expert.findings.agentVersion;fs.writeFileSync(p+'.bak',JSON.stringify(o,null,2))"
cp test/fixtures/agent-briefs.json test/fixtures/agent-briefs.good.json
cp test/fixtures/agent-briefs.json.bak test/fixtures/agent-briefs.json
bun test test/agents-conformance.test.ts

```

Expected: **FAIL** — the expert `findings passes the SDK guard` and `brief envelope` tests go red.

Now restore and confirm green:

```bash
cp test/fixtures/agent-briefs.good.json test/fixtures/agent-briefs.json
rm test/fixtures/agent-briefs.json.bak test/fixtures/agent-briefs.good.json
bun test test/agents-conformance.test.ts

```

Expected: PASS. Do not proceed until both the red and the green have been observed.

- [ ] **Step 5: Document the regeneration recipe**

Append to `test/fixtures/README.md`:

````markdown
## `agent-briefs.json`

Golden `<agent>.briefReady` payloads for all eight `agents.*` methods, consumed
by `test/agents-conformance.test.ts`.

**Regenerate from the Nimbus repo — never edit by hand:**

```bash
bun run scripts/gen-agent-brief-fixtures.ts > agent-briefs.json
cp agent-briefs.json ../nimbus-client/test/fixtures/agent-briefs.json

```

The generator drives the real `dispatchAgentsRpc` → `emitBriefWithSynthesis`
path against an in-memory index, so the shape comes from gateway code.
````

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/agent-briefs.json test/agents-conformance.test.ts test/fixtures/README.md
git commit -m "test(agents): add the agents.* conformance gate

Pins parseBriefReady and the SDK guards to payloads real gateway code emitted.
Verified failing (agentVersion removed) before verified passing."

```

### Task 12: Export, release 0.7.0

**Files:**

- Modify: `src/index.ts`, `package.json`, `CHANGELOG.md`

- [ ] **Step 1: Add the public exports to `src/index.ts`**

```ts
export {
  AgentBriefError,
  type AgentBriefEvent,
  type AgentParamsFor,
  AgentTimeoutError,
  type CatchupParams,
  type ConflictsParams,
  DEFAULT_AGENT_TIMEOUT_MS,
  type ExpertParams,
  type GhostParams,
  type HuddleParams,
  type ImpactParams,
  type JanitorParams,
  type PreflightParams,
} from "./agents.js";

```

Extend the existing `export type { NimbusItem } from "@nimbus-dev/sdk";` line so consumers can name brief shapes without depending on the SDK directly:

```ts
export type {
  AgentBrief, AgentName, BriefFor, CatchupBrief, ConflictBrief, ExpertBrief,
  GhostBrief, HuddleBrief, ImpactBrief, JanitorBrief, NimbusItem, PreflightBrief,
} from "@nimbus-dev/sdk";

```

- [ ] **Step 2: Bump the version and write the CHANGELOG**

`package.json`: `0.6.0` → `0.7.0`. Then in `CHANGELOG.md`:

```markdown
## 0.7.0

### Added

- The `agents.*` namespace — all eight built-in read-only agents:
  `agentsExpert`, `agentsImpact`, `agentsCatchup`, `agentsGhost`,
  `agentsConflicts`, `agentsHuddle`, `agentsJanitor`, `agentsPreflight`.
  Each resolves with its typed brief and rejects with `AgentBriefError`
  carrying the gateway's message when the agent fails.

- `subscribeAgentBrief(agent, handler)` — the low-level primitive, generic over
  agent name, observing both `<agent>.briefReady` and `<agent>.briefError`.

- `AgentTimeoutError`, `DEFAULT_AGENT_TIMEOUT_MS` (30s).
- A conformance gate pinning the notification contract to gateway-generated
  golden payloads.

Requires `@nimbus-dev/sdk` ^1.5.0.

```

- [ ] **Step 3: Full verification**

Run: `bun test && bun run typecheck && bun run lint && bun run build`
Expected: all clean.

- [ ] **Step 4: Push and open the PR**

```bash
git add src/index.ts package.json CHANGELOG.md
git commit -m "chore(release): 0.7.0 — the agents.* namespace"
git push -u origin dev/asafgolombek/agents-namespace
gh pr create --title "feat(agents): expose the agents.* namespace (0.7.0)" --body "Stage 1 Wave 1a, PR 3 of 3. Eight methods + subscribeAgentBrief + conformance gate."

```

- [ ] **Step 5: After merge, update the ecosystem roadmap**

In the Nimbus repo, move Wave 1a from the Stage 1 table to a shipped list noting client 0.7.0, per `ecosystem-roadmap.md` §"How to update this document".

---

## Verification checklist

- [ ] All eight `agents.*` methods callable from `@nimbus-dev/client` with typed params and typed briefs.
- [ ] A failed agent rejects with `AgentBriefError` carrying the gateway's message — not a timeout.
- [ ] Two concurrent runs of one agent resolve to their own results (sessionId correlation).
- [ ] A notification arriving before the RPC resolves is still delivered (buffering).
- [ ] The composed brief types exist in exactly one place; gateway and CLI import them.
- [ ] The conformance gate was observed **red** before green.
- [ ] `MockClient` parity is compiler-enforced (Task 10 Step 2 saw the error).
- [ ] `bun run preflight:fast` clean in Nimbus; `bun test && typecheck && lint && build` clean in both libraries.
