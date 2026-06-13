<!-- scripts/sign/README.md -->
# Code-signing seam

Each signer follows one convention: **cert secrets present → sign; else warn and `exit 0`.**
The pipeline shape is identical signed or unsigned — adding cert secrets later flips
every channel to trusted with zero pipeline rework.

| Script | Tool | Secret gate |
| --- | --- | --- |
| `sign-windows.ps1` | `signtool` | `WINDOWS_CERT_PFX_BASE64` + `WINDOWS_CERT_PASSWORD` |
| `sign-macos.sh` | `codesign`/`productsign` + `notarytool` | `APPLE_CERT_P12_BASE64` + `APPLE_TEAM_ID` (+ notary creds) |
| `../sign-linux-gpg.sh` | `gpg --detach-sign` | `GPG_PRIVATE_KEY` + `GPG_PASSPHRASE` |
| `../sign-ed25519.ts` | Ed25519 updater sig | `UPDATER_SIGNING_KEY` |

Nimbus currently ships **unsigned-ready**: no cert secrets are configured, so the
Windows/macOS signers no-op. Linux GPG + Ed25519 updater signing are already active.
