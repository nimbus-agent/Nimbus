# Why-lens step 2 — SDK → client hop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the `why` lens (`agents.why` async brief + `agents.whyPeek` synchronous peek) through `@nimbus-dev/client`, with the Why types promoted to `@nimbus-dev/sdk` as the single source of truth, and publish both packages so the VS Code extension can consume them.

**Architecture:** Three repos, released in dependency order. `@nimbus-dev/sdk` 1.6.0 promotes the Why types + the 9th-agent machinery (this is the source-of-truth move). `@nimbus-dev/client` 0.12.0 depends on sdk `^1.6.0` and adds `agentsWhy` (reusing the existing `runAgent` brief-streaming machinery) + `agentsWhyPeek` (a new synchronous request/response). The gateway (Nimbus) then bumps to sdk `^1.6.0`, re-exports the promoted types from `findings.ts`, and deletes its local definitions — a pure type-move, no behavior change.

**Tech Stack:** TypeScript 6.x strict, Bun, Biome. Three git repos: `C:/gitrep/nimbus-sdk`, `C:/gitrep/nimbus-client`, and the gateway worktree `C:/gitrep/Nimbus/.claude/worktrees/why-lens-step2` (branch `dev/asafgolombek/why-lens-step2-client-hop`, already created).

## Global Constraints

- **No `any`** — `unknown` for external data; TS strict is non-negotiable (all three repos).
- **Copy the gateway's exact shapes.** The promoted SDK types must be byte-identical to the gateway's current `packages/gateway/src/agents/_lib/why-types.ts` definitions (today's source of truth), or the gateway re-export won't typecheck.
- **Release order is publish-then-verify-then-proceed:** SDK 1.6.0 published + `npm view @nimbus-dev/sdk@1.6.0` live → client 0.12.0 published + `npm view @nimbus-dev/client@0.12.0` live → gateway PR. A dependent repo built against an unpublished version fails `bun install`.
- **release-please may not auto-cut the tag** (known repo trap). Treat "PR merged" as *not released*; verify the npm version explicitly. If the tag did not cut, push it manually (`git tag vX.Y.Z <merge-commit> && git push origin vX.Y.Z`).
- **Params stay client-local.** `WhyInput`/`WhyParams` are NOT promoted (all 8 existing agents define params client-side; only result types live in the SDK).
- **Branch hygiene:** never commit on `main`; each repo gets its own `dev/asafgolombek/why-lens-step2-*` branch. The gateway worktree branch already exists.
- Every code step below shows the exact code. Match the surrounding file's import style (`.js` specifiers in sdk/client, `.ts` in gateway).

---

## File structure

**SDK (`C:/gitrep/nimbus-sdk`):**
- Modify `src/agents/agent-names.ts` — add `"why"` to `AGENT_NAMES` + `AGENT_KIND`.
- Modify `src/agents/brief-types.ts` — add `WhyLane`, `WhyFinding`, `WhySubject`.
- Modify `src/agents/brief-composites.ts` — add `WhyBrief` (+ `AgentBrief` union + `BriefFor` map) and standalone `WhyPeek`.
- Modify `src/agents/brief-guards.ts` — add `isWhyBrief` + `BRIEF_GUARDS.why`.
- Modify `src/index.ts` — export the new symbols.
- Modify `src/agents/agent-names.test.ts`, `src/agents/brief-guards.test.ts` — extend the exhaustive fixtures.
- Modify `package.json` — version → 1.6.0 (or let release-please do it).

**Client (`C:/gitrep/nimbus-client`):**
- Modify `package.json` — `@nimbus-dev/sdk` → `^1.6.0`.
- Modify `src/agents.ts` — add `WhyParams` + `AgentParamsFor.why`.
- Modify `src/nimbus-client.ts` — `NimbusClientLike` gains `agentsWhy`/`agentsWhyPeek`; the class implements both; imports.
- Modify `src/validate.ts` — add `validateWhyPeek`.
- Modify `src/mock-client.ts` — `agentBriefs.why` + `whyPeek` fixtures + the two methods.
- Modify `src/index.ts` — re-export `WhyParams`/`WhyBrief`/`WhyPeek`.
- Add tests: `src/agents-why.test.ts` (or extend an existing client test file).

**Gateway (worktree `why-lens-step2`):**
- Modify `packages/gateway/package.json` — `@nimbus-dev/sdk` → `^1.6.0`.
- Modify `packages/gateway/src/agents/_lib/findings.ts` — re-export the 5 types + `isWhyBrief`.
- Modify `packages/gateway/src/agents/_lib/why-types.ts` — delete local defs, re-export from `./findings.ts`; keep `WhyInput`.
- Modify `docs/ecosystem-roadmap.md` — record the lens is now client-reachable.

---

## PHASE 1 — `@nimbus-dev/sdk` 1.6.0

Work in `C:/gitrep/nimbus-sdk`. First: `cd C:/gitrep/nimbus-sdk && git switch -c dev/asafgolombek/why-lens-sdk-types && git rev-parse --abbrev-ref HEAD` (confirm the branch).

### Task 1: Promote the Why types

**Files:**
- Modify: `src/agents/brief-types.ts` (append leaf types)
- Modify: `src/agents/brief-composites.ts` (add `WhyBrief`, union, `BriefFor`, `WhyPeek`)
- Modify: `src/agents/agent-names.ts` (register the 9th agent)

**Interfaces produced (later tasks + the client rely on these exact names):**
```ts
export type WhyLane = "authorship" | "pull_request" | "ticket" | "discussion" | "driver" | "downstream";
export type WhyFinding = { lane: WhyLane; title: string; detail: string; url: string | null; occurredAt: number | null; entityId: string | null };
export type WhySubject = { repoRoot: string; filePath: string; lineNo: number | null; symbol: string | null };
export type WhyBrief = AgentBriefBase & { kind: "why"; query: { ref: string; line: number | null }; subject: WhySubject | null; findings: WhyFinding[] };
export type WhyPeek = { subject: { repoRoot: string; filePath: string; lineNo: number } | null; author: string | null; authorEmail: string | null; commitSha: string | null; committedAt: number | null; commitSubject: string | null; pr: { number: number | null; title: string; url: string | null } | null; ticket: { key: string; title: string; url: string | null } | null; hasMore: boolean };
```

- [ ] **Step 1: Add leaf types to `src/agents/brief-types.ts`** (append at end of file):

```ts
export type WhyLane =
  | "authorship"
  | "pull_request"
  | "ticket"
  | "discussion"
  | "driver"
  | "downstream";

export type WhyFinding = {
  lane: WhyLane;
  title: string;
  detail: string;
  url: string | null;
  occurredAt: number | null;
  entityId: string | null;
};

export type WhySubject = {
  repoRoot: string;
  filePath: string;
  lineNo: number | null;
  symbol: string | null;
};
```

- [ ] **Step 2: Register the 9th agent in `src/agents/agent-names.ts`** — add `"why"` to the `AGENT_NAMES` array (after `"preflight"`), and `why: "why"` to `AGENT_KIND`. Update the leading comment from "eight" to "nine":

```ts
export const AGENT_NAMES = [
  "expert",
  "impact",
  "catchup",
  "ghost",
  "conflicts",
  "huddle",
  "janitor",
  "preflight",
  "why",
] as const;
```
```ts
export const AGENT_KIND = {
  expert: "expert",
  impact: "impact",
  catchup: "catchup",
  ghost: "ghost",
  conflicts: "conflict",
  huddle: "huddle",
  janitor: "janitor",
  preflight: "preflight",
  why: "why",
} as const satisfies Record<AgentName, string>;
```

- [ ] **Step 3: Add `WhyFinding`/`WhySubject` to the `brief-types.js` import in `src/agents/brief-composites.ts`**, then add `WhyBrief` (before the `AgentBrief` union), add it to the union, add `why: WhyBrief` to the `BriefFor` map, and add standalone `WhyPeek`:

Import block — add the two leaf names:
```ts
import type {
  AgentBriefBase,
  CatchupSection,
  ConflictType,
  ExpertFinding,
  ImpactFinding,
  JanitorPeerTouch,
  PreflightDownstream,
  WhyFinding,
  WhySubject,
} from "./brief-types.js";
```
Add `WhyBrief` immediately after `PreflightBrief`:
```ts
export type WhyBrief = AgentBriefBase & {
  kind: "why";
  query: { ref: string; line: number | null };
  subject: WhySubject | null;
  findings: WhyFinding[];
};
```
Add to the `AgentBrief` union (append `| WhyBrief`) and to `BriefFor` (add `why: WhyBrief;`). Then add the standalone `WhyPeek` (NOT in the union — it is a synchronous peek result, not a brief):
```ts
/**
 * `agents.whyPeek` result — a synchronous one-line answer, NOT a brief.
 * Deliberately not part of `AgentBrief`: it carries no `AgentBriefBase` fields
 * and no gap notes.
 */
export type WhyPeek = {
  subject: { repoRoot: string; filePath: string; lineNo: number } | null;
  author: string | null;
  authorEmail: string | null;
  commitSha: string | null;
  committedAt: number | null;
  commitSubject: string | null;
  pr: { number: number | null; title: string; url: string | null } | null;
  ticket: { key: string; title: string; url: string | null } | null;
  hasMore: boolean;
};
```

- [ ] **Step 4: Typecheck** — `cd C:/gitrep/nimbus-sdk && bunx tsc --noEmit`. Expected: PASS. (If `BriefFor` or `AGENT_KIND` is missing the `why` key, tsc reports it here — the mapped/`satisfies Record<AgentName>` types are exhaustive.)

- [ ] **Step 5: Commit**
```bash
git add src/agents/brief-types.ts src/agents/brief-composites.ts src/agents/agent-names.ts
git commit -m "feat(agents): promote the why types + register the 9th agent"
```

### Task 2: `isWhyBrief` guard + exhaustive test fixtures

**Files:**
- Modify: `src/agents/brief-guards.ts`
- Modify: `src/agents/brief-guards.test.ts`, `src/agents/agent-names.test.ts`

**Interfaces produced:** `export const isWhyBrief: (x: unknown) => x is WhyBrief` and `BRIEF_GUARDS.why`.

- [ ] **Step 1: Update `agent-names.test.ts`** — the "all eight agents are listed" test now expects nine. Rename it and append `"why"`:
```ts
  test("all nine agents are listed", () => {
    expect([...AGENT_NAMES]).toEqual([
      "expert",
      "impact",
      "catchup",
      "ghost",
      "conflicts",
      "huddle",
      "janitor",
      "preflight",
      "why",
    ]);
  });
```

- [ ] **Step 2: Add the `why` fixture to `brief-guards.test.ts`** — the `FIXTURES` map is `{ [A in AgentName]: … }` (exhaustive), so tsc requires a `why` entry. Add after `preflight`:
```ts
  why: {
    brief: {
      ...base,
      kind: "why",
      query: { ref: "src/a.ts", line: null },
      subject: null,
      findings: [],
    },
    distinguishing: ["findings"],
  },
```

- [ ] **Step 3: Run the tests to verify they now FAIL** — `cd C:/gitrep/nimbus-sdk && bun test src/agents/`. Expected: FAIL — `BRIEF_GUARDS.why` does not exist yet (the loop over `AGENT_NAMES` dereferences `BRIEF_GUARDS["why"]`), and `isWhyBrief` is unresolved.

- [ ] **Step 4: Implement `isWhyBrief` in `src/agents/brief-guards.ts`** — add `WhyBrief` to the `brief-composites.js` type import, add the guard after `isPreflightBrief`, and add `why: isWhyBrief` to `BRIEF_GUARDS`:
```ts
export const isWhyBrief = createBriefGuard<WhyBrief>(
  "why",
  (b) => Array.isArray(b["findings"]),
  STRICT,
);
```
```ts
export const BRIEF_GUARDS: { [A in AgentName]: (x: unknown) => boolean } = {
  expert: isExpertBrief,
  impact: isImpactBrief,
  catchup: isCatchupBrief,
  ghost: isGhostBrief,
  conflicts: isConflictBrief,
  huddle: isHuddleBrief,
  janitor: isJanitorBrief,
  preflight: isPreflightBrief,
  why: isWhyBrief,
};
```

- [ ] **Step 5: Run tests to verify PASS** — `bun test src/agents/ && bunx tsc --noEmit`. Expected: PASS. The exhaustive loop now proves `isWhyBrief` accepts only the why fixture and rejects the other eight (kind mismatch), and rejects a why brief with `findings` deleted.

- [ ] **Step 6: Commit**
```bash
git add src/agents/brief-guards.ts src/agents/brief-guards.test.ts src/agents/agent-names.test.ts
git commit -m "feat(agents): isWhyBrief guard + exhaustive why fixtures"
```

### Task 3: Export + release SDK 1.6.0

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json` (version) — or defer to release-please

- [ ] **Step 1: Export the new symbols from `src/index.ts`** — add the types to the `@nimbus-dev/sdk`-facing export block (find the block that exports `ExpertBrief`, `AgentBrief`, etc. from `./agents/brief-composites.js` and the leaf types from `./agents/brief-types.js`) and export `isWhyBrief` alongside the other `is*Brief` guards. Add: `WhyLane`, `WhyFinding`, `WhySubject`, `WhyBrief`, `WhyPeek` (types) and `isWhyBrief` (value).

- [ ] **Step 2: Build + full test** — `cd C:/gitrep/nimbus-sdk && bun run build && bun test && bunx tsc --noEmit`. Expected: PASS + a `dist/` with the new exports. Confirm the public surface: `node -e "const s=require('./dist/index.js'); console.log(typeof s.isWhyBrief)"` → `function`.

- [ ] **Step 3: Commit + open PR**
```bash
git add src/index.ts
git commit -m "feat: export why types + isWhyBrief (sdk 1.6.0)"
git push -u origin dev/asafgolombek/why-lens-sdk-types
gh pr create --base main --title "feat: promote the why types to the SDK (1.6.0)" --body "Adds the ninth agent (why): WhyBrief into the AgentBrief union + BriefFor + AGENT_NAMES/AGENT_KIND/BRIEF_GUARDS, isWhyBrief guard, and the standalone WhyPeek. Consumed by the gateway re-export and @nimbus-dev/client 0.12.0 (why-lens step 2)."
```

- [ ] **Step 4: Merge + RELEASE + VERIFY.** After CI green + merge, ensure release-please cut `@nimbus-dev/sdk@1.6.0`. If the release PR did not cut the tag, push it manually against the merge commit. **Gate:** do not start Phase 2 until this prints a version:
```bash
npm view @nimbus-dev/sdk@1.6.0 version
```
Expected: `1.6.0`.

---

## PHASE 2 — `@nimbus-dev/client` 0.12.0

Work in `C:/gitrep/nimbus-client`. First: `cd C:/gitrep/nimbus-client && git switch -c dev/asafgolombek/why-lens-client-methods && git rev-parse --abbrev-ref HEAD`.

### Task 4: Bump SDK + add `WhyParams`

**Files:**
- Modify: `package.json` (`@nimbus-dev/sdk` → `^1.6.0`)
- Modify: `src/agents.ts`

**Interfaces produced:** `export type WhyParams = { ref: string; line?: number }` and `AgentParamsFor.why`.

- [ ] **Step 1: Bump the dep + install** — set `"@nimbus-dev/sdk": "^1.6.0"` in `package.json`, then `cd C:/gitrep/nimbus-client && bun install`. Expected: resolves 1.6.0 (published in Phase 1). If it fails, Phase 1 is not actually published — stop and fix that first.

- [ ] **Step 2: Add `WhyParams` + the params-map entry to `src/agents.ts`** — after `PreflightParams`:
```ts
export type WhyParams = { ref: string; line?: number };
```
and add `why: WhyParams;` to the `AgentParamsFor` map object.

- [ ] **Step 3: Typecheck** — `bunx tsc --noEmit`. Expected: FAIL, because `NimbusClientLike`/`MockClient` do not yet implement the `why` members that `AgentName` now admits (this surfaces the surface-parity obligation). This failure is expected and resolved in Tasks 5–6. (If you prefer a clean gate here, proceed to Task 5 before re-running tsc.)

- [ ] **Step 4: Commit**
```bash
git add package.json src/agents.ts bun.lock
git commit -m "feat(agents): WhyParams + sdk ^1.6.0"
```

### Task 5: `agentsWhy` (async brief) + `agentsWhyPeek` (synchronous)

**Files:**
- Modify: `src/nimbus-client.ts` (imports, `NimbusClientLike`, class methods)
- Modify: `src/validate.ts` (`validateWhyPeek`)

**Interfaces produced:**
```ts
agentsWhy(p: WhyParams, o?: { timeoutMs?: number }): Promise<WhyBrief>;
agentsWhyPeek(p: WhyParams): Promise<WhyPeek>;
export function validateWhyPeek(method: string, v: unknown): WhyPeek;
```

- [ ] **Step 1: Write the failing test** — `src/agents-why.test.ts`:
```ts
import { expect, test } from "bun:test";
import { MockClient } from "./mock-client.js";
import type { WhyBrief, WhyPeek } from "@nimbus-dev/sdk";
import { validateWhyPeek } from "./validate.js";

const brief: WhyBrief = {
  agentVersion: 1,
  generatedAt: 1,
  latencyMs: 1,
  gaps: [],
  kind: "why",
  query: { ref: "src/a.ts", line: 42 },
  subject: { repoRoot: "/r", filePath: "src/a.ts", lineNo: 42, symbol: null },
  findings: [],
};
const peek: WhyPeek = {
  subject: { repoRoot: "/r", filePath: "src/a.ts", lineNo: 42 },
  author: "alice",
  authorEmail: "alice@example.com",
  commitSha: "abc",
  committedAt: 1,
  commitSubject: "fix",
  pr: { number: 1, title: "PR", url: "u" },
  ticket: { key: "NIM-1", title: "T", url: "u" },
  hasMore: true,
};

test("agentsWhy resolves the mock why brief", async () => {
  const c = new MockClient({ agentBriefs: { why: brief } });
  expect(await c.agentsWhy({ ref: "src/a.ts", line: 42 })).toEqual(brief);
});

test("agentsWhyPeek resolves the mock peek", async () => {
  const c = new MockClient({ whyPeek: peek });
  expect(await c.agentsWhyPeek({ ref: "src/a.ts:42" })).toEqual(peek);
});

test("validateWhyPeek accepts a well-formed peek and is lenient about extras", () => {
  expect(validateWhyPeek("agents.whyPeek", { ...peek, futureField: 1 })).toEqual(peek);
});

test("validateWhyPeek rejects a non-boolean hasMore", () => {
  expect(() => validateWhyPeek("agents.whyPeek", { ...peek, hasMore: "yes" })).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails** — `cd C:/gitrep/nimbus-client && bun test src/agents-why.test.ts`. Expected: FAIL (`validateWhyPeek` undefined; `agentsWhy`/`agentsWhyPeek` missing; `whyPeek` fixture unknown).

- [ ] **Step 3: Add `validateWhyPeek` to `src/validate.ts`** (uses the existing `record`/`nullableStr`/`nullableNum`/`nullableBool`/`bool`/`num`/`str` helpers; lenient about extra fields like every other validator):
```ts
export function validateWhyPeek(method: string, v: unknown): WhyPeek {
  const o = record(method, v);
  const subjRaw = o["subject"];
  const subject =
    subjRaw === null
      ? null
      : (() => {
          const s = record(method, subjRaw);
          return {
            repoRoot: str(method, s, "repoRoot"),
            filePath: str(method, s, "filePath"),
            lineNo: num(method, s, "lineNo"),
          };
        })();
  const prRaw = o["pr"];
  const pr =
    prRaw === null || prRaw === undefined
      ? null
      : (() => {
          const p = record(method, prRaw);
          return {
            number: nullableNum(method, p, "number"),
            title: str(method, p, "title"),
            url: nullableStr(method, p, "url"),
          };
        })();
  const tRaw = o["ticket"];
  const ticket =
    tRaw === null || tRaw === undefined
      ? null
      : (() => {
          const t = record(method, tRaw);
          return {
            key: str(method, t, "key"),
            title: str(method, t, "title"),
            url: nullableStr(method, t, "url"),
          };
        })();
  return {
    subject,
    author: nullableStr(method, o, "author"),
    authorEmail: nullableStr(method, o, "authorEmail"),
    commitSha: nullableStr(method, o, "commitSha"),
    committedAt: nullableNum(method, o, "committedAt"),
    commitSubject: nullableStr(method, o, "commitSubject"),
    pr,
    ticket,
    hasMore: bool(method, o, "hasMore"),
  };
}
```
Add `import type { WhyPeek } from "@nimbus-dev/sdk";` to the top of `validate.ts`.

- [ ] **Step 4: Wire the client methods in `src/nimbus-client.ts`** — add imports (`WhyParams` from `./agents.js`; `WhyBrief`, `WhyPeek` from `@nimbus-dev/sdk`; `validateWhyPeek` from `./validate.js`). Add to the `NimbusClientLike` interface after `agentsPreflight`:
```ts
  agentsWhy(p: WhyParams, o?: { timeoutMs?: number }): Promise<WhyBrief>;
  agentsWhyPeek(p: WhyParams): Promise<WhyPeek>;
```
Add to the `NimbusClient` class after `agentsPreflight`:
```ts
  agentsWhy(p: WhyParams, o?: { timeoutMs?: number }): Promise<WhyBrief> {
    return this.runAgent("why", p, o);
  }
  async agentsWhyPeek(p: WhyParams): Promise<WhyPeek> {
    const raw = await this.ipc.call("agents.whyPeek", {
      ref: p.ref,
      ...(p.line === undefined ? {} : { line: p.line }),
    });
    return validateWhyPeek("agents.whyPeek", raw);
  }
```

**No `timeoutMs` on `agentsWhyPeek` (deliberate).** Unlike `agentsWhy`, whose
`timeoutMs` guards the *notification wait* for `why.briefReady` (which may never
arrive), `agentsWhyPeek` is a plain request/response — `ipc.call` already
applies the transport's **30 s default per-request timeout** (`ipc-transport.ts`,
verified), so it cannot hang, and the gateway bounds its single `git blame`
spawn at **20 s** (`BLAME_TIMEOUT_MS` + `AbortSignal.timeout`, verified). No
synchronous client method (`searchRanked`, `metricsDora`, `queryItems`, `egress*`,
…) takes a per-call `timeoutMs`; adding one only to `whyPeek` would break that
convention, not improve parity. If a per-call override is ever wanted it belongs
at the transport layer for all methods, not a `whyPeek` special case.

- [ ] **Step 5: Run to verify PASS (after Task 6's mock lands the fixtures)** — the two validator tests pass now: `bun test src/agents-why.test.ts -t validateWhyPeek`. The `agentsWhy`/`agentsWhyPeek` mock tests pass once Task 6 implements the mock. Do Task 6 next, then run the full file.

- [ ] **Step 6: Commit**
```bash
git add src/nimbus-client.ts src/validate.ts src/agents-why.test.ts
git commit -m "feat(agents): agentsWhy + agentsWhyPeek + validateWhyPeek"
```

### Task 6: Mock + full pass

**Files:**
- Modify: `src/mock-client.ts`

- [ ] **Step 1: Add the fixtures + methods to `src/mock-client.ts`.** Add `why: WhyBrief;` to the `agentBriefs` partial, add `whyPeek?: WhyPeek;` to `MockClientFixtures`, import `WhyBrief`/`WhyPeek`/`WhyParams`, and implement both methods after `agentsPreflight`:
```ts
  async agentsWhy(_p: WhyParams): Promise<WhyBrief> {
    return this.brief("why");
  }
  async agentsWhyPeek(_p: WhyParams): Promise<WhyPeek> {
    if (this.fixtures.whyPeek === undefined) {
      return Promise.reject(new Error("MockClient: no whyPeek fixture configured"));
    }
    return this.fixtures.whyPeek;
  }
```

- [ ] **Step 2: Run the full file + typecheck** — `bun test src/agents-why.test.ts && bunx tsc --noEmit`. Expected: PASS. tsc passing proves `MockClient implements NimbusClientLike` is satisfied — the surface-parity guard (both methods present on the mock).

- [ ] **Step 3: Enrich the human-facing mock fixture (high-fidelity, per the spec).** In whatever shared mock-fixtures the repo ships for consumers (grep for where `agentBriefs` example fixtures are constructed, e.g. a `examples/` or fixtures module; if none, add a `WHY_BRIEF_FIXTURE` export in `src/mock-client.ts`), provide a `WhyBrief` carrying one finding per lane and a fully-populated `WhyPeek`:
```ts
export const WHY_BRIEF_FIXTURE: WhyBrief = {
  agentVersion: 1, generatedAt: 1, latencyMs: 5, gaps: [],
  kind: "why",
  query: { ref: "src/retry.ts", line: 42 },
  subject: { repoRoot: "/repo", filePath: "src/retry.ts", lineNo: 42, symbol: "retryBackoff" },
  findings: (["authorship","pull_request","ticket","discussion","driver","downstream"] as const).map(
    (lane, i) => ({ lane, title: `${lane} finding`, detail: `${lane} detail`, url: `https://x/${lane}`, occurredAt: 1_700_000_000_000 + i, entityId: `e${i}` }),
  ),
};
```
(One rich fixture; null/empty variants stay the consumer's test to construct — YAGNI.)

- [ ] **Step 4: Full client verify** — `bun test && bunx tsc --noEmit && bunx biome check src`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/mock-client.ts
git commit -m "feat(agents): mock why brief + whyPeek (high-fidelity fixture)"
```

### Task 7: Export + release client 0.12.0

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Re-export the public why types from `src/index.ts`** — add `WhyParams` to the block that exports `ExpertParams` etc. from `./agents.js`, and add `WhyBrief`/`WhyPeek`/`WhyLane`/`WhyFinding`/`WhySubject` to the block that re-exports agent brief types from `@nimbus-dev/sdk` (so `nimbus-vscode` can name them).

- [ ] **Step 2: Full verify + build** — `cd C:/gitrep/nimbus-client && bun run build && bun test && bunx tsc --noEmit && bun run verify:sdk`. Expected: PASS (`verify:sdk` checks against the local SDK; it must be the 1.6.0 line).

- [ ] **Step 3: Commit + PR**
```bash
git add src/index.ts
git commit -m "feat: expose agents.why + agents.whyPeek (client 0.12.0, why-lens step 2)"
git push -u origin dev/asafgolombek/why-lens-client-methods
gh pr create --base main --title "feat: expose agents.why + agents.whyPeek (client 0.12.0)" --body "why-lens step 2. agentsWhy reuses runAgent (async brief); agentsWhyPeek is a new synchronous method. Depends on @nimbus-dev/sdk ^1.6.0. Mock + validateWhyPeek + high-fidelity fixture."
```

- [ ] **Step 4: Merge + RELEASE + VERIFY.** As Phase 1: confirm release-please cut `@nimbus-dev/client@0.12.0`, manual-tag if needed. **Gate:**
```bash
npm view @nimbus-dev/client@0.12.0 version
```
Expected: `0.12.0`.

---

## PHASE 3 — Gateway re-export + roadmap

Work in the existing worktree `C:/gitrep/Nimbus/.claude/worktrees/why-lens-step2` (branch `dev/asafgolombek/why-lens-step2-client-hop`). Confirm: `cd C:/gitrep/Nimbus/.claude/worktrees/why-lens-step2 && git rev-parse --abbrev-ref HEAD`.

**No Tauri change needed (verified).** `agents.why` and `agents.whyPeek` are already in the Tauri `ALLOWED_METHODS` allowlist (`packages/ui/src-tauri/src/gateway_bridge.rs`, added by #820, invariant I7) — the desktop UI can already reach them. Step 2 only changes where the *types* live and adds *client* methods; it introduces no new IPC method, so there is nothing to add to the allowlist and no `security-invariants.test.ts` count to bump.

### Task 8: Consume sdk 1.6.0 + re-export

**Files:**
- Modify: `packages/gateway/package.json` (`@nimbus-dev/sdk` → `^1.6.0`)
- Modify: `packages/gateway/src/agents/_lib/findings.ts`
- Modify: `packages/gateway/src/agents/_lib/why-types.ts`

- [ ] **Step 0: Establish the baseline green (before any change).** Confirm the why suites pass on the unchanged worktree so a post-swap failure is unambiguously yours:
```bash
cd C:/gitrep/Nimbus/.claude/worktrees/why-lens-step2
bun install   # this worktree is git-ignored and may have NO node_modules of its own;
              # install so it does not silently resolve against the PARENT repo's
              # node_modules (a known worktree trap). Re-run if a later step 404s a dep.
bun test packages/gateway/src/agents/ packages/gateway/src/ipc/agents-rpc.why.test.ts
```
Expected: PASS. Record the pass count — Step 4 must match it.

- [ ] **Step 1: Bump + install** — set `"@nimbus-dev/sdk": "^1.6.0"` in `packages/gateway/package.json`; from the **worktree root** (`C:/gitrep/Nimbus/.claude/worktrees/why-lens-step2`, not the main checkout) run `bun install`. Expected: resolves 1.6.0. If it does not, Phase 1 is not actually published on npm — stop and fix that gate first.

- [ ] **Step 2: Add the why re-exports to `findings.ts`** — add `WhyBrief`, `WhyFinding`, `WhyLane`, `WhySubject`, `WhyPeek` to the `export type { … } from "@nimbus-dev/sdk"` block, and `isWhyBrief` to the `export { … } from "@nimbus-dev/sdk"` guards block.

- [ ] **Step 3: Rewrite `why-types.ts` to re-export** — delete the local `WhyLane`/`WhyFinding`/`WhySubject`/`WhyBrief`/`WhyPeek` definitions and the `AgentBriefBase` import; keep `WhyInput` (the local request-shape). Replace the header comment. New file:
```ts
/**
 * Why-lens types.
 *
 * The result types now live in `@nimbus-dev/sdk` (promoted in step 2 / sdk
 * 1.6.0) so the gateway, CLI and `@nimbus-dev/client` share one definition.
 * Re-exported here via `findings.ts` (the gateway's SDK shim) so existing
 * gateway imports keep working unchanged. `WhyInput` stays local: it is the
 * request-params shape, not a shared result type (params are client-local for
 * every agent).
 */
export type { WhyBrief, WhyFinding, WhyLane, WhyPeek, WhySubject } from "./findings.ts";

export type WhyInput = { ref: string; line?: number };
```

- [ ] **Step 4: Verify no behavior change** — the why suites must be green unchanged, and tsc must prove the promoted shapes match the gateway's runtime producers:
```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bun test packages/gateway/src/agents/ packages/gateway/src/ipc/agents-rpc.why.test.ts packages/gateway/test/e2e/scenarios/why.e2e.test.ts
bun run audit:structure
```
Expected: PASS with the **same pass count as Step 0's baseline** and zero edits to any why test file. (tsc is the load-bearing check: if the SDK shapes drifted from `why.ts`/`why-peek.ts`'s producers, it fails here. `audit:structure` confirms no import cycle from the re-export.)

- [ ] **Step 5: Commit**
```bash
git add packages/gateway/package.json packages/gateway/src/agents/_lib/findings.ts packages/gateway/src/agents/_lib/why-types.ts bun.lock
git commit -m "refactor(agents): consume the promoted why types from @nimbus-dev/sdk ^1.6.0"
```

### Task 9: Roadmap truth-pass + gateway PR

**Files:**
- Modify: `docs/ecosystem-roadmap.md`

- [ ] **Step 1: Update `docs/ecosystem-roadmap.md`** — in Stage 2 / "2a — the `why` lens", record that the lens is now built (gateway+CLI in #820) and reachable through `@nimbus-dev/client` 0.12.0 (this PR's step-2 hop); retire the "spiked, not built / banner did not ship" framing for the *reachability* claim (keep the data-quality caveat, which #822 addresses). Add a line to the "Left open from Stage 2" list marking the client hop done. Keep edits factual and scoped.

- [ ] **Step 2: Doc gates** — `bun run audit:doc-refs && bun run audit:readme-cli && bun run lint:markdown`. Expected: PASS (markdown gate lives outside preflight — run it explicitly; see the step-1b lesson).

- [ ] **Step 3: Commit**
```bash
git add docs/ecosystem-roadmap.md
git commit -m "docs(roadmap): why lens now reachable through @nimbus-dev/client (step 2)"
```

- [ ] **Step 4: Pre-flight + PR.** Run the ship-readiness gates (tsc, biome via `bunx biome check packages scripts`, `audit:structure`, the why suites, `lint:markdown`) — see the step-1b ship-readiness playbook — then push and open the gateway PR:
```bash
git push -u origin dev/asafgolombek/why-lens-step2-client-hop
gh pr create --base main --title "refactor(agents): consume promoted why types from sdk 1.6.0 + roadmap (why-lens step 2)" --body "Gateway half of why-lens step 2: bumps @nimbus-dev/sdk to ^1.6.0, re-exports the promoted Why types from findings.ts, drops the local why-types definitions (keeps WhyInput). Pure type-move; all why suites green unchanged. Records the lens as client-reachable in the ecosystem roadmap. Follows @nimbus-dev/client 0.12.0."
```

---

## Final verification (definition of done)

- [ ] `npm view @nimbus-dev/sdk@1.6.0 version` → `1.6.0`; `npm view @nimbus-dev/client@0.12.0 version` → `0.12.0`.
- [ ] `client.agentsWhy(...)` returns a `WhyBrief`; `client.agentsWhyPeek(...)` returns a `WhyPeek`, both typed from the SDK.
- [ ] Gateway builds against sdk `^1.6.0`; `why-types.ts` re-exports; all why suites green.
- [ ] `ecosystem-roadmap.md` Stage 2a records the lens as client-reachable.
- [ ] All three PRs merged.

## Self-review notes

- **Spec coverage:** SDK promotion (Task 1–3), client `agentsWhy`/`agentsWhyPeek` + Mock + validator (Task 4–7), gateway re-export (Task 8), roadmap update (Task 9), release verification (Task 3/7 gates + Final verification) — all spec sections covered. The plan additionally captures SDK coupling the spec under-specified (`AGENT_NAMES`/`AGENT_KIND`/`BRIEF_GUARDS`/`BriefFor` + the two exhaustive SDK tests) — required because the client's `AgentName` is SDK-derived.
- **Type consistency:** `WhyParams` (client), `WhyInput` (gateway), `WhyBrief`/`WhyPeek`/`WhyFinding`/`WhyLane`/`WhySubject` + `isWhyBrief` (SDK) used consistently across tasks; method names `agentsWhy`/`agentsWhyPeek` and `validateWhyPeek` match between the interface, class, mock, and tests.
