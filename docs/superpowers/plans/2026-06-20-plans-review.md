# Review of Implementation Plans (2026-06-20)

This document provides a detailed review of the following two implementation plans:

1. [Egress Ledger & nimbus prove Plan](file:///C:/gitrep/Nimbus/docs/superpowers/plans/2026-06-20-egress-ledger-nimbus-prove.md)
2. [Standup Generator Plan](file:///C:/gitrep/Nimbus/docs/superpowers/plans/2026-06-20-standup-generator.md)

---

## 1. Global Sequencing & Conflict Adjustments

### Migration Version Conflict (`V44` Schema)

- **Problem:** Both the **Egress Ledger** plan and the **Proactive Watch Daemon** design spec claim `V44` as their schema migration version (`simpleStep(43, 44, ...)`). Since migrations must be strictly contiguous and sequential, they cannot both occupy `V44`.
- **Recommendation:**
  - Whichever feature lands first should occupy `V44` (with schema version bumped to 44).
  - The second feature must be updated to `V45` (updating the migration runner to `simpleStep(44, 45, ...)` and schema version to 45).
  - If Egress Ledger lands first, it keeps `V44`, and the Watch Daemon will be adjusted to `V45`.

### Invariant & Static Check Numbering

- **Problem:** Egress Ledger uses **I30** and **D23** as sequence placeholders, while other specs mention **I28** (reserved for MCP-server owner-sink) and **I29** (daemon-proposal taint barrier).
- **Recommendation:**
  - Reconcile numbers sequentially during execution. If Egress Ledger lands before Watch Daemon:
    - Egress Ledger: Invariant **I29**, Static Complement **D22**.
    - Watch Daemon: Invariant **I30**, Static Complement **D23**.
  - All changes to `SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md`, and the test suites must be updated in a single coordinated commit for each feature.

---

## 2. Egress Ledger Plan Review

### Open Question: Total Dispatch Coverage (Task 1)

- **Observation:** Task 1 outlines a read-only audit to verify that `connectors.dispatch` is only invoked from `ToolExecutor.gate()`. This is a vital security chokepoint constraint.
- **Suggestion:** Enhance the static check (`D23`) to ensure no third-party MCP tool or custom wrapper can execute raw dispatch methods. If a new developer introduces a shortcut bypass in the future, the preflight static check (`check-nimbus-invariants.ts`) must catch it immediately.

### Suggestion: Egress Prune Default Retention

- **Observation:** `pruneEgress` accepts a `beforeTs` epoch timestamp.
- **Suggestion:** Standardize CLI ergonomics for retention pruning. For example, instead of only accepting `--before <ISO-date>`, the CLI could accept duration-based inputs like `nimbus egress prune --older-than 30d`. This aligns with the duration parser (`parseSince`) used in other subcommands.

### Architectural Note: Receipt Signing Key

- **Observation:** Reusing the Vault-only Ed25519 share keypair is smart as it avoids vault creep (no new key creation required).
- **Security Check:** Ensure the private seed is strictly confined to in-memory operations inside `packages/gateway/src/egress/egress-sign.ts` and never leaks to logs or database columns, adhering to Non-Negotiable #3.

---

## 3. Standup Generator Plan Review

### Headless & Remote Server Gaps

- **Observation:** The plan handles unresolved user identity by generating a `missing_user_identity` GapNote.
- **Improvement:** In a headless server setup (such as a remote production agent), OS-level usernames and git email configurations might not resolve to any local people database record.
- **Recommendation:** Ensure the remediation message printed by `nimbus standup` clearly instructs headless operators how to configure the `me_person_id` via environment variables (e.g., `NIMBUS_ME_PERSON_ID`) or config files so that automated cron triggers do not abort on identity gaps.

### Formatting CLI Transforms

- **Observation:** `--format slack` performs a pure string rewrite of Markdown to mrkdwn.
- **Validation:** This respects Non-Negotiable #5 and Invariant **I27** by keeping the render network-free (no external Slack API client call). The test suite includes a fetch-spy assertion, which is an excellent defense-in-depth practice.

### Suggestion: Sub-Agent Output Caching

- **Observation:** Reusing the five catchup sub-agents (owned services, active repos, incidents, collaborators, window items) via `AgentCoordinator` is computationally expensive because it scans SQLite tables for recent activity.
- **Suggestion:** Since the window is strictly 24 hours for a daily standup, investigate whether the sub-agents can leverage common query caching or indexed ranges, preventing redundant table scans when both `nimbus catchup` and `nimbus standup` are run sequentially.
