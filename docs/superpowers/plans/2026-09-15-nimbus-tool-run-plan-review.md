# Plan Review: `nimbus tool run` Implementation Plan (2026-09-15)

**Target Plan:** `2026-09-15-nimbus-tool-run.md`  
**Review Date:** 2026-09-15  
**Review Status:** Completed & Actionable  

---

## 1. Executive Summary

The implementation plan is structured logically, follows test-driven development (TDD) with explicit red/green steps, and properly decomposes the work into 6 cohesive tasks. It adheres to all global repository constraints: strict TypeScript with `exactOptionalPropertyTypes`, no schema migrations, no invariant creep, and maintaining model unreachability (`deps.toolgen` unsupplied).

This review identifies **three critical corrections** (including a TypeScript discriminator mismatch in the CLI tests and an ephemeral-vs-saved registry lookup bug), along with several concrete wiring and error-handling improvements to ensure zero friction during subagent execution.

---

## 2. Critical Findings & Required Fixes

### Finding 1: CLI Parsed Args Discriminator Typo (`kind` vs `sub`) in Task 5
In **Task 5 Step 1** (lines 585, 589):
```ts
// In Task 5 Step 1 test:
expect(parseToolArgs(["run", "t1", "--input", '{"q":"x"}', "--json"]))
  .toEqual({ kind: "run", toolId: "t1", input: { q: "x" }, json: true });

expect(parseToolArgs(["run", "t1"])).toMatchObject({ kind: "run", input: {} });
```
**Problem:** In `packages/cli/src/commands/tool.ts`, the discriminated union `ParsedToolArgs` uses **`sub`**, not `kind`:
```ts
export type ParsedToolArgs =
  | { readonly sub: "create"; ... }
  | { readonly sub: "list"; ... }
  | { readonly sub: "revoke"; ... }
  | { readonly sub: "save"; ... }
  | { readonly sub: "credential-set"; ... }
  | { readonly sub: "run"; readonly toolId: string; readonly input: Record<string, unknown>; readonly json: boolean };
```
`runTool` dispatches via `switch (parsed.sub)`. Using `kind: "run"` will break `ParsedToolArgs` typechecking and fail `switch (parsed.sub)`.

**Fix:** Update Task 5 tests and types to use `{ sub: "run", toolId: "t1", input: { q: "x" }, json: true }`.

---

### Finding 2: `ToolgenRegistry.findArtifact(toolId)` Finds Ephemeral Tools in Task 1
In **Task 1 Step 4** (lines 160-161):
```ts
const artifact = deps.registry.findArtifact(toolId);
if (artifact === undefined) return refuse(deps, toolId, ERR_TOOLGEN_NOT_SAVED);
```
**Problem:** `ToolgenRegistry.findArtifact(toolId)` (in `toolgen-registry.ts:77-79`) checks `#byId` (ephemeral tools) **before** `#saved`:
```ts
findArtifact(toolId): GeneratedToolArtifact | undefined {
  return this.#byId.get(toolId)?.envelope.artifact ?? this.#saved.get(toolId)?.artifact;
}
```
If an owner creates an ephemeral tool (`nimbus tool create`) that has **not** been saved, `findArtifact(toolId)` will return its ephemeral artifact. `invokeSavedTool` will proceed past the check and then attempt `spawnSavedTool(toolId)`, which will fail or throw unexpectedly instead of cleanly refusing with `ERR_TOOLGEN_NOT_SAVED`.

**Fix:** The saved-only check must inspect the saved collection:
```ts
const saved = deps.registry.savedTools().find((s) => s.toolId === toolId);
if (saved === undefined) return refuse(deps, toolId, ERR_TOOLGEN_NOT_SAVED);
const artifact = saved.artifact;
```
Or add a `getSaved(toolId: string): SavedToolEnvelope | undefined` / `findSavedArtifact(toolId: string)` method to `ToolgenRegistry`.

---

### Finding 3: `spawn(toolId)` Refusals vs Execution Failures in Task 2
In **Task 2 Step 3** (lines 318-327):
```ts
try {
  handle = await deps.spawn(toolId);
  const result = await handle.call(input);
  return succeed(deps, toolId, result, deps.now() - startedAt);
} catch (e) {
  return fail(deps, toolId, String(e), deps.now() - startedAt);
}
```
**Problem:** If `spawnSavedTool` throws a `ToolgenError` (e.g. `ERR_TOOLGEN_SIGNATURE_INVALID` from a tampered on-disk artifact, or `ERR_TOOLGEN_MANIFEST_SHAPE_INVALID`):
- Catching everything into `fail(...)` produces `status: "failed"` (exit code `1`, audit `outcome: "failed"`).
- According to spec §8, design spec §8, and `TOOL_EXIT_CODES`, pre-execution refusals (tampered signatures, invalid manifests) must be `status: "refused"` (exit code `127`, audit `outcome: "refused"`).

**Fix:** Distinguish `ToolgenError` from runtime execution errors in `catch`:
```ts
} catch (e) {
  if (e instanceof ToolgenError) {
    return refuse(deps, toolId, e.code, e.message);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return fail(deps, toolId, msg, deps.now() - startedAt);
}
```

---

## 3. Architecture & Dependency Plumbing Improvements

### Improvement 1: Provide Concrete `platform/assemble.ts` Wiring in Task 4
Task 4 Step 3 states "build it in `platform/assemble.ts` beside the existing toolgen wiring" without showing the concrete wiring.

To prevent guesswork during execution, specify the exact assembly block:

```ts
// In platform/assemble.ts:
const toolgenInvokeDeps: ToolgenInvokeDeps = {
  db,
  config: toolGenerationCfg,
  get enforced() {
    return policyGate.enforced();
  },
  registry: toolgenRegistry,
  spawn: async (toolId) => {
    const pubkeyB64 = await vault.get(TOOLGEN_SIGNING_PUBKEY);
    if (pubkeyB64 === null) {
      throw new ToolgenError(
        ERR_TOOLGEN_PUBKEY_UNAVAILABLE,
        "toolgen signing pubkey not found in Vault",
      );
    }
    const row = getSavedTool(db, toolId);
    if (row === null) {
      throw new ToolgenError(ERR_TOOLGEN_NOT_SAVED, `tool "${toolId}" is not saved`);
    }
    return spawnSavedTool(toolId, {
      configDir: paths.configDir,
      pubkeyB64,
      sessionId: CLI_TOOLGEN_SESSION_ID,
      row: { approvedAt: row.approvedAt },
      runtime: { requiredReadPaths: () => runtimeReadPaths },
      readVerifiedSavedTool,
      savedToolDir,
      rewriteSavedToolScript,
      spawn: (envelope) =>
        spawnGeneratedTool(
          envelope,
          toolgenBroker,
          dirname(envelope.scriptPath),
        ),
    });
  },
  audit: (entry) => appendAuditEntry(db, entry),
  now: () => Date.now(),
};

ipcOpts.toolgenRpcCtx = {
  ...ipcOpts.toolgenRpcCtx,
  invokeDeps: toolgenInvokeDeps,
};
```

---

### Improvement 2: Tool ID Safety Check (`assertCallerToolId`)
In `packages/gateway/src/ipc/toolgen-rpc.ts`, every caller-supplied tool ID is guarded by `assertCallerToolId(toolId)` (`toolgen.revoke`, `toolgen.credentialSet`) to prevent accessing reserved namespaces like `"signing"` or path traversal attempts.

In Task 4 Step 3, include `assertCallerToolId(toolId)` before calling `invokeSavedTool`:
```ts
"toolgen.invoke": async (params, ctx) => {
  const rec = asRecord(params) ?? {};
  const toolId = requireString(params, "toolId");
  assertCallerToolId(toolId);
  const rawInput = rec["input"];
  const input = rawInput === undefined ? {} : (asRecord(rawInput) ?? undefined);
  if (input === undefined) {
    throw new ToolgenRpcError(-32602, "input must be a JSON object");
  }
  return invokeSavedTool({ toolId, input }, ctx.invokeDeps);
},
```

---

### Improvement 3: CLI Parser and Helper Structure in Task 5
In `packages/cli/src/commands/tool.ts`:
1. **Parser Implementation (`parseRunArgs`):**
   ```ts
   function parseRunArgs(rest: readonly string[]): Extract<ParsedToolArgs, { sub: "run" }> {
     const toolId = rest[0];
     if (toolId === undefined || toolId.startsWith("--")) {
       throw new Error(`nimbus tool run: a tool id is required\n${USAGE}`);
     }
     let input: Record<string, unknown> = {};
     let json = false;
     const cur = flagCursor(rest.slice(1));
     while (cur.more()) {
       const flag = cur.peek();
       switch (flag) {
         case "--input": {
           const raw = cur.valueFor(flag);
           let parsed: unknown;
           try {
             parsed = JSON.parse(raw);
           } catch (e) {
             throw new Error(`nimbus tool run: --input must be valid JSON\n${USAGE}`);
           }
           if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
             throw new Error(`nimbus tool run: --input must be a JSON object\n${USAGE}`);
           }
           input = parsed as Record<string, unknown>;
           break;
         }
         case "--json":
           json = true;
           break;
         default:
           throw new Error(`Unknown flag: ${flag}\n${USAGE}`);
       }
       cur.step();
     }
     return { sub: "run", toolId, input, json };
   }
   ```
2. **Outcome Rendering & Exit Codes:**
   Define exported helper functions matching `exitCodeForTool` and `exitCodeForSave`:
   ```ts
   export function exitCodeForInvoke(outcome: ToolInvokeOutcome): number {
     if (outcome.status === "executed") return 0;
     if (outcome.status === "failed") return 1;
     return TOOL_EXIT_CODES.refused;
   }

   export function renderToolInvokeOutcome(
     outcome: ToolInvokeOutcome,
     sink: OutcomeSink,
     json: boolean,
   ): void {
     if (outcome.status === "executed") {
       if (json) {
         sink.out(`${JSON.stringify(outcome.result, null, 2)}\n`);
       } else if (typeof outcome.result === "string") {
         sink.out(`${outcome.result}\n`);
       } else if (outcome.result !== undefined && outcome.result !== null) {
         sink.out(`${JSON.stringify(outcome.result, null, 2)}\n`);
       } else {
         sink.out("(no output)\n");
       }
       return;
     }
     if (outcome.status === "failed") {
       sink.err(`nimbus: tool execution failed: ${outcome.error}\n`);
       return;
     }
     sink.err(`nimbus: refused (${outcome.code}${outcome.reason ? `: ${outcome.reason}` : ""})\n`);
   }
   ```

---

## 4. Test Matrix & Verification Checklist

Ensure the test suites cover all edge cases across tasks:

| Test Location | Test Case | Target State |
|---|---|---|
| `toolgen-invoke-gate.test.ts` | Config disabled -> `ERR_TOOLGEN_INVOKE_DISABLED` | Refusal |
| `toolgen-invoke-gate.test.ts` | Org policy disabled / `enforced === undefined` -> `ERR_TOOLGEN_INVOKE_POLICY_DISABLED` | Refusal |
| `toolgen-invoke-gate.test.ts` | Ephemeral-only tool or unknown ID -> `ERR_TOOLGEN_NOT_SAVED` | Refusal |
| `toolgen-invoke-gate.test.ts` | Non-object input or missing `required` schema keys -> `ERR_TOOLGEN_INPUT_INVALID` | Refusal |
| `toolgen-invoke-gate.test.ts` | `spawnSavedTool` throws `ERR_TOOLGEN_SIGNATURE_INVALID` | Refusal |
| `toolgen-invoke-gate.test.ts` | Successful execution returns `{ status: "executed", result, durationMs }` | Success |
| `toolgen-invoke-gate.test.ts` | Tool body throw returns `{ status: "failed", error, durationMs }` | Failure |
| `toolgen-invoke-gate.test.ts` | Concurrent invocations on SAME toolId are serialised | Concurrency |
| `toolgen-invoke-gate.test.ts` | Invocations on DIFFERENT toolIds run concurrently | Concurrency |
| `toolgen-invoke-gate.test.ts` | Audit row written with `actionType: "tool.invoke"`, no input/output in payload | Audit |
| `toolgen-rpc.test.ts` | `toolgen.invoke` dispatches, validates params, rejects reserved `"signing"` | IPC |
| `lan-rpc.test.ts` | `toolgen.invoke` is in `test.each` and verified LAN-forbidden | Security |
| `tool.test.ts` | `nimbus tool run` CLI parser and outcome renderer (exit codes 0, 1, 127) | CLI |
| `toolgen-run.test.ts` | Integration: save -> run -> tamper signature -> run refused (I40) | Integration |
| `tool-run.e2e.test.ts` | E2E: real gateway subprocess over IPC socket | E2E |

---

## 5. Summary of Recommended Plan Edits

1. **Task 1:** Update `invokeSavedTool` to check `deps.registry.savedTools().find(...)` rather than `findArtifact(...)` so ephemeral tools cannot pass the saved-only check.
2. **Task 2:** In the `catch` block of `invokeSavedTool`, check `if (e instanceof ToolgenError)` to return `refuse(...)` rather than `fail(...)`.
3. **Task 4:** Add `assertCallerToolId(toolId)` in `toolgen.invoke` handler, and specify the concrete `assemble.ts` wiring snippet.
4. **Task 5:** Fix the test assertion discriminator from `{ kind: "run", ... }` to `{ sub: "run", ... }`, and define `parseRunArgs`, `exitCodeForInvoke`, and `renderToolInvokeOutcome`.
