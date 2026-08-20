# Design Review: Nimbus distribution program (2026-08-19)

This document reviews [2026-08-19-nimbus-distribution-program-design.md](./2026-08-19-nimbus-distribution-program-design.md) and captures questions, improvements, and suggestions.

---

## 1. Zero-Config Wedge (`nimbus why`) & Local-Only Capabilities

### Clarifying the onboarding experience without external LLMs

- **Observation:** Section 1 states that the wedge (`nimbus why <file>:<line>`) is "free of every prerequisite (no LLM, no API key, no cloud account, no credentials)".
- **Question:** Does `nimbus why` function completely locally using pre-indexed code symbols, git blame history, and structural imports, or does it require a local LLM runner (like Ollama)?
- **Suggestion:**
  - If it is fully static/deterministic: Ensure the output format is clearly structured to highlight this (e.g., displaying the last 3 commit summaries, dependents/dependencies, and active authors).
  - If it expects a local model: The CLI should gracefully detect if Ollama (or similar) is missing or unconfigured and guide the user on how to start it, rather than throwing a raw error.

---

## 2. Scaffold Completeness & CI Invariants

### Ensuring new connector scaffolding is truly "plug-and-play"

- **Observation:** Section 2, Rung 1 mentions verifying if the scaffold emits every type-coupled registration site a new connector must touch.
- **Suggestion:**
  - We should write a validation step into `scripts/structure-audit/check-nimbus-invariants.ts` that fails if a new connector directory exists under `packages/mcp-connectors/` but is missing from the registry, config schemas, or manifest lists.
  - This ensures that if the scaffold is ever updated or if new registration sites are introduced in future versions, the build/PR check enforces registration consistency automatically.

---

## 3. npm Registry Rights & Launcher Publishing

### Mitigating hurdles around publishing `@nimbus-dev/mcp`

- **Observation:** `@nimbus-dev/mcp` is currently unpublished (404), causing a documentation discrepancy in `CLAUDE.md` and `GEMINI.md`.
- **Question:** Do we have administrative access to the `@nimbus-dev` npm organization, and is the token configured in our release secrets?
- **Suggestion:** Verify the publishing credentials and configuration inside `.github/workflows/` or `.release-please-config.json` before removing the blocker label. Add a checklist item to ensure package scope and access rights are locked down.

---

## 4. Guarding Hacktoberfest Against Spam

### Implementing structured rules for Rung 1 & 2 contributors

- **Observation:** Hacktoberfest is mentioned as highly aligned but carries a high risk of low-effort/spam pull requests.
- **Suggestion:**
  - Introduce a strict **"Issue Assignment Required"** policy in `docs/CONTRIBUTING.md`. Clearly state that PRs from outside contributors will only be reviewed/merged if they were explicitly assigned the corresponding issue beforehand.
  - Create a GitHub Action or issue template configuration that automatically replies to unassigned PRs, pointing them to the guidelines.

---

## 5. SLAs & Response Automation

### Helping maintainers meet the 72-hour response target

- **Observation:** A key commitment is a published 72-hour first-response target on new issues and PRs.
- **Suggestion:**
  - Set up a lightweight, scheduled GitHub Action (e.g., using `actions/stale` or a custom query) that flags issues or PRs approaching the 60-hour mark without maintainer activity.
  - This alert can add a label like `needs-maintainer-eyes` or post a notification via an internal webhook to keep the SLA from slipping.
