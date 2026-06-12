# Phase 6 Slice 6b — Federated Action Requests — Design Review

This document lists open questions, suggestions, and potential improvements identified during the review of the [2026-06-11-phase6-slice6b-federated-action-requests-design.md](./2026-06-11-phase6-slice6b-federated-action-requests-design.md) specification.

---

## 1. Open Questions

### Q1: Janitor Resource Identifier Formatting & Provider Resolution

- **Context:** The Cloud Janitor queries peers content-free to see if they've touched a resource reference (e.g., `i-12345`). The design notes: "Cleanup: `nimbus run cloud.instance.terminate i-12345`".
- **Questions:**
  - How does the Janitor determine the exact cleanup action command format (`cloud.instance.terminate`) just from a string like `i-12345`? Is there a resource-type parsing logic (e.g., AWS vs GCP ARN/URN structures), or must the user supply the resource type alongside the reference?
  - What if a resource ref is short and matches false positives in local logs/databases (e.g. searching for a simple ID like `123` or `test` vs a globally unique ID)? Should we enforce a minimum length or format constraint on `resourceRef` to avoid incorrect idle status due to false hits?

### Q2: Janitor Strict Coverage vs. Offline/No-Grant Peers

- **Context:** The spec states: "gaps (unreachable / no_grant) are NEVER counted as idle; they suppress the proposal and are surfaced in the brief... The janitor proposes a cleanup only when every answering peer is clear and coverage is complete."
- **Questions:**
  - If a large team has 15 paired peers, and one team member is on vacation (machine offline) or has revoked access (`no_grant`), the Janitor will permanently withhold the cleanup proposal.
  - Should there be a command-line flag or config option (e.g. `--allow-gaps` or `--min-coverage 80%`) to allow proposing cleanups with a warning about incomplete coverage? Or is the "all-or-nothing" security model the absolute desired default with no bypass?

### Q3: Preflight CLI Exit Codes for CI/CD Pipelines

- **Context:** Upstream triggers `nimbus preflight HEAD~1..HEAD` to check downstream readiness before merging.
- **Questions:**
  - If the preflight command is used in pre-merge CI/CD checks, how does the CLI handle failures or missing configurations?
  - Will `nimbus preflight` return a non-zero exit code if any downstream fails, is unreachable, declines, or is not configured?
  - Should there be a `--strict` or `--permissive` flag to toggle whether gaps/unconfigured/declined downstreams fail the upstream CI build?

### Q4: Sandbox Permissions & Git Repository Access for Preflight Commands

- **Context:** Inbound preflight commands run in the sandbox (`createSandboxRunner`) with a "test dir only" manifest.
- **Questions:**
  - A test command typically needs access to the downstream repository code at the target `git ref`. If the sandbox is heavily restricted, does it have access to the local git working tree or does it clone to a temporary directory?
  - If `cwd` is specified in `nimbus.toml`, does `createSandboxRunner` automatically grant read/write access to that path? How are path traversal attacks prevented if a compromised upstream peer attempts to pass malicious path parameters?

---

## 2. Suggestions & Improvements

### S1: Strict Validation of GIT_REF / Param Sanitization

- **Problem:** Environment variables passed to sandbox runners (like `NIMBUS_PREFLIGHT_REF`) could contain shell metacharacters. If the downstream user's local script uses a shell or interpolates the env var, command injection is possible.
- **Suggestion:** We should define a strict regex allowlist for `ref` (e.g., `^[a-zA-Z0-9_/.-]+$`) and reject requests that do not conform. We should also enforce that the changed symbol/surface parameter contains only alphanumeric characters plus common code-symbol characters (like `.`, `:`, `_`).

### S2: Dry-Run Mode for Preflights

- **Problem:** When testing or bootstrapping a new preflight command, it is hard to verify if the local config works without initiating a real cross-peer request.
- **Suggestion:** Add a local dry-run or verification command, e.g., `nimbus preflight run-local <namespace> --ref <ref>`, which executes the configured command locally inside the sandbox with dummy environment variables. This allows developers to test their own test command setups before onboarding upstream peers.

### S3: Auditing Sandbox Boundary Violations

- **Problem:** Since we are running potentially heavy test suites, these tasks are much more demanding than lightweight MCP connector calls.
- **Suggestion:** Log sandbox resource utilization (e.g., CPU, memory, execution duration) in the `audit_log` alongside the preflight outcome, and enforce a strict default timeout (e.g., 5 minutes) on the sandbox runner.
