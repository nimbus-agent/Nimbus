# Verifying Release Integrity

Nimbus releases ship with a **GPG-signed `SHA256SUMS` manifest** that gives any user on any platform a cryptographic integrity check — independent of Apple Gatekeeper, Windows SmartScreen, or any other platform code-signing. This page explains what the chain looks like and how to verify it.

> **If you're in a hurry:** run the helper script on your OS. See "Recommended: Use `nimbus-verify`" below.

## The Integrity Chain

```text
user's trust root
  └─ project GPG public key fingerprint          ← published in four places:
     ├─ keys.openpgp.org (keyserver)
     ├─ keyserver.ubuntu.com (keyserver)
     ├─ docs/SECURITY.md (in the repo)
     └─ docs/release/SIGNING-KEY.asc (in the repo, ASCII-armored)
          └─ SHA256SUMS.asc  (detached GPG signature)
               └─ SHA256SUMS  (text manifest: one line per artifact)
                    └─ each release artifact  (SHA-256 hash-verified)
```

The fingerprint is published in **four independent places** so a first-time user can cross-check before trusting anything they downloaded. **If the four sources diverge, do not install. Open a private security issue.**

## Recommended: Use `nimbus-verify`

Every GitHub Release page carries `nimbus-verify.sh` (Linux + macOS) and `nimbus-verify.ps1` (Windows) — small standalone helpers that:

1. Download `SHA256SUMS` + `SHA256SUMS.asc` from the release page.
2. Import the project GPG key from a keyserver (if not already in your keyring).
3. **Print the imported fingerprint** so you can cross-check against this repo.
4. Run `gpg --verify` on the manifest signature.
5. Hash-verify every artifact from the manifest that's present in your current directory.
6. Print `✅` for each passing artifact, `❌` for any that fail.

### Linux + macOS

```bash
curl -LO https://github.com/nimbus-agent/Nimbus/releases/download/v<ver>/nimbus-verify.sh
bash nimbus-verify.sh --version <ver>
```

### Windows (PowerShell 7+)

```powershell
Invoke-WebRequest -Uri https://github.com/nimbus-agent/Nimbus/releases/download/v<ver>/nimbus-verify.ps1 -OutFile nimbus-verify.ps1
.\nimbus-verify.ps1 -Version <ver>
```

### Offline mode (`--no-fetch` / `-NoFetch`)

Pre-download `SHA256SUMS`, `SHA256SUMS.asc`, the artifacts, and import the GPG key once. Then:

```bash
bash nimbus-verify.sh --no-fetch
```

```powershell
.\nimbus-verify.ps1 -NoFetch
```

This is the right mode for CI pipelines, air-gapped machines, or any scenario where you've staged inputs manually and want pure verification without network activity.

## Manual Verification (for the Paranoid)

If you don't trust the helper script, run the same checks yourself:

### 1. Import the public key

```bash
# By fingerprint — fill in the value from docs/SECURITY.md
gpg --keyserver keys.openpgp.org --recv-keys 5A20457CCD8B53FFAA945240886ADA6B487CAB6E
# or from the repo's committed key body:
gpg --import docs/release/SIGNING-KEY.asc
```

### 2. Verify the manifest signature

```bash
gpg --verify SHA256SUMS.asc SHA256SUMS
```

Look for `Good signature from "Nimbus Release Signing <releases@...>"` and `Primary key fingerprint:` lines. **The fingerprint must match `docs/SECURITY.md`, `docs/README.md`, and keys.openpgp.org — all four.**

### 3. Verify artifact hashes

```bash
# Linux (coreutils sha256sum is present by default):
sha256sum --ignore-missing -c SHA256SUMS

# macOS (default install has no sha256sum; use shasum -a 256):
shasum -a 256 --ignore-missing -c SHA256SUMS
# Or, if you've installed coreutils via Homebrew (`brew install coreutils`),
# `gsha256sum` and `sha256sum` are both available.

# Windows (PowerShell 7+):
Get-Content SHA256SUMS | ForEach-Object {
  if ($_ -match '^([0-9a-f]{64})\s+\*?(.+)$') {
    $expected = $matches[1]; $file = $matches[2].Trim()
    if (Test-Path $file) {
      $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
      if ($actual -eq $expected) { "OK  $file" } else { "BAD $file ($actual != $expected)" }
    }
  }
}
```

**Why `--ignore-missing`?** `SHA256SUMS` covers the full release set. You've probably only downloaded a subset — the binary for your OS, maybe the verify script. Without `--ignore-missing`, `sha256sum`/`shasum` would print a `WARNING: N listed files could not be read` line and exit non-zero even though everything you actually have is fine. `--ignore-missing` silently skips absent files; the checker only reports status for files that are present.

**`latest.json` is intentionally absent from `SHA256SUMS`** — the updater manifest carries its own Ed25519 signature (verified by the Gateway internally at auto-update time) and is not user-hand-verifiable. If you have `latest.json` in your download folder, it won't be in the manifest and `--ignore-missing` won't even consider it. This is expected, not a bug.

## What `SHA256SUMS` Covers (and Doesn't)

**Covered:** every user-facing release artifact — raw Gateway + CLI binaries (Linux / macOS x64 + arm64 / Windows), the macOS `.tar.gz` archives, the Windows `.zip`, the Linux `.deb`, `.AppImage`, and tarball, the CycloneDX SBOM, and the `nimbus-verify` scripts themselves.

**Not covered:** `latest.json` — the updater manifest. It carries its own **Ed25519 signature** that the Gateway verifies internally before applying an auto-update. End users don't hand-verify `latest.json`; it's a machine-consumed file. This separation matches user mental models (one manifest for "I'm downloading the app", a different signature flow for "the app is updating itself").

## Linux: AppImage on libfuse2-Less Distros

On Ubuntu 24.04+, Fedora 40+, Arch, and other distros that ship `libfuse3` by default, the AppImage needs either:

```bash
# Option A: install the transitional libfuse2 package
sudo apt install libfuse2t64
./nimbus-headless-<ver>-x86_64.AppImage

# Option B: extract-and-run (no FUSE needed)
./nimbus-headless-<ver>-x86_64.AppImage --appimage-extract-and-run
```

Option A is faster on repeated runs. Option B has no system-level dependencies beyond the AppImage itself.

**`.AppImage` + File Manager double-click.** The packaged `.desktop` entry uses `Terminal=true`. Some Desktop Environments (GNOME, KDE) respect this and pop a terminal; others silently do nothing when double-clicked. Users who want consistent double-click behavior should install [`AppImageLauncher`](https://github.com/TheAssassin/AppImageLauncher) — it also integrates `.AppImage` files into the desktop menu and handles updates cleanly. **Recommended invocation remains shell: `./nimbus-headless-<ver>-x86_64.AppImage`.**

## <a name="key-rotation"></a> Key Rotation

Rotating the project signing key takes two releases:

1. **`vN.N.N+1`** — signed by the **old** key. Contains updated `nimbus-verify.{sh,ps1}` whose `TRUSTED_FINGERPRINTS` array lists **both** the old and new fingerprint. Users who upgrade via `vN.N.N+1` pick up the new fingerprint.
2. **`vN.N.N+2`** — signed by the **new** key. `TRUSTED_FINGERPRINTS` drops the old fingerprint. Publish a key revocation on `keys.openpgp.org` for the old key. Update `docs/SECURITY.md`, `docs/README.md`, and `docs/release/SIGNING-KEY.asc`.

Users who skip straight from `vN.N.N` to `vN.N.N+2` must manually update their keyring via `docs/SECURITY.md`'s recv-keys instructions. This is accepted as an edge case; users who update regularly never notice the transition.

## Related Files

- [`docs/SECURITY.md`](SECURITY.md) — project GPG fingerprint + vulnerability reporting
- [`docs/release/SIGNING-KEY.asc`](release/SIGNING-KEY.asc) — ASCII-armored public key body
- [`docs/install-macos-unsigned.md`](install-macos-unsigned.md) — macOS Gatekeeper bypass
- [`docs/install-windows-unsigned.md`](install-windows-unsigned.md) — Windows SmartScreen bypass
