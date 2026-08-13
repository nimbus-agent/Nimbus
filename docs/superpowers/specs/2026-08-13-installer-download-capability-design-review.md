# Installer download capability + headless-Linux keyring remedy — Design Review

> **HISTORICAL — do not read as current contract.** This is a point-in-time
> review of the design spec, kept for provenance. It records open questions as
> they stood *before* implementation.

## Open Questions & Risks

1. **Windows PowerShell 5.1 vs. PowerShell Core (7+) Compatibility**
   - The design spec under § "Version and asset resolution" suggests:
     ```powershell
     $r.BaseResponse.RequestMessage.RequestUri
     ```
     which is tailored for PowerShell 7.
   - **Question**: Standard Windows installations only have Windows PowerShell 5.1 pre-installed by default. Will this redirect-resolution logic work on Windows PowerShell 5.1? 
   - **Suggestion**: In Windows PowerShell 5.1, `Invoke-WebRequest` does not have a `BaseResponse` on the return value if it auto-redirects unless you specify `-MaximumRedirection 0` or catch the redirect exception, or inspect the underlying session/headers. We must ensure the PowerShell code gracefully handles both PowerShell 5.1 and PowerShell 7+, perhaps by using `[System.Net.HttpWebRequest]` or inspecting the headers/exception details.

2. **Asset Versioning Inconsistency Across Platforms**
   - The asset resolution table lists:
     - `linux x64`: `nimbus-headless-linux-amd64-v<ver>.tar.gz` (Base: `/releases/download/v<ver>/`)
     - `macos arm64`: `nimbus-headless-macos-arm64.tar.gz` (Base: `/releases/latest/download/`)
     - `macos x64`: `nimbus-headless-macos-x64.tar.gz` (Base: `/releases/latest/download/`)
     - `windows x64`: `nimbus-headless-windows-x64.zip` (Base: `/releases/latest/download/`)
   - **Question**: Why does the Linux asset include the `-v<ver>` suffix in its filename while macOS and Windows assets do not? Furthermore, if macOS/Windows use the base `/releases/latest/download/`, does this mean specifying a pinned version via `--from-release <ver>` will fail to download the specific requested version for macOS/Windows, always fetching the latest?
   - **Suggestion**: Align the asset naming scheme so that *all* platforms either include the version suffix or use the same redirect/base path structure. If GitHub release assets must have version suffixes (like Linux), then macOS and Windows assets should also support version-specific URLs to make `--from-release <ver>` work correctly.

3. **GPG Key Retrieval and Keyserver Reliability**
   - The spec states that if `gpg` is available, it will fetch the signature and verify it against the pinned fingerprint `5A20457CCD8B53FFAA945240886ADA6B487CAB6E`.
   - **Question**: Where does the installer obtain the public key corresponding to this fingerprint? If it attempts to fetch it from a public keyserver (e.g., `keyserver.ubuntu.com`), these lookups are highly prone to transient network failures, timeouts, or local firewall blockages.
   - **Suggestion**: Consider embedding the public key directly inline within the installer scripts or fetching it from a trusted, static repository location (e.g., raw GitHub content) rather than querying a dynamic keyserver.

4. **Keyring Directory Permissions & Parent Creation**
   - Under `nimbus doctor --fix-keyring` (§ "Mechanism: deliberately unspecified here"), the keyring fix involves pre-creating `~/.local/share/keyrings/login.keyring` and the `default` pointer.
   - **Question**: Does the tool guarantee the strict folder permissions required by `gnome-keyring`? If the parent directories are created with overly permissive permissions (e.g., `0777` or `0755`), `gnome-keyring-daemon` might ignore the keyring or refuse to load it.
   - **Suggestion**: Ensure that `nimbus doctor --fix-keyring` explicitly sets `0700` permissions (read/write/execute by owner only) on the `~/.local/share/keyrings` directory and `0600` on the keyring files themselves to satisfy the security invariants of Linux keyring managers.

5. **Wget Fallback for Unix Systems**
   - **Question**: Many minimal or headless Linux environments (like lightweight Docker containers or raw Alpine images) do not ship with `curl` pre-installed but may have `wget` (or vice versa).
   - **Suggestion**: To maximize portability on headless machines, the `install.sh` script should check for both `curl` and `wget`, using whichever is available to perform the asset downloads and redirect resolutions.

## Suggestions for Implementation Plan

- **Validate Windows PowerShell 5.1 in CI**: Add a verification step or test runner that specifically executes `install.ps1` inside a standard Windows PowerShell 5.1 environment to verify compatibility.
- **Fail-Safe Keyring Dry Run**: Have `nimbus doctor --fix-keyring` output the exact actions it plans to perform (e.g. "Will create folder X with permissions Y, will write file Z") and ask for user confirmation if in an interactive TTY, keeping the operational change clear and auditable.
