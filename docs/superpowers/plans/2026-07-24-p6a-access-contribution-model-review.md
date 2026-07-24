# Design Review: P6a — Access & Contribution Model (core) Implementation Plan

This document reviews [2026-07-24-p6a-access-contribution-model.md](./2026-07-24-p6a-access-contribution-model.md) and captures suggestions, open questions, and improvements.

---

## 1. Workflow Optimization & Token Minting

### Consolidating Sweep Jobs

- **Observation:** In Task 5 (Step 2), the plan adds two completely separate jobs (`org-settings-drift` and `team-reachability`) to `org-drift-sweep.yml`. Each job performs Checkout, Setup Bun, and Mint App token steps independently.
- **Suggestion:** Since all three jobs (`ruleset-drift`, `org-settings-drift`, and `team-reachability`) execute fast (under 10s of actual runtime) but incur ~1–2 minutes of GitHub Actions runner setup overhead and hit GitHub App token rate/mint limits, consider consolidating them into a single `org-drift-sweep` job with sequential steps:
  1. Setup environment (Checkout + Setup Bun + Mint Token).
  2. Step: `Audit rulesets` (`bun run audit:ruleset-drift --strict`).
  3. Step: `Audit org settings` (`bun run audit:org-settings-drift --strict`).
  4. Step: `Audit team reachability` (`bun run audit:team-reachability --strict`).
  
  This reduces GHA usage, avoids rate-limiting risks from multiple concurrent token mint operations, and simplifies workflow maintenance.

---

## 2. GitHub Actions SHA Pin Verification

### Checkout Action Version Comments

- **Observation:** Under Task 5 (Step 2), the checkout step is listed as:
  `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- **Question:** The comment mentions `# v7.0.1`, but the official `actions/checkout` is currently at `v4.x` (e.g. `v4.1.7`). We should verify if this comment has a typo or if a mock pin was used, to keep documentation and comments accurate.

---

## 3. Configuration Validation & Schema Checks

### JSON Formatting and Syntax in `.github/org-access.json`

- **Observation:** In Task 2 (Step 1), the JSON structure uses standard formatting.
- **Suggestion:** In `check-org-settings-drift.ts`, add a quick fallback check in `loadOrgAccess` to handle JSON parse errors gracefully, printing a clear syntax/error warning if `.github/org-access.json` contains invalid JSON or comments (since comments in JSON files are technically non-standard, though `JSON.parse` is used directly in the script). If we need comments in `.github/org-access.json`, we should ensure the parse logic doesn't break if a user writes standard JSON-incompatible structures.
