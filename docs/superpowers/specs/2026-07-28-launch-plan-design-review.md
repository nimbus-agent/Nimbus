# Design Review: Nimbus launch — prove-then-launch

This document reviews [2026-07-28-launch-plan-design.md](./2026-07-28-launch-plan-design.md) and notes questions, suggestions, and improvements.

---

## 1. Automated "Quickstart Smoke Test" in CI

### Preventing regression of the quickstart experience

- **Observation:** The indexing bug in PR #895 slipped through because tests used a fake `syncFilesystem` and a fake gateway. Gate 1 addresses this by manually verifying the real installation on clean Windows, Linux, and macOS environments.
- **Question:** Once Gate 1 passes, how do we prevent future changes from silently breaking the quickstart path?
- **Suggestion:** Translate the manual Gate 1 steps into an automated "smoke-test" workflow in CI (e.g. `.github/workflows/smoke-test.yml`):
  - Triggered on PRs and release candidates.
  - Spins up isolated runners (Ubuntu, Windows, macOS).
  - Downloads the compiled binary or executes `install.sh`/`install.ps1`.
  - Runs `nimbus init` and `nimbus why` on a small, real test repository checked out during the workflow.
  - Asserts exit codes and verifies that the SQLite database has been successfully initialized and populated.

---

## 2. Defining Zero-Config Fallback & "Aha" Mechanics

### Verifying the experience without credentials/LLMs configured

- **Observation:** The quickstart sequence executes `nimbus why <file>:<line>` with "no LLM and no credentials configured" to verify the deterministic onboarding flow.
- **Question:** What is the exact expected behavior and user experience of `nimbus why` in this zero-config state?
  - If it requires an LLM to generate an explanation, does it fail with a clean prompt instructing the user to configure one?
  - Or does it perform a local-only, template-based structural explanation (e.g. listing local imports, active files, and Git log context) from the index?
- **Suggestion:**
  - Define a high-quality "local-only" fallback for `nimbus why` when no LLM is configured. It should display a summary of what the index *knows* about the target file/line (e.g., dependents, active developers, recent commits affecting that line). This shows that the tool works locally and has successfully analyzed the repo, even without a cloud API key.
  - Include a clear, aesthetically pleasing console UI block pointing to instructions for adding a local LLM (Ollama) or cloud provider keys.

---

## 3. Voluntary Debug Diagnostics Command

### Gathering troubleshooting data without telemetry

- **Observation:** Nimbus has a strict no-telemetry constraint, meaning Gate 2 (private alpha) feedback is voluntary. If a tester's install fails silently or hits an OS-specific edge case (e.g., Windows PATH environment changes, Bun SQLite driver errors), troubleshooting via text messages is highly inefficient.
- **Suggestion:** Introduce a diagnostic command: `nimbus debug-report`.
  - This command runs basic diagnostic checks: prints OS version, Bun version, node path, checks read/write permissions on the Nimbus configuration folder, audits configuration schema, and checks log sizes.
  - It outputs a sanitized, shareable Markdown summary (redacted of personal paths, repo names, or secrets) that testers can copy-paste into an issue or direct message.
  - Mention this command in the onboarding / Gate 2 tester instructions as the primary way to report unexpected bugs.

---

## 4. Connector Audit & Tiering

### De-risking the "80+ cloud services" claim

- **Observation:** Gate 3 highlights the risk of the "80+ services" claim, warning that some connectors are stubs and that a user connecting a stub will suffer a trust hit.
- **Question:** Do we have a list of exactly which connectors are fully operational, which are read-only, and which are currently stubs?
- **Suggestion:**
  - Create a list of "Tier 1" (verified, fully active) connectors to promote during launch.
  - For any connector that is currently a stub or experimental, ensure the CLI or configuration loader handles it gracefully (e.g., showing a warning message like `"Connector <name> is experimental/in-development"` instead of crashing or failing silently).
  - Run a lightweight script `scripts/audit-connectors.ts` to map the connector manifest to implemented tool endpoints, validating the claim before launch.
