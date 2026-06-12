# Specification Review: Proper Installer & Distribution for Nimbus

**Review Date:** 2026-06-12  
**Target Design Spec:** [2026-06-12-installer-distribution-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/installer-distribution/docs/superpowers/specs/2026-06-12-installer-distribution-design.md)  
**Status:** Under Review / Recommendations Formulated

---

## Summary of Findings & Suggestions

While the proposed design is solid and aligns perfectly with Nimbus's local-first architecture and existing release pipeline, several key areas require clarification or enhancement before proceeding to implementation.

These have been categorized into:

1. **Self-Updater Conflict Prevention** (Critical)
2. **macOS `.pkg` Permissions & Symlink Scope**
3. **Windows `.msi` Installation Scope & WiX Bootstrap**
4. **Linux APT/YUM Repo Signing & Modern Security Standards**
5. **CI Runner Tooling Setup**

---

## 1. Critical: Self-Updater Conflict Prevention

### The Issue

Nimbus currently has an Ed25519 auto-updater. If a user installs Nimbus via a package manager (`brew`, `scoop`, `winget`, `apt`, `yum`), and Nimbus auto-updates itself, it will bypass the package manager's package database.

- This results in the package manager reporting a different version than what is actually installed.
- Subsequent updates via the package manager might fail, downgrade, or leave orphan files.
- On Linux, updating the binary in a system folder (like `/usr/bin`) requires root privileges, which the gateway/CLI normally won't have during runtime.

### Recommendations

- **Detection & Disabling:** The CLI and Gateway should detect if they are running from a package-managed installation.
  - **Compile-time flags / Env variables:** Set a build flag or environment variable during package building (e.g., `NIMBUS_DISTRIBUTION_CHANNEL=brew`), or detect if the binary path matches typical package manager paths.
  - **Behavior:** When a package manager distribution is detected, the automatic check for updates should be disabled, and any manual update commands (e.g., `nimbus update`) should prompt the user to use their package manager instead (e.g., `"Nimbus was installed via Homebrew. Please run 'brew upgrade nimbus' to update."`).

---

## 2. macOS `.pkg` Permissions & Symlink Scope

### The Issue

The spec states: "Installs binaries plus a `postinstall` that symlinks into `/usr/local/bin`."

- `/usr/local/bin` is system-wide and typically owned by `root`. On modern macOS, writing to it during a user-scoped `.pkg` install will fail or prompt for administrative credentials (sudo).
- If the `.pkg` is set to run as a user-level installer (`Standard` install without requiring authorization), it cannot write to `/usr/local/bin`.
- If the `.pkg` runs with `Require Authorization`, the user must input their administrator password. Since Nimbus is headless and run by developers, a user-level installation is often preferred to avoid elevating privileges.

### Recommendations

- **Per-User Option:** Decide whether the `.pkg` is system-wide (requires root/admin password) or user-scoped (installs to `~/Applications` or `~/.nimbus/bin` and updates the user's shell profile like `.zshrc` / `.bash_profile`).
- **Symlink Handling:** If system-wide, clearly document the admin privilege requirement during installation. If user-scoped, avoid `/usr/local/bin` and update the PATH environment variable in shell config files, reusing parts of the Unix install script (`scripts/install/unix/install.sh`).

---

## 3. Windows `.msi` Installation Scope & WiX Bootstrap

### The Issue

- **Installation Scope:** Standard `.msi` installers default to system-wide installation (`C:\Program Files`), which requires elevated UAC permissions. The spec states it installs to `%LOCALAPPDATA%\Programs\Nimbus\bin`.
- **WiX v5 Tooling:** GitHub Actions Windows runners do not include WiX v5 by default.

### Recommendations

- **MSI Package Configuration:** Explicitly configure the MSI's `Package` tag with `InstallScope="perUser"` and set `ALLUSERS` to `""` in the WiX source file. This guarantees that UAC elevation is not requested and installation seamlessly targets `%LOCALAPPDATA%`.
- **WiX Tooling Bootstrapping:** In `.github/workflows/release.yml`, bootstrap WiX v5 by running `dotnet tool install --global wix` before triggering `package-windows-installer.ps1`.

---

## 4. Linux APT/YUM Repo Signing & Modern Security Standards

### The Issue

- **Apt-key Deprecation:** Debian/Ubuntu have deprecated `apt-key add`. Systems now show security warnings if keys are added directly to the global keyring.
- **Repository Secrets:** Signing the APT/YUM repos requires the private GPG key in the CI environment.

### Recommendations

- **Modern APT Source Setup:** Update the installation documentation to use the modern `signed-by` option:

  ```bash
  curl -fsSL https://pkg.nimbus.dev/gpg.key | gpg --dearmor -o /usr/share/keyrings/nimbus-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/nimbus-archive-keyring.gpg] https://pkg.nimbus.dev/apt stable main" | sudo tee /etc/apt/sources.list.d/nimbus.list
  ```

- **Repository Automation Signing:** Ensure that the workflow `publish-linux-repo.yml` has access to the GPG private key secret (e.g., `NIMBUS_GPG_PRIVATE_KEY`) and uses `gpg --import` securely inside the runner without leaking it in logs.

---

## 5. CI Runner Tooling Setup (nfpm)

### The Issue

`nfpm` needs to run during the Linux packaging phase. It is not pre-installed on the default GitHub Actions runner.

### Recommendations

- **Bootstrap nfpm:** In `scripts/package-linux-installers.ts` or the GitHub Actions runner setup steps, download the `nfpm` binary directly from Goreleaser's GitHub releases or run it via a setup action (e.g., `goreleaser/filter-repo` or simply downloading the single Go binary), ensuring deterministic version locking of `nfpm`.

---

## Open Questions for the Spec Review

1. **Uninstall Flow:** Since package managers clean up after themselves, how do we clean up custom installer artifacts (like the user-level path addition for Windows MSI or the macOS symlink)? Should we register an uninstall hook in MSI / pkg post-install?
2. **Channel Consistency:** Should the external channel repositories (`nimbus-dev/homebrew-tap` and `nimbus-dev/scoop-bucket`) support pre-releases (e.g. `vN.N.N-beta.X`) or only stable releases? Homebrew core generally discourages pre-releases, but custom taps can support them.
