# Installing Nimbus (headless)

Nimbus ships a headless Gateway + CLI. Pick the channel that fits your platform.
All downloads are checksummed in `SHA256SUMS` and GPG-signed; verify with
`scripts/release/nimbus-verify.sh --version <ver>` (or `nimbus-verify.ps1`).

## Package managers (recommended — auto-updating)

| Platform | Command |
| --- | --- |
| macOS / Linux (Homebrew) | `brew install nimbus-agent/tap/nimbus` |
| Windows (Scoop) | `scoop bucket add nimbus https://github.com/nimbus-agent/scoop-bucket; scoop install nimbus` |
| Windows (winget) | `winget install NimbusAgent.Nimbus` |

> **winget availability & trust:** the winget package tracks **stable releases only**
> and is published by an automated `wingetcreate` PR to
> [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs) on each release, so
> a new version appears once Microsoft's PR review merges it (not instantly). The installer
> it delivers is the same per-user `.msi` as the direct download — currently **unsigned**, so
> Microsoft's PR review + SmartScreen reputation are the trust signals until code-signing
> lands (see the signing note at the bottom of this page).

On Linux the Homebrew formula also needs your distribution's `bubblewrap` package: the gateway looks for
`bwrap` at fixed paths, and Homebrew's own is not one of them. After `brew upgrade`, restart the gateway.

## Native installers (double-click)

| Platform | Artifact | Scope |
| --- | --- | --- |
| Windows | `nimbus-headless-windows-x64.msi` | Per-user (`%LOCALAPPDATA%`), no admin |
| macOS (Apple Silicon) | `nimbus-headless-macos-arm64.pkg` | Per-user (`~/.local`), no sudo |
| macOS (Intel) | `nimbus-headless-macos-x64.pkg` | Per-user (`~/.local`), no sudo |
| Linux (RPM) | `nimbus-headless-<ver>-x86_64.rpm` | `sudo dnf install ./...rpm` |
| Linux (DEB) | `nimbus-headless_<ver>_amd64.deb` | `sudo apt install ./...deb` |

Native installers and package-manager builds disable the self-updater — the
installer/package owns updates. The standalone tarball and the raw binaries can check for a new
version (`nimbus update --check`), but no build can apply one yet: `nimbus update` is refused with
`ERR_UPDATER_INSTALL_UNSUPPORTED` before anything is downloaded, and prints what to do for that copy.
For an `install.sh` install, run `nimbus stop` and re-run `install.sh` from the new release; it refuses,
changing nothing, while a gateway is running from its directory. See [Direct downloads](#direct-downloads)
for the AppImage and for a copy kept anywhere else.

To remove: Windows uses Add/Remove Programs; macOS runs `uninstall-nimbus`;
RPM/DEB use `sudo dnf remove nimbus-headless` / `sudo apt remove nimbus-headless`.

## Linux repositories (apt / yum)

For auto-updating Linux installs, add the signed Nimbus repository. The repository
**metadata is GPG-signed** (the native apt/yum trust model), so `apt`/`dnf` verify it
cryptographically — a stronger trust path than the standalone `.deb`/`.rpm`. The channel
tracks **stable releases only**.

**Debian / Ubuntu (apt):**

```bash
curl -fsSL https://nimbus-agent.github.io/linux-repo/gpg.key -o /tmp/nimbus.key
# Verify the key fingerprint BEFORE trusting it — it must match the Nimbus
# release signing key (also used to sign every release's SHA256SUMS):
gpg --show-keys --with-fingerprint /tmp/nimbus.key
#   expected: 5A20 457C CD8B 53FF AA94  5240 886A DA6B 487C AB6E
gpg --dearmor < /tmp/nimbus.key \
  | sudo tee /usr/share/keyrings/nimbus-archive-keyring.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/nimbus-archive-keyring.gpg] https://nimbus-agent.github.io/linux-repo/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/nimbus.list
sudo apt update && sudo apt install nimbus-headless
```

**Fedora / RHEL (dnf/yum):**

```bash
sudo curl -fsSL https://nimbus-agent.github.io/linux-repo/nimbus.repo \
  -o /etc/yum.repos.d/nimbus.repo
sudo dnf install nimbus-headless
```

`apt upgrade` / `dnf upgrade` then keep Nimbus current. (Uses the modern `signed-by`
keyring form — not the deprecated `apt-key add`.)

Both channels are pruned on publish: apt carries the newest release, yum the newest
few, so `dnf downgrade nimbus-headless` reaches back only a release or two. Older
versions stay available on the [releases page](https://github.com/nimbus-agent/Nimbus/releases)
as direct `.deb`/`.rpm` downloads.

## Direct downloads

Every artifact — the native installers above, the raw `nimbus` / `nimbus-gateway`
binaries, the portable `.tar.gz` (macOS/Linux) and `.zip` (Windows) archives, the
Linux `.AppImage`, and the `SHA256SUMS` + GPG signature — is published on the
[releases page](https://github.com/nimbus-agent/Nimbus/releases). The portable
archives and raw binaries can check for updates (`nimbus update --check`) but cannot apply one: the
updater refuses with `ERR_UPDATER_INSTALL_UNSUPPORTED` before it downloads anything. To update:

- **Installed with `install.sh`:** run `nimbus stop`, then re-run `install.sh` from the new release. It
  refuses, changing nothing, while a gateway is running from its directory.
- **An AppImage:** run `nimbus stop`, download the new `.AppImage` and use it in place of the old one.
  An AppImage runs from a copy of its binaries in `~/.cache/nimbus/appimage` (about 225 MB, see
  [`docs/sandbox.md`](./sandbox.md#linux)); delete an old version's directory there when you no longer need it.
- **A raw binary, or an archive unpacked and kept in its own directory:** `install.sh` always installs to
  `~/.local/bin`, so it would add a second copy and leave this one old. Run `nimbus stop` and replace every
  file there from the new archive.

On Linux, a raw `nimbus-gateway-linux-x64` has no `nimbus-sandbox-helper` beside it, so connectors that
declare a network reach the whole internet (a log warning and `nimbus doctor` `[warn]`). Copy
`bin/nimbus-sandbox-helper` from the Linux tarball beside that gateway, or use the tarball's `install.sh`,
which installs its own copy of everything to `~/.local/bin`.

## Universal fallback (scripted)

The read-it-yourself `install.sh` / `install.ps1` in each release archive install
per-user with no admin; re-running one from a newer release, after `nimbus stop`, is how they update. See
[`scripts/install/README.md`](../scripts/install/README.md).

> **Signing status:** Windows/macOS installers are currently **unsigned** (no
> certificates yet). You may see a SmartScreen / Gatekeeper warning. Verify the
> download's checksum + GPG signature as your trust anchor until signing lands.
