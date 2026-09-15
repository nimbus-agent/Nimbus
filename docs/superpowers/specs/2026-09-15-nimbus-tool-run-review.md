# Design Review: `nimbus tool run` (2026-09-15)

**Target Spec:** `2026-09-15-nimbus-tool-run-design.md`  
**Review Date:** 2026-09-15  
**Review Status:** Completed & Actionable  

---

## 1. Executive Summary

The design for `nimbus tool run` is well-scoped, concise, and technically sound. It adheres strictly to the architectural constraints established in Spine S2:
- **Zero Invariant Drift:** Re-uses and exercises invariant **I40** (pre-execution signature verification via `readVerifiedSavedTool`) rather than introducing new invariants.
- **Strict Scope Boundary:** Preserves the CLI/owner-only boundary (model cannot call generated tools; `deps.toolgen` remains unsupplied to `engine/agent.ts`), matching the precedent set by `nimbus exec` (I33).
- **Correct Security Posture:** Closes the audit visibility gap by recording direct `"tool.invoke"` audit rows, avoids process pooling to guarantee fresh on-disk signature checks immediately before execution, and keeps the namespace LAN-forbidden and excluded from Tauri.

This review outlines specific open questions, ambiguities, and concrete technical improvements that should be incorporated into the design or implementation plan before writing code.

---

## 2. Open Questions & Ambiguities to Resolve

### Q1: Exact IPC Contract (`toolgen.invoke`)
The design states `toolgen.invoke(toolId, args)` in the text, but the exact JSON-RPC request and response shapes need formal definition:

1. **Request Payload:**
   ```ts
   export interface ToolgenInvokeParams {
     readonly toolId: string;
     readonly input?: Record<string, unknown>;
     readonly sessionId?: string;
   }
   ```
   - **Naming:** Is the parameter named `input` (matching the CLI `--input` flag and `inputSchema`) or `args` (matching `handle.call(args)`)? Standardizing on `input` in IPC and CLI is recommended.
   - **Session ID:** `SavedSpawnDeps` requires `sessionId: string` to track caller attribution without polluting the `#saved` sentinel. The CLI should pass `sessionId: "cli"` (`CLI_TOOLGEN_SESSION_ID`), while the gateway defaults to `"cli"` if omitted.
   - **Missing Input:** If `--input` is omitted, does it default to `{}`? (Recommended: yes, defaulting to `{}` so tools without required parameters can be run with `nimbus tool run <tool-id>`).

2. **Response / Outcome Shape:**
   Does `toolgen.invoke` return an outcome envelope (following `createGeneratedTool` and `saveGeneratedTool`), or return the raw result and throw RPC errors on failure?
   
   *Recommendation:* Follow the outcome union pattern established across `toolgen` and `exec`:
   ```ts
   export type ToolgenInvokeOutcome =
     | { readonly status: "executed"; readonly toolId: string; readonly result: unknown; readonly durationMs: number }
     | { readonly status: "failed"; readonly toolId: string; readonly error: string; readonly durationMs: number }
     | { readonly status: "refused"; readonly toolId: string; readonly code: string; readonly reason?: string };
   ```
   This cleanly distinguishes between a gateway-level refusal (e.g. invalid signature), a tool-level runtime execution error (e.g. JS error inside child), and a successful execution.

### Q2: Headless & Non-TTY Execution Support
In `commands/tool.ts`, `runCreateCmd` and `runSaveCmd` explicitly enforce `if (!deps.isInteractiveTty())` and refuse execution because human consent cannot be obtained via piped `y` or headless environments.

Since `nimbus tool run` has **no interactive HITL prompt** (§4.2, standing approval was already granted at `save` time):
- **Is `nimbus tool run` permitted in non-interactive / headless / piped scripts?**
- *Recommendation:* Yes, explicitly state in the spec that `nimbus tool run` **does NOT require an interactive TTY** and is fully functional in CI, shell scripts, and headless automations.

### Q3: CLI Exit Code Taxonomy
The spec defines control outcomes for `tool` commands in `TOOL_EXIT_CODES` (`denied: 126`, `refused: 127`), but `run` introduces an execution phase:
- Success -> `0`
- Refused by Gateway (capability disabled, policy disabled, signature invalid, tool not saved) -> `127` (`TOOL_EXIT_CODES.refused`)
- Tool Runtime Execution Error (tool body threw an unhandled error, network failure, or protocol timeout) -> `1` (or general failure exit code)

*Recommendation:* Explicitly specify exit code `1` for tool execution errors vs `127` for gateway refusals, avoiding ambiguity between "the gateway refused to run the tool" and "the tool ran but encountered an error".

### Q4: Input Validation against `inputSchema`
When the owner passes `--input '<json>'`:
- Should the gateway validate `input` against `artifact.inputSchema` before calling `handle.call(input)`?
- Or is validation handled inside the child script or by the tool body?

*Recommendation:* Perform light schema validation on the gateway side before spawning/calling:
- Verify `input` is a non-null, non-array object.
- If `inputSchema.required` has properties missing from `input`, refuse immediately with `ERR_TOOLGEN_INPUT_INVALID` without spawning a process.
- This gives instant, clear feedback to the CLI user before incurring subprocess spawn latency.

### Q5: Registry State for Saved Tools Spawned on Demand
In `platform/assemble.ts`, `toolgenBroker` resolves `approvedHostsFor` and `credentialHostsFor` using `toolgenRegistry.findArtifact(toolId)`.
- If a saved tool was skipped at gateway boot (e.g. unverified/repaired later) or if `loadSavedToolsIntoRegistry` was not called for it, does `spawnSavedTool` ensure `toolgenRegistry` holds the verified artifact so the broker can resolve its approved hosts during `nimbusFetch`?
- *Recommendation:* In `spawnSavedTool` or the invoke handler, ensure `toolgenRegistry.registerSaved(...)` is updated with the freshly verified artifact upon successful signature check.

---

## 3. Concrete Improvements & Technical Suggestions

### Suggestion 1: Follow the Gate Pattern (`toolgen-invoke-gate.ts`)
Following the pattern of `toolgen-gate.ts` (`createGeneratedTool`) and `toolgen-save-gate.ts` (`saveGeneratedTool`), encapsulate invocation logic into a dedicated gate module:
`packages/gateway/src/toolgen/toolgen-invoke-gate.ts`

```ts
export interface ToolgenInvokeDeps {
  readonly db: Database;
  readonly configDir: string;
  readonly config: Pick<NimbusToolGenerationToml, "enabled">;
  readonly enforced?: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  readonly vault: NimbusVault;
  readonly registry: ToolgenRegistry;
  readonly runtime: { readonly requiredReadPaths: () => readonly string[] };
  readonly spawn: (envelope: ToolgenEnvelope) => Promise<GeneratedToolHandle>;
  readonly now: () => number;
}

export async function invokeSavedTool(
  req: { toolId: string; input?: Record<string, unknown>; sessionId?: string },
  deps: ToolgenInvokeDeps,
): Promise<ToolgenInvokeOutcome>;
```

**Benefits:**
1. Isolates capability checks, database lookups, signature verification, audit logging, and process lifecycle in a single testable unit.
2. Keeps `ipc/toolgen-rpc.ts` purely focused on parameter extraction and JSON-RPC dispatching.
3. Allows unit tests to drive the entire invoke lifecycle with in-memory DB and fake vault/spawn.

### Suggestion 2: Standardize Error Codes in `toolgen-types.ts`
Define explicit error codes for invocation failures:
- `ERR_TOOLGEN_INVOKE_DISABLED` — `[tool_generation] enabled = false` in config.
- `ERR_TOOLGEN_INVOKE_POLICY_DISABLED` — `capabilitiesDisabled.has("tool_generation")` in org policy.
- `ERR_TOOLGEN_NOT_SAVED` — tool ID not found in `generated_tool` table (or is ephemeral-only).
- `ERR_TOOLGEN_PUBKEY_UNAVAILABLE` — Vault has no `toolgen.signing.pubkey`.
- `ERR_TOOLGEN_INPUT_INVALID` — `--input` is not valid JSON or fails required schema constraints.
- `ERR_TOOLGEN_EXECUTION_FAILED` — child process or tool body threw a runtime error.
- `ERR_TOOLGEN_EXECUTION_TIMEOUT` — child process failed to reply within protocol timeout (default 60s).

### Suggestion 3: CLI Output Formatting & Ergonomics
In `commands/tool.ts`:
1. **`--input` Parsing:**
   - If `--input` is passed, parse via `JSON.parse`. If parsing fails, throw `Error('nimbus tool run: --input must be valid JSON: ...\n' + USAGE)`.
   - If parsed value is not an object or is an array, throw `Error('nimbus tool run: --input must be a JSON object (e.g. \'{"key": "value"}\')\n' + USAGE)`.
   - If omitted, default to `{}`.
2. **Result Rendering:**
   - If `--json` flag is set: print `JSON.stringify(outcome.result, null, 2)` to stdout.
   - If `--json` flag is NOT set:
     - If `result` is a string: print `result\n` directly.
     - If `result` is an object/array: pretty-print `JSON.stringify(result, null, 2)\n`.
     - If `result` is undefined/null: print `(no output)\n`.
3. **Stderr & Stdio Handling:**
   - Since `spawnGeneratedTool` sets `stderr: "inherit"`, child `console.error` logs stream directly to terminal stderr.
   - If the tool fails or gateway refuses, write formatted error message with `nimbus:` prefix to `sink.err`.

### Suggestion 4: Audit Payload Precision & PII Safety
The spec states in §5:
> "One `audit_log` row per invocation, `actionType: "tool.invoke"`, written directly... The row records the tool id, the outcome, and the duration. It does not record the tool's output."

**Recommendation on Input Data:**
Do **not** record the raw `input` object in `actionJson`. Tool parameters could contain sensitive information (API parameters, email addresses, search terms).
The `actionJson` payload should strictly be:
```json
{
  "outcome": "executed" | "failed" | "refused_before_execution",
  "toolId": "tool_123",
  "durationMs": 42,
  "code": "ERR_TOOLGEN_...",
  "error": "..."
}
```
`hitl_status` must be `"not_required"` (matches `tool.save` for already-approved artifacts).

### Suggestion 5: Concurrent Invocations Safety
In `toolgen-saved-spawn.ts`, `spawnSavedTool` calls `rewriteSavedToolScript`, which writes to `<configDir>/toolgen/saved/<toolId>/index.ts` before spawning.
If two invocations of the same `toolId` occur concurrently:
- On Windows, overwriting `index.ts` while another child process has it open for `import()` could encounter transient `EBUSY` / file-lock errors.
- *Recommendation:* Consider checking if `index.ts` already exists with matching content, or use a temporary entry point / atomic rewrite to ensure concurrent executions on the same toolId do not collide.

---

## 4. Test Strategy & Verification Matrix

Ensure the test plan covers all layers:

| Layer | Test Location | Test Case |
|---|---|---|
| **CLI Parser** | `packages/cli/src/commands/tool.test.ts` | `parseToolArgs` parses `run <id> [--input <json>] [--json]`, handles invalid JSON and missing toolId |
| **CLI Outcome** | `packages/cli/src/commands/tool.test.ts` | `runTool` renders string output, JSON output, handles failures and sets exit codes 0, 1, 127 |
| **IPC Dispatch** | `packages/gateway/src/ipc/toolgen-rpc.test.ts` | `toolgen.invoke` dispatches correctly, asserts caller toolId, handles missing tool |
| **LAN Guard** | `packages/gateway/src/ipc/lan-rpc.test.ts` | `toolgen.invoke` is included in `test.each` and verified LAN-forbidden |
| **Tauri Boundary**| `packages/gateway/src/ipc/server/dispatchers.test.ts` | `ALLOWED_METHODS` count remains unchanged; `toolgen.invoke` is NOT exposed |
| **Invoke Gate** | `packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts` | Capability off, org policy disabled fail-closed, unknown tool refused, tampered signature refused (I40) |
| **Audit Log** | `packages/gateway/src/toolgen/toolgen-invoke-gate.test.ts` | Exactly 1 audit row written for executed, failed, and refused outcomes; no output leaked |
| **Integration** | `test/integration/toolgen/toolgen-run.test.ts` | End-to-end save -> run with mock broker and network fetch -> process close and audit validation |

---

## 5. Summary Checklist for Spec Update

- [ ] Clarify request parameter name as `input?: Record<string, unknown>` and default to `{}`.
- [ ] Define the response / outcome shape (`status: "executed" | "failed" | "refused"`).
- [ ] State explicitly that `nimbus tool run` is headless-capable and does not require an interactive TTY.
- [ ] Specify exit codes: `0` for success, `1` for tool runtime failure, `127` for gateway refusal.
- [ ] Clarify input validation rules against `inputSchema`.
- [ ] Formalize error codes in `toolgen-types.ts`.
- [ ] Specify `actionJson` audit payload fields and confirm omission of input/output data.
- [ ] Add `"toolgen.invoke"` to `lan-rpc.test.ts` test list.
