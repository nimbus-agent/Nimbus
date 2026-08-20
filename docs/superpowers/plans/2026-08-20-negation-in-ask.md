# Negation Predicates on the Model Surfaces (W6-B.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make B.1's three negation predicates callable by a model — from `nimbus ask` (and the
desktop/VS Code surfaces that share the engine) and from external MCP clients — without letting a
model turn a substrate refusal into a confident answer.

**Architecture:** The orchestration B.1 left inside two IPC handlers moves into one module
(`index/negation-query.ts`) that the handlers and three new Mastra tools all call. Each tool records
a disclosure sentence on the per-request `AsyncLocalStorage` store **and** embeds it in its own
result payload; `runConversationalAgent` drains the store and appends the sentences at the single
site both execution paths return through, streaming the same text so the CLI and desktop answers
agree. The MCP surface reuses the existing IPC methods and inherits the orchestration for free.

**Tech Stack:** Bun 1.2+, TypeScript strict, `@mastra/core` 1.59, `bun:sqlite`, Zod (MCP tool
schemas), Biome.

**Spec:** [`docs/superpowers/specs/2026-08-20-negation-in-ask-design.md`](../specs/2026-08-20-negation-in-ask-design.md)
(read it — this plan argues from it), plus its review response
[`...-design-review-response.md`](../specs/2026-08-20-negation-in-ask-design-review-response.md).

## Global Constraints

- **No `any`.** External data is `unknown` plus a narrowing guard. `bun run audit:any --check` is a
  gate, and it counts a bare `any` **inside string literals too** — phrase user-facing text around
  the word.
- **Never commit on `main`.** Work happens on `dev/asafgolombek/w6b2-negation-in-ask`, in the
  worktree at `.claude/worktrees/w6b2-negation-in-ask`.
- **`packages/cli` must not import gateway source.** `.dependency-cruiser.cjs`'s
  `cli-no-import-gateway` is enforced by `bun run audit:boundaries` (in `preflight:fast`). The MCP
  tools reach the gateway over IPC only.
- **No new IPC method, no schema migration, no new invariant.** `ALLOWED_METHODS` stays at **105**
  (`packages/ui/src-tauri/src/gateway_bridge.rs:594`).
- **Every LLM-facing tool result is enveloped** by `wrapToolForLlm` in `engine/agent.ts:45` — new
  engine tools must be registered through it, exactly like the existing six (I11).
- **Coverage floor:** every touched file ≥85% line AND ≥80% branch (`audit:coverage-floor`,
  CI-Linux-authoritative).
- **Red-prove every guard** by deleting it and confirming the test fails. A green suite proves
  nothing about a guard.
- Before the first push: `grep -rn "file:///" --include=*.md docs/ *.md` — expected **no matches**.
  An absolute `file:///` link passes `audit:links` locally (the path exists on the authoring
  machine) and fails on the Linux runner; it has happened on three branches. Grep for `file:///`
  specifically and not for the drive path — plain-text worktree paths appear in prose all over this
  directory and are harmless, since lychee only follows links.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/engine/negation-disclosure.ts` | One definition of each disclosure sentence; record-to-ALS and drain-from-ALS |
| `packages/gateway/src/engine/negation-disclosure.test.ts` | Sentence derivation, record/drain, missing-store warning |
| `packages/gateway/src/index/negation-query.ts` | The extracted probe → refuse-or-query → count → explain sequence, one function per predicate |
| `packages/gateway/src/index/negation-query.test.ts` | The sequence, refusal and gap paths, per predicate |
| `packages/gateway/src/engine/negation-tools.ts` | The three Mastra tool definitions (kept out of the already-large `agent.ts`) |
| `packages/gateway/src/engine/negation-tools.test.ts` | Tool argument handling, refusal/gap payloads, disclosure recording |

**Modify:**

| File | Change |
| --- | --- |
| `packages/gateway/src/engine/agent-request-context.ts` | Add the optional `negationDisclosures` field |
| `packages/gateway/src/engine/agent.ts` | Register the three tools in `baseTools`; extend `toolGuidance` and `searchLocalIndex`'s description |
| `packages/gateway/src/engine/run-conversational-agent.ts` | Extract the fork into `runTurn` unchanged; append drained disclosures at the one return |
| `packages/gateway/src/engine/run-conversational-agent.test.ts` | Append-site tests, both paths, identity-when-empty |
| `packages/gateway/src/ipc/diagnostics-rpc.ts` | Call the orchestrator instead of inlining the sequence |
| `packages/gateway/src/ipc/people-rpc.ts` | Same |
| `packages/cli/src/mcp/adapter.ts` | Three new entries in `INDEX_TOOL_SPECS` |
| `packages/cli/src/mcp/adapter.test.ts` | `TOOL_SPECS` count pin 18 → 21; per-tool tests |
| `docs/CHANGELOG.md`, `docs/roadmap.md`, `CLAUDE.md`, `GEMINI.md` | Delivery record + the § 7.1 bound |

---

## Task 1: Disclosure sentences, the ALS carrier, and the fail-safe

Spec § 5.1 and § 5.1.1. This is first because everything else depends on it, and because its risk
is the one that fails silently.

**Files:**

- Create: `packages/gateway/src/engine/negation-disclosure.ts`
- Create: `packages/gateway/src/engine/negation-disclosure.test.ts`
- Modify: `packages/gateway/src/engine/agent-request-context.ts`

**Interfaces:**

- Consumes: `agentRequestContext` from `engine/agent-request-context.ts`.
- Produces: `negationDisclosureLine(input: NegationDisclosureInput): string | undefined`,
  `recordNegationDisclosure(line: string): void`, `drainNegationDisclosures(): string[]`, and the
  `NegationDisclosureInput` union. Task 3 calls the first two; Task 4 calls the third.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/engine/negation-disclosure.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { agentRequestContext } from "./agent-request-context.ts";
import {
  drainNegationDisclosures,
  negationDisclosureLine,
  recordNegationDisclosure,
} from "./negation-disclosure.ts";

describe("negationDisclosureLine", () => {
  test("a refusal names the tool, the reason and the remediation", () => {
    const line = negationDisclosureLine({
      kind: "refused",
      tool: "findPrsNotTouching",
      message: "no PR file-coverage data is indexed, so which PRs do not touch a path cannot be verified",
      remediation: "sync a connector that populates PR changed-file coverage (GitHub/GitLab), then retry",
    });
    expect(line).toContain("findPrsNotTouching");
    expect(line).toContain("could not be verified");
    expect(line).toContain("no PR file-coverage data is indexed");
    expect(line).toContain("sync a connector");
  });

  test("exclusions are reported per reason, never summed", () => {
    const line = negationDisclosureLine({
      kind: "excluded",
      tool: "findPrsNotTouching",
      counts: [
        { label: "no file coverage indexed", n: 12 },
        { label: "file coverage truncated", n: 3 },
      ],
    });
    expect(line).toContain("12 excluded (no file coverage indexed)");
    expect(line).toContain("3 excluded (file coverage truncated)");
    expect(line).not.toContain("15");
  });

  test("a zero-count exclusion set produces NO line — nothing was withheld", () => {
    expect(
      negationDisclosureLine({
        kind: "excluded",
        tool: "findDeploymentsWithoutIncident",
        counts: [{ label: "no graph entity of the required type", n: 0 }],
      }),
    ).toBeUndefined();
  });

  test("a zero count alongside a non-zero one is omitted, not printed as 0", () => {
    const line = negationDisclosureLine({
      kind: "excluded",
      tool: "findPrsNotTouching",
      counts: [
        { label: "no file coverage indexed", n: 4 },
        { label: "file coverage truncated", n: 0 },
      ],
    });
    expect(line).toContain("4 excluded (no file coverage indexed)");
    expect(line).not.toContain("truncated");
  });
});

describe("record / drain", () => {
  test("records inside a request scope and drains read-once", async () => {
    await agentRequestContext.run({}, async () => {
      recordNegationDisclosure("first");
      recordNegationDisclosure("second");
      expect(drainNegationDisclosures()).toEqual(["first", "second"]);
      // Read-once: a second drain in the SAME scope must not re-emit what was already shown.
      expect(drainNegationDisclosures()).toEqual([]);
    });
  });

  test("two request scopes do not see each other's disclosures", async () => {
    await agentRequestContext.run({}, async () => {
      recordNegationDisclosure("turn-A");
    });
    await agentRequestContext.run({}, async () => {
      expect(drainNegationDisclosures()).toEqual([]);
    });
  });

  test("recording with NO request scope does not throw and drains empty", () => {
    // The fail-safe path (spec § 5.1.1): the tool payload still carries the sentence, so this
    // degrades to the MCP-level guarantee rather than to silence.
    expect(() => recordNegationDisclosure("orphan")).not.toThrow();
    expect(drainNegationDisclosures()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/engine/negation-disclosure.test.ts`
Expected: FAIL — `Cannot find module './negation-disclosure.ts'`.

- [ ] **Step 3: Add the field to the request context**

Modify `packages/gateway/src/engine/agent-request-context.ts`:

```ts
export type AgentRequestContext = {
  sessionId?: string | undefined;
  /**
   * Disclosure sentences recorded by negation tools during this turn, drained and appended by
   * `runConversationalAgent`. Created LAZILY by `recordNegationDisclosure` rather than
   * initialised where the store is built: `ipc/server/inline-handlers.ts` constructs the store
   * in THREE places (`engine.ask` :96, `workflow.run` :215, the `engine.askStream` dispatcher
   * :350), and a field that had to be initialised at each would eventually be initialised at
   * some.
   */
  negationDisclosures?: string[];
};
```

- [ ] **Step 4: Write the implementation**

Create `packages/gateway/src/engine/negation-disclosure.ts`:

```ts
import pino from "pino";

import { agentRequestContext } from "./agent-request-context.ts";

const disclosureLog = pino({
  name: "negation-disclosure",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export type NegationDisclosureInput =
  | { kind: "refused"; tool: string; message: string; remediation: string }
  | { kind: "excluded"; tool: string; counts: ReadonlyArray<{ label: string; n: number }> };

/**
 * ONE definition of each disclosure sentence, read by the tool (which embeds it in its own
 * payload) and by the append site (which shows it to the user whatever the model did). The
 * `agents/_lib/brief-disclosures.ts` shape: one definition, two readers, so the two cannot drift.
 *
 * Returns `undefined` when there is nothing to disclose — an all-zero exclusion set means nothing
 * was withheld, and a line claiming "0 excluded" would imply a shortfall that did not happen.
 */
export function negationDisclosureLine(input: NegationDisclosureInput): string | undefined {
  if (input.kind === "refused") {
    return `${input.tool} could not be verified: ${input.message}. ${input.remediation}.`;
  }
  const parts = input.counts
    .filter((c) => c.n > 0)
    .map((c) => `${String(c.n)} excluded (${c.label})`);
  if (parts.length === 0) {
    return undefined;
  }
  return `${input.tool}: ${parts.join("; ")} — absent from the answer above rather than counted as matching.`;
}

/**
 * Push a sentence onto the current turn's store. A missing store is NOT an error: the tool has
 * already embedded the same sentence in its result payload (spec § 5.1.1), so the guarantee
 * degrades to "the model saw it" rather than to silence. It is logged because a turn that
 * silently lost its context is worth knowing about.
 */
export function recordNegationDisclosure(line: string): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) {
    disclosureLog.warn(
      { line },
      "negation disclosure not recorded: no agent request context on this turn",
    );
    return;
  }
  const arr = store.negationDisclosures ?? [];
  arr.push(line);
  store.negationDisclosures = arr;
}

/**
 * Read AND CLEAR. Draining rather than reading is what stops a store reused within one dispatch
 * frame — a sub-agent turn, a retry — from re-emitting a disclosure the user has already seen.
 */
export function drainNegationDisclosures(): string[] {
  const arr = agentRequestContext.getStore()?.negationDisclosures;
  if (arr === undefined || arr.length === 0) {
    return [];
  }
  return arr.splice(0, arr.length);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/gateway/src/engine/negation-disclosure.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Prove ALS reaches a tool retrieved from a REAL Mastra agent**

This is the part of the risk that CI **can** retire (spec § 5.1.1). Append to
`packages/gateway/src/engine/negation-disclosure.test.ts`:

```ts
import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";

test("a tool retrieved from a real Mastra Agent sees the request store", async () => {
  const probe = createTool({
    id: "alsProbe",
    description: "test-only probe",
    execute: async () => {
      recordNegationDisclosure("sentinel");
      return { ok: true };
    },
  });
  const agent = new Agent({
    id: "als-probe-agent",
    name: "ALS Probe",
    instructions: "test-only",
    model: "openai/gpt-4o-mini",
    tools: { alsProbe: probe },
  });
  const tools = (await agent.getTools()) as Record<string, { execute: (i: unknown) => Promise<unknown> }>;
  const fromAgent = tools["alsProbe"];
  expect(fromAgent).toBeDefined();

  const drained = await agentRequestContext.run({}, async () => {
    await fromAgent?.execute({});
    return drainNegationDisclosures();
  });
  expect(drained).toEqual(["sentinel"]);
});
```

If `agent.getTools()` is not the accessor on `@mastra/core` 1.59, copy the retrieval used by
`getTool` in `packages/gateway/src/engine/agent.test.ts:47` (`listAgentTools`) rather than
inventing one. **No live model is called** — the tool is executed directly after being retrieved
through the Agent, which is the part Mastra mediates and CI can reach. Constructing an `Agent` with
`model: "openai/gpt-4o-mini"` touches no network and needs no `OPENAI_API_KEY`; `agent.test.ts`
already does it throughout and passes in CI.

**If construction ever does throw, the fallback ladder is: (1) real `Agent`, as written; (2) a mock
model PROVIDER passed to a real `Agent`; (3) declare it not provable in CI and fall back to the
spec's § 5.1.1 table.** Never a fake `Agent` object. This step's entire subject is whether a tool
retrieved *through Mastra* sees the store, so substituting a hand-built agent deletes the thing
under test and leaves a green test that proves nothing. (`fakeConversationalAgent` in
`packages/gateway/src/engine/run-ask.test.ts:46` is the right tool for `run-ask.test.ts`, whose
subject is the caller, and the wrong one here.)

- [ ] **Step 7: Run it**

Run: `bun test packages/gateway/src/engine/negation-disclosure.test.ts`
Expected: PASS, 8 tests. **If the sentinel does not arrive, STOP and report** — do not start Task 3.
The spec's § 5.1.1 table is the fallback contract, and a failure here means the append half of the
design is dead and only the payload half survives.

- [ ] **Step 8: Red-prove the drain**

Change `arr.splice(0, arr.length)` to `arr.slice(0, arr.length)` (read, not clear) and run the
tests. Expected: the "drains read-once" case FAILS. Restore the `splice`.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/engine/negation-disclosure.ts \
        packages/gateway/src/engine/negation-disclosure.test.ts \
        packages/gateway/src/engine/agent-request-context.ts
git commit -F - <<'EOF'
feat(engine): negation disclosure sentences carried on the request store

One definition per sentence, read by the tool that embeds it in its own
payload and by the append site that shows it whatever the model did.

Drain is read-AND-CLEAR so a store reused inside one dispatch frame
cannot re-emit a disclosure already shown, and a missing store warns
rather than throwing: the tool payload still carries the sentence, so
the guarantee degrades to the MCP-level one instead of to silence.

An all-zero exclusion set produces NO line - "0 excluded" would imply a
shortfall that did not happen.
EOF
```

---

## Task 2: Extract the orchestration into `index/negation-query.ts`

Spec § 4. Pure refactor: the two IPC handlers must behave identically afterwards, proven by their
existing tests staying green without modification.

**Files:**

- Create: `packages/gateway/src/index/negation-query.ts`
- Create: `packages/gateway/src/index/negation-query.test.ts`
- Modify: `packages/gateway/src/ipc/diagnostics-rpc.ts` (the two negation branches in
  `rpcIndexQueryItems`)
- Modify: `packages/gateway/src/ipc/people-rpc.ts` (the `notReviewed` branch in `rpcPeopleList`)

**Interfaces:**

- Consumes: everything `index/negation-predicates.ts` already exports —
  `probePrFileCoverage(db)`, `probeCorrelatesWith(db)`, `probeReviewed(db, sinceMs?)`,
  `buildNotTouchingSql(pathGlob)`, `buildNoDownstreamIncidentSql()`, `buildNotReviewedSql(sinceMs)`,
  `toPositionalSubquery({sql, vals})`, `countNotTouchingExclusions(db, scope?)`,
  `countNoDownstreamIncidentExclusions(db, scope?)`, `countNotReviewedExclusions(db, scope?)`,
  `missingSubstrateRefusal(message, remediation, explainBlock)`, and the types `NegationExplain`,
  `MissingSubstrateRefusal`, `NegationGaps`.
- Produces: `NegationOutcome<Row>`, `runNotTouchingQuery`, `runNoDownstreamIncidentQuery`,
  `runNotReviewedQuery`. Task 3 calls all three.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/negation-query.test.ts`. Build the fixture with the SAME
production writers the existing RPC tests use (`recordPrChangedFiles`, `upsertGraphEntity`,
`upsertGraphRelation`) — copy the seed helpers from
`packages/gateway/src/ipc/diagnostics-rpc.test.ts:74-130` rather than hand-rolling INSERTs:

```ts
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "./local-index.ts";
import { runNotTouchingQuery } from "./negation-query.ts";
// plus the seed helpers copied from diagnostics-rpc.test.ts

describe("runNotTouchingQuery", () => {
  test("refuses when no PR file coverage is indexed", () => {
    const { index, db } = freshIndex();
    const out = runNotTouchingQuery(db, index, { pathGlob: "tests/**", limit: 20 });
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(out.refusal.reason).toBe("missing_substrate");
    expect(out.refusal.message).toContain("no PR file-coverage data is indexed");
    db.close();
  });

  test("returns rows plus per-reason gap counts when the substrate exists", () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "touches-src", ["src/a.ts"]);
    seedCoveredPr(db, "touches-tests", ["tests/a.test.ts"]);
    seedUncoveredPr(db, "unfetched");
    const out = runNotTouchingQuery(db, index, { pathGlob: "tests/**", limit: 20 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.rows.map((r) => r.id)).toEqual(["touches-src"]);
    expect(out.gaps).toEqual({ excludedNoCoverage: 1, excludedTruncated: 0 });
    db.close();
  });

  test("explain carries the COMPOSED sql and the substrate probe, not the bare predicate", () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    const out = runNotTouchingQuery(db, index, { pathGlob: "tests/**", limit: 7, explain: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.explain?.sql).toContain("LIMIT ?");
    expect(out.explain?.substrate?.passed).toBe(true);
    db.close();
  });

  test("no explain requested means no explain block", () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    const out = runNotTouchingQuery(db, index, { pathGlob: "tests/**", limit: 20 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.explain).toBeUndefined();
    db.close();
  });
});
```

Write the equivalent four cases for `runNoDownstreamIncidentQuery` (substrate =
`probeCorrelatesWith`, gaps = `{ excludedNoGraphEntity }`, seeds =
`seedDeploymentWithIncident` / `seedDeploymentWithoutIncident` / `seedDeploymentNoGraphEntity`) and
for `runNotReviewedQuery` (substrate = windowed `probeReviewed`, rows via `listPersons`, gaps =
`{ excludedNoGraphEntity }`).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/index/negation-query.test.ts`
Expected: FAIL — `Cannot find module './negation-query.ts'`.

- [ ] **Step 3: Write the module**

Create `packages/gateway/src/index/negation-query.ts`. Move the sequences out of the two handlers
**verbatim** — same probes, same refusal strings, same composed-SQL construction, same gap scoping:

```ts
import type { Database } from "bun:sqlite";

// NOTE: `IndexedItem` is defined in TWO places — `index/local-index.ts:65`
// (`NimbusItem & { indexPrimaryKey: string }`, what `listItems` returns) and
// `embedding/types.ts:1` (a different shape entirely). Import the FORMER. An editor
// auto-import will offer the latter first.
import type { IndexedItem } from "./local-index.ts";
import { buildItemListSql, type ItemListQueryParams } from "./item-list-query.ts";
import {
  buildNoDownstreamIncidentSql,
  buildNotReviewedSql,
  buildNotTouchingSql,
  countNoDownstreamIncidentExclusions,
  countNotReviewedExclusions,
  countNotTouchingExclusions,
  missingSubstrateRefusal,
  type MissingSubstrateRefusal,
  type NegationExplain,
  probeCorrelatesWith,
  probePrFileCoverage,
  probeReviewed,
  toPositionalSubquery,
} from "./negation-predicates.ts";

export type NegationOutcome<Row, Gaps> =
  | { readonly kind: "refused"; readonly refusal: MissingSubstrateRefusal }
  | {
      readonly kind: "ok";
      readonly rows: Row[];
      readonly gaps: Gaps;
      readonly explain?: NegationExplain;
    };

/**
 * The subset of `LocalIndex` this module needs, so a test can pass a real index and the module
 * does not depend on the class. `LocalIndex.listItems` (`index/local-index.ts:752`) satisfies it
 * structurally.
 */
type ItemLister = { listItems(params: ItemListQueryParams): IndexedItem[] };

export type NotTouchingParams = {
  readonly pathGlob: string;
  readonly services?: readonly string[];
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit: number;
  readonly explain?: boolean;
};

export function runNotTouchingQuery(
  db: Database,
  index: ItemLister,
  params: NotTouchingParams,
): NegationOutcome<IndexedItem, { excludedNoCoverage: number; excludedTruncated: number }> {
  const types = ["pr"] as const;
  const baseParams: ItemListQueryParams = {
    ...(params.services === undefined ? {} : { services: params.services }),
    types,
    ...(params.sinceMs === undefined ? {} : { sinceMs: params.sinceMs }),
    ...(params.untilMs === undefined ? {} : { untilMs: params.untilMs }),
    limit: params.limit,
  };
  const probeResult = probePrFileCoverage(db);
  const idInSql = toPositionalSubquery(buildNotTouchingSql(params.pathGlob));
  const composed = buildItemListSql({ ...baseParams, idInSql });
  if (!probeResult.passed) {
    return {
      kind: "refused",
      refusal: missingSubstrateRefusal(
        "no PR file-coverage data is indexed, so which PRs do not touch a path cannot be verified",
        "sync a connector that populates PR changed-file coverage (GitHub/GitLab), then retry",
        params.explain === true
          ? { sql: composed.sql, params: composed.vals, substrate: probeResult }
          : undefined,
      ),
    };
  }
  const rows = index.listItems({ ...baseParams, idInSql });
  const gaps = countNotTouchingExclusions(db, {
    ...(params.services === undefined ? {} : { services: params.services }),
    types,
  });
  return {
    kind: "ok",
    rows,
    gaps,
    ...(params.explain === true
      ? { explain: { sql: composed.sql, params: composed.vals, substrate: probeResult } }
      : {}),
  };
}
```

Write `runNoDownstreamIncidentQuery` the same way (types `["deployment"]`,
`probeCorrelatesWith`, `buildNoDownstreamIncidentSql()`, `countNoDownstreamIncidentExclusions`,
refusal text *"no `correlates_with` edges are indexed, so which deployments have no downstream
incident cannot be verified"* / *"run a sync that populates deployment-to-incident correlation,
then retry"*), and `runNotReviewedQuery` (`probeReviewed(db, sinceMs ?? 0)`, `buildNotReviewedSql`,
`buildPersonListSql`, `listPersons`, `countNotReviewedExclusions(db, { unlinkedOnly })`, refusal
text *"no `reviewed` edges are indexed within the --since window, so who has not reviewed anything
in that window cannot be verified"* / *"widen --since to include older reviews, or sync a connector
that populates PR review activity and run nimbus index regraph"*).

**Copy the refusal strings exactly** — `packages/cli/src/commands/*.test.ts` and the RPC tests
assert on them.

- [ ] **Step 4: Run the new tests**

Run: `bun test packages/gateway/src/index/negation-query.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 4b: Make the `--since` remediation surface-neutral**

B.1 wrote its remediations for the CLI, which was right when the CLI was the only caller. **B.2 is
what breaks that**: this same string now reaches a model answering in `nimbus ask` and an external
MCP client, neither of which has a `--since` flag, so it would tell those users to widen something
that does not exist where they are. Fixed at the single definition, in the orchestrator, so no
per-surface copy can drift:

```ts
        "widen the time window (`--since` on the CLI, `sinceDays` on the tool surfaces) to " +
          "include older reviews, or sync a connector that populates PR review activity and run " +
          "nimbus index regraph",
```

Then update the two assertions that pin the old wording — these are **expected** test edits, which
is why this is its own step and not part of Step 5/6, whose contract is that no existing test
changes:

- `packages/cli/src/commands/people.test.ts:580` — the full remediation string in the fixture.
- `packages/cli/src/commands/people.test.ts:590` — `expect(out.stderr).toContain("widen --since")`
  becomes `toContain("widen the time window")`. Keep an assertion that `--since` still appears
  somewhere in the remediation, so the CLI's own advice cannot be lost while making it portable.

- [ ] **Step 5: Rewire `rpcIndexQueryItems` to call the orchestrator**

In `packages/gateway/src/ipc/diagnostics-rpc.ts`, keep every `-32602` validation and the
both-predicates rejection exactly as they are; replace the two negation BRANCHES with calls:

```ts
if (notTouching !== undefined) {
  const outcome = runNotTouchingQuery(db, requireLocalIndex(ctx), {
    pathGlob: notTouching,
    ...(services.length > 0 ? { services } : {}),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
    limit,
    explain,
  });
  if (outcome.kind === "refused") {
    return { kind: "hit", value: outcome.refusal };
  }
  return {
    kind: "hit",
    value: {
      items: outcome.rows,
      meta: { limit, total: outcome.rows.length },
      gaps: outcome.gaps,
      ...(outcome.explain === undefined ? {} : { explain: outcome.explain }),
    },
  };
}
```

- [ ] **Step 6: Rewire `rpcPeopleList` the same way**, keeping its clamped `limit`, its
`unlinkedOnly` handling, its `personToJson(p, countItemsByAuthor(db, p.id))` mapping and its
bare-array plain path untouched.

- [ ] **Step 7: Prove the refactor changed nothing**

Run: `bun test packages/gateway/src/ipc/diagnostics-rpc.test.ts packages/gateway/src/ipc/people-rpc.test.ts packages/gateway/src/index packages/cli/src/commands/query.test.ts packages/cli/src/commands/people.test.ts`
Expected: PASS with the **same counts as before the refactor**, and **zero edits to those test files
beyond the two lines Step 4b names**. If any other test needed changing, the refactor was not
behaviour-preserving — revert and redo.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/index/negation-query.ts \
        packages/gateway/src/index/negation-query.test.ts \
        packages/gateway/src/ipc/diagnostics-rpc.ts \
        packages/gateway/src/ipc/people-rpc.ts
git commit -F - <<'EOF'
refactor(index): extract the negation orchestration from the two IPC handlers

Probe, refuse-or-query, count, explain now live in one module that three
consumers share. Wire-shaped validation stays in the RPC layer: the
-32602 rejections are about untrusted JSON-RPC records, and pulling them
down here would drag DiagnosticsRpcError and the {kind:"hit"} outcome
shape into a module the engine has to import.

Behaviour-preserving by construction: both handlers' test files are
untouched and green.
EOF
```

---

## Task 3: The three Mastra tools

Spec § 1, § 5.1, § 6.

**Files:**

- Create: `packages/gateway/src/engine/negation-tools.ts`
- Create: `packages/gateway/src/engine/negation-tools.test.ts`
- Modify: `packages/gateway/src/engine/agent.ts`

**Interfaces:**

- Consumes: Task 1's `negationDisclosureLine` / `recordNegationDisclosure`; Task 2's three
  `run*Query` functions.
- Produces: `createNegationTools(deps: { localIndex: LocalIndex }): Record<string, ReturnType<typeof createTool>>`
  with keys `findPrsNotTouching`, `findDeploymentsWithoutIncident`, `findPeopleWithoutReviews`.
  Task 4 depends on nothing here; `agent.ts` registers them.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/engine/negation-tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { agentRequestContext } from "./agent-request-context.ts";
import { drainNegationDisclosures } from "./negation-disclosure.ts";
import { createNegationTools } from "./negation-tools.ts";
// freshIndex + seed helpers as in Task 2

describe("findPrsNotTouching", () => {
  test("a missing pathGlob is an error result, never an unfiltered answer", async () => {
    const { index, db } = freshIndex();
    const tools = createNegationTools({ localIndex: index });
    const out = (await tools["findPrsNotTouching"]?.execute?.({})) as { error?: string };
    expect(out.error).toContain("pathGlob is required");
    db.close();
  });

  test("a refusal records a disclosure AND embeds it in the payload", async () => {
    const { index, db } = freshIndex(); // no pr_files_state rows at all
    const tools = createNegationTools({ localIndex: index });
    const drained = await agentRequestContext.run({}, async () => {
      const out = (await tools["findPrsNotTouching"]?.execute?.({ pathGlob: "tests/**" })) as {
        refused?: boolean;
        disclosure?: string;
      };
      expect(out.refused).toBe(true);
      // Fail-safe (spec 5.1.1): the sentence is in the payload the model sees, not only in ALS.
      expect(out.disclosure).toContain("findPrsNotTouching could not be verified");
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("no PR file-coverage data is indexed");
    db.close();
  });

  test("exclusions are recorded; a clean result records nothing", async () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "touches-src", ["src/a.ts"]);
    seedUncoveredPr(db, "unfetched");
    const tools = createNegationTools({ localIndex: index });
    const drained = await agentRequestContext.run({}, async () => {
      await tools["findPrsNotTouching"]?.execute?.({ pathGlob: "tests/**" });
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("1 excluded (no file coverage indexed)");

    const clean = freshIndex();
    seedCoveredPr(clean.db, "only-covered", ["src/a.ts"]);
    const cleanTools = createNegationTools({ localIndex: clean.index });
    const none = await agentRequestContext.run({}, async () => {
      await cleanTools["findPrsNotTouching"]?.execute?.({ pathGlob: "tests/**" });
      return drainNegationDisclosures();
    });
    expect(none).toEqual([]);
    clean.db.close();
    db.close();
  });

  test("no itemType parameter exists — the type scope is intrinsic", async () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('github:issue-1','github','issue','i1','an issue',0,0)`,
    );
    const tools = createNegationTools({ localIndex: index });
    const out = (await tools["findPrsNotTouching"]?.execute?.({
      pathGlob: "tests/**",
      itemType: "issue", // ignored: not part of the schema
    })) as { items?: Array<{ id: string }> };
    expect(out.items?.map((i) => i.id)).toEqual(["p1"]);
    db.close();
  });
});
```

Add the equivalent refusal + exclusion cases for `findDeploymentsWithoutIncident` and
`findPeopleWithoutReviews`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/engine/negation-tools.test.ts`
Expected: FAIL — `Cannot find module './negation-tools.ts'`.

- [ ] **Step 3: Write the tools**

Create `packages/gateway/src/engine/negation-tools.ts`. Kept out of `agent.ts` because that file is
already ~500 lines of tool definitions; these three belong together and change together.

**★ Every description MUST name its parameters in prose.** No engine tool in this codebase uses
Mastra's `inputSchema` — verified: `grep -rn "inputSchema" packages/gateway/src/engine/*.ts` returns
nothing — so the description and `toolGuidance` are the **only** places the model learns which
arguments exist. `fetchMoreIndexResults` sets the convention by spelling its signature out in
`toolGuidance`. A tool whose one required argument is never named is a tool the model calls wrong
and gets an error from, which then reads as the model being bad at the task.

**`findPeopleWithoutReviews` takes `sinceDays: number`, not a duration string and not an epoch.**
A duration string (`"7d"`) would need a parser, and the gateway has none — `parseSinceDurationToMs`
lives in `packages/cli/src/lib/parse-since.ts`, and B.1's spec § 4.3 explicitly refused to write a
second one, because two parsers that disagree about `7d` is a silent cross-surface bug. An epoch
millisecond is what `people.list` wants but is a hostile thing to ask a model to compute. So the
tool takes days-back and converts at its own boundary:
`sinceMs: Date.now() - sinceDays * 86_400_000`. Omitting it still means "ever".

```ts
import { createTool } from "@mastra/core/tools";

import type { LocalIndex } from "../index/local-index.ts";
import {
  runNoDownstreamIncidentQuery,
  runNotReviewedQuery,
  runNotTouchingQuery,
} from "../index/negation-query.ts";
import { negationDisclosureLine, recordNegationDisclosure } from "./negation-disclosure.ts";

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function optTrimmed(q: Record<string, unknown>, k: string): string | undefined {
  const v = q[k];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function optLimit(q: Record<string, unknown>): number {
  const v = q["limit"];
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(500, Math.max(1, Math.floor(v)))
    : 20;
}

/**
 * Emit the refusal payload AND record the same sentence. Both, always: the recorded copy is what
 * the user sees regardless of the model (spec § 5.1), and the embedded copy is what keeps the
 * guarantee from degrading to silence if the request store is missing (§ 5.1.1).
 */
function refusalResult(
  tool: string,
  refusal: { message: string; remediation: string; reason: string },
): Record<string, unknown> {
  const line = negationDisclosureLine({
    kind: "refused",
    tool,
    message: refusal.message,
    remediation: refusal.remediation,
  });
  if (line !== undefined) recordNegationDisclosure(line);
  return {
    refused: true,
    reason: refusal.reason,
    message: refusal.message,
    remediation: refusal.remediation,
    disclosure: line,
    note: "Do not answer the question from ranked search instead. The data needed to verify this negation is not indexed, so any list you produce would be an artifact of the missing data rather than an answer.",
  };
}

function withExclusions(
  tool: string,
  counts: ReadonlyArray<{ label: string; n: number }>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const line = negationDisclosureLine({ kind: "excluded", tool, counts });
  if (line === undefined) return payload;
  recordNegationDisclosure(line);
  return { ...payload, disclosure: line };
}

export function createNegationTools(deps: { localIndex: LocalIndex }) {
  const findPrsNotTouching = createTool({
    id: "findPrsNotTouching",
    description:
      "findPrsNotTouching(pathGlob, service?, limit?) — pull requests with NO indexed changed-file path matching pathGlob (a GLOB such as 'tests/**'; required). Use this, never searchLocalIndex, when the question is which PRs do NOT touch something: it proves its substrate first and refuses when PR file coverage is not indexed, because an unfetched PR is indistinguishable from one that genuinely never touched the path. Scoped to pull requests intrinsically — there is no itemType argument. service is optional; omitting it searches every indexed forge.",
    execute: async (inputData: unknown) => {
      const q = asRecord(inputData);
      const pathGlob = optTrimmed(q, "pathGlob");
      if (pathGlob === undefined) {
        return { error: "pathGlob is required (a GLOB pattern such as 'tests/**')" };
      }
      const service = optTrimmed(q, "service");
      const db = deps.localIndex.getDatabase();
      const outcome = runNotTouchingQuery(db, deps.localIndex, {
        pathGlob,
        ...(service === undefined ? {} : { services: [service] }),
        limit: optLimit(q),
      });
      if (outcome.kind === "refused") {
        return refusalResult("findPrsNotTouching", outcome.refusal);
      }
      return withExclusions(
        "findPrsNotTouching",
        [
          { label: "no file coverage indexed", n: outcome.gaps.excludedNoCoverage },
          { label: "file coverage truncated", n: outcome.gaps.excludedTruncated },
        ],
        { items: outcome.rows, gaps: outcome.gaps },
      );
    },
  });
  // findDeploymentsWithoutIncident(service?, limit?) and
  // findPeopleWithoutReviews(sinceDays?, limit?) follow the same shape, and their descriptions
  // open with that same signature line for the reason given above.
  //
  // The deployment tool's description must state that the correlation window is FIXED at write
  // time and cannot be widened per query — there is deliberately no `within` argument, because
  // the edge timestamp is a WRITE time, not an event time, so a query-time window cannot be
  // reconstructed even in principle.
  //
  // The people tool converts at its own boundary and defaults to "ever":
  //   const sinceDays = typeof q["sinceDays"] === "number" && Number.isFinite(q["sinceDays"])
  //     ? Math.max(0, Math.floor(q["sinceDays"]))
  //     : undefined;
  //   const sinceMs = sinceDays === undefined ? undefined : Date.now() - sinceDays * 86_400_000;
  return { findPrsNotTouching /* , … */ };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/engine/negation-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the tools and steer away from the wrong one**

In `packages/gateway/src/engine/agent.ts`, spread the three into `baseTools` **through
`wrapToolForLlm`** (I11 — an unwrapped tool would hand raw output to the model):

```ts
const negationTools = createNegationTools({ localIndex: deps.localIndex });
const baseTools = {
  searchLocalIndex: wrapToolForLlm("index", "searchLocalIndex", searchLocalIndex, deps.auditDb),
  // … existing five …
  findPrsNotTouching: wrapToolForLlm(
    "index",
    "findPrsNotTouching",
    negationTools.findPrsNotTouching,
    deps.auditDb,
  ),
  // … the other two …
};
```

Append to `searchLocalIndex`'s `description` (spec § 6):

```text
 It ranks and returns items that MATCH; it cannot answer which items do NOT match. For a negation — PRs that don't touch a path, deployments with no downstream incident, people who haven't reviewed — use findPrsNotTouching, findDeploymentsWithoutIncident or findPeopleWithoutReviews, which prove their substrate before answering.
```

Append to `toolGuidance`:

```text
 For a negative question ("which X did NOT ..."), use findPrsNotTouching(pathGlob, service?, limit?), findDeploymentsWithoutIncident(service?, limit?) or findPeopleWithoutReviews(sinceDays?, limit?) rather than searchLocalIndex: only they prove the underlying data exists, and only they can tell "nothing matched" apart from "nothing was indexed". If one of them refuses, say so and stop — do not substitute a ranked search.
```

- [ ] **Step 6: Run the engine tests**

Run: `bun test packages/gateway/src/engine`
Expected: PASS. A count assertion over `baseTools` may need updating from 6/8 to 9/11 — update the
number, never the assertion's shape.

- [ ] **Step 7: Red-prove the refusal path**

In `runNotTouchingQuery`, temporarily change `if (!probeResult.passed)` to `if (false)` and run
`bun test packages/gateway/src/engine/negation-tools.test.ts`. Expected: the refusal test FAILS.
Restore.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/engine/negation-tools.ts \
        packages/gateway/src/engine/negation-tools.test.ts \
        packages/gateway/src/engine/agent.ts
git commit -F - <<'EOF'
feat(engine): three negation tools on the conversational agent

findPrsNotTouching, findDeploymentsWithoutIncident and
findPeopleWithoutReviews, registered through wrapToolForLlm like every
other tool so their results are enveloped (I11).

Type scoping is intrinsic rather than validated: each tool hardcodes its
item type, so the guard B.1 had to enforce on the CLI cannot be violated
here - there is no itemType parameter to get wrong.

Each tool records its disclosure AND embeds it in its own payload, and a
refusal payload carries an explicit instruction not to substitute a
ranked search. searchLocalIndex's description now says it cannot answer
which items do NOT match.
EOF
```

---

## Task 4: Append the disclosures where both execution paths return

Spec § 5.1. **The existing control flow moves unchanged** — see the review response: the fallback
and the narrowing are behaviour, not scaffolding.

**Files:**

- Modify: `packages/gateway/src/engine/run-conversational-agent.ts`
- Modify: `packages/gateway/src/engine/run-conversational-agent.test.ts`

**Interfaces:**

- Consumes: Task 1's `drainNegationDisclosures()`.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/engine/run-conversational-agent.test.ts`:

```ts
import { agentRequestContext } from "./agent-request-context.ts";
import { recordNegationDisclosure } from "./negation-disclosure.ts";

describe("negation disclosures", () => {
  test("non-stream: the disclosure is appended to the reply", async () => {
    const agent = { generate: mock(async () => ({ text: "ok" })) } as unknown as Agent;
    const r = await agentRequestContext.run({}, async () => {
      recordNegationDisclosure("findPrsNotTouching could not be verified: no data. sync it.");
      return runConversationalAgent({ agent, input: "hi", stream: false, sendChunk: () => {} });
    });
    expect(r.reply).toContain("ok");
    expect(r.reply).toContain("findPrsNotTouching could not be verified");
  });

  test("stream: the SAME text is streamed and returned — the UI cannot show less than the CLI", async () => {
    const chunks: string[] = [];
    const agent = {
      stream: mock(async () => ({
        fullStream: mockAgentTextDeltaStream(),
        text: Promise.resolve("full"),
      })),
    } as unknown as Agent;
    const r = await agentRequestContext.run({}, async () => {
      recordNegationDisclosure("D1");
      return runConversationalAgent({
        agent,
        input: "hi",
        stream: true,
        sendChunk: (t) => chunks.push(t),
      });
    });
    expect(chunks.join("")).toContain("D1");
    expect(r.reply).toContain("D1");
  });

  test("identity when nothing was recorded — a default turn's reply must not move", async () => {
    const agent = { generate: mock(async () => ({ text: "ok" })) } as unknown as Agent;
    const r = await agentRequestContext.run({}, async () =>
      runConversationalAgent({ agent, input: "hi", stream: false, sendChunk: () => {} }),
    );
    expect(r.reply).toBe("ok");
  });

  test("the local-router fallback still fires — appending must not change which turns survive", async () => {
    const llmRouter = {
      prefersLocal: () => true,
      generate: mock(async () => {
        throw new Error("router down");
      }),
    } as unknown as LlmRouter;
    const agent = { generate: mock(async () => ({ text: "from agent" })) } as unknown as Agent;
    const r = await runConversationalAgent({
      agent,
      llmRouter,
      input: "hi",
      stream: false,
      sendChunk: () => {},
    });
    expect(r.reply).toBe("from agent");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/engine/run-conversational-agent.test.ts`
Expected: the first two FAIL (no disclosure in the reply); the last two PASS already — they are the
regression guards for this task, and they must stay green throughout.

- [ ] **Step 3: Move the fork into `runTurn`, unchanged**

In `packages/gateway/src/engine/run-conversational-agent.ts`, cut the body from `const llmRouter =`
through the final `return await runViaAgent(...)` and paste it into a new function. **Nothing inside
changes** — same `try`/`catch`, same warn log, same `undefined` narrowing, same error text:

```ts
/**
 * The router-vs-agent fork, MOVED verbatim out of `runConversationalAgent` so the disclosure
 * append below has exactly one return to wrap. If this function's body differs from what the
 * caller used to contain by anything other than its signature, the change is wrong: a feature
 * that appends a sentence must not alter which turns survive.
 */
async function runTurn(
  p: RunConversationalAgentParams,
  promptArg: PromptArg,
  maxSteps: number,
): Promise<{ reply: string; modelMeta?: LlmGenerateResult }> {
  const llmRouter = p.llmRouter;
  if (llmRouter !== undefined && shouldUseLocalRouter(p)) {
    try {
      return await runViaLocalRouter(llmRouter, promptArg, p);
    } catch (e) {
      if (p.agent === undefined) {
        throw e;
      }
      conversationalLog.warn({ err: e }, "local LLM router failed; falling back to agent");
    }
  }
  if (p.agent === undefined) {
    throw new Error("No conversational agent or local LLM router configured");
  }
  return await runViaAgent(p.agent, promptArg, p, maxSteps);
}
```

- [ ] **Step 4: Add the append and call it at the one return**

```ts
/**
 * Drain the turn's negation disclosures and append them to BOTH the streamed output and the
 * returned reply, so the desktop app cannot show less than the CLI. Identity when nothing was
 * recorded — the default turn's reply must not move.
 *
 * The stream has already been sent by the time this runs, so the disclosure necessarily arrives
 * last. That is deliberate: it qualifies an answer the user has already begun reading.
 */
function appendNegationDisclosures<T extends { reply: string }>(
  res: T,
  p: RunConversationalAgentParams,
): T {
  const lines = drainNegationDisclosures();
  if (lines.length === 0) {
    return res;
  }
  const text = `\n\n${lines.join("\n")}`;
  if (p.stream) {
    p.sendChunk(text);
  }
  return { ...res, reply: `${res.reply}${text}` };
}
```

and in `runConversationalAgent`, inside the existing `try`, replace the moved block with:

```ts
    return appendNegationDisclosures(await runTurn(p, promptArg, maxSteps), p);
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/engine/run-conversational-agent.test.ts`
Expected: PASS, all four new cases plus every pre-existing one.

- [ ] **Step 6: Red-prove the stream half**

Delete the `if (p.stream) { p.sendChunk(text); }` block and re-run. Expected: the streaming test
FAILS while the non-stream one still passes — proving the test covers the wire and not just the
return value. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/engine/run-conversational-agent.ts \
        packages/gateway/src/engine/run-conversational-agent.test.ts
git commit -F - <<'EOF'
feat(engine): append negation disclosures where both paths return

The router-vs-agent fork moves verbatim into runTurn so the append has
exactly one return to wrap - fallback, narrowing and error text
unchanged, with a regression test proving the router-failure fallback
still reaches the agent.

The same text is streamed and returned, so the desktop surface cannot
show less than the CLI. Identity when nothing was recorded.
EOF
```

---

## Task 5: The three MCP tools

Spec § 1, § 5.2, § 7.

**Files:**

- Modify: `packages/cli/src/mcp/adapter.ts` (`INDEX_TOOL_SPECS`, `packages/cli/src/mcp/adapter.ts:377`)
- Modify: `packages/cli/src/mcp/adapter.test.ts` (count pin at `:906`)

**Interfaces:**

- Consumes: the existing `index.queryItems` / `people.list` IPC methods — Task 2's orchestrator is
  reached through them, not imported (the `cli-no-import-gateway` boundary).
- Produces: three new `ToolSpec` entries.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/mcp/adapter.test.ts`, following the existing tool-test pattern in that
file:

```ts
test("findPrsNotTouching forwards notTouching and pins the pr type", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const deps = depsWithClient({
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { items: [], meta: { limit: 50, total: 0 }, gaps: { excludedNoCoverage: 0, excludedTruncated: 0 } };
    },
  });
  const spec = INDEX_TOOL_SPECS.find((s) => s.name === "findPrsNotTouching");
  expect(spec).toBeDefined();
  await spec?.run(deps, { pathGlob: "tests/**", service: "github" });
  expect(calls[0]?.method).toBe("index.queryItems");
  expect(calls[0]?.params).toMatchObject({
    services: ["github"],
    types: ["pr"],
    notTouching: "tests/**",
  });
});

test("a refusal document is returned to the MCP caller intact", async () => {
  const deps = depsWithClient({
    call: async () => ({
      status: "refused",
      reason: "missing_substrate",
      message: "no PR file-coverage data is indexed",
      remediation: "sync a connector",
    }),
  });
  const spec = INDEX_TOOL_SPECS.find((s) => s.name === "findPrsNotTouching");
  const out = await spec?.run(deps, { pathGlob: "tests/**" });
  const text = out?.content?.[0]?.text ?? "";
  expect(text).toContain("missing_substrate");
  expect(text).toContain("sync a connector");
});
```

and update the count pin:

```ts
expect(TOOL_SPECS).toHaveLength(21);
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/src/mcp/adapter.test.ts`
Expected: FAIL — `spec` undefined, and the length assertion reports 18.

- [ ] **Step 3: Add the specs**

In `packages/cli/src/mcp/adapter.ts`, append to `INDEX_TOOL_SPECS` (NOT
`AGENT_CLASSIFIED_TOOL_SPECS` — these serve index rows, not gateway-synthesised briefs, and that
distinction is what decides whether the call is ledgered):

```ts
  {
    name: "findPrsNotTouching",
    description:
      "Pull requests with NO indexed changed-file path matching a glob. Proves its substrate first and REFUSES (status 'refused') when PR file coverage is not indexed, because an unfetched PR is indistinguishable from one that never touched the path — do not fall back to searchIndex on a refusal. Always reports how many PRs were excluded as unverifiable; report that count to the user.",
    schema: { pathGlob: z.string(), service: serviceArg, limit: limitArg },
    run: (deps, args) =>
      runTool(deps, async (c) =>
        jsonResult(
          await c.call("index.queryItems", {
            types: ["pr"],
            notTouching: optString(args, "pathGlob") ?? "",
            ...(optString(args, "service") === undefined
              ? {}
              : { services: [optString(args, "service")] }),
            limit: clampLimit(optNumber(args, "limit")),
          }),
        ),
      ),
  },
```

Write `findDeploymentsWithoutIncident` (`types: ["deployment"]`, `noDownstreamIncident: true`, and
a description stating the correlation window is fixed at write time) and `findPeopleWithoutReviews`
(`c.call("people.list", { notReviewed: true, sinceMs, limit })`, **no `service`** — `people.list`
has no service dimension). Its schema takes `sinceDays: z.number().int().nonnegative().optional()`
and converts to `sinceMs` at the tool boundary, exactly as the engine tool does, so the two
surfaces present one vocabulary rather than two.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/src/mcp`
Expected: PASS. `mcp-server.ts` derives its counts from the arrays, so no other number changes.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp/adapter.ts packages/cli/src/mcp/adapter.test.ts
git commit -F - <<'EOF'
feat(mcp): serve the three negation tools to external MCP clients

Registered in INDEX_TOOL_SPECS, not AGENT_CLASSIFIED_TOOL_SPECS: they
serve index rows rather than gateway-synthesised briefs, which is the
rule that decides whether a call is ledgered. TOOL_SPECS 18 -> 21.

They reach the predicates over IPC, so they inherit the orchestration
and the refusal contract without importing gateway source.
EOF
```

---

## Task 6: Documentation, and the two bounds that must not be implied away

Spec § 5.2 and § 7.1.

**Files:**

- Modify: `docs/CHANGELOG.md`, `docs/roadmap.md`, `CLAUDE.md`, `GEMINI.md`

- [ ] **Step 1: Verify each drift site before editing**

Run: `grep -n "W6-B" docs/roadmap.md` and read the surrounding rows. Two rows carry W6-B: the
"Remaining in S1" row (narrowed to B.2 on 2026-08-20) and the Phase 7 Wave 6 row. **This delivery
closes both** — mark them complete, and keep the 2026-08-16 correction and the SUPERSEDED note on
the `--negate` acceptance criterion, which record why the row's original shape was wrong.

- [ ] **Step 2: Write the CHANGELOG entry**

State, in this order: the three tools and the two surfaces; that refusals are structural on both
but **exclusion counts are guaranteed only on the engine surface**, because the append lives in the
engine and an external MCP client never reaches it; that **the local-router path has no tools at
all**, so a `prefer_local = true` user reaches the predicates only through the CLI or MCP; that a
model can still ignore the tool descriptions and answer a negation from ranked search, which is a
known open bound and not closed by this delivery; and that no schema, no IPC method, no invariant
and no egress row are added.

- [ ] **Step 3: Update both roadmap rows and the mirrored status line**

Close W6-B in both rows. Update the `**Status:**` sentence in **both** `CLAUDE.md` and `GEMINI.md`
— they mirror each other and `audit:status-drift` reads them — to record Wave 6 complete, carrying
the local-router bound in one clause.

- [ ] **Step 4: Run the doc gates**

Run: `bun run lint:markdown && bun run audit:status-drift && bun run audit:doc-refs`
then `bun run audit:links` **unpiped**, checking its own exit code — a trailing pipe reports the
pipe's status, not lychee's.

- [ ] **Step 5: Full verification, reporting COUNTS for each**

- `bun run preflight:fast`
- `bun test packages/gateway` — quote pass/skip/fail
- `bun test packages/cli` — quote pass/skip/fail
- `bun run typecheck:tests` — quote the violation count, not the exit code
- `grep -rn "file:///" --include=*.md docs/ *.md` — expected: no matches

- [ ] **Step 6: Commit**

```bash
git add docs/ CLAUDE.md GEMINI.md
git commit -F - <<'EOF'
docs: record negation on the model surfaces (W6-B.2), closing Wave 6

States the three bounds a reader needs and that no other document
states: exclusion counts are guaranteed only on the engine surface,
since the append lives in the engine and an external MCP client never
reaches it; the local-router path has NO tools at all, so a
prefer_local = true user reaches these predicates only through the CLI
or MCP; and a model can still ignore the tool descriptions and answer a
negation from ranked search, which this delivery does not close.

Closes both W6-B rows without deleting the 2026-08-16 correction or the
SUPERSEDED note on the --negate criterion.
EOF
```

---

## Self-Review

**Spec coverage.** § 1 three tools × two surfaces → Tasks 3 and 5. § 4 extraction → Task 2. § 5.1
disclosure + drain + single append site → Tasks 1 and 4. § 5.1.1 fail-safe (payload copy + warn) →
Task 1 Steps 4 and 6, asserted in Task 3 Step 1. § 5.2 MCP asymmetry → Task 5 descriptions + Task 6
Step 2. § 6 steering + residual → Task 3 Step 5 + Task 6 Step 2. § 7 scope facts → Task 5 Step 3
(list choice) and Task 6. § 7.1 local-router bound → Task 6 Steps 2–3. § 8 testing: seam test →
Task 4 Step 1; identity → Task 4 Step 1; red-proves → Tasks 1, 3, 4; count pin → Task 5.

**Placeholder scan.** Tasks 2, 3 and 5 each describe two sibling implementations in prose rather
than repeating the full code ("write the equivalent for X"). That is deliberate and bounded: each
names the exact substrate probe, builder, counter, gap shape and refusal strings to use, so nothing
is left to invention. Every other step carries runnable content.

**Type consistency.** `NegationOutcome<Row, Gaps>` is two-parameter in Task 2's code (the gap shape
differs per predicate) — the spec's one-parameter sketch is the loose version; Task 2's signature
wins. `runNotTouchingQuery(db, index, params)` is called with that argument order in Tasks 2 and 3.
`negationDisclosureLine` returns `string | undefined` in Task 1 and every caller in Task 3 checks
for `undefined`. `createNegationTools({ localIndex })` is the shape `agent.ts` uses in Task 3 Step 5.

**One risk carried into execution.** Task 1 Step 6 may find that `@mastra/core` 1.59 exposes tools
under a different accessor than `agent.getTools()`; the step names the fallback
(`listAgentTools` in `agent.test.ts:47`) rather than leaving the executor to guess. If the sentinel
genuinely does not arrive, Step 7 says stop — the append half of the design is dead and only the
payload half survives, which is a decision for the human, not a workaround for the executor.
