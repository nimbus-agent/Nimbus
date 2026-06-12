# Installing Nimbus (headless gateway + CLI)

| Platform | One-liner |
|---|---|
| macOS / Linux (Homebrew) | `brew install nimbus-agent/tap/nimbus` |
| Windows (Scoop) | `scoop bucket add nimbus https://github.com/nimbus-agent/scoop-bucket && scoop install nimbus` |
| Any (script) | Download the latest release tarball/zip and run `install.sh` / `install.ps1` |

Updates are owned by your installer: `brew upgrade nimbus`, `scoop update nimbus`, or
re-running the install script. When Nimbus is installed via a package manager its built-in
self-updater is disabled automatically, and `nimbus update` will point you back at your
package manager.

Direct downloads (raw binaries, `.tar.gz`, `.zip`, Linux `.deb` / AppImage) and their
`SHA256SUMS` + GPG signature remain on the
[releases page](https://github.com/nimbus-agent/Nimbus/releases).
