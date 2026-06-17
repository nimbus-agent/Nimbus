# Phase 6 Slice 8b — Recipe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `nimbus share <session> --as-recipe` — a deterministic, LLM-free declarative tool-call DAG reconstructed from the session's logged tool calls, redacted + signed through the existing I27 share-gate, with real per-step params now that tool-call inputs are durably logged.

**Architecture:** A new migration (V42) adds a redacted `params_json` column to `tool_call_log`, and the two tool-instrumentation write sites capture the call input. `share/recipe.ts` reconstructs an ordered step DAG (`called_at ASC`) with an advisory `dependsOn` value-matcher. The share-gate gains a `recipe` branch that redacts the recipe (same `redactForShare` pass), sets `body.kind="recipe"` + `body.recipe`, and omits `turns`/`toolCalls`. The recipe variant is emitted as deterministic YAML; `verify-share` accepts YAML or JSON (re-canonicalizing the body, so verification is format-independent). No new invariant — recipe sharing inherits I27 with zero new emit path.

**Tech Stack:** Bun + TypeScript 6 strict · `bun:sqlite` · `yaml@^2.9.0` (already in dep tree — no `bun add`) · `@noble/hashes/blake3` + `tweetnacl` (existing share-format) · Biome.

## Global Constraints

- **No `any`** — `unknown` for external/wire input; TypeScript strict mode. (Non-Negotiable #7)
- **No new emit path / no new invariant** — recipe sharing routes through the EXISTING `share/share-gate.ts` `createShare`; I27/D21 stay exactly as shipped in 8a. The `share.publish` HITL gate, the Vault-only `share.signing.privkey`, and the `createShare` call-site allow-list (`share-gate.ts` + `share-rpc.ts`) are unchanged. Do not name `share.publish` / `share.signing.privkey` / call `createShare` outside their D21-allowed sites.
- **Redaction is layered** — params are SECRET-redacted at write time (`redactAuditPayload`, the audit_log precedent) before hitting `tool_call_log.params_json`; the share-gate applies the FULL PII set + caller patterns on top at publish time. No raw secret ever lands in `params_json`.
- **Deterministic output** — `buildRecipeFromSession(db, sessionId)` returns byte-identical recipes for the same rows; YAML is stable-key-ordered (content-addressable).
- **Schema is forward-only** — V42 is `ALTER TABLE ... ADD COLUMN` (nullable, no default backfill); old rows read back `params: null`. (See `nimbus-db-migrations` skill.)
- **Spec amendment** — this wave amends `docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md`: the "8b adds no migration" rule is dropped (8b now owns V42), and 8d's `share_inbox` shifts from V42 → **V43**. Task 10 carries the doc edits.
- **Coverage** — every new/modified file clears the ≥80% line+branch true-coverage floor (Docker-Linux-authoritative; baseline at `docs/structure-audit/coverage-baseline.json`).
- **Tests** — run with `bun test <path>`; gateway unit tests live beside source as `*.test.ts`.

---

### Task 1: V42 migration — `tool_call_log.params_json`

**Files:**
- Create: `packages/gateway/src/index/tool-call-params-v42-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (register the step + import)
- Modify: `packages/gateway/src/index/local-index.ts:269` (`CURRENT_SCHEMA_VERSION` 41 → 42)
- Test: `packages/gateway/src/index/migrations/runner-v42.test.ts`

**Interfaces:**
- Produces: `TOOL_CALL_PARAMS_V42_SQL` (string) — the migration SQL; consumed by `runner.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/index/migrations/runner-v42.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "./runner.ts";

describe("V42 — tool_call_log.params_json", () => {
  test("adds nullable params_json column to tool_call_log", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cols = (db.query("PRAGMA table_info(tool_call_log)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("params_json");
  });

  test("old rows without params read back as NULL", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.run(
      `INSERT INTO tool_call_log (session_id, tool_id, service, called_at, duration_ms, result_envelope, status)
       VALUES ('s1', 'gmail_search', 'gmail', 1, 5, '{}', 'ok')`,
    );
    const row = db.query("SELECT params_json FROM tool_call_log WHERE tool_id = 'gmail_search'").get() as {
      params_json: string | null;
    };
    expect(row.params_json).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner-v42.test.ts`
Expected: FAIL — `params_json` not in column list (column does not exist yet).

- [ ] **Step 3: Create the migration SQL**

```ts
// packages/gateway/src/index/tool-call-params-v42-sql.ts
// V42 — tool_call_log.params_json (Phase 6 Slice 8b: Recipe).
// Stores the SECRET-redacted JSON of each tool call's input params so a session can be
// reconstructed as a declarative recipe DAG (share/recipe.ts) with real per-step params.
// Nullable + no backfill: rows logged before V42 read back NULL (params unknown). Secrets are
// stripped at write time via redactAuditPayload; the share-gate applies the full PII set on top.
export const TOOL_CALL_PARAMS_V42_SQL = `
ALTER TABLE tool_call_log ADD COLUMN params_json TEXT;
`;
```

- [ ] **Step 4: Register the step + bump the version**

In `packages/gateway/src/index/migrations/runner.ts`, add the import near the other SQL imports (e.g. beside `SHARE_RECORDS_V41_SQL`):

```ts
import { TOOL_CALL_PARAMS_V42_SQL } from "../tool-call-params-v42-sql.ts";
```

Add the step immediately after the V41 `simpleStep` (line ~401):

```ts
  simpleStep(41, 42, "tool_call_log.params_json (recipe params v42)", TOOL_CALL_PARAMS_V42_SQL),
```

In `packages/gateway/src/index/local-index.ts:269`:

```ts
export const CURRENT_SCHEMA_VERSION = 42;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/runner-v42.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full migration runner suite (no regression)**

Run: `bun test packages/gateway/src/index/migrations/`
Expected: PASS — existing runner tests still green at the new head version.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/tool-call-params-v42-sql.ts \
        packages/gateway/src/index/migrations/runner.ts \
        packages/gateway/src/index/migrations/runner-v42.test.ts \
        packages/gateway/src/index/local-index.ts
git commit -m "feat(share): V42 — tool_call_log.params_json column for recipe params"
```

---

### Task 2: Capture + read redacted params in `tool_call_log`

**Files:**
- Modify: `packages/gateway/src/db/tool-call-log.ts`
- Test: `packages/gateway/src/db/tool-call-log.test.ts`

**Interfaces:**
- Consumes: `redactAuditPayload` from `../audit/format-audit-payload.ts` (returns a redacted, length-bounded JSON string).
- Produces:
  - `ToolCallLogEntry.params?: unknown` (write-side input).
  - `ToolCallLogReadEntry.params: unknown` (read-side; `null` when absent).

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/db/tool-call-log.test.ts`:

```ts
test("persists params (secret-redacted) and reads them back", () => {
  const db = freshDb(); // existing helper in this file that runs migrations on :memory:
  writeToolCallLog(db, entry({ params: { query: "from:boss", token: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }));
  const { toolCalls } = readToolCallLog(db, {});
  const p = toolCalls[0]?.params as { query?: string; token?: string };
  expect(p.query).toBe("from:boss");
  expect(p.token).toBe("[REDACTED]"); // secret stripped at write time
});

test("params is null when not supplied", () => {
  const db = freshDb();
  writeToolCallLog(db, entry()); // entry() has no params
  const { toolCalls } = readToolCallLog(db, {});
  expect(toolCalls[0]?.params).toBeNull();
});
```

> Note: reuse this file's existing `entry()` factory and DB-setup helper. If the file builds its DB inline rather than via a `freshDb()` helper, mirror that exact setup instead — do not introduce a new helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/db/tool-call-log.test.ts`
Expected: FAIL — `params` is `undefined` (not stored/returned yet).

- [ ] **Step 3: Implement params capture + read**

In `packages/gateway/src/db/tool-call-log.ts`:

Add the import at the top:

```ts
import { redactAuditPayload } from "../audit/format-audit-payload.ts";
```

Extend the entry types:

```ts
export interface ToolCallLogEntry {
  sessionId: string | null;
  toolId: string;
  service: string;
  calledAt: number;
  durationMs: number;
  resultEnvelope: string;
  status: "ok" | "error";
  params?: unknown;
}

export interface ToolCallLogReadEntry extends ToolCallLogEntry {
  id: number;
  params: unknown;
}
```

Update `INSERT_SQL` to include the column:

```ts
const INSERT_SQL = `
INSERT INTO tool_call_log
  (session_id, tool_id, service, called_at, duration_ms, result_envelope, status, params_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`.trim();
```

In `writeToolCallLog`, compute the redacted params JSON and bind it. `params === undefined` ⇒ store `null`:

```ts
export function writeToolCallLog(db: Database, entry: ToolCallLogEntry): void {
  const envelope = truncateEnvelope(entry.resultEnvelope);
  const paramsJson = entry.params === undefined ? null : redactAuditPayload(entry.params);
  try {
    dbRun(db, INSERT_SQL, [
      entry.sessionId,
      entry.toolId,
      entry.service,
      entry.calledAt,
      entry.durationMs,
      envelope,
      entry.status,
      paramsJson,
    ]);
  } catch {
    // Best-effort. The two wiring sites are not allowed to throw because of
    // an audit-write failure — the user's tool call must still complete.
  }
}
```

In `readToolCallLog`, select the column, add it to the `Row` type, and parse it on the way out (malformed/NULL ⇒ `null`):

```ts
  const sql = `
SELECT id, session_id, tool_id, service, called_at, duration_ms, result_envelope, status, params_json
FROM tool_call_log
${whereClause}
ORDER BY called_at ASC, id ASC
LIMIT ?
`.trim();

  type Row = {
    id: number;
    session_id: string | null;
    tool_id: string;
    service: string;
    called_at: number;
    duration_ms: number;
    result_envelope: string;
    status: "ok" | "error";
    params_json: string | null;
  };
```

In the `.map` that builds `toolCalls`, add `params`:

```ts
  const toolCalls: ToolCallLogReadEntry[] = visible.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    toolId: r.tool_id,
    service: r.service,
    calledAt: r.called_at,
    durationMs: r.duration_ms,
    resultEnvelope: r.result_envelope,
    status: r.status,
    params: parseParamsJson(r.params_json),
  }));
```

Add the helper near `truncateEnvelope`:

```ts
function parseParamsJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/db/tool-call-log.test.ts`
Expected: PASS (all, including the 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/db/tool-call-log.ts packages/gateway/src/db/tool-call-log.test.ts
git commit -m "feat(share): capture secret-redacted tool-call params in tool_call_log"
```

---

### Task 3: Wire the instrumentation write sites + `collectSession` to carry params

**Files:**
- Modify: `packages/gateway/src/engine/agent.ts` (2 `writeToolCallLog` calls, ~line 50 + ~line 63)
- Modify: `packages/gateway/src/connectors/lazy-mesh/mesh.ts` (2 `writeToolCallLog` calls, ~line 470 + ~line 483)
- Modify: `packages/gateway/src/platform/assemble.ts` (~line 1665 — `collectSession` maps `params: null`)
- Test: `packages/gateway/src/db/tool-call-log.test.ts` already proves the read path; add a focused assemble-level check below.

**Interfaces:**
- Consumes: `ToolCallLogEntry.params` (Task 2).
- Produces: real per-step params reaching `share/recipe.ts` (Task 4) via `readToolCallLog`.

- [ ] **Step 1: Wire `engine/agent.ts`**

In both `writeToolCallLog({ ... })` calls inside `wrapToolForLlm` (the error branch ~line 50 and the success branch ~line 63), add `params: input,` to the object. Example (success branch):

```ts
        writeToolCallLog(auditDb, {
          sessionId,
          toolId: tool,
          service,
          calledAt,
          durationMs: Date.now() - calledAt,
          resultEnvelope: envelope,
          status,
          params: input,
        });
```

Apply the identical `params: input,` addition to the error-branch call above it.

- [ ] **Step 2: Wire `connectors/lazy-mesh/mesh.ts`**

In both `writeToolCallLog({ ... })` calls inside the `merged[key].execute` wrapper (error branch ~line 470, success branch ~line 483), add `params: input,`:

```ts
            writeToolCallLog(auditDb, {
              sessionId,
              toolId: key,
              service,
              calledAt,
              durationMs: Date.now() - calledAt,
              resultEnvelope: envelope,
              status,
              params: input,
            });
```

- [ ] **Step 3: Update `assemble.ts` `collectSession` to surface stored params**

In `packages/gateway/src/platform/assemble.ts` (~line 1665), change the `toolCalls` map from `params: null` to the stored params, and update the stale comment:

```ts
      // collectSession pre-resolves turns from the session-memory store + tool calls (with their
      // SECRET-redacted input params, V42) from tool_call_log. The share-gate applies the full PII
      // redaction set on top before any share leaves the machine.
      const toolCalls = readToolCallLog(db, { sessionId, limit: 1000 }).toolCalls.map((tc) => ({
        toolId: tc.toolId,
        service: tc.service,
        params: tc.params,
        status: tc.status,
      }));
```

- [ ] **Step 4: Add the assemble-path round-trip test**

Append to `packages/gateway/src/db/tool-call-log.test.ts` (proves the exact shape `collectSession` consumes — write with params, read with a session filter, params survive):

```ts
test("params survive a session-scoped read (collectSession shape)", () => {
  const db = freshDb();
  writeToolCallLog(db, entry({ sessionId: "sess-A", params: { channel: "#eng", limit: 10 } }));
  const { toolCalls } = readToolCallLog(db, { sessionId: "sess-A", limit: 1000 });
  expect(toolCalls).toHaveLength(1);
  expect((toolCalls[0]?.params as { channel?: string }).channel).toBe("#eng");
});
```

- [ ] **Step 5: Run the test + typecheck the wired files**

Run: `bun test packages/gateway/src/db/tool-call-log.test.ts`
Expected: PASS.
Run: `bunx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: 0 errors (the `params: input` additions and the `collectSession` change typecheck).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/engine/agent.ts \
        packages/gateway/src/connectors/lazy-mesh/mesh.ts \
        packages/gateway/src/platform/assemble.ts \
        packages/gateway/src/db/tool-call-log.test.ts
git commit -m "feat(share): log tool-call params at the instrumentation sites + surface in collectSession"
```

---

### Task 4: `share/recipe.ts` — recipe types + `buildRecipeFromSession` (ordered steps)

**Files:**
- Create: `packages/gateway/src/share/recipe.ts`
- Test: `packages/gateway/src/share/recipe.test.ts`

**Interfaces:**
- Consumes: `readToolCallLog` from `../db/tool-call-log.ts` (returns ordered `toolCalls` with `toolId`, `service`, `status`, `params`, `resultEnvelope`).
- Produces:
  - `interface RecipeStep { readonly stepId: string; readonly tool: string; readonly service: string; readonly params: unknown; readonly status: string; readonly dependsOn: readonly string[]; }`
  - `interface Recipe { readonly recipeVersion: 1; readonly sourceSessionId: string; readonly generatedAt: number; readonly steps: readonly RecipeStep[]; readonly graphTraversals: readonly unknown[]; }`
  - `function buildRecipeFromSession(db: Database, sessionId: string, now: () => number): Recipe`

> Design note for the reviewer: `graphTraversals` is part of the spec §7.1 shape but has no deterministic source today (Nimbus does not track per-call graph traversals), so it is emitted as `[]` and documented as a future enrichment. The ordered `steps` list is the authoritative contract (spec §7.1).

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/share/recipe.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "../index/migrations/runner.ts";
import { writeToolCallLog } from "../db/tool-call-log.ts";
import { buildRecipeFromSession } from "./recipe.ts";

function db(): Database {
  const d = new Database(":memory:");
  runMigrations(d);
  return d;
}

describe("buildRecipeFromSession — ordered steps", () => {
  test("steps follow called_at ascending and carry tool/service/params/status", () => {
    const d = db();
    writeToolCallLog(d, {
      sessionId: "s1", toolId: "slack_search", service: "slack", calledAt: 200,
      durationMs: 1, resultEnvelope: "{}", status: "ok", params: { q: "incident" },
    });
    writeToolCallLog(d, {
      sessionId: "s1", toolId: "gmail_list", service: "gmail", calledAt: 100,
      durationMs: 1, resultEnvelope: "{}", status: "ok", params: { label: "INBOX" },
    });
    const recipe = buildRecipeFromSession(d, "s1", () => 999);
    expect(recipe.recipeVersion).toBe(1);
    expect(recipe.sourceSessionId).toBe("s1");
    expect(recipe.generatedAt).toBe(999);
    expect(recipe.steps.map((s) => s.tool)).toEqual(["gmail_list", "slack_search"]); // 100 before 200
    expect(recipe.steps[0]?.service).toBe("gmail");
    expect((recipe.steps[0]?.params as { label?: string }).label).toBe("INBOX");
    expect(recipe.steps[0]?.status).toBe("ok");
    expect(recipe.steps[0]?.stepId).toBe("step-1");
    expect(recipe.steps[1]?.stepId).toBe("step-2");
    expect(recipe.graphTraversals).toEqual([]);
  });

  test("deterministic — identical rows produce identical recipes", () => {
    const seed = (d: Database) => {
      writeToolCallLog(d, { sessionId: "s1", toolId: "a_list", service: "a", calledAt: 1, durationMs: 1, resultEnvelope: "{}", status: "ok", params: { x: 1 } });
      writeToolCallLog(d, { sessionId: "s1", toolId: "b_get", service: "b", calledAt: 2, durationMs: 1, resultEnvelope: "{}", status: "ok", params: { y: 2 } });
    };
    const d1 = db(); seed(d1);
    const d2 = db(); seed(d2);
    expect(JSON.stringify(buildRecipeFromSession(d1, "s1", () => 5))).toBe(
      JSON.stringify(buildRecipeFromSession(d2, "s1", () => 5)),
    );
  });

  test("empty session → empty steps", () => {
    expect(buildRecipeFromSession(db(), "nope", () => 1).steps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/recipe.test.ts`
Expected: FAIL — `Cannot find module './recipe.ts'`.

- [ ] **Step 3: Implement `recipe.ts` (ordered steps; `dependsOn` empty for now)**

```ts
// packages/gateway/src/share/recipe.ts
import type { Database } from "bun:sqlite";
import { readToolCallLog } from "../db/tool-call-log.ts";

/**
 * A declarative, LLM-free recipe reconstructed from a session's logged tool calls.
 * The ordered `steps` list (execution order, `called_at` ascending) is the authoritative
 * contract. `dependsOn` is an ADVISORY enrichment (Task 5) — Nimbus does not track parameter
 * lineage, so edges are inferred by a conservative value-matcher and may be incomplete; replay
 * (Slice 8c) executes steps in recorded order and never relies on `dependsOn`.
 */
export interface RecipeStep {
  readonly stepId: string;
  readonly tool: string;
  readonly service: string;
  readonly params: unknown;
  readonly status: string;
  readonly dependsOn: readonly string[];
}

export interface Recipe {
  readonly recipeVersion: 1;
  readonly sourceSessionId: string;
  readonly generatedAt: number;
  readonly steps: readonly RecipeStep[];
  /** Reserved (spec §7.1). No deterministic source today → always `[]`. */
  readonly graphTraversals: readonly unknown[];
}

export function buildRecipeFromSession(db: Database, sessionId: string, now: () => number): Recipe {
  const { toolCalls } = readToolCallLog(db, { sessionId, limit: 1000 });
  const steps: RecipeStep[] = toolCalls.map((tc, i) => ({
    stepId: `step-${i + 1}`,
    tool: tc.toolId,
    service: tc.service,
    params: tc.params ?? {},
    status: tc.status,
    dependsOn: [],
  }));
  return {
    recipeVersion: 1,
    sourceSessionId: sessionId,
    generatedAt: now(),
    steps,
    graphTraversals: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/recipe.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/recipe.ts packages/gateway/src/share/recipe.test.ts
git commit -m "feat(share): recipe.ts — deterministic ordered tool-call DAG from a session"
```

---

### Task 5: `share/recipe.ts` — advisory `dependsOn` value-matcher

**Files:**
- Modify: `packages/gateway/src/share/recipe.ts`
- Test: `packages/gateway/src/share/recipe.test.ts`

**Interfaces:**
- Produces: populated `RecipeStep.dependsOn` — `B.dependsOn` includes `A.stepId` when a non-trivial identifier-shaped leaf value in B's `params` also appears in A's `resultEnvelope`. (Same signatures as Task 4 — no type changes.)

Matcher rules (spec §7.1, copied verbatim into the implementation):
- An edge B → A is inferred only when a **non-trivial** value in B's redacted params also appears in A's `result_envelope`.
- "Non-trivial" excludes booleans, numbers, strings shorter than 4 chars, and `true`/`false`/`null`/`""`.
- Only **identifier-shaped** values qualify: strings that look like entity IDs, file paths, URLs/URNs, or strings ≥ 8 chars with mixed alphanumerics. The matcher walks nested structures but matches on **leaf scalars**, not whole subtrees.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/share/recipe.test.ts`:

```ts
describe("buildRecipeFromSession — advisory dependsOn", () => {
  function chain(d: Database, aResult: string, bParams: unknown): void {
    writeToolCallLog(d, { sessionId: "s1", toolId: "a_get", service: "a", calledAt: 1, durationMs: 1, resultEnvelope: aResult, status: "ok", params: {} });
    writeToolCallLog(d, { sessionId: "s1", toolId: "b_get", service: "b", calledAt: 2, durationMs: 1, resultEnvelope: "{}", status: "ok", params: bParams });
  }

  test("identifier value in B.params found in A.result → edge B→A", () => {
    const d = db();
    chain(d, JSON.stringify({ id: "issue-9f2a8c71" }), { ref: "issue-9f2a8c71" });
    const recipe = buildRecipeFromSession(d, "s1", () => 1);
    expect(recipe.steps[1]?.dependsOn).toEqual(["step-1"]);
  });

  test("trivial scalar collisions create NO edge", () => {
    const d = db();
    chain(d, JSON.stringify({ ok: true, count: 10, tag: "ab" }), { ok: true, count: 10, tag: "ab" });
    expect(buildRecipeFromSession(d, "s1", () => 1).steps[1]?.dependsOn).toEqual([]);
  });

  test("nested leaf identifier matches; whole-subtree does not", () => {
    const d = db();
    chain(d, JSON.stringify({ items: [{ key: "abcd1234efgh" }] }), { filter: { nested: { key: "abcd1234efgh" } } });
    expect(buildRecipeFromSession(d, "s1", () => 1).steps[1]?.dependsOn).toEqual(["step-1"]);
  });

  test("no false edge when values differ", () => {
    const d = db();
    chain(d, JSON.stringify({ id: "issue-aaaaaaaa" }), { ref: "issue-bbbbbbbb" });
    expect(buildRecipeFromSession(d, "s1", () => 1).steps[1]?.dependsOn).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/recipe.test.ts`
Expected: FAIL — `dependsOn` is `[]` for the identifier cases (matcher not implemented).

- [ ] **Step 3: Implement the matcher**

In `packages/gateway/src/share/recipe.ts`, add the helpers and use them in `buildRecipeFromSession`:

```ts
const LOW_ENTROPY = new Set(["true", "false", "null", ""]);

/** Identifier-shaped scalar test (spec §7.1): entity IDs / paths / URLs/URNs / mixed-alnum ≥ 8. */
function isIdentifierValue(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.length < 4 || LOW_ENTROPY.has(v)) return false;
  if (/[/\\]/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^urn:/i.test(v)) return true; // path / URL / URN
  if (/^[A-Za-z]+[-_][A-Za-z0-9]{4,}$/.test(v)) return true; // prefixed entity id, e.g. issue-9f2a8c71
  return v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v); // mixed alphanumeric ≥ 8
}

/** Collect identifier-shaped leaf scalars from an arbitrary value tree. */
function collectIdentifierLeaves(value: unknown, out: Set<string>): void {
  if (isIdentifierValue(value)) {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectIdentifierLeaves(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectIdentifierLeaves(v, out);
  }
}
```

Then change the body of `buildRecipeFromSession` so each step computes `dependsOn` against earlier steps' result envelopes:

```ts
export function buildRecipeFromSession(db: Database, sessionId: string, now: () => number): Recipe {
  const { toolCalls } = readToolCallLog(db, { sessionId, limit: 1000 });
  // For each prior step, the identifier set produced by its (string) result envelope.
  const priorResults: Array<{ stepId: string; envelope: string }> = [];
  const steps: RecipeStep[] = toolCalls.map((tc, i) => {
    const stepId = `step-${i + 1}`;
    const params = tc.params ?? {};
    const ids = new Set<string>();
    collectIdentifierLeaves(params, ids);
    const dependsOn: string[] = [];
    for (const prior of priorResults) {
      if ([...ids].some((id) => prior.envelope.includes(id))) dependsOn.push(prior.stepId);
    }
    priorResults.push({ stepId, envelope: tc.resultEnvelope });
    return { stepId, tool: tc.toolId, service: tc.service, params, status: tc.status, dependsOn };
  });
  return { recipeVersion: 1, sourceSessionId: sessionId, generatedAt: now(), steps, graphTraversals: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/recipe.test.ts`
Expected: PASS (all 7 tests — Task 4 + Task 5).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/recipe.ts packages/gateway/src/share/recipe.test.ts
git commit -m "feat(share): advisory dependsOn value-matcher for the recipe DAG"
```

---

### Task 6: `share/recipe-yaml.ts` — deterministic YAML serializer

**Files:**
- Create: `packages/gateway/src/share/recipe-yaml.ts`
- Test: `packages/gateway/src/share/recipe-yaml.test.ts`

**Interfaces:**
- Consumes: `ShareFile` from `./share-format.ts`; `yaml` package (`stringify`).
- Produces:
  - `function serializeShareFileToYaml(share: ShareFile): string` — deterministic (stable-key-ordered) YAML of the full signed envelope. Used for the `.nimbus-recipe.yaml` file emit.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/share/recipe-yaml.test.ts
import { describe, expect, test } from "bun:test";
import { parse as yamlParse } from "yaml";
import type { ShareFile } from "./share-format.ts";
import { serializeShareFileToYaml } from "./recipe-yaml.ts";

const share: ShareFile = {
  format: "nimbus-share/v1",
  contentHash: "deadbeef",
  body: {
    kind: "recipe",
    sessionId: "s1",
    createdAt: 1,
    expiresAt: null,
    redactionSet: ["secrets"],
    origin: { label: "host", pubkey: "PUB" },
    recipe: { recipeVersion: 1, sourceSessionId: "s1", generatedAt: 1, steps: [], graphTraversals: [] },
  },
  sig: { alg: "ed25519", pubkey: "PUB", signature: "SIG" },
  forwarding: { hops: 0, chain: [] },
};

describe("serializeShareFileToYaml", () => {
  test("round-trips to the same object", () => {
    expect(yamlParse(serializeShareFileToYaml(share))).toEqual(share);
  });

  test("deterministic — stable key order regardless of input key order", () => {
    const reordered = { forwarding: share.forwarding, sig: share.sig, body: share.body, contentHash: share.contentHash, format: share.format } as ShareFile;
    expect(serializeShareFileToYaml(reordered)).toBe(serializeShareFileToYaml(share));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/recipe-yaml.test.ts`
Expected: FAIL — `Cannot find module './recipe-yaml.ts'`.

- [ ] **Step 3: Implement the serializer**

```ts
// packages/gateway/src/share/recipe-yaml.ts
import { stringify } from "yaml";
import type { ShareFile } from "./share-format.ts";

/**
 * Deterministic YAML rendering of a signed share envelope (the `.nimbus-recipe.yaml` variant,
 * spec §5/§7.1). `sortMapEntries: true` gives stable key order so the YAML bytes are
 * content-addressable. Verification does NOT depend on YAML byte-order: verify-share re-canonicalizes
 * the parsed `body` to JSON before hashing/verifying (see verify-share.ts), so this is purely the
 * on-disk/human-readable form.
 */
export function serializeShareFileToYaml(share: ShareFile): string {
  return stringify(share, { sortMapEntries: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/recipe-yaml.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/recipe-yaml.ts packages/gateway/src/share/recipe-yaml.test.ts
git commit -m "feat(share): deterministic YAML serializer for the recipe share variant"
```

---

### Task 7: `verify-share` accepts YAML or JSON

**Files:**
- Modify: `packages/gateway/src/share/verify-share.ts`
- Test: `packages/gateway/src/share/verify-share.test.ts`

**Interfaces:**
- Consumes: `serializeShareFileToYaml` (Task 6) in the test; `parse` from `yaml` in the impl.
- Produces: `verifyShareFromBytes` / `verifyShareFromInput` transparently handle a YAML-serialized share — the parsed `body` is re-canonicalized to JSON bytes and handed to the existing `verifyShareBytes`, so a genuine YAML recipe verifies and a tampered one fails. `verifyShareBytes` in `share-format.ts` stays JSON-only (the dependency-light CI primitive — spec §6.4).

> Read `verify-share.ts` first. The exact insertion point is wherever it currently decodes bytes → calls `verifyShareBytes`. Insert a "if it is not JSON, YAML-parse and re-encode as canonical JSON bytes" shim BEFORE that call. Do not change `verifyShareBytes`.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/share/verify-share.test.ts` (reuse the file's existing helper that builds a signed share via `buildShareFile` + a generated keypair; mirror its setup):

```ts
test("verifies a YAML-serialized recipe share", () => {
  const share = signedRecipeShare(); // build via buildShareFile over a recipe body (mirror existing helper)
  const yamlBytes = new TextEncoder().encode(serializeShareFileToYaml(share));
  const result = verifyShareFromBytes(yamlBytes, { now: share.body.createdAt + 1 });
  expect(result.ok).toBe(true);
  expect(result.signatureValid).toBe(true);
});

test("a tampered YAML share fails verification", () => {
  const share = signedRecipeShare();
  const tampered = serializeShareFileToYaml(share).replace(share.body.sessionId, "evil-session");
  const result = verifyShareFromBytes(new TextEncoder().encode(tampered), { now: share.body.createdAt + 1 });
  expect(result.ok).toBe(false);
});
```

Add the imports the test needs:

```ts
import { serializeShareFileToYaml } from "./recipe-yaml.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/verify-share.test.ts`
Expected: FAIL — YAML bytes are not valid JSON, so `verifyShareBytes` reports `malformed json` (`ok: false`) for the genuine case.

- [ ] **Step 3: Implement the YAML shim**

In `packages/gateway/src/share/verify-share.ts`, add the import:

```ts
import { parse as yamlParse } from "yaml";
```

Add a normalizer that turns share bytes into canonical JSON bytes (JSON passthrough; YAML → JSON), and call it before `verifyShareBytes` in the bytes path:

```ts
/**
 * Accept either a JSON (`.nimbus-share.json`) or YAML (`.nimbus-recipe.yaml`) share. Parse to an
 * object and re-encode as JSON bytes so the single JSON-only `verifyShareBytes` primitive can hash
 * + verify. Verification re-canonicalizes the body, so the input serialization never affects the
 * result. Returns the original bytes unchanged when they are already JSON.
 */
function toJsonShareBytes(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  try {
    JSON.parse(text);
    return bytes; // already JSON
  } catch {
    // fall through to YAML
  }
  try {
    const obj = yamlParse(text) as unknown;
    return new TextEncoder().encode(JSON.stringify(obj));
  } catch {
    return bytes; // neither JSON nor YAML → let verifyShareBytes report "malformed json"
  }
}
```

In `verifyShareFromBytes`, normalize first:

```ts
export function verifyShareFromBytes(bytes: Uint8Array, opts?: { now?: number }): VerifyResult {
  return verifyShareBytes(toJsonShareBytes(bytes), opts);
}
```

> If `verifyShareFromBytes`/`verifyShareFromInput` already wrap `verifyShareBytes` differently, thread `toJsonShareBytes` at the single point where raw share bytes are about to be verified — both the file/url-fetched (`verifyShareFromInput`) and the direct-bytes path must route through it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/verify-share.test.ts`
Expected: PASS (all, including the 2 new YAML tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/share/verify-share.ts packages/gateway/src/share/verify-share.test.ts
git commit -m "feat(share): verify-share accepts the YAML recipe variant (re-canonicalized to JSON)"
```

---

### Task 8: `share-gate.ts` — recipe branch

**Files:**
- Modify: `packages/gateway/src/share/share-gate.ts`
- Test: `packages/gateway/src/share/share-gate.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks at the gate (the recipe is built by the caller and handed in).
- Produces: `CreateShareDeps.buildRecipe: (sessionId: string) => unknown` — a new REQUIRED dep. When `req.kind === "recipe"`, the gate builds → redacts the recipe (same `redactForShare`), previews + HITL-gates it, and emits `body.recipe` with `turns`/`toolCalls` OMITTED. Transcript path unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/share/share-gate.test.ts` (reuse the file's existing `deps`/stub factory — add a `buildRecipe` to it):

```ts
test("recipe kind: redacts the recipe, sets body.recipe, omits turns/toolCalls", async () => {
  const recipe = { recipeVersion: 1, sourceSessionId: "s1", generatedAt: 1, graphTraversals: [],
    steps: [{ stepId: "step-1", tool: "gmail_search", service: "gmail", status: "ok", dependsOn: [],
              params: { q: "from:ceo@corp.com" } }] };
  let previewed: unknown;
  const result = await createShare(
    { sessionId: "s1", kind: "recipe", sink: { type: "file" } },
    makeDeps({
      buildRecipe: () => recipe,
      requestApproval: async (preview) => { previewed = preview; return true; },
    }),
  );
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("unreachable");
  expect(result.share.body.kind).toBe("recipe");
  expect(result.share.body.turns).toBeUndefined();
  expect(result.share.body.toolCalls).toBeUndefined();
  // recipe present + email PII redacted both in the preview and the signed body
  const body = result.share.body.recipe as { steps: { params: { q: string } }[] };
  expect(body.steps[0]?.params.q).toBe("[REDACTED]");
  expect(JSON.stringify(previewed)).toContain("[REDACTED]");
  expect(result.share.body.redactionSet).toContain("emails");
});

test("recipe kind: a rejected approval emits nothing", async () => {
  const result = await createShare(
    { sessionId: "s1", kind: "recipe", sink: { type: "file" } },
    makeDeps({ buildRecipe: () => ({ recipeVersion: 1, sourceSessionId: "s1", generatedAt: 1, steps: [], graphTraversals: [] }), requestApproval: async () => false }),
  );
  expect(result.status).toBe("rejected");
});
```

> `makeDeps` here stands for this file's existing deps factory. Add a default `buildRecipe: () => ({})` to it so the existing transcript tests keep compiling, and let each test override it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/share/share-gate.test.ts`
Expected: FAIL — `body.recipe` is undefined / `toolCalls` is `[]` not omitted (recipe branch absent).

- [ ] **Step 3: Implement the recipe branch**

In `packages/gateway/src/share/share-gate.ts`:

Add `buildRecipe` to `CreateShareDeps`:

```ts
export interface CreateShareDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly label: string;
  readonly now: () => number;
  readonly collectSession: (sessionId: string) => SessionContent;
  /** Builds the declarative recipe DAG for `--as-recipe` (kind="recipe"). Redacted at the gate. */
  readonly buildRecipe: (sessionId: string) => unknown;
  readonly requestApproval: (preview: unknown, redactionSet: readonly string[]) => Promise<boolean>;
  readonly recordAudit: (e: {
    actionType: string;
    hitlStatus: string;
    actionJson: string;
    timestamp: number;
    sessionId?: string;
  }) => void;
}
```

Replace the collect+redact+body assembly in `createShare`. The HITL approval, audit, sign, and persist steps stay exactly as they are — only the redaction input and the body extras branch on `kind`:

```ts
  const now = deps.now();

  let previewPayload: unknown;
  let applied: readonly string[];
  let bodyExtras: Pick<ShareBody, "turns" | "toolCalls" | "recipe">;
  if (req.kind === "recipe") {
    const recipe = deps.buildRecipe(req.sessionId);
    const red = redactForShare(recipe, req.callerPatterns ?? []);
    previewPayload = red.redacted;
    applied = red.applied;
    bodyExtras = { recipe: red.redacted }; // turns + toolCalls omitted entirely
  } else {
    const content = deps.collectSession(req.sessionId);
    const red = redactForShare(
      { turns: content.turns, toolCalls: content.toolCalls },
      req.callerPatterns ?? [],
    );
    previewPayload = red.redacted;
    applied = red.applied;
    const r = red.redacted as { turns?: readonly ShareTurn[]; toolCalls?: readonly ShareToolCall[] };
    bodyExtras = { turns: r.turns ?? [], toolCalls: r.toolCalls ?? [] };
  }

  const approved = await deps.requestApproval(previewPayload, applied);
  if (!approved) {
    deps.recordAudit({
      actionType: "share.publish",
      hitlStatus: "rejected",
      actionJson: JSON.stringify({
        sessionId: req.sessionId,
        kind: req.kind,
        redactionSet: applied,
        sink: req.sink.type,
      }),
      timestamp: now,
      sessionId: req.sessionId,
    });
    return { status: "rejected" };
  }

  const kp = await ensureShareKeypair(deps.vault);
  const body: ShareBody = {
    kind: req.kind,
    sessionId: req.sessionId,
    createdAt: now,
    expiresAt: req.expiresAt ?? null,
    redactionSet: applied,
    origin: { label: deps.label, pubkey: kp.pubkeyB64 },
    ...bodyExtras,
  };
  const share = buildShareFile(body, kp.privkeyB64, kp.pubkeyB64);
```

The remaining `insertShareRecord` + `recordAudit("approved")` + `return { status: "ok", share }` block is unchanged.

> Remove the now-unused top-of-function `const content = deps.collectSession(...)` / old `redactForShare` lines that this block replaces, so `collectSession` is only called on the transcript branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/share/share-gate.test.ts`
Expected: PASS (all — existing transcript tests + the 2 new recipe tests).

- [ ] **Step 5: Confirm the static D21 audit + I27 test still pass**

Run: `bun test packages/gateway/src/security-invariants.test.ts`
Run: `bun run scripts/structure-audit/check-nimbus-invariants.ts`
Expected: PASS / exit 0 — `share.publish`, `share.signing.privkey`, and the `createShare` call-site allow-list are unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/share/share-gate.ts packages/gateway/src/share/share-gate.test.ts
git commit -m "feat(share): share-gate recipe branch — redact + sign body.recipe, omit transcript"
```

---

### Task 9: RPC + assemble wiring — build the recipe, emit the YAML variant

**Files:**
- Modify: `packages/gateway/src/ipc/share-rpc.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (the `createShare(...)` deps in `share.create` route through `share-rpc.ts`, so the `buildRecipe` dep is added in `share-rpc.ts`; assemble only changed if `collectSession` wasn't already updated in Task 3 — it was)
- Test: `packages/gateway/src/ipc/share-rpc.test.ts`

**Interfaces:**
- Consumes: `buildRecipeFromSession` (Task 4/5), `serializeShareFileToYaml` (Task 6).
- Produces: `share.create` with `kind:"recipe"` builds the recipe from `ctx.db` and emits the file sink as deterministic YAML when the target path ends in `.yaml`/`.yml` (default for recipe). JSON otherwise — verify-share handles both.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/ipc/share-rpc.test.ts` (reuse the file's existing ctx factory; it already seeds a db + an approving `requestApproval`). Seed a tool call so the recipe is non-empty:

```ts
test("share.create kind=recipe builds body.recipe from tool_call_log and persists it", async () => {
  const ctx = makeCtx(); // existing helper: db w/ migrations, label, now, approving requestApproval
  writeToolCallLog(ctx.db, { sessionId: "s1", toolId: "gmail_search", service: "gmail", calledAt: 1, durationMs: 1, resultEnvelope: "{}", status: "ok", params: { q: "hi" } });
  const res = (await dispatchShareRpc("share.create", { sessionId: "s1", kind: "recipe", sink: { type: "file" } }, ctx)) as { result: { status: string; contentHash: string } };
  expect(res.result.status).toBe("ok");
  const stored = getShareRecord(ctx.db, res.result.contentHash);
  const body = JSON.parse(stored!.bodyJson) as { kind: string; recipe?: { steps: unknown[] }; turns?: unknown };
  expect(body.kind).toBe("recipe");
  expect(body.recipe?.steps).toHaveLength(1);
  expect(body.turns).toBeUndefined();
});
```

Add imports the test needs (`writeToolCallLog`, `getShareRecord`) mirroring the file's existing import style.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/share-rpc.test.ts`
Expected: FAIL — `createShare` is called without a `buildRecipe` dep (compile error or `body.recipe` empty).

- [ ] **Step 3: Wire `buildRecipe` into the gate call + YAML file emit**

In `packages/gateway/src/ipc/share-rpc.ts`, add the imports:

```ts
import { buildRecipeFromSession } from "../share/recipe.ts";
import { serializeShareFileToYaml } from "../share/recipe-yaml.ts";
```

In the `share.create` handler, pass `buildRecipe` into the `createShare` deps:

```ts
    const result = await createShare(req, {
      db: ctx.db,
      vault: ctx.vault,
      label: ctx.label,
      now: ctx.now,
      collectSession: () => content,
      buildRecipe: (sessionId) => buildRecipeFromSession(ctx.db, sessionId, ctx.now),
      requestApproval: (preview, redactionSet) =>
        ctx.requestApproval(sessionId, kind, sink.type, preview, redactionSet),
      recordAudit: ctx.recordAudit,
    });
```

Replace the file-sink emit so a recipe (or a `.yaml`/`.yml` target) is written as YAML:

```ts
    if (sink.type === "file") {
      if (filePath !== undefined) {
        const wantsYaml = kind === "recipe" || /\.ya?ml$/i.test(filePath);
        const out = wantsYaml ? serializeShareFileToYaml(result.share) : json;
        await emitFile(filePath, out);
      }
    } else if (sink.type === "http") {
      await emitHttp(ctx, json);
    }
```

> `json` (the JSON string) is still what the HTTP sink POSTs and what the persisted `body_json` holds — only the on-disk file for recipes switches to YAML.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/share-rpc.test.ts`
Expected: PASS (all, including the new recipe test).

- [ ] **Step 5: Typecheck the gateway**

Run: `bunx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: 0 errors. (Note: `assemble.ts`'s `createShare` is reached only through `share-rpc.ts`, which now supplies `buildRecipe`; if any other `createShare` deps literal exists it will fail typecheck here — there should be none per D21.)

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/share-rpc.ts packages/gateway/src/ipc/share-rpc.test.ts
git commit -m "feat(share): wire recipe build + YAML emit into share.create"
```

---

### Task 10: Spec amendment + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/architecture.md` (schema reference — add V42 row; bump "schema V<N>" prose if present)

**Interfaces:** none (docs only).

- [ ] **Step 1: Amend the spec**

In `docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md`:

- §7.1, the YAML paragraph: replace the "check whether a `yaml` package is already in the dep tree; if not, add it" sentence with a note that `yaml@^2.9.0` is already a dependency and that **8b adds migration V42 (`tool_call_log.params_json`)** so recipe steps carry real, secret-redacted params (the input-args-not-stored limitation is resolved).
- §10 schema summary table: add a row `| V42 | 8b | tool_call_log.params_json (recipe step params) |` and change the existing `share_inbox` row from `V42` to **`V43`** (wave 8d). Update the parenthetical "(8b and 8c add no migrations …)" to "(8c adds no migration; 8b adds V42 for recipe params; 8d adds V43.)".
- §9.4 and §13 (wave→PR→plan map): change `share_inbox` / 8d's migration reference from V42 → **V43**.

- [ ] **Step 2: Add the CHANGELOG entry**

Add under the current unreleased / dated section of `docs/CHANGELOG.md` (mirror the 2026-06-15 8a entry's style):

```markdown
- **Share & Virality — Slice 8b (recipes):** `nimbus share <session> --as-recipe` now produces a
  deterministic, LLM-free declarative tool-call DAG (`share/recipe.ts`) reconstructed from the
  session's logged tool calls, redacted + signed through the existing I27 share-gate (no new
  invariant). Migration **V42** adds `tool_call_log.params_json` (secret-redacted) so recipe steps
  carry real params; an advisory `dependsOn` value-matcher links steps by identifier-shaped values.
  The recipe variant serializes to deterministic YAML (`.nimbus-recipe.yaml`); `verify-share` accepts
  either YAML or JSON.
```

- [ ] **Step 3: Update the schema reference in architecture.md**

Find the schema/migration table in `docs/architecture.md` and add a `V42 — tool_call_log.params_json (recipe step params)` row after V41. If a "current schema version" number is stated in prose, bump it to **42**.

- [ ] **Step 4: Run the doc-reference audit**

Run: `bun run audit:doc-refs`
Expected: PASS (no broken links / stale repo-rooted paths introduced).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-15-slice8-share-virality-design.md docs/CHANGELOG.md docs/architecture.md
git commit -m "docs(share): amend Slice 8 spec for V42 recipe params; CHANGELOG + schema ref"
```

---

### Task 11: E2E — recipe share round-trip

**Files:**
- Modify: `packages/gateway/test/e2e/share-e2e.test.ts` (add a recipe case alongside the 8a transcript case)

**Interfaces:** Consumes the real-gateway raw-IPC harness already established by 8a (`NIMBUS_E2E_SEED_SESSION_JSON` seam + the create→approve→verify flow).

- [ ] **Step 1: Read the existing 8a e2e to reuse its harness**

Read `packages/gateway/test/e2e/share-e2e.test.ts`. Identify how it (a) seeds a session, (b) drives `share.create` + the approval round-trip via `share.approvalRespond`, and (c) calls `share.verify`. The recipe case reuses all three.

- [ ] **Step 2: Write the recipe e2e case**

Add a test that: seeds a session that yields at least one tool call (extend the `NIMBUS_E2E_SEED_SESSION_JSON` seed to include a `tool_call_log` row with params, OR seed via the existing seam if it already supports tool calls — match whatever the 8a seed seam exposes), runs `share.create` with `{ kind: "recipe", sink: { type: "file" }, ... }`, approves it, then `share.verify`s the resulting artifact and asserts:

```ts
// shape assertions (adapt to the harness's helpers)
expect(createResult.status).toBe("ok");
const verify = await rpc("share.verify", { input: recipeFilePath });
expect(verify.ok).toBe(true);
const got = await rpc("share.get", { contentHash: createResult.contentHash });
const body = JSON.parse(got.share.bodyJson);
expect(body.kind).toBe("recipe");
expect(body.recipe.steps.length).toBeGreaterThan(0);
expect(body.turns).toBeUndefined();
```

> If the 8a seed seam (`NIMBUS_E2E_SEED_SESSION_JSON`) only seeds `session_memory` (turns) and not `tool_call_log`, extend the seam in the gateway runner to also accept seeded tool calls (mirror the existing vec_rowid-0 sentinel pattern noted in the 8a memory), so the recipe has at least one step. Keep the seam test-only.

- [ ] **Step 3: Run the e2e**

Run: `bun test packages/gateway/test/e2e/share-e2e.test.ts`
Expected: PASS (8a transcript case + the new recipe case).

> Windows-local note: per the 8a memory, the share consent-broker test hangs on Windows-local from an unref'd TTL timer (the same pattern as the federation preflight-consent test) — both pass Linux CI. If the gateway suite hangs locally, verify this specific e2e in isolation and rely on Docker/Linux for the full-suite gate.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/test/e2e/share-e2e.test.ts
git commit -m "test(share): e2e recipe share round-trip (create --as-recipe → approve → verify)"
```

---

### Task 12: Coverage floor + full preflight + ship

**Files:** possibly `docs/structure-audit/coverage-baseline.json` (only if a new file needs an exclusion — prefer tests over exclusion).

- [ ] **Step 1: Run the changed-file unit suites together**

Run: `bun test packages/gateway/src/share/ packages/gateway/src/db/tool-call-log.test.ts packages/gateway/src/index/migrations/`
Expected: PASS.

- [ ] **Step 2: Static gates**

Run: `bunx tsc -p packages/gateway/tsconfig.json --noEmit`
Run: `bunx biome check packages scripts` (NOT `bun run lint` — it false-fails in `.claude/worktrees`; see memory)
Run: `bun run scripts/structure-audit/check-nimbus-invariants.ts`
Expected: 0 errors / exit 0 each.

- [ ] **Step 3: Docker-Linux coverage-floor (authoritative)**

Per memory ([[ship-readiness-before-first-push]] + the 8a coverage traps): the local unit `--coverage` run gives FALSE non-target violations because it omits the 26 `test:coverage:*` shards — ONLY the Docker full-run is authoritative. Run the established Docker-Linux lcov build + `audit:coverage-floor` (oven/bun:latest, bun 1.3.x = CI). Every new file (`recipe.ts`, `recipe-yaml.ts`, `tool-call-params-v42-sql.ts`) must clear ≥80% line+branch. Migration SQL files are typically below-threshold glue — if `tool-call-params-v42-sql.ts` is a pure string export with no branches, follow the V41 precedent (`share-records-v41-sql.ts`): check whether it's covered incidentally or needs the same exclusion treatment V41 used.

Expected: `coverage-floor: ok`.

- [ ] **Step 4: Full preflight (run gates individually in-worktree)**

Per memory, `bun run preflight` / `test:ci` false-fail wholesale in `.claude/worktrees` due to the biome exclusion — run the gate set individually (typecheck all packages, `biome check packages scripts`, markdownlint on the new plan/spec, `audit:doc-refs`, `audit:cross-platform`, js-licenses, jscpd). Fix anything red BEFORE the first push.

- [ ] **Step 5: Whole-branch self-review**

Run `/code-review` over the branch diff; address findings (fix-not-suppress).

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin worktree-phase6-slice8b-recipe
gh pr create --title "feat(share): Phase 6 Slice 8b — recipe (--as-recipe declarative DAG, V42 params)" --body "<summary + spec link + I27-unchanged note>"
```

Then watch CI green; address CodeRabbit / Sonar / coverage-floor as they report.

---

## Self-Review (completed during authoring)

- **Spec coverage:** §7.1 recipe DAG → Tasks 4+5; deterministic YAML → Task 6; §7.2 `--as-recipe` through the same gate → Task 8 (gate) + Task 9 (wiring); CLI surface already shipped in 8a (verified). The params-availability gap (input args not logged) is resolved by the user-approved V42 (Tasks 1–3), amending the spec's "no migration in 8b" rule (Task 10).
- **Out of scope (correctly deferred):** replay/recipe-runner = Slice 8c; forwarding/`share_inbox` (now V43) = Slice 8d. No replay code here.
- **Type consistency:** `Recipe`/`RecipeStep` defined in Task 4, consumed unchanged in 5/8/9; `buildRecipeFromSession(db, sessionId, now)` signature stable across Tasks 4/5/9; `serializeShareFileToYaml(share)` stable across Tasks 6/7/9; `CreateShareDeps.buildRecipe` added in Task 8, supplied in Task 9.
- **Invariants:** I27/D21 untouched — recipe routes through the existing `createShare`; no new `share.publish` / `share.signing.privkey` / `createShare` references introduced (Task 8 Step 5 verifies).
