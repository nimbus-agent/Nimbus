# Installer Download Capability Plan Review

> **HISTORICAL — do not read as current contract.** This is a point-in-time
> review of the implementation plan, kept for provenance. It records open
> questions as they stood *before* implementation.

## Open Questions & Risks

1. **PowerShell Redirect Resolution in Standard environments**
   - In Task 4 Step 3, `Resolve-LatestTag` resolves redirect URIs by inspecting `$r.BaseResponse.ResponseUri` (for PS 5.1) or `$r.BaseResponse.RequestMessage.RequestUri` (for PS 7+).
   - **Question**: When `Invoke-WebRequest` is called on a redirecting URL like `/releases/latest`, does the web request succeed and return the redirected page, or does it throw/fail under certain group policies/environments if basic parsing is used?
   - **Suggestion**: Under basic parsing on PowerShell 5.1, `Invoke-WebRequest` behaves correctly, but using the `[System.Net.HttpWebRequest]` class directly is sometimes cleaner if `Invoke-WebRequest` experiences environment-specific proxy issues. We should verify that the fallback logic handles network/proxy errors gracefully.

2. **Windows background HTTP server for CI verification**
   - Task 6 Step 1 details starting the Python HTTP server on Unix, and says "Mirror for Windows with Expand-Archive-compatible zip packing".
   - **Question**: How should the background HTTP server be started and stopped on Windows in GitHub Actions without blocking the runner or leaving orphaned processes?
   - **Suggestion**: In Windows PowerShell/pwsh, use `Start-Process` to run Python in the background, saving the process handle or ID to stop it afterward:

     ```powershell
     $job = Start-Process python -ArgumentList "-m http.server 8788 --bind 127.0.0.1" -PassThru
     # ... run tests ...
     Stop-Process -Id $job.Id -Force
     ```

3. **Temp Directory Cleanup on Failure / Interrupt**
   - The shell script in Task 3 and PowerShell script in Task 4 both create dynamic temp directories (`mktemp -d` and `New-Item -ItemType Directory`).
   - **Question**: If the installation fails midway or is interrupted by the user (e.g. `Ctrl+C`), do these directories remain on disk indefinitely?
   - **Suggestion**: Register a shell `trap` in `install.sh` to ensure cleanup of `$DOWNLOAD_DIR` and `$GNUPGHOME` on exit, signal, or error (e.g. `trap 'rm -rf "$DOWNLOAD_DIR" "$GNUPGHOME"' EXIT INT TERM`).

4. **GPG Key Import Encoding on Windows**
   - Task 5 Step 3 mentions writing the GPG key and importing it in PowerShell.
   - **Question**: Windows PowerShell defaults to UTF-16 when piping or writing strings to files, which can cause `gpg` to fail to parse the armored block.
   - **Suggestion**: Ensure that the GPG public key string is written to a temporary file using UTF-8 or ASCII encoding explicitly (e.g. `Out-File -Encoding ascii` or `[System.IO.File]::WriteAllText($path, $key)`), rather than default redirection or pipelining which might corrupt the encoding on Windows.

## Suggestions for Implementation Plan

- **GPG Version Check**: In Task 5 Step 2, ensure the `gpg` execution checks that GPG is responsive (e.g. `gpg --version`) and not just on the PATH as a broken symlink or blocked execution alias.
- **Verbose Output on Skip**: If GPG is skipped, make the warning message clear about security implications, so that advanced users running in headless mode are fully aware they are relying on SHA-256 only.
