# Why-Lens Step 1b — The `nimbus why` Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `why` agent (six parallel lanes over the graph edges 1a made real), the synchronous `agents.whyPeek` (<300 ms), the `nimbus why` CLI, the `nimbus index regraph` CLI over `regraphAllItems`, and the two Tauri allowlist entries — gateway + CLI only; SDK/client/VS Code are steps 2 and 3.

**Architecture:** `agents/why.ts` mirrors `agents/impact.ts` exactly: `AgentCoordinator` → six `SubTask`s → `emitBriefWithSynthesis`. The peek is a separate synchronous module (`agents/why-peek.ts`) sharing subject-resolution and on-demand-blame helpers in `agents/_lib/`. Brief types are defined **gateway-locally** in `agents/_lib/why-types.ts` (composed from the SDK's `AgentBriefBase`) because `@nimbus-dev/sdk` 1.5.x has no `WhyBrief` — step 2 promotes them. On-demand blame reuses the already-exported `gitBlameLinePorcelain` + `upsertBlameLines` + `lookupBlame`; the only new blame code is a path→configured-root matcher and a cache-then-spawn wrapper.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, `bun:test`, Biome. Rust only for the two-line Tauri allowlist edit.

## Global Constraints

- **No `any`** — `unknown` for external data. Strict mode is non-negotiable.
- **Bound parameters only** (I9). Placeholder *counts* may come from array length; values always bind.
- **Read-only agent** (agent shape invariant): no `ToolExecutor` import, no HITL, no writes except the blame-cache `upsertBlameLines` (which goes through `dbRun`, satisfying I14).
- **No migration, no new invariant, no I13 write route.** The one Rust change is two `ALLOWED_METHODS` entries (I7) with the count assertion 99 → 101 (see Task 7 — the count is a single global assertion, *not* a per-namespace "8 agents" count as the spec assumed).
- **Seed every test from the connector's own externalId/metadata builders** or literals copied verbatim from connector source — never hand-invented shapes. This is the single most important rule from 1a: ~460 green tests still shipped two dead edge types because fixtures were invented.
- **`resolves` is polysemous** (pr→issue from 1a; `catchup.ts` expects person→incident). Every `resolves` traversal here scopes **both** endpoint types with INNER JOINs on `graph_entity.type`.
- **Lane queries INNER JOIN `graph_entity`** (and `item` where item fields are read) so a dangling relation yields no row, never a phantom finding.
- **Per-file coverage floor ≥80% line and branch**; Docker-Linux-authoritative (`docker run --rm -v "$PWD":/w -w /w oven/bun:latest bash -c "bun install --frozen-lockfile && bun run audit:coverage-floor"`) — never trust native Windows.
- **`packages/gateway/tsconfig.json` includes only `src/**/*`** — `packages/gateway/test/` is never typechecked. A clean `tsc` does not prove you found every call site; grep too.
- **Editor TS diagnostics go stale.** Always confirm with a real `bunx tsc --noEmit -p packages/gateway/tsconfig.json` (and `-p packages/cli/tsconfig.json` for CLI tasks).
- **`bun run lint` false-fails inside `.claude/worktrees`** (0 files). Use `bunx biome check packages scripts`.
- **Fresh worktree: `bun install` FIRST.** Bun hoists `@nimbus-dev/sdk` 1.4.0 to the root and nests 1.5.x under `packages/gateway`; root `node_modules` is misleading.
- **`noUnusedVariables` is a Biome error** and fires on unused module-private functions — introduce a helper only in the task that first calls it.
- **Prefer a loud failure over a plausible wrong answer** (the `occurredAtForItem` principle). Lanes degrade via `agents/_lib/gap-notes.ts`, not special-casing.
- Run `bun run preflight:fast` after every task; full `bun run preflight` before the first push.

## Grounded facts every task relies on (verified against main @ 44e1c384)

| Fact | Source |
| --- | --- |
| `git_blame_line` PK `(repo_root, file_path, line_no)`; `author_time_ms` in **ms** | `index/git-blame-line-v32-sql.ts:1-12` |
| `lookupBlame(db, repoRoot, filePath, lineNo): BlameLookup \| null`; `upsertBlameLines(db, repoRoot, filePath, rows)`; `BlameRow {lineNo, commitSha, authorName, authorEmail, authorTimeMs}` | `security/blame-store.ts:63-118` |
| `gitBlameLinePorcelain(root, relFile, ranges, spawn = Bun.spawn): Promise<BlameRow[]>` — argv `git -C <root> blame --line-porcelain -L a,b -- <relFile>`, `AbortSignal.timeout(20_000)`, non-zero exit / throw → `[]`, **exported**, spawn injectable | `connectors/filesystem-v2-sync.ts:461-488` |
| Stored `repo_root` = the **configured `[[filesystem.roots]]` path** (not git toplevel); `file_path` = root-relative **POSIX** (`relative(root, fp).replaceAll("\\", "/")`) | `filesystem-v2-sync.ts:329,350` |
| Roots: `NimbusFilesystemRootToml {path, gitAware, codeIndex, dependencyGraph, exclude}`; runtime loader `loadNimbusFilesystemRootsFromConfigDir(configDir)` | `config/filesystem-toml.ts:5-11,147-160` |
| **No existing path→root matcher, no git-toplevel helper** — write the matcher here | explorer sweep |
| `AgentsRpcContext {db, llm?, notify, configDir?, index?, selfIdentity?, sendOverWire?}`; handlers load config lazily from `configDir` | `ipc/agents-rpc.ts:27-35` |
| All 8 `agents.*` methods are async `{sessionId}`-returning; **`agents.whyPeek` is the first synchronous-payload method** — `dispatchByMethod` supports it (handler return value becomes the RPC result) | `agents-rpc.ts:377-392`, `_lib/dispatch-by-method.ts` |
| Param guards throw `AgentsRpcError(-32602, …)`, mapped in `server/dispatchers.ts:134-135` | `agents-rpc.ts:18-25,48-76` |
| `emitBriefWithSynthesis<B extends AnyBrief>` — `AnyBrief` is a **local union in `emit-brief.ts:13-21`** that must gain `WhyBrief`; opts `{sessionId, briefReadyMethod, briefErrorMethod, notify, llm?, buildBrief}` | `agents/_lib/emit-brief.ts` |
| `synthesize()` dispatches deterministic rendering on `brief.kind` — needs a `renderWhy` case; LLM is optional and unwired in production | `agents/_lib/synthesize.ts:52-61,74-96` |
| `AgentBriefBase {agentVersion: 1, generatedAt, latencyMs, gaps}` and `GapNote {category, detail, remediation?}` come from `@nimbus-dev/sdk` via the re-export shim `agents/_lib/findings.ts` | `findings.ts:8-47` |
| gap-notes API: `detectEmptyIndex(db)`, `detectMissingConnector(db, service)`, `detectMissingEntityType(db, type)`, `detectMissingRelationEmit(db, relationType, remediation?)`, `detectMissingRelationToEntityType(db, relationType, targetEntityType, remediation?)`, `aggregateMissingEntityTypes(notes)` | `agents/_lib/gap-notes.ts` |
| `AgentCoordinator` ctor `{sessionId, parentId, depth, toolCallCount:{value}}`; `run(tasks)` = `Promise.all`, per-task throw → `status:"error"` | `engine/coordinator.ts:36-81` |
| Entity shapes: `commit` external_id **`${service}:${sha}`** (metadata `{sha, repoRoot}`, label = commit subject for filesystem commits, `sha.slice(0,12)` for PR-merge stubs); `symbol` (NOT `code_symbol`) external_id = item id, metadata `{file, name, repoRoot}`; `pr`/`issue`/`message`/`incident`/`deployment` external_id = item id | `graph/graph-populator.ts:231-510,674-737` |
| **One physical commit can have TWO commit entities** — `filesystem:<sha>` (git log) and e.g. `github:<sha>` (PR merge). Match commits by **SHA portion** `substr(external_id, instr(external_id, ':') + 1)`, never by entity id | `graph-populator.ts:270,330` |
| `merged_as` direction **pr → commit**; fires only when `metadata.merged === true` and `metadata.merge_commit_sha` non-empty | `graph-populator.ts:265-276` |
| `authored` is person → pr. **`reviewed` is emitted by NO populator** — `expert.ts:286-292` gap-notes it (`detectMissingRelationEmit(db, "reviewed", "Tracked as a graph-populator follow-up…")`). The PR lane must NOT promise reviewers | `expert.ts:286-292` |
| incident/deployment entity metadata: exactly `{occurredAt, affectedService}`; `correlates_with` always deployment → incident; `CORRELATION_WINDOW_MS = 2h` | `graph-populator.ts:598,674-737` |
| `item` table has `url` and `canonical_url` columns | `index/unified-item-v3-sql.ts:16-31` |
| `code_symbol` **items** carry `metadata.excerptStartLine` (entity metadata does not) | `filesystem-v2-sync.ts:294-311` |
| `git_commit` items (filesystem): service `"filesystem"`, externalId `` `${sha}_${rk}` ``, title = subject, bodyPreview = sha, metadata `{repoRoot, sha, subject}` | `filesystem-v2-sync.ts:194-209` |
| `regraphAllItems(db, opts?: {batchSize?, logger?, resolveServiceId?, _syncItem?}): {scanned, graphed, skipped}`; `graphed` = "actually wrote rows", not "dispatched" | `graph/regraph.ts:7-36,204` |
| Resolver: `buildServiceIdentityResolver(configs, onAmbiguousBinding?)` built in production from `loadNimbusServiceConfigsFromConfigDir(configDir)` (`config/nimbus-toml.ts:1493`) | `metrics/service-identity.ts:265-268`, `platform/assemble.ts:1600-1614` |
| `index.reembed` pattern: own module `ipc/index-reembed-rpc.ts` + method-gated block in `server/dispatchers.ts:523-543` with ctx `{db, vault, paths, logger: pino(...), notify}` | `dispatchers.ts` |
| CLI agents path is the **generic client surface**: `IPCClient.call<T>(method, params)` + `onNotification` — no typed client method needed. `runAgentCli({agentName, ipcMethod, callParams, guard, json})` in `cli/src/lib/agent-cli-dispatcher.ts`; 30 s timeout in `lib/agent-brief-render.ts:3`; brief markdown is written verbatim (no CLI-side rendering, no NO_COLOR handling in agent paths) | explorer report |
| CLI registration = 3 touches: `commands/registry.ts` `COMMAND_NAMES` (+ `"why"` between `watch` and `workflow`), barrel `commands/index.ts`, `COMMAND_HANDLERS` in `cli/src/index.ts` | `registry.ts`, `index.ts:77-133` |
| `nimbus index` subcommands: string-compare chain in `commands/index-cmd.ts` `runIndexCmd:163-175`; simple calls use `withGatewayIpc` | `index-cmd.ts` |
| Rust: `ALLOWED_METHODS` agents block at `gateway_bridge.rs:59-66` (alphabetized); `allowlist_exact_size` asserts **99** (`:514-517`); TS mirror asserts the literal `99` at `security-invariants.test.ts:556-559`. `NO_TIMEOUT_METHODS` does NOT include agents.* (they return instantly) | explorer report |
| No doc-count audit gates the IPC catalogue; docs to touch are prose: `docs/architecture.md` agent table (~:1066-1080), `docs/cli-reference.md`, `docs/CHANGELOG.md` | explorer report |
| `IPCClient.call` has **no client-side timeout** — a long synchronous `index.regraph` call is safe | client dist grep |

## Deferred-backlog triage (decided)

| Item | Disposition |
| --- | --- |
| Ticket-key extraction matches prose (`UTF-8`, `RFC-2119`, `SHA-256`) | **In 1b** — Task 10. Wrong edges beat missing edges in badness; a stoplist of standards prefixes is cheap and testable. |
| `REGRAPH_TYPE_ORDER` omits `obsidian_note` | **In 1b** — Task 10. 1b ships the user-facing `nimbus index regraph`; the ordering hazard becomes user-reachable. One string + one test. |
| `annotateDeployment` DORA eligibility raw `includes()` with no production→prod alias | **Own slice.** DORA metrics behavior, no interaction with any 1b lane. Fixing it here would couple an agent PR to a metrics-semantics change. |
| `agents/expert.ts` `subIncidentResolved` has no real query | **Own slice.** Verified on main: #813 already re-keyed its gap note on `detectMissingRelationToEntityType(db, "resolves", "incident", …)` (`expert.ts:296-314`), so it does NOT go silent — the remaining work (an actual person→incident evidence query) needs a populator that emits person→incident `resolves`, which nothing does yet. |
| *(new, found in grounding)* `expert.ts` `subBlame` queries item `type='commit'` but the populator dispatches on `'git_commit'` | **Own slice / flag in review.** Pre-existing, not touched by 1b. |

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/gateway/src/agents/_lib/why-types.ts` | `WhyLane`, `WhyFinding`, `WhyBrief`, `WhyPeek`, `WhyInput` — gateway-local until SDK 1.6 | **Create** (Task 1) |
| `packages/gateway/src/agents/_lib/render.ts` | `renderWhy` deterministic markdown | Modify (Task 1) |
| `packages/gateway/src/agents/_lib/synthesize.ts` | `kind: "why"` dispatch case | Modify (Task 1) |
| `packages/gateway/src/agents/_lib/emit-brief.ts` | widen `AnyBrief` with `WhyBrief` | Modify (Task 1) |
| `packages/gateway/src/agents/_lib/graph-traversals.ts` | shared `reverseDependsOn` (extracted from `impact.ts`) | **Create** (Task 2) |
| `packages/gateway/src/agents/impact.ts` | consume the extracted traversal; suite green **unchanged** | Modify (Task 2) |
| `packages/gateway/src/agents/_lib/why-subject.ts` | `parseRef`, `matchConfiguredRoot`, `resolveWhySubject` | **Create** (Task 3) |
| `packages/gateway/src/agents/_lib/blame-on-demand.ts` | `ensureBlameLine` — cache → root-fence → one bounded spawn → persist | **Create** (Task 4) |
| `packages/gateway/src/agents/why-peek.ts` | `runWhyPeek` — synchronous, no coordinator, no LLM | **Create** (Task 5) |
| `packages/gateway/src/agents/why.ts` | `runWhy` (six lanes) + `emitWhyBrief` | **Create** (Task 6) |
| `packages/gateway/src/ipc/agents-rpc.ts` | `agents.why` + `agents.whyPeek` handlers + guards | Modify (Task 7) |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | 2 `ALLOWED_METHODS` entries; count 99 → 101 | Modify (Task 7) |
| `packages/gateway/src/security-invariants.test.ts` | TS mirror of the Rust count 99 → 101 | Modify (Task 7) |
| `packages/gateway/src/ipc/index-regraph-rpc.ts` | `index.regraph` handler | **Create** (Task 8) |
| `packages/gateway/src/ipc/server/dispatchers.ts` | wire `index.regraph` | Modify (Task 8) |
| `packages/cli/src/commands/index-cmd.ts` | `nimbus index regraph` subcommand | Modify (Task 8) |
| `packages/cli/src/commands/why.ts` | `nimbus why <ref> [--line N] [--peek] [--json]` | **Create** (Task 9) |
| `packages/cli/src/commands/{registry,index}.ts`, `packages/cli/src/index.ts` | registration | Modify (Task 9) |
| `packages/gateway/src/graph/graph-refs.ts` | ticket-key standards stoplist | Modify (Task 10) |
| `packages/gateway/src/graph/regraph.ts` | `REGRAPH_TYPE_ORDER` + `obsidian_note` | Modify (Task 10) |
| `packages/gateway/test/e2e/scenarios/why.e2e.test.ts` | e2e: brief sections, HITL-free, latency | **Create** (Task 11) |
| `docs/cli-reference.md`, `docs/architecture.md`, `docs/CHANGELOG.md` | docs | Modify (Task 12) |

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. Tasks 8/9/10 are mutually independent but all depend on ≤7.

---

### Task 0: Worktree + baseline

- [ ] **Step 1:** Create the worktree and branch (never commit on main; commit on a NEW branch inside a git worktree):

```bash
git -C C:/gitrep/Nimbus worktree add .claude/worktrees/why-lens-1b -b dev/asafgolombek/why-lens-1b-agent
cd C:/gitrep/Nimbus/.claude/worktrees/why-lens-1b
bun install
```

- [ ] **Step 2:** Baseline checks (must be green BEFORE any change, so later failures are yours):

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json
bun test packages/gateway/src/agents/ packages/gateway/src/graph/
```

Expected: PASS. All Read/Edit operations from here on use the **worktree** absolute path (`.claude/worktrees/why-lens-1b/...`) — a main-repo path silently edits main.

---

### Task 1: Why types + renderer + synthesis dispatch

**Files:**

- Create: `packages/gateway/src/agents/_lib/why-types.ts`
- Modify: `packages/gateway/src/agents/_lib/render.ts`, `_lib/synthesize.ts`, `_lib/emit-brief.ts`
- Test: `packages/gateway/src/agents/_lib/render.why.test.ts` (create)

**Interfaces:**

- Consumes: `AgentBriefBase`, `GapNote` from `./findings.ts` (SDK re-export shim).
- Produces (every later task relies on these exact names):

```ts
// _lib/why-types.ts
export type WhyLane = "authorship" | "pull_request" | "ticket" | "discussion" | "driver" | "downstream";
export type WhyFinding = { lane: WhyLane; title: string; detail: string; url: string | null; occurredAt: number | null; entityId: string | null };
export type WhySubject = { repoRoot: string; filePath: string; lineNo: number | null; symbol: string | null };
export type WhyBrief = AgentBriefBase & { kind: "why"; query: { ref: string; line: number | null }; subject: WhySubject | null; findings: WhyFinding[] };
export type WhyPeek = { subject: { repoRoot: string; filePath: string; lineNo: number } | null; author: string | null; authorEmail: string | null; commitSha: string | null; committedAt: number | null; commitSubject: string | null; pr: { number: number | null; title: string; url: string | null } | null; ticket: { key: string; title: string; url: string | null } | null; hasMore: boolean };
export type WhyInput = { ref: string; line?: number };
```

(Deviation from the spec's sketch, grounded: `pr.number`/`pr.url`/`ticket.url` are nullable because the item row may lack `url` and `metadata.number`; the spec's non-null versions would force fabrication. `WhySubject.lineNo` is nullable because a bare-symbol ref may have no `excerptStartLine`.)

- [ ] **Step 1: Write the failing test** — `packages/gateway/src/agents/_lib/render.why.test.ts`:

```ts
import { expect, test } from "bun:test";

import { renderWhy } from "./render.ts";
import type { WhyBrief } from "./why-types.ts";

function brief(overrides: Partial<WhyBrief>): WhyBrief {
  return {
    kind: "why",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 1234,
    gaps: [],
    query: { ref: "src/a.ts:42", line: null },
    subject: { repoRoot: "/repo", filePath: "src/a.ts", lineNo: 42, symbol: null },
    findings: [],
    ...overrides,
  };
}

test("renders lane sections in fixed order with linked findings", () => {
  const md = renderWhy(
    brief({
      findings: [
        { lane: "ticket", title: "NIM-88 Retry backoff", detail: "linked via resolves", url: "https://linear.app/NIM-88", occurredAt: null, entityId: "e2" },
        { lane: "authorship", title: "alice · a1b2c3d4e5f6", detail: "Fix retry backoff", url: null, occurredAt: 1_700_000_000_000, entityId: "e1" },
      ],
    }),
  );
  expect(md).toContain("## Authorship");
  expect(md).toContain("## Ticket");
  expect(md.indexOf("## Authorship")).toBeLessThan(md.indexOf("## Ticket"));
  expect(md).toContain("[NIM-88 Retry backoff](https://linear.app/NIM-88)");
  expect(md).toContain("alice · a1b2c3d4e5f6");
});

test("an unresolved subject renders a could-not-resolve line, not a crash", () => {
  const md = renderWhy(brief({ subject: null }));
  expect(md).toContain("src/a.ts:42");
  expect(md.toLowerCase()).toContain("could not resolve");
});

test("gaps section renders when gaps exist", () => {
  const md = renderWhy(
    brief({ gaps: [{ category: "missing_connector", detail: "No Slack connector synced." }] }),
  );
  expect(md).toContain("No Slack connector synced.");
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/gateway/src/agents/_lib/render.why.test.ts`
Expected: FAIL — `Cannot find module './why-types.ts'` (and no `renderWhy` export).

- [ ] **Step 3: Implement.**

Create `_lib/why-types.ts` with exactly the types in the Interfaces block above, plus this header comment:

```ts
/**
 * Why-brief types, gateway-local.
 *
 * These deliberately do NOT live in `@nimbus-dev/sdk` yet: the published SDK
 * is 1.5.x and promoting the ninth agent is the step-2 `sdk 1.6.0` →
 * `client 0.8.0` hop (see the why-lens design spec). When that lands, these
 * move to the SDK and `findings.ts` re-exports them like the other eight.
 */
import type { AgentBriefBase } from "./findings.ts";
```

In `_lib/render.ts`, add (matching the file's existing private `renderGaps` / `renderLatency` helpers — read the file and use their exact signatures, do not duplicate them):

```ts
const WHY_LANE_ORDER: readonly WhyLane[] = Object.freeze([
  "authorship", "pull_request", "ticket", "discussion", "driver", "downstream",
]);
const WHY_LANE_HEADINGS: Readonly<Record<WhyLane, string>> = Object.freeze({
  authorship: "Authorship",
  pull_request: "Pull request",
  ticket: "Ticket",
  discussion: "Discussion",
  driver: "What drove it",
  downstream: "Downstream",
});

export function renderWhy(brief: WhyBrief): string {
  const lines: string[] = ["# Why"];
  lines.push(
    brief.subject === null
      ? `_Could not resolve \`${brief.query.ref}\` to an indexed location._`
      : `\`${brief.subject.filePath}${brief.subject.lineNo === null ? "" : `:${String(brief.subject.lineNo)}`}\` in \`${brief.subject.repoRoot}\``,
  );
  for (const lane of WHY_LANE_ORDER) {
    const rows = brief.findings.filter((f) => f.lane === lane);
    if (rows.length === 0) continue;
    lines.push(`\n## ${WHY_LANE_HEADINGS[lane]}`);
    for (const f of rows) {
      const when = f.occurredAt === null ? "" : ` — ${new Date(f.occurredAt).toISOString().slice(0, 10)}`;
      const head = f.url === null ? `**${f.title}**` : `**[${f.title}](${f.url})**`;
      lines.push(`- ${head}${when}\n  ${f.detail}`);
    }
  }
  // Append gaps + latency exactly the way the sibling renderers do.
  ...
  return lines.join("\n");
}
```

(The `...` is the two calls to the file's existing private gap/latency helpers — copy the exact two lines the other renderers end with.)

In `_lib/synthesize.ts`: add `renderWhy` to the import from `./render.ts` and a `case "why": return renderWhy(brief);` (or the file's equivalent dispatch shape — match it exactly).

In `_lib/emit-brief.ts`: add `WhyBrief` to the `AnyBrief` union (import from `./why-types.ts` — note `findings.ts` does NOT have it; it is not in the SDK yet).

- [ ] **Step 4: Run to verify pass + typecheck**

```bash
bun test packages/gateway/src/agents/_lib/ && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

Expected: PASS + clean. If `synthesize.ts` constrains its parameter to the same `AnyBrief`-style union, widen there too.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/
git commit -m "feat(agents): why brief types, deterministic renderer, synthesis dispatch"
```

---

### Task 2: Extract the shared reverse-`depends_on` traversal

The spec mandates: `subDownstream` overlaps `impact.ts`'s traversal; extract into `agents/_lib/` and refactor `impact.ts` to consume it **in the same PR**, with impact's suite passing unchanged (the honesty gate).

**Files:**

- Create: `packages/gateway/src/agents/_lib/graph-traversals.ts`, `graph-traversals.test.ts`
- Modify: `packages/gateway/src/agents/impact.ts:210-221` (the `subDownstreamCode` query)

**Interfaces:**

- Produces: `reverseDependsOn(db: Database, toEntityId: string, limit?: number): ReverseDependsOnRow[]` where `ReverseDependsOnRow = { entityId: string; label: string; serviceId: string }`.

- [ ] **Step 1: Write the failing test** — `graph-traversals.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LocalIndex } from "../../index/local-index.ts";
import { reverseDependsOn } from "./graph-traversals.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

test("returns entities that depend on the target, defaulting service to filesystem", () => {
  const db = freshDb();
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
      "('t', 'symbol', 'filesystem:t', 'target', NULL, '{}')," +
      "('d', 'symbol', 'filesystem:d', 'dependent', NULL, '{}')",
  );
  db.run(
    "INSERT INTO graph_relation (from_id, to_id, type, weight, created_at) VALUES ('d', 't', 'depends_on', 1.0, 0)",
  );
  expect(reverseDependsOn(db, "t")).toEqual([
    { entityId: "d", label: "dependent", serviceId: "filesystem" },
  ]);
});

test("a dangling relation yields no row (INNER JOIN)", () => {
  const db = freshDb();
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('t', 'symbol', 'filesystem:t', 'target', NULL, '{}')",
  );
  // No 'ghost' entity row; FK would normally forbid this, so insert with FKs off to simulate drift.
  db.run("PRAGMA foreign_keys = OFF");
  db.run(
    "INSERT INTO graph_relation (from_id, to_id, type, weight, created_at) VALUES ('ghost', 't', 'depends_on', 1.0, 0)",
  );
  expect(reverseDependsOn(db, "t")).toEqual([]);
});

test("respects the limit", () => {
  const db = freshDb();
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('t', 'symbol', 'x:t', 't', NULL, '{}')",
  );
  for (let i = 0; i < 5; i++) {
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'symbol', ?, ?, NULL, '{}')",
      [`d${String(i)}`, `x:d${String(i)}`, `dep${String(i)}`],
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, weight, created_at) VALUES (?, 't', 'depends_on', 1.0, 0)",
      [`d${String(i)}`],
    );
  }
  expect(reverseDependsOn(db, "t", 2)).toHaveLength(2);
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/gateway/src/agents/_lib/graph-traversals.test.ts`
Expected: FAIL — `Cannot find module './graph-traversals.ts'`.

- [ ] **Step 3: Implement** — `_lib/graph-traversals.ts`:

```ts
import type { Database } from "bun:sqlite";

/**
 * Shared graph walks used by more than one built-in agent. Extracted from
 * `impact.ts` (`subDownstreamCode`) when `why.ts` needed the same reverse
 * `depends_on` traversal — a sixth copy of a graph walk is not acceptable
 * under the repo's duplication floor.
 */
export type ReverseDependsOnRow = { entityId: string; label: string; serviceId: string };

/** Entities that declare `depends_on` → the given entity (reverse edge walk). */
export function reverseDependsOn(db: Database, toEntityId: string, limit = 50): ReverseDependsOnRow[] {
  const rows = db
    .query(
      `SELECT
         e.id    AS entity_id,
         e.label AS label,
         COALESCE(e.service, 'filesystem') AS service_id
       FROM graph_relation r
       JOIN graph_entity   e ON e.id = r.from_id
       WHERE r.to_id = ? AND r.type = 'depends_on'
       LIMIT ?`,
    )
    .all(toEntityId, limit) as Array<{ entity_id: string; label: string; service_id: string }>;
  return rows.map((r) => ({ entityId: r.entity_id, label: r.label, serviceId: r.service_id }));
}
```

Then in `impact.ts` `subDownstreamCode` (lines 210-221): replace the inline query with `const rows = reverseDependsOn(db, start.entityId);` and adjust the mapping to use `rows.map((r) => ({ category: "downstream_repo", affectedItemId: r.entityId, affectedTitle: r.label, serviceId: r.serviceId, hops: 1, pathSummary: ... }))` — keeping the `pathSummary` string and the empty-result gap note byte-identical.

- [ ] **Step 4: Honesty gate** — impact's suites green **unchanged**:

```bash
bun test packages/gateway/src/agents/_lib/graph-traversals.test.ts packages/gateway/src/agents/impact.test.ts packages/gateway/test/e2e/scenarios/impact.e2e.test.ts && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

Expected: PASS with zero edits to either impact test file.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/graph-traversals.ts packages/gateway/src/agents/_lib/graph-traversals.test.ts packages/gateway/src/agents/impact.ts
git commit -m "refactor(agents): extract shared reverse depends_on traversal for impact + why"
```

---

### Task 3: Subject resolution (`parseRef` / `matchConfiguredRoot` / `resolveWhySubject`)

**Files:**

- Create: `packages/gateway/src/agents/_lib/why-subject.ts`, `why-subject.test.ts`

**Interfaces:**

- Consumes: `NimbusFilesystemRootToml` from `../../config/filesystem-toml.ts`; `WhySubject` from `./why-types.ts`.
- Produces:

```ts
export function parseRef(ref: string): { path: string; line: number | null };
export type ResolvedRootPath = { repoRoot: string; filePath: string };
export function matchConfiguredRoot(roots: readonly NimbusFilesystemRootToml[], refPath: string, exists?: (p: string) => boolean): ResolvedRootPath | null;
export function resolveWhySubject(db: Database, roots: readonly NimbusFilesystemRootToml[], input: WhyInput, exists?: (p: string) => boolean): WhySubject | null;
```

`exists` is an injectable `existsSync` (default `node:fs` `existsSync`) so tests need no real files.

Semantics (grounded in how blame rows are stored):

- `parseRef`: a trailing `:<digits>` is a line suffix (`/^(.+):(\d+)$/` — the `.+` keeps `C:\repo\file.ts:42` working because the path capture is greedy). `input.line` overrides a suffix.
- `matchConfiguredRoot`: absolute path → the first configured root that contains it (via `relative(root, abs)` not starting with `..` and not absolute), returning `repoRoot` = the **configured root path verbatim** (that is what `git_blame_line.repo_root` stores) and `filePath` root-relative POSIX. Relative path → the first root where `exists(join(root.path, refPath))`. No match → `null`. **This `null` is the path-escape fence** — Task 4 red-proves that no spawn can happen without a `ResolvedRootPath`.
- `resolveWhySubject`: try path resolution first; if the ref has no separator and no dot-extension and path resolution failed, look up a `symbol` entity — exact `json_extract(metadata,'$.name') = ?`, then `label LIKE '%' || ? || '%' ORDER BY length(label) ASC, id ASC LIMIT 1` (mirroring `impact.ts:163-174`) — and take `metadata.file` + `metadata.repoRoot` from the entity and `lineNo` from the **item** row's `metadata.excerptStartLine` (`JOIN item i ON i.id = e.external_id`; entity metadata does not carry it). Null line is allowed.

- [ ] **Step 1: Write the failing test** — `why-subject.test.ts` (use `path.join`/`path.sep` — never hardcoded separators; the cross-platform audit flags Windows-only assertions):

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";

import type { NimbusFilesystemRootToml } from "../../config/filesystem-toml.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { matchConfiguredRoot, parseRef, resolveWhySubject } from "./why-subject.ts";

const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
function root(p: string): NimbusFilesystemRootToml {
  return { path: p, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] };
}

test("parseRef splits a trailing line suffix and keeps drive-letter paths whole", () => {
  expect(parseRef("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
  expect(parseRef("C:\\work\\repo\\src\\a.ts:7")).toEqual({ path: "C:\\work\\repo\\src\\a.ts", line: 7 });
  expect(parseRef("src/a.ts")).toEqual({ path: "src/a.ts", line: null });
  expect(parseRef("mySymbol")).toEqual({ path: "mySymbol", line: null });
});

test("matchConfiguredRoot maps an absolute path inside a root to root-relative POSIX", () => {
  const abs = path.join(ROOT, "src", "a.ts");
  expect(matchConfiguredRoot([root(ROOT)], abs)).toEqual({ repoRoot: ROOT, filePath: "src/a.ts" });
});

test("matchConfiguredRoot returns null for a path outside every root — the escape fence", () => {
  const outside = path.resolve(path.join(path.sep, "elsewhere", "a.ts"));
  expect(matchConfiguredRoot([root(ROOT)], outside)).toBeNull();
});

test("a relative path resolves against the first root where it exists", () => {
  const exists = (p: string): boolean => p === path.join(ROOT, "src", "a.ts");
  expect(matchConfiguredRoot([root(ROOT)], "src/a.ts", exists)).toEqual({
    repoRoot: ROOT,
    filePath: "src/a.ts",
  });
  expect(matchConfiguredRoot([root(ROOT)], "src/missing.ts", () => false)).toBeNull();
});

test("a bare token resolves through a symbol entity, line from the item's excerptStartLine", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  // Copied verbatim from filesystem-v2-sync.ts code_symbol emission: service,
  // type, title `${name} (${kind})`, metadata {file, name, repoRoot(?), excerptStartLine}.
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "code_symbol",
    externalId: `${ROOT}#src/a.ts#retryBackoff`,
    title: "retryBackoff (function)",
    bodyPreview: "export function retryBackoff() {",
    modifiedAt: now,
    syncedAt: now,
    metadata: { file: "src/a.ts", name: "retryBackoff", repoRoot: ROOT, excerptStartLine: 42 },
  });
  const subject = resolveWhySubject(db, [root(ROOT)], { ref: "retryBackoff" }, () => false);
  expect(subject).toEqual({ repoRoot: ROOT, filePath: "src/a.ts", lineNo: 42, symbol: "retryBackoff" });
});

test("an unresolvable ref yields null", () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  expect(resolveWhySubject(db, [root(ROOT)], { ref: "nothingHere" }, () => false)).toBeNull();
});
```

**Fixture-grounding step (mandatory before running):** open `connectors/filesystem-v2-sync.ts` around lines 260-311 and confirm the `code_symbol` item's `externalId` shape and metadata keys (`file`, `name`, `excerptStartLine`, and whether `repoRoot` is in item metadata or only entity metadata). Correct the fixture above to the connector's exact shape — the test must be seeded from the connector's own builder shape, not this plan's guess. If `repoRoot` is absent from item metadata, take it from the symbol **entity** metadata (which grounding confirmed has it) and adjust `resolveWhySubject` accordingly.

- [ ] **Step 2: Run to verify it fails** — `bun test packages/gateway/src/agents/_lib/why-subject.test.ts`
Expected: FAIL — `Cannot find module './why-subject.ts'`.

- [ ] **Step 3: Implement** `why-subject.ts`:

```ts
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { NimbusFilesystemRootToml } from "../../config/filesystem-toml.ts";
import type { WhyInput, WhySubject } from "./why-types.ts";

const LINE_SUFFIX_RE = /^(.+):(\d+)$/;

export function parseRef(ref: string): { path: string; line: number | null } {
  const m = LINE_SUFFIX_RE.exec(ref);
  if (m === null) return { path: ref, line: null };
  const [, p, n] = m as unknown as [string, string, string];
  return { path: p, line: Number.parseInt(n, 10) };
}

export type ResolvedRootPath = { repoRoot: string; filePath: string };

/**
 * Map a user-supplied path onto a configured `[[filesystem.roots]]` entry.
 *
 * `repoRoot` is returned VERBATIM as configured because that exact string is
 * the `git_blame_line.repo_root` key filesystem-v2 stores (it never runs
 * `git rev-parse`); `filePath` is root-relative POSIX for the same reason.
 *
 * Returning null is the security fence: a path outside every configured root
 * must produce a gap note and ZERO blame spawns (see blame-on-demand.ts).
 */
export function matchConfiguredRoot(
  roots: readonly NimbusFilesystemRootToml[],
  refPath: string,
  exists: (p: string) => boolean = existsSync,
): ResolvedRootPath | null {
  if (isAbsolute(refPath)) {
    const abs = resolve(refPath);
    for (const r of roots) {
      const rel = relative(resolve(r.path), abs);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
      return { repoRoot: r.path, filePath: rel.replaceAll("\\", "/") };
    }
    return null;
  }
  for (const r of roots) {
    if (exists(join(r.path, refPath))) {
      return { repoRoot: r.path, filePath: refPath.replaceAll("\\", "/") };
    }
  }
  return null;
}

function lookupSymbol(
  db: Database,
  token: string,
): { file: string; repoRoot: string; lineNo: number | null; name: string } | null {
  const row = (db
    .query(
      `SELECT json_extract(e.metadata, '$.file')     AS file,
              json_extract(e.metadata, '$.repoRoot') AS repo_root,
              json_extract(e.metadata, '$.name')     AS name,
              CAST(json_extract(i.metadata, '$.excerptStartLine') AS INTEGER) AS start_line
         FROM graph_entity e
         JOIN item i ON i.id = e.external_id
        WHERE e.type = 'symbol' AND json_extract(e.metadata, '$.name') = ?
        LIMIT 1`,
    )
    .get(token) ??
    db
      .query(
        `SELECT json_extract(e.metadata, '$.file')     AS file,
                json_extract(e.metadata, '$.repoRoot') AS repo_root,
                json_extract(e.metadata, '$.name')     AS name,
                CAST(json_extract(i.metadata, '$.excerptStartLine') AS INTEGER) AS start_line
           FROM graph_entity e
           JOIN item i ON i.id = e.external_id
          WHERE e.type = 'symbol' AND e.label LIKE '%' || ? || '%'
          ORDER BY length(e.label) ASC, e.id ASC
          LIMIT 1`,
      )
      .get(token)) as { file?: string; repo_root?: string; name?: string; start_line?: number | null } | null;
  if (row?.file === undefined || row.file === null || row.repo_root === undefined || row.repo_root === null) {
    return null;
  }
  return {
    file: row.file,
    repoRoot: row.repo_root,
    lineNo: row.start_line ?? null,
    name: row.name ?? token,
  };
}

export function resolveWhySubject(
  db: Database,
  roots: readonly NimbusFilesystemRootToml[],
  input: WhyInput,
  exists: (p: string) => boolean = existsSync,
): WhySubject | null {
  const parsed = parseRef(input.ref);
  const line = input.line ?? parsed.line;

  const asPath = matchConfiguredRoot(roots, parsed.path, exists);
  if (asPath !== null) {
    return { repoRoot: asPath.repoRoot, filePath: asPath.filePath, lineNo: line, symbol: null };
  }

  const sym = lookupSymbol(db, parsed.path);
  if (sym !== null) {
    return { repoRoot: sym.repoRoot, filePath: sym.file, lineNo: line ?? sym.lineNo, symbol: sym.name };
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass + typecheck**

```bash
bun test packages/gateway/src/agents/_lib/why-subject.test.ts && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/why-subject.ts packages/gateway/src/agents/_lib/why-subject.test.ts
git commit -m "feat(agents): why subject resolution — ref parsing, root matching, symbol lookup"
```

---

### Task 4: On-demand single-line blame (`ensureBlameLine`) — with the red-proven fence

**Files:**

- Create: `packages/gateway/src/agents/_lib/blame-on-demand.ts`, `blame-on-demand.test.ts`

**Interfaces:**

- Consumes: `lookupBlame`, `upsertBlameLines`, `BlameLookup` from `../../security/blame-store.ts`; `gitBlameLinePorcelain` (exported, spawn-injectable) from `../../connectors/filesystem-v2-sync.ts`; `ResolvedRootPath` from `./why-subject.ts`.
- Produces:

```ts
export type BlameSpawn = typeof Bun.spawn;
export async function ensureBlameLine(
  db: Database,
  subject: ResolvedRootPath,
  lineNo: number,
  spawn?: BlameSpawn,
): Promise<BlameLookup | null>;
```

Contract (spec §on-demand-blame, grounded):

1. `lookupBlame` hit → return it, **zero spawns**.
2. Miss → the caller can only have a `ResolvedRootPath` from `matchConfiguredRoot`, but defense-in-depth: re-verify `join(repoRoot, ".git")` exists (mirrors `isGitRepo`); missing → `null`, zero spawns.
3. Spawn exactly one `gitBlameLinePorcelain(repoRoot, filePath, [{from: lineNo, to: lineNo}], spawn)` — that helper already carries the `AbortSignal.timeout(20 s)`, `-- <file>` argv discipline, and swallow-to-`[]` failure shape; **write no new spawn code**.
4. Persist via `upsertBlameLines`, then re-`lookupBlame` so the next call is a pure DB hit.
5. Empty result (failure/timeout/non-git) → `null`. Never throws.

- [ ] **Step 1: Write the failing test** — `blame-on-demand.test.ts`. Spawn counting uses the injectable `spawn` param; the fake returns a minimal porcelain payload built with `parseBlamePorcelain`'s real grammar (sha header + `author`/`author-mail`/`author-time` + tab content line):

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";

import { LocalIndex } from "../../index/local-index.ts";
import { lookupBlame, upsertBlameLines } from "../../security/blame-store.ts";
import { ensureBlameLine } from "./blame-on-demand.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = path.resolve(path.join(path.sep, "work", "repo"));

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** Real `git blame --line-porcelain` grammar for one line — the exact shape parseBlamePorcelain consumes. */
const PORCELAIN = [
  `${SHA} 42 42`,
  "author alice",
  "author-mail <alice@example.com>",
  "author-time 1700000000",
  "author-tz +0000",
  "\tconst x = 1;",
  "",
].join("\n");

type SpawnCounter = { count: number; spawn: typeof Bun.spawn };
function countingSpawn(stdout: string, exitCode = 0): SpawnCounter {
  const counter: SpawnCounter = {
    count: 0,
    spawn: ((..._args: unknown[]) => {
      counter.count += 1;
      return {
        exited: Promise.resolve(exitCode),
        stdout: new Response(stdout).body,
        stderr: new Response("").body,
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn,
  };
  return counter;
}

test("DB hit → zero spawns", async () => {
  const db = freshDb();
  upsertBlameLines(db, ROOT, "src/a.ts", [
    { lineNo: 42, commitSha: SHA, authorName: "alice", authorEmail: "alice@example.com", authorTimeMs: 1_700_000_000_000 },
  ]);
  const c = countingSpawn(PORCELAIN);
  const out = await ensureBlameLine(db, { repoRoot: ROOT, filePath: "src/a.ts" }, 42, c.spawn);
  expect(out?.commitSha).toBe(SHA);
  expect(c.count).toBe(0);
});

test("miss → one spawn → row persisted → second call is a DB hit with zero further spawns", async () => {
  const db = freshDb();
  const c = countingSpawn(PORCELAIN);
  // ensureBlameLine re-verifies <root>/.git exists before spawning; point the
  // check at a temp dir that has one (see implementation's injectable gitDirExists
  // if the real-fs route is awkward — but prefer a real temp dir + real check).
  const tmp = await import("node:fs/promises").then(async (fs) => {
    const os = await import("node:os");
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "why-blame-"));
    await fs.mkdir(path.join(d, ".git"));
    return d;
  });
  const first = await ensureBlameLine(db, { repoRoot: tmp, filePath: "src/a.ts" }, 42, c.spawn);
  expect(first?.commitSha).toBe(SHA);
  expect(c.count).toBe(1);
  expect(lookupBlame(db, tmp, "src/a.ts", 42)?.commitSha).toBe(SHA);
  const second = await ensureBlameLine(db, { repoRoot: tmp, filePath: "src/a.ts" }, 42, c.spawn);
  expect(second?.commitSha).toBe(SHA);
  expect(c.count).toBe(1);
});

test("non-zero exit → null, no throw", async () => {
  const db = freshDb();
  const c = countingSpawn("", 128);
  const tmp = await import("node:fs/promises").then(async (fs) => {
    const os = await import("node:os");
    const d = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "why-blame-"));
    await fs.mkdir(path.join(d, ".git"));
    return d;
  });
  expect(await ensureBlameLine(db, { repoRoot: tmp, filePath: "src/a.ts" }, 1, c.spawn)).toBeNull();
});

test("a root with no .git directory → null and ZERO spawns", async () => {
  const db = freshDb();
  const c = countingSpawn(PORCELAIN);
  const out = await ensureBlameLine(db, { repoRoot: ROOT, filePath: "src/a.ts" }, 42, c.spawn);
  expect(out).toBeNull();
  expect(c.count).toBe(0);
});
```

(Clean up temp dirs in `afterEach` if the test runner leaves them; `os.tmpdir()` only, never `/tmp` literals.)

- [ ] **Step 2: Run to verify it fails** — `bun test packages/gateway/src/agents/_lib/blame-on-demand.test.ts`
Expected: FAIL — `Cannot find module './blame-on-demand.ts'`.

- [ ] **Step 3: Implement** `blame-on-demand.ts`:

```ts
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { gitBlameLinePorcelain } from "../../connectors/filesystem-v2-sync.ts";
import { type BlameLookup, lookupBlame, upsertBlameLines } from "../../security/blame-store.ts";
import type { ResolvedRootPath } from "./why-subject.ts";

export type BlameSpawn = typeof Bun.spawn;

/**
 * Blame one line on demand, cached forever after.
 *
 * The path fence has two layers: callers can only obtain a ResolvedRootPath
 * from `matchConfiguredRoot` (a path outside every configured root resolves
 * to null upstream), and this function independently refuses to spawn unless
 * `<repoRoot>/.git` exists. The spawn itself is the existing
 * `gitBlameLinePorcelain` — argv after `--`, 20 s AbortSignal, failure → [].
 * A local git read: not a connector dispatch (no I29), not a write gate (no I2).
 */
export async function ensureBlameLine(
  db: Database,
  subject: ResolvedRootPath,
  lineNo: number,
  spawn: BlameSpawn = Bun.spawn,
): Promise<BlameLookup | null> {
  const cached = lookupBlame(db, subject.repoRoot, subject.filePath, lineNo);
  if (cached !== null) return cached;

  if (!existsSync(join(subject.repoRoot, ".git"))) return null;

  const rows = await gitBlameLinePorcelain(
    subject.repoRoot,
    subject.filePath,
    [{ from: lineNo, to: lineNo }],
    spawn,
  );
  if (rows.length === 0) return null;

  upsertBlameLines(db, subject.repoRoot, subject.filePath, rows);
  return lookupBlame(db, subject.repoRoot, subject.filePath, lineNo);
}
```

- [ ] **Step 4: Run to verify pass** — `bun test packages/gateway/src/agents/_lib/blame-on-demand.test.ts && bunx tsc --noEmit -p packages/gateway/tsconfig.json`
Expected: PASS.

- [ ] **Step 5: RED-PROVE the fence.** Temporarily delete the `existsSync(join(...))` guard line, run the test file, and confirm the "ZERO spawns" test **fails** (spawn count 1). Restore the line, re-run, confirm green. Additionally, once Task 5 lands, its out-of-root peek test red-proves the `matchConfiguredRoot` layer the same way. Record in the commit message that the fence was red-proven — a guard asserted against a leftover import instead of a real call site is a failure mode this repo has already shipped once.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/agents/_lib/blame-on-demand.ts packages/gateway/src/agents/_lib/blame-on-demand.test.ts
git commit -m "feat(agents): on-demand single-line blame with red-proven root fence"
```

---

### Task 5: `agents.whyPeek` core (`runWhyPeek`)

**Files:**

- Create: `packages/gateway/src/agents/why-peek.ts`, `why-peek.test.ts`

**Interfaces:**

- Consumes: `resolveWhySubject`, `ensureBlameLine`, `WhyPeek`, `WhyInput`, `NimbusFilesystemRootToml`.
- Produces:

```ts
export type WhyPeekDeps = {
  db: Database;
  roots: readonly NimbusFilesystemRootToml[];
  spawn?: BlameSpawn;
  exists?: (p: string) => boolean;
};
export async function runWhyPeek(input: WhyInput, deps: WhyPeekDeps): Promise<WhyPeek>;
```

Behavior: resolve subject (a subject without a line → `subject: null` in the peek — the peek is line-anchored); `ensureBlameLine` (≤1 spawn); commit subject from the `commit` entity whose **SHA portion** equals the blame SHA, preferring the entity whose `metadata.repoRoot` matches the subject (the filesystem entity's label is the real commit subject; the PR-merge stub's label is a sha prefix); PR via `merged_as` reverse with the SHA-portion join; ticket via `resolves` from that PR (both endpoints type-scoped); `hasMore` = cheap `EXISTS` checks (any `mentions` edge into the found pr/issue/commit entities, any `depends_on` edge into the file's symbols, or any `correlates_with` edge at all).

- [ ] **Step 1: Write the failing test** — `why-peek.test.ts`. **Every fixture goes through `upsertIndexedItem` with connector-verbatim shapes** (the 1a standing rule). Before writing fixtures, open `connectors/github-sync.ts` and copy the PR item's exact `externalId` and metadata literal (Task-8-of-1a verified: PRs are `${repoFull}#${num}` with metadata carrying `number`, `repo`, `state`, `draft`, `merged`, and the merge SHA key that `syncPrGraph` reads — `merge_commit_sha`; confirm the key name at `graph-populator.ts:265-267` and in github-sync, then use the connector's spelling):

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as path from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { LocalIndex } from "../index/local-index.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { upsertBlameLines } from "../security/blame-store.ts";
import { runWhyPeek } from "./why-peek.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = path.resolve(path.join(path.sep, "work", "repo"));
const roots: NimbusFilesystemRootToml[] = [
  { path: ROOT, gitAware: true, codeIndex: true, dependencyGraph: true, exclude: [] },
];

function seededDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();

  // filesystem git_commit item — copied verbatim from filesystem-v2-sync.ts:194-209.
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "git_commit",
    externalId: `${SHA}_r1`,
    title: "Fix retry backoff",
    bodyPreview: SHA,
    modifiedAt: now,
    syncedAt: now,
    metadata: { repoRoot: ROOT, sha: SHA, subject: "Fix retry backoff" },
  });

  // github PR — externalId/metadata shape from github-sync.ts (confirm keys per Step 1 preamble).
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#412",
    title: "Fix retry backoff",
    bodyPreview: "part of NIM-88",
    url: "https://github.com/acme/app/pull/412",
    modifiedAt: now,
    syncedAt: now,
    metadata: { number: 412, repo: "acme/app", state: "merged", draft: false, merged: true, merge_commit_sha: SHA },
  });

  // linear issue — shape from 1a's graph-populator-resolves.test.ts ticket-key case.
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff is wrong",
    bodyPreview: "",
    url: "https://linear.app/acme/issue/NIM-88",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  // Blame row seeded via the real builder — zero spawns needed at peek time.
  upsertBlameLines(db, ROOT, "src/retry.ts", [
    { lineNo: 42, commitSha: SHA, authorName: "alice", authorEmail: "alice@example.com", authorTimeMs: 1_700_000_000_000 },
  ]);
  return db;
}

test("peek walks blame → commit → PR → ticket entirely from the index", async () => {
  const db = seededDb();
  const peek = await runWhyPeek({ ref: `${path.join(ROOT, "src", "retry.ts")}:42` }, { db, roots });
  expect(peek.subject).toEqual({ repoRoot: ROOT, filePath: "src/retry.ts", lineNo: 42 });
  expect(peek.author).toBe("alice");
  expect(peek.commitSha).toBe(SHA);
  expect(peek.commitSubject).toBe("Fix retry backoff");
  expect(peek.pr?.number).toBe(412);
  expect(peek.pr?.url).toBe("https://github.com/acme/app/pull/412");
  expect(peek.ticket?.key).toBe("NIM-88");
});

test("a path outside every configured root → null subject and ZERO spawns (red-prove me)", async () => {
  const db = seededDb();
  let spawns = 0;
  const spy = ((..._a: unknown[]) => {
    spawns += 1;
    throw new Error("must not spawn");
  }) as typeof Bun.spawn;
  const outside = path.resolve(path.join(path.sep, "elsewhere", "x.ts"));
  const peek = await runWhyPeek({ ref: `${outside}:1` }, { db, roots, spawn: spy });
  expect(peek.subject).toBeNull();
  expect(spawns).toBe(0);
});

test("no blame row and no git dir → nulls, not an error", async () => {
  const db = seededDb();
  const peek = await runWhyPeek({ ref: `${path.join(ROOT, "src", "other.ts")}:9` }, { db, roots });
  expect(peek.subject).not.toBeNull();
  expect(peek.commitSha).toBeNull();
  expect(peek.pr).toBeNull();
});

test("hasMore is false on this fixture (no mentions/depends_on/correlates_with) and true once a mentions edge exists", async () => {
  const db = seededDb();
  const before = await runWhyPeek({ ref: `${path.join(ROOT, "src", "retry.ts")}:42` }, { db, roots });
  expect(before.hasMore).toBe(false);
  // Slack message mentioning the ticket — shape per slack-sync.ts message items
  // (confirm externalId/metadata in the connector source; 1a's mentions tests used C1/1000.1 + {channel}).
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1000.1",
    title: "anyone looking at NIM-88?",
    bodyPreview: "anyone looking at NIM-88?",
    modifiedAt: now,
    syncedAt: now,
    metadata: { channel: "C1" },
  });
  const after = await runWhyPeek({ ref: `${path.join(ROOT, "src", "retry.ts")}:42` }, { db, roots });
  expect(after.hasMore).toBe(true);
});

test("peek latency under 300 ms on the fixture index", async () => {
  const db = seededDb();
  const t0 = performance.now();
  await runWhyPeek({ ref: `${path.join(ROOT, "src", "retry.ts")}:42` }, { db, roots });
  expect(performance.now() - t0).toBeLessThan(300);
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test packages/gateway/src/agents/why-peek.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `why-peek.ts`. Core queries (all bound-param, all type-scoped INNER JOINs):

```ts
import type { Database } from "bun:sqlite";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { type BlameSpawn, ensureBlameLine } from "./_lib/blame-on-demand.ts";
import { resolveWhySubject } from "./_lib/why-subject.ts";
import type { WhyInput, WhyPeek } from "./_lib/why-types.ts";

export type WhyPeekDeps = {
  db: Database;
  roots: readonly NimbusFilesystemRootToml[];
  spawn?: BlameSpawn;
  exists?: (p: string) => boolean;
};

const SHA_PORTION = "substr(external_id, instr(external_id, ':') + 1)";

function commitSubjectFor(db: Database, sha: string, repoRoot: string): { id: string; label: string } | null {
  return db
    .query(
      `SELECT id, label FROM graph_entity
        WHERE type = 'commit' AND ${SHA_PORTION} = ?
        ORDER BY CASE WHEN json_extract(metadata, '$.repoRoot') = ? THEN 0 ELSE 1 END, id ASC
        LIMIT 1`,
    )
    .get(sha, repoRoot) as { id: string; label: string } | null;
}

function prForSha(db: Database, sha: string): { entityId: string; number: number | null; title: string; url: string | null } | null {
  const row = db
    .query(
      `SELECT p.id AS entity_id,
              CAST(json_extract(i.metadata, '$.number') AS INTEGER) AS number,
              i.title AS title,
              i.url   AS url
         FROM graph_relation r
         JOIN graph_entity c ON c.id = r.to_id  AND c.type = 'commit'
         JOIN graph_entity p ON p.id = r.from_id AND p.type = 'pr'
         JOIN item i ON i.id = p.external_id
        WHERE r.type = 'merged_as'
          AND substr(c.external_id, instr(c.external_id, ':') + 1) = ?
        LIMIT 1`,
    )
    .get(sha) as { entity_id: string; number: number | null; title: string; url: string | null } | null;
  return row === null ? null : { entityId: row.entity_id, number: row.number, title: row.title, url: row.url };
}

function ticketForPr(db: Database, prEntityId: string): { entityId: string; key: string; title: string; url: string | null } | null {
  const row = db
    .query(
      `SELECT ie.id AS entity_id, i.external_id AS key, i.title AS title, i.url AS url
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'pr'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'issue'
         JOIN item i ON i.id = ie.external_id
        WHERE r.from_id = ? AND r.type = 'resolves'
        LIMIT 1`,
    )
    .get(prEntityId) as { entity_id: string; key: string; title: string; url: string | null } | null;
  return row === null ? null : { entityId: row.entity_id, key: row.key, title: row.title, url: row.url };
}
```

`runWhyPeek` assembles: subject (null if unresolved OR `lineNo === null`), `ensureBlameLine` (pass `deps.spawn`), then the three lookups, then `hasMore`:

```ts
function computeHasMore(db: Database, targetIds: readonly string[], subject: { repoRoot: string; filePath: string }): boolean {
  if (targetIds.length > 0) {
    const ph = targetIds.map(() => "?").join(", ");
    const m = db
      .query(`SELECT 1 FROM graph_relation WHERE to_id IN (${ph}) AND type = 'mentions' LIMIT 1`)
      .get(...targetIds);
    if (m !== null) return true;
  }
  const dep = db
    .query(
      `SELECT 1 FROM graph_relation r
        WHERE r.type = 'depends_on'
          AND r.to_id IN (
            SELECT id FROM graph_entity
             WHERE type = 'symbol'
               AND json_extract(metadata, '$.file') = ?
               AND json_extract(metadata, '$.repoRoot') = ?
          )
        LIMIT 1`,
    )
    .get(subject.filePath, subject.repoRoot);
  if (dep !== null) return true;
  return db.query("SELECT 1 FROM graph_relation WHERE type = 'correlates_with' LIMIT 1").get() !== null;
}
```

All nulls flow through (`author: blame?.authorName ?? null`, etc.). No throw on any miss.

- [ ] **Step 4: Run to verify pass** — `bun test packages/gateway/src/agents/why-peek.test.ts && bunx tsc --noEmit -p packages/gateway/tsconfig.json`

- [ ] **Step 5: RED-PROVE the outer fence.** Temporarily make `matchConfiguredRoot` return the first root unconditionally for absolute paths; confirm the "ZERO spawns" test fails (the spy throws / count is 1 — because the missing-`.git` inner fence uses a real path that doesn't exist, ALSO temporarily bypass it to see the spy fire, or point ROOT at the temp-git dir). The point is to witness the test detect the removed guard. Restore, re-run, green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/agents/why-peek.ts packages/gateway/src/agents/why-peek.test.ts
git commit -m "feat(agents): agents.whyPeek core — sub-300ms line-anchored peek"
```

---

### Task 6: The `why` agent — six parallel lanes

**Files:**

- Create: `packages/gateway/src/agents/why.ts`, `why.test.ts`

**Interfaces:**

- Consumes: everything above; `AgentCoordinator`/`SubTask` from `../engine/coordinator.ts`; `emitBriefWithSynthesis`; gap-notes helpers; `reverseDependsOn`.
- Produces:

```ts
export type WhyContext = {
  db: Database;
  roots: readonly NimbusFilesystemRootToml[];
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  spawn?: BlameSpawn;
};
export async function runWhy(input: WhyInput, ctx: WhyContext): Promise<WhyBrief>;
export function emitWhyBrief(input: WhyInput, ctx: WhyContext): Promise<{ sessionId: string }>;
```

Structure is a line-for-line mirror of `impact.ts:53-127`: preflight `detectEmptyIndex`, resolve subject once, `AgentCoordinator` (`parentId: \`why:${ctx.sessionId}\``,`depth: 1`), six`makeSubAgent`-wrapped lanes, JSON-decode results, aggregate gaps, return the brief.`emitWhyBrief` = `emitBriefWithSynthesis({ sessionId, briefReadyMethod: "why.briefReady", briefErrorMethod: "why.briefError", notify, llm?, buildBrief: () => runWhy(input, ctx) })`.

**Lane resolution pass (before the coordinator):** resolve subject; run `ensureBlameLine` **once** (it is the only spawn and two lanes need the SHA — running it inside parallel lanes could double-spawn on a cold line); package `{subject, blame}` and hand it to every lane. Lanes are then pure SQL.

The six lanes — each returns `{ findings?: WhyFinding[]; gap?: GapNote }`:

| Lane | Logic (all queries bound-param, endpoint-type-scoped INNER JOINs) |
| --- | --- |
| `subAuthorship` | No subject/line → gap (`missing_relation_emit`-style detail "cannot anchor"). Blame null → gap `detail: "No blame available for this line (outside an indexed root, not a git repo, or git blame failed)."`. Else finding `{lane:"authorship", title: \`${authorName ?? "unknown"} · ${sha.slice(0,12)}\`, detail: commit subject via commitSubjectFor(...) ?? sha, occurredAt: authorTimeMs, url: null, entityId: commit entity id or null}`. |
| `subPullRequest` | Blame SHA → `prForSha`. Also author person via `SELECT pe.label FROM graph_relation a JOIN graph_entity pe ON pe.id = a.from_id AND pe.type='person' WHERE a.to_id = ? AND a.type='authored' LIMIT 1`. Finding: PR title/number/url, detail includes the PR author label when found. No PR → gap `detectMissingRelationEmit(db, "merged_as", ...)` if the relation has no rows at all, else `{}` (PR simply not merged/indexed). **Reviewers: never promised** — when a PR is found, append the exact gap `expert.ts:287-291` uses: `detectMissingRelationEmit(db, "reviewed", "Tracked as a graph-populator follow-up; not gated on a specific Phase 5 wave.")` (grounding: no populator emits `reviewed`; the spec's "reviewer set" claim was ungrounded). |
| `subTicket` | From the PR entity (if any): the `ticketForPr` query but `.all()` (up to 10), each → finding `{lane:"ticket", title: \`${key} ${title}\`, url, occurredAt: i.modified_at, entityId}`. No PR →`{}`. PR but zero rows →`detectMissingRelationToEntityType(db, "resolves", "issue", "PR bodies emit `resolves` since 1a — reference the ticket key in the PR body.")`. Both endpoints type-scoped (`pe.type='pr'`,`ie.type='issue'`) —`resolves` is polysemous. |
| `subDiscussion` | Target ids = the found pr/issue/commit entity ids. Reverse `mentions`: `SELECT m.id, i.title, i.body_preview, i.url, i.modified_at FROM graph_relation r JOIN graph_entity m ON m.id=r.from_id AND m.type='message' JOIN item i ON i.id=m.external_id WHERE r.to_id IN (…) AND r.type='mentions' ORDER BY i.modified_at DESC LIMIT 20`. Zero rows and zero `mentions` rows overall → `detectMissingRelationEmit(db, "mentions", "Messages emit`mentions`since 1a — connect Slack/Teams and sync.")`; zero rows otherwise → `{}`. |
| `subDriver` | Anchor = blame `authorTimeMs`; without it → `{}`. Incidents in `[t - DRIVER_WINDOW_MS, t]` (`DRIVER_WINDOW_MS = 48h` — a change "responds to" an incident that precedes it; 2 h is the deploy-correlation window, too tight for a human writing a fix): `SELECT e.id, e.label, i.url, CAST(json_extract(e.metadata,'$.occurredAt') AS INTEGER) AS occurred_at FROM graph_entity e JOIN item i ON i.id = e.external_id WHERE e.type='incident' AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at DESC, e.id ASC LIMIT 10`. Enrich each with its correlated deployment (`correlates_with`, deployment→incident, `LIMIT 1`) in the detail. Zero incident entities at all → `detectMissingEntityType(db, "incident")`. Always append (when findings exist too) the permanent-gap honesty note: `detectMissingRelationEmit(db, "affects", "No populator emits`affects`; driver attribution is temporal (48 h window), not causal.")`. |
| `subDownstream` | Symbols of the subject file: `SELECT id, label FROM graph_entity WHERE type='symbol' AND json_extract(metadata,'$.file') = ? AND json_extract(metadata,'$.repoRoot') = ? LIMIT 20`; for each, `reverseDependsOn(db, id, 25)` → findings `{lane:"downstream", title: r.label, detail: \`depends on ${symbolLabel}\`, entityId: r.entityId, url: null, occurredAt: null}` (dedupe by entityId). Zero symbols → gap `detail: "No indexed code symbols for this file — enable code_index on the root and sync."`. Symbols but zero dependents → the same remediation note`impact.ts:228-230` uses (symbol-level `depends_on` granularity). |

- [ ] **Step 1: Write the failing tests** — `why.test.ts`. One `describe` per lane against a fixture DB containing **only that lane's edges** (per the spec's test table), plus a degradation test. Build fixtures with the same connector-verbatim seeding as Task 5 (share a `seedWhyFixture(db, parts: {...})` local helper; do NOT hand-roll new shapes — reuse the Task 5 literals). Key cases:

```ts
// (imports mirror why-peek.test.ts, plus:)
import { runWhy } from "./why.ts";

function ctxFor(db: Database): Parameters<typeof runWhy>[1] {
  return { db, roots, notify: () => {}, sessionId: "why-test-1" };
}

test("authorship lane: blame row → author + commit subject finding", async () => { /* seed commit item + blame row; assert one finding, lane authorship, occurredAt = authorTimeMs */ });

test("pull_request lane: merged_as reverse walk finds the PR by SHA portion", async () => { /* seed PR (merged:true, merge_commit_sha) + blame; assert PR finding title/url; assert a reviewed gap note is present */ });

test("ticket lane: pr → resolves → issue, endpoint-scoped", async () => {
  /* seed the full chain; ALSO insert a person→incident resolves edge directly
     (upsertGraphRelation) and assert it does NOT surface — the polysemy guard. */
});

test("discussion lane: message → mentions → issue surfaces the thread", async () => { /* seed message + issue + mentions via real populator (message body contains NIM-88 → 1a emits the edge) */ });

test("driver lane: incident within 48h before the commit, enriched with its correlated deployment", async () => {
  /* seed incident + deployment via the REAL connector path — import
     syncPagerdutyIncidentItems / mapVercelDeploymentToItem + ctxWithResolver
     exactly as graph-populator-incidents.test.ts does (copy its raw payload
     literals); blame authorTimeMs = incident occurredAt + 1h. Assert one
     driver finding naming the incident. */
});

test("downstream lane: reverse depends_on from the file's symbols", async () => { /* seed two symbol entities + a depends_on edge; assert dependent surfaces */ });

test("git-only degradation: lanes 2-5 emit GapNotes, not errors; brief still renders", async () => {
  /* seed ONLY commit item + blame row. runWhy → findings only in authorship
     (+ maybe downstream gap); assert gaps.length >= 3; assert no lane threw
     (brief returned, kind === "why"). */
});

test("unresolvable ref: subject null, gap note, six lanes all degrade", async () => { /* runWhy({ref:"nope"}) → subject null, findings [], gaps non-empty */ });

test("exactly one blame spawn even with six parallel lanes on a cold line", async () => {
  /* temp git dir + counting spawn (Task 4 helper shape); runWhy on a line with
     no blame row; assert spawn count <= 1. This pins the resolve-once design. */
});
```

Write each `/* */` out as real code — the comments here compress layout, not content; every seeding line comes from the Task 5 literals or the 1a incidents-test import pattern.

- [ ] **Step 2: Run to verify failure** — `bun test packages/gateway/src/agents/why.test.ts` → module not found.

- [ ] **Step 3: Implement `why.ts`** following the lane table above. Mirror `impact.ts`'s `makeSubAgent`/decode/aggregate skeleton exactly (including the `r.status !== "done"` → `missing_connector` gap for a failed sub-agent). Constants at top:

```ts
/** A change "responds to" an incident well before the 2h deploy-correlation window — 48h is the human-latency window. */
const DRIVER_WINDOW_MS = 48 * 60 * 60 * 1000;
const SHA_PORTION = "substr(external_id, instr(external_id, ':') + 1)";
```

Brief assembly mirrors `impact.ts:103-112`: `{ kind: "why", agentVersion: 1, generatedAt: Date.now(), latencyMs, gaps: aggregateMissingEntityTypes([...preflight, ...laneGaps]), query: { ref: input.ref, line: input.line ?? parsedLine }, subject, findings }`.

- [ ] **Step 4: Run to verify pass**

```bash
bun test packages/gateway/src/agents/ && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

Expected: PASS including all pre-existing agent suites.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/why.ts packages/gateway/src/agents/why.test.ts
git commit -m "feat(agents): the why agent — six parallel lanes over the 1a graph edges"
```

---

### Task 7: IPC handlers + Tauri allowlist

**Before touching code, invoke the `nimbus-ipc` and `nimbus-tauri-allowlist` skills** (repo rule: consult before any `agents-rpc.ts` / `gateway_bridge.rs` change).

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts` (+ its test file `agents-rpc.test.ts` or a sibling `agents-rpc.why.test.ts`)
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`
- Modify: `packages/gateway/src/security-invariants.test.ts` (the TS mirror of the Rust count)

**Interfaces:**

- Produces: IPC `agents.why` (async, `{sessionId}`, emits `why.briefReady`/`why.briefError` pair) and `agents.whyPeek` (synchronous payload — the namespace's first, deliberately: same allowlist grouping per the spec's naming decision).

- [ ] **Step 1: Write the failing tests** — `packages/gateway/src/ipc/agents-rpc.why.test.ts`, mirroring the existing per-method tests in `agents-rpc.test.ts` (read one first and copy its harness):

```ts
/* Cases:
   1. agents.why with {ref: "src/a.ts:1"} returns { sessionId: string } synchronously.
   2. agents.why with {} / {ref: 42} / null → AgentsRpcError rpcCode -32602.
   3. agents.whyPeek with a valid ref returns a payload with the WhyPeek keys
      (subject/author/commitSha/pr/ticket/hasMore) — NOT a sessionId.
   4. agents.whyPeek malformed → -32602.
   5. why.briefReady or why.briefError fires after agents.why (await a notify
      capture with a short poll — mirror how existing tests await notifications). */
```

Write these as real tests against `dispatchAgentsRpc` with an in-memory `AgentsRpcContext` (`{db, notify}`; no `configDir` → roots default `[]`, peek subject null — valid).

- [ ] **Step 2: Run to verify failure** — the dispatch misses (`kind: "miss"`).

- [ ] **Step 3: Implement** in `agents-rpc.ts`:

```ts
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { runWhyPeek } from "../agents/why-peek.ts";
import { emitWhyBrief } from "../agents/why.ts";
import type { WhyInput } from "../agents/_lib/why-types.ts";

function requireWhyParams(params: unknown): WhyInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.why requires { ref: string, line?: number }");
  }
  const p = params as { ref?: unknown; line?: unknown };
  if (typeof p.ref !== "string" || p.ref.length === 0 || p.ref.length > 1024) {
    throw new AgentsRpcError(-32602, "agents.why requires { ref: string, line?: number }");
  }
  if (p.line !== undefined && (typeof p.line !== "number" || !Number.isInteger(p.line) || p.line < 1)) {
    throw new AgentsRpcError(-32602, "agents.why line must be a positive integer");
  }
  return { ref: p.ref, ...(p.line === undefined ? {} : { line: p.line }) };
}

function whyRoots(ctx: AgentsRpcContext) {
  return ctx.configDir === undefined ? [] : loadNimbusFilesystemRootsFromConfigDir(ctx.configDir);
}

async function handleWhy(params: unknown, ctx: AgentsRpcContext): Promise<{ sessionId: string }> {
  const input = requireWhyParams(params);
  const sessionId = newSessionId("why");
  return await emitWhyBrief(input, {
    db: ctx.db,
    roots: whyRoots(ctx),
    notify: ctx.notify,
    sessionId,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}

/** The namespace's first synchronous method: no coordinator, no LLM, no notification — returns its payload directly (spec: "a 10-second hover is not a hover"). */
async function handleWhyPeek(params: unknown, ctx: AgentsRpcContext): Promise<WhyPeek> {
  const input = requireWhyParams(params);
  return await runWhyPeek(input, { db: ctx.db, roots: whyRoots(ctx) });
}
```

Add both to the `dispatchByMethod` map (`"agents.why": handleWhy, "agents.whyPeek": handleWhyPeek`). Reuse the file's existing `newSessionId`; match its guard-message phrasing conventions.

- [ ] **Step 4: Tauri allowlist** — in `gateway_bridge.rs`: insert `"agents.why",` and `"agents.whyPeek",` after `"agents.preflight",` (alphabetical: `why` < `whyPeek`); bump `allowlist_exact_size` `99` → `101`; update the TS mirror in `security-invariants.test.ts:556-559` (`99` → `101`). Do NOT touch `NO_TIMEOUT_METHODS` (both methods return fast) or `classify_notification` (briefReady flows through the generic `gateway://notification` channel like the other eight).

- [ ] **Step 5: Run to verify pass**

```bash
bun test packages/gateway/src/ipc/agents-rpc.why.test.ts packages/gateway/src/security-invariants.test.ts && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

If a Rust toolchain is present, also `cargo test --manifest-path packages/ui/src-tauri/Cargo.toml allowlist` (CI runs it regardless; the TS mirror test catches the count drift either way).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.why.test.ts packages/ui/src-tauri/src/gateway_bridge.rs packages/gateway/src/security-invariants.test.ts
git commit -m "feat(ipc): agents.why + agents.whyPeek; Tauri allowlist 99 -> 101"
```

---

### Task 8: `index.regraph` IPC + `nimbus index regraph` CLI

**Files:**

- Create: `packages/gateway/src/ipc/index-regraph-rpc.ts`, `index-regraph-rpc.test.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts`
- Modify: `packages/cli/src/commands/index-cmd.ts` (+ its test if one exists — check for `index-cmd.test.ts` and extend)

**Interfaces:**

- Produces: IPC `index.regraph` (no params) → `{ scanned: number; graphed: number; skipped: number }`; CLI `nimbus index regraph [--json]`.

**The 1a Critical trap this task exists to respect:** `nimbus index regraph` MUST pass `resolveServiceId` to `regraphAllItems` or the backfill **destroys `correlates_with` edges** (the resolver-bound entities re-sync without a resolver, `affectedService` goes null, and the retirement clears fire). Also pass a logger, and surface `skipped > 0` to the user. `graphed` means "actually wrote rows", not "dispatched" — say so in the help text.

- [ ] **Step 1: Write the failing test** — `index-regraph-rpc.test.ts`:

```ts
/* Cases (real SQLite, no mocks):
   1. dispatch("index.regraph", null, ctx) on a DB seeded with the 1a
      regraph.test.ts raw-item pattern (copy insertRawItem + the PR/issue pair
      verbatim) → { scanned: 2, graphed: 2, skipped: 0 } and a resolves edge exists.
   2. THE RESOLVER TRAP, red-proving the wiring: seed a resolver-bound
      deployment + incident using seedResolverBoundIncidentAndDeploy from
      graph/regraph.test.ts (copy the helper + CHECKOUT_SERVICE_CONFIG literal
      into this test file — test files cannot import each other's helpers),
      write a nimbus.toml carrying that ServiceConfig into a temp configDir,
      dispatch with ctx.configDir set → the correlates_with edge COUNT IS
      UNCHANGED after regraph. Then dispatch with ctx.configDir undefined →
      assert the edge count DROPS — proving the resolver is what preserves it
      (and that the production wiring passes it).
   3. dispatch("index.regraph", {unexpected: 1}, ctx) → -32602.
   4. Unknown method → {kind: "miss"}. */
```

Write the temp-config fixture with the `[ci.service.<id>]`-style stanza `loadNimbusServiceConfigsFromConfigDir` parses — copy a literal from `config/nimbus-toml.ts`'s own tests (grep `loadNimbusServiceConfigsFromConfigDir` in `*.test.ts` for a working TOML snippet and copy it verbatim, adjusting ids to `checkout`).

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement** `index-regraph-rpc.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import { regraphAllItems, type RegraphResult } from "../graph/regraph.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class IndexRegraphRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "IndexRegraphRpcError";
  }
}

export type IndexRegraphRpcContext = {
  db: Database;
  configDir?: string;
  logger: Logger;
};

function requireNoParams(params: unknown): void {
  if (params !== null && params !== undefined && (typeof params !== "object" || Array.isArray(params) || Object.keys(params).length > 0)) {
    throw new IndexRegraphRpcError(-32602, "index.regraph takes no parameters");
  }
}

async function handleRegraph(params: unknown, ctx: IndexRegraphRpcContext): Promise<RegraphResult> {
  requireNoParams(params);
  // Without the resolver, resolver-bound deployments/incidents re-sync with a
  // null affectedService and the retirement clears DESTROY their
  // correlates_with edges (1a Task 9 / the F1 fix). Fail toward preserving
  // edges: always thread the resolver when a configDir exists.
  const resolveServiceId =
    ctx.configDir === undefined
      ? undefined
      : buildServiceIdentityResolver(loadNimbusServiceConfigsFromConfigDir(ctx.configDir), (w) =>
          ctx.logger.warn({ warning: w }, "ambiguous service binding during regraph"),
        );
  return regraphAllItems(ctx.db, {
    logger: ctx.logger,
    ...(resolveServiceId === undefined ? {} : { resolveServiceId }),
  });
}

export async function dispatchIndexRegraphRpc(
  method: string,
  params: unknown,
  ctx: IndexRegraphRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "index.regraph": handleRegraph });
}
```

(Match `regraphAllItems`'s actual `logger` option type — if it is not pino's `Logger`, use the type `regraph.ts` declares. Match `buildServiceIdentityResolver`'s warner signature from `metrics/service-identity.ts:40-47`.)

Wire into `server/dispatchers.ts` copying the `index.reembed` block shape (`:523-543`): gate on `method === "index.regraph"`, require `localIndex`, ctx `{db: ctx.options.localIndex.getDatabase(), configDir: ctx.options.configDir (spread-if-defined), logger: pino({ level: "info" })}`, map `IndexRegraphRpcError` → `RpcMethodError`.

- [ ] **Step 4: CLI** — in `index-cmd.ts`: add `regraph` to `runIndexCmd`'s chain and the help text:

```ts
type RegraphSummary = { scanned: number; graphed: number; skipped: number };

async function runRegraph(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const result = await withGatewayIpc(async (c) => c.call<RegraphSummary>("index.regraph", null));
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    // `graphed` counts items that actually wrote graph rows, not items dispatched.
    console.log(`regraph: scanned ${String(result.scanned)}, graphed ${String(result.graphed)}, skipped ${String(result.skipped)}`);
  }
  if (result.skipped > 0) {
    console.error(`WARN: ${String(result.skipped)} item(s) failed to graph — see the gateway log for per-item errors.`);
  }
}
```

Help text line (match the file's existing format): `regraph      Re-run the graph populator over every indexed item (backfills resolves/mentions/correlates_with)`.

- [ ] **Step 5: Run to verify pass**

```bash
bun test packages/gateway/src/ipc/index-regraph-rpc.test.ts packages/cli/src/commands/ && bunx tsc --noEmit -p packages/gateway/tsconfig.json && bunx tsc --noEmit -p packages/cli/tsconfig.json
```

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/index-regraph-rpc.ts packages/gateway/src/ipc/index-regraph-rpc.test.ts packages/gateway/src/ipc/server/dispatchers.ts packages/cli/src/commands/index-cmd.ts
git commit -m "feat(index): nimbus index regraph — resolver-threaded graph backfill over IPC"
```

---

### Task 9: `nimbus why` CLI

**Files:**

- Create: `packages/cli/src/commands/why.ts` (+ `why.test.ts` mirroring however `impact` is tested — check for `impact.test.ts` / dispatcher tests and copy the harness)
- Modify: `packages/cli/src/commands/registry.ts` (`"why"` between `"watch"` and `"workflow"`), `packages/cli/src/commands/index.ts` (barrel), `packages/cli/src/index.ts` (`why: runWhyCli` in `COMMAND_HANDLERS` + import)

**Interfaces:**

- Consumes: `runAgentCli` from `../lib/agent-cli-dispatcher.ts`; `withGatewayIpc` from `../lib/with-gateway-ipc.ts`.
- Produces: `runWhyCli(args: string[]): Promise<void>`.

The guard: `@nimbus-dev/sdk` 1.5.x has no `isWhyBrief` — define a local structural guard in `why.ts` (step 2 replaces it with the SDK guard):

```ts
type WhyBriefLike = { kind: "why"; findings: unknown[]; gaps: Array<{ category: string }> };
/** Structural stand-in until sdk 1.6.0 ships isWhyBrief (why-lens step 2). */
function isWhyBriefLike(v: unknown): v is WhyBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as { kind?: unknown; findings?: unknown; gaps?: unknown };
  return b.kind === "why" && Array.isArray(b.findings) && Array.isArray(b.gaps);
}
```

- [ ] **Step 1: Write the failing test** — arg-parsing units (pure) + a peek-render unit; the full-path IPC flow is covered by the shared dispatcher's existing tests:

```ts
/* Cases:
   parseWhyArgs(["src/a.ts:42"])           → { ref: "src/a.ts:42", peek: false, json: false }
   parseWhyArgs(["src/a.ts", "--line", "7", "--peek", "--json"]) → { ref: "src/a.ts", line: 7, peek: true, json: true }
   parseWhyArgs([])                        → throws the usage string
   parseWhyArgs(["--line", "x", "a.ts"])   → throws (line must be a positive integer)
   renderPeekLine(fullPeek)  → "alice · a1b2c3d4e5f6 · 2023-11-14 · Fix retry backoff · PR #412 · NIM-88"
   renderPeekLine(emptyPeek) → "No indexed answer for <ref> (line not blamed, or path outside the indexed roots)." */
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `why.ts` (mirror `impact.ts`'s parse-then-dispatch shape; usage string `"Usage: nimbus why <path[:line] | symbol> [--line <n>] [--peek] [--json]"`):

```ts
export async function runWhyCli(args: string[]): Promise<void> {
  const parsed = parseWhyArgs(args);
  if (parsed.peek) {
    const peek = await withGatewayIpc(async (c) =>
      c.call<WhyPeekLike>("agents.whyPeek", {
        ref: parsed.ref,
        ...(parsed.line === undefined ? {} : { line: parsed.line }),
      }),
    );
    process.stdout.write(`${parsed.json ? JSON.stringify(peek, null, 2) : renderPeekLine(parsed.ref, peek)}\n`);
    return;
  }
  await runAgentCli({
    agentName: "why",
    ipcMethod: "agents.why",
    callParams: { ref: parsed.ref, ...(parsed.line === undefined ? {} : { line: parsed.line }) },
    guard: isWhyBriefLike,
    json: parsed.json,
  });
}
```

`WhyPeekLike` is a local structural type (subject/author/commitSha/committedAt/commitSubject/pr/ticket/hasMore, all as in the gateway type — the CLI cannot import gateway source; IPC-only rule). `renderPeekLine` joins the non-null parts with `" · "`.

- [ ] **Step 4: Register** — registry (+`"why"`), barrel, `COMMAND_HANDLERS`. Then:

```bash
bun test packages/cli/src/ && bunx tsc --noEmit -p packages/cli/tsconfig.json && bun run audit:readme-cli
```

Expected: PASS. (`audit:readme-cli` validates `docs/README.md` references against the registry — it goes red only if a doc names an unregistered command; adding the registry entry now keeps Task 12's docs green.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/why.ts packages/cli/src/commands/why.test.ts packages/cli/src/commands/registry.ts packages/cli/src/commands/index.ts packages/cli/src/index.ts
git commit -m "feat(cli): nimbus why <ref> [--line N] [--peek] [--json]"
```

---

### Task 10: Triaged 1a backlog — ticket-key prose stoplist + `REGRAPH_TYPE_ORDER`

**Files:**

- Modify: `packages/gateway/src/graph/graph-refs.ts`, `graph-refs.test.ts`
- Modify: `packages/gateway/src/graph/regraph.ts`, `regraph.test.ts`

- [ ] **Step 1: Failing tests.** Append to `graph-refs.test.ts`:

```ts
test("standards references in prose are not ticket keys", () => {
  expect(extractIssueRefs("encode as UTF-8 per RFC-2119, hash with SHA-256, scan CVE-2024-1234")).toEqual({
    numeric: [],
    ticketKeys: [],
  });
});

test("real tracker keys still match after the stoplist", () => {
  expect(extractIssueRefs("NIM-88 and ABC-7 remain")).toEqual({ numeric: [], ticketKeys: ["NIM-88", "ABC-7"] });
});
```

Append to `regraph.test.ts`:

```ts
test("obsidian_note is in the ordered slice, not the catch-all", () => {
  // Guards the REGRAPH_TYPE_ORDER omission deferred from 1a: note entities are
  // backlink targets, so the ordered pass must create them before anything that
  // references them. Assert membership structurally (the array is not exported;
  // read the source) — plus a behavioral check that a raw obsidian_note item
  // regraphs into a note entity.
  const src = require("node:fs").readFileSync(require.resolve("./regraph.ts"), "utf8") as string;
  const orderBlock = /REGRAPH_TYPE_ORDER[^\]]+\]/.exec(src)?.[0] ?? "";
  expect(orderBlock).toContain("obsidian_note");
});
```

(Also add the behavioral half: `insertRawItem` an `obsidian_note`-typed row — copy the obsidian connector's externalId/metadata shape from `connectors/obsidian-sync.ts` verbatim — run `regraphAllItems`, assert its entity exists. If `syncObsidianNoteGraph` requires metadata keys the raw insert lacks, ground them from the connector first.)

- [ ] **Step 2: Run to verify the new cases fail** (`SHA-256` currently extracts as a ticket key; `obsidian_note` is absent from the order block).

- [ ] **Step 3: Implement.** In `graph-refs.ts`:

```ts
/**
 * Prefixes that look like ticket keys but are overwhelmingly standards
 * references in prose (deferred from 1a as a real precision issue: each false
 * positive costs an unindexed LIKE scan, and a tracker project literally
 * named e.g. SHA would emit a WRONG edge — worse than a missing one).
 * A real tracker whose project key collides with this list cannot be
 * resolved; that trade is deliberate and mirrors 1a's short-SHA reasoning
 * in reverse: there the cost of filtering was silent misses, here the cost
 * of NOT filtering is wrong edges.
 */
const NON_TICKET_KEY_PREFIXES: ReadonlySet<string> = new Set([
  "RFC", "UTF", "SHA", "ISO", "CVE", "IEEE", "ECMA", "ANSI", "CWE", "CVSS", "PEP", "MD", "AES", "TLS",
]);
```

…and in `extractIssueRefs`'s ticket-key loop, before pushing: `const prefix = m[1]; if (prefix !== undefined && NON_TICKET_KEY_PREFIXES.has(prefix)) continue;` (the regex already captures the prefix in group 1).

In `regraph.ts`: add `"obsidian_note"` to `REGRAPH_TYPE_ORDER` (position: with the other target-first types, before `pr`/`message`) and extend the doc comment: notes are `backlinks` targets.

- [ ] **Step 4: Run the full graph suite** — `bun test packages/gateway/src/graph/` — 1a's suites must stay green: the stoplist must not break any existing extraction test (if an existing 1a test uses a stoplisted prefix as a positive case, STOP and reconcile with the reviewer rather than editing the old test silently).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/graph/
git commit -m "fix(graph): ticket-key standards stoplist + obsidian_note in regraph order (1a backlog)"
```

---

### Task 11: E2E + latency

**Files:**

- Create: `packages/gateway/test/e2e/scenarios/why.e2e.test.ts`

Remember: this directory is **not typechecked** — run the tests; do not trust `tsc` for it.

- [ ] **Step 1: Write the test**, mirroring `impact.e2e.test.ts`'s in-process shape, with the Task 5 seeding (blame row via `upsertBlameLines` = pure DB hit, zero spawns in e2e):

```ts
/* Cases:
   1. Full chain: runWhy on `<ROOT>/src/retry.ts:42` (roots fixture) against the
      Task-5 seeded DB → brief.kind === "why"; findings include lanes
      "authorship", "pull_request", "ticket"; latency < 10_000 ms measured
      around the call; brief renders via renderWhy without throwing.
   2. Git-only index (commit + blame only): authorship findings present; gaps
      name at least merged_as/mentions/incident-shaped remediations; NO errors.
   3. Structural HITL-free: read agents/why.ts, why-peek.ts,
      _lib/blame-on-demand.ts sources; expect not.toContain("ToolExecutor") and
      not.toContain("HITL_REQUIRED"). ALSO the source-scanning trap from memory:
      assert the why.ts source DOES contain "reverseDependsOn(" — with the
      paren — proving the shared-traversal guard matches a call site, not a
      leftover import.
   4. Notification pair: emitWhyBrief with a capturing notify → eventually one
      "why.briefReady" with {sessionId, brief: string, findings} where
      findings.kind === "why"; brief non-empty. */
```

- [ ] **Step 2: Run** — `bun test packages/gateway/test/e2e/scenarios/why.e2e.test.ts` → PASS (write implementation-free: the agent already exists; this task is test-only unless it finds a bug — if it does, fix in the module that owns it, never by loosening the test).

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/e2e/scenarios/why.e2e.test.ts
git commit -m "test(agents): why e2e — lanes, degradation, HITL-free, <10s"
```

---

### Task 12: Docs

**Files:**

- Modify: `docs/cli-reference.md` — two sections in the established format (heading → prose → bash examples → Options table → Output line → Read-only line → `---`): `### \`nimbus why\`` under Team Intelligence (after `impact`), and a`regraph` row/paragraph in the `nimbus index` section beside `reembed`. Copy the`impact`section's anatomy exactly (`cli-reference.md:223-244`); for`why`, the Read-only line notes the one local`git blame` subprocess (root-fenced, cached, not a connector call).
- Modify: `docs/architecture.md` — one row in the agent catalogue table (~line 1066-1080): Phase `S1` | Agent `why` | Command `nimbus why` | IPC `agents.why` / `agents.whyPeek` | Status shipped; plus the `agents.*` comment block (~:1163-1217) gains the two methods.
- Modify: `docs/CHANGELOG.md` — dated entry under 2026-07 (connector-docs convention: deliveries go here, NOT the CLAUDE.md status line): the why agent + peek + CLI + `nimbus index regraph` + the 1a-backlog fixes, referencing why-lens step 1b.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run the doc gates:**

```bash
bun run audit:readme-cli && bun run audit:doc-refs && bun run audit:status-drift
```

Expected: PASS. If lychee is installed (`~/.cargo/bin/lychee`), run it over the changed docs and match CI's link total (gate the whole branch, not just edited files — review docs must not embed absolute `file:///C:/gitrep/...worktrees/` links).

- [ ] **Step 3: Commit**

```bash
git add docs/cli-reference.md docs/architecture.md docs/CHANGELOG.md
git commit -m "docs: nimbus why + whyPeek + index regraph reference and catalogue entries"
```

---

## Final verification (before the first push — ship-readiness rule: never push-and-see)

- [ ] `bun run preflight` — the full CI-parity gate set (`test:ci` alone is NOT it). Note: full preflight can be unusable inside `.claude/worktrees` (1a hit this) — if it fails on worktree-shape issues rather than real gates, run the static gates individually (`bunx biome check packages scripts`, `bunx tsc --noEmit -p packages/gateway/tsconfig.json`, `-p packages/cli/tsconfig.json`, `bun run audit:structure`, the audit trio from Task 12) and run full preflight from a clean checkout of the branch outside the repo if needed.
- [ ] Docker-Linux coverage floor: `docker run --rm -v "$PWD":/w -w /w oven/bun:latest bash -c "bun install --frozen-lockfile && bun run audit:coverage-floor"` — every new file ≥80% line AND branch. New files here are small and directly tested; if `why.ts` dips on branches, add lane-edge cases rather than excluding.
- [ ] `bun run audit:structure` — no invariant drift (this plan adds no `connectors.dispatch` site, no HITL type, no write route; D12 covers the one new write path, `upsertBlameLines`, which already goes through `dbRun`).
- [ ] `bun run audit:cross-platform` — the new path-handling code (`why-subject.ts`) is the risk surface; every test path built with `path.join`.
- [ ] Whole-branch review (see below), THEN push and open the PR.

## Whole-branch review (mandatory, the highest-value gate)

Every serious 1a defect — including two dead edge types — was found by review, never by implementation; per-task reviews each saw one slice and three times passed things broken by another part of the same branch. After all tasks: dispatch a fresh-context reviewer over the ENTIRE branch diff (`git diff main...HEAD`) with the spec + this plan, explicitly hunting cross-task defects:

1. Do the lanes' SQL shapes match what the **merged** 1a populator actually writes (not what this plan says it writes)? Re-derive `resolves`/`mentions`/`correlates_with`/`merged_as` shapes from `graph-populator.ts` source, then check each lane query against them.
2. Does anything traverse `resolves` without scoping BOTH endpoint types?
3. Can any spawn happen on a path outside `[[filesystem.roots]]`? (Re-red-prove: comment the fence, run the two fence tests, watch them fail.)
4. Are all fixtures connector-verbatim? Diff every test fixture literal against the connector source it claims to copy.
5. Cross-surface drift: Rust allowlist count vs TS mirror; registry vs `COMMAND_HANDLERS` vs docs; peek type shape CLI-side vs gateway-side.
6. The Task 8 resolver trap: does the production `dispatchers.ts` wiring actually pass `configDir` through, and does the test prove edge preservation through the REAL dispatch path (not by calling `regraphAllItems` directly)?
