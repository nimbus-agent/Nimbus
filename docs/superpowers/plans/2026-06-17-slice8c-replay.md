# Phase 6 Slice 8c — Replay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `nimbus verify-share <file|url> --replay` — a deterministic, LLM-free local re-execution of a shared recipe's (or a transcript share's) tool calls, classifying each step against the shared original and rendering a divergence report (`match` / `diverged` / `missing-connector` / `skipped-non-read` / `error`).

**Architecture:** A new `share/read-tool-registry.ts` provides a **positive** read-only allowlist (`isReadOnlyToolId`) sourced from connector read-verb naming (`*_list`/`*_get`/`*_query`/`*_search` + a curated read surface) — never "absent from the HITL set", so a write tool that is missing from `HITL_REQUIRED_BACKING` is still classified non-read and skipped. `share/recipe-runner.ts` normalizes a `ShareFile` (recipe or transcript) into ordered `RecipeStep`s and replays each step in recorded order against an injected read-only tool executor, producing a `ReplayReport`. A new `share.replay` RPC loads + verifies the share, builds the executor from the live connector mesh, runs the runner, and returns `{ verify, report }`; the CLI `verify-share --replay` flag renders it. No migration, no new invariant — replay is read-only and routes no data outward.

**Tech Stack:** Bun + TypeScript 6 strict · `bun:sqlite` · `js-yaml@^4.2.0` (declared `packages/gateway` dep, reused by `verify-share.ts`) · `@noble/hashes/blake3` + `tweetnacl` (existing share-format) · Biome.

## Global Constraints

- **No `any`** — `unknown` for external/wire input (the share file, the recipe `body.recipe: unknown`, tool execute results); TypeScript strict mode. (Non-Negotiable #7)
- **Read-only is structural, enforced by a POSITIVE allowlist** — a step executes only when `isReadOnlyToolId(step.tool)` returns true. The classifier sources read tools from connector read-verb naming + a curated read set; it **NEVER** classifies a tool read-only by its absence from `HITL_REQUIRED_BACKING`. This is the security-load-bearing point of 8c (spec §8.1, design-review point 3). The runner must never invoke the executor for a non-read tool.
- **No new emit path / no new invariant** — replay reads the user's own connectors locally and emits nothing. I27/D21 (the share-gate emit chokepoint) are untouched: no new `share.publish` / `share.signing.privkey` / `createShare` references. Replay does **not** re-invoke the LLM and does **not** execute write/HITL actions (spec §12).
- **Deterministic, LLM-free** — `replayRecipe(steps, deps)` executes steps in recorded order (`step` order from the share); it never consults `dependsOn`. Same recipe + same executor outcomes → same report.
- **No migration** — 8c adds none. `CURRENT_SCHEMA_VERSION` stays **42** (`packages/gateway/src/index/local-index.ts:269`).
- **Privacy of the original** — the shared artifact carries only per-step `params` + `status` (no result bodies, by 8a/8b design). The diff is therefore status-level (`replayStatus` vs `originalStatus`) + availability — it never reconstructs or leaks the origin's result data.
- **Coverage** — every new/modified file clears the ≥80% line+branch true-coverage floor (Docker-Linux-authoritative; baseline at `docs/structure-audit/coverage-baseline.json`). New pure files (`read-tool-registry.ts`, `recipe-runner.ts`) must be ≥80%; IPC/CLI glue follows the 8a exclusion precedent only where a pure core can't be tested.
- **Tests** — run with `bun test <path>`; gateway unit tests live beside source as `*.test.ts`.
- **CLI surface note** — spec §8.2 names the surface `nimbus share verify --replay`. The shipped 8a verification entry point is the top-level `nimbus verify-share <file|url>` command (there is no `share verify` subcommand). To avoid a duplicate verify command, 8c realizes the spec's replay intent by adding a `--replay` flag to the existing `verify-share` command. (Documented in Task 9's CHANGELOG entry.)

---

### Task 1: `share/read-tool-registry.ts` — positive read-only allowlist

**Files:**

- Create: `packages/gateway/src/share/read-tool-registry.ts`
- Test: `packages/gateway/src/share/read-tool-registry.test.ts`

**Interfaces:**

- Consumes: `HITL_REQUIRED` from `../engine/executor.ts` (test only — to assert a write tool absent from the HITL set is still non-read); `WAREHOUSE_BI_WRITE_TOOL_IDS` from `../connectors/warehouse-write-tools.ts` (test only).
- Produces: `function isReadOnlyToolId(toolId: string): boolean` — `true` iff the tool's trailing `_`-segment is a known read verb (the spec's `list`/`get`/`query`/`search` + a curated read surface grounded in connector tool ids); `false` for everything else (write verbs, unknown/unclassifiable, malformed input).

> **Why positive, not "absent from HITL"** (spec §8.1, design-review point 3): a write tool that someone forgot to add to `HITL_REQUIRED_BACKING` would, under a denylist, be treated as safe and executed during replay. A positive allowlist fails safe — anything not recognized as read-only is skipped. The read-verb set below is grounded in a scan of `packages/mcp-connectors/*` tool ids (dominant read suffixes: `list` 138×, `get` 93×, `search` 68×, `query`; plus `read`/`history`/`download`/`preview`/`info`/`metadata` confirmed on real tool ids, and `fetch`/`describe`/`export`/`view`/`show` as unambiguously-read forward-compat verbs). Skipping a genuine read tool not in this set is a fail-safe false-negative (it shows `skipped-non-read`, no data is touched) — never a security hole. **Deliberately NOT included:** write-ambiguous verbs like `status` (a `_status` tool could plausibly set state) and any verb no connector uses today (`exists`, `count`) — broadening a positive allowlist trades fail-safety for coverage, so additions must be unambiguously read AND worth the margin; a connector that needs one is a safe, additive follow-up.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/share/read-tool-registry.test.ts
import { describe, expect, test } from "bun:test";
import { WAREHOUSE_BI_WRITE_TOOL_IDS } from "../connectors/warehouse-write-tools.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import { isReadOnlyToolId } from "./read-tool-registry.ts";

describe("isReadOnlyToolId — positive read-only allowlist", () => {
  test("the spec's four read-verb suffixes classify read-only", () => {
    expect(isReadOnlyToolId("gmail_list")).toBe(true);
    expect(isReadOnlyToolId("slack_user_get")).toBe(true);
    expect(isReadOnlyToolId("snowflake_table_query")).toBe(true);
    expect(isReadOnlyToolId("slack_search")).toBe(true);
  });

  test("curated read-surface verbs (grounded in real connector tool ids) classify read-only", () => {
    expect(isReadOnlyToolId("slack_channel_history")).toBe(true);
    expect(isReadOnlyToolId("dataprofile_preview")).toBe(true);
    expect(isReadOnlyToolId("drive_file_read")).toBe(true);
  });

  test("write verbs classify NON-read", () => {
    for (const w of ["email_send", "file_delete", "jira_issue_create", "calendar_event_update"]) {
      expect(isReadOnlyToolId(w)).toBe(false);
    }
  });

  test("malformed / empty / no-underscore input is non-read (fail-safe)", () => {
    expect(isReadOnlyToolId("")).toBe(false);
    expect(isReadOnlyToolId("recommend")).toBe(false);
    expect(isReadOnlyToolId("get")).toBe(false); // bare verb, no tool prefix
  });

  // SECURITY-LOAD-BEARING (spec §8.1): classification is POSITIVE, never "absent from HITL".
  test("a write tool ABSENT from HITL_REQUIRED_BACKING is still non-read", () => {
    const fabricatedWrite = "acme_destroy"; // not a read verb, and not in the HITL frozen set
    expect(HITL_REQUIRED.has("acme.destroy")).toBe(false); // genuinely absent from HITL
    expect(isReadOnlyToolId(fabricatedWrite)).toBe(false); // …yet still classified non-read
  });

  test("warehouse/BI write tool ids are all non-read (they end in write verbs)", () => {
    for (const id of WAREHOUSE_BI_WRITE_TOOL_IDS) {
      expect(isReadOnlyToolId(id)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/read-tool-registry.test.ts`
Expected: FAIL — `Cannot find module './read-tool-registry.ts'`.

- [ ] **Step 3: Implement the registry**

```ts
// packages/gateway/src/share/read-tool-registry.ts

/**
 * Positive read-only tool allowlist for recipe replay (Phase 6 Slice 8c, spec §8.1).
 *
 * A tool is read-only iff its trailing `_`-segment is a recognized READ verb. The set is the
 * spec's four (`list`/`get`/`query`/`search`) plus a curated read surface grounded in a scan of
 * `packages/mcp-connectors/*` tool ids (e.g. `slack_channel_history`, `dataprofile_preview`,
 * `*_read`/`*_fetch`/`*_download`). This is intentionally a POSITIVE allowlist — a write tool
 * absent from `HITL_REQUIRED_BACKING` (a real risk the design review flagged) is STILL classified
 * non-read here, because classification never consults the HITL set. Anything unrecognized is
 * skipped (`skipped-non-read`), which is fail-safe: a missed read tool costs replay coverage, never
 * safety. Broadening the set is a safe, additive follow-up.
 */
const READ_VERBS: ReadonlySet<string> = new Set([
  // spec §8.1 core
  "list",
  "get",
  "query",
  "search",
  // curated read surface (read-only verbs observed in connector tool ids)
  "read",
  "fetch",
  "download",
  "describe",
  "preview",
  "history",
  "export",
  "view",
  "show",
  "info", // slack_user_info, teams_user_info
  "metadata", // gdrive_file_metadata
]);

/** Classify a tool id as read-only by its trailing `_`-segment verb. Pure; fail-safe on bad input. */
export function isReadOnlyToolId(toolId: string): boolean {
  if (typeof toolId !== "string") return false;
  const idx = toolId.lastIndexOf("_");
  if (idx <= 0 || idx === toolId.length - 1) return false; // no prefix, or trailing "_"
  return READ_VERBS.has(toolId.slice(idx + 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/read-tool-registry.test.ts`
Expected: PASS (6 tests).

> If `HITL_REQUIRED` is not an exported name from `executor.ts`, the substrate map shows it is exported as `export const HITL_REQUIRED = Object.freeze({...}) as unknown as ReadonlySet<string>` — use `HITL_REQUIRED.has(...)`. Confirm the import resolves before implementing.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/read-tool-registry.ts packages/gateway/src/share/read-tool-registry.test.ts
git commit -m "feat(share): positive read-only tool allowlist for recipe replay"
```

---

### Task 2: `share/recipe-runner.ts` — types + share→steps normalization

**Files:**

- Create: `packages/gateway/src/share/recipe-runner.ts`
- Test: `packages/gateway/src/share/recipe-runner.test.ts`

**Interfaces:**

- Consumes: `RecipeStep` from `./recipe.ts`; `ShareFile`, `ShareToolCall` from `./share-format.ts`.
- Produces:
  - `type ToolRunOutcome = { readonly kind: "unavailable" } | { readonly kind: "ran"; readonly ok: boolean } | { readonly kind: "threw"; readonly message: string }` — the result of attempting one tool locally (consumed by Task 3; produced by the executor wired in Task 6).
  - `type ReplayStepStatus = "match" | "diverged" | "missing-connector" | "skipped-non-read" | "error"`.
  - `interface ReplayStepResult { readonly stepId: string; readonly tool: string; readonly service: string; readonly status: ReplayStepStatus; readonly originalStatus: string; readonly detail?: string }`.
  - `interface ReplaySummary { readonly total: number; readonly match: number; readonly diverged: number; readonly missingConnector: number; readonly skippedNonRead: number; readonly error: number }`.
  - `interface ReplayReport { readonly sourceSessionId: string; readonly steps: readonly ReplayStepResult[]; readonly summary: ReplaySummary }`.
  - `interface RecipeRunnerDeps { readonly isReadOnly: (toolId: string) => boolean; readonly run: (toolId: string, params: unknown) => Promise<ToolRunOutcome> }`.
  - `function stepsFromShare(share: ShareFile): { readonly sourceSessionId: string; readonly steps: readonly RecipeStep[] }` — normalizes a recipe share (`body.recipe`) or a transcript share (`body.toolCalls`) into ordered `RecipeStep`s.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/share/recipe-runner.test.ts
import { describe, expect, test } from "bun:test";
import type { ShareFile } from "./share-format.ts";
import { stepsFromShare } from "./recipe-runner.ts";

function shareWith(body: Partial<ShareFile["body"]> & { kind: "transcript" | "recipe" }): ShareFile {
  return {
    format: "nimbus-share/v1",
    contentHash: "x",
    body: {
      sessionId: "s1",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: "h", pubkey: "P" },
      ...body,
    },
    sig: { alg: "ed25519", pubkey: "P", signature: "S" },
    forwarding: { hops: 0, chain: [] },
  };
}

describe("stepsFromShare", () => {
  test("recipe share → uses body.recipe.steps in order", () => {
    const share = shareWith({
      kind: "recipe",
      recipe: {
        recipeVersion: 1,
        sourceSessionId: "s1",
        generatedAt: 1,
        graphTraversals: [],
        steps: [
          { stepId: "step-1", tool: "gmail_list", service: "gmail", params: { a: 1 }, status: "ok", dependsOn: [] },
          { stepId: "step-2", tool: "slack_search", service: "slack", params: {}, status: "ok", dependsOn: [] },
        ],
      },
    });
    const { sourceSessionId, steps } = stepsFromShare(share);
    expect(sourceSessionId).toBe("s1");
    expect(steps.map((s) => s.tool)).toEqual(["gmail_list", "slack_search"]);
  });

  test("transcript share → synthesizes steps from body.toolCalls (ordered, step-N ids)", () => {
    const share = shareWith({
      kind: "transcript",
      toolCalls: [
        { toolId: "gmail_get", service: "gmail", params: { id: "1" }, status: "ok" },
        { toolId: "file_delete", service: "fs", params: { path: "/x" }, status: "ok" },
      ],
    });
    const { steps } = stepsFromShare(share);
    expect(steps.map((s) => s.stepId)).toEqual(["step-1", "step-2"]);
    expect(steps[1]?.tool).toBe("file_delete");
    expect(steps[1]?.dependsOn).toEqual([]);
  });

  test("malformed / missing recipe → empty steps (fail-safe)", () => {
    expect(stepsFromShare(shareWith({ kind: "recipe", recipe: undefined })).steps).toEqual([]);
    expect(stepsFromShare(shareWith({ kind: "recipe", recipe: { nope: true } })).steps).toEqual([]);
    expect(stepsFromShare(shareWith({ kind: "transcript" })).steps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/recipe-runner.test.ts`
Expected: FAIL — `Cannot find module './recipe-runner.ts'`.

- [ ] **Step 3: Implement the types + normalization**

```ts
// packages/gateway/src/share/recipe-runner.ts
import type { RecipeStep } from "./recipe.ts";
import type { ShareFile, ShareToolCall } from "./share-format.ts";

/** Outcome of attempting one tool locally during replay (produced by the executor, Task 6). */
export type ToolRunOutcome =
  | { readonly kind: "unavailable" } // connector/tool not installed locally
  | { readonly kind: "ran"; readonly ok: boolean } // executed; ok = resolved without throwing
  | { readonly kind: "threw"; readonly message: string }; // execution raised

export type ReplayStepStatus =
  | "match"
  | "diverged"
  | "missing-connector"
  | "skipped-non-read"
  | "error";

export interface ReplayStepResult {
  readonly stepId: string;
  readonly tool: string;
  readonly service: string;
  readonly status: ReplayStepStatus;
  /** The status recorded in the shared artifact (`ok`/`error`). */
  readonly originalStatus: string;
  /** Human note: the connector name for `missing-connector`, the error message for `error`, etc. */
  readonly detail?: string;
}

export interface ReplaySummary {
  readonly total: number;
  readonly match: number;
  readonly diverged: number;
  readonly missingConnector: number;
  readonly skippedNonRead: number;
  readonly error: number;
}

export interface ReplayReport {
  readonly sourceSessionId: string;
  readonly steps: readonly ReplayStepResult[];
  readonly summary: ReplaySummary;
}

export interface RecipeRunnerDeps {
  /** Positive read-only classifier (Task 1's `isReadOnlyToolId` in production). */
  readonly isReadOnly: (toolId: string) => boolean;
  /** Execute one read-only tool locally and report the outcome (mesh-backed in production, Task 6). */
  readonly run: (toolId: string, params: unknown) => Promise<ToolRunOutcome>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/** Validate one untrusted recipe-step object into a `RecipeStep` (or `null` if malformed). */
function parseStep(v: unknown, index: number): RecipeStep | null {
  if (!isRecord(v)) return null;
  const tool = v["tool"];
  const service = v["service"];
  if (typeof tool !== "string" || typeof service !== "string") return null;
  const stepId = typeof v["stepId"] === "string" ? v["stepId"] : `step-${index + 1}`;
  const status = typeof v["status"] === "string" ? v["status"] : "ok";
  const dependsOn = Array.isArray(v["dependsOn"])
    ? v["dependsOn"].filter((d): d is string => typeof d === "string")
    : [];
  return { stepId, tool, service, params: v["params"], status, dependsOn };
}

/**
 * Normalize a share into ordered replay steps. A recipe share uses `body.recipe.steps`; a transcript
 * share synthesizes steps from `body.toolCalls` (recorded order). Both are untrusted external input,
 * so every field is validated — anything malformed yields zero steps (fail-safe). Replay executes in
 * this order and never consults `dependsOn`.
 */
export function stepsFromShare(share: ShareFile): {
  readonly sourceSessionId: string;
  readonly steps: readonly RecipeStep[];
} {
  const sourceSessionId = share.body.sessionId;
  if (share.body.kind === "recipe") {
    const recipe = share.body.recipe;
    const rawSteps = isRecord(recipe) && Array.isArray(recipe["steps"]) ? recipe["steps"] : [];
    const steps = rawSteps
      .map((s, i) => parseStep(s, i))
      .filter((s): s is RecipeStep => s !== null);
    return { sourceSessionId, steps };
  }
  const toolCalls: readonly ShareToolCall[] = share.body.toolCalls ?? [];
  const steps: RecipeStep[] = toolCalls.map((tc, i) => ({
    stepId: `step-${i + 1}`,
    tool: tc.toolId,
    service: tc.service,
    params: tc.params,
    status: tc.status,
    dependsOn: [],
  }));
  return { sourceSessionId, steps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/recipe-runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/recipe-runner.ts packages/gateway/src/share/recipe-runner.test.ts
git commit -m "feat(share): recipe-runner types + share→steps normalization"
```

---

### Task 3: `share/recipe-runner.ts` — `replayRecipe` (per-step classification + summary)

**Files:**

- Modify: `packages/gateway/src/share/recipe-runner.ts`
- Test: `packages/gateway/src/share/recipe-runner.test.ts`

**Interfaces:**

- Consumes: `RecipeStep` (`./recipe.ts`), `RecipeRunnerDeps`, `ToolRunOutcome`, `ReplayReport`, `ReplayStepResult` (Task 2).
- Produces: `function replayRecipe(sourceSessionId: string, steps: readonly RecipeStep[], deps: RecipeRunnerDeps): Promise<ReplayReport>` — classifies each step in order:
  - `isReadOnly(step.tool)` false → `skipped-non-read` (executor NOT called);
  - else `run(...)` → `{kind:"unavailable"}` → `missing-connector` (detail = service); `{kind:"threw"}` → `error` (detail = message); `{kind:"ran",ok}` → `match` if `(ok ? "ok" : "error") === step.status` else `diverged`.

> Classification order is fixed and the branches are mutually exclusive. `replayStatus` after a `ran` outcome is `"ok"` when `ok` is true, else `"error"` — the same ok/error semantics `tool_call_log` records. `diverged` therefore fires when the local outcome's status differs from the shared step's recorded status.

> **Expected divergence is not a bug** (review open-questions A/B): the shared params are PII/secret-redacted (8a/8b), so a step whose redacted param was a required id/path/query will legitimately fail locally → `error` (the connector raised) or `diverged` (it ran but the original errored). Likewise a service the local operator hasn't connected → `missing-connector` (tool absent from the map) or `error` (execute throws on missing creds). These outcomes are the divergence report doing its job — surfacing "this step needs connector X / a real value you don't have" — not a runner defect. No special-casing in the runner.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/share/recipe-runner.test.ts`:

```ts
import { replayRecipe, type ToolRunOutcome } from "./recipe-runner.ts";
import type { RecipeStep } from "./recipe.ts";

function step(tool: string, status = "ok", params: unknown = {}): RecipeStep {
  return { stepId: `step-x`, tool, service: tool.split("_")[0] ?? "svc", params, status, dependsOn: [] };
}

describe("replayRecipe — per-step classification", () => {
  const readOnly = (t: string) => t.endsWith("_get") || t.endsWith("_list");

  test("non-read tool → skipped-non-read, executor NEVER called", async () => {
    let calls = 0;
    const report = await replayRecipe("s1", [step("file_delete")], {
      isReadOnly: readOnly,
      run: async () => {
        calls++;
        return { kind: "ran", ok: true };
      },
    });
    expect(report.steps[0]?.status).toBe("skipped-non-read");
    expect(calls).toBe(0);
  });

  test("unavailable → missing-connector (detail = service)", async () => {
    const report = await replayRecipe("s1", [step("gmail_get")], {
      isReadOnly: readOnly,
      run: async () => ({ kind: "unavailable" }),
    });
    expect(report.steps[0]?.status).toBe("missing-connector");
    expect(report.steps[0]?.detail).toBe("gmail");
  });

  test("threw → error (detail = message)", async () => {
    const report = await replayRecipe("s1", [step("gmail_get")], {
      isReadOnly: readOnly,
      run: async () => ({ kind: "threw", message: "boom" }),
    });
    expect(report.steps[0]?.status).toBe("error");
    expect(report.steps[0]?.detail).toBe("boom");
  });

  test("ran ok + original ok → match; ran ok + original error → diverged", async () => {
    const ran: ToolRunOutcome = { kind: "ran", ok: true };
    const r1 = await replayRecipe("s1", [step("gmail_get", "ok")], { isReadOnly: readOnly, run: async () => ran });
    expect(r1.steps[0]?.status).toBe("match");
    const r2 = await replayRecipe("s1", [step("gmail_get", "error")], { isReadOnly: readOnly, run: async () => ran });
    expect(r2.steps[0]?.status).toBe("diverged");
  });

  test("summary tallies each category and total", async () => {
    const steps = [step("file_delete"), step("gmail_get", "ok"), step("slack_list", "ok")];
    const report = await replayRecipe("s1", steps, {
      isReadOnly: readOnly,
      run: async (tool) => (tool === "gmail_get" ? { kind: "ran", ok: true } : { kind: "unavailable" }),
    });
    expect(report.summary).toEqual({
      total: 3,
      match: 1,
      diverged: 0,
      missingConnector: 1,
      skippedNonRead: 1,
      error: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/recipe-runner.test.ts`
Expected: FAIL — `replayRecipe` is not exported.

- [ ] **Step 3: Implement `replayRecipe`**

Append to `packages/gateway/src/share/recipe-runner.ts`:

```ts
import type { RecipeStep } from "./recipe.ts";

/**
 * Replay a recipe's steps locally, in recorded order, classifying each against the shared original.
 * Deterministic and read-only: the executor is invoked ONLY for positively-classified read tools
 * (spec §8.1). Never consults `dependsOn`; never re-invokes the LLM; never runs a write action.
 */
export async function replayRecipe(
  sourceSessionId: string,
  steps: readonly RecipeStep[],
  deps: RecipeRunnerDeps,
): Promise<ReplayReport> {
  const results: ReplayStepResult[] = [];
  for (const s of steps) {
    const base = { stepId: s.stepId, tool: s.tool, service: s.service, originalStatus: s.status };
    if (!deps.isReadOnly(s.tool)) {
      results.push({ ...base, status: "skipped-non-read" });
      continue;
    }
    const outcome = await deps.run(s.tool, s.params);
    if (outcome.kind === "unavailable") {
      results.push({ ...base, status: "missing-connector", detail: s.service });
    } else if (outcome.kind === "threw") {
      results.push({ ...base, status: "error", detail: outcome.message });
    } else {
      const replayStatus = outcome.ok ? "ok" : "error";
      results.push({ ...base, status: replayStatus === s.status ? "match" : "diverged" });
    }
  }
  const summary: ReplaySummary = {
    total: results.length,
    match: results.filter((r) => r.status === "match").length,
    diverged: results.filter((r) => r.status === "diverged").length,
    missingConnector: results.filter((r) => r.status === "missing-connector").length,
    skippedNonRead: results.filter((r) => r.status === "skipped-non-read").length,
    error: results.filter((r) => r.status === "error").length,
  };
  return { sourceSessionId, steps: results, summary };
}
```

> Remove the now-duplicate `import type { RecipeStep }` line if Task 2 already imported it at the top — keep a single import. (The append above assumes the top-of-file import from Task 2 exists; if so, drop this second `import type { RecipeStep }`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/recipe-runner.test.ts`
Expected: PASS (all — Task 2 + Task 3).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/recipe-runner.ts packages/gateway/src/share/recipe-runner.test.ts
git commit -m "feat(share): replayRecipe — per-step divergence classification + summary"
```

---

### Task 4: `share/recipe-runner.ts` — `replayShare` wrapper + security guarantee test

**Files:**

- Modify: `packages/gateway/src/share/recipe-runner.ts`
- Test: `packages/gateway/src/share/recipe-runner.test.ts`

**Interfaces:**

- Consumes: `stepsFromShare` (Task 2), `replayRecipe` (Task 3), `ShareFile`, `RecipeRunnerDeps`, `ReplayReport`.
- Produces: `function replayShare(share: ShareFile, deps: RecipeRunnerDeps): Promise<ReplayReport>` — `stepsFromShare` then `replayRecipe`. This is the single entry point the RPC calls.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/share/recipe-runner.test.ts`. The security test uses the REAL `isReadOnlyToolId` (not a fake) + a spy executor, proving end-to-end that a write tool absent from the HITL set is never executed:

```ts
import { replayShare } from "./recipe-runner.ts";
import { isReadOnlyToolId } from "./read-tool-registry.ts";

describe("replayShare", () => {
  test("recipe share → report over its steps", async () => {
    const share = shareWith({
      kind: "recipe",
      recipe: {
        recipeVersion: 1, sourceSessionId: "s1", generatedAt: 1, graphTraversals: [],
        steps: [{ stepId: "step-1", tool: "gmail_list", service: "gmail", params: {}, status: "ok", dependsOn: [] }],
      },
    });
    const report = await replayShare(share, {
      isReadOnly: () => true,
      run: async () => ({ kind: "ran", ok: true }),
    });
    expect(report.summary.total).toBe(1);
    expect(report.steps[0]?.status).toBe("match");
  });

  // SECURITY-LOAD-BEARING (spec §8.1 / §11): a write tool absent from HITL_REQUIRED_BACKING must be
  // skipped-non-read and NEVER handed to the executor, under the REAL classifier.
  test("a write tool absent from HITL is skipped-non-read and never executed", async () => {
    const executed: string[] = [];
    const share = shareWith({
      kind: "transcript",
      toolCalls: [
        { toolId: "acme_destroy", service: "acme", params: { all: true }, status: "ok" }, // write, not in HITL
        { toolId: "snowflake_tag_set", service: "snowflake", params: {}, status: "ok" }, // write, IS in HITL
        { toolId: "gmail_get", service: "gmail", params: {}, status: "ok" }, // genuine read
      ],
    });
    const report = await replayShare(share, {
      isReadOnly: isReadOnlyToolId, // the REAL positive allowlist
      run: async (toolId) => {
        executed.push(toolId);
        return { kind: "ran", ok: true };
      },
    });
    expect(executed).toEqual(["gmail_get"]); // ONLY the read tool was executed
    expect(report.steps[0]?.status).toBe("skipped-non-read"); // acme_destroy (HITL-absent write)
    expect(report.steps[1]?.status).toBe("skipped-non-read"); // snowflake_tag_set (HITL-present write)
    expect(report.steps[2]?.status).toBe("match"); // gmail_get
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/recipe-runner.test.ts`
Expected: FAIL — `replayShare` is not exported.

- [ ] **Step 3: Implement `replayShare`**

Append to `packages/gateway/src/share/recipe-runner.ts`:

```ts
/** Replay a whole share (recipe or transcript). The single entry point for the `share.replay` RPC. */
export async function replayShare(share: ShareFile, deps: RecipeRunnerDeps): Promise<ReplayReport> {
  const { sourceSessionId, steps } = stepsFromShare(share);
  return replayRecipe(sourceSessionId, steps, deps);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/recipe-runner.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/recipe-runner.ts packages/gateway/src/share/recipe-runner.test.ts
git commit -m "feat(share): replayShare entry point + read-only-allowlist security test"
```

---

### Task 5: `verify-share.ts` loader helpers + `share.replay` RPC

**Files:**

- Modify: `packages/gateway/src/share/verify-share.ts` (export two reusable helpers)
- Modify: `packages/gateway/src/ipc/share-rpc.ts` (new `share.replay` handler + `ShareRpcCtx.listReplayTools` dep)
- Test: `packages/gateway/src/share/verify-share.test.ts` (the new helpers)
- Test: `packages/gateway/src/ipc/share-rpc.test.ts` (the `share.replay` dispatch)

**Interfaces:**

- Produces (verify-share.ts):
  - `function loadShareBytes(input: string, deps?: { readonly safeFetchFn?: typeof safeFetch }): Promise<Uint8Array>` — fetch (http/https via safeFetch) or read a local file; the input-loading half of `verifyShareFromInput`.
  - `function parseShareFile(bytes: Uint8Array): ShareFile | null` — YAML-or-JSON parse + minimal shape validation (`body`/`sig`/`forwarding` present); `null` if not a share. Reuses the private `toJsonShareBytes` normalizer.
- Produces (share-rpc.ts):
  - `ShareRpcCtx.listReplayTools: () => Promise<LazyMeshToolMap>` — the live connector tool map (mesh-backed in Task 6).
  - `share.replay` method: params `{ input?: string } | { bytesB64?: string }` → `{ verify: VerifyResult; report: ReplayReport }`.

- [ ] **Step 1: Write the failing test (verify-share helpers)**

Append to `packages/gateway/src/share/verify-share.test.ts`. Reuse the file's existing `signedRecipeShare()` factory (defined at ~line 106 — builds a signed recipe `ShareFile`; that shape is fine for the loader/parse tests, which don't care whether it's a recipe or transcript):

```ts
import { loadShareBytes, parseShareFile } from "./verify-share.ts";
import { serializeShareFileToYaml } from "./recipe-yaml.ts";

test("parseShareFile parses a JSON share", () => {
  const share = signedRecipeShare(); // existing helper in this file (~line 106)
  const bytes = new TextEncoder().encode(JSON.stringify(share));
  expect(parseShareFile(bytes)?.body.sessionId).toBe(share.body.sessionId);
});

test("parseShareFile parses a YAML share (recipe variant)", () => {
  const share = signedRecipeShare();
  const bytes = new TextEncoder().encode(serializeShareFileToYaml(share));
  expect(parseShareFile(bytes)?.body.sessionId).toBe(share.body.sessionId);
});

test("parseShareFile returns null for non-share input", () => {
  expect(parseShareFile(new TextEncoder().encode("not a share"))).toBeNull();
  expect(parseShareFile(new TextEncoder().encode(JSON.stringify({ hi: 1 })))).toBeNull();
});

test("loadShareBytes reads a local file", async () => {
  const share = signedRecipeShare();
  const path = `${import.meta.dir}/../../../../node_modules/.cache/share-${share.contentHash}.json`;
  await Bun.write(path, JSON.stringify(share));
  const bytes = await loadShareBytes(path);
  expect(parseShareFile(bytes)?.contentHash).toBe(share.contentHash);
});
```

> `signedRecipeShare()` already exists in this file (it uses `generateEd25519Keypair()` + `buildShareFile`); reuse it. For `loadShareBytes`, write to a tmp path via `mkdtempSync(join(tmpdir(), …))` (the S5443-safe pattern) rather than the node_modules cache path shown above — prefer the tmpdir form.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/verify-share.test.ts`
Expected: FAIL — `loadShareBytes` / `parseShareFile` not exported.

- [ ] **Step 3: Implement the helpers in `verify-share.ts`**

Add the import + two exports. `parseShareFile` reuses the existing private `toJsonShareBytes`:

```ts
import type { ShareFile } from "./share-format.ts";
```

```ts
/**
 * Load raw share bytes from a URL (SSRF-safe {@link safeFetch}) or a local file path. The
 * input-loading half of {@link verifyShareFromInput}, exported so `share.replay` can both verify and
 * parse the same bytes without a second read.
 */
export async function loadShareBytes(
  input: string,
  deps?: { readonly safeFetchFn?: typeof safeFetch },
): Promise<Uint8Array> {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const doFetch = deps?.safeFetchFn ?? safeFetch;
    const res = await doFetch(input);
    return new Uint8Array(await res.arrayBuffer());
  }
  return await Bun.file(input).bytes();
}

/**
 * Parse share bytes (JSON or YAML) into a {@link ShareFile} for replay, or `null` if the input is not
 * a well-formed share envelope. Verification is the trust boundary ({@link verifyShareFromBytes}) —
 * this only structurally validates enough to read `body`/`sig`/`forwarding`. Never throws.
 */
export function parseShareFile(bytes: Uint8Array): ShareFile | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(toJsonShareBytes(bytes))) as unknown;
    if (
      obj === null ||
      typeof obj !== "object" ||
      typeof (obj as { body?: unknown }).body !== "object" ||
      (obj as { body?: unknown }).body === null ||
      typeof (obj as { sig?: unknown }).sig !== "object"
    ) {
      return null;
    }
    return obj as ShareFile;
  } catch {
    return null;
  }
}
```

> Optional DRY: refactor `verifyShareFromInput` to call `loadShareBytes` (it currently inlines the same fetch/file logic). Safe and tidy, but not required — leave it if the diff risk isn't worth it.

- [ ] **Step 4: Write the failing test (`share.replay` dispatch)**

Append to `packages/gateway/src/ipc/share-rpc.test.ts` (reuse the file's existing ctx factory — add a `listReplayTools` to it). Build a signed recipe share on disk, then dispatch `share.replay` with `{ input: path }`:

```ts
import { buildShareFile } from "../share/share-format.ts";
import nacl from "tweetnacl";
import { encodeBase64 } from "@nimbus-dev/sdk";

test("share.replay verifies + replays a recipe share; report classifies each step", async () => {
  const ctx = makeCtx(); // existing helper
  // sign a recipe share with one read + one write step
  const seed = nacl.randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const body = {
    kind: "recipe" as const, sessionId: "s1", createdAt: 1, expiresAt: null,
    redactionSet: [], origin: { label: "h", pubkey: encodeBase64(kp.publicKey) },
    recipe: {
      recipeVersion: 1, sourceSessionId: "s1", generatedAt: 1, graphTraversals: [],
      steps: [
        { stepId: "step-1", tool: "gmail_get", service: "gmail", params: {}, status: "ok", dependsOn: [] },
        { stepId: "step-2", tool: "file_delete", service: "fs", params: {}, status: "ok", dependsOn: [] },
      ],
    },
  };
  const share = buildShareFile(body, encodeBase64(seed), encodeBase64(kp.publicKey));
  const dir = mkdtempSync(join(tmpdir(), "share-replay-"));
  const path = join(dir, "r.nimbus-share.json");
  await Bun.write(path, JSON.stringify(share));

  const res = (await dispatchShareRpc("share.replay", { input: path }, {
    ...ctx,
    // gmail_get available (runs ok); file_delete is a write → never reached
    listReplayTools: async () => ({ gmail_get: { execute: async () => ({}) } }),
  })) as { result: { verify: { ok: boolean }; report: { summary: { match: number; skippedNonRead: number } } } };

  expect(res.result.verify.ok).toBe(true);
  expect(res.result.report.summary.match).toBe(1); // gmail_get
  expect(res.result.report.summary.skippedNonRead).toBe(1); // file_delete
});
```

> Add the imports the test needs (`mkdtempSync`, `tmpdir`, `join`, the nacl/sdk helpers) mirroring the file's existing import style.

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/share-rpc.test.ts`
Expected: FAIL — `share.replay` is not a handler / `listReplayTools` not on ctx.

- [ ] **Step 6: Implement the `share.replay` handler**

In `packages/gateway/src/ipc/share-rpc.ts`:

Add imports:

```ts
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import { replayShare, type ToolRunOutcome } from "../share/recipe-runner.ts";
import { isReadOnlyToolId } from "../share/read-tool-registry.ts";
import { loadShareBytes, parseShareFile } from "../share/verify-share.ts";
```

(The existing `verifyShareFromBytes` import stays.)

Add the `listReplayTools` dep to `ShareRpcCtx` (after `httpSink`):

```ts
  /**
   * The live connector tool map for recipe replay (Slice 8c). Mesh-backed in production
   * (`platform/assemble.ts`). A tool absent from the map → `missing-connector`. Read-only by
   * construction: the runner only ever invokes tools the positive allowlist classifies read-only.
   */
  readonly listReplayTools: () => Promise<LazyMeshToolMap>;
```

Add a helper that adapts one mesh tool into a `ToolRunOutcome` (near `emitHttp`):

```ts
/** Run one mesh tool and normalize the outcome for the replay runner. Read-only: callers gate first. */
async function runReplayTool(
  tools: LazyMeshToolMap,
  toolId: string,
  params: unknown,
): Promise<ToolRunOutcome> {
  const tool = tools[toolId];
  if (tool === undefined || typeof tool.execute !== "function") {
    return { kind: "unavailable" };
  }
  try {
    await tool.execute(params);
    return { kind: "ran", ok: true };
  } catch (e) {
    return { kind: "threw", message: e instanceof Error ? e.message : String(e) };
  }
}
```

Add the handler to the `HANDLERS` map (after `share.verify`):

```ts
  // REPLAY (Slice 8c) — load + verify a share, then re-run its read-only tool calls locally and diff
  // each step against the shared original. Read-only + LLM-free: the runner executes a tool only when
  // the POSITIVE allowlist (read-tool-registry) classifies it read-only — never by HITL absence.
  "share.replay": async (params, ctx) => {
    const rec = asRecord(params) ?? {};
    let bytes: Uint8Array;
    if (typeof rec["input"] === "string") {
      bytes = await loadShareBytes(rec["input"]);
    } else if (typeof rec["bytesB64"] === "string") {
      bytes = Uint8Array.from(Buffer.from(rec["bytesB64"], "base64"));
    } else {
      throw new ShareRpcError(-32602, "ERR_INVALID_PARAMS: input (url/path) or bytesB64 required");
    }
    const verify = verifyShareFromBytes(bytes, { now: ctx.now() });
    const share = parseShareFile(bytes);
    if (share === null) {
      throw new ShareRpcError(-32602, "ERR_INVALID_PARAMS: not a share file");
    }
    const tools = await ctx.listReplayTools();
    const report = await replayShare(share, {
      isReadOnly: isReadOnlyToolId,
      run: (toolId, p) => runReplayTool(tools, toolId, p),
    });
    return { verify, report };
  },
```

- [ ] **Step 7: Run both test files to verify they pass**

Run: `bun test packages/gateway/src/share/verify-share.test.ts packages/gateway/src/ipc/share-rpc.test.ts`
Expected: PASS (all, including the new helper + replay tests).

- [ ] **Step 8: Typecheck the gateway**

Run: `bunx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: 0 errors. (Every `ShareRpcCtx` literal must now supply `listReplayTools`; the only production site is `assemble.ts`, wired in Task 6. The test ctx factory must provide it too — Step 4 passes it inline; also add a default to `makeCtx` if other tests construct ctx without it.)

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/share/verify-share.ts packages/gateway/src/share/verify-share.test.ts \
        packages/gateway/src/ipc/share-rpc.ts packages/gateway/src/ipc/share-rpc.test.ts
git commit -m "feat(share): share.replay RPC + verify-share loader/parse helpers"
```

---

### Task 6: assemble.ts wiring — mesh-backed `listReplayTools`

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts` (`ipcOpts.shareRpcCtx`, ~line 1650–1683)

**Interfaces:**

- Consumes: `connectorMesh.listToolsForDispatcher()` (already used in this file at ~line 1096 / ~line 1333 — confirm `connectorMesh` is in scope at the share-ctx site, ~line 1650).
- Produces: the production `listReplayTools` dep on `ipcOpts.shareRpcCtx`.

> No new unit test — `assemble.ts` is integration-wired; the e2e (Task 8) exercises this path. This is a one-line dep addition.

- [ ] **Step 1: Add the dep to the share ctx**

In `packages/gateway/src/platform/assemble.ts`, in the `ipcOpts.shareRpcCtx = { … }` literal (~line 1650), add after `httpSink: shareHttpSink,`:

```ts
    // Slice 8c replay: the live connector tool map. `share.replay` re-runs only read-only-classified
    // tools (read-tool-registry) against it; an uninstalled connector → `missing-connector`.
    listReplayTools: () => connectorMesh.listToolsForDispatcher(),
```

- [ ] **Step 2: Typecheck the gateway**

Run: `bunx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: 0 errors. (If `connectorMesh` is not the in-scope identifier at this site, use whatever the two earlier `listTools: () => …listToolsForDispatcher()` call sites reference — grep `listToolsForDispatcher` in this file to confirm the variable name.)

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(share): wire mesh-backed listReplayTools into the share RPC ctx"
```

---

### Task 7: CLI — `verify-share --replay` + pure report formatter

**Files:**

- Modify: `packages/cli/src/commands/share.ts` (`runVerifyShare` + a new pure `formatReplayReport`)
- Test: `packages/cli/src/commands/share-replay-format.test.ts` (the pure formatter)

**Interfaces:**

- Consumes: the `share.replay` RPC `{ verify, report }` shape (Task 5).
- Produces:
  - `function formatReplayReport(report: ReplayReportShape): string` — a deterministic, pure renderer of the divergence report (per-step lines + a summary line). Exported for testing (the surrounding `runVerifyShare` IPC glue follows the 8a `share.ts` coverage-exclusion precedent; the pure formatter is tested directly).
  - `ReplayReportShape` — a local structural type mirroring the RPC return (CLI does not import gateway types).

- [ ] **Step 1: Write the failing test (pure formatter)**

```ts
// packages/cli/src/commands/share-replay-format.test.ts
import { describe, expect, test } from "bun:test";
import { formatReplayReport } from "./share.ts";

describe("formatReplayReport", () => {
  const report = {
    sourceSessionId: "s1",
    steps: [
      { stepId: "step-1", tool: "gmail_get", service: "gmail", status: "match", originalStatus: "ok" },
      { stepId: "step-2", tool: "file_delete", service: "fs", status: "skipped-non-read", originalStatus: "ok" },
      { stepId: "step-3", tool: "slack_list", service: "slack", status: "missing-connector", originalStatus: "ok", detail: "slack" },
    ],
    summary: { total: 3, match: 1, diverged: 0, missingConnector: 1, skippedNonRead: 1, error: 0 },
  };

  test("renders one line per step with status + tool", () => {
    const out = formatReplayReport(report);
    expect(out).toContain("step-1");
    expect(out).toContain("gmail_get");
    expect(out).toContain("match");
    expect(out).toContain("skipped-non-read");
    expect(out).toContain("missing-connector");
  });

  test("renders a summary line with the counts", () => {
    const out = formatReplayReport(report);
    expect(out).toContain("3"); // total
    expect(out).toMatch(/match.*1/);
  });

  test("empty report → a clear 'no steps' line, no crash", () => {
    const out = formatReplayReport({ sourceSessionId: "s", steps: [], summary: { total: 0, match: 0, diverged: 0, missingConnector: 0, skippedNonRead: 0, error: 0 } });
    expect(out.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/share-replay-format.test.ts`
Expected: FAIL — `formatReplayReport` not exported.

- [ ] **Step 3: Implement the formatter + wire `--replay`**

In `packages/cli/src/commands/share.ts`, add the structural type + pure formatter (above `runVerifyShare`):

```ts
interface ReplayStepShape {
  readonly stepId: string;
  readonly tool: string;
  readonly service: string;
  readonly status: string;
  readonly originalStatus: string;
  readonly detail?: string;
}
interface ReplayReportShape {
  readonly sourceSessionId: string;
  readonly steps: readonly ReplayStepShape[];
  readonly summary: {
    readonly total: number;
    readonly match: number;
    readonly diverged: number;
    readonly missingConnector: number;
    readonly skippedNonRead: number;
    readonly error: number;
  };
}

/** Pure renderer for the replay divergence report (one line per step + a summary). */
export function formatReplayReport(report: ReplayReportShape): string {
  const lines: string[] = [`Replay of session ${report.sourceSessionId} (${report.summary.total} steps):`];
  if (report.steps.length === 0) {
    lines.push("  (no replayable steps in this share)");
  }
  for (const s of report.steps) {
    const suffix = s.detail === undefined ? "" : ` — ${s.detail}`;
    lines.push(`  ${s.stepId}  ${s.status.padEnd(18)} ${s.tool}${suffix}`);
  }
  const m = report.summary;
  lines.push(
    `Summary: match ${m.match}, diverged ${m.diverged}, missing-connector ${m.missingConnector}, skipped-non-read ${m.skippedNonRead}, error ${m.error}`,
  );
  return lines.join("\n");
}
```

Then extend `runVerifyShare` to honor `--replay` (call `share.replay` instead of `share.verify`, print verification + the formatted report):

```ts
export async function runVerifyShare(args: string[]): Promise<void> {
  const replay = args.includes("--replay");
  const input = args.find((a) => !a.startsWith("--"));
  if (input === undefined) {
    console.error("Usage: nimbus verify-share <file|url> [--replay]");
    process.exitCode = 1;
    return;
  }
  const isUrl = input.startsWith("http://") || input.startsWith("https://");
  // Read the local file up front with a friendly error (a missing/unreadable path otherwise crashes
  // with an unhandled rejection). Applies to both the verify and replay paths.
  let params: { input: string } | { bytesB64: string };
  if (isUrl) {
    params = { input };
  } else {
    try {
      params = { bytesB64: Buffer.from(await Bun.file(input).bytes()).toString("base64") };
    } catch {
      console.error(`Cannot read share file: ${input}`);
      process.exitCode = 1;
      return;
    }
  }
  await withIpc(async (c) => {
    if (replay) {
      const r = await c.call<{
        verify: { ok: boolean; signatureValid: boolean; expired: boolean; errors: string[] };
        report: ReplayReportShape;
      }>("share.replay", params);
      console.log(
        `signature: ${r.verify.signatureValid ? "VALID" : "INVALID"}${r.verify.expired ? " (expired)" : ""}`,
      );
      console.log(formatReplayReport(r.report));
      if (!r.verify.ok) {
        console.error(r.verify.errors.join("; ")); // surface why the share is invalid (tamper/expiry)
        process.exitCode = 1;
      }
      return;
    }
    const r = await c.call<{
      ok: boolean;
      signatureValid: boolean;
      contentHashValid: boolean;
      expired: boolean;
      errors: string[];
    }>("share.verify", params);
    console.log(
      `signature: ${r.signatureValid ? "VALID" : "INVALID"}${r.expired ? " (expired)" : ""}`,
    );
    if (!r.ok) {
      console.error(r.errors.join("; "));
      process.exitCode = 1;
    }
  });
}
```

> Note the `input` parse change: `args[0]` → `args.find(a => !a.startsWith("--"))` so `verify-share --replay <file>` and `verify-share <file> --replay` both work.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/share-replay-format.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck the CLI**

Run: `bunx tsc -p packages/cli/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/share.ts packages/cli/src/commands/share-replay-format.test.ts
git commit -m "feat(share): verify-share --replay renders the divergence report"
```

---

### Task 8: E2E — recipe replay round-trip

**Files:**

- Modify: `packages/gateway/test/e2e/share-e2e.test.ts` (add a replay case)

**Interfaces:** Consumes the real-gateway raw-IPC harness already established by 8a/8b (`NIMBUS_E2E_SEED_SESSION_JSON` + `NIMBUS_E2E_SEED_TOOLCALLS_JSON` seams; the create→approve flow).

- [ ] **Step 1: Read the existing e2e to reuse its harness**

Read `packages/gateway/test/e2e/share-e2e.test.ts`. Identify (a) how it seeds tool calls (`NIMBUS_E2E_SEED_TOOLCALLS_JSON`), (b) the create→`share.approvalRespond` round-trip, (c) where the created share file lands on disk (the `--out`/file-sink path). The replay case reuses all three.

- [ ] **Step 2: Write the replay e2e case**

Add a test that: seeds a session with at least one tool call, creates a recipe share to a file path, approves it, then calls `share.replay` with `{ input: <recipe file path> }` and asserts the report. The spawned gateway has no real connectors installed, so the seeded read tool replays as `missing-connector` — a valid, deterministic assertion that exercises load → verify → parse → classify end-to-end. If the seed includes a write-shaped tool id (e.g. `file_delete`), assert it is `skipped-non-read`:

```ts
// shape assertions (adapt to the harness's rpc helper)
const replay = await rpc("share.replay", { input: recipeFilePath });
expect(replay.verify.ok).toBe(true);
expect(replay.report.summary.total).toBeGreaterThan(0);
// uninstalled connector in a bare gateway → missing-connector; a write step → skipped-non-read
expect(replay.report.summary.missingConnector + replay.report.summary.skippedNonRead).toBeGreaterThan(0);
```

> If the 8a/8b seed seam already seeds a read tool (`gmail_search`) but not a write tool, that step replays as `missing-connector` (no gmail connector in the e2e gateway) — assert `missingConnector >= 1`. To also assert `skipped-non-read`, extend `NIMBUS_E2E_SEED_TOOLCALLS_JSON` with one write-shaped tool id (e.g. `{ toolId: "file_delete", service: "fs", params: {} }`). Keep the seam test-only.

- [ ] **Step 3: Run the e2e**

Run: `bun test packages/gateway/test/e2e/share-e2e.test.ts`
Expected: PASS (8a transcript + 8b recipe + the new replay case).

> Windows-local note (8a/8b memory): the share consent-broker test hangs on Windows-local from an unref'd TTL timer — pass on Linux CI. If the gateway suite hangs locally, verify this e2e in isolation and rely on Docker/Linux for the full-suite gate.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/test/e2e/share-e2e.test.ts
git commit -m "test(share): e2e recipe replay round-trip (create --as-recipe → approve → replay)"
```

---

### Task 9: Docs — CHANGELOG + spec status + architecture

**Files:**

- Modify: `docs/CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md` (mark §8 implemented)
- Modify: `docs/architecture.md` (note replay in the share subsystem; no schema change)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the CHANGELOG entry**

Add under the current dated/unreleased section of `docs/CHANGELOG.md` (mirror the 8a/8b entry style):

```markdown
- **Share & Virality — Slice 8c (replay):** `nimbus verify-share <file|url> --replay` now re-runs a
  shared recipe's (or a transcript share's) tool calls locally and renders a divergence report
  (`match` / `diverged` / `missing-connector` / `skipped-non-read` / `error`). Replay is
  deterministic and LLM-free; read-only is enforced by a POSITIVE allowlist
  (`share/read-tool-registry.ts`) sourced from connector read-verb naming — a tool absent from the
  HITL set is classified non-read and skipped, never executed. No migration, no new invariant
  (replay reads the user's own connectors and emits nothing). Realizes the spec's
  `nimbus share verify --replay` intent via the existing `verify-share` command.
```

- [ ] **Step 2: Mark the spec section implemented**

In `docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md`, §13 (wave→PR→plan map), update the 8c row to reference this plan (`plan-8c`) and note it shipped. Optionally add a one-line "Implemented 2026-06-17 (PR #…)" note at §8 — leave the PR number as a placeholder to fill at ship time, or omit if the repo convention tracks status only in the CHANGELOG.

- [ ] **Step 3: Note replay in architecture.md**

Find the share/virality subsystem description in `docs/architecture.md` (added by 8a). Add a sentence: replay (`share.replay` RPC + `share/recipe-runner.ts`) re-executes a share's read-only-classified tool calls locally for a divergence report; it adds no schema (current version stays V42) and no invariant. Do NOT add a schema-table row (no migration).

- [ ] **Step 4: Run the doc-reference audit**

Run: `bun run audit:doc-refs`
Expected: PASS (no broken links / stale paths).

- [ ] **Step 5: Commit**

```bash
git add docs/CHANGELOG.md docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md docs/architecture.md
git commit -m "docs(share): Slice 8c replay — CHANGELOG, spec status, architecture note"
```

---

### Task 10: Coverage floor + full preflight + ship

**Files:** possibly `docs/structure-audit/coverage-baseline.json` (only if a new file needs an exclusion — prefer tests over exclusion).

- [ ] **Step 1: Run the changed-file unit suites together**

Run: `bun test packages/gateway/src/share/ packages/gateway/src/ipc/share-rpc.test.ts packages/cli/src/commands/share-replay-format.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the FULL integration suite (8b CI-red lesson)**

Run: `bun test packages/gateway/test/integration/`
Expected: PASS. (8b's only CI red was an integration test that hand-builds `tool_call_log`; 8c changes no DB SELECT/INSERT shape, but run the gate anyway — and if any change to a widely-read DB helper crept in, `grep -rln TABLE_V<n>_SCHEMA_SQL` for every test that hand-builds that table.)

- [ ] **Step 3: Static gates**

Run: `bunx tsc -p packages/gateway/tsconfig.json --noEmit`
Run: `bunx tsc -p packages/cli/tsconfig.json --noEmit`
Run: `bunx biome check packages scripts` (NOT `bun run lint` — it false-fails in `.claude/worktrees`; see memory)
Run: `bun run scripts/structure-audit/check-nimbus-invariants.ts`
Run: `bun test packages/gateway/src/security-invariants.test.ts`
Expected: 0 errors / exit 0 each. (I27/D21 unchanged — no new `share.publish` / `share.signing.privkey` / `createShare` references; the structure audit and invariant test must stay green untouched.)

- [ ] **Step 4: Docker-Linux coverage-floor (authoritative)**

Per memory ([[ship-readiness-before-first-push]] + the 8a coverage traps): the local unit `--coverage` run gives FALSE non-target violations because it omits the 26 `test:coverage:*` shards — ONLY the Docker full-run is authoritative. Start Docker Desktop, run the established Docker-Linux lcov build + `audit:coverage-floor` (oven/bun:latest, bun 1.3.x = CI). Every new file (`read-tool-registry.ts`, `recipe-runner.ts`) must clear ≥80% line+branch. The CLI `share.ts` IPC glue follows the 8a exclusion precedent (the pure `formatReplayReport` + `parseShareCreateArgs` stay tested; the `withIpc` glue is excluded). Expected: `coverage-floor: ok`.

- [ ] **Step 5: Duplication gate (EXACT CI command)**

Per memory: verify with the EXACT CI jscpd command (`--min-lines 10 --threshold 5`), NOT `bun run audit:duplication` (the strict 3% local target ≠ the CI gate). Expected: under 5%.

- [ ] **Step 6: Full preflight (run gates individually in-worktree)**

Per memory, `bun run preflight` / `test:ci` false-fail wholesale in `.claude/worktrees` due to the biome exclusion — run the gate set individually (typecheck all packages, `biome check packages scripts`, markdownlint on the new plan + amended spec, `audit:doc-refs`, `audit:cross-platform`, js-licenses, jscpd, lychee). Fix anything red BEFORE the first push.

- [ ] **Step 7: Whole-branch self-review**

Run `/code-review` over the branch diff; address findings (fix-not-suppress).

- [ ] **Step 8: Push + open PR**

```bash
git push -u origin worktree-phase6-slice8c-replay
gh pr create --title "feat(share): Phase 6 Slice 8c — replay (verify-share --replay, recipe-runner)" --body "<summary + spec §8 link + I27/no-migration/no-new-invariant note + read-only positive-allowlist note>"
```

Then watch CI green; address CodeRabbit / Sonar / coverage-floor as they report.

---

## Self-Review (completed during authoring)

- **Spec coverage:** §8.1 recipe-runner → Tasks 2–4; positive read-only allowlist (`read-tool-registry.ts`, "never absent-from-HITL") → Task 1 + the security tests in Tasks 1 & 4; the five step classifications (`match`/`diverged`/`missing-connector`/`skipped-non-read`/`error`) → Task 3; §8.2 `share verify --replay` (load recipe or transcript toolCalls, diff, divergence report + summary) → Tasks 5 (RPC) + 7 (CLI); transcript-toolCalls replay → `stepsFromShare` (Task 2). §11 testing: read-only-allowlist guarantee asserted with a write tool absent from `HITL_REQUIRED_BACKING` (Tasks 1 & 4); §12 out-of-scope honored (no LLM, no writes, no forwarding/inbox — that's 8d).
- **No migration / no new invariant:** confirmed — `CURRENT_SCHEMA_VERSION` stays 42; no `share.publish` / `share.signing.privkey` / `createShare` references added; Task 10 Step 3 re-runs the invariant test + structure audit to prove I27/D21 untouched.
- **Type consistency:** `ToolRunOutcome` / `ReplayReport` / `ReplayStepResult` / `RecipeRunnerDeps` defined in Task 2, consumed unchanged in 3/4/5; `replayRecipe(sourceSessionId, steps, deps)` (Task 3) and `replayShare(share, deps)` (Task 4) signatures stable into Task 5; `isReadOnlyToolId(toolId)` (Task 1) consumed in Task 4's security test + Task 5's RPC; `loadShareBytes`/`parseShareFile` (Task 5) consumed by the RPC handler; `ShareRpcCtx.listReplayTools` added in Task 5, supplied in Task 6; `formatReplayReport(report)` (Task 7) over a CLI-local `ReplayReportShape` mirroring the RPC return.
- **CLI surface deviation:** spec says `nimbus share verify --replay`; realized as `nimbus verify-share <file|url> --replay` (the shipped 8a verification entry point) to avoid a duplicate verify command — documented in the Global Constraints + Task 9 CHANGELOG.
