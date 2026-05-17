# Review of Phase 5 T2 PR 1 — Sandbox PAL + 3-OS isolation — Design

**Date:** 2026-05-16
**Status:** Review Feedback

This design provides a robust and ambitious foundation for kernel-level security isolation. The transition from an honor-system approach to OS-native sandboxing is a critical step for the project's security posture.

Here are the key points for improvement and open questions:

### 1. `nimbus-sandbox-helper` Security Surface (Linux)
The C helper binary granted `cap_net_admin` is a high-value target for privilege escalation.
*   **Suggestion:** Ensure the implementation plan for the C binary includes:
    *   Strict input validation for the `--allow <host>` strings.
    *   Exploration of `cap_net_admin` versus `cap_net_raw` (some iptables operations might need more than just admin).
    *   A mandate for static analysis (e.g., `cppcheck` or `clang-tidy`) and a fuzzer for the command-line parsing logic in the release pipeline.
    *   Explicitly ensuring the binary cannot be used to modify the *host's* network namespace once it has unshared its own.

### 2. DNS Resolution and IP-based Filtering (Linux/macOS)
The Linux helper resolves hostnames *once* at start time and installs IP-based iptables rules.
*   **Question:** Many modern services (GitHub, AWS, Slack) use highly dynamic IP ranges or CDNs. If a hostname's IP changes during a long-running extension session (e.g., a background sync connector), will the connection start failing?
*   **Suggestion:** If a connector hits an `ECONNREFUSED` on an allowed host, the Gateway might need to trigger a sandbox restart to re-resolve the host and update the iptables rules. Document this strategy in the implementation plan.

### 3. Windows All-or-Nothing Network Gap
*   **Observation:** The Windows asymmetry is a significant gap (AppContainer `internetClient` allows access to *any* host).
*   **Suggestion:** While WFP is out of scope for PR 1, we should ensure the documentation (and CLI `nimbus extension info`) clearly labels Windows network isolation as "Degraded: All-or-nothing network" so users are aware of the platform difference.

### 4. Hard-disable UX and "Pre-flight"
*   **Observation:** The hard-disable of pre-T2 extensions is a major breaking change (though justified).
*   **Suggestion:** Add a "pre-flight" check to the installer/updater or a CLI command (e.g., `nimbus diag --check-sandbox-readiness`) that lists which extensions will be disabled *before* the user upgrades to the T2-enabled Gateway. This reduces frustration.

### 5. Seccomp Filter Maintenance
*   **Question:** The default seccomp filter is quite permissive (allowing `fork`, `execve`, etc. to support Bun's runtime). 
*   **Suggestion:** Consider if we should eventually move to a "profile-per-runtime" (e.g., a stricter profile for a Python extension vs. a Bun extension) in a follow-up Phase. For PR 1, the current approach is an acceptable compromise.

### 6. `sandbox-exec` and macOS 15+ (Sequoia)
*   **Observation:** macOS 15 has tightened privacy controls further.
*   **Suggestion:** The viability spike should specifically test if `sandbox-exec` requires an "App Management" or "Full Disk Access" permission for the *Gateway* itself to work correctly when spawning these profiles.

### 7. Bwrap availability (Linux)
*   **Question:** `bwrap` is common but not always installed by default (e.g., on minimal server installs).
*   **Suggestion:** The Linux installer scripts (`.deb`, `.rpm`) must declare `bubblewrap` as a hard dependency. The tarball install instructions should check for `bwrap` and provide a helpful install command if missing.

### 8. Contract Test Negative Probes
*   **Observation:** The negative network probe is skipped on Windows.
*   **Suggestion:** Ensure the contract test failure message on Windows explicitly points to the "Windows Asymmetry" section in the docs so developers don't think it's a bug in their test code.
