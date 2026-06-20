# Dedup "Realistic Floor" Program — Wave A Design (intra-package cleanups)

**Date:** 2026-06-20 · **Branch:** `worktree-dedup-wave-a` (off `origin/main`, post-#692 dedup Wave-2 + #694 security)
**Baseline strict `bunx jscpd packages`:** **3.97%** (5266 dup-lines / 523 clones); CI ratchet `.jscpd.json` threshold **4.0**.

## Program context

This is **Wave A** of a 3-wave "realistic floor" program (user committed to the full A→B→C):

- **A — intra-package cleanups** (this spec): within-package loops/helpers + sibling-module merges. Low risk.
- **B — cross-package sdk hoisting**: move legitimately-shared logic/types into `@nimbus-dev/sdk`. Medium risk. (separate spec)
- **C — connector-template codegen**: collapse the ~80-connector scaffolding parallelism behind a declarative factory. High risk, biggest lever. (separate spec)

**Recalibrated expectation:** recon showed the intra-package bucket is *less* reducible than the coarse 36% suggested — much of it is "similar-by-convention" code that the program's fix-not-force rule says to leave. Clean Wave A ≈ **~180–240 dup-lines → ~3.8%**. The program's legitimate floor is ~3% (B) and ~2–2.5% only if C's codegen succeeds.

## Non-negotiable: pure dedup, zero behavior change

Every existing test stays GREEN UNEDITED. New helpers get co-located TDD tests. No `.jscpd.json` ignore added. If a candidate can't be unified byte-faithfully, defer + record (don't force a harmful abstraction).

## Targets (6) — all CLEAN/PARTIAL, recon-confirmed

### A1 — gitlab `server.ts` self-clones (~43L) · CLEAN

Eleven tool registrations repeat `const token = requireProcessEnv("GITLAB_PAT"); … glFetch(token,url); return mcpJsonResultIfOk("GitLab", res)`. Extract a **file-local** factory:

```ts
function registerGitlabTool<S extends z.ZodObject<z.ZodRawShape>>(
  name: string, description: string, schema: S,
  buildUrl: (p: z.infer<S>) => string,
  buildInit?: (p: z.infer<S>) => RequestInit,
): void  // reg(name, desc, schema, async p => mcpJsonResultIfOk("GitLab", await glFetch(token, buildUrl(p), buildInit?.(p))))
```

Applies to the standard tools (`gitlab_mr_list`/`_mr_get`/`_issue_list`/`_issue_get`/`_pipeline_list`/`_pipeline_get`/`_pipeline_jobs_get`). The custom-tail tools (`gitlab_job_trace`, `gitlab_job_log_tail` — text trace; `gitlab_pipeline_retry`/`_cancel` — custom error text) **stay hand-written**. Behaviour-identical (`mcpJsonResultIfOk("GitLab", res)` is the existing tail).

### A2 — google-drive `server.ts` self-clones (~35L) · CLEAN

Eight tools repeat `safeParse → throw error.message → requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN") → drive<X>(token,…) → mcpJsonResult(data)`. Extract a **file-local** factory:

```ts
function registerDriveTool<S extends z.ZodObject<z.ZodRawShape>>(
  name: string, description: string, schema: S,
  handler: (args: z.infer<S>, token: string) => Promise<unknown>,
): void  // createZodToolRegistrar-style: parse via registerZodTool, token, return mcpJsonResult(await handler(...))
```

Reuse the existing shared `createZodToolRegistrar`/`registerZodTool` (same byte-identical `throw new Error(parsed.error.message)`) so this also drops the manual safeParse boilerplate. Tools whose tail isn't `mcpJsonResult(data)` (e.g. a download returning a custom shape) stay hand-written.

### A3 — http-server admin bearer gate (~24L) · CLEAN

`handleAdminStatus` / `handleMetrics` / `handleAdminConsole` repeat the `resolveAdminToken` + `requireBearer` → 401 check. Extract a **file-local** helper returning the 401 `Response` or `null` (gate passed):

```ts
async function checkAdminBearerGate(req: Request, opts: ReadOnlyHttpServerOptions): Promise<Response | null>
```

★ Fidelity: the 401 body differs per handler today (`json({error:"unauthorized"},401)` vs `text/plain "unauthorized\n"`). Preserve EXACT current bytes — verify each call site's current 401 shape and either standardize only if byte-identical, else parameterize. The `resolveAdminToken === undefined → return null` short-circuit must be preserved per handler.

### A4 — cli agent-command dispatcher (~51L+) · CLEAN

The `runXxxCli` body (read gateway state → IPCClient connect → `registerInteractiveCliIpcHandlers` → `awaitAgentBrief(client, name, guard, …)` + timeout → `client.call(method, params)` → `renderAgentBrief` → exit-code error handling → finally disconnect) repeats across the agent commands. Extract `runAgentCli(...)` to `packages/cli/src/lib/agent-cli-dispatcher.ts`:

```ts
export async function runAgentCli<B>(opts: {
  agentName: string;
  ipcMethod: string;                 // "agents.catchup" etc.
  callParams: Record<string, unknown>;
  guard: (x: unknown) => x is B;
  json: boolean;
}): Promise<void>
```

Apply to **every** agent command that matches the shape (catchup, impact, expert, ghost, conflicts, huddle, janitor, preflight) — confirm each matches before migrating; a command with extra pre/post logic keeps that logic around the shared call. ★ Preserve exact stderr text + `process.exit(1|2)` codes + the timeout-clear-in-finally.

### A5 — gcloud spawn runner (~28L) · CLEAN

`cloud-logging-sync.ts` + `vertex-ai-sync.ts` repeat the `Bun.spawn(["gcloud",…], {env: extensionProcessEnv({GOOGLE_APPLICATION_CREDENTIALS}), …}) → exited → text` try/catch. Extract to `packages/gateway/src/connectors/_lib/gcloud-runner.ts` (+ co-located test):

```ts
export async function runGcloudCommand(argv: string[], credPath: string): Promise<{ ok: boolean; text: string }>
```

Each connector keeps its per-service argv builder + `loadCreds` (vertex-ai's region `isSafeCliArg` guard stays). ★ I1 note: preserve `extensionProcessEnv()` (child-process env scoping invariant) — the helper must call it exactly as today.

### A6 — peer-fanout generic (~30L) · PARTIAL, federation-sensitive

`fanOutQuery`/`fanOutExpertise`/`fanOutProbe`/`fanOutPreflight` repeat the `runPool(reachablePeers) → send(method, body) → cast → per-peer ok/gap → sort by peerId → {perPeer, gaps}` skeleton. Extract `fanOutGeneric<TOut>(deps, rpcMethod, buildBody, parseWorker)` (in `peer-fanout.ts`), keeping each function's shape-specific `parseWorker` closure. ★ **I17-sensitive**: `fanOutQuery`'s `no_grant → deps.store.prune` and `deps.store.record` semantics + every gap message must stay byte-exact. All 3 peer-fanout test files (`peer-fanout.test.ts`, `.preflight.test.ts`, `.probe.test.ts`) stay green unedited.

## Skipped — documented (program forbids forcing these)

- `connector-rpc-handlers/auth.ts` (52L) — 16 per-service handlers with genuinely distinct validation / secret-shape / error text; a parameterized registry trades local auditability for a forced abstraction.
- `google-meet-sync ↔ google-photos-sync` (39L) — GET-params vs POST-body, distinct parse/map. Forced.
- `agents-rpc.ts` (~12L) — only a cosmetic llm-ternary; not worth a helper.

## Dependency / invariant guardrails

- All extractions are **within-package** (no cross-package imports — that's Wave B). gitlab/google-drive helpers are file-local; gcloud-runner in gateway `_lib`; cli dispatcher in `cli/src/lib`.
- I1 (extensionProcessEnv) preserved in A5. I17 (federation query gate) untouched by A6 (only the fanout skeleton moves; the gate logic stays). No invariant wiring changes.

## Execution discipline

- Subagent-driven TDD where useful, but bg subagents are shell-denied here → controller implements + commits; per-target: edit → `bun test` the co-located/connector tests green UNEDITED → tsc → biome → commit → jscpd re-measure.
- ★ Strict tsc loop after any `mcp-connectors/shared/` change (none expected in Wave A — helpers are file-local/gateway/cli) — but run per-package tsc on each touched connector.
- `git checkout -- docs/structure-audit/` before every commit.
- Ship gates before first push: full preflight + coverage-floor (Docker/local) + markdownlint + lychee (if docs) + whole-branch review.

## Ship sequence

Land A1–A6 (commit per target, jscpd re-measure), then re-measure final strict % (expect ~3.8%); **do not lower the ratchet this wave** (leave 4.0; tighten at program end after C). Open the Wave A PR.
