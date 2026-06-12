# Proper Installer & Distribution for Nimbus (headless) — Design

**Date:** 2026-06-12
**Status:** Approved (brainstorming) — review incorporated — pending implementation plan
**Revision:** r2 — incorporated spec review (updater coexistence, per-user install scope, uninstall, pre-release policy; see §6.1, §9)
**Scope:** Headless Gateway + CLI distribution. The Tauri 2.0 desktop app (Phase 13) is explicitly out of scope.

---

## 1. Problem & Goals

Nimbus ships a mature signed release pipeline (`release.yml`) that already produces
per-platform Gateway + CLI binaries, Linux `.deb` / AppImage / tarball, `SHA256SUMS`,
an SBOM, build-provenance attestations, and an Ed25519 auto-updater. What it lacks is a
**"proper installer" surface**: native double-click installers, package-manager channels,
and OS code-signing.

The user wants all four gaps closed for the headless product:

1. **Native double-click installers** — `.msi` (Windows), `.pkg` (macOS), plus `.rpm` to round out Linux.
2. **OS trust / no scary warnings** — real code-signing + notarization, built as a *pluggable* seam (see §6).
3. **Package-manager install** — Homebrew, Scoop, winget, and a hosted apt/yum repo.
4. **Desktop app install** — *deferred*; tracked with Phase 13, not built here.

### Non-goals

- No Tauri desktop bundling (`packages/ui`) — deferred to Phase 13.
- No purchase of code-signing certificates as part of this work. The pipeline is built
  **signing-ready but unsigned**; trusted installers activate the day cert secrets land.
- No `.dmg` — that format is for drag-installing a `.app`; wrong shape for a headless CLI.

---

## 2. Guiding Principle

**Layer onto the existing release flow; do not replace it.** The release tag
(`vN.N.N` / pre-release `vN.N.N-*`) stays the single trigger. We add
artifact-producing steps to `release.yml` and post-release *publish* jobs for the
package-manager channels. Channel content (Homebrew formula, Scoop manifest) lives in
**separate small repos** under the `nimbus-dev` GitHub org, updated by CI on each release.

No `packages/` changes — this is pure release infrastructure under `scripts/` and
`.github/workflows/`.

---

## 3. Tooling Approach (selected: A)

**A — Extend the existing pipeline, signing-pluggable**, borrowing `nfpm` from approach B
for clean `.deb`/`.rpm` generation.

Rejected alternatives:

- **B — Adopt GoReleaser/full toolkit:** Go-project-centric, fights the Bun monorepo, and
  would displace the existing bespoke signing/attestation steps that already work. We take
  only `nfpm` (a focused `.deb`/`.rpm`/`.apk` builder) from it.
- **C — Package managers only, skip native installers:** drops two stated goals
  (native installers; winget wants an `.msi`).

---

## 4. Reused Existing Assets

| Asset | Role it already plays |
|---|---|
| `scripts/package-headless-bundle.ts` | Produces the bundle dir (gateway + cli + embedding model) |
| `scripts/package-linux-installers.ts` | `.deb` + tarball + AppImage today; gains `.rpm` via nfpm |
| `scripts/install/` (`unix/`, `windows/`, `lib/`) | Per-user PATH-managing install/uninstall scripts + tested `markers`/`paths` libs — PATH logic reused by the `.msi` |
| `scripts/release/nimbus-verify.{sh,ps1}` | Checksum + GPG verification — extended to new artifacts |
| `scripts/sign-linux-gpg.sh`, `scripts/sign-ed25519.ts` | Existing signing steps — join the unified seam convention |
| `release.yml` | Build matrix, signing hooks, `SHA256SUMS`, SBOM, GitHub Release publish |
| Ed25519 auto-updater + signed manifest | Direct-download path keeps it enabled; managed builds disable it via the existing `NIMBUS_UPDATER_DISABLE` switch (see §6.1) so the package manager owns updates |

---

## 5. Slice Decomposition (value-first, each independently shippable)

### Slice 1 — Homebrew tap + Scoop  *(lowest effort, biggest immediate win)*

- New repos: `nimbus-dev/homebrew-tap` (`Formula/nimbus.rb`) and
  `nimbus-dev/scoop-bucket` (`bucket/nimbus.json`).
- Formula/manifest download the existing release tarball and verify its sha256 (read from
  the release `SHA256SUMS`).
- New workflow `publish-package-managers.yml` (on release published) renders both files from
  the tag version + checksums and commits/PRs to each repo via a scoped token.
- **Result:** `brew install nimbus-dev/tap/nimbus` and `scoop install nimbus`;
  `brew upgrade` / `scoop update` handle updates.

### Slice 2 — Native installers `.msi` + `.pkg` + `.rpm`  *(foundation for Slices 3 & 4)*

- **`.msi`** — WiX v5 on the Windows runner (`scripts/package-windows-installer.ps1`).
  Installs `nimbus.exe` + `nimbus-gateway.exe` to `%LOCALAPPDATA%\Programs\Nimbus\bin`;
  adds it to **User** PATH (reusing the proven logic in `scripts/install/windows/install.ps1`,
  i.e. the `.NET` `SetEnvironmentVariable` approach, never `setx`); registers an
  Add/Remove Programs entry with a stable `UpgradeCode` for in-place upgrades.
  **Per-user, UAC-free:** the WiX `Package` is authored `InstallScope="perUser"` with
  `ALLUSERS=""`, so the install targets `%LOCALAPPDATA%` without an elevation prompt and
  matches the no-admin posture of the existing install scripts. Uninstall is handled
  natively by the MSI's Add/Remove Programs registration (no custom uninstaller needed).
- **`.pkg`** — `pkgbuild` + `productbuild` on the macOS runner
  (`scripts/package-macos-installer.sh`). **User-scoped, no sudo:** the `.pkg` is authored as
  a *user* install (no `RequireAuthorization`) writing to `~/.local/bin` (binaries) and
  updating the user's shell profile via the **same idempotent PATH-marker logic already in
  `scripts/install/unix/install.sh`** — **not** `/usr/local/bin`, which is root-owned and
  would force an admin prompt, contradicting Nimbus's per-user philosophy. Because macOS
  `.pkg` has no native Add/Remove-Programs equivalent, the package ships an
  `uninstall-nimbus` script (reusing `scripts/install/unix/uninstall.sh`) and the design
  records its installed files via the pkg receipt for clean removal.
- **`.rpm`** — add `nfpm` to `scripts/package-linux-installers.ts` (one config →
  `.deb` + `.rpm`). Keep the existing `.deb`/AppImage/tarball outputs; nfpm runs alongside
  (or replaces only the `.deb` internals if the swap is clean and tests stay green).
- All three: attached to the GitHub Release, flow through `SHA256SUMS`, and pass through the
  signing seam (§6).

### Slice 3 — winget  *(depends on the `.msi` from Slice 2)*

- `publish-package-managers.yml` gains a `winget` job using `wingetcreate` to auto-open a PR
  to `microsoft/winget-pkgs` pointing at the released `.msi`.
- Best-effort: Microsoft PR review + SmartScreen reputation still apply while unsigned;
  documented honestly.

### Slice 4 — Hosted apt/yum repo  *(highest effort, last)*

- Static, GPG-signed repos generated with `reprepro` (apt) + `createrepo_c` (yum) from the
  released `.deb` / `.rpm`, signed with the **existing release GPG secrets**
  (`GPG_SIGNING_SUBKEY` + `GPG_PASSPHRASE` — the same pair `sign-linux-gpg.sh` already
  imports; **no new `NIMBUS_GPG_PRIVATE_KEY` secret**). `publish-linux-repo.yml` imports the
  key into an ephemeral `GNUPGHOME` and never echoes it.
- **Modern client trust (not deprecated `apt-key`).** The published install docs use the
  `signed-by` keyring form:

  ```bash
  curl -fsSL https://pkg.nimbus.dev/gpg.key | gpg --dearmor -o /usr/share/keyrings/nimbus-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/nimbus-archive-keyring.gpg] https://pkg.nimbus.dev/apt stable main" | sudo tee /etc/apt/sources.list.d/nimbus.list
  ```

- Hosted on GitHub Pages (target domain e.g. `pkg.nimbus.dev`, TBD with the docs domain) so
  `apt install nimbus` / `dnf install nimbus` work and auto-update.
- New workflow `publish-linux-repo.yml`.

---

## 6. Cross-Cutting Concerns

### 6.1 Updater ↔ package-manager coexistence (load-bearing)

The Ed25519 self-updater and a package-manager install **must not both own the binary**, or
the package DB reports a stale version, later `apt`/`brew` upgrades clash or downgrade, and on
Linux the running (unprivileged) process can't even write a root-owned install path. The
design resolves this by making **package/installer builds the source of truth for updates**:

- **Disable the self-updater in managed builds.** The mechanism already exists —
  `NIMBUS_UPDATER_DISABLE=1` flips `updater.enabled=false` (`config/nimbus-toml.ts:411`). Every
  packaged artifact (`.msi`/`.pkg`/`.rpm`/`.deb` + brew/scoop) bakes a disabled-updater default
  (env baked into the launcher or a shipped `nimbus.toml` with `[updater].enabled=false`). No
  new gateway mechanism is required.
- **Channel marker + helpful nudge.** Builds stamp the channel they came from (e.g.
  `NIMBUS_DISTRIBUTION_CHANNEL=homebrew|scoop|winget|apt|yum|msi|pkg`). When the updater is
  disabled and the user runs `nimbus update`, the CLI prints the channel-appropriate command
  instead of self-updating (`"Installed via Homebrew — run 'brew upgrade nimbus'."`). The
  standalone tarball / direct-download path keeps the self-updater **enabled** (unchanged).
- **Net effect:** each install path has exactly one updater. This is the one place the spec
  touches CLI/gateway behavior; it is a small, additive config-default + message change, not a
  new subsystem. (A `NIMBUS_DISTRIBUTION_CHANNEL` read is the only new code; the disable switch
  reuses what exists.)

### Signing seam (the load-bearing design choice)

New `scripts/sign/` directory unifying the convention:

- `sign-windows.ps1` — `signtool`, gated on `WINDOWS_CERT_*` secrets.
- `sign-macos.sh` — `codesign` + `notarytool`, gated on `APPLE_*` secrets.
- Existing `sign-linux-gpg.sh` + `sign-ed25519.ts` adopt the same convention.

**Contract:** each step is `if secret present → sign, else → warn + exit 0`. The pipeline
shape is identical signed or unsigned. Adding cert secrets later flips every channel to
trusted with **zero pipeline rework**.

### Verification

Extend `scripts/release/nimbus-verify.{sh,ps1}` to cover the new artifacts. They already
validate against `SHA256SUMS` + GPG; the new artifacts are staged into the same `SHA256SUMS`.

### Testing (mirrors existing patterns)

- Unit-test the **generators** — formula / scoop manifest / winget manifest / nfpm config
  rendering from `(version, checksums)` — following `package-linux-installers.test.ts` and
  `nimbus-verify.test.ts`.
- Native installer binaries (`.msi` via WiX, `.pkg` via `pkgbuild`) **cannot** be built
  cross-platform in unit tests; they get a smoke build in their native CI job.
- Each slice is its own PR with its own tests. New `test:scripts` entries register
  accordingly.

### Documentation

- New install page in `docs/` presenting the channel matrix + one-liners per platform.
- Update `scripts/install/README.md` to point package-manager users at the new page; keep the
  read-it-yourself `install.sh` / `install.ps1` as the universal unsigned fallback.

### Where code lives

- Packaging scripts → `scripts/` (matching `package-headless-bundle.ts`,
  `package-linux-installers.ts`).
- CI → `.github/workflows/` (`publish-package-managers.yml`, `publish-linux-repo.yml`;
  edits to `release.yml`).
- Channel content → new external repos (`homebrew-tap`, `scoop-bucket`).

---

## 7. Assumed Defaults (confirm at spec review)

- External channel repos live under the **`nimbus-dev`** GitHub org.
- apt/yum repo hosted on **GitHub Pages** (final domain TBD).
- **Reuse the existing release GPG key** for apt/yum repo signing.
- macOS native installer is **`.pkg`**, not `.dmg`.

---

## 8. Deliverable Order

Slice 1 → 2 → 3 → 4. Slice 1 yields `brew`/`scoop` one-liners almost immediately;
Slice 2 unlocks native installers + winget; Slice 4 (hosted repo) is the heavy lift last.
Each slice is a standalone PR.

---

## 9. Pre-release Policy & Deferred Implementation Details

### Pre-release channel policy

`release.yml` already flips `vN.N.N-{rc,beta,alpha}.*` tags to GitHub **Pre-release**.
Package-manager channels track **stable releases only** — `publish-package-managers.yml` and
`publish-linux-repo.yml` no-op on pre-release tags. Pre-release builds remain available as
direct GitHub Release downloads (and via the self-updater's pre-release opt-in, unchanged).
This keeps `brew`/`scoop`/`winget`/`apt` pointed at stable, matching ecosystem norms.

### Deferred to the per-slice implementation plans (correct, but impl-level, not design)

These were raised in review, accepted as correct, and belong in the slice plans rather than
the design:

- **Slice 2 — WiX bootstrap:** GitHub Windows runners lack WiX v5; the release job runs
  `dotnet tool install --global wix` (pinned version) before `package-windows-installer.ps1`.
- **Slice 2 — nfpm bootstrap:** nfpm isn't pre-installed; download a **version-pinned** nfpm
  binary in the Linux packaging step (checksum-verified), not "latest".
- **Slice 4 — apt/yum client docs** use the `signed-by` keyring form shown in §5/Slice 4;
  no `apt-key add`.

These carry no design ambiguity — they are recorded so the implementer doesn't rediscover them.
