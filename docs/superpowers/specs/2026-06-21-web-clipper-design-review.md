# Review & Feedback: Phase 6 Slice 9 — Web Clipper — Design Review

**Review Date:** 2026-06-21  
**Design Document Reviewed:** [2026-06-21-web-clipper-design.md](./2026-06-21-web-clipper-design.md)  
**Status:** Review Feedback / Suggestions / Open Questions

---

## 1. Multiple Extension / Browser Support

### Context
In **§ Security Posture**, the design states:
> A web-clipper token is minted only behind a live, owner-opened [...] pairing window [...] token is persisted to Vault (`http_api.web_clipper_token`).
> A fresh pair supersedes the prior token.

### Suggestions / Open Questions
1. **Single vs. Multiple Tokens:**
   - If the user uses multiple browsers (e.g., Chrome at work, Firefox at home) or multiple browser profiles, using a single vault key `http_api.web_clipper_token` means pairing a new browser will immediately invalidate/revoke the token on the previous one.
   - **Recommendation:** Allow the Vault to store a list/map of active tokens (possibly associated with a user-supplied name/ID like "Chrome-Work" or "Firefox") or simply allow multiple concurrent active tokens under a collection key to avoid locking users into a single active browser extension instance.

---

## 2. Dynamic CSS Bleed-in in Shadow DOM

### Context
In **§ Components & Data Flow (Sidecar flow)**, the spec notes:
> Extension renders an overlay panel in a **Shadow DOM** (so page CSS can't bleed in) listing related local items.

### Suggestions / Open Questions
1. **CSS Inheritance:**
   - While Shadow DOM blocks document-level selectors from matching elements inside the shadow tree, inherited CSS properties (e.g., `font-family`, `color`, `line-height`, and CSS custom properties declared on `:root`/`html`/`body`) will still bleed into the Shadow DOM.
   - **Recommendation:** Implement a css reset rule inside the Shadow DOM container (using `all: initial` or standard resets for text properties) to prevent the host page's typography and color schemes from distorting the sidecar UI.

---

## 3. Ephemeral vs. Persistent Pairing Window

### Context
In **§ Components & Data Flow (Pairing flow)** and **§ Security Posture (I30)**, the spec proposes an "in-memory pairing window" with a TTL of ~120s.

### Suggestions / Open Questions
1. **Gateway Lifecycle:**
   - If the Gateway process restarts or crashes during an active pairing window, does the state disappear?
   - **Recommendation:** Confirm that the pairing window state is strictly ephemeral and resides only in memory (e.g., a singleton controller with a timer). A gateway restart naturally invalidates the session, requiring the user to run `nimbus clip pair` again, which is a safe, simple, and standard behavior for local-first software.

---

## 4. Query Strategy for Related Items (`/v1/clips/related`)

### Context
In **§ Components & Data Flow (Sidecar flow)**, the content script collects the page `title`, `canonicalUrl`, and any active `selection` to retrieve related local items.

### Suggestions / Open Questions
1. **Combining Multiple Search Signals:**
   - If a page has a generic title (e.g., "Documentation") but a specific selection, standard FTS queries might yield noisy results.
   - **Recommendation:** Clarify how the `/v1/clips/related` search endpoint processes these three inputs. For example, does it use the selection text (if present) as the primary semantic vector query, while using the title/URL keywords to boost or filter results?

---

## 5. Token Management CLI Actions

### Context
In **§ CLI Surface**, the spec lists `nimbus clip pair` as the primary CLI command.

### Suggestions / Open Questions
1. **Revocation and Status:**
   - Since the token is stored in the extension storage (which is outside the OS Vault boundary), users might want to verify or revoke access without running a new pairing process.
   - **Recommendation:** Introduce CLI actions for management, such as:
     - `nimbus clip status` — checks if a clipper token is registered and reports active count (if multi-token support is adopted).
     - `nimbus clip revoke` — clears all clipper tokens from the Vault to immediately cut off access from any paired browser.
