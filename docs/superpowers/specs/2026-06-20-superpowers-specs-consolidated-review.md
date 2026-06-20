# Consolidated Review & Suggestions: 2026-06-20 Superpower Design Specs

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-20  
**Target Specifications:** 13 Design Specs dated 2026-06-20 in `docs/superpowers/specs/`

This document provides a consolidated architectural review, highlighting structural conflicts, database migration sequence conflicts, security invariant number collisions, open questions, and concrete recommendations for the 13 superpower specifications.

---

## 1. Global Monorepo Conflicts & Sequencing

Because these 13 specifications were authored in parallel, they exhibit collisions in sequential numbering systems (Security Invariants and Database Migrations) and CLI namespace usage.

### A. Security Invariant Numbering (I28 and Beyond)
Currently, the main branch ceiling is `I27` (with `I28` reserved on branch `dev/asafgolombek/phase7-mcp-gateway-server` for the MCP-server owner-sink). 
Almost every spec targeting a new security invariant attempts to claim `I29`. To avoid integration failures, we must resolve this collision with a unified sequencing plan:

| Spec / Subsystem | Proposed Invariant ID | Invariant Statement / Responsibility |
| --- | --- | --- |
| *MCP Gateway Server* | **I28** *(Reserved)* | Owner-sink consent re-routing core. |
| **Proactive Watch Daemon** | **I29** | Proposal taint barrier (untrusted inputs force HITL). |
| **Egress Ledger** | **I30** | Egress-ledger completeness over the executor chokepoint. |
| **Encrypted Envelope Relay** | **I31** | Relay Opacity (relay gets opaque NaCl-box ciphertext + key hashes only). |
| **Air-Gapped Edition** | **I32** | Strict offline spawn guard (cloud connectors blocked at spawn boundary). |
| **Recipe Marketplace** | **I33** | Recipe Verification (install verification + read-only execution). |

### B. Database Migration Sequencing (V44 and Beyond)
The current migration schema ceiling is `V43` (at `packages/gateway/src/index/migrations/runner.ts`). Multiple specs assume they will claim `V44`. The following sequence is proposed:

| Schema Version | Subsystem | Tables Added |
| --- | --- | --- |
| **V44** | **Proactive Watch Daemon** | `watch_daemon_config`, `incident_record` |
| **V45** | **Egress Ledger** | `egress_ledger` |
| **V46** | **Recipe Marketplace** | `recipe_index` |
| **V47** *(Optional)* | **Encrypted Envelope Relay** | `relay_inbound_pending` *(spool for offline envelopes; defer if YAGNI holds)* |

---

## 2. Individual Spec Reviews & Feedback

### §2.1. Proactive `nimbus watch` Daemon
* **CLI Namespace Collision (Open Question 7):** Keeping both the old connector-watcher (`watcher.list`, etc.) and the new proactive daemon (`watch status`, `brief`) under `nimbus watch` will confuse users. 
  * *Recommendation:* Keep `nimbus watch` for this new proactive daemon (since it fits natural language better). Rename the developer-oriented connector-watcher CLI group to `nimbus hook` or `nimbus events` (and mapping to `watcher.*` RPC), or keep them completely separate.
* *Suggestion:* For daily briefing triggers, support a `--timezone` override in config to prevent issues if the Gateway process runs on a remote VM set to UTC, but the user is local.

### §2.2. GitHub PR Checks (App / Action)
* **Forked PRs & Token Limits (Open Question 4):** Standard GitHub Action workflows triggered on `pull_request` from forks do not have write access for security reasons (meaning the comment post will fail with a `403`).
  * *Suggestion:* Document explicitly that for public repos/fork support, users should configure a workflow using `pull_request_target`. However, warning documentation must detail the security risks of checking out untrusted fork code alongside local gateway queries.

### §2.3. Mobile Approval Companion
* **Owner-Sink Contention (Open Question 2):** If Tauri (desktop) and iOS are open, last-writer-wins could lead to the desktop window losing focus.
  * *Suggestion:* Modify the `ConsentCoordinator` to support multiple registered owner-sinks simultaneously (broadcasting HITL requests to all active sinks, and the first to respond wins, canceling the prompt on other active sinks). This avoids race conditions and improves multi-device UX.

### §2.4. Recipe Marketplace
* **Client-Side Ratings Complexity (Open Question 4):** Collecting all ratings client-side from static buckets is resilient but slow.
  * *Recommendation:* Defer ratings entirely to a later sub-slice. Focus first on signed metadata verification and install-time HITL.
* *Suggestion:* Add an automated CLI command `nimbus recipes check-connectors <recipe-id>` to query if the local gateway has all required connectors set up *before* attempting installation.

### §2.5. Egress Ledger (`nimbus prove`)
* **Read-Action Coverage (Open Question 2):** The spec notes a critical risk: if some read dispatches bypass the `ToolExecutor`, the ledger will miss them, invalidating "zero egress" claims.
  * *Action:* We must audit `connectors.dispatch` sites.
  * *Suggestion:* Add a static lint/structure rule that forbids direct imports or calls to `connectors.dispatch` outside of `ToolExecutor` (enforced via `check-nimbus-invariants.ts`).

### §2.6. Cloud Federation Relay
* **Metadata Linkability (Open Question 3):** Using a stable salted key-hash allows the relay operator to map network topology.
  * *Recommendation:* Keep the stable hash for v1, but clearly flag it in the design's "Privacy Disclosures". Shift to rotating Ephemeral Routing Keys (ERKs) derived from the pairing key in a subsequent slice.

### §2.7. Vertical Personas
* **Lineage as the Headline (Open Question 2):**
  * *Recommendation:* For `nimbus dataeng`, prioritize lineage impact tracking. This leverages the V40 lineage graph, highlighting Nimbus's cross-source advantage.

### §2.8. Air-Gapped Edition
* **Mail Bridge Exception (Open Question 1):**
  * *Recommendation:* Keep mail connectors classified as `cloud` (blocked). A strict air-gap profile must prevent socket binds/connects to non-localhost mail bridges unless explicitly overridden by an enterprise-wide signed policy (I22).

### §2.9. Auto-Postmortem Forensics
* **Timeline Linking (Open Question 1):** Deploy-to-PR links can be brittle.
  * *Suggestion:* Provide a `--commit-range` override to manually anchor timeline searches when automatic merge-commit correlation fails.

### §2.10. Standup Review Generator
* **Command Output Format (Open Question 3):**
  * *Recommendation:* Support plain Markdown copy-paste. String conversion to Slack mrkdwn is acceptable, but full Slack Block Kit payload integration is a non-goal for v1.

### §2.11. Browser Web-Clipper
* **Direct Write vs. Review Queue (Open Question 1):**
  * *Recommendation:* Web-clipper writes should go directly into the index but be flagged as `source: web_clipper`. This keeps the flow fast while allowing users to filter searches.

### §2.12. Embeddable SDK
* **Binary Distribution Responsibility (Open Question 2):**
  * *Recommendation:* The documentation must prominently display AGPL licensing requirements. Third-party developers embedding the client must understand their obligations regarding shipping the gateway binary.

### §2.13. Adoption Surfaces Bundle
* **Derived Summary Focus (Open Question 1):**
  * *Recommendation:* Implement the CLI compliance view first (`nimbus audit policy`). Extend the Tauri settings page as a follow-up.
