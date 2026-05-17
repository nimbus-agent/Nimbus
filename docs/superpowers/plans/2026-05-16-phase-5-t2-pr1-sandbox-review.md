# Review of Phase 5 T2 PR 1 — Sandbox PAL + 3-OS isolation — Implementation Plan

**Date:** 2026-05-16
**Status:** Review Feedback

The implementation plan is exceptionally thorough and provides a clear, actionable roadmap for this complex cross-platform refactor. It correctly incorporates many of the points from the design review (macOS 15 spikes, Windows asymmetry labeling, hard-disable UX, etc.).

Here are a few suggestions for improvement and open questions:

### 1. `nimbus-sandbox-helper` Robustness (Task 6)
*   **Suggestion:** The plan for the C helper (Task 6.1) should explicitly mention **input validation** for the `--allow <host>` arguments to prevent command injection or other malformed input attacks, especially since it runs with `CAP_NET_ADMIN`.
*   **Suggestion:** Add a sub-task to Task 22 (CI wiring) to run a static analysis tool (e.g., `cppcheck`) on the C binary if available in the CI environment.

### 2. DNS/IP Rotation and Sandbox Restart
*   **Observation:** The plan (and design) uses one-time DNS resolution in the Linux helper.
*   **Suggestion:** In the "Operator reference" (Task 21), or in the implementation of the `SandboxRunner`, we should explicitly document that if a connector experiences persistent connection failures to an allowed host (due to an IP change), the user should restart the Gateway or the extension. A follow-up PR could implement auto-restart on `ECONNREFUSED`, but for PR 1, documentation is sufficient.

### 3. Task 6.1: Netns Isolation
*   **Suggestion:** In the C binary implementation, ensure that the helper binary explicitly drops the `nb-out-<pid>` peer from the child's visibility (e.g., via `ip netns exec ... ip link set nb-out-<pid> netns 1` or similar logic) so the connector cannot attempt to interfere with the host-side peer.

### 4. Task 15.2: Structured Log Warning
*   **Suggestion:** Ensure the structured log warning emitted when the sandbox is degraded (Task 20.3) is clearly visible in the TUI/CLI output at startup, not just buried in a log file. Users should be aware that their "hardened" system is currently in a degraded state.

### 5. Task 22.3: `bwrap` Dependency
*   **Suggestion:** While Task 22.3 adds `bubblewrap` to the CI environment, ensure that Task 22.4 (or a new task) explicitly updates the Linux package control files (e.g., `packages/gateway/scripts/linux/control` for `.deb`) to list `bubblewrap` as a hard dependency.

### 6. Task 9: macOS Spike Logging
*   **Suggestion:** In Task 9, ensure the `spike-darwin-sandbox-exec.sh` script logs the specific error codes (EPERM vs. EHOSTUNREACH) to help differentiate between "sandbox denied the request" and "network is just down".

### 7. Task 12: Windows FFI Stub
*   **Observation:** Task 12.1 uses an explicit `Error` for the missing FFI.
*   **Suggestion:** Ensure this error message is user-friendly and points them to a troubleshooting page or explains that Windows per-host filtering is currently a work-in-progress, so they don't think their installation is broken.
