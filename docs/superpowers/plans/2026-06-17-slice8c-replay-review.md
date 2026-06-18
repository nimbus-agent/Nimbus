# Phase 6 Slice 8c — Replay — Plan Review

We have reviewed the implementation plan for **Phase 6 Slice 8c — Replay** (`2026-06-17-slice8c-replay.md`). The plan is highly detailed, robust, and correctly addresses the core requirements—particularly the security-critical positive allowlist for read-only tools.

Below is an analysis of minor improvements, suggestions, and edge cases to ensure a smooth implementation.

---

## 1. Suggestions & Code Improvements

### A. CLI Verification Error Reporting in Replay Path

In **Task 7**, the updated CLI command `runVerifyShare` handles the `--replay` flag. If verification fails (`!r.verify.ok`), it sets `process.exitCode = 1` but does not print the validation errors, unlike the standard path which outputs `r.errors.join("; ")`.

* **Suggestion**: Print verification errors in the replay path so users understand why a share is invalid (e.g., expired signature, tampered body).
* **Code Adjustment**:

  ```typescript
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
      console.error(r.verify.errors.join("; ")); // <--- Print verification errors
      process.exitCode = 1;
    }
    return;
  }
  ```

### B. CLI Error Handling for Local File Reads

In **Task 7**, `runVerifyShare` reads local files via `await Bun.file(input).bytes()` without a try-catch. If a user runs `nimbus verify-share non_existent_file.json`, the CLI will crash with an unhandled exception.

* **Suggestion**: Wrap the local file read in a `try/catch` block and output a user-friendly error message before exiting cleanly.

### C. Test Helper Name Mismatch (Task 5, Step 1)

The test draft in **Task 5, Step 1** calls a helper `signedShare()`. However, the helper defined at `packages/gateway/src/share/verify-share.test.ts:106` is named `signedRecipeShare()`.

* **Improvement**: Change the test invocation in Task 5 to use `signedRecipeShare()` to prevent test compilation failures.

### D. Read-Only Verbs Suffix Expansion

The positive allowlist `READ_VERBS` in `read-tool-registry.ts` covers the standard verbs (`list`, `get`, `query`, `search`, `read`, `fetch`, `download`, `describe`, `preview`, `history`, `export`, `view`, `show`).

* **Improvement**: Consider adding `info`, `status`, `metadata`, and `exists` to the `READ_VERBS` set. These are common read-only operations (e.g., checking if a resource exists or retrieving status/metadata) that do not perform writes. Adding them will improve replay coverage for connectors that utilize these suffixes.

---

## 2. Open Questions & Design Considerations

### A. Redacted Parameters during Replay

Replay executes tool calls with parameters (`s.params`) recorded in the shared recipe/transcript. Under Slices 8a and 8b, PII and secret redaction is applied to these parameters before they are saved to the log or shared.

* **Question**: If a required parameter (such as a database query, file path, or record ID) is redacted or modified, the local tool execution is likely to throw an API validation or lookup error.
* **Impact**: Such failures will be classified as `error` or `diverged` instead of `match`. Implementers should be aware that parameter redaction will naturally cause some steps to diverge/error during replay, which is expected behavior rather than a bug in the runner.

### B. Local Authentication Requirement

Replay executes tools against the local connector mesh, which means the local operator must have active connections and credentials configured for the target services.

* **Consideration**: Ensure that if a service has no active credentials, the connector/tool execution returns `unavailable` or throws gracefully (classified as `missing-connector` or `error` respectively).

---

## Summary

The proposed plan is solid, and the positive allowlist implementation is an excellent security measure. Incorporating the above suggestions (especially the CLI verification error reporting and try/catch on file reads) will make the feature production-ready and user-friendly.
