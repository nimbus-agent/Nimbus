# Cross-platform support

Windows 10+, macOS 13+, and Ubuntu 22.04+ are equally supported. Every PR runs a full gate on Ubuntu; pushes to `main` run the full three-platform matrix in parallel. Platform-specific code (IPC, secrets, autostart, notifications) lives behind a typed `PlatformServices` abstraction — business logic never knows which OS it's on.

| | Windows 10+ | macOS 13+ | Ubuntu 22.04+ † |
|---|---|---|---|
| **Gateway IPC** | Named Pipe | Unix Socket | Unix Socket |
| **Secrets** | DPAPI | Keychain | libsecret |
| **Autostart** | Registry | LaunchAgents | systemd user |
| **Notifications** | Win32 Toast | NSUserNotification | libnotify/D-Bus |
| **Config dir** | `%APPDATA%\Nimbus` | `~/Library/…/Nimbus` | `~/.config/nimbus` |
| **Desktop UI** | WebView2 | WKWebView | WebKitGTK |
| **CI runner** | `windows-2025` | `macos-15` | `ubuntu-24.04` |
| **Release** | `.zip` (unsigned, v0.1.0 cut-line) † | `.tar.gz` (unsigned, v0.1.0 cut-line) † | `.deb` (GPG-signed) + AppImage |

† **Ubuntu 22.04 is supported for source builds only.** Pre-built Linux binaries are compiled on Ubuntu 24.04 and require **glibc ≥ 2.39** at runtime (Ubuntu 24.04+, Fedora 40+, Debian 13+, Arch / other current rolling releases). Ubuntu 22.04 LTS, Debian 12, and RHEL 9 (and derivatives) will fail with `GLIBC_2.39 not found`. See [SECURITY.md](./SECURITY.md#linux-runtime-support--glibc-floor) for the canonical supported-distro list and rationale.

† **macOS and Windows ship unsigned in v0.1.0.** Cross-platform integrity is provided by the GPG-signed `SHA256SUMS.asc` manifest. macOS Gatekeeper and Windows SmartScreen will prompt on first run; this is expected. Apple Developer notarization and Windows Authenticode signing are deferred to a later point release — see [signing-keys.md](./release/signing-keys.md#v010-signing-cut-line).
