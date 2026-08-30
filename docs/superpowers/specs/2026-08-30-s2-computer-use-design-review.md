# Design Review: S2 — Local Computer-Use Loop (2026-08-30)

Below are comments, questions, and suggested improvements for the `2026-08-30-s2-computer-use-design.md` specification.

## Open Questions & Clarifications

### 1. Browser Lane: API Requests, Fetch/XHR, and Exfiltration

* **Context:** The specification states that the browser origin allowlist governs *navigation*, and that subresource loading is allowed but logged under the `browser` egress class to avoid breaking the web.
* **Question:** How are client-side API requests (`fetch`, `XMLHttpRequest`, `WebSocket`) handled? Are they classified as "navigations" (blocked if outside the approved origin list) or "subresources" (allowed but logged)?
* **Impact:** If outbound `fetch` calls to arbitrary third-party APIs are treated as subresources and allowed, a compromised page could easily exfiltrate private data via dynamic HTTP requests or WebSocket connections without triggering a navigation refusal. We should clarify if dynamic outgoing API traffic is blocked or allowed, and how we draw the boundary.

### 2. Terminal Lane: Character-by-Character Writes and Hotkey Bypass

* **Context:** The terminal classifier marks a write as `actuating` only when the PTY write contains a submit character (`\n` or `\r`). Non-submit keystrokes are classified as `observing`.
* **Question:** Does the gateway buffer the command bytes and wait for a submit character before sending *any* bytes to the PTY, or are the characters sent incrementally to the PTY as they are typed?
* **Impact:** If characters are written to the PTY incrementally:
  1. An interactive terminal application (like `vi`, `nano`, `fzf`, or a CLI tool prompting for confirmation) might execute destructive actions on single character keypresses (e.g., `y`, `d`, or Ctrl-C/D) without any newline.
  2. An attacker could exploit this by having the model send keystrokes that trigger hotkeys or shortcut executions.
  We should clarify whether typing is fully buffered or written immediately.

### 3. Screen Lane: Window Handle Recycling and Spoofing

* **Context:** The screen lane targets a single window handle fixed at envelope approval. If the window closes mid-session, the session terminates.
* **Question:** How is the window handle uniquely identified across OS platforms (e.g. Windows `HWND`, macOS `CGWindowID`, Linux X11/Wayland IDs)? What prevents an attacker from causing the target window to close and immediately spawning a new window that obtains the same recycled window handle, spoofing the target?
* **Suggestion:** We should specify that the window tracking logic verifies not just the handle/ID but also the process ID (PID) and executable path associated with the handle to ensure it hasn't been recycled or hijacked.

### 4. Wayland and Non-Negotiable Platform Equality

* **Context:** Bound 4 highlights that Wayland might make targeted synthetic input unimplementable without `xdg-desktop-portal`, creating a potential conflict with platform equality (#5).
* **Question:** What is the preferred fallback for Linux systems running Wayland? If we restrict the screen lane to X11-only on Linux, how do we document this deviation from the platform equality non-negotiable?

## Suggested Improvements

### 1. Fully Buffer Terminal Input Prior to Approval

* **Suggestion:** The gateway should accumulate all characters sent to the terminal lane in a local buffer. Only when a newline/submit is received should the accumulated command line be shown to the user for HITL approval. No bytes should be written to the active PTY device until the user approves the complete command. This prevents hotkey/incremental input exploits.

### 2. Retention Policy and Disk Pruning for `cu_action` DOM Snapshots

* **Suggestion:** Since `dom_before` and `dom_after` in the `cu_action` table store complete DOM snapshots, this table will grow extremely rapidly and bloat the user's local SQLite database.
* **Action:** Define an auto-pruning policy (e.g., retain DOM snapshots for 7 days or up to 500 total actions) and plug it into the `egress.prune` command line/trigger, ensuring database hygiene.

### 3. Block Dynamic Script Execution of Out-of-Envelope APIs

* **Suggestion:** In the browser lane, configure Playwright to intercept and block all dynamic outbound network requests (`fetch`/`XHR`/`WebSockets`) to origins outside the approved target list, while still permitting standard static subresources (images, stylesheets, fonts) to load. This blocks the most common script-based data exfiltration vectors while minimizing web breakage.
