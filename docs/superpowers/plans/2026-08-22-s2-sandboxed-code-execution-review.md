# Implementation Plan Review: S2 Slice 1 — Sandboxed Code Execution (2026-08-22)

This document collects feedback, suggestions, and open questions on the [Sandboxed Code Execution (S2 Slice 1) Implementation Plan](./2026-08-22-s2-sandboxed-code-execution.md).

> **Status: answered 2026-08-22.** All four items accepted; see [Review disposition](./2026-08-22-s2-sandboxed-code-execution.md#review-disposition-2026-08-22) in the plan for the per-item outcome. Q1 was fixed more broadly than asked (a second, unnamed defect — per-chunk decoding of split multi-byte characters — fell out of it). Q3's suggested import path does not exist; the helpers are defined locally instead, and the shared-module extraction is explicitly deferred. Q4 needed no code change.

---

## 1. Open Questions & Suggestions

### Q1: Character Length vs. Byte Length in Output Cap Enforcer

In **Task 5 Step 3**, the `absorb` helper in `runConfined` checks the limit and slices the output using string lengths:

```ts
function absorb(chunk: unknown, into: "out" | "err"): void {
  const text = String(chunk);
  const room = opts.maxOutputBytes - bytes;
  if (room <= 0) return;
  const slice = text.length > room ? text.slice(0, room) : text;
  bytes += slice.length;
  ...
}
```

* **Issue:** `opts.maxOutputBytes` is configured in bytes (`max_output_bytes`), but `text.length` and `slice.length` measure JavaScript UTF-16 code units (characters). If the process outputs multi-byte characters (e.g., emojis or non-ASCII text), the memory buffer could hold significantly more bytes than `maxOutputBytes`, and the limit check may not trigger at the correct byte threshold. Additionally, slicing a string arbitrarily at a character boundary might still be fine, but if we process raw buffers/Uint8Arrays, we should ensure the byte accumulation is accurate.
* **Suggestion:** Accumulate bytes using byte length (e.g. `Buffer.byteLength(slice)` or converting `chunk` to a `Buffer` and checking `.byteLength` before decoding). If string-level approximation is acceptable, the plan should explicitly document that the cap is enforced on characters/code-units rather than raw bytes to avoid confusion.

### Q2: Scratch Directory Lifecycle and Error/Denial Cleanup

In **Task 7 Step 3**, the plan specifies writing a temporary directory/file when inline `--code` is used, and mentions cleanup:
> *Note the ordering consequence worth keeping: the scratch file is written before consent, so a denied execution leaves a temp file behind. Delete it in a finally block — a rejected body sitting in tmpdir() is code the owner explicitly refused to run.*

* **Suggestion:** Since the draft code for `runExecution` in Step 3 does not show the `try/finally` implementation for this cleanup, we should explicitly show it. Crucially:
  1. The scratch directory (`scratch.dir`) must be recursively removed (`fs.rmSync(scratch.dir, { recursive: true, force: true })`) in a `finally` block of `runExecution`.
  2. If the process is approved and spawned, the cleanup must happen *after* the process exits and stdout/stderr are read, not immediately after spawn (otherwise Bun won't be able to read the script file during execution).
  3. Ensure that if `runConfined` throws an error or rejects, the cleanup still executes.

### Q3: Import of Validation Helpers in IPC Module

In **Task 8 Step 3**, the handler for `exec.run` uses validation functions like `stringArray`, `requireString`, and `asRecord`:

```ts
fsRead: stringArray(rec["fsRead"]),
fsWrite: stringArray(rec["fsWrite"]),
cwd: requireString(params, "cwd"),
```

* **Suggestion:** Explicitly note in the plan to import these validation helpers from `packages/gateway/src/ipc/_lib/validation.ts` (or the appropriate internal IPC library file), to prevent compiler errors for the implementing agent.

### Q4: Validation of `runtimeId` Against `allowedRuntimes`

In **Task 7 Step 3**, `runExecution` checks:

```ts
if (!deps.config.allowedRuntimes.includes(runtime.id)) {
  throw new ExecGateError("ERR_EXEC_RUNTIME_NOT_ALLOWED", `runtime not allowed: ${runtime.id}`);
}
```

* **Observation:** The `allowed_runtimes` array in config contains string identifiers (e.g. `["bun"]`). If `req.runtimeId` matches a known runtime registry ID (like `"bun"`) but is not explicitly in `allowedRuntimes`, it is correctly blocked. However, we should make sure that case sensitivity doesn't lead to false mismatches (e.g. comparing `"Bun"` vs `"bun"`). The registry already lowercases IDs, but we should make sure `config.allowedRuntimes` is parsed/compared in lowercase format as well.
