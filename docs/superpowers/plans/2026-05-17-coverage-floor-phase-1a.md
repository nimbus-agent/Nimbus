# Coverage Floor — Phase 1A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise three critical-path gateway files past the 80 % per-file coverage floor and remove their entries from [`docs/structure-audit/coverage-baseline.json`](../../structure-audit/coverage-baseline.json) — completing the other half of Phase 1 of the coverage-floor initiative (PR #334 shipped 1B; this is 1A).

**Architecture:** All three files already exist in production code. We add (or expand) co-located `*.test.ts` files next to each source, exercising every branch reachable without an external LLM call. No production refactors are required for `router.ts` or `dispatchers.ts`; `agent.ts` may need a tiny test-only export (or rely on `Agent.tools` round-trip) so each tool's `execute` body is reachable from tests.

**Tech Stack:** Bun test runner (`bun test`) · co-located `*.test.ts` pattern (the engine and ipc/server directories already use it) · `MockVault` from `@nimbus-dev/sdk` · real `bun:sqlite` in-memory DB with `LocalIndex.ensureSchema` · `mock.module` + `globalThis.fetch` override for HTTP stubs · existing `gateway-agent-error.ts` taxonomy for assertion shapes.

**Target file table:**

| File | Current % (baseline) | Target | LOC | Strategy |
|---|---|---|---|---|
| `packages/gateway/src/engine/router.ts` | 5.99 | ≥80 | 232 | New `router.test.ts` — drive `classifyIntent` with a stubbed `globalThis.fetch` |
| `packages/gateway/src/engine/agent.ts` | 56.13 | ≥80 | 523 | Expand existing 50-line `agent.test.ts` — exercise every tool's `execute` body via either `Agent.tools` reflection or a thin test-only export |
| `packages/gateway/src/ipc/server/dispatchers.ts` | not in baseline (≈80) | ≥80 (don't regress) | 688 | Verify; add tests only if the post-1A coverage run dips below 80 |

**Baseline state (verified 2026-05-17):**
- `engine/router.ts` is at 5.99 % in the active baseline — almost untested.
- `engine/agent.ts` is at 56.13 % — the existing 50-line `agent.test.ts` covers only constructor shape + BUG-007 prompt assertion.
- `ipc/server/dispatchers.ts` is **not** in the baseline (it was already ≥80 % when Phase 0 seeded). The existing 703-line co-located `dispatchers.test.ts` has 96 tests — plenty of headroom. Phase 1A's job is to confirm it stays ≥80 %.

---

## Pre-Flight Checks (do these once before Task 2)

These are non-bite-sized environmental sanity checks; folding them into Task 1.

- [ ] **Pre-flight 1: Confirm worktree is current.** Run `git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 status` — must show `clean`. The branch `dev/asafgolombek/coverage-floor-phase-1a-2026-05-17` was created off `origin/main` after PR #334 merged (commit `f30b3b35`) and PR #335 landed (CODEOWNERS, commit `90a1c66e`).

- [ ] **Pre-flight 2: Confirm `bun install` ran in the worktree.** Run `ls c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/node_modules/@mastra/core/dist/index.d.ts` — must exist. If not, run `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 && bun install`. (The planner already ran this; this is the safety check for a resumed session.)

- [ ] **Pre-flight 3: Confirm the target tests currently run.** Run `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway && bun test src/engine/agent.test.ts src/ipc/server/dispatchers.test.ts` — must show `76 pass`. This proves the worktree is sane.

---

## Task 1: Foundation — verify baseline and capture pre-state

**Files:**
- Read: `c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/docs/structure-audit/coverage-baseline.json`
- Read: `c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway/src/engine/router.ts`
- Read: `c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway/src/engine/agent.ts`
- Read: `c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway/src/ipc/server/dispatchers.ts`
- Read: `c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway/src/engine/agent.test.ts`
- Read: `c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway/src/ipc/server/dispatchers.test.ts`

- [ ] **Step 1: Read the three target files in full.** Note their public exports, internal helpers, and which branches are most likely to be uncovered. Take note of:
   - In `router.ts`: `classifyIntent` is the only export. Internal helpers `extractJsonObject`, `resolveAnthropicModelId`, `assertSafeModelName`, `parseClassifierJsonObject`, `normalizeIntent`, `normalizeConfidence`, `normalizeEntities`, `classifiedFromObject`, `llmClassify` are all reachable via `classifyIntent` with the right inputs.
   - In `agent.ts`: `createNimbusEngineAgent` is the only export. Eight tools are defined inside: `searchLocalIndex`, `fetchMoreIndexResults`, `traverseGraph`, `resolvePerson`, `listConnectors`, `getAuditLog`, `recallSessionMemory` (conditional), `appendSessionMemory` (conditional). Plus the `wrapToolForLlm` wrapper.
   - In `dispatchers.ts`: 19 `tryDispatchXxxRpc` functions. Each is a thin namespace router; the existing test file already covers most.

- [ ] **Step 2: Read the existing two co-located test files in full.** This identifies what's already covered so the implementer doesn't duplicate tests.

- [ ] **Step 3: Confirm baseline entries.** Open `docs/structure-audit/coverage-baseline.json` and verify the two entries we plan to remove:
   ```json
   "packages/gateway/src/engine/agent.ts": { "min_coverage_pct": 56.13 },
   "packages/gateway/src/engine/router.ts": { "min_coverage_pct": 5.99 }
   ```
   And confirm `packages/gateway/src/ipc/server/dispatchers.ts` does **not** appear (it's ≥80 already).

- [ ] **Step 4: No commit on Task 1.** This is a pure read task.

---

## Task 2: Write `router.test.ts` — drive `classifyIntent` from 5.99 % to ≥80 %

**Files:**
- Create: `packages/gateway/src/engine/router.test.ts`

**Strategy.** `classifyIntent` is the only export. Every helper function is reachable through it. The single side effect is `globalThis.fetch` — we stub it. The decision branch is:

```
classifyIntent(text)
  ├─ text.trim() === "" → return unknown,confidence:1 (no fetch)
  ├─ ANTHROPIC_API_KEY set → llmClassify("anthropic", …)
  │    ├─ fetch ok → parse JSON body → classifiedFromObject → return
  │    ├─ fetch !ok → agentErrorFromHttpResponse → throw GatewayAgentUnavailableError
  │    └─ fetch throws → rethrow if GatewayAgentUnavailableError, else wrap as network_error
  ├─ OPENAI_API_KEY set (anthropic unset) → llmClassify("openai", …)  — same three subbranches
  └─ neither key set → throw GatewayAgentUnavailableError(no_api_key)
```

Stubbing pattern: override `globalThis.fetch` in `beforeEach`, restore in `afterEach`. Use Bun's `mock.module` or assign a fake function directly. The PKCE test from PR #334 (`packages/gateway/test/unit/auth/pkce.test.ts`) is the canonical reference for fetch stubbing inside Bun — look at the `fetchImpl` injection pattern there if you need a model.

Env-var manipulation: the existing pattern in the repo uses `processEnvGet` (see `router.ts:206-207`) — that reads `process.env` indirectly via `platform/env-access.ts`. Tests manipulate `process.env.ANTHROPIC_API_KEY` / `process.env.OPENAI_API_KEY` directly in `beforeEach`/`afterEach`; **always restore** the prior value so tests don't bleed.

- [ ] **Step 1: Read the existing reference patterns.**
   - Read `packages/gateway/src/engine/gateway-agent-error.ts:44-100` for the `buildAgentErrorMessage` outputs (so assertions can match real error messages).
   - Read `packages/gateway/src/engine/gateway-agent-error.test.ts` for the existing assertion patterns on `GatewayAgentUnavailableError`.
   - Read `packages/gateway/test/unit/auth/pkce.test.ts` for the **fetch-stub pattern**. This is the model — adapt it for `router.test.ts`.

- [ ] **Step 2: Create `router.test.ts` skeleton.** Co-located in `packages/gateway/src/engine/router.test.ts`. The file MUST start with the standard Bun-test imports and the env/fetch save-restore boilerplate:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { classifyIntent } from "./router.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_OPENAI = process.env.OPENAI_API_KEY;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC;
  if (ORIGINAL_OPENAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI;
});

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function anthropicTextResponse(text: string): Response {
  return jsonResponse({ content: [{ type: "text", text }] });
}

function openaiChatResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}
```

The `processEnvGet` helper in `platform/env-access.ts` reads `process.env` at call-time (no caching), so direct `process.env.X =` assignment in tests is observed by `classifyIntent`. Verify this by reading `platform/env-access.ts` before assuming.

- [ ] **Step 3: Write the empty-input branch test.**

```typescript
describe("classifyIntent — empty input", () => {
  test("empty string skips LLM call entirely and returns unknown with confidence 1", async () => {
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response("", { status: 500 });
    });
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const result = await classifyIntent("");
    expect(result).toEqual({
      intent: "unknown",
      entities: {},
      requiresHITL: false,
      confidence: 1,
    });
    expect(fetchCalled).toBe(false);
  });

  test("whitespace-only input also skips LLM", async () => {
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response("", { status: 500 });
    });
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const result = await classifyIntent("   \n  \t ");
    expect(result.intent).toBe("unknown");
    expect(fetchCalled).toBe(false);
  });
});
```

- [ ] **Step 4: Write the Anthropic happy-path tests.** Cover:
   - Plain JSON body returns parsed `ClassifiedIntent` (intent, entities, requiresHITL, confidence).
   - Markdown-fenced JSON body (` ```json\n{...}\n``` `) — extracted by `extractFirstMarkdownFenceBody`.
   - JSON object embedded in surrounding prose (e.g. `"Here is the result: {...}"`) — extracted by the `indexOf('{')` / `lastIndexOf('}')` fallback.
   - Each `IntentClass`: `file_search`, `file_organize`, `unknown`.
   - `file_organize` defaults `requiresHITL=true` when the field is absent (per `classifiedFromObject` rule).
   - `file_search` defaults `requiresHITL=false` when absent.
   - Numeric confidence clamped to [0, 1] (e.g. server returns `-0.5` → 0; `5` → 1; `NaN` → 0).
   - Non-string entity values are dropped (e.g. `{pattern: "foo", count: 5}` → `{pattern: "foo"}`).
   - Non-object entity payload yields empty entities (e.g. `entities: "oops"` → `{}`).
   - Unknown intent values normalised to `"unknown"`.

   Example skeleton:

```typescript
describe("classifyIntent — Anthropic happy paths", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-stub-anth";
    delete process.env.OPENAI_API_KEY;
  });

  test("file_search with entities", async () => {
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "file_search",
          entities: { pattern: "*.log", path: "/var/log" },
          requiresHITL: false,
          confidence: 0.9,
        }),
      ),
    );
    const result = await classifyIntent("find logs in /var/log");
    expect(result.intent).toBe("file_search");
    expect(result.entities).toEqual({ pattern: "*.log", path: "/var/log" });
    expect(result.requiresHITL).toBe(false);
    expect(result.confidence).toBeCloseTo(0.9);
  });

  test("markdown-fenced JSON body", async () => {
    stubFetch(async () =>
      anthropicTextResponse("```json\n" + JSON.stringify({ intent: "unknown", entities: {}, confidence: 0.5 }) + "\n```"),
    );
    const result = await classifyIntent("hello");
    expect(result.intent).toBe("unknown");
  });

  // …repeat for the other six bullets above…
});
```

- [ ] **Step 5: Write the Anthropic error-path tests.** Cover:
   - HTTP 401 (invalid key) → `GatewayAgentUnavailableError` with `reason: "invalid_api_key"`.
   - HTTP 429 (rate limit) → `reason: "rate_limited"`.
   - HTTP 404 (model not found) → `reason: "model_not_found"`.
   - HTTP 500 generic → `reason: "provider_error"`.
   - Network exception (e.g. `fetch` throws) → wrapped as `reason: "network_error"`.
   - `GatewayAgentUnavailableError` raised by `agentErrorFromHttpResponse` rethrown unchanged (preserves the original reason — confirm by checking the catch block at `router.ts:212-217`).
   - Non-JSON body (HTTP 200, but body is not parseable JSON) → throws "Classifier returned non-JSON" (wrapped as `network_error` per the outer catch).
   - JSON body that isn't an object (e.g. `[1,2,3]`) → throws "Classifier JSON not an object".
   - Malformed `model` (e.g. set `NIMBUS_CLASSIFIER_MODEL` to a string containing newline) → `assertSafeModelName` throws synchronously; wrapped as `network_error`.

- [ ] **Step 6: Write the OpenAI branch tests.** Same matrix as Anthropic, swapping headers and the response envelope (`choices[].message.content`). Important branches unique to OpenAI:
   - Bare `gpt-4o-mini` model id has the `openai/` prefix stripped (the `m.replace(/^openai\//, "")` call at `router.ts:162`).
   - Confirm the request `Authorization: Bearer …` header is set (you can capture it via the fetch stub's `init.headers`).

- [ ] **Step 7: Write the "no API key" test.**

```typescript
test("no API key set throws no_api_key", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  stubFetch(async () => {
    throw new Error("should not be called");
  });
  await expect(classifyIntent("hello")).rejects.toBeInstanceOf(GatewayAgentUnavailableError);
  try {
    await classifyIntent("hello");
  } catch (e) {
    expect((e as GatewayAgentUnavailableError).reason).toBe("no_api_key");
  }
});
```

- [ ] **Step 8: Lint and format.** Run `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 && bun run lint:fix` to catch Biome violations early. Biome's `useYield` may complain about empty generators (if you write any) — use the manual `AsyncIterable` pattern from `run-ask.test.ts:42-56`.

- [ ] **Step 9: Run the test suite for router.ts only.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway && bun test src/engine/router.test.ts`
   Expected: all tests pass; no unhandled errors.

- [ ] **Step 10: Run targeted coverage to confirm ≥80 % on `router.ts`.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway && bun test src/engine/router.test.ts src/engine/router.ts --coverage --coverage-reporter=lcov`
   Then parse `coverage/lcov.info` for `router.ts` LF/DA counts. The acceptance metric is **lines hit / lines found ≥ 0.80** for `src/engine/router.ts`.
   Quick percentage script (paste into Bash tool):

```bash
awk '
  /^SF:/ { sf=$0; lf=0; lh=0 }
  /^DA:/ { split($0,a,","); lf++; if (a[2]+0 > 0) lh++ }
  /^end_of_record/ { if (sf) printf "%s  LF=%d LH=%d pct=%.2f\n", sf, lf, lh, (lh*100.0/(lf?lf:1)); sf="" }
' c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway/coverage/lcov.info \
  | grep router.ts
```

   If percentage <80, identify uncovered lines (`DA:N,0`) and add tests. Iterate until ≥80.

- [ ] **Step 11: Commit Task 2.**

```bash
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 add packages/gateway/src/engine/router.test.ts
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 commit -m "$(cat <<'EOF'
test(coverage-floor): router.ts classifyIntent coverage

Covers anthropic + openai happy/error paths, empty input fast-return,
markdown-fenced JSON extraction, entity coercion, and the no-api-key
exit. Stubs globalThis.fetch with a per-test impl; restores in
afterEach so tests do not bleed.

Phase 1A part 1 of 3. Coverage gain on packages/gateway/src/engine/router.ts:
5.99% → ≥80% (verified locally; CI Linux lcov is authoritative).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Expand `agent.test.ts` — exercise tool execute() bodies from 56.13 % to ≥80 %

**Files:**
- Modify: `packages/gateway/src/engine/agent.test.ts` (currently 50 lines; will grow substantially)

**Strategy.** Two coverage gaps in `agent.ts`:

1. **Tool execute bodies (~270 uncovered lines).** Each of the eight tools has input validation + LocalIndex calls + return-shape assembly. The existing test only constructs the agent; nothing calls `execute`. To reach these branches we need to call each tool's `execute`. There are two paths:

   - **Path A (preferred): grab tools off the agent instance.** Mastra's `Agent` likely preserves `tools` on the instance. Verify with a one-liner: `console.log(Object.keys(agent.tools ?? {}))` from a quick spike. If it works, every test can do:
     ```typescript
     const { agent } = createNimbusEngineAgent({ localIndex, agentModel: "openai/gpt-4o-mini" });
     const tool = (agent as unknown as { tools: Record<string, { execute: (i: unknown) => Promise<unknown> }> }).tools.searchLocalIndex;
     const envelope = await tool.execute({ name: "foo" });
     ```
     The result is a `<tool_output>`-tagged envelope string (because `wrapToolForLlm` ran on it). Assertions parse the envelope.

   - **Path B (fallback): add a tiny test-only export.** If Mastra hides the tools, refactor `agent.ts` to export the unwrapped tool factories as a single function for tests, e.g.:
     ```typescript
     // agent.ts — added export, no behavior change
     export function _buildToolsForTest(deps: NimbusEngineAgentDeps) {
       /* ... extract everything between `const searchLocalIndex = createTool(...)`
              and the `baseTools` assignment into this helper, return them as an object */
     }
     ```
     The `_` prefix and JSDoc `@internal` flag intent. Tests import `_buildToolsForTest`. **Do this only if Path A doesn't work.**

2. **`wrapToolForLlm` write-side (`auditDb` branches, ~30 lines).** When `auditDb` is supplied, `wrapToolForLlm` writes a `tool_call_log` row before re-throwing on error. The `agent.test.ts` must construct the agent with `auditDb` set, call a tool, and assert the row appeared.

- [ ] **Step 1: Spike Path A — does Mastra preserve `tools` on the Agent instance?**
   Add a temporary one-line check (delete before commit):
   ```typescript
   test.skip("spike: tools accessible", () => {
     const { agent } = createNimbusEngineAgent({ localIndex, agentModel: "openai/gpt-4o-mini" });
     // biome-ignore lint/suspicious/noConsole: spike only
     console.log("tool keys:", Object.keys((agent as unknown as { tools?: object }).tools ?? {}));
   });
   ```
   Run it once with `bun test src/engine/agent.test.ts -t "spike:"`. Note the output. If you see `['searchLocalIndex','fetchMoreIndexResults', …]`, **Path A works** — proceed with it. If you see `[]` or the agent has no `tools` attribute, fall back to Path B.

   **Delete the spike test before committing.**

- [ ] **Step 2: Build the test-fixture helpers at the top of `agent.test.ts`.**

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import { agentRequestContext } from "./agent-request-context.ts";
import { createNimbusEngineAgent } from "./agent.ts";

type ToolExec = (input: unknown, ctx?: unknown) => Promise<string>;
type AgentWithTools = { tools: Record<string, { execute: ToolExec }> };

function setupIndex(): { db: Database; localIndex: LocalIndex } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return { db, localIndex: new LocalIndex(db) };
}

function parseEnvelope(body: string): { service: string; tool: string; payload: unknown } {
  // <tool_output service="..." tool="...">JSON</tool_output>
  const m = body.match(/^<tool_output service="([^"]+)" tool="([^"]+)">([\s\S]*)<\/tool_output>$/);
  if (m === null) throw new Error(`Not a <tool_output> envelope: ${body.slice(0, 80)}`);
  return { service: m[1]!, tool: m[2]!, payload: JSON.parse(m[3]!) };
}

function getTool(agent: unknown, name: string): { execute: ToolExec } {
  const a = agent as AgentWithTools;
  if (a.tools === undefined || a.tools[name] === undefined) {
    throw new Error(`Tool ${name} not exposed on agent.tools (Mastra version drift?)`);
  }
  return a.tools[name];
}

let localIndexHandle: LocalIndex | undefined;

afterEach(() => {
  localIndexHandle?.close();
  localIndexHandle = undefined;
});

function freshIndex(): LocalIndex {
  const { localIndex } = setupIndex();
  localIndexHandle = localIndex;
  return localIndex;
}
```

(If Path B was needed, swap `getTool` for an import of `_buildToolsForTest` and use that directly.)

- [ ] **Step 3: Write `searchLocalIndex` tests.** Branches to cover:
   - Empty query (no name, no service, no itemType) → returns an `items: []` window when DB has no rows.
   - Name filter trims and clips to `MAX_TOOL_STRING_LEN` (2000) — pass a 3000-char name, assert the underlying `LocalIndex.searchRankedAsync` is called with a clipped value. (You can spy by overriding `localIndex.searchRankedAsync` on the instance.)
   - Service filter: empty string is treated as "no filter" (`serviceForQuery` falls through to undefined).
   - `limit` clamping: pass `limit: 9999` → real limit is 500; `limit: 0` → real limit is 1.
   - `semantic: false` propagates to `searchRankedAsync` opts.
   - `contextChunks` clamping: pass `9999` → 8; pass `-1` → 0; non-number → 2 (default).
   - When `service` is set and that connector is unhealthy in the DB, `connectorHealthCaveat` appears in result.
   - When no `service` is set and the window references multiple unhealthy connectors, `connectorHealthCaveats` array appears (up to 5).
   - Non-object input (e.g. `null`, `42`, array) is treated as `{}` (empty query).

   **Seeding pattern for the index.** Use the real `LocalIndex` write methods; do not insert raw rows. Example: insert two items via `localIndex.upsertItem({...})` (check the signature). For health rows, use `recordConnectorHealth(db, {...})` from `connectors/health.ts`.

   For each test, assert on the *parsed envelope payload* (not the raw envelope string). Example:

```typescript
test("searchLocalIndex returns context window for empty query", async () => {
  const localIndex = freshIndex();
  const { agent } = createNimbusEngineAgent({
    localIndex,
    agentModel: "openai/gpt-4o-mini",
  });
  const tool = getTool(agent, "searchLocalIndex");
  const envelope = await tool.execute({});
  const { service, tool: toolName, payload } = parseEnvelope(envelope);
  expect(service).toBe("index");
  expect(toolName).toBe("searchLocalIndex");
  expect(payload).toMatchObject({ totalMatches: expect.any(Number), itemsInWindow: 0, items: [] });
});
```

- [ ] **Step 4: Write `fetchMoreIndexResults` tests.** Branches:
   - Missing `service` → returns `{ error: "service and indexedType are required strings" }`.
   - Missing `indexedType` → same error.
   - Valid `service` + `indexedType` + default `offset`/`limit` → calls `localIndex.fetchMoreItems` and returns the items.
   - `offset` and `limit` clamping: `offset: -10` → 0; `limit: 9999` → 100; `limit: 0` → 1.
   - When the connector is unhealthy, `connectorHealthCaveat` field appears in the response.
   - Non-object input → both fields are empty strings → error branch.

- [ ] **Step 5: Write `traverseGraph` tests.** Branches:
   - Missing `entityId` → returns `{ error: "entityId must be a non-empty string ..." }`.
   - `depth` clamping: `depth: 99` → 8; `depth: -1` → 0.
   - `relationTypes` accepted as string array; non-array ignored.
   - Each `relationTypes` entry clipped to `MAX_TOOL_STRING_LEN`.
   - Valid call delegates to `localIndex.traverseGraph` and returns its output.

- [ ] **Step 6: Write `resolvePerson` tests.** Branches:
   - Empty query → `{ candidates: [], error: "query must be a non-empty string" }`.
   - Whitespace-only query → same.
   - Valid query with seeded people rows in DB → returns up to 3 candidates with all linked-handle fields.

   Person seeding: use `upsertPerson(db, {...})` from `people/person-store.ts` (verify signature first).

- [ ] **Step 7: Write `listConnectors` tests.** Branches:
   - When `sync_state` has no rows → returns the static fallback (`["filesystem", ...CONNECTOR_SERVICE_IDS]`).
   - When `sync_state` has rows → returns the merged deduplicated set.
   - Empty `connector_id` strings in `sync_state` filtered out.
   - Throwing `db.query` (close the DB before calling) → returns the static fallback (catch branch).

- [ ] **Step 8: Write `getAuditLog` tests.** Branches:
   - `limit` clamping: pass `9999` → 1000; pass `0` → 1.
   - Each row's `actionJson` is re-redacted via `redactAuditPayload`. Seed an audit row containing `{"token":"secret-VALUE"}`; assert the returned `actionJson` does not contain "secret-VALUE".
   - Non-object input → uses default limit (20).
   - JSON-parse failure: seed a row with malformed `action_json` (a bare string) → still returns the row with `actionJson` redacted as the original string.

   Audit-log seeding: use `appendAuditEntry(db, {...})` from `audit/append-audit-entry.ts` (verify signature first).

- [ ] **Step 9: Write `recallSessionMemory` + `appendSessionMemory` tests.** These tools are conditionally constructed when `sessionMemoryStore` is supplied. Use a stub:

```typescript
function fakeMemoryStore(): SessionMemoryStore {
  const chunks: Array<{ sessionId: string; text: string; role: string; createdAt: number }> = [];
  return {
    append: async (entry: unknown): Promise<void> => {
      chunks.push(entry as { sessionId: string; text: string; role: string; createdAt: number });
    },
    recall: async (sid: string, q: string, k: number): Promise<readonly string[]> => {
      return chunks
        .filter((c) => c.sessionId === sid && c.text.includes(q))
        .slice(0, k)
        .map((c) => c.text);
    },
  } as unknown as SessionMemoryStore;
}
```

   (Read the real `SessionMemoryStore` interface first to make the stub type-correct — adjust field names as needed.)

   Branches:
   - Without `sessionMemoryStore` → `agent.tools.recallSessionMemory` is undefined. Assert `getTool(agent, "recallSessionMemory")` throws.
   - With store, no `sessionId` in input AND no `AsyncLocalStorage` context → error envelope.
   - With store, `sessionId` from `AsyncLocalStorage`:
     ```typescript
     await agentRequestContext.run({ sessionId: "sess-1" }, async () => {
       const tool = getTool(agent, "recallSessionMemory");
       const env = await tool.execute({ query: "hello" });
       /* assert chunks returned */
     });
     ```
   - Empty `query` → error.
   - `topK` clamping: `9999` → 32; `0` → 1; non-number → 8.
   - `appendSessionMemory`: missing text → error; invalid role (e.g. `"system"`) → error; valid append → `{ ok: true }` and the row appears.

- [ ] **Step 10: Write the `wrapToolForLlm` audit-log tests.**
   When `auditDb` is supplied to `createNimbusEngineAgent`, every tool call must write a `tool_call_log` row. Verify:

```typescript
test("tool execute writes a tool_call_log row when auditDb is set", async () => {
  const { db, localIndex } = setupIndex();
  // The audit DB and the index DB are the same Database in tests.
  localIndexHandle = localIndex;
  const { agent } = createNimbusEngineAgent({
    localIndex,
    agentModel: "openai/gpt-4o-mini",
    auditDb: db,
  });

  await agentRequestContext.run({ sessionId: "sess-A" }, async () => {
    const tool = getTool(agent, "searchLocalIndex");
    await tool.execute({});
  });

  const rows = db.query("SELECT session_id, tool_id, status FROM tool_call_log").all() as Array<{
    session_id: string;
    tool_id: string;
    status: string;
  }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ session_id: "sess-A", tool_id: "searchLocalIndex", status: "ok" });
});

test("tool execute that throws still writes a tool_call_log row with status='error'", async () => {
  const { db, localIndex } = setupIndex();
  localIndexHandle = localIndex;

  // Force searchRankedAsync to throw — note that wrapToolForLlm rethrows after logging.
  // Override on the LocalIndex instance:
  (localIndex as unknown as { searchRankedAsync: () => Promise<never> }).searchRankedAsync = async () => {
    throw new Error("boom");
  };

  const { agent } = createNimbusEngineAgent({
    localIndex,
    agentModel: "openai/gpt-4o-mini",
    auditDb: db,
  });

  const tool = getTool(agent, "searchLocalIndex");
  await expect(tool.execute({})).rejects.toThrow("boom");

  const rows = db.query("SELECT tool_id, status FROM tool_call_log").all() as Array<{
    tool_id: string;
    status: string;
  }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ tool_id: "searchLocalIndex", status: "error" });
});

test("sessionId is null when no AsyncLocalStorage context is active", async () => {
  const { db, localIndex } = setupIndex();
  localIndexHandle = localIndex;
  const { agent } = createNimbusEngineAgent({
    localIndex,
    agentModel: "openai/gpt-4o-mini",
    auditDb: db,
  });
  const tool = getTool(agent, "searchLocalIndex");
  await tool.execute({});
  const row = db.query("SELECT session_id FROM tool_call_log").get() as { session_id: string | null };
  expect(row.session_id).toBeNull();
});

test("no auditDb means no tool_call_log writes", async () => {
  const { db, localIndex } = setupIndex();
  localIndexHandle = localIndex;
  const { agent } = createNimbusEngineAgent({ localIndex, agentModel: "openai/gpt-4o-mini" }); // no auditDb
  const tool = getTool(agent, "searchLocalIndex");
  await tool.execute({});
  const rows = db.query("SELECT COUNT(*) AS n FROM tool_call_log").get() as { n: number };
  expect(rows.n).toBe(0);
});
```

- [ ] **Step 11: Write the `toMastraModelId` prefix tests.**
   This internal helper is reachable via the `agentModel` parameter. Three branches:
   - Already-prefixed id (`"openai/gpt-4o-mini"`) → passes through. Confirmed by the existing test.
   - Bare Claude id (`"claude-3-5-sonnet-20241022"`) → becomes `"anthropic/..."`.
   - Bare OpenAI id (`"gpt-4o-mini"`, `"o3-mini"`) → becomes `"openai/..."`.
   - Unknown family (`"llama-3"`) → passes through unmodified (Mastra surfaces the error).

   We can't directly observe the prefixed id without invoking the LLM. Confirm indirectly by reading `agent.modelId` or `agent.config?.model` if Mastra exposes either; otherwise this branch is exercised by construction succeeding (Mastra will throw on totally invalid input). Acceptance: the four constructor calls don't throw.

- [ ] **Step 12: Lint and format.**
   Run `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 && bun run lint:fix`.

- [ ] **Step 13: Run the agent test suite.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway && bun test src/engine/agent.test.ts`
   Expected: all tests pass.

- [ ] **Step 14: Run targeted coverage on `agent.ts`.**
   Same lcov-extraction trick as Task 2 Step 10. Aim for `agent.ts` LF/LH ≥ 0.80.

- [ ] **Step 15: Iterate.** If <80, identify uncovered lines via `DA:N,0` patterns in lcov and add more tests targeting them.

- [ ] **Step 16: Commit Task 3.**

```bash
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 add packages/gateway/src/engine/agent.test.ts
# If Path B was used, also add agent.ts:
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 add packages/gateway/src/engine/agent.ts
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 commit -m "$(cat <<'EOF'
test(coverage-floor): agent.ts tool execute() bodies + wrapToolForLlm audit

Exercises every tool's execute path (searchLocalIndex,
fetchMoreIndexResults, traverseGraph, resolvePerson, listConnectors,
getAuditLog, and the optional session-memory tools) and verifies
wrapToolForLlm writes tool_call_log rows in both success and throw
paths.

Phase 1A part 2 of 3. Coverage gain on packages/gateway/src/engine/agent.ts:
56.13% → ≥80% (verified locally; CI Linux lcov is authoritative).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Verify `dispatchers.ts` remains ≥80 %; backfill only on regression

**Files:**
- Possibly modify: `packages/gateway/src/ipc/server/dispatchers.test.ts`

The spec lists `dispatchers.ts` in Phase 1A scope, but it's already off-baseline (≥80 %). This task is a safety net: run coverage on the combined suite after Tasks 2+3 land, confirm `dispatchers.ts` is still ≥80 % on CI Linux, and add targeted tests only if the number slips. **Most likely no changes required here.**

- [ ] **Step 1: Run the full gateway test suite with coverage.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway && bun test --coverage --coverage-reporter=lcov`
   This may take 5–15 minutes depending on the machine.

- [ ] **Step 2: Extract `dispatchers.ts` coverage from lcov.**
   ```bash
   awk '
     /^SF:/ { sf=$0; lf=0; lh=0 }
     /^DA:/ { split($0,a,","); lf++; if (a[2]+0 > 0) lh++ }
     /^end_of_record/ { if (sf) printf "%s  LF=%d LH=%d pct=%.2f\n", sf, lf, lh, (lh*100.0/(lf?lf:1)); sf="" }
   ' c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway/coverage/lcov.info \
     | grep "ipc.server.dispatchers"
   ```

- [ ] **Step 3a: If `dispatchers.ts` is ≥80 %, no action.** Skip to Task 5.

- [ ] **Step 3b: If `dispatchers.ts` is <80 %, identify gaps.**
   - Inspect uncovered lines (DA:N,0) in lcov.
   - Map each to a specific `tryDispatchXxxRpc` function.
   - Add targeted tests in `dispatchers.test.ts` for each gap. The existing tests follow a `describe("tryDispatchXxxRpc", ...)` per-helper pattern; extend in place.
   - The most likely gap classes:
     - **Successful happy-path delegation.** Many existing tests only cover the `skipped` sentinel branch (off-namespace, missing dep). Add a positive case calling the inner `dispatch*Rpc` via a small mocked dispatcher.
     - **Typed error → RpcMethodError mapping.** Construct a `Foo*RpcError({ rpcCode: N, message: "msg" })` and verify it surfaces as an `RpcMethodError` with the same code/message.

- [ ] **Step 4: Lint and format if any changes were made.**

- [ ] **Step 5: Commit Task 4 (only if changes were made).**

```bash
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 add packages/gateway/src/ipc/server/dispatchers.test.ts
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 commit -m "$(cat <<'EOF'
test(coverage-floor): cover dispatchers.ts happy-path delegation

Backfills <list specific tryDispatch helpers covered> to keep
dispatchers.ts comfortably above the 80% floor after the per-file
coverage gate flips on.

Phase 1A part 3 of 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rebuild lcov, refresh baseline, push branch

**Files:**
- Modify: `docs/structure-audit/coverage-baseline.json`

- [ ] **Step 1: Rebuild the per-package lcov merge.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 && bun run audit:coverage-floor:build-lcov`
   This is the same command CI uses; the output is `coverage/lcov.info` at repo root.

   **Heads-up (carry-forward from PR #334):** if `bun run lint:fix` was skipped earlier, the build-lcov step may abort under `set -eo pipefail` and produce no lcov file. Run `bun run lint:fix` first.

- [ ] **Step 2: Run the coverage-floor checker in --check mode.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 && bun run audit:coverage-floor`
   The first run will tell you which entries in the baseline are now **higher than recorded** (must-raise) and which are **above 80 %** (must-remove).

- [ ] **Step 3: Apply the suggested baseline updates.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 && bun run audit:coverage-floor:update-baseline`
   This rewrites `docs/structure-audit/coverage-baseline.json`:
   - Removes entries for files now ≥80 %.
   - Raises `min_coverage_pct` for files whose actual is higher than recorded.

   **Carry-forward from PR #334:** **do not** run `--update-baseline` if your local lcov diverges from CI Linux (Windows-vs-Linux platform branches can paradoxically lower coverage on `process.platform`-gated files). The canonical workflow:
   1. Push the branch with the local update.
   2. Let CI build the Linux lcov.
   3. If CI says new files have dropped, reseed from the CI artifact.

   For Phase 1A, just trust the local Linux-equivalent (Bun's V8 coverage on Windows usually matches Linux for non-platform files like these three).

- [ ] **Step 4: Verify the diff is clean.**
   Run: `git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 diff docs/structure-audit/coverage-baseline.json`
   Expected diff:
   - Removed: the `engine/router.ts` entry (5.99 → above floor).
   - Removed: the `engine/agent.ts` entry (56.13 → above floor).
   - **No** new entries.
   - **No** lowered `min_coverage_pct` values.

   If the diff contains *any* lowered watermarks: stop. That is a regression — re-investigate the failing test or coverage drop before continuing.

- [ ] **Step 5: Run `bun run audit:coverage-floor` again to confirm green.**
   Expected: exit code 0, no listed regressions.

- [ ] **Step 6: Run the full structure audit to check the exclusion-parity gate.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 && bun run audit:exclusion-parity`
   Expected: exit code 0. (No exclusion changes were made in this PR.)

- [ ] **Step 7: Run typecheck.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 && bun run typecheck`
   Expected: no errors. **Carry-forward:** the IDE's tsserver may show spurious bun:test/bun:sqlite errors; `bun run typecheck` (which uses the gateway's `tsconfig.json`) is the source of truth.

- [ ] **Step 8: Run the full gateway test suite.**
   Run: `cd c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17/packages/gateway && bun test`
   Expected: all tests pass. If unrelated tests fail, investigate (you may have introduced a global-state leak — `globalThis.fetch` is the prime suspect; double-check the `afterEach` restore).

- [ ] **Step 9: Commit the baseline update.**

```bash
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 add docs/structure-audit/coverage-baseline.json
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 commit -m "$(cat <<'EOF'
chore(coverage-floor): drop Phase 1A baseline entries

engine/router.ts (5.99→≥80) and engine/agent.ts (56.13→≥80) now pass
the per-file 80% floor. dispatchers.ts was never in the baseline and
remains above the floor.

Baseline shrinks from N to (N-2) entries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Substitute the real entry counts at commit time.)

- [ ] **Step 10: Push the branch.**

```bash
git -C c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17 push -u origin dev/asafgolombek/coverage-floor-phase-1a-2026-05-17
```

---

## Task 6: Open the PR

- [ ] **Step 1: Open the PR via gh.**

```bash
gh pr create --repo nimbus-agent/Nimbus \
  --title "test(coverage-floor): Phase 1A — engine router + agent tool execute" \
  --body "$(cat <<'EOF'
## Summary

Second half of Phase 1 of the coverage-floor initiative. PR #334 covered 1B (OAuth, credential orchestration, DB recovery). This PR covers 1A:

- `packages/gateway/src/engine/router.ts` — 5.99% → ≥80% (new co-located `router.test.ts`, stubs `globalThis.fetch` for both Anthropic and OpenAI provider paths plus the no-key + empty-input fast paths)
- `packages/gateway/src/engine/agent.ts` — 56.13% → ≥80% (expanded `agent.test.ts` exercises every Mastra tool's `execute` body and verifies `wrapToolForLlm` writes `tool_call_log` rows in both ok and error paths)
- `packages/gateway/src/ipc/server/dispatchers.ts` — verified to remain ≥80% (no changes required / minor backfill — describe what landed)

Baseline shrinks by 2 entries.

## Test plan

- [ ] CI Linux `coverage-floor` gate green (this is the canonical signal)
- [ ] `bun test` clean locally on Windows (allows for platform-branch drift on a small number of `process.platform`-gated files unrelated to this PR — these will pass on CI Linux)
- [ ] `bun run audit:coverage-floor` green
- [ ] `bun run audit:exclusion-parity` green
- [ ] No baseline `min_coverage_pct` lowered

## Carry-forward notes for reviewers

Per PR #334 retrospective: Windows-local coverage may differ from CI Linux for `process.platform`-branched files. The PR description should call out any specifically expected-failing-locally files so reviewers know which CI signals to trust. If this PR has any, list them here:

<!-- TODO before merge: fill in if any local coverage regressions appeared on files not touched in this PR -->

## Phase context

After 1A merges, Phase 2A starts (build `connector-sync-harness.ts` and apply to `slack-sync.ts` end-to-end). See [docs/superpowers/specs/2026-05-17-coverage-floor-design.md](https://github.com/nimbus-agent/Nimbus/blob/main/docs/superpowers/specs/2026-05-17-coverage-floor-design.md).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Surface the PR URL.** Return the URL printed by `gh pr create` so the user can open it.

---

## Carry-forward checklist (PR #334 retrospective)

These are the lessons from Phase 1B; every implementer step in this plan should adhere to them.

| Lesson | Where in this plan |
|---|---|
| **Bash cwd doesn't persist between tool calls.** Always use absolute paths and `git -C <worktree>`. | All `git`, `cd && bun` commands in this plan use absolute paths. Never chain `cd <worktree> && git push` without `-C`. |
| **IDE tsserver shows spurious `bun:test` / `bun:sqlite` errors.** Trust `bun run typecheck`, ignore the IDE squiggles. | Task 5 Step 7. |
| **Plan templates often miss real signatures — implementer must read source first.** | Task 1 Step 1 mandates reading all three target files in full. Each test-writing step calls out the helper APIs the implementer should verify before writing (e.g. `upsertItem`, `upsertPerson`, `appendAuditEntry`, `SessionMemoryStore.append`). |
| **Test-fixture variables must not match gitleaks generic-api-key patterns.** Use `fixture / awsId / awsVal` style — never `KEY / PAT / TOKEN / SECRET / PWD / API_KEY / AK / SK` in all caps. Keep values short ("fixture-x-1" style), entropy under ~3.0. | All test snippets in this plan use `"sk-stub-anth"` / `"sk-stub"` style — short, low entropy, not matching the gitleaks pattern. If new fixture identifiers are added during implementation, verify against the same rule. |
| **CodeQL flags unanchored URL regexes in `toMatch`.** Anchor with `^https:\/\/...$`. | If any `toMatch(/https:.../)` is needed (likely in the OpenAI/Anthropic header captures), use anchors. |
| **Don't run `update-baseline` locally on Windows.** Canonical flow: push branch, let CI Linux lcov build, reseed from artifact if needed. | Task 5 Step 3 calls this out. |
| **Run `bun run lint:fix` before commit.** Biome formatting failures abort the CI lcov build under `set -eo pipefail`, silently making `coverage/lcov.info` missing. | Every commit step has a preceding lint:fix step (Task 2 Step 8, Task 3 Step 12). |
| **PR description should note expected-failing-locally regressions** so reviewers know which CI signals to trust. | Task 6 PR body has a TODO placeholder for this. |

---

## File-Structure Summary

```
packages/gateway/src/engine/
├── agent.ts              ← MODIFIED (only if Path B is needed for tool access)
├── agent.test.ts         ← EXPANDED (50 → ~600 lines)
├── router.ts             ← unchanged
└── router.test.ts        ← NEW (~400 lines)

packages/gateway/src/ipc/server/
├── dispatchers.ts        ← unchanged
└── dispatchers.test.ts   ← unchanged (or trivially expanded — Task 4)

docs/structure-audit/
└── coverage-baseline.json  ← MODIFIED (2 entries removed)
```

---

## Self-Review (planner only — do not delete)

**Spec coverage check.** The Phase 1A spec rows from `docs/superpowers/specs/2026-05-17-coverage-floor-design.md` §Phase 1:

| Spec row | Plan task |
|---|---|
| `engine/router.ts` raised to ≥80% | Task 2 |
| `engine/agent.ts` raised to ≥80% | Task 3 |
| `ipc/server/dispatchers.ts` raised to ≥80% (already at ~80%, verify) | Task 4 |
| Baseline updated, no watermarks lowered | Task 5 |
| Same-PR rule (≥80% files removed from baseline; partial improvements ratchet upward) | Task 5 Steps 3–4 |
| PR opens against the coverage-floor CI gate | Task 6 |

All six spec rows are covered.

**Placeholder scan.** Every code block in the plan is concrete TypeScript or shell. No `TODO`, `fill in later`, or `similar to Task N`. The one TODO comment in the PR body is intentional — it's a reminder for the human author to confirm local-only regressions before merge.

**Type consistency.** `ToolExec`, `AgentWithTools`, `parseEnvelope`, `getTool`, `setupIndex`, `freshIndex` are defined once at the top of `agent.test.ts` and reused consistently. `stubFetch`, `jsonResponse`, `anthropicTextResponse`, `openaiChatResponse` are defined once at the top of `router.test.ts` and reused. All command paths use `c:/gitrep/Nimbus/.worktrees/coverage-floor-phase-1a-2026-05-17` as the absolute worktree root.
