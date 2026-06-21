# Installing Nimbus on macOS (Unsigned)

## Why unsigned?

Nimbus v0.1.0 ships unsigned on macOS and Windows. Apple's Developer ID Program costs $99/year + a yearly cert rotation — a recurring cost we're deferring until the product reaches a stable-user milestone. This is an **honest tradeoff**: Gatekeeper's "unidentified developer" dialog requires an extra click, and some users will bounce at that friction. In exchange, we avoid a recurring fee and a vendor-telemetry dependency for a project whose mission is **local-first**.

**The integrity proof is orthogonal to platform code-signing.** Every Nimbus release ships a `SHA256SUMS` manifest GPG-signed with the project key. That signature works on every OS, independent of Gatekeeper or SmartScreen, and is the **real** trust signal. Verify before you install — see [`docs/verify-release-integrity.md`](verify-release-integrity.md).

## Power-User Shortcut

One-liner that downloads the verify helper, verifies the binary, strips the quarantine attribute, and runs:

```bash
# Replace <ver> and <arch> (x64 or arm64 — run `uname -m` to check)
curl -LO https://github.com/nimbus-agent/Nimbus/releases/download/v<ver>/nimbus-headless-macos-<arch>.tar.gz
curl -LO https://github.com/nimbus-agent/Nimbus/releases/download/v<ver>/nimbus-verify.sh
bash nimbus-verify.sh --version <ver>                         # ✅ signature + hash
tar -xzf nimbus-headless-macos-<arch>.tar.gz                  # extracts nimbus-gateway-macos-<arch>, nimbus-cli-macos-<arch>, README, LICENSE
xattr -d com.apple.quarantine ./nimbus-gateway-macos-<arch>   # remove the Gatekeeper quarantine bit
xattr -d com.apple.quarantine ./nimbus-cli-macos-<arch>
./nimbus-gateway-macos-<arch> &                               # start the Gateway in the background
./nimbus-cli-macos-<arch> --help
```

### Picking the right archive

Apple Silicon (M1/M2/M3/M4): download `nimbus-headless-macos-arm64.tar.gz`.
Intel Mac: download `nimbus-headless-macos-x64.tar.gz`.

Run `uname -m` in a terminal: `arm64` → arm64 archive; `x86_64` → x64 archive.

## Finder Workflow (Step by Step)

If you prefer clicking through the UI:

1. Download the archive from the [GitHub Release page](https://github.com/nimbus-agent/Nimbus/releases).
2. Double-click the `.tar.gz` in Finder — macOS extracts it automatically.
3. Open Terminal (Spotlight → "Terminal").
4. `cd Downloads` (or wherever the archive extracted).
5. **Right-click `nimbus-gateway-macos-<arch>` → Open.**
6. Gatekeeper shows: *"macOS cannot verify the developer. Are you sure you want to open it?"* → **Open**.
7. A terminal window launches the Gateway. Leave it running.
8. In a new Terminal: `./nimbus-cli-macos-<arch> --help`.

**Why right-click → Open (not double-click)?** macOS records a one-time Gatekeeper exception only when you explicitly invoke "Open" via the right-click menu. After the first run, subsequent double-clicks work with no prompt.

## Troubleshooting

### "…cannot be opened because the developer cannot be verified."

This is Gatekeeper's default dialog for any unsigned binary. Follow the Finder workflow above (right-click → Open) for a one-time exception. Alternatively from the command line:

```bash
xattr -d com.apple.quarantine ./nimbus-gateway-macos-<arch>
```

### "Killed: 9" on first run

Usually means the binary was downloaded via a browser that stripped the executable bit. Fix:

```bash
chmod +x ./nimbus-gateway-macos-<arch>
```

If the problem persists, the download is likely corrupted — re-run `nimbus-verify.sh` and re-download if hashes don't match.

### "arch: Bad CPU type in executable"

You downloaded the wrong architecture. `uname -m` to check; re-download the matching archive.

## Next Steps

- [`docs/cli-reference.md`](cli-reference.md) — `nimbus` CLI reference
- [`docs/verify-release-integrity.md`](verify-release-integrity.md) — detailed integrity verification
