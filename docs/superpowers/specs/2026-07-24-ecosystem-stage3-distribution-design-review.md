# Design Review: Ecosystem Stage 3 — Distribution

This document reviews [2026-07-24-ecosystem-stage3-distribution-design.md](./2026-07-24-ecosystem-stage3-distribution-design.md) and notes questions, suggestions, and improvements.

---

## 1. Marketplace Metadata & Character Limits

### Truncation of Package Description

- **Observation:** The proposed description for `package.json` is 231 characters. While the absolute maximum limit set by VS Code is 280 characters, search engines and the marketplace listing cards often truncate description fields at around 150–200 characters.
- **Suggestion:** To prevent mid-sentence truncation in search result previews, we should consider a slightly more compact version.
  - *Alternative (190 chars):* `"Private, local-first AI agent for on-call & platform engineers. Slash commands (/incident, /deploys, /owns, /blast) grounded in your local index with a signed, verifiable egress record."`

### Category Validation

- **Observation:** The categories list is updated to `["AI", "Chat"]`.
- **Check:** Ensure both `"AI"` and `"Chat"` are fully recognized as valid categories by the marketplace packager (`vsce`) at release time, as `vsce` will fail packaging if an unrecognized category is declared.

---

## 2. Trust Story & Egress Receipt Framing (Honesty Scoping)

### Egress Receipt Boundary

- **Observation:** The trust story highlights Nimbus's ability to maintain a signed, verifiable record of everything sent off the machine.
- **Suggestion:** To maintain strict honesty and prevent false security assumptions, the documentation must explicitly state the boundaries of the egress ledger:
  - It records all *agent-dispatched actions and tool executions* (via the coordinator/executor).
  - It is **not** a low-level network firewall and does not monitor raw TCP/IP sockets or direct HTTP calls made outside the agent framework (e.g., by third-party unsandboxed MCP servers or local system binaries).

---

## 3. Link Safety & Default Branches

### URL Target Branch Resilience

- **Observation:** The `ROADMAP.md` files point to `https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md`.
- **Question:** Is `main` confirmed as the default branch for `nimbus-agent/Nimbus`? If the repository switches default branches or moves the file, these links will break.
- **Suggestion:** If supported, use relative links for in-repo navigation, and verify that the target URL resolves dynamically or has a permanent redirect if the branch name shifts.

---

## 4. Maintenance of Client `ROADMAP.md` Files

### Version Number Staleness

- **Observation:** Section B templates a hardcoded version and status line (e.g., `@nimbus-dev/client 0.12.0`).
- **Suggestion:** Hardcoding specific minor/patch versions in multiple repositories introduces a high likelihood of documentation drift as client libraries get updated.
- **Alternative:** Keep the local slice description high-level and refer users to the releases page for active version numbers (e.g., *"Role: The typed IPC wrapper. Currently released on npm. Next here: The `why` hover UI (Stage 4)."*).

---

## 5. Legibility of the "why" Lens Teaser

### Teaser Distinction

- **Observation:** Teasing the upcoming `why` lens in the main README is a great way to show active development.
- **Suggestion:** Ensure the "why lens" teaser is clearly separated under an "Upcoming Features" or "Roadmap" header so that users installing the current version do not mistake it for a shipped feature, which could lead to negative marketplace reviews.
