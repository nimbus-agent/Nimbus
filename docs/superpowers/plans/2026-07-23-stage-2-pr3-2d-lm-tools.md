# Stage 2 PR 3 — 2d: Language Model tool registration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `nimbus_search` and `nimbus_ask` as Language Model tools (`contributes.languageModelTools` + `vscode.lm.registerTool`) so Copilot (and any LM extension) can pull the user's private local-index context. Zero new RPCs; stable API at the existing `^1.95.0` engines floor.

**Architecture:** Mirror the chat-participant split: a **pure** module `src/lm-tools/lm-tools.ts` (input validation, client calls through a minimal `LmToolsClientLike`, plain-string results — unit-testable, no `vscode` import) and a **real** adapter `src/lm-tools/real-lm-tools.ts` (`vscode.lm.registerTool`, wraps strings in `LanguageModelToolResult`/`LanguageModelTextPart`). `ActivateDeps` gains `registerLmTools?` defaulting to the real adapter, invoked once at activation with a lazy `() => client` — tools answer "Gateway not connected" text when down.

**Tech Stack:** as PR 1/2. Client calls: `searchRanked({ name, limit })`, `agentInvoke(input, { stream: false, agent? })` → `{ reply?: string }`.

## Global Constraints

- Branch `dev/asafgolombek/stage2-pr3-2d-lm-tools` in a worktree; `bun install` first; never commit on `main`; full gate set (incl. `package` + `check-vsix-contents`) before first push.
- Tool `modelDescription`s are written in the ICP's vocabulary: private incident/CI/PR context, local machine, invisible to cloud assistants.
- The pure module must not import `vscode` (vitest runs without the vscode host).

---

### Task 1: Manifest entries (test-first)

**Files:**

- Modify: `test/unit/manifest-capabilities.test.ts` (new describe-block) — or extend in place if PR 2 merged; if PR 2 is unmerged, base off its branch is NOT allowed — create the equivalent standalone test file `test/unit/manifest-lm-tools.test.ts` instead.
- Modify: `package.json` (`contributes.languageModelTools`)

**Interfaces:**

- Produces: two `languageModelTools` entries named `nimbus_search` / `nimbus_ask`, each with `displayName`, `modelDescription`, `userDescription`, `canBeReferencedInPrompt: true`, `toolReferenceName` (`nimbusSearch` / `nimbusAsk`), `tags`, and an `inputSchema` (`query: string` required + optional `limit: number` for search; `question: string` required for ask).

- [ ] **Step 1: failing test** — assert both entries exist by `name`, `inputSchema.required` matches, `modelDescription` contains "local" and "private", `canBeReferencedInPrompt === true`.
- [ ] **Step 2: run to fail.**
- [ ] **Step 3: add the manifest entries** (schema per Interfaces; search `limit` described as "max results, default 8, clamped 1–20").
- [ ] **Step 4: run to pass; commit** (`feat(manifest): declare nimbus_search + nimbus_ask LM tools`).

---

### Task 2: Pure tool handlers (TDD)

**Files:**

- Create: `src/lm-tools/lm-tools.ts`
- Create: `test/unit/lm-tools.test.ts`

**Interfaces:**

```ts
export interface LmToolsClientLike {
  searchRanked(params: { name: string; limit?: number }): Promise<unknown[]>;
  agentInvoke(
    input: string,
    options?: { stream?: boolean; agent?: string },
  ): Promise<{ reply?: string } & Record<string, unknown>>;
}
export interface LmToolsDeps {
  client: () => LmToolsClientLike | undefined;
  askAgent: () => string; // settings.askAgent(); "" = gateway default
  log: { warn(msg: string): void };
}
export function runNimbusSearchTool(deps: LmToolsDeps, input: unknown): Promise<string>;
export function runNimbusAskTool(deps: LmToolsDeps, input: unknown): Promise<string>;
```

Behavior:

- Invalid input (non-object / missing-empty `query`/`question`) → a one-line error string naming the expected field (LM tools should return text, not throw).
- No client → `"The Nimbus Gateway is not connected on this machine, so the private local index is unavailable. The user can run \"Nimbus: Start Gateway\"."`
- Search: clamp `limit` to 1–20 (default 8), call `searchRanked({ name: query, limit })`, format each row via the existing row-shape used by `src/search.ts` (`normalizeInline` / fields `name`, `service`, `snippet`) as `- <name> (<service>): <snippet>`; empty results → `"No matches in the local index for \"<query>\"."`
- Ask: `agentInvoke(question, { stream: false, agent })` passing `agent` only when `askAgent()` is non-empty; return `reply ?? "(the agent returned no reply)"`.
- Client call throws → `"Nimbus lookup failed: <errMsg>"` + `log.warn`.

- [ ] **Step 1: failing tests** covering each behavior bullet (fake client objects; no vscode).
- [ ] **Step 2: run to fail. Step 3: implement. Step 4: run to pass; typecheck. Step 5: commit** (`feat(lm-tools): pure nimbus_search / nimbus_ask handlers`).

---

### Task 3: Real registration + activation wiring

**Files:**

- Create: `src/lm-tools/real-lm-tools.ts`
- Modify: `src/extension.ts` (ActivateDeps + wiring next to `registerParticipant`, `src/extension.ts:1001`)
- Modify: `test/unit/extension.test.ts` (one test: activation calls `registerLmTools` once with working deps)

**Interfaces:**

```ts
// real-lm-tools.ts
export function registerNimbusLmTools(opts: { deps: LmToolsDeps }): DisposableLike;
// extension.ts
registerLmTools?: (opts: { deps: LmToolsDeps }) => DisposableLike;
```

`registerNimbusLmTools` calls `vscode.lm.registerTool("nimbus_search", …)` / `("nimbus_ask", …)`; each `invoke` awaits the pure handler and returns `new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])`; returns a disposable disposing both. Wire in `extension.ts`: `const registerLm = deps.registerLmTools ?? registerNimbusLmTools; ctx.subscriptions.push(registerLm({ deps: { client: () => nimbus(), askAgent: () => settings.askAgent(), log } }));`

- [ ] **Step 1: failing extension test** — fake `registerLmTools` captures deps; assert called once, and `deps.client()` resolves to the fake client after connect.
- [ ] **Step 2-4: implement, pass, typecheck.**
- [ ] **Step 5: commit** (`feat(lm-tools): register nimbus_search + nimbus_ask with vscode.lm`).

---

### Task 4: Full gates, push, PR

As PR 1 Task 4. PR body leads with: Copilot can now call Nimbus for private local context (the "value per install" multiplier); note the accepted trade (roadmap: hands the relationship to Microsoft; Stage 3 owns installs); README gets a short "Copilot integration" section only if `check-settings-docs`/docs gates require nothing else — otherwise defer README copy to Stage 3's re-cut.
