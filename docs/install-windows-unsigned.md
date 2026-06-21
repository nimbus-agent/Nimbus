# Installing Nimbus on Windows (Unsigned)

## Why unsigned?

Windows Authenticode / EV code-signing certificates cost ~$350–700/year plus ongoing cert-rotation overhead — a recurring cost we're deferring until the product reaches a stable-user milestone. This is an **honest tradeoff**: SmartScreen's "Windows protected your PC" dialog takes one extra click to bypass, and Defender may flag an unsigned single-file-packed binary briefly on first run. In exchange, we avoid a recurring fee and vendor-telemetry dependency for a local-first project.

**The integrity proof is orthogonal to platform code-signing.** Every Nimbus release ships a `SHA256SUMS` manifest GPG-signed with the project key. That signature works on every OS, independent of SmartScreen or Authenticode, and is the **real** trust signal. Verify before you install — see [`docs/verify-release-integrity.md`](verify-release-integrity.md).

## Power-User Shortcut (PowerShell 7+)

One-liner that downloads the verify helper, **unblocks the Zone.Identifier** (see "Execution policy" below), verifies the archive, extracts, and runs:

```powershell
# Replace <ver>
Invoke-WebRequest -Uri https://github.com/nimbus-agent/Nimbus/releases/download/v<ver>/nimbus-headless-windows-x64.zip -OutFile nimbus-headless.zip
Invoke-WebRequest -Uri https://github.com/nimbus-agent/Nimbus/releases/download/v<ver>/nimbus-verify.ps1       -OutFile nimbus-verify.ps1
Unblock-File -Path .\nimbus-verify.ps1                              # removes the Zone.Identifier marker from the downloaded .ps1
.\nimbus-verify.ps1 -Version <ver>                                  # ✅ signature + hash
Expand-Archive -Path nimbus-headless.zip -DestinationPath .\nimbus  # extract binaries + README + LICENSE
cd nimbus
.\nimbus-gateway-windows-x64.exe                                    # Start the Gateway
# In a new PowerShell window:
.\nimbus-cli-windows-x64.exe --help
```

**About `Unblock-File`:** Windows attaches a Zone.Identifier NTFS alternate-data-stream to any `.ps1` downloaded from the internet. With the default `RemoteSigned` execution policy, PowerShell refuses to run such scripts until they're unblocked. `Unblock-File` removes the marker for one specific file without changing any global policy — preferred over `Set-ExecutionPolicy Bypass`, which lowers the guard more broadly than needed.

PowerShell 7 ships with `Expand-Archive`. On older Windows with only Windows PowerShell 5.1, the command is identical — `Expand-Archive` has been built-in since 5.0 — but `nimbus-verify.ps1` itself requires PowerShell 7+. Install via `winget install Microsoft.PowerShell` if you're on 5.1.

## File Explorer Workflow (Step by Step)

If you prefer clicking through the UI:

1. Download the `.zip` from the [GitHub Release page](https://github.com/nimbus-agent/Nimbus/releases).
2. Right-click the downloaded `.zip` → **Extract All…** → pick a destination → **Extract**.
3. In the extracted folder, **double-click** `nimbus-gateway-windows-x64.exe`.
4. SmartScreen shows: *"Windows protected your PC. Microsoft Defender SmartScreen prevented an unrecognized app from starting."* → **More info** → **Run anyway**.
5. A terminal window launches the Gateway. Leave it running.
6. Open a new PowerShell window: `.\nimbus-cli-windows-x64.exe --help`.

**Why "More info → Run anyway"?** SmartScreen's default primary button is "Don't run" — designed to protect users who clicked a phishing link. The "More info" disclosure reveals the bypass button for the case where you intentionally downloaded an unsigned binary you trust.

## Defender Exclusion Guidance

Microsoft Defender's heuristic engine **may** flag `nimbus-gateway-windows-x64.exe` on first run. This is because the Bun compiler produces a **single-file packed executable** — a characteristic shared with some malware families, which Defender's heuristics pattern-match on. There is nothing malicious about the binary; you can confirm this by verifying its hash against `SHA256SUMS.asc`.

Two options:

1. **Wait.** On-access scans typically clear new binaries within a few minutes to hours once Microsoft's cloud-delivered reputation signal catches up.
2. **Add an exclusion.** Windows Security → Virus & threat protection → Manage settings → Exclusions → Add or remove exclusions → **Add a file exclusion** → pick the Nimbus `.exe`. This is a common workflow for developer-tool binaries.

**Do NOT disable Defender entirely.** Either wait for reputation, or add a specific-file exclusion — nothing broader.

## Troubleshooting

### "This app can't run on your PC"

Wrong architecture. Nimbus v0.1.0 only ships a Windows x64 binary. On Windows on ARM, you can use the x64 binary under emulation (included on Windows 11 ARM).

### PowerShell execution policy blocks `nimbus-verify.ps1`

```text
File C:\...\nimbus-verify.ps1 cannot be loaded. The file is not digitally signed.
  or
...because running scripts is disabled on this system.
```

**Preferred fix — `Unblock-File` (per-file, no policy change):**

```powershell
Unblock-File -Path .\nimbus-verify.ps1
.\nimbus-verify.ps1 -Version <ver>
```

This removes the Zone.Identifier NTFS stream that Windows attaches to downloaded files. The file-level unblock is enough with the default `RemoteSigned` policy — no global change needed.

**If your policy is stricter than `RemoteSigned`** (e.g., `AllSigned` / `Restricted`, common on corp-managed machines):

```powershell
# Run once in PowerShell as your user (NOT elevated):
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

`RemoteSigned` requires remote scripts to be signed but allows unsigned local scripts after `Unblock-File`. On corp-managed machines where `-Scope CurrentUser` is blocked by group policy, use `-Scope Process` for a single-session bypass:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\nimbus-verify.ps1 -Version <ver>
```

`-Scope Process` lives only for the current shell window and is discarded on close — the narrowest possible escape hatch.

### "Windows protected your PC" with no "More info" link

Your SmartScreen is set to **Block**. Change: Settings → Privacy & Security → Windows Security → App & browser control → Reputation-based protection settings → "Check apps and files" set to **Warn** (not **Block**). This restores the bypass button.

## Next Steps

- [`docs/cli-reference.md`](cli-reference.md) — `nimbus` CLI reference
- [`docs/verify-release-integrity.md`](verify-release-integrity.md) — detailed integrity verification
