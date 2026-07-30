# Design Review: P6 Bypass-actor Audit Implementation Plan

This document contains a design review of the [2026-07-30-p6-bypass-actor-audit.md](./2026-07-30-p6-bypass-actor-audit.md) implementation plan, detailing open questions, suggestions, and potential improvements.

---

## 1. Open Questions

### 1.1. Uncaught JSON Parsing Errors in Loaders

In Task 1 (Step 4), `loadDeclaredBypass` reads `general-branch.json` and immediately parses it:

```ts
export function loadDeclaredBypass(repoRoot: string): DeclaredBypassFile {
  const raw = readFileSync(join(repoRoot, ".github/rulesets/general-branch.json"), "utf8");
  return JSON.parse(raw) as DeclaredBypassFile;
}
```

* **The Question**: If `general-branch.json` contains a syntax error (e.g., a trailing comma or a merge conflict marker), this will throw a raw `SyntaxError` and crash the process with a stack trace. Is this intentional, or should we handle JSON parsing failure gracefully with a structured error message?
* **Suggestion**: Wrap the `JSON.parse` in a try-catch block and return/print a clean, descriptive error message indicating that `general-branch.json` has invalid JSON syntax, mirroring the parsing safety implemented for the attestation file.

### 1.2. CLI Help/Usage Information

The CLIs in Task 3 and Task 4 check `argv` directly but do not provide help information:

* **The Question**: If the user runs `bun run audit:bypass-actors --help` or passes invalid/unexpected arguments, how should the tools respond?
* **Suggestion**: Add a simple argument check. If the CLI receives `--help` or `-h`, it should print a brief description of the tool, its flags (e.g., `--attest`, `--strict`), and exit.

---

## 2. Improvements & Suggestions

### 2.1. Robustness of the `attested_by` login resolution

In Task 3 (Step 5), Gate 1's CLI queries the authenticated user:

```ts
const who = runGh(["gh", "api", "user", "--jq", ".login"]);
```

* **Improvement**: If this API query fails (e.g., due to rate limiting or restricted token scopes), `who.ok` is `false`, and it defaults to `"unknown"`. We should also strip any trailing whitespace/newlines from `who.stdout` if `who.ok` is `true` (which the plan currently does via `.trim()`). However, to make local offline testing of the `--attest` flag easier, we can also check if a fallback environment variable (like `USER`, `USERNAME`, or `GITHUB_ACTOR`) is set before falling back to `"unknown"`.

### 2.2. Standardize Grace Window Extraction

* **Improvement**: In `check-bypass-attestation.ts`, `graceDays` is passed into `evaluateAttestation` from the loaded config. To make the test setup in `check-bypass-attestation.test.ts` more robust, ensure that the schema check for `attestation_grace_days` (such as checking if it is an integer > 0) is also enforced when initializing the input, or verify that the validator `validateDeclaredBypass` is called prior to checking the attestation in the CLI entry point.
