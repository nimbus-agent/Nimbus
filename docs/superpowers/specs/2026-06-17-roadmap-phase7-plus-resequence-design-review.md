# Review & Suggestions — Roadmap Phase 7+ Re-sequence & Idea Injection Design Spec

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-17  
**Target Spec:** `2026-06-17-roadmap-phase7-plus-resequence-design.md`

This document outlines feedback, architectural recommendations, and answers to open questions for the Roadmap Phase 7+ Re-sequence & Idea Injection Design Spec.

---

## 1. Recommendations & Improvements

### A. Exposing Nimbus as an MCP Server (S3) vs. Security Invariants (I5, I6, I13)

* **Context**: The design proposes exposing the private index as an MCP server for third-party IDE clients (e.g., Cursor, Claude Code).
* **Issue**: Operating as a local MCP server introduces new local communication vectors:
  1. **HTTP/SSE-based MCP** runs the risk of violating local network bind restrictions (`127.0.0.1`, I6) or bypass authentication rules (I13/HTTP write route restrictions) if local processes can arbitrary query the server.
  2. **Stdio-based MCP** is bound to the parent process lifecycle, which is safer, but still requires strict capability limits.
* **Recommendation**:
  * Explicitly specify that the local MCP server endpoint should default to **Stdio-based MCP** for local developer tools, avoiding the network port surface entirely.
  * If HTTP/SSE is supported, it must require pairing token exchanges (constant-time compared, I10) and honor the local-only bind rules (I6), adhering strictly to the `LanServer` method checks (I5).

### B. "Composes-With" Dependency Audit for Demoted/Promoted Phases

* **Context**: Waves in Phase 7 (W1–3) are demoted to S5, while other primitives (from Phase 14/22/27) are promoted to S1/S2.
* **Issue**: Many phases in `roadmap.md` contain "composes-with" cross-references to other waves/phases. Moving components across priority tracks without reviewing the dependent phases could create logical contradictions (e.g., a Phase in Track 2 stating it "composes with a Phase 8 security tool" which is now pushed back to S5).
* **Recommendation**: Include a step in the implementation plan to audit the "composes-with" lines of both promoted and demoted phases to ensure their prerequisite logic remains sound.

### C. Standardized Formatting for "Research Horizon" Primitives

* **Context**: Phases 21–27 (Track 3) will carry one-line extraction pointers to show what was pulled forward.
* **Recommendation**: Standardize the formatting in the Markdown to make it highly scannable. For example:

  ```markdown
  > **Research Horizon — Primitive Extracted:** The egress ledger and `nimbus prove` surface have been extracted to **Track 1 / S1** (Phase 7 W6).
  ```

  This keeps the layout consistent with the existing mature structure of `roadmap.md`.
