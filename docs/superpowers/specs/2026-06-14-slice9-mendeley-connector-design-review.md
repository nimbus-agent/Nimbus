# Review & Suggestions — Mendeley Connector Design Spec

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-14  
**Target Spec:** `2026-06-14-slice9-mendeley-connector-design.md`

This document details open questions, design feedback, and recommended improvements for the Mendeley Connector Design Spec.

---

## 1. Open Questions & Scope Clarifications

### A. PDF / File Attachment Extraction

* **Context**: The spec states the connector indexes papers, PDFs, and citations. However, under "Non-goals (MVP)", annotations and highlights are excluded.
* **Question**: Is raw PDF text extraction (fetching the binary PDF attachments, running local text extraction, and indexing the full text) a goal for the MVP, or are we **only** indexing document metadata (title, authors, abstract)?
* **Recommendation**: If binary file indexing is a non-goal for the MVP, explicitly list "Full-text PDF attachment indexing" under **Non-goals (MVP)** to keep the scope bounded, aligning with the "documents metadata only" focus.

### B. Client Secret Management & Confidential OAuth Flow

* **Context**: The spec notes: `clientSecret: "required"`, `secretPlacement: "basic_header"`, `usesPkce: false (Elsevier confidential client)`.
* **Question**: Since Nimbus is a local-first client (CLI / Tauri), how are the `clientId` and `clientSecret` managed?
  * Do we expect users to register their own developer applications and supply these credentials via environment variables / configuration (e.g., `MENDELEY_CLIENT_ID` and `MENDELEY_CLIENT_SECRET`)?
  * Or is there a central first-party authentication proxy hosting the client secret?
* **Recommendation**: Clarify this in the **Auth** section. If user-supplied application credentials are required, describe the CLI configuration path (e.g., `nimbus config set` or environment loading).

---

## 2. Technical Suggestions & Edge Case Protections

### A. Link Header Parser Robustness

* **Context**: Mendeley paginates via standard RFC 5988 `Link` headers.
* **Suggestion**: Ensure the custom parser used in `mendeley-sync.ts` is robust against variations in whitespace, casing, quotes, and handles both relative and absolute links.
* **Example Regex/Pattern**:

  ```ts
  // Ensure we capture: <https://api.mendeley.com/documents?page=2>; rel="next"
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  const nextUrl = match?.[1];
  ```

### B. Cursor Handling & Date Formats

* **Context**: Incremental syncs will use `modified_since=<ISO>`.
* **Suggestion**: Document the exact date format Mendeley expects. Some APIs require millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`), while others fail unless it is stripped (`YYYY-MM-DDTHH:mm:ssZ`). The API contract should be explicitly mocked in `mendeley-sync.test.ts` to prevent serialization bugs.

### C. OAuth Token Refresh Handling

* **Context**: Mendeley OAuth tokens expire.
* **Suggestion**: Ensure `getValidMendeleyAccessToken(ctx.vault)` handles concurrent sync triggers gracefully to prevent duplicate refresh requests to Elsevier (which can invalidate older refresh tokens in slide-window setups).
