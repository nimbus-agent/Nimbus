# Design Review: S2 Slice 1 — Sandboxed Code Execution (2026-08-22)

Below are comments, questions, and suggested improvements for the `2026-08-22-s2-sandboxed-code-execution-design.md` specification.

> **Status: answered 2026-08-22.** All eight items accepted; see [§10 Review disposition](./2026-08-22-s2-sandboxed-code-execution-design.md#10-review-disposition-2026-08-22) in the design for the per-item outcome. Two amendments to what was asked: Q2's "DoS" framing was corrected to resource hygiene, and S3 was strengthened from an existence check to a read-once rule that closes a TOCTOU. Q3's concurrency half needed no change — the shared `ConsentBroker` base already supports concurrent approvals.

## Open Questions & Clarifications

1. **Resolution of Relative Paths for FS Grants**
   * **Context:** The CLI allows specifying `--allow-fs-read <path>` and `--allow-fs-write <path>`. Since the CLI interacts with the Gateway over JSON-RPC IPC, the paths must be correctly interpreted.
   * **Question:** If the user provides a relative path (e.g. `--allow-fs-read ./src`), will the CLI resolve it to an absolute path using the shell's current working directory before sending it to the Gateway, or will the Gateway resolve it? If the Gateway resolves it, how does it know the CLI's current working directory (which may differ from the Gateway daemon's `cwd`)?

2. **Output Stream Handling and Truncation Behavior**
   * **Context:** The configuration limits output size via `max_output_bytes` (default 1MB).
   * **Question:** When a sandboxed process produces output exceeding `max_output_bytes`, does the gateway immediately terminate the process (fail-closed to prevent CPU/IO denial of service), or does it continue execution and simply truncate the captured buffer? Terminating the process is safer to prevent runaway loops (e.g. `while(true) console.log("spam")`). We should clarify if truncation triggers process termination.

3. **Concurrency in the ExecConsentBroker**
   * **Context:** A user might run multiple scripts in parallel from different terminal windows.
   * **Question:** How does `ExecConsentBroker` handle concurrent execution requests? Are they queued, or can multiple approval prompts be active simultaneously? If the CLI receives a timeout from the broker, does it report a specific exit code to distinguish approval timeouts/rejections from script execution failures?

4. **Runtime Detection Logic**
   * **Question:** If `--file <path>` is provided without an explicit `--runtime` flag, how does the `ExecRuntime` registry select the runtime? Does it map file extensions (e.g. `.ts`, `.js` -> `bun`)? What is the behavior when an unrecognized extension is supplied, or when the requested runtime is in `allowed_runtimes` but missing from the local system?

5. **Local Network Loopback Restriction**
   * **Context:** The spec states `network: none` is unconditionally empty.
   * **Question:** Does `none` block loopback interface access (`localhost`, `127.0.0.1`) in the sandbox? Standard sandbox containers might still allow loopback unless explicitly configured otherwise. We should specify if loopback is blocked to prevent the sandboxed script from querying other local services or the Gateway itself.

## Suggested Improvements

1. **Explicit Hashing Algorithm for Output Digests**
   * **Suggestion:** Specify the hashing algorithm for `stdoutDigest` and `stderrDigest` (e.g., BLAKE3). This ensures alignment with the codebase's preference for BLAKE3 (as used in the I29 egress-ledger) and avoids ambiguity in implementation.

2. **Log FS Read/Write Grants in Audit Record**
   * **Suggestion:** In the audit entry (`actionJson`), explicitly include the resolved read/write path allowlists in the logged `grants` payload. This guarantees a complete audit trail of what parts of the filesystem the script was allowed to touch.

3. **Pre-spawn Validation of Script Files**
   * **Suggestion:** For `--file <path>` executions, the gate should verify the file's existence and readability before prompting the user for HITL consent. This prevents situations where a user approves a script execution, only for the runtime to immediately crash with a file-not-found error.
