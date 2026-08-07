# Agents over HTTP (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gateway's read-only agents invocable over the local HTTP API — `POST /v1/agents/{agent}`, `GET /v1/agents/runs/{id}`, `GET /v1/agents` — with every HTTP-originated brief recorded in the egress ledger under a new `http` source type, and with the `D22` static rule tightened so a *third* entry point cannot repeat the bypass this one would otherwise have been.

**Architecture:** The append site does not move. `dispatchAgentsRpc` already appends before dispatch; its condition generalises from `ctx.caller?.kind === "mcp"` to a lookup over a **total** map from `ClientKind` to an egress source type, so `cli`/`ui`/`unknown` keep appending nothing and a future kind is a compile error rather than a silent hole. Delivery is dependency injection: `AgentsRpcContext.notify` is already an injected `(method, params) => void`, so the HTTP path builds a context whose `notify` writes into an in-memory `AgentRunController` modelled on `briefs/brief-run-store.ts`. **No agent code changes.**

**Tech Stack:** Bun v1.2+, TypeScript strict, `bun:test`, `bun:sqlite`, Biome.

**Spec:** [`../specs/2026-08-06-http-agents-route-and-resolve-by-url-design.md`](../specs/2026-08-06-http-agents-route-and-resolve-by-url-design.md) §1 (Surfaces) and §2 (`I29`/`D22`) are the requirements. **Predecessor:** [`./2026-08-06-http-agents-pr1-token-scopes.md`](./2026-08-06-http-agents-pr1-token-scopes.md), merged as `826b76a1` (#1062).

---

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict is non-negotiable.
- **Server-derived attribution only.** `caller.clientId` is the label returned by token verification and `caller.kind` is the literal `"http"` set by the route handler. Neither may be read from the request body, headers, or params. This is the same rule `I23` relies on for reply targets.
- **Fail closed on the append.** The egress append precedes any agent work and is not wrapped in `try`/`catch` inside `dispatchAgentsRpc`. A throwing append must produce a 500 with **no run created and no brief**. Do not add a `catch` that serves the brief anyway — including a `try {` opened *before* the append with its `catch` after the dispatch, which is the shape the enforcement test scans for.
- **Do not touch `parseCoverage`.** See "The one `prove` blackout" below.
- **`agents.preflight` stays off this surface** (`I24`: an external caller must never originate a consent prompt on the owner's machine). `ghost` and `huddle` stay in, as they did for MCP.
- **Any test that reads a source file resolves from `import.meta.dir`, never the process CWD.** A CWD-relative path resolves locally and throws `ENOENT` under CI's sharded runner — PR 1 shipped exactly that bug and it was dead in the only place it had to work. Every task that adds such a test ends by running the suite from a **second working directory** (Task 4, Step 9).
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators. Note `iterateSourceFiles` (`scripts/structure-audit/lib.ts:85`) normalises `relPath` to forward slashes, so static-audit path comparisons use `/` on every OS.
- **Commit on the branch `dev/asaf/http-agents-pr2`** in worktree `.claude/worktrees/http-agents-pr2`. Never on `main`. Run `bun install` in the fresh worktree **before** the first build or test.
- Run `bun run preflight:fast` after each task, and the full `bun run preflight` before opening the PR. `audit:invariants` runs before the test suite and fails first.
- **The PR title carries the conventional-commit type** — local commit messages are discarded on squash-merge. Proposed title: `feat(gateway): invoke read-only agents over the HTTP API, recorded in the egress ledger`.

## The one `prove` blackout — intended, do not soften

`parseCoverage` (`egress/egress-coverage.ts:89`) returns `null` for a marker string containing an **unknown** key *and* for one **missing** a known key. Adding `http` to `COVERAGE_CLASSES` therefore breaks marker parsing in **both** directions: a pre-`http` binary's marker is missing the key, and a post-`http` binary's marker carries a key the old one rejects. Every `nimbus prove` window spanning the upgrade reads `indeterminate` on **every class**.

That is the intended fail-safe. A marker whose vector cannot be parsed must contribute `ALL_NONE_COVERAGE` rather than a plausible-looking partial claim. Task 1 asserts the blackout as an accepted cost rather than leaving it to be discovered in the field. **Do not relax `parseCoverage` to tolerate a missing or unknown class.**

This is the *only* blackout in the four-PR sequence: PR 4 raises `sync` from `none` to `per-run`, which changes a **value**, and `weakestCoverage` degrades a value mismatch gracefully across a mixed window.

## The pin, resolved

The spec's §2 "Costs" says the pin at `security-invariants.test.ts` goes to `["http","mcp","sync","task"]`. **That is the end state after PR 4, not PR 2.** Verified in the tree:

- `packages/gateway/src/security-invariants.test.ts:1390` currently reads `expect([...claimed].sort()).toEqual(["mcp", "task"]);` (line 1390, not the spec's 1375 — the file has drifted).
- The assertion is over `COVERAGE_CLASSES.filter((c) => THIS_BINARY_COVERAGE[c] !== "none")`, i.e. classes **claiming** non-`none`.
- PR 2 lands the `http` appender and nothing else. `sync` has no appender until PR 4 and must keep claiming `none`.

**PR 2's pin is `["http","mcp","task"]`.** Raising `sync` here would be exactly the defect the coverage vector exists to prevent: a claim with no landed appender. The test's own comment calls widening it "a review moment, not a test to re-bank" — this plan is that review, and it widens by exactly one entry.

Sequencing consequence inside this PR: **Task 1 adds the class at `none`; Task 3 raises it to `per-call` in the same commit as the appender.** Tasks 1 and 2 leave the pin at `["mcp","task"]`.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/egress/egress-source-type.ts` (modify) | `http` joins the frozen union, with its decision recorded in the header the way `mcp`'s is. |
| `packages/gateway/src/egress/egress-coverage.ts` (modify) | `http` joins `COVERAGE_CLASSES` (key-sorted, so it heads the list) and `THIS_BINARY_COVERAGE` / `ALL_NONE_COVERAGE`. |
| `packages/cli/src/commands/prove.ts` (modify) | `COVERAGE_CLASS_LABELS` — the hand-maintained CLI mirror the gateway cannot import. Moves in the same commit. |
| `packages/gateway/src/egress/agent-brief-egress.ts` (rename from `mcp-brief-egress.ts`) | `recordAgentBriefEgress` — the sole appender for agent briefs, now parameterised by source type. |
| `packages/gateway/src/ipc/server/client-kind.ts` (modify) | `ClientKind` gains `"http"`; `RECOGNISED` deliberately does **not**. |
| `packages/gateway/src/egress/egress-bearing-kinds.ts` (create) | The **total** `ClientKind → EgressSourceType \| null` map. Totality is what stops a future kind becoming a silent coverage hole. |
| `packages/gateway/src/ipc/agents-rpc.ts` (modify) | Generalised append condition; the HTTP-invokable agent set + resolver. |
| `scripts/structure-audit/check-nimbus-invariants.ts` (modify) | `D22(c)` regex moves to the new symbol; **`D22(d)`** lands. |
| `packages/gateway/src/agent-runs/agent-run-store.ts` (create) | `AgentRunController` — plain `Map`, injected clock, lazy expiry, tombstones, admission cap. |
| `packages/gateway/src/agent-runs/agent-http-invoke.ts` (create) | `buildAgentHttpInvoker` — admit, dispatch through `dispatchAgentsRpc`, open the run. |
| `packages/gateway/src/agent-runs/agent-test-server.ts` (create) | Test harness booting a real `startReadOnlyHttpServer` with the agents seam. Mirrors `briefs/brief-test-server.ts`. |
| `packages/gateway/src/ipc/http-write-routes.ts` (modify) | `POST /v1/agents/{agent}` on `WRITE_ROUTE_ALLOWLIST` (`I13`). |
| `packages/gateway/src/ipc/http-server.ts` (modify) | The two bearer-gated reads, mounted in the `fetch` handler before the unauthenticated GET table. |
| `packages/gateway/src/ipc/http-route-auth.ts` (modify) | Three table entries; `ClipReadRouteKey` widened; **`hasScope` made module-private** (PR 1's parked residual). |
| `packages/gateway/src/platform/assemble.ts` (modify) | Builds the controller + invoker and threads them into `HttpSidecarOpts`. |

**Why the run store lives in `agent-runs/`, not `agents/`.** `D22(d)` (Task 4) forbids any file outside `ipc/agents-rpc.ts` from importing `agents/<name>.ts`. A new module at `agents/agent-run-store.ts` would be caught by its own rule. `agent-runs/` mirrors how `briefs/` sits beside `ipc/`, and keeps the rule unambiguous.

---

### Task 1: `http` joins the egress vocabulary (at `none`)

**Files:**

- Modify: `packages/gateway/src/egress/egress-source-type.ts`
- Modify: `packages/gateway/src/egress/egress-coverage.ts`
- Modify: `packages/cli/src/commands/prove.ts`
- Test: `packages/gateway/src/egress/egress-source-type.test.ts`, `packages/gateway/src/egress/egress-coverage.test.ts`, `packages/cli/src/commands/prove.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `EGRESS_SOURCE_TYPES` gains the member `"http"`; `EgressSourceType` widens.
  - `COVERAGE_CLASSES` becomes `["http", "mcp", "model", "peer", "session", "sync", "task"]` (seven, key-sorted).
  - `THIS_BINARY_COVERAGE.http === "none"` **for this task only** — Task 3 raises it.
  - `ALL_NONE_COVERAGE.http === "none"`.

> **Read this before writing anything.** `EGRESS_SOURCE_TYPES`' header says the union "was frozen at eight members in #1038" and that `mcp` was "the taxonomy decision that closes the union… A further class still needs an explicit decision recorded here; it is not a casual append." **This is that further class**, and the record goes in that header, not in a commit message. Quote the existing header before editing it.

- [ ] **Step 1: Write the failing tests**

In `packages/gateway/src/egress/egress-source-type.test.ts`, update the exact-membership assertion (currently at line 22) to include `"http"`. Read the file first and match its existing style; the assertion is a `toEqual` over the full array in declaration order, so append `"http"` at the end of the expected list and at the end of the source array (declaration order is not the wire format for this list — only `COVERAGE_CLASSES` is order-sensitive).

Add to `packages/gateway/src/egress/egress-coverage.test.ts`:

```ts
test("COVERAGE_CLASSES stays key-sorted, with http at the head", () => {
  // The array IS the wire format: serializeCoverage maps over it into a boot marker's HASHED
  // source_id. `http` sorts before `mcp`, so it heads the list rather than trailing it. A
  // non-sorted array would still typecheck and would still round-trip within one binary — and
  // would produce a different canonical string from any other binary that sorted correctly.
  expect([...COVERAGE_CLASSES]).toEqual([
    "http",
    "mcp",
    "model",
    "peer",
    "session",
    "sync",
    "task",
  ]);
  expect([...COVERAGE_CLASSES]).toEqual([...COVERAGE_CLASSES].sort());
});

test("http claims `none` until its appender lands", () => {
  // Task 3 of this plan raises it, in the same commit as recordAgentBriefEgress starts writing
  // `http` rows. Raising a claim before its appender is the exact defect this vector exists to
  // catch, and a two-task gap is long enough for it to ship.
  expect(THIS_BINARY_COVERAGE.http).toBe("none");
  expect(ALL_NONE_COVERAGE.http).toBe("none");
});

test("a pre-http marker does not parse — the accepted `prove` blackout", () => {
  // The six-class string every binary before this one wrote. parseCoverage rejects a vector
  // MISSING a known class, so it returns null and the caller substitutes ALL_NONE_COVERAGE,
  // driving the whole window to `indeterminate`.
  //
  // This is asserted, not merely documented, because it is a real operational consequence: every
  // `nimbus prove` window spanning this upgrade reports indeterminate on EVERY class. Softening
  // parseCoverage to tolerate it would let an old marker contribute understated-but-plausible
  // coverage, which is the forward-compatibility failure the strictness exists to prevent.
  const preHttp = "mcp=per-call;model=none;peer=none;session=none;sync=none;task=per-call";
  expect(parseCoverage(preHttp)).toBeNull();
});

test("a post-http marker round-trips through serialize/parse", () => {
  expect(parseCoverage(serializeCoverage(THIS_BINARY_COVERAGE))).toEqual(THIS_BINARY_COVERAGE);
});
```

Add the imports these need (`ALL_NONE_COVERAGE`, `parseCoverage`, `serializeCoverage`) to the existing import from `./egress-coverage.ts`.

- [ ] **Step 2: Run them to confirm they fail**

```text
bun test packages/gateway/src/egress/egress-coverage.test.ts packages/gateway/src/egress/egress-source-type.test.ts
```

Expected: FAIL. `COVERAGE_CLASSES` has six entries and `THIS_BINARY_COVERAGE.http` does not typecheck.

- [ ] **Step 3: Add the source type, with its decision recorded**

In `packages/gateway/src/egress/egress-source-type.ts`, append to the array:

```ts
  "http", // agent brief served over the local HTTP API
```

and append this paragraph to the existing header doc comment, after the paragraph ending "…it is not a casual append.":

```text
 * `http` is that further class, and this is its decision. It is named for the VERIFIABLE
 * TRANSPORT rather than for a caller-declared client kind: over stdio, `mcp` is ultimately a
 * client's self-declaration at handshake, whereas an HTTP caller's transport is a fact the gateway
 * observed and whose identity it verified against the token map. Reusing `mcp` would have merged
 * two different attribution strengths under one string, permanently, in every row. Reusing
 * `session` (the freeze's own prescription for a class whose appender is not landing yet) was
 * rejected for the same reason it was rejected for `mcp`: `session` must go on claiming `none`
 * coverage until telemetry/updater/JWKS land, which would mean recording HTTP briefs and
 * disclaiming them in the same breath. Like `mcp`, the class covers LESS than its name suggests —
 * see THIS_BINARY_COVERAGE in egress-coverage.ts, where the narrowing is recorded machine-readably.
```

- [ ] **Step 4: Add the coverage class**

In `packages/gateway/src/egress/egress-coverage.ts`:

```ts
export const COVERAGE_CLASSES = [
  "http",
  "mcp",
  "model",
  "peer",
  "session",
  "sync",
  "task",
] as const;
```

Add `http: "none",` to both `THIS_BINARY_COVERAGE` and `ALL_NONE_COVERAGE`.

Extend the `THIS_BINARY_COVERAGE` doc comment's "READ THE `mcp` ENTRY NARROWLY" paragraph with the sibling narrowing for `http`:

```text
 * READ THE `http` ENTRY THE SAME WAY, and more narrowly still. When raised (see the agent-brief
 * appender), it is `per-call` over exactly one thing: an `agents.*` brief served to a caller
 * verified on the local HTTP API. It is NOT "everything on the HTTP API". `GET /v1/items`,
 * `GET /v1/people`, `GET /v1/audit` and the rest of the read surface hand index rows to a local
 * process and append NO row — and `GET /v1/items/resolve` (PR 3) will not either. Conversely
 * `POST /v1/items/fetch` (PR 4) DOES append, but under `sync`, not `http`: the class tracks the
 * kind of egress, not the port it arrived on.
```

- [ ] **Step 5: Move the CLI label mirror in the same commit**

`packages/cli/src/commands/prove.ts:46` — `COVERAGE_CLASS_LABELS` is a hand-maintained mirror the gateway cannot import (`egress-coverage.ts` says so explicitly). Add:

```ts
const COVERAGE_CLASS_LABELS: Readonly<Record<string, string>> = {
  task: "gated connector actions",
  mcp: "agents.* briefs served to MCP clients",
  http: "agents.* briefs served over the local HTTP API",
};
```

Note the renderer already falls back to the raw class name (`COVERAGE_CLASS_LABELS[c] ?? c`), so a missing label degrades rather than crashes — which is exactly why it can drift silently and why it moves in this commit.

- [ ] **Step 6: Run the affected suites**

```text
bun test packages/gateway/src/egress/ packages/cli/src/commands/prove.test.ts
```

Expected: PASS. If `security-invariants.test.ts` is also run, the `COVERAGE_CLASSES ≡ non-marker source types` test at line 1374 must pass without editing — both lists gained `http` and neither gained a marker.

- [ ] **Step 7: Confirm the pin has NOT moved**

```text
bun test packages/gateway/src/security-invariants.test.ts -t "landed appender"
```

Expected: PASS with the pin still `["mcp", "task"]`. `http` claims `none` in this task, so nothing to widen yet. **If this fails, you raised the claim early — revert `THIS_BINARY_COVERAGE.http` to `"none"`.**

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/egress/egress-source-type.ts packages/gateway/src/egress/egress-coverage.ts packages/gateway/src/egress/egress-source-type.test.ts packages/gateway/src/egress/egress-coverage.test.ts packages/cli/src/commands/prove.ts
git commit -m "feat(egress): add the http source type and coverage class, claiming none"
```

**Definition of done:** `COVERAGE_CLASSES` is seven key-sorted entries; `http` claims `none`; the pre-`http` marker is asserted unparseable; `prove.ts` has the label; the appender pin is untouched.

---

### Task 2: `recordMcpBriefEgress` → `recordAgentBriefEgress`

**Files:**

- Rename: `packages/gateway/src/egress/mcp-brief-egress.ts` → `packages/gateway/src/egress/agent-brief-egress.ts`
- Rename: `packages/gateway/src/egress/mcp-brief-egress.test.ts` → `packages/gateway/src/egress/agent-brief-egress.test.ts`
- Modify: `packages/gateway/src/ipc/agents-rpc.ts` (the import and the one call site)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (`D22(c)`)
- Modify: `packages/gateway/src/security-invariants.test.ts` (the two-namers scan at line 1310, the ordering scan at line 1353)
- Modify: docs — `docs/SECURITY-INVARIANTS.md`, `docs/architecture.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/commands/nimbus-egress.md`, `.claude/commands/nimbus-file-map.md`, `packages/gateway/src/egress/egress-verify.ts` (a doc-comment reference), `packages/gateway/src/egress/egress-coverage.ts` (two doc-comment references)

**Interfaces:**

- Consumes: `EgressSourceType` (Task 1).
- Produces:

```ts
export function recordAgentBriefEgress(
  db: Database,
  args: {
    readonly sourceType: Extract<EgressSourceType, "mcp" | "http">;
    readonly method: string;
    readonly params: unknown;
    readonly clientId: string;
    readonly now: number;
  },
): void;
```

> **Behaviour-preserving.** After this task the only call site still passes `sourceType: "mcp"` and every existing row shape is byte-identical. Task 3 adds the second value. Keeping the rename separate is what makes Task 3's diff readable as a behaviour change rather than as churn.

- [ ] **Step 1: Rename the module and its test, then update the appender**

```bash
git mv packages/gateway/src/egress/mcp-brief-egress.ts packages/gateway/src/egress/agent-brief-egress.ts
git mv packages/gateway/src/egress/mcp-brief-egress.test.ts packages/gateway/src/egress/agent-brief-egress.test.ts
```

Rewrite `packages/gateway/src/egress/agent-brief-egress.ts`:

```ts
// packages/gateway/src/egress/agent-brief-egress.ts

import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import type { EgressSourceType } from "./egress-source-type.ts";

/**
 * Agents that answer by querying paired peers rather than purely from the local index. Their rows
 * must stay distinguishable from purely local briefs — collapsing them into one undifferentiated
 * destination would hide outbound peer traffic inside a local-looking record.
 */
const FEDERATION_TOUCHING: ReadonlySet<string> = new Set(["agents.ghost", "agents.huddle"]);

/**
 * The transports whose agent briefs are ledgered. Narrowed from EgressSourceType so a caller
 * cannot record a brief as `task` or `sync`: those classes carry their own coverage claims, and a
 * brief filed under one of them would inflate a claim nothing appended for.
 */
export type AgentBriefSourceType = Extract<EgressSourceType, "mcp" | "http">;

/**
 * The sole append site for agent briefs served to an external client (I29, D22(c)).
 *
 * Called BEFORE the brief is returned to the caller. It throws on failure by design: the caller
 * must fail closed and emit no brief, mirroring the executor's append-before-dispatch discipline.
 * A ledger that can be outrun by the thing it records is decorative.
 *
 * `sourceType` is the transport, supplied by the dispatcher from a SERVER-DERIVED caller kind —
 * never from RPC params or a request body. `destination` derives from it so the federation-touching
 * distinction survives on both transports (`mcp+federation`, `http+federation`).
 */
export function recordAgentBriefEgress(
  db: Database,
  args: {
    readonly sourceType: AgentBriefSourceType;
    readonly method: string;
    readonly params: unknown;
    readonly clientId: string;
    readonly now: number;
  },
): void {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: args.sourceType,
    sourceId: args.clientId,
    destination: FEDERATION_TOUCHING.has(args.method)
      ? `${args.sourceType}+federation`
      : args.sourceType,
    method: args.method,
    payloadSummary: redactEgressSummary(args.params),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
```

- [ ] **Step 2: Update the test file**

In `agent-brief-egress.test.ts`, rename every `recordMcpBriefEgress(` call to `recordAgentBriefEgress(` and add `sourceType: "mcp",` to each args object. The existing assertions on `source_type='mcp'` and `destination` stay unchanged — that is the point of this task.

Add one new test:

```ts
test("the sourceType drives both the column and the destination", () => {
  const db = freshDb();
  recordAgentBriefEgress(db, {
    sourceType: "http",
    method: "agents.ghost",
    params: {},
    clientId: "chrome",
    now: 1,
  });
  const row = db
    .query("SELECT source_type, destination, source_id FROM egress_ledger ORDER BY id DESC LIMIT 1")
    .get() as { source_type: string; destination: string; source_id: string };
  expect(row.source_type).toBe("http");
  // The federation-touching distinction must survive the parameterisation — ghost queries peers
  // over HTTP exactly as it does over stdio, and a bare "http" here would hide that.
  expect(row.destination).toBe("http+federation");
  expect(row.source_id).toBe("chrome");
});
```

**Quote the existing `freshDb()` helper in that file before using it** — it is defined at the top of the file; do not invent a second one.

- [ ] **Step 3: Update the single call site**

In `packages/gateway/src/ipc/agents-rpc.ts`, change the import (line 23) and the call (lines 585-590):

```ts
import { recordAgentBriefEgress } from "../egress/agent-brief-egress.ts";
```

```ts
  if (ctx.caller?.kind === "mcp" && Object.hasOwn(AGENTS_RPC_HANDLERS, method)) {
    recordAgentBriefEgress(ctx.db, {
      sourceType: "mcp",
      method,
      params,
      clientId: ctx.caller.clientId,
      now: Date.now(),
    });
  }
```

- [ ] **Step 4: Move `D22(c)` with the symbol**

In `scripts/structure-audit/check-nimbus-invariants.ts`, replace lines 606-611:

```ts
// (c) the agent brief egress chokepoint must be TOTAL: `recordAgentBriefEgress` is CALLED from
// exactly one file. This mirrors (a) — it pins the caller, it does not merely permit an appender.
// Adding a file to an allowlist here would satisfy the checker while dissolving the property it
// protects. The symbol was `recordMcpBriefEgress` until agent briefs became reachable over HTTP as
// well as stdio; the rule moved with it in the same commit, because a rule pinning a symbol that no
// longer exists passes vacuously.
const D22_AGENT_RECORD_RE = /\brecordAgentBriefEgress\b/;
const D22_AGENT_RECORD_CALLER = "packages/gateway/src/ipc/agents-rpc.ts";
const D22_AGENT_RECORD_DEFINITION = "packages/gateway/src/egress/agent-brief-egress.ts";
```

Update the three uses at lines 638-643 and the violation rule name to `"D22-agent-brief-egress"`, and the `::error` message at line 831 (`recordMcpBriefEgress outside agents-rpc.ts` → `recordAgentBriefEgress outside agents-rpc.ts`).

- [ ] **Step 5: Update the enforcement tests**

In `packages/gateway/src/security-invariants.test.ts`:

- Line 1267: `expect(audit).toContain("D22-mcp-brief-egress");` → `"D22-agent-brief-egress"`.
- The test at line 1310 (`recordMcpBriefEgress is named by exactly two production files`): rename the symbol in the title, the `contents.includes(...)` check, and the expected pair at line 1338 → `["egress/agent-brief-egress.ts", "ipc/agents-rpc.ts"]`. **Read the test body before editing** — it deliberately refers to the module by prose elsewhere so the scan does not count its own file.
- Line 1353: `src.indexOf("recordMcpBriefEgress(ctx.db")` → `src.indexOf("recordAgentBriefEgress(ctx.db")`.

- [ ] **Step 6: Red-prove the moved rule**

Add a temporary line `const x = recordAgentBriefEgress;` to `packages/gateway/src/ipc/http-server.ts`.

```text
bun run audit:invariants
```

Expected: FAIL with `D22-agent-brief-egress`. Remove the line and re-run; expected PASS.

**A guard that has never failed is a guard nobody has checked** — and a renamed guard is a new guard.

- [ ] **Step 7: Update every doc that names the old symbol**

Search and update. These are the surfaces verified to name it:

```text
docs/SECURITY-INVARIANTS.md         (lines ~539, 567, 571, 580, 582, 587, 588, 591)
docs/architecture.md                (line ~1378)
CLAUDE.md                           (the I29 bullet)
GEMINI.md                           (the mirrored I29 bullet)
.claude/commands/nimbus-egress.md   (lines ~27, ~101)
.claude/commands/nimbus-file-map.md (line ~315)
packages/gateway/src/egress/egress-verify.ts     (doc comment ~line 379)
packages/gateway/src/egress/egress-coverage.ts   (doc comments ~lines 25, 38)
```

At this task, only the **name and path** change — the described behaviour is still MCP-only. Task 3 and Task 9 update the described behaviour. Do not describe HTTP briefs as ledgered yet; they are not.

- [ ] **Step 8: Run the gates**

```text
bun run audit:invariants && bun test packages/gateway/src/egress/ packages/gateway/src/ipc/agents-rpc.test.ts packages/gateway/src/security-invariants.test.ts && bun run preflight:fast
```

Expected: PASS. `lint:markdown` globs `docs/**/*.md` and fails the **whole branch**, so a pre-existing violation in any doc you touched is now yours to fix.

- [ ] **Step 9: Commit**

```bash
git add -u
git commit -m "refactor(egress): rename recordMcpBriefEgress to recordAgentBriefEgress, moving D22(c)"
```

**Definition of done:** `audit:invariants` green; `rg recordMcpBriefEgress` returns nothing outside `docs/superpowers/` (historical plans and specs keep their text); the appender's behaviour is unchanged for `mcp`; `D22(c)` red-proved under the new name.

---

### Task 3: The `http` client kind and the generalised append

**Files:**

- Modify: `packages/gateway/src/ipc/server/client-kind.ts`
- Create: `packages/gateway/src/egress/egress-bearing-kinds.ts`
- Create: `packages/gateway/src/egress/egress-bearing-kinds.test.ts`
- Modify: `packages/gateway/src/ipc/agents-rpc.ts`
- Modify: `packages/gateway/src/egress/egress-coverage.ts` (raise `http` to `per-call`)
- Test: `packages/gateway/src/ipc/server/client-kind.test.ts`, `packages/gateway/src/ipc/agents-rpc.test.ts`, `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**

- Consumes: `AgentBriefSourceType` (Task 2), `EgressSourceType` (Task 1).
- Produces:
  - `type ClientKind = "cli" | "mcp" | "ui" | "http" | "unknown"`
  - `EGRESS_BEARING_CLIENT_KINDS: Readonly<Record<ClientKind, AgentBriefSourceType | null>>`
  - `egressSourceTypeForClientKind(kind: ClientKind | undefined): AgentBriefSourceType | null`

> **The two-meanings-of-null trap, and why this one is safe.** PR 1 shipped a lookup whose `null` meant both "no scope needed" and "entry missing", and both were read as ALLOW — a fail-open that survived four review passes. This lookup's `null` also has one job, but the consumption is inverted: a `null` **suppresses a ledger row**, it does not grant access. The failure mode is therefore a *missing record*, not a *granted request* — still bad, so it is closed structurally: the map is `Record<ClientKind, …>`, **total over the union**, so adding a sixth kind without deciding its egress status is a **compile error**, not a silent `undefined`. Do not weaken it to `Partial<Record<…>>` or a `Map`.

- [ ] **Step 1: Write the failing client-kind test**

Add to `packages/gateway/src/ipc/server/client-kind.test.ts`:

```ts
test("a socket client cannot declare itself http", () => {
  // `http` is a kind the GATEWAY constructs when it has verified a bearer token on the local HTTP
  // API. It is a fact the server observed. Letting a socket client declare it at handshake would
  // turn the strongest attribution on the surface back into a self-declaration — and would let a
  // CLI process file its briefs under a transport it never used.
  const store = new ClientKindStore();
  expect(store.declare("c1", "http")).toBe("unknown");
  expect(store.get("c1")).toBe("unknown");
});

test("the three declarable kinds are unchanged", () => {
  const store = new ClientKindStore();
  expect(store.declare("a", "cli")).toBe("cli");
  expect(store.declare("b", "mcp")).toBe("mcp");
  expect(store.declare("c", "ui")).toBe("ui");
});
```

- [ ] **Step 2: Run it to confirm it fails**

```text
bun test packages/gateway/src/ipc/server/client-kind.test.ts
```

Expected: the first new test FAILS to typecheck (`"http"` is not assignable to `ClientKind` in the `get` comparison) or passes vacuously — either way, it is not yet meaningful. Record which.

- [ ] **Step 3: Widen the union without widening the handshake**

In `packages/gateway/src/ipc/server/client-kind.ts`:

```ts
export type ClientKind = "cli" | "mcp" | "ui" | "http" | "unknown";

/**
 * The kinds a client may DECLARE at connect time. `http` is deliberately absent: it is not
 * declarable, it is derived. The HTTP route handler constructs `caller: {kind: "http"}` itself
 * after verifying a bearer token against the labeled token map, so the kind is a server-checked
 * fact rather than a client's word — the same server-derived-not-caller-supplied rule I23 relies
 * on for reply targets. Adding "http" here would silently downgrade that.
 */
const RECOGNISED: ReadonlySet<string> = new Set(["cli", "mcp", "ui"]);
```

Extend the file's header comment to say `http` is constructed, never declared.

- [ ] **Step 4: Run to confirm it passes**

```text
bun test packages/gateway/src/ipc/server/client-kind.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing egress-bearing-kinds test**

Create `packages/gateway/src/egress/egress-bearing-kinds.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  EGRESS_BEARING_CLIENT_KINDS,
  egressSourceTypeForClientKind,
} from "./egress-bearing-kinds.ts";

describe("egress-bearing client kinds", () => {
  test("the map is TOTAL over ClientKind", () => {
    // Totality is the whole point. A Partial map or a Map would make a future sixth kind an
    // undefined lookup — i.e. an agent brief served to it would append nothing, and nothing would
    // fail. Here, adding a kind without deciding is a compile error; this test pins the runtime
    // shape so the decision cannot be un-made by loosening the type alone.
    expect(Object.keys(EGRESS_BEARING_CLIENT_KINDS).sort()).toEqual([
      "cli",
      "http",
      "mcp",
      "ui",
      "unknown",
    ]);
  });

  test("exactly two kinds bear egress", () => {
    expect(egressSourceTypeForClientKind("mcp")).toBe("mcp");
    expect(egressSourceTypeForClientKind("http")).toBe("http");
  });

  test("cli, ui and unknown append nothing", () => {
    // #1059's false-positive guard, extended rather than replaced: a CLI-originated brief is the
    // owner reading their own index on their own machine, and recording it as egress would make
    // `nimbus prove` count the user against themselves.
    expect(egressSourceTypeForClientKind("cli")).toBeNull();
    expect(egressSourceTypeForClientKind("ui")).toBeNull();
    expect(egressSourceTypeForClientKind("unknown")).toBeNull();
  });

  test("an absent caller appends nothing", () => {
    // AgentsRpcContext.caller is optional (unit tests and non-socket callers omit it). undefined
    // must reach the same answer as an unrecognised kind, not throw and not default to a source
    // type.
    expect(egressSourceTypeForClientKind(undefined)).toBeNull();
  });
});
```

- [ ] **Step 6: Run to confirm it fails**

```text
bun test packages/gateway/src/egress/egress-bearing-kinds.test.ts
```

Expected: FAIL — `Cannot find module './egress-bearing-kinds.ts'`.

- [ ] **Step 7: Write the map**

Create `packages/gateway/src/egress/egress-bearing-kinds.ts`:

```ts
// packages/gateway/src/egress/egress-bearing-kinds.ts

import type { ClientKind } from "../ipc/server/client-kind.ts";
import type { AgentBriefSourceType } from "./agent-brief-egress.ts";

/**
 * Which client kinds' agent briefs are ledgered, and under which `egress_ledger.source_type`.
 *
 * TOTAL over `ClientKind` on purpose. This started life as `ctx.caller?.kind === "mcp"` — an
 * equality that was correct for one transport and silently wrong for the second. Written as a
 * Partial map or a Map, a THIRD transport would be an `undefined` lookup: the brief would be
 * served, nothing would be appended, and no test would fail. As a total Record, adding a member to
 * `ClientKind` without deciding its egress status does not compile.
 *
 * `null` means "append nothing" and ONLY that. It is not overloaded with "not found" — a key that
 * is absent is a type error, not a null. (A lookup whose null means two things, one of which is
 * consumed as permission, is how the PR 1 clip-scope fail-open shipped.)
 *
 * `cli` and `ui` are the owner reading their own index on their own machine; recording those as
 * outbound egress would make `nimbus prove` count the user against themselves. `unknown` is a
 * client that declared nothing, which is not evidence of egress either — and unlike the scope
 * gates, guessing "yes" here would corrupt an append-only, hash-chained record whose only mutation
 * path is a HITL-gated prune.
 */
export const EGRESS_BEARING_CLIENT_KINDS: Readonly<
  Record<ClientKind, AgentBriefSourceType | null>
> = Object.freeze({
  cli: null,
  ui: null,
  unknown: null,
  mcp: "mcp",
  http: "http",
});

/** The ledger source type for a caller kind, or null when that kind bears no egress. */
export function egressSourceTypeForClientKind(
  kind: ClientKind | undefined,
): AgentBriefSourceType | null {
  return kind === undefined ? null : EGRESS_BEARING_CLIENT_KINDS[kind];
}
```

- [ ] **Step 8: Run to confirm it passes**

```text
bun test packages/gateway/src/egress/egress-bearing-kinds.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 9: Write the failing dispatcher tests**

Add to `packages/gateway/src/ipc/agents-rpc.test.ts`. **Before writing, read the existing `I29` block in that file** (it already contains "a CLI dispatch appends nothing" and "an MCP dispatch appends exactly one row") and mirror its `freshDb()` / `makeCtx()` helpers rather than inventing new ones.

```ts
test("I29: an HTTP-originated brief appends exactly one source_type='http' row", async () => {
  const db = freshDb();
  await dispatchAgentsRpc(
    "agents.expert",
    { topicOrFile: "x" },
    { db, notify: () => {}, caller: { clientId: "chrome", kind: "http" } },
  );
  const rows = db
    .query("SELECT source_type, source_id, method FROM egress_ledger WHERE source_type = 'http'")
    .all() as Array<{ source_type: string; source_id: string; method: string }>;
  expect(rows).toEqual([{ source_type: "http", source_id: "chrome", method: "agents.expert" }]);
});

test("I29: a CLI-originated brief still appends nothing", async () => {
  // #1059's false-positive guard, EXTENDED not replaced. The generalisation from an equality to a
  // lookup is exactly the kind of change that quietly widens what it matches.
  const db = freshDb();
  await dispatchAgentsRpc(
    "agents.expert",
    { topicOrFile: "x" },
    { db, notify: () => {}, caller: { clientId: "term", kind: "cli" } },
  );
  expect(db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 0 });
});

test("I29: an UNRECOGNISED method from an http caller appends nothing", async () => {
  // Membership of the served handler map, never the `agents.` namespace prefix. Prefix-gating
  // over-counted `nimbus prove` AND admitted an unbounded caller-controlled string into a hashed,
  // append-only column. The generalised condition must not lose that.
  const db = freshDb();
  const out = await dispatchAgentsRpc(
    "agents.nope",
    {},
    { db, notify: () => {}, caller: { clientId: "chrome", kind: "http" } },
  );
  expect(out.kind).toBe("miss");
  expect(db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 0 });
});
```

- [ ] **Step 10: Run to confirm the http test fails**

```text
bun test packages/gateway/src/ipc/agents-rpc.test.ts
```

Expected: the `source_type='http'` test FAILS with an empty row set. The other two PASS already — that is correct; they are regression guards, not new behaviour.

- [ ] **Step 11: Generalise the condition**

In `packages/gateway/src/ipc/agents-rpc.ts`, add the import and replace the append block:

```ts
import { egressSourceTypeForClientKind } from "../egress/egress-bearing-kinds.ts";
```

```ts
export async function dispatchAgentsRpc(
  method: string,
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<RpcMissOrHit> {
  // I29/D22(c): an externally-originated brief is egress — the gateway synthesises from the private
  // index and hands the result to whatever model the calling client uses. Append BEFORE any work,
  // and let a failure propagate: no row, no brief. Gated on a RECOGNISED method, never on the
  // namespace prefix, so an unrecognised call is a `miss` that ledgers nothing.
  //
  // The caller kind drives the source type through a TOTAL map (egress/egress-bearing-kinds.ts)
  // rather than an equality: this used to read `ctx.caller?.kind === "mcp"`, which was correct for
  // one transport and appended nothing for the second. `cli`/`ui`/`unknown`/absent map to null and
  // append nothing, unchanged.
  const egressSourceType = egressSourceTypeForClientKind(ctx.caller?.kind);
  if (egressSourceType !== null && Object.hasOwn(AGENTS_RPC_HANDLERS, method)) {
    recordAgentBriefEgress(ctx.db, {
      sourceType: egressSourceType,
      method,
      params,
      clientId: ctx.caller?.clientId ?? "",
      now: Date.now(),
    });
  }
  return dispatchByMethod<AgentsRpcContext>(method, params, ctx, AGENTS_RPC_HANDLERS);
}
```

> **`ctx.caller?.clientId ?? ""` is unreachable-by-construction and deliberate.** `egressSourceType` is non-null only when `ctx.caller` exists, but TypeScript cannot narrow across the helper call. Do **not** use a non-null assertion (`!`) — the project forbids that class of silent claim; the `??` makes the impossible branch explicit and harmless.

- [ ] **Step 12: Update the ordering assertion**

`packages/gateway/src/security-invariants.test.ts:1371` asserts `expect(src).toContain('ctx.caller?.kind === "mcp"');`. That literal no longer exists. Replace it:

```ts
    // The caller kind is server-derived (`ctx.caller`), never read out of the RPC params. The
    // condition is a lookup over a total map rather than an equality on one transport — see
    // egress/egress-bearing-kinds.ts. Both halves are asserted: the derivation site AND the
    // absence of any params-derived kind.
    expect(src).toContain("egressSourceTypeForClientKind(ctx.caller?.kind)");
    expect(src).not.toMatch(/params\s*\.\s*kind/);
```

Also update line 1368's guarded-region assertion if the `Object.hasOwn(AGENTS_RPC_HANDLERS, method)` literal moved — it did not, but re-read the region indices (`fnAt` / `appendAt` / `dispatchAt`) since `appendAt` now searches for `recordAgentBriefEgress(ctx.db` (changed in Task 2).

- [ ] **Step 13: Raise the coverage claim and move the pin**

In `packages/gateway/src/egress/egress-coverage.ts`, `THIS_BINARY_COVERAGE.http` becomes `"per-call"`. Update the `http` narrowing paragraph added in Task 1 to drop "When raised (see the agent-brief appender)".

In `packages/gateway/src/egress/egress-coverage.test.ts`, the Task 1 test `"http claims none until its appender lands"` becomes:

```ts
test("http claims per-call, and its appender has landed", () => {
  expect(THIS_BINARY_COVERAGE.http).toBe("per-call");
  // sync is PR 4's; raising it here would be a claim with no appender.
  expect(THIS_BINARY_COVERAGE.sync).toBe("none");
});
```

In `packages/gateway/src/security-invariants.test.ts:1385-1391`:

```ts
  test("I29: every coverage class claiming non-none has a landed appender", () => {
    // `mcp` and `http` are per-call because recordAgentBriefEgress ships for both transports; the
    // others stay none until theirs do. `sync` in particular is PR 4's — the design document lists
    // it in the end-state vector, and raising it here would be exactly the defect this assertion
    // exists to catch. Raising an entry without its appender is not a test to re-bank.
    const claimed = COVERAGE_CLASSES.filter((c) => THIS_BINARY_COVERAGE[c] !== "none");
    expect([...claimed].sort()).toEqual(["http", "mcp", "task"]);
  });
```

- [ ] **Step 14: Run the gates**

```text
bun test packages/gateway/src/egress/ packages/gateway/src/ipc/ packages/gateway/src/security-invariants.test.ts && bun run preflight:fast
```

Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add -u && git add packages/gateway/src/egress/egress-bearing-kinds.ts packages/gateway/src/egress/egress-bearing-kinds.test.ts
git commit -m "feat(egress): ledger agent briefs from http callers via a total client-kind map"
```

**Definition of done:** an `http` caller appends exactly one `source_type='http'` row before any agent work; a `cli` caller appends none; an unrecognised method appends none; `http` claims `per-call`; the pin reads `["http","mcp","task"]`; the map is total and the totality is both compile-enforced and test-pinned.

---

### Task 4: `D22(d)` — the emitter-import confinement

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Test: `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: a `"D22-agent-emitter-import"` violation rule.

> **The property.** `D22(c)` pins *one known caller* of the appender. That is not what `I29` needs, and the MCP design said so itself: "A test that only proves 'this file is allowed to append' is not an enforcement test." `D22(d)` makes it total:
>
> > No file outside `packages/gateway/src/ipc/agents-rpc.ts` may import an agent **emitter** module — `packages/gateway/src/agents/<name>.ts`, excluding `packages/gateway/src/agents/_lib/`.
>
> `docs/SECURITY-INVARIANTS.md:567` already predicts this exact bypass in prose. This task converts the prediction into a failing build.

**Verified green today** (re-verify before relying on it — run the grep in Step 1). The only non-test importers of `agents/*` are:

- `ipc/agents-rpc.ts` — all **twelve** emitter modules (eleven `emit*Brief` plus `why-peek.ts`), and four `_lib/*` type imports.
- `federation/peer-fanout.ts` — `agents/_lib/findings.ts` (a type).
- `ipc/index-demo-symbol-rpc.ts` — `agents/_lib/demo-symbol.ts` (a helper).

- [ ] **Step 1: Re-verify the baseline**

```bash
grep -rn 'from "[^"]*agents/[^"]*"\|import("[^"]*agents/[^"]*")' --include=*.ts packages/gateway/src packages/cli/src | grep -v '\.test\.ts:' | grep -v '^packages/gateway/src/agents/'
```

Expected: exactly the three files above. **If anything else appears, STOP and report NEEDS_CONTEXT** — the rule does not land green and the plan is wrong about the tree.

- [ ] **Step 2: Write the failing enforcement test**

Add to the `I29` describe block in `packages/gateway/src/security-invariants.test.ts`:

```ts
  test("D22(d): only agents-rpc.ts imports an agent emitter module", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D22-agent-emitter-import");
    // Both import forms, or the rule is sidestepped by a one-character change. A static-only
    // regex would let `await import("../agents/why.ts")` bypass the ledger while audit:invariants
    // stayed green — which is the same class of hole D22(d) exists to close, one level down.
    expect(audit).toContain("D22_EMITTER_STATIC_RE");
    expect(audit).toContain("D22_EMITTER_DYNAMIC_RE");
  });

  test("D22(d): agents/_lib re-exports no emitter — the gap the import regex cannot see", async () => {
    // A regex over import SPECIFIERS does not follow re-export chains. Were an emitter re-exported
    // through agents/_lib/, a file could import it from the EXCLUDED path and D22(d) would miss —
    // the same shape as D22's recorded wrapper/façade limit. That gap is closed by assertion here
    // rather than by trusting the import rule to cover something it structurally cannot.
    const libDir = resolve(import.meta.dir, "agents/_lib");
    const files = await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: libDir }));
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(".test.ts")) continue;
      const src = await Bun.file(join(libDir, f)).text();
      // Any re-export whose specifier climbs out of _lib into the agents/ directory itself.
      if (/export\s[^;]*from\s+"\.\.\/[A-Za-z][\w-]*\.ts"/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
```

Add `import { join, resolve } from "node:path";` if the file does not already import them — **check first**, `security-invariants.test.ts` already uses `import.meta.dir` at line 47 and may import `resolve` there.

- [ ] **Step 3: Run to confirm the first test fails**

```text
bun test packages/gateway/src/security-invariants.test.ts -t "D22(d)"
```

Expected: the first FAILS (the rule name is not in the audit script); the second PASSES (no `_lib` file re-exports an emitter today — that is the property, asserted so it stays true).

- [ ] **Step 4: Write the rule**

In `scripts/structure-audit/check-nimbus-invariants.ts`, after the `D22_AGENT_RECORD_*` constants:

```ts
// (d) the emitter chokepoint. Rule (c) pins the CALLER of the appender, which catches a second file
// acquiring the appender — but not a second file that serves a brief WITHOUT calling it. That path
// spells nothing (c) matches: it would append no row, serve the brief, and leave audit:invariants
// green. docs/SECURITY-INVARIANTS.md records that gap in prose; this rule closes it.
//
// The property: only ipc/agents-rpc.ts may import an agent EMITTER module. Emitters are
// `packages/gateway/src/agents/<name>.ts`; `agents/_lib/` is excluded because it holds types and
// shared helpers (findings.ts, demo-symbol.ts) that federation/ and ipc/ legitimately consume.
//
// BOTH forms are matched. A static-only regex is sidestepped by the one-character change from
// `import x from "…"` to `await import("…")`, which would be a bypass hiding in plain sight.
//
// KNOWN LIMIT, stated because D22's existing weakness is exactly this: a regex over import
// specifiers does not follow re-export chains. An emitter re-exported through `agents/_lib/` could
// be imported from the excluded path and this rule would miss. That is closed by an assertion in
// security-invariants.test.ts ("agents/_lib re-exports no emitter"), not by this regex — the same
// answer as the wrapper/façade limit above: address the capability, do not pretend the regex sees it.
const D22_EMITTER_ALLOWED = "packages/gateway/src/ipc/agents-rpc.ts";
const D22_EMITTER_DIR = "packages/gateway/src/agents/";
/** `from ".../agents/<name>.ts"` — any quote style, excluding an `_lib/` segment. */
const D22_EMITTER_STATIC_RE =
  /\bfrom\s+["'`][^"'`]*\/agents\/(?!_lib\/)[A-Za-z][\w-]*\.ts["'`]/;
/** `import(".../agents/<name>.ts")` — the dynamic form. */
const D22_EMITTER_DYNAMIC_RE =
  /\bimport\s*\(\s*["'`][^"'`]*\/agents\/(?!_lib\/)[A-Za-z][\w-]*\.ts["'`]/;

export function checkAgentEmitterImportConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // An emitter importing a sibling emitter is internal to the agents package, not a second
    // entry point; the rule is about who can reach IN from outside.
    if (f.relPath.startsWith(D22_EMITTER_DIR)) continue;
    if (f.relPath === D22_EMITTER_ALLOWED) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      if (D22_EMITTER_STATIC_RE.test(line) || D22_EMITTER_DYNAMIC_RE.test(line)) {
        out.push({
          rule: "D22-agent-emitter-import",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}
```

Wire it into `run()` alongside its siblings (the `mode === "binary-only" || mode === "all"` arms):

```ts
  if (mode === "binary-only" || mode === "all") {
    const v = checkAgentEmitterImportConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(d) agent emitter imported outside ipc/agents-rpc.ts — a second entry point would serve a brief with no egress row; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
```

- [ ] **Step 5: Run to confirm the rule is green on an unmodified tree**

```text
bun run audit:invariants
```

Expected: PASS. **Passing green today is not evidence** — Steps 6 and 7 are.

- [ ] **Step 6: Red-prove with a STATIC import**

Add to `packages/gateway/src/ipc/http-server.ts`:

```ts
import { emitWhyBrief } from "../agents/why.ts";
```

```text
bun run audit:invariants
```

Expected: FAIL with `D22(d) agent emitter imported outside ipc/agents-rpc.ts` naming `http-server.ts`. Remove the line.

- [ ] **Step 7: Red-prove with a DYNAMIC import**

Add to `packages/gateway/src/ipc/http-server.ts`, inside any function body:

```ts
  const mod = await import("../agents/why.ts");
  void mod;
```

```text
bun run audit:invariants
```

Expected: FAIL again, on the dynamic line. Remove it.

**Both proofs are mandatory.** A static-only rule is defeated by a one-character change, and only the second proof shows the second regex actually fires. Note also that the file iterator skips `*.test.ts` entirely (`scripts/structure-audit/lib.ts:88`), so a plant in a test file proves nothing — plant in production source.

- [ ] **Step 8: Red-prove the `_lib` assertion**

Add to `packages/gateway/src/agents/_lib/findings.ts`:

```ts
export { emitWhyBrief } from "../why.ts";
```

```text
bun test packages/gateway/src/security-invariants.test.ts -t "re-exports no emitter"
```

Expected: FAIL listing `findings.ts`. Remove the line and re-run; expected PASS.

This proves the assertion covers the one gap the import regex structurally cannot see. Note that with the re-export in place `audit:invariants` **still passes** — that is the demonstration, not a bug.

- [ ] **Step 9: Prove the tests are not CWD-dependent**

Both new tests read source files. Run the suite from a **second working directory**:

```bash
cd packages/gateway && bun test src/security-invariants.test.ts -t "D22(d)" && cd -
```

Expected: PASS from both locations. A CWD-relative `read(...)` / `Bun.file(...)` passes from the repo root and throws `ENOENT` under CI's sharded runner — PR 1 shipped exactly that and the guard was dead where it had to work. If either test fails here, its path is CWD-relative: fix it to resolve from `import.meta.dir`.

- [ ] **Step 10: Commit**

```bash
git add -u
git commit -m "feat(audit): D22(d) confines agent emitter imports to agents-rpc.ts"
```

**Definition of done:** `audit:invariants` green on a clean tree; red under both a static and a dynamic planted import; the `_lib` no-re-export assertion red-proved; both tests pass from two working directories.

---

### Task 5: `AgentRunController`

**Files:**

- Create: `packages/gateway/src/agent-runs/agent-run-store.ts`
- Test: `packages/gateway/src/agent-runs/agent-run-store.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:

```ts
export type AgentRunStatus = "running" | "done" | "failed";
export type AgentRun = {
  readonly id: string;
  status: AgentRunStatus;
  createdAtMs: number;
  expiresAtMs: number;
  brief: string | null;
  findings: unknown;
  error: string | null;
};
export type AgentRunControllerDeps = { readonly nowMs: () => number; readonly ttlMs?: number };
export const AGENT_RUN_TTL_MS = 10 * 60_000;
export const MAX_CONCURRENT_AGENT_RUNS = 3;
export const MAX_RETAINED_TERMINAL_AGENT_RUNS = 16;
export const MAX_EXPIRED_AGENT_TOMBSTONES = 256;
export const AGENT_BUSY_RETRY_AFTER_SECONDS = 1;
export type AdmitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly activeRuns: number;
      /** null when every slot is an in-flight reservation, so no clock bounds the wait. */
      readonly oldestExpiresInSeconds: number | null;
    };
export class AgentRunController {
  admit(): AdmitResult;
  abandon(): void;
  open(runId: string): void;
  observe(method: string, params: unknown): void;
  get(runId: string): AgentRun | null;
  wasKnown(runId: string): boolean;
  activeCount(): number;
}
```

> **The two hard parts, decided here rather than at the keyboard.**
>
> **(1) The run id is minted inside the agent, so admission cannot key on it.** Every emitter returns `{sessionId}` where `sessionId` is `<agent>_<ts>_<uuid8>` (`agents-rpc.ts:194-209`), and the design reuses it as the `runId` so a ledger row, a brief and an HTTP poll all name the same thing. The caller therefore cannot know the id until dispatch returns. So admission is a **two-phase reservation**: `admit()` increments a pending counter *synchronously*, before the `await`; `open(runId)` converts the reservation into a run; `abandon()` releases it when dispatch fails. Checking `activeCount()` before the await and creating the run after would over-admit, because two requests can both pass the check while suspended.
>
> **(2) A brief can complete BEFORE the route registers the run.** `emitBriefWithSynthesis` (`agents/_lib/emit-brief.ts:51`) starts its async IIFE *before* returning `{sessionId}`. A fast agent's `notify` therefore fires against a `runId` the controller has never seen. So `observe` **creates the run if absent**, in terminal state, and `open` **adopts** an already-terminal run rather than resetting it to `running`. Get this backwards and a fast brief is silently lost to a 404.
>
> **On the 10-minute TTL.** Briefs use 30 minutes (`brief-constants.ts:32`) because a brief run sits in `collecting` for as long as the human keeps feeding it tabs — the TTL bounds a *human*'s pace. An agent run has no collecting phase: it goes `running` → terminal in seconds with no client participation, so the TTL only bounds how long a **finished** brief stays pollable. Ten minutes is generous for "invoke, then read the result", and a third of briefs' retention for a store that holds synthesised index-derived text in memory. Not copied from briefs — deliberately shorter, for a different reason.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/agent-runs/agent-run-store.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import {
  AgentRunController,
  MAX_CONCURRENT_AGENT_RUNS,
  MAX_RETAINED_TERMINAL_AGENT_RUNS,
} from "./agent-run-store.ts";

let now = 1_000;
function makeController(ttlMs?: number): AgentRunController {
  return new AgentRunController({ nowMs: () => now, ...(ttlMs === undefined ? {} : { ttlMs }) });
}

beforeEach(() => {
  now = 1_000;
});

describe("AgentRunController", () => {
  test("an opened run is readable and running", () => {
    const c = makeController();
    expect(c.admit()).toEqual({ ok: true });
    c.open("expert_1_aaaa");
    expect(c.get("expert_1_aaaa")?.status).toBe("running");
  });

  test("a briefReady notification finishes the run with markdown and findings", () => {
    const c = makeController();
    c.admit();
    c.open("expert_1_aaaa");
    c.observe("expert.briefReady", {
      sessionId: "expert_1_aaaa",
      brief: "# Expert\n",
      findings: { gaps: [] },
    });
    const run = c.get("expert_1_aaaa");
    expect(run?.status).toBe("done");
    expect(run?.brief).toBe("# Expert\n");
    expect(run?.findings).toEqual({ gaps: [] });
    expect(run?.error).toBeNull();
  });

  test("a briefError notification fails the run and carries no brief", () => {
    const c = makeController();
    c.admit();
    c.open("why_1_bbbb");
    c.observe("why.briefError", { sessionId: "why_1_bbbb", error: "index unavailable" });
    const run = c.get("why_1_bbbb");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("index unavailable");
    expect(run?.brief).toBeNull();
  });

  test("a brief that completes BEFORE open is adopted, not lost", () => {
    // emitBriefWithSynthesis starts its work before returning {sessionId}, so notify can fire
    // against an id the controller has never seen. If observe dropped it — or if open reset the
    // adopted run to `running` — a fast agent's brief would be a permanent 404 and then a 410.
    const c = makeController();
    c.admit();
    c.observe("catchup.briefReady", { sessionId: "catchup_1_cccc", brief: "md", findings: null });
    c.open("catchup_1_cccc");
    const run = c.get("catchup_1_cccc");
    expect(run?.status).toBe("done");
    expect(run?.brief).toBe("md");
  });

  test("observe ignores a notification with no string sessionId", () => {
    const c = makeController();
    c.observe("expert.briefReady", { brief: "md" });
    c.observe("expert.briefReady", { sessionId: 42 });
    c.observe("expert.briefReady", null);
    expect(c.activeCount()).toBe(0);
  });

  test("observe ignores a method that is neither briefReady nor briefError", () => {
    const c = makeController();
    c.observe("index.syncProgress", { sessionId: "expert_1_dddd" });
    expect(c.get("expert_1_dddd")).toBeNull();
  });

  test("the concurrency cap counts reservations, not just opened runs", () => {
    // The cap must hold across the await between admit() and open(): two in-flight dispatches that
    // both passed a plain activeCount() check would over-admit by exactly the number in flight.
    const c = makeController();
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) {
      expect(c.admit()).toEqual({ ok: true });
    }
    expect(c.admit()).toEqual({
      ok: false,
      activeRuns: MAX_CONCURRENT_AGENT_RUNS,
      // Every slot here is a RESERVATION, not an opened run — so no run's expiry bounds the wait
      // and there is no honest number to report. null, never a fabricated 0 or an Infinity that
      // would serialize to JSON `null` anyway and mean something different.
      oldestExpiresInSeconds: null,
    });
  });

  test("a busy refusal over OPEN runs reports when the soonest one expires", () => {
    const c = makeController(5_000);
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) {
      c.admit();
      c.open(`expert_1_h${String(i)}`);
    }
    now += 2_000;
    expect(c.admit()).toEqual({
      ok: false,
      activeRuns: MAX_CONCURRENT_AGENT_RUNS,
      // 5s TTL, 2s elapsed. This is the UPPER bound on the wait, not the expected one: a run
      // normally finishes and frees its slot long before it expires. The route sends the small
      // AGENT_BUSY_RETRY_AFTER_SECONDS as Retry-After and this only as context in the body.
      oldestExpiresInSeconds: 3,
    });
  });

  test("abandon releases a reservation", () => {
    const c = makeController();
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) c.admit();
    expect(c.admit().ok).toBe(false);
    c.abandon();
    expect(c.admit()).toEqual({ ok: true });
  });

  test("a terminal run does not hold a concurrency slot", () => {
    const c = makeController();
    c.admit();
    c.open("expert_1_eeee");
    c.observe("expert.briefReady", { sessionId: "expert_1_eeee", brief: "md", findings: null });
    expect(c.activeCount()).toBe(0);
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(c.admit().ok).toBe(true);
  });

  test("a run past its TTL expires and becomes a 410 signal", () => {
    const c = makeController(5_000);
    c.admit();
    c.open("expert_1_ffff");
    now += 5_001;
    expect(c.get("expert_1_ffff")).toBeNull();
    expect(c.wasKnown("expert_1_ffff")).toBe(true);
  });

  test("an id that never existed is a 404 signal, not a 410", () => {
    const c = makeController();
    expect(c.get("expert_1_nope")).toBeNull();
    expect(c.wasKnown("expert_1_nope")).toBe(false);
  });

  test("expiry happens without anyone polling", () => {
    // Access-triggered expiry alone would let three never-polled runs pin the cap until restart.
    const c = makeController(5_000);
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) {
      c.admit();
      c.open(`expert_1_${String(i)}`);
    }
    expect(c.admit().ok).toBe(false);
    now += 5_001;
    expect(c.admit()).toEqual({ ok: true });
  });

  test("retained terminal runs are bounded, oldest evicted first", () => {
    const c = makeController();
    for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENT_RUNS + 2; i++) {
      now += 1;
      c.admit();
      const id = `expert_${String(i)}_g`;
      c.open(id);
      c.observe("expert.briefReady", { sessionId: id, brief: "md", findings: null });
    }
    expect(c.get("expert_0_g")).toBeNull();
    expect(c.wasKnown("expert_0_g")).toBe(true);
    expect(c.get(`expert_${String(MAX_RETAINED_TERMINAL_AGENT_RUNS + 1)}_g`)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```text
bun test packages/gateway/src/agent-runs/agent-run-store.test.ts
```

Expected: FAIL — `Cannot find module './agent-run-store.ts'`.

- [ ] **Step 3: Write the controller**

Create `packages/gateway/src/agent-runs/agent-run-store.ts`:

```ts
/**
 * In-memory store for HTTP-invoked agent runs, modelled on `briefs/brief-run-store.ts` (which is
 * itself modelled on `clips/pairing-window.ts`, invariant I30): a plain Map, injected clock, lazy
 * expiry, no timer and no sweeper thread.
 *
 * A gateway restart drops everything, DELIBERATELY. Persisting these would write synthesised brief
 * text — derived from the private index — into a new on-disk table, which is a privacy expansion,
 * to buy resumption of something reproducible by re-issuing the call. The cost is that a client
 * polling across a restart sees 404, not 410, because the tombstone set dies with the process. That
 * is a stated contract, not an accident: 404 means "unknown OR lost to a restart", and the client's
 * response to both is to re-issue, never to keep waiting.
 */

/** Run lifetime from creation. NOT refreshed on access — a polling client must not pin memory. */
export const AGENT_RUN_TTL_MS = 10 * 60_000;
/** Live (non-terminal) runs plus outstanding reservations. Mirrors briefs' MAX_CONCURRENT_RUNS. */
export const MAX_CONCURRENT_AGENT_RUNS = 3;
/** Terminal runs retained for polling after finishing, oldest evicted first. */
export const MAX_RETAINED_TERMINAL_AGENT_RUNS = 16;
/** Cap on the expired-run tombstone set (drives 410 vs 404). Oldest evicted first. */
export const MAX_EXPIRED_AGENT_TOMBSTONES = 256;
/**
 * `Retry-After` on a busy refusal, in seconds.
 *
 * Small ON PURPOSE, and NOT derived from the run TTL. A slot frees when a run FINISHES, which for
 * an agent brief is seconds — not when it expires, which is ten minutes. Reporting the expiry
 * distance (as the briefs store does, where a run legitimately sits collecting for as long as a
 * human keeps feeding it) would tell a client to wait ten minutes for a three-second brief. That
 * is a misleading number, not a conservative one. A client that retries too early simply gets
 * another 429 carrying the header again, which costs one request.
 */
export const AGENT_BUSY_RETRY_AFTER_SECONDS = 1;

export type AdmitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly activeRuns: number;
      /**
       * Seconds until the soonest non-terminal run expires — the UPPER bound on the wait, offered
       * as context rather than as the retry hint. `null` when every occupied slot is an in-flight
       * RESERVATION rather than an opened run: nothing on the clock bounds that wait, and 0 or
       * Infinity would both be claims the store cannot support.
       */
      readonly oldestExpiresInSeconds: number | null;
    };

export type AgentRunStatus = "running" | "done" | "failed";

export type AgentRun = {
  readonly id: string;
  status: AgentRunStatus;
  createdAtMs: number;
  expiresAtMs: number;
  /** Synthesised markdown from `<agent>.briefReady`. */
  brief: string | null;
  /** The typed brief from the same notification. `unknown`: the shape is per-agent. */
  findings: unknown;
  error: string | null;
};

export type AgentRunControllerDeps = {
  readonly nowMs: () => number;
  readonly ttlMs?: number;
};

const READY_SUFFIX = ".briefReady";
const ERROR_SUFFIX = ".briefError";

function readSessionId(params: unknown): string | null {
  if (params === null || typeof params !== "object") return null;
  const p = params as { sessionId?: unknown };
  return typeof p.sessionId === "string" && p.sessionId !== "" ? p.sessionId : null;
}

export class AgentRunController {
  private readonly runs = new Map<string, AgentRun>();
  /** Ids that existed and have since expired or been evicted — drives 410 vs 404. */
  private readonly expired = new Set<string>();
  /** Admitted but not yet opened. Held across the await between admit() and open(). */
  private pending = 0;
  private readonly nowMs: () => number;
  private readonly ttlMs: number;

  constructor(deps: AgentRunControllerDeps) {
    this.nowMs = deps.nowMs;
    this.ttlMs = deps.ttlMs ?? AGENT_RUN_TTL_MS;
  }

  /**
   * Drops every run past its TTL. Called before the admission check because expiry is otherwise
   * access-triggered: three runs created and never polled would never expire and would pin the cap
   * until the gateway restarted.
   */
  private sweep(): void {
    const now = this.nowMs();
    for (const [id, run] of this.runs) {
      if (now > run.expiresAtMs) {
        this.runs.delete(id);
        this.rememberExpired(id);
      }
    }
  }

  private rememberExpired(id: string): void {
    this.expired.add(id);
    while (this.expired.size > MAX_EXPIRED_AGENT_TOMBSTONES) {
      const oldest = this.expired.values().next().value;
      if (oldest === undefined) break;
      this.expired.delete(oldest);
    }
  }

  private isTerminal(run: AgentRun): boolean {
    return run.status === "done" || run.status === "failed";
  }

  /** Non-terminal runs only — a terminal run holds no work and must not lock a caller out. */
  activeCount(): number {
    this.sweep();
    let n = 0;
    for (const run of this.runs.values()) if (!this.isTerminal(run)) n += 1;
    return n;
  }

  private trimTerminal(): void {
    const terminal = [...this.runs.values()]
      .filter((r) => this.isTerminal(r))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (let i = 0; i < terminal.length - MAX_RETAINED_TERMINAL_AGENT_RUNS; i++) {
      const run = terminal[i] as AgentRun;
      this.runs.delete(run.id);
      this.rememberExpired(run.id);
    }
  }

  /**
   * Reserves a concurrency slot SYNCHRONOUSLY, before the caller awaits the dispatch that mints the
   * run id. Two in-flight dispatches that had merely checked `activeCount()` would both pass and
   * over-admit; the reservation is what makes the cap hold across the await.
   */
  admit(): AdmitResult {
    const active = this.activeCount() + this.pending;
    if (active >= MAX_CONCURRENT_AGENT_RUNS) {
      return { ok: false, activeRuns: active, oldestExpiresInSeconds: this.soonestExpiry() };
    }
    this.pending += 1;
    return { ok: true };
  }

  /**
   * Seconds until the soonest non-terminal run expires, or null when there is none.
   *
   * The null case is real here in a way it is not for briefs: a busy refusal can be caused purely
   * by in-flight RESERVATIONS, with zero opened runs. The briefs store computes this only after
   * `activeCount() >= MAX`, so a run always exists and `Number.POSITIVE_INFINITY` is unreachable
   * there. Reproducing its shape without this guard would return Infinity, which `JSON.stringify`
   * turns into `null` anyway — but silently, and meaning "unknown" rather than "not clock-bounded".
   */
  private soonestExpiry(): number | null {
    const now = this.nowMs();
    let soonest = Number.POSITIVE_INFINITY;
    for (const run of this.runs.values()) {
      if (!this.isTerminal(run)) soonest = Math.min(soonest, run.expiresAtMs);
    }
    return soonest === Number.POSITIVE_INFINITY ? null : Math.max(0, Math.ceil((soonest - now) / 1000));
  }

  /** Releases a reservation whose dispatch never produced a run. */
  abandon(): void {
    if (this.pending > 0) this.pending -= 1;
  }

  /**
   * Converts a reservation into a run. ADOPTS an existing record rather than overwriting it: the
   * agent's notify can fire before this runs (emitBriefWithSynthesis starts work before returning
   * the sessionId), in which case `observe` already created the run in terminal state and resetting
   * it to `running` would strand a finished brief forever.
   */
  open(runId: string): void {
    this.abandon();
    this.ensure(runId);
  }

  private ensure(runId: string): AgentRun {
    const existing = this.runs.get(runId);
    if (existing !== undefined) return existing;
    const now = this.nowMs();
    const run: AgentRun = {
      id: runId,
      status: "running",
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      brief: null,
      findings: null,
      error: null,
    };
    this.runs.set(runId, run);
    return run;
  }

  /**
   * The notify sink. Keyed purely on the `sessionId` in the params and on the method SUFFIX, so it
   * needs no per-agent list and cannot drift as agents are added. Anything it does not recognise is
   * ignored rather than guessed at — this is the same injected `notify` channel the socket server
   * uses for unrelated notifications.
   */
  observe(method: string, params: unknown): void {
    const isReady = method.endsWith(READY_SUFFIX);
    const isError = method.endsWith(ERROR_SUFFIX);
    if (!isReady && !isError) return;
    const runId = readSessionId(params);
    if (runId === null) return;
    const run = this.ensure(runId);
    const p = params as { brief?: unknown; findings?: unknown; error?: unknown };
    if (isError) {
      run.status = "failed";
      run.error = typeof p.error === "string" ? p.error : "internal_error";
    } else {
      run.status = "done";
      run.brief = typeof p.brief === "string" ? p.brief : null;
      run.findings = p.findings ?? null;
    }
    this.trimTerminal();
  }

  /** Returns the run, or null when it is unknown OR has expired (expiry is checked here). */
  get(runId: string): AgentRun | null {
    const run = this.runs.get(runId);
    if (run === undefined) return null;
    if (this.nowMs() > run.expiresAtMs) {
      this.runs.delete(runId);
      this.rememberExpired(runId);
      return null;
    }
    return run;
  }

  /** True when this id was a real run that has since expired or been evicted — the 410 signal. */
  wasKnown(runId: string): boolean {
    return this.expired.has(runId);
  }
}
```

- [ ] **Step 4: Run to confirm it passes**

```text
bun test packages/gateway/src/agent-runs/agent-run-store.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agent-runs/
git commit -m "feat(agent-runs): in-memory agent run store with reservation-based admission"
```

**Definition of done:** every test above green, including the completes-before-open adoption case and the reservation cap; no timers; no disk writes.

---

### Task 6: The HTTP-invokable agent set and the invoker

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts`
- Create: `packages/gateway/src/agent-runs/agent-http-invoke.ts`
- Test: `packages/gateway/src/ipc/agents-rpc.test.ts`, `packages/gateway/src/agent-runs/agent-http-invoke.test.ts`

**Interfaces:**

- Consumes: `AgentRunController` (Task 5), `dispatchAgentsRpc` / `AgentsRpcError` (existing).
- Produces:
  - From `ipc/agents-rpc.ts`: `HTTP_AGENT_NAMES: readonly string[]`, `resolveHttpAgentMethod(agent: string): string | null`
  - From `agent-runs/agent-http-invoke.ts`: `type AgentInvokeResult`, `type AgentHttpInvoker`, `buildAgentHttpInvoker(deps): AgentHttpInvoker`

> **Two exclusions, both decided here.**
>
> `agents.preflight` — carried over unchanged from the MCP design: it is the `I24` federated-action path, and a caller that can invoke it can queue consent prompts on the owner's machine.
>
> `agents.whyPeek` — **excluded, and this resolves a gap the spec does not address.** §1 says `{agent}` resolves against `AGENTS_RPC_HANDLERS` minus `agents.preflight`, and describes a uniform `{runId}` + poll contract. But `agents.whyPeek` is the namespace's one **synchronous** method (`agents-rpc.ts:439-447`): it returns a `WhyPeek` payload directly and calls `notify` **never**. Put it on the run/poll contract and it creates a run that can never complete — the caller polls until the TTL turns it into a 410, which is a lie. The alternatives are (a) a second response shape on `POST /v1/agents/{agent}`, forcing every client to branch, or (b) exclusion. Exclusion is chosen: it costs the browser panel nothing today, it is reversible as its own inline-result route, and inventing a second contract at the keyboard is precisely the #1059 failure. Recorded as an open question for a later PR. Ledger coverage is unaffected either way — `whyPeek` is in `AGENTS_RPC_HANDLERS`, so it would append under the generalised condition regardless of which transport reaches it.
>
> **`AGENTS_RPC_HANDLERS` itself is NOT exported.** Exporting the map would let another file call a handler directly — a bypass `D22(d)` cannot see, because it is not an `agents/<name>.ts` import. Only the derived name list and the resolver leave the module.

- [ ] **Step 1: Write the failing resolver tests**

Add to `packages/gateway/src/ipc/agents-rpc.test.ts`:

```ts
describe("the HTTP-invokable agent set", () => {
  test("is exactly the ten asynchronous, non-preflight agents", () => {
    expect([...HTTP_AGENT_NAMES]).toEqual([
      "catchup",
      "conflicts",
      "decisions",
      "expert",
      "ghost",
      "glossary",
      "huddle",
      "impact",
      "janitor",
      "why",
    ]);
  });

  test("preflight is not reachable over HTTP", () => {
    // I24: agents.preflight is the federated-action path. A caller that can invoke it can queue
    // consent prompts on the owner's machine — an external caller must never originate one.
    expect(resolveHttpAgentMethod("preflight")).toBeNull();
    expect(HTTP_AGENT_NAMES).not.toContain("preflight");
  });

  test("whyPeek is not reachable over HTTP", () => {
    // Synchronous by design (the why-lens hover): it returns a payload and notifies never, so the
    // run/poll contract would produce a run that can never complete.
    expect(resolveHttpAgentMethod("whyPeek")).toBeNull();
  });

  test("ghost and huddle stay in, as they did for MCP", () => {
    expect(resolveHttpAgentMethod("ghost")).toBe("agents.ghost");
    expect(resolveHttpAgentMethod("huddle")).toBe("agents.huddle");
  });

  test("the resolver is prototype-safe and rejects anything unserved", () => {
    // A caller-supplied path segment reaches this. `Object.hasOwn` (not `in`) is what stops
    // "constructor" / "__proto__" / "toString" resolving to an inherited property.
    for (const junk of ["__proto__", "constructor", "toString", "", "expert.extra", "Expert"]) {
      expect(resolveHttpAgentMethod(junk)).toBeNull();
    }
  });

  test("every HTTP_AGENT_NAMES entry resolves back to a served method", () => {
    // The list and the resolver are two derivations of the same map; this pins them together so a
    // name cannot be advertised by GET /v1/agents and then 404 on invocation.
    for (const name of HTTP_AGENT_NAMES) {
      expect(resolveHttpAgentMethod(name)).toBe(`agents.${name}`);
    }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```text
bun test packages/gateway/src/ipc/agents-rpc.test.ts -t "HTTP-invokable"
```

Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Add the set and resolver**

Append to `packages/gateway/src/ipc/agents-rpc.ts`, immediately after `AGENTS_RPC_HANDLERS`:

```ts
const AGENTS_METHOD_PREFIX = "agents.";

/**
 * Methods served on the socket but deliberately NOT exposed on the HTTP API.
 *
 * `agents.preflight` — the I24 federated-action path. A caller that can invoke it can queue consent
 * prompts on the owner's machine; an external caller must never originate one. Carried over
 * unchanged from the MCP tool surface, for the same reason.
 *
 * `agents.whyPeek` — the namespace's one SYNCHRONOUS method. It returns a WhyPeek payload directly
 * and never calls `notify`, so it cannot be represented on the HTTP `{runId}` + poll contract: the
 * run would never complete and the caller would poll until the TTL turned a success into a 410.
 * Exposing it needs its own inline-result route, which is a later decision, not a second response
 * shape bolted onto this one.
 */
const HTTP_EXCLUDED_AGENT_METHODS: ReadonlySet<string> = new Set([
  "agents.preflight",
  "agents.whyPeek",
]);

/**
 * The agent names `POST /v1/agents/{agent}` accepts and `GET /v1/agents` publishes.
 *
 * DERIVED from AGENTS_RPC_HANDLERS, so it cannot drift from the served set — a hand-maintained
 * second list of the same names is the #1059 defect shape. Sorted for a stable wire response.
 */
export const HTTP_AGENT_NAMES: readonly string[] = Object.freeze(
  Object.keys(AGENTS_RPC_HANDLERS)
    .filter((m) => !HTTP_EXCLUDED_AGENT_METHODS.has(m))
    .map((m) => m.slice(AGENTS_METHOD_PREFIX.length))
    .sort(),
);

/**
 * The `agents.*` method for an HTTP path segment, or null when that segment names nothing this
 * surface serves.
 *
 * `Object.hasOwn`, never `in`: the segment is caller-supplied, and `in` would resolve
 * `"constructor"` / `"toString"` against the object prototype. Same reasoning as the append gate's
 * membership check.
 *
 * AGENTS_RPC_HANDLERS itself is NOT exported. Handing the map out would let another file invoke an
 * agent directly — a bypass D22(d) cannot see, since it is not an `agents/<name>.ts` import.
 */
export function resolveHttpAgentMethod(agent: string): string | null {
  const method = `${AGENTS_METHOD_PREFIX}${agent}`;
  if (!Object.hasOwn(AGENTS_RPC_HANDLERS, method)) return null;
  if (HTTP_EXCLUDED_AGENT_METHODS.has(method)) return null;
  return method;
}
```

- [ ] **Step 4: Run to confirm it passes**

```text
bun test packages/gateway/src/ipc/agents-rpc.test.ts
```

Expected: PASS. If the ten-name list differs from the assertion in Step 1, **the assertion is right and the exclusion set is wrong** — recount against `AGENTS_RPC_HANDLERS` (twelve keys, minus `preflight` and `whyPeek`).

- [ ] **Step 5: Write the failing invoker tests**

Create `packages/gateway/src/agent-runs/agent-http-invoke.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { buildAgentHttpInvoker } from "./agent-http-invoke.ts";
import { AgentRunController, MAX_CONCURRENT_AGENT_RUNS } from "./agent-run-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function makeInvoker(db: Database, runs: AgentRunController) {
  return buildAgentHttpInvoker({ db, runs });
}

describe("buildAgentHttpInvoker", () => {
  test("an unknown agent is refused before any admission is spent", async () => {
    const db = freshDb();
    const runs = new AgentRunController({ nowMs: () => 1 });
    const out = await makeInvoker(db, runs)("nope", {}, "chrome");
    expect(out).toEqual({ ok: false, reason: "unknown_agent" });
    // No reservation leaked: the cap is still fully available.
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);
  });

  test("preflight is refused as unknown, not merely unrouted", async () => {
    const db = freshDb();
    const runs = new AgentRunController({ nowMs: () => 1 });
    expect(await makeInvoker(db, runs)("preflight", { ref: "HEAD" }, "chrome")).toEqual({
      ok: false,
      reason: "unknown_agent",
    });
    expect(db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 0 });
  });

  test("a successful invocation returns the gateway sessionId as the runId", async () => {
    const db = freshDb();
    const runs = new AgentRunController({ nowMs: () => 1 });
    const out = await makeInvoker(db, runs)("expert", { topicOrFile: "auth.ts" }, "chrome");
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    // The gateway's own <agent>_<ts>_<uuid8> id, reused rather than a second identifier minted —
    // so a ledger row, a brief and an HTTP poll all name the same thing.
    expect(out.runId).toMatch(/^expert_\d+_[0-9a-f]{8}$/);
    expect(runs.get(out.runId)).not.toBeNull();
  });

  test("the invocation appends exactly one source_type='http' row, attributed to the label", async () => {
    const db = freshDb();
    const runs = new AgentRunController({ nowMs: () => 1 });
    await makeInvoker(db, runs)("expert", { topicOrFile: "auth.ts" }, "chrome-work");
    const rows = db
      .query("SELECT source_type, source_id, method FROM egress_ledger")
      .all() as Array<{ source_type: string; source_id: string; method: string }>;
    expect(rows).toEqual([
      { source_type: "http", source_id: "chrome-work", method: "agents.expert" },
    ]);
  });

  test("invalid params are a typed refusal, not a thrown error", async () => {
    const db = freshDb();
    const runs = new AgentRunController({ nowMs: () => 1 });
    const out = await makeInvoker(db, runs)("expert", { topicOrFile: "" }, "chrome");
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("invalid_params");
    // The reservation is released, or a client could exhaust the cap with malformed requests.
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);
  });

  test("validation failure still leaves the egress row — the append precedes validation", async () => {
    // Stated rather than discovered: dispatchAgentsRpc appends BEFORE dispatchByMethod, and the
    // per-agent validator runs inside the handler. So a rejected call is ledgered. This matches
    // the MCP path exactly and is the honest reading of "append before any agent work".
    const db = freshDb();
    const runs = new AgentRunController({ nowMs: () => 1 });
    await makeInvoker(db, runs)("expert", { topicOrFile: "" }, "chrome");
    expect(db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 1 });
  });

  test("the concurrency cap refuses with busy and appends no egress row", async () => {
    // The cap is pre-filled through the CONTROLLER, not by issuing three real invocations.
    // Driving it with real invocations would be flaky: an agent is fire-and-forget, so its brief
    // can reach a terminal state before the next invoke runs — and a terminal run holds no slot,
    // so the fourth call would sometimes be admitted. Filling with reservations is deterministic
    // and exercises exactly the path the route hits under concurrent requests.
    const db = freshDb();
    const runs = new AgentRunController({ nowMs: () => 1 });
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);

    expect(await makeInvoker(db, runs)("expert", { topicOrFile: "x" }, "chrome")).toEqual({
      ok: false,
      reason: "busy",
      activeRuns: MAX_CONCURRENT_AGENT_RUNS,
      // Every slot is a reservation, so nothing on the clock bounds the wait.
      oldestExpiresInSeconds: null,
    });
    // Refused before dispatch, so before the append: a rejected request is not egress.
    expect(db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 0 });
  });

  test("a failing egress append creates NO run and propagates — fail closed", async () => {
    // The whole I29 claim in one test: no row, no brief. A read-only handle makes the append throw
    // the way a real disk failure would.
    const db = freshDb();
    db.exec("PRAGMA query_only = ON");
    const runs = new AgentRunController({ nowMs: () => 1 });
    await expect(makeInvoker(db, runs)("expert", { topicOrFile: "x" }, "chrome")).rejects.toThrow();
    expect(runs.activeCount()).toBe(0);
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);
  });
});
```

> **On the last test:** `PRAGMA query_only = ON` is how `http-server.ts:749` makes its read handle read-only, so this is the codebase's own idiom rather than an invented failure mode. If it does not make `appendEgressEntry` throw, **report NEEDS_CONTEXT rather than weakening the test** — find how `egress-ledger.test.ts` provokes an append failure and mirror that.

- [ ] **Step 6: Run to confirm they fail**

```text
bun test packages/gateway/src/agent-runs/agent-http-invoke.test.ts
```

Expected: FAIL — `Cannot find module './agent-http-invoke.ts'`.

- [ ] **Step 7: Write the invoker**

Create `packages/gateway/src/agent-runs/agent-http-invoke.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc, resolveHttpAgentMethod } from "../ipc/agents-rpc.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import type { AgentRunController } from "./agent-run-store.ts";

export type AgentInvokeResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly reason: "unknown_agent" }
  | {
      readonly ok: false;
      readonly reason: "busy";
      readonly activeRuns: number;
      readonly oldestExpiresInSeconds: number | null;
    }
  | { readonly ok: false; readonly reason: "invalid_params"; readonly detail: string };

export type AgentHttpInvokerDeps = {
  readonly db: Database;
  readonly runs: AgentRunController;
  readonly index?: LocalIndex;
  readonly configDir?: string;
  readonly selfIdentity?: BoxKeypair;
};

/**
 * `(agent, params, clientLabel) => result`. `clientLabel` is the VERIFIED token label from
 * `verifyApiToken` — server-derived, never caller-supplied.
 */
export type AgentHttpInvoker = (
  agent: string,
  params: unknown,
  clientLabel: string,
) => Promise<AgentInvokeResult>;

function readSessionId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { sessionId?: unknown };
  return typeof v.sessionId === "string" && v.sessionId !== "" ? v.sessionId : null;
}

/**
 * The HTTP entry point into the agents namespace.
 *
 * Reaches agents THROUGH `dispatchAgentsRpc`, never through an `agents/<name>.ts` emitter — that is
 * what makes the egress append total by construction, and it is the property D22(d) enforces
 * statically. The params go through VERBATIM: the gateway's own validator is the only contract, so
 * unlike the MCP adapter there is no second schema to drift (the #1059 defect area).
 *
 * The context deliberately mirrors `ipc/server/dispatchers.ts` `tryDispatchAgentsRpc` — including
 * omitting `llm`, which that path also omits, so HTTP briefs synthesise exactly as socket briefs
 * do. `notify` writes ONLY into the run controller: broadcasting an HTTP caller's brief onto the
 * socket would hand it to every other local client.
 */
export function buildAgentHttpInvoker(deps: AgentHttpInvokerDeps): AgentHttpInvoker {
  return async (agent, params, clientLabel): Promise<AgentInvokeResult> => {
    const method = resolveHttpAgentMethod(agent);
    if (method === null) return { ok: false, reason: "unknown_agent" };

    // Reserved SYNCHRONOUSLY, before the await: the run id does not exist until dispatch returns,
    // so a post-hoc count would over-admit by the number of in-flight requests.
    const admitted = deps.runs.admit();
    if (!admitted.ok) {
      return {
        ok: false,
        reason: "busy",
        activeRuns: admitted.activeRuns,
        oldestExpiresInSeconds: admitted.oldestExpiresInSeconds,
      };
    }

    let out: Awaited<ReturnType<typeof dispatchAgentsRpc>>;
    try {
      out = await dispatchAgentsRpc(method, params, {
        db: deps.db,
        notify: (m, p): void => {
          deps.runs.observe(m, p);
        },
        ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
        ...(deps.index === undefined ? {} : { index: deps.index }),
        ...(deps.selfIdentity === undefined ? {} : { selfIdentity: deps.selfIdentity }),
        // Server-derived on BOTH fields. There is no connection to hand-shake here, so `kind` is a
        // literal the gateway sets after verifying the token, and `clientId` is that token's label
        // — stronger attribution than stdio's self-declared kind, not weaker.
        caller: { clientId: clientLabel, kind: "http" },
      });
    } catch (e) {
      deps.runs.abandon();
      if (e instanceof AgentsRpcError) {
        return { ok: false, reason: "invalid_params", detail: e.message };
      }
      // A failed egress append lands here. It propagates: no row, no run, no brief (I29).
      throw e;
    }

    if (out.kind === "miss") {
      // Unreachable — resolveHttpAgentMethod already checked membership of the same map — but a
      // silent leaked reservation would be worse than a redundant branch.
      deps.runs.abandon();
      return { ok: false, reason: "unknown_agent" };
    }

    const runId = readSessionId(out.value);
    if (runId === null) {
      deps.runs.abandon();
      throw new TypeError(`agent ${agent} returned no sessionId; cannot open a run`);
    }
    deps.runs.open(runId);
    return { ok: true, runId };
  };
}
```

- [ ] **Step 8: Run to confirm they pass**

```text
bun test packages/gateway/src/agent-runs/ packages/gateway/src/ipc/agents-rpc.test.ts && bun run audit:invariants
```

Expected: PASS. `audit:invariants` matters here: `agent-http-invoke.ts` imports from `ipc/agents-rpc.ts`, not from an emitter, so `D22(d)` must stay green. **If it reds, the invoker is reaching an emitter directly and the design has been broken** — fix the import, do not touch the rule.

- [ ] **Step 9: Commit**

```bash
git add -u && git add packages/gateway/src/agent-runs/
git commit -m "feat(agent-runs): HTTP agent invoker over dispatchAgentsRpc, with the exposed set derived"
```

**Definition of done:** ten names exposed; `preflight` and `whyPeek` refused; a successful invoke returns the sessionId and appends one `http` row; busy / invalid_params / unknown_agent are distinct; a failing append yields no run; `D22(d)` still green.

---

### Task 7: `POST /v1/agents/{agent}` on the I13 write surface

**Files:**

- Modify: `packages/gateway/src/ipc/http-write-routes.ts`
- Modify: `packages/gateway/src/ipc/http-route-auth.ts`
- Test: `packages/gateway/src/ipc/http-route-auth.test.ts`, `packages/gateway/src/agent-runs/agent-http-e2e.test.ts` (created in Task 9)

**Interfaces:**

- Consumes: `AgentHttpInvoker` (Task 6), `ApiScope` / `enforceClipScope` (PR 1).
- Produces:

```ts
export interface AgentsWriteSurface {
  readonly verifyToken: (
    presented: string,
  ) => Promise<{ label: string; scopes: readonly ApiScope[] } | null>;
  readonly invoke: AgentHttpInvoker;
}
```

`WriteRouteContext` gains `readonly agents?: AgentsWriteSurface;`. `WRITE_ROUTE_ALLOWLIST` gains `"POST /v1/agents/{agent}"`.

> **Before writing any of this, quote `resolveBriefCreateRoute` (`http-write-routes.ts:441-455`), `requireBriefAuth` (~line 997) and `runClipIngestRoute` (~line 902) into your working notes.** Every helper below mirrors one of them — the reject-action/audit shape in particular. Mirroring from memory is how PR 1 acquired five plan-originated defects. If any of them differs from what this plan shows, **the source wins; report NEEDS_CONTEXT**.

- [ ] **Step 1: Write the failing table test**

Add to `packages/gateway/src/ipc/http-route-auth.test.ts`:

```ts
  test("the agent invoke route requires the agents scope", () => {
    expect(HTTP_ROUTE_AUTH["POST /v1/agents/{agent}"]).toEqual({ kind: "clip", scope: "agents" });
  });

  test("a briefs-only token is refused on the agent invoke route", () => {
    // The whole point of PR 1: a token minted to clip a page must not run any read-only agent over
    // the whole index. `agents` was added to the vocabulary in PR 1 precisely so it could be
    // WITHHELD before this route existed.
    expect(enforceClipScope("POST /v1/agents/{agent}", ["clip", "briefs"])).toEqual({
      ok: false,
      status: 403,
      body: { error: "insufficient_scope", required: "agents", granted: ["clip", "briefs"] },
    });
  });
```

- [ ] **Step 2: Run to confirm it fails**

```text
bun test packages/gateway/src/ipc/http-route-auth.test.ts
```

Expected: FAIL — the table has no such key, so `enforceClipScope` returns the 500 misconfiguration verdict.

- [ ] **Step 3: Add the table entry**

In `packages/gateway/src/ipc/http-route-auth.ts`, in the writes block:

```ts
  // `{agent}`, not `:agent` — matches the `{id}` convention already used by the brief and SCIM
  // item routes, and the key is the STATIC route constant, never a request path with the segment
  // substituted in (see scopeRefusal's contract).
  "POST /v1/agents/{agent}": { kind: "clip", scope: "agents" },
```

- [ ] **Step 4: Add the route to the write surface**

In `packages/gateway/src/ipc/http-write-routes.ts`:

```ts
const ROUTE_AGENT_INVOKE = "POST /v1/agents/{agent}";
```

```ts
const AGENTS_DISABLED_HINT = "agent invocation over HTTP disabled — no local index is wired";
const AGENT_INVOKE_REJECT_ACTION = "agents.invoke_rejected";
```

```ts
/** `/v1/agents/<name>` — path-param routing by regex, as the brief and SCIM item routes do. */
const AGENT_INVOKE_RE = /^\/v1\/agents\/([A-Za-z]{1,32})$/;
```

Add `ROUTE_AGENT_INVOKE` to `WRITE_ROUTE_ALLOWLIST` and extend its doc comment with one sentence:

```text
 * `POST /v1/agents/{agent}` invokes one read-only agent and returns a run id to poll (auth = the
 * same labeled client token, verified in-route, requiring the `agents` scope).
```

Add `"agentInvoke"` to `RouteKind`, and:

```ts
/** `POST /v1/agents/{agent}` (404 unless the agents seam is enabled). */
function resolveAgentInvokeRoute(
  method: string,
  agent: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.agents === undefined) {
    return jsonResponse({ error: "agents_disabled", hint: AGENTS_DISABLED_HINT }, 404);
  }
  return {
    key: ROUTE_AGENT_INVOKE,
    kind: "agentInvoke",
    expectedToken: "", // verified in-route against the labeled token map (clipIngest precedent)
    disabledHint: AGENTS_DISABLED_HINT,
    rejectAction: AGENT_INVOKE_REJECT_ACTION,
    hasBody: true,
    // Control-plane sized. Agent params are a topic, a file path or a since-window; the 1 MiB
    // article cap stays the deliberate outlier it is documented to be.
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
    // `id` carries the agent NAME for this route kind, as it carries the brief id for the brief
    // routes. The route KEY stays the static template either way.
    id: agent,
  };
}
```

In `resolveRoute`, after the brief item regex:

```ts
  const agentInvoke = AGENT_INVOKE_RE.exec(path);
  if (agentInvoke !== null) {
    return resolveAgentInvokeRoute(method, agentInvoke[1] as string, ctx);
  }
```

In `checkAuth`, beside the brief arms:

```ts
  // Agent invocation verifies the labeled token in-route (clipIngest precedent) and gets its own
  // rate-limit bucket, so an agent sweep cannot starve clipping and vice versa.
  if (route.kind === "agentInvoke") return { fingerprint: "agents" };
```

- [ ] **Step 5: Add the handler**

```ts
/**
 * 401/403 gate for the agent routes, returning the VERIFIED PRINCIPAL on success.
 *
 * Unlike `requireBriefAuth` this returns the label rather than discarding it: the label becomes
 * `caller.clientId` on the egress row, which is the whole attribution claim — a hand-built or
 * body-supplied client id would make the row a record of what the caller said about itself.
 */
async function requireAgentAuth(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  req: Request,
  limit: RateLimitCheck,
): Promise<Response | { label: string; scopes: readonly ApiScope[] }> {
  const agents = ctx.agents as AgentsWriteSurface;
  const presented = bearerToken(req);
  const verdict = presented === undefined ? null : await agents.verifyToken(presented);
  if (verdict === null) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 401,
      reason: "unauthorized",
    });
    return jsonResponse({ error: "unauthorized" }, 401, rateLimitHeaders(limit));
  }
  const refusal = scopeRefusal(route.key, verdict.scopes, limit);
  if (refusal !== null) {
    // See the twin comment in runClipIngestRoute: refusal.status is 403 or 500, and the recorded
    // reason must match which one actually happened.
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: refusal.status,
      reason: refusal.status === 403 ? "insufficient_scope" : "internal_error",
    });
    return refusal;
  }
  return verdict;
}

async function runAgentInvokeRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  const agents = ctx.agents as AgentsWriteSurface;
  const auth = await requireAgentAuth(ctx, route, fingerprint, req, limit);
  if (auth instanceof Response) return auth;

  let out: Awaited<ReturnType<AgentHttpInvoker>>;
  try {
    // The body goes through VERBATIM to the gateway's own validator. No params are built here and
    // no schema is mirrored, so there is no second contract to drift.
    out = await agents.invoke(route.id as string, parsed, auth.label);
  } catch {
    // Reached when the egress append fails: I29 fail-closed. No run was created and no brief was
    // emitted; the caller gets a 500 and may retry.
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }

  if (out.ok) {
    // 202: the run is accepted and in progress, not complete. Poll GET /v1/agents/runs/{id}.
    return jsonResponse({ runId: out.runId }, 202, rateLimitHeaders(limit));
  }
  if (out.reason === "unknown_agent") {
    return jsonResponse({ error: "unknown_agent" }, 404, rateLimitHeaders(limit));
  }
  if (out.reason === "busy") {
    // 429, matching the rate limiter's own refusal code: both mean "retry later", and a client
    // that already handles 429 needs no second code path. The AgentRunController cap — not the
    // 60/min token limiter — is the real bound on agent runs.
    //
    // Retry-After is MANDATORY here, not a nicety. `checkRateLimit` (this same file) already sends
    // it on the OTHER 429 this route can produce, so omitting it would mean two 429s from one
    // endpoint, one honouring the header contract and one not — and a client written to "back off
    // by Retry-After" would read null and either hammer or guess. The value is the small constant,
    // NOT the run-expiry distance: a slot frees when a run finishes (seconds), not when it expires
    // (ten minutes). The expiry distance goes in the body as an upper bound, where over-estimating
    // is context rather than an instruction, and is omitted entirely when it is null.
    return jsonResponse(
      {
        error: "busy",
        activeRuns: out.activeRuns,
        ...(out.oldestExpiresInSeconds === null
          ? {}
          : { oldestExpiresInSeconds: out.oldestExpiresInSeconds }),
      },
      429,
      {
        ...rateLimitHeaders(limit),
        "Retry-After": String(AGENT_BUSY_RETRY_AFTER_SECONDS),
      },
    );
  }
  return jsonResponse(
    { error: "invalid_params", detail: out.detail },
    400,
    rateLimitHeaders(limit),
  );
}
```

Add the dispatch arm in `dispatchWriteRoute`'s switch, beside the brief arms:

```ts
    case "agentInvoke":
      return runAgentInvokeRoute(ctx, route, auth.fingerprint, limit, req, parsed);
```

Add the surface type and the context field near `BriefsWriteSurface`:

```ts
/**
 * Agent-invocation seam — present only when the agents surface is enabled. `verifyToken` reuses the
 * same labeled client token map as `ClipsWriteSurface` / `BriefsWriteSurface`; `invoke` is the
 * closure built in `agent-runs/agent-http-invoke.ts`, which reaches agents through
 * `dispatchAgentsRpc` and therefore through the egress append.
 */
export interface AgentsWriteSurface {
  readonly verifyToken: (
    presented: string,
  ) => Promise<{ label: string; scopes: readonly ApiScope[] } | null>;
  readonly invoke: AgentHttpInvoker;
}
```

with `import type { AgentHttpInvoker } from "../agent-runs/agent-http-invoke.ts";` and
`import { AGENT_BUSY_RETRY_AFTER_SECONDS } from "../agent-runs/agent-run-store.ts";`.

- [ ] **Step 5b: Assert both 429s on this route carry `Retry-After`**

Add to `packages/gateway/src/ipc/http-write-routes.test.ts` (or the agents e2e file if the harness is
easier — the assertion is what matters, not its address):

```ts
test("the busy 429 carries Retry-After, like the rate-limited 429 on the same route", async () => {
  // Two different 429s reach a client from POST /v1/agents/{agent}: the per-token rate limiter's
  // and the run-store capacity refusal. A client backing off by Retry-After must not have to know
  // which one it got. This is the assertion that keeps them consistent as either side changes.
  const s = await startAgentTestServer();
  try {
    // Fill the cap deterministically via the controller the harness exposes, then invoke.
    s.fillRunCapacity();
    const res = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents/expert`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
      body: JSON.stringify({ topicOrFile: "x" }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await res.json()) as { error: string }).toMatchObject({ error: "busy" });
  } finally {
    s.stop();
  }
});
```

This needs one more harness affordance in Task 9: `fillRunCapacity()`, which calls
`runs.admit()` `MAX_CONCURRENT_AGENT_RUNS` times. Add it to `AgentTestServer` alongside `advance`.
**Reserve, do not open** — for the reason recorded in Task 6's cap test: a real invocation's brief
can go terminal before the next request and free the slot.

- [ ] **Step 6: Run the route-auth suite**

```text
bun test packages/gateway/src/ipc/http-route-auth.test.ts packages/gateway/src/ipc/http-write-routes.test.ts
```

Expected: PASS. The `every WRITE_ROUTE_ALLOWLIST entry has an auth decision` test is what proves the table and the allowlist agree; the `no table entry is a route that no longer exists` test excludes write-allowlisted keys, so `/v1/agents/{agent}` will not read as stale.

- [ ] **Step 7: Red-prove the new table entry**

Temporarily change the entry to `{ kind: "public" }`.

```text
bun test packages/gateway/src/ipc/http-route-auth.test.ts
```

Expected: FAIL on `the agent invoke route requires the agents scope` **and** on `a briefs-only token is refused` (which now returns the 500 misconfiguration verdict — exactly the fail-closed behaviour PR 1's `enforceClipScope` was written to produce). Restore it.

- [ ] **Step 8: Commit**

```bash
git add -u
git commit -m "feat(ipc): POST /v1/agents/{agent} on the I13 write surface, agents-scoped"
```

**Definition of done:** the route is on `WRITE_ROUTE_ALLOWLIST` with an `agents`-scoped table entry; 401 / 403 / 404 / 400 / 429 / 500 / 202 are all distinct; the reject-audit shape mirrors `requireBriefAuth`; the table entry is red-proved.

---

### Task 8: The two bearer-gated reads, and `hasScope` privatised

**Files:**

- Modify: `packages/gateway/src/ipc/http-server.ts`
- Modify: `packages/gateway/src/ipc/http-route-auth.ts`
- Test: `packages/gateway/src/ipc/http-route-auth.test.ts`

**Interfaces:**

- Consumes: `AgentRunController` (Task 5), `HTTP_AGENT_NAMES` (Task 6), `requireScopedClipToken` (PR 1).
- Produces:
  - `ReadOnlyHttpServerOptions` gains `agentRuns?: AgentRunController` and `agentInvoke?: AgentHttpInvoker`.
  - `ROUTE_KEY_AGENT_RUN_GET = "GET /v1/agents/runs/*"`, `ROUTE_KEY_AGENTS_LIST = "GET /v1/agents"`.
  - `ClipReadRouteKey` widens to the four read constants.
  - **`hasScope` is no longer exported.**

> **PR 1's parked residual, paid here.** PR 1 recorded: "no static rule confines `hasScope`'s argument to a `clipScopeFor`-derived value." It was parked with two call sites, both correct. This PR adds enforcement sites, so it earns its keep — and the right fix is **capability removal, not a regex**. `hasScope` is called from exactly one place today (`enforceClipScope`, `http-route-auth.ts:153`) plus its own unit test. Making it module-private means a call site *cannot* name a scope inline: `hasScope(scopes, "briefs")` at a handler would not compile. That is stronger than any static rule and needs no maintenance. Verified before writing: `grep -rn hasScope` finds only `http-route-auth.ts` and `http-route-auth.test.ts`.

- [ ] **Step 1: Write the failing table/scope tests**

In `packages/gateway/src/ipc/http-route-auth.test.ts`:

- Add `"/v1/agents/runs/*"` to `REGEX_ROUTED_GET`, with the comment `// matched by AGENT_RUN_GET_RE in http-server.ts`.
- Remove `hasScope` from the import and delete the `hasScope is exact membership` test — its behaviour is now covered by the four `enforceClipScope` tests, which exercise membership through the only path that can reach it.
- Add:

```ts
  test("the agent read routes require the agents scope", () => {
    expect(HTTP_ROUTE_AUTH["GET /v1/agents"]).toEqual({ kind: "clip", scope: "agents" });
    expect(HTTP_ROUTE_AUTH["GET /v1/agents/runs/*"]).toEqual({ kind: "clip", scope: "agents" });
  });

  test("a legacy token reaches neither agent read", () => {
    // A bare-string token in the Vault parses as exactly clip+briefs (PR 1). Both reads must
    // refuse it: the run poll returns a synthesised brief over the whole private index.
    for (const key of ["GET /v1/agents", "GET /v1/agents/runs/*"]) {
      expect(enforceClipScope(key, ["clip", "briefs"])).toMatchObject({ ok: false, status: 403 });
    }
  });

  test("hasScope is not exported — a call site cannot name a scope inline", async () => {
    // PR 1's parked residual, closed by capability removal rather than a static rule. While
    // hasScope was exported, `hasScope(scopes, "briefs")` at a handler would compile and would
    // make HTTP_ROUTE_AUTH decorative: the table would still pass its completeness test while the
    // real requirement lived at the call site. Now it does not compile.
    const src = await Bun.file(resolve(import.meta.dir, "http-route-auth.ts")).text();
    expect(src).toContain("function hasScope(");
    expect(src).not.toContain("export function hasScope(");
  });
```

- [ ] **Step 2: Run to confirm they fail**

```text
bun test packages/gateway/src/ipc/http-route-auth.test.ts
```

Expected: FAIL on the two table tests (no entries) and on the `hasScope` test (still exported). The `every REGEX_ROUTED_GET … has an auth decision` test also fails now that `/v1/agents/runs/*` is listed — that is the guard working.

- [ ] **Step 3: Add the entries and privatise `hasScope`**

In `packages/gateway/src/ipc/http-route-auth.ts`:

```ts
export const ROUTE_KEY_AGENT_RUN_GET = "GET /v1/agents/runs/*";
export const ROUTE_KEY_AGENTS_LIST = "GET /v1/agents";
```

In the client-token reads block:

```ts
  [ROUTE_KEY_AGENTS_LIST]: { kind: "clip", scope: "agents" },
  [ROUTE_KEY_AGENT_RUN_GET]: { kind: "clip", scope: "agents" },
```

Widen the read-key union:

```ts
export type ClipReadRouteKey =
  | typeof ROUTE_KEY_CLIPS_RELATED
  | typeof ROUTE_KEY_BRIEF_GET
  | typeof ROUTE_KEY_AGENTS_LIST
  | typeof ROUTE_KEY_AGENT_RUN_GET;
```

Drop the `export` from `hasScope`, and extend its neighbours' doc comment:

```ts
/**
 * Exact membership. MODULE-PRIVATE on purpose: while this was exported, any handler could write
 * `hasScope(scopes, "briefs")` inline, which would make HTTP_ROUTE_AUTH decorative — the table
 * would keep passing its completeness test while the requirement actually enforced lived at the
 * call site. Every enforcement site goes through `enforceClipScope`, so the table is the single
 * source of truth by construction rather than by convention.
 */
function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.includes(required);
}
```

- [ ] **Step 4: Add the two read handlers**

In `packages/gateway/src/ipc/http-server.ts`, add the imports:

```ts
import type { AgentHttpInvoker } from "../agent-runs/agent-http-invoke.ts";
import type { AgentRunController } from "../agent-runs/agent-run-store.ts";
import { HTTP_AGENT_NAMES } from "./agents-rpc.ts";
import {
  ROUTE_KEY_AGENT_RUN_GET,
  ROUTE_KEY_AGENTS_LIST,
} from "./http-route-auth.ts"; // merge into the existing http-route-auth import block
```

`./agents-rpc.ts` is the dispatcher module, **not** an emitter — `D22(d)` (Task 4) is unaffected. If `audit:invariants` reds after this step, you imported an `agents/<name>.ts` module by mistake.

Extend the options:

```ts
  // Agents over HTTP (PR 2). Both are required to mount the read surface; the write route mounts
  // from the same pair via buildAgentsSeam. Absent either => every /v1/agents route 404s.
  readonly agentRuns?: AgentRunController;
  readonly agentInvoke?: AgentHttpInvoker;
```

```ts
// GET /v1/agents/runs/{id} — bearer-authed read of an in-memory run. Mounted in the fetch handler,
// NOT in dispatchReadOnlyDataGet: that table is documented "no bearer gate", so routing a
// synthesised brief through it would expose it to any local process on the machine.
const AGENT_RUN_GET_RE = /^\/v1\/agents\/runs\/(\w{1,64})$/;

/** Kept identical to http-write-routes.ts AGENTS_DISABLED_HINT — one string, two surfaces. */
const AGENTS_DISABLED_HINT_READ = "agent invocation over HTTP disabled — no local index is wired";

async function handleAgentsList(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const clipsVault = opts.clipsVault;
  if (clipsVault === undefined || opts.agentRuns === undefined) {
    return json({ error: "agents_disabled", hint: AGENTS_DISABLED_HINT_READ }, 404);
  }
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_AGENTS_LIST);
  if (!auth.ok) return auth.response;
  // Derived from AGENTS_RPC_HANDLERS, so it cannot drift from what POST actually accepts.
  return json({ agents: [...HTTP_AGENT_NAMES] }, 200);
}

async function handleAgentRunGet(
  req: Request,
  id: string,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const clipsVault = opts.clipsVault;
  const runs = opts.agentRuns;
  if (clipsVault === undefined || runs === undefined) {
    return json({ error: "agents_disabled", hint: AGENTS_DISABLED_HINT_READ }, 404);
  }
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_AGENT_RUN_GET);
  if (!auth.ok) return auth.response;
  const run = runs.get(id);
  if (run === null) {
    // 404 means "unknown OR lost to a gateway restart" — the tombstone set is in-memory, so a
    // client polling across a restart cannot see 410. Both are terminal: re-issue the call, never
    // keep waiting. 410 means known-and-expired within this process lifetime.
    return runs.wasKnown(id) ? json({ error: "expired" }, 410) : json({ error: "not_found" }, 404);
  }
  // `failureReason`, NOT `error`: on every other route here `error` means an HTTP-level failure,
  // so reusing it for a legitimately-failed run would make `if (body.error)` — the obvious client
  // check — misread a normal outcome as a transport error. Same choice as handleBriefGet.
  return json(
    {
      status: run.status,
      ...(run.brief === null ? {} : { brief: run.brief }),
      ...(run.findings === null ? {} : { findings: run.findings }),
      ...(run.error === null ? {} : { failureReason: run.error }),
    },
    200,
  );
}
```

Mount both in the `fetch` handler, immediately after the brief-get interception and **before** the write dispatcher:

```ts
      // GET /v1/agents and GET /v1/agents/runs/{id} — bearer-authed reads; intercept before the
      // unauthenticated GET table for the same reason GET /v1/briefs/{id} is intercepted there.
      if (req.method === "GET") {
        if (url.pathname === "/v1/agents") return await handleAgentsList(req, opts);
        const agentRun = AGENT_RUN_GET_RE.exec(url.pathname);
        if (agentRun !== null) return await handleAgentRunGet(req, agentRun[1] as string, opts);
      }
```

Add the agents write seam beside `buildBriefsSeam`:

```ts
// Agent-invocation write seam — present only when clipsVault, agentRuns AND agentInvoke are all
// wired. verifyToken reuses the same labeled client token map (clipIngest precedent).
function buildAgentsSeam(opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const runs = opts.agentRuns;
  const invoke = opts.agentInvoke;
  if (clipsVault === undefined || runs === undefined || invoke === undefined) return undefined;
  return { verifyToken: (t: string) => verifyApiToken(clipsVault, t), invoke };
}
```

and spread it into `resolveWriteRouteDeps` (`...(agents === undefined ? {} : { agents })`), plus add `opts.agentRuns === undefined &&` to the `writeDb` gate in `startReadOnlyHttpServer` so the writable handle opens when only the agents surface is enabled.

- [ ] **Step 5: Run the route-auth suite**

```text
bun test packages/gateway/src/ipc/
```

Expected: PASS, including the `_RE.exec(` count pin — `REGEX_ROUTED_GET.size` is now 2 and `http-server.ts` now contains exactly two `\w+_RE.exec(` occurrences (`BRIEF_GET_RE`, `AGENT_RUN_GET_RE`). **If that pin fails, count the actual occurrences before changing anything** — a mismatch means a third regex-matched route joined the surface unguarded, which is precisely what the pin is for.

- [ ] **Step 6: Red-prove the completeness guard against the new route**

Temporarily delete the `[ROUTE_KEY_AGENTS_LIST]` line from `HTTP_ROUTE_AUTH`.

```text
bun test packages/gateway/src/ipc/http-route-auth.test.ts
```

Expected: FAIL on `every route literal in http-server.ts has an auth decision`, naming `/v1/agents`. Restore.

Then temporarily remove `"/v1/agents/runs/*"` from `REGEX_ROUTED_GET`.

Run again. Expected: FAIL on the `_RE.exec(` count pin (2 execs vs 1 listed). Restore.

- [ ] **Step 7: Run the whole gateway IPC + agent suites and typecheck**

```text
bun test packages/gateway/src/ipc/ packages/gateway/src/agent-runs/ packages/gateway/src/clips/ packages/gateway/src/briefs/ && bun run typecheck && bun run preflight:fast
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -u
git commit -m "feat(ipc): bearer-gated GET /v1/agents and /v1/agents/runs/{id}; hasScope made private"
```

**Definition of done:** both reads mounted before the unauthenticated GET table with `agents`-scoped table entries; `ClipReadRouteKey` covers all four read keys; `hasScope` unexported and the change asserted; both guards red-proved.

---

### Task 9: Assemble wiring, end-to-end proof, and docs

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts`
- Create: `packages/gateway/src/agent-runs/agent-test-server.ts`
- Create: `packages/gateway/src/agent-runs/agent-http-e2e.test.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`, `docs/architecture.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/commands/nimbus-egress.md`, `.claude/commands/nimbus-file-map.md`, `docs/CHANGELOG.md`

**Interfaces:**

- Consumes: everything above.
- Produces: `startAgentTestServer(opts?): Promise<AgentTestServer>` with `{ port, token, db, advance(ms), fillRunCapacity(), stop() }`.

> **`HTTP_ROUTES` (`ipc/http-routes.ts`) is deliberately NOT touched**, and neither is the OpenAPI YAML. Verified: neither lists `/v1/clips` or `/v1/briefs` either. Those surfaces set the precedent that the published route catalogue covers the stable read API, not every mounted route. Adding agents to one and not the other would create exactly the drift the completeness guard exists to prevent.

- [ ] **Step 1: Wire the seams into assemble**

In `packages/gateway/src/platform/assemble.ts`, extend `HttpSidecarOpts`:

```ts
  // Agents over HTTP (PR 2): threaded into ReadOnlyHttpServerOptions the same way briefs are.
  // The controller is a SINGLETON — the POST route opens runs in it and the GET route reads them.
  agentRuns?: AgentRunController;
  agentInvoke?: AgentHttpInvoker;
```

and `buildReadOnlyHttpServerOpts`:

```ts
    ...(httpOpts.agentRuns === undefined ? {} : { agentRuns: httpOpts.agentRuns }),
    ...(httpOpts.agentInvoke === undefined ? {} : { agentInvoke: httpOpts.agentInvoke }),
```

Add the boot function beside `bootBriefsIntoHttpSidecar`:

```ts
/**
 * Agents-over-HTTP boot (PR 2). Mirrors bootBriefsIntoHttpSidecar: build the singleton run store
 * and the invoker, assign them onto the caller's httpSidecarOpts so wiring order is unchanged.
 *
 * The context passed to the invoker mirrors `tryDispatchAgentsRpc` (ipc/server/dispatchers.ts) —
 * same db, index, configDir and federation identity, and the same absence of `llm`. Diverging here
 * would make an HTTP brief and a socket brief different answers to the same question.
 */
function bootAgentsIntoHttpSidecar(deps: {
  db: Database;
  localIndex: LocalIndex;
  configDir: string;
  federationIdentity: BoxKeypair | undefined;
  httpSidecarOpts: HttpSidecarOpts;
}): void {
  const agentRuns = new AgentRunController({ nowMs: () => Date.now() });
  deps.httpSidecarOpts.agentRuns = agentRuns;
  deps.httpSidecarOpts.agentInvoke = buildAgentHttpInvoker({
    db: deps.db,
    runs: agentRuns,
    index: deps.localIndex,
    configDir: deps.configDir,
    ...(deps.federationIdentity === undefined ? {} : { selfIdentity: deps.federationIdentity }),
  });
}
```

Call it from `assemblePlatformServices` where `bootBriefsIntoHttpSidecar` is called. **Read that call site and match the names of the locals available there** (`db`, `localIndex`, `paths.configDir`, and whatever the federation identity local is actually called) — do not assume the names in this snippet. If a required local is not in scope at that point, **report NEEDS_CONTEXT** rather than moving the call.

- [ ] **Step 2: Build the e2e harness**

Create `packages/gateway/src/agent-runs/agent-test-server.ts`, modelled **line for line** on `packages/gateway/src/briefs/brief-test-server.ts` (read it first). Differences:

- The seam is `clipsVault`, `agentRuns`, `agentInvoke` instead of the brief trio.
- `makeInMemoryVault` keeps the same shape, but the **default** token seed carries `["clip","briefs","agents"]` in the scoped record form, because an agents route with a legacy token is a 403 and every positive test would fail on auth. Keep the `tokensJson` override so a test can supply a legacy or narrower token.
- No `startRun` / `save` closures. The controller is built on the **harness's injected clock**, which is what makes `advance()` able to expire a run without a real wait:

```ts
export async function startAgentTestServer(opts?: {
  ttlMs?: number;
  /** false => omit agentRuns, so the seam is absent (every /v1/agents route 404s). */
  enabled?: boolean;
  /** Raw JSON for `http_api.web_clipper_tokens`. Omit for the scoped agents-capable default. */
  tokensJson?: string;
}): Promise<AgentTestServer> {
  /* …tmpdir + migrate + close + writable handle, copied verbatim from brief-test-server.ts… */
  let clockMs = Date.now();
  const nowMs = (): number => clockMs;
  const vault = makeInMemoryVault(opts?.tokensJson);
  const runs = new AgentRunController({
    nowMs,
    ...(opts?.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
  });
  const handle = startReadOnlyHttpServer(dbPath, 0, {
    nowMs,
    ...(enabled
      ? { clipsVault: vault, agentRuns: runs, agentInvoke: buildAgentHttpInvoker({ db, runs }) }
      : // Opens the I13 write surface for an UNRELATED reason so POST /v1/agents/{agent} still
        // reaches dispatchWriteRoute's `ctx.agents === undefined` check (agents_disabled, 404)
        // rather than the generic writeDb===null 405.
        { resolveDeploymentToken: async () => "agent-test-server-unused-deploy-token" }),
  });
  /* …return { port, token: KNOWN_TOKEN, db,
       advance(ms) { clockMs += ms; },
       // Reserves every concurrency slot so a test can exercise the busy 429 deterministically.
       // RESERVES rather than opens: a real invocation's brief can reach a terminal state before
       // the next request and free the slot, which would make the refusal test flaky.
       fillRunCapacity() { for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) runs.admit(); },
       stop() { … } }… */
}
```

The `advance()` + injected-clock pairing is load-bearing for the 410 test: the run store's expiry reads `nowMs`, so a real `Bun.sleep` would either be flaky or take the full TTL.

```ts
const KNOWN_TOKEN = "agent-test-token-0123456789abcdef0123456789abcd";
const KNOWN_LABEL = "agent-test-harness";

function makeInMemoryVault(tokensJson?: string): NimbusVault {
  const store = new Map<string, string>();
  store.set(
    "http_api.web_clipper_tokens",
    // Scoped form WITH `agents`, unlike the briefs harness's legacy default: every agents route is
    // agents-scoped, so a legacy seed would 403 the positive tests. The override exists so the
    // legacy and narrow-scope cases can still be exercised explicitly.
    tokensJson ??
      JSON.stringify({ [KNOWN_LABEL]: { token: KNOWN_TOKEN, scopes: ["clip", "briefs", "agents"] } }),
  );
  /* …the four NimbusVault methods, copied verbatim from brief-test-server.ts… */
}
```

- [ ] **Step 3: Write the end-to-end test**

Create `packages/gateway/src/agent-runs/agent-http-e2e.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { startAgentTestServer } from "./agent-test-server.ts";

const LEGACY_TOKENS = JSON.stringify({ chrome: "legacy-bare-string-token-0123456789abcdef" });

async function invoke(port: number, agent: string, token: string, body: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}/v1/agents/${agent}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("agents over HTTP — end to end", () => {
  test("an agents-scoped token invokes an agent and polls its run to completion", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "expert", s.token, { topicOrFile: "auth.ts" });
      expect(res.status).toBe(202);
      const { runId } = (await res.json()) as { runId: string };
      expect(runId).toMatch(/^expert_\d+_[0-9a-f]{8}$/);

      // Poll to a terminal state rather than sleeping a fixed interval: the run is fire-and-forget
      // and a fixed sleep is the classic CI flake.
      let body: { status: string; brief?: string; failureReason?: string } | null = null;
      for (let i = 0; i < 100; i++) {
        const poll = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents/runs/${runId}`, {
          headers: { authorization: `Bearer ${s.token}` },
        });
        expect(poll.status).toBe(200);
        body = (await poll.json()) as typeof body;
        if (body !== null && body.status !== "running") break;
        await Bun.sleep(20);
      }
      expect(body?.status).toBe("done");
    } finally {
      s.stop();
    }
  });

  test("the invocation appended exactly one source_type='http' egress row", async () => {
    const s = await startAgentTestServer();
    try {
      await invoke(s.port, "expert", s.token, { topicOrFile: "auth.ts" });
      const rows = s.db
        .query("SELECT source_type, source_id, method FROM egress_ledger WHERE source_type='http'")
        .all() as Array<{ source_type: string; source_id: string; method: string }>;
      expect(rows).toEqual([
        { source_type: "http", source_id: "agent-test-harness", method: "agents.expert" },
      ]);
    } finally {
      s.stop();
    }
  });

  test("a LEGACY token is refused with 403 insufficient_scope", async () => {
    // The scope story end to end: a token minted before scopes existed parses as clip+briefs and
    // must not reach any agent. This is the assertion PR 1 was built to make possible.
    const s = await startAgentTestServer({ tokensJson: LEGACY_TOKENS });
    try {
      const res = await invoke(
        s.port,
        "expert",
        "legacy-bare-string-token-0123456789abcdef",
        { topicOrFile: "x" },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; required: string; granted: string[] };
      expect(body).toEqual({
        error: "insufficient_scope",
        required: "agents",
        granted: ["clip", "briefs"],
      });
      expect(s.db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 0 });
    } finally {
      s.stop();
    }
  });

  test("an unknown token is 401, not 403", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "expert", "not-a-real-token", { topicOrFile: "x" });
      expect(res.status).toBe(401);
    } finally {
      s.stop();
    }
  });

  test("agents.preflight is not reachable over HTTP", async () => {
    // I24. A 404 here is the whole point: an external caller must not be able to queue a consent
    // prompt on the owner's machine, and no egress row is written for a route that does not exist.
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "preflight", s.token, { ref: "HEAD", namespace: "n" });
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toEqual({ error: "unknown_agent" });
      expect(s.db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 0 });
    } finally {
      s.stop();
    }
  });

  test("GET /v1/agents publishes exactly the invokable set", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const { agents } = (await res.json()) as { agents: string[] };
      expect(agents).not.toContain("preflight");
      expect(agents).not.toContain("whyPeek");
      expect(agents).toContain("expert");
      expect(agents.length).toBe(10);
    } finally {
      s.stop();
    }
  });

  test("an unknown run id is 404 and an expired one is 410", async () => {
    const s = await startAgentTestServer({ ttlMs: 5_000 });
    try {
      const poll = async (id: string): Promise<number> =>
        (
          await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents/runs/${id}`, {
            headers: { authorization: `Bearer ${s.token}` },
          })
        ).status;
      expect(await poll("expert_1_deadbeef")).toBe(404);
      const res = await invoke(s.port, "expert", s.token, { topicOrFile: "x" });
      const { runId } = (await res.json()) as { runId: string };
      s.advance(5_001);
      expect(await poll(runId)).toBe(410);
    } finally {
      s.stop();
    }
  });

  test("malformed params are 400, and the run store is untouched", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "expert", s.token, { topicOrFile: "" });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_params" });
    } finally {
      s.stop();
    }
  });
});
```

- [ ] **Step 4: Run the e2e suite**

```text
bun test packages/gateway/src/agent-runs/
```

Expected: PASS. If the poll loop times out, the notify sink is not wired to the controller — check that `buildAgentHttpInvoker`'s `notify` calls `runs.observe`, not the socket broadcast.

- [ ] **Step 5: Update `docs/SECURITY-INVARIANTS.md`**

The `I29` section needs four edits, all in the same commit as the wiring (the triple rule):

1. **The `D22(c)` limit paragraph (line ~567)** currently reads that "a second entry point that serves a brief WITHOUT calling the appender spells nothing it matches… A new surface that calls the `agents/*` `emit*Brief` functions directly (a browser-reachable agent route… ) would append nothing, serve the brief, and leave `audit:invariants` green." **That prediction has now come true and been closed.** Rewrite it to say rule (d) closes it, and state (d)'s own limit: it is a regex over import specifiers and does not follow re-export chains, which is why `security-invariants.test.ts` separately asserts `agents/_lib/` re-exports no emitter.
2. **The `Wired at` bullets (lines ~580-582)**: the append condition is now a lookup over `EGRESS_BEARING_CLIENT_KINDS` (total over `ClientKind`), the appender is `recordAgentBriefEgress` parameterised by source type, and there is a second entry point — `agent-runs/agent-http-invoke.ts` — which reaches agents through `dispatchAgentsRpc`, never through an emitter.
3. **The `Enforced statically` bullet (line ~587)**: `D22` now has **four** rules. Describe (d) exactly, including that it matches both the static and the dynamic import forms.
4. **The coverage sentence (line ~571)** and the **anti-pattern list (line ~591)**: the vector now records **three** non-`none` classes (`task`, `mcp`, `http`); add anti-patterns — "widening `RECOGNISED` in `client-kind.ts` to let a socket client declare `kind: \"http\"`", "weakening `EGRESS_BEARING_CLIENT_KINDS` from a total `Record<ClientKind, …>` to a `Partial` or a `Map`", and "adding an `agents/<name>.ts` import outside `agents-rpc.ts`".

- [ ] **Step 6: Update the remaining doc surfaces**

- `CLAUDE.md` + `GEMINI.md` — the `I29` bullet: the second append path now covers **MCP-originated and HTTP-originated** agent briefs, gated on a total client-kind map; `D22` has **four** rules. Keep both files identical (they are mirrors and drift between them is its own defect).
- `docs/architecture.md` (~line 1378) — qualifier (3): the vector now records `task`, `mcp` **and** `http` as `per-call`; name the `http` narrowing.
- `.claude/commands/nimbus-egress.md` (lines ~27, ~101) — "this binary watches exactly two classes" becomes three; describe the `http` blackout the same way the `mcp` one is described.
- `.claude/commands/nimbus-file-map.md` (~line 315) — the renamed module, plus new rows for `agent-runs/agent-run-store.ts` and `agent-runs/agent-http-invoke.ts`.

- [ ] **Step 7: Add the CHANGELOG entry**

Prepend to the `## Post-Phase-6 deliveries` list in `docs/CHANGELOG.md`, above the 2026-08-06 token-scopes entry. Cover: the three routes; the `agents` scope becoming live; the `http` source type and coverage class; `D22(d)`; the run contract (404 = unknown *or* lost to a restart); and — stated plainly, because operators will see it — **that every `nimbus prove` window spanning this upgrade reports `indeterminate`, by design**. Name the `preflight` and `whyPeek` exclusions and why.

- [ ] **Step 8: Full preflight**

```text
bun run preflight
```

Expected: PASS. Specifically watch:

- `audit:invariants` — runs first and fails first.
- `lint:markdown` — globs `docs/**/*.md` and fails the **whole branch**; a pre-existing violation in a doc you touched is now yours.
- `lychee` — **no `file:///` links**, which resolve on Windows and fail on Linux (PR 1 shipped two).
- `audit:coverage-floor` — **CI-Linux-authoritative**. The new files under `agent-runs/` must clear 85% line / 80% branch. If Windows reports a violation, check `git diff --name-only` before believing it, then confirm with `bun run verify:docker`.
- `typecheck:tests` — covers `packages/gateway/test/**`, which no tsconfig `include` reaches.

- [ ] **Step 9: Commit and open the PR**

```bash
git add -u && git add packages/gateway/src/agent-runs/
git commit -m "feat(gateway): wire agents over HTTP into assemble, with e2e proof and docs"
```

PR title (this becomes the squash commit subject release-please parses):

```text
feat(gateway): invoke read-only agents over the HTTP API, recorded in the egress ledger
```

**Definition of done:** `bun run preflight` fully green; the e2e suite proves invoke → poll → done, one `http` egress row, a legacy token refused with zero rows, `preflight` unreachable; every doc surface names the new symbol and the fourth `D22` rule; `docs/CHANGELOG.md` states the `prove` blackout.

---

## Out of scope for this PR

Carried from the design's own list, restated so nobody adds them mid-implementation:

- **`GET /v1/items/resolve`** and the V50 `resolve_key` migration — PR 3.
- **`POST /v1/items/fetch`**, `fetchOne`, the derived host boundary, and raising `sync` to `per-run` — PR 4. **Do not raise `sync` here.**
- **Agent cancellation.** No `AbortController` exists on the agent path, so a cancel route would be a lie.
- **Persisting agent runs to SQLite.** Rejected in review: it would write synthesised brief text derived from the private index into a new on-disk table.
- **A generic `POST /v1/rpc` bridge.** Sequenced behind the per-method egress-coverage question it depends on.
- **Migrating the stdio MCP adapter to HTTP.**
- **Tightening the `agents.*` validators to reject unknown keys.** Pre-existing IPC semantics; changing them affects every caller. Recorded as a known gap, not inherited as solved.
- **Publishing each agent's parameter schema from `GET /v1/agents`.** The validators are hand-written imperative checks; deriving is not currently possible and hand-mirroring is the exact #1059 defect.
- **Exposing `agents.whyPeek` over HTTP.** Needs its own inline-result route (Task 6).

## Reviewed and deferred

From [`./2026-08-06-http-agents-pr2-agents-over-http-review.md`](./2026-08-06-http-agents-pr2-agents-over-http-review.md).
Recorded here so they are re-decided rather than re-discovered. Its fourth item — `Retry-After` on
the busy 429 — was **accepted and is implemented** in Tasks 5-7.

**1. A dedicated inline `POST /v1/agents/why-peek` route.** Deferred. It is new surface the approved
design does not contain (§1 enumerates five routes), it has no consumer — the browser panel is owned
by the 2026-08-01 spec in a satellite repo and has not asked for it — and it carries an unresolved
sub-question this plan should not answer unilaterally: `resolveHttpAgentMethod` maps a path segment
to `agents.<segment>` with **no translation table**, so a hyphenated `why-peek` path would need a
second mapping, which is the drift shape (#1059) the derivation exists to avoid. The alternatives are
a camelCase path segment (`/v1/agents/whyPeek`, ugly but zero-drift) or a per-name alias map (clean
URL, new drift surface). Decide that with the panel's requirements in hand.

**2. `createdAtMs` / `expiresAtMs` / `ttlRemainingMs` in the poll response.** Deferred. `handleBriefGet`
does not expose them either, so omitting them is the surface's precedent rather than an oversight, and
adding response fields is purely additive — deferring costs nothing later, while adding now commits
the contract for a consumer that does not exist. The operational case is also weak: a run reaches a
terminal state in seconds against a ten-minute TTL, so a countdown would be showing a number that
never matters. What the review's question DID surface and is now fixed: the plan gave no rationale for
choosing 10 minutes over briefs' 30. That reasoning is now recorded in Task 5.

**3. `agents:read` / `agents:write` scope hierarchy.** Deferred, and this one is a decision, not a
postponement. Three reasons:

- `API_SCOPES` shipped in PR 1 (`826b76a1`) as five flat capability names with **no** `:` separator —
  `clip`, `briefs`, `agents`, `resolve`, `fetch`. Introducing `agents:read` alone would be the only
  resource-verb pair in the vocabulary.
- The rename is not free. `parseEntry` **drops** unrecognised scopes (fail-closed, correctly), so
  every token minted since PR 1 would silently lose `agents` rather than fail loudly. That is a
  migration for a vocabulary one day old.
- Most decisively, **the split would not be the enforcement boundary.** Built-in agents are
  structurally read-only (`nimbus-agent-patterns`: the read-only/HITL-free shape is an invariant),
  and a write-capable agent would be gated by the executor's consent gate (`I2`) — which is
  structural, lives in the executor, and cannot be bypassed or configured away by any token scope.
  A write scope would be a second, weaker lock on a door `I2` already holds shut, and the risk with
  a weaker parallel lock is that someone eventually trusts it instead.

If a write-capable agent surface is ever designed, the scope question reopens **with the HITL
interaction settled first** — the same shape as the design's own deferral of `POST /v1/rpc` behind
the egress-coverage question.

## Notes for whoever dispatches this

Three process rules, each earned on PR 1:

1. **Treat plan text as a hypothesis.** Five of PR 1's defects originated in the plan, not in any implementation, and every one was caught by someone reading source against the plan. In every dispatch, require the implementer to **quote the real source before writing anything that mirrors it**, and to **report `NEEDS_CONTEXT` rather than guess**.
2. **Put "REPORT IMMEDIATELY WHEN DONE — do not pause waiting for a background process or notification" in every dispatch.** One PR 1 subagent stalled three times over 130 tool calls returning "waiting for the notification" instead of a status.
3. **A lookup whose `null` is consumed as "allow" must not also mean "not found."** That fail-open shipped through four review passes on PR 1 and was caught by CodeRabbit. Task 3's map is total for exactly this reason; do not let a reviewer talk it down to a `Partial`.
