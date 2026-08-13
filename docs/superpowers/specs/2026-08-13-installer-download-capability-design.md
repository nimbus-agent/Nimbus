# Installer download capability + headless-Linux keyring remedy — design

**Date:** 2026-08-13
**Issues:** [#1167](https://github.com/nimbus-agent/Nimbus/issues/1167), [#1168](https://github.com/nimbus-agent/Nimbus/issues/1168)
**Status:** design approved, implementation pending

---

## Problem

### #1167 — the published installers cannot install

`scripts/install/unix/install.sh` and `scripts/install/windows/install.ps1` are
**local-staging** installers. They resolve `nimbus` / `nimbus-gateway` from
`$SCRIPT_DIR` (fallback `$SCRIPT_DIR/bin/`) and have **no download capability at
all**. Both are nevertheless published as standalone release assets
(`release.yml:634-637`), where no binaries sit beside them. Fetched standalone,
`install.sh` exits 1:

```
Error: cannot locate 'nimbus' or 'nimbus-gateway' beside /tmp/nimbus-install.sh
```

`install.ps1` fails worse under the documented `irm | iex`:
`$MyInvocation.MyCommand.Path` is `$null`, so `Split-Path -Parent $null` throws
under the script's own `$ErrorActionPreference = "Stop"` — before any of its own
error handling runs.

PR #1169 corrected the **docs** on both surfaces, so nothing now tells a user to
fetch these standalone. The assets remain published, broken, and undocumented.
This design makes them work.

**Why CI never caught it, and why that is structural.** `install-smoke.yml`
copies the built binaries next to the script (lines 143-157 Unix, 444-454
Windows) and then runs `"$STAGE/install.sh"`. That exercises the **tarball**
path — the one that works — and has never once exercised the documented one. A
PR has no published release to install from, so a PR-time job *structurally*
cannot cover the real URLs. `scripts/release/documented-asset-urls.ts` passed
throughout as well: it proves a documented URL names a staged asset, which is a
strictly weaker claim than the script running. Adding the standalone assets to
fix six 404s converted a clean 404 into a script that downloads fine and then
fails — harder to diagnose, not easier.

### #1168 — doctor's headless remedy does not work on headless boxes

Every failing Vault state appends `VAULT_UNLOCK_HINT`
(`packages/cli/src/commands/doctor-core.ts:80`), which says to run:

```sh
dbus-run-session -- bash -c 'echo "" | gnome-keyring-daemon --unlock --components=secrets; nimbus start'
```

On a box that has **never had a login keyring**, `--unlock` must *create* the
collection, which escalates to `gcr-prompter`, which fails with
`cannot open display`. A headless box is exactly the box with no login keyring,
so the remedy fails precisely where it is printed. Detection is good — `no-bus`,
`no-provider` and `no-collection` are correctly distinguished; only the remedy
is short.

---

## Non-goals

- Restoring the `curl | sh` one-liner to the docs **in this change** (see
  [Sequencing](#sequencing)).
- Publishing a Linux arm64 build. None exists; this design detects and reports
  that, it does not add one.
- Changing the archive-bundled install path, which works today.
- Any change to the Vault backend or its non-negotiable OS-native constraint.

---

## Design — the downloading installer

### Shape

**Hard constraint:** a curl'd script is one file and cannot source a sibling. The
download logic is therefore inline in each script. The rejected alternative —
assembling the standalone asset from modules under `scripts/install/lib/` at
release time — would make the published asset differ from the repo file,
destroying the "read-it-yourself" property that is these scripts' stated
justification (`scripts/install/README.md`).

**Two modes in one script:**

| Mode | Trigger | Behavior |
| --- | --- | --- |
| Local | binaries beside the script or in `./bin` | Unchanged, byte-for-byte. The path the archives and `install-smoke.yml` use. |
| Remote | no local binaries | Resolve → download → verify → extract → hand off to the same install logic. |

`--from-release [<ver>]` and `--local` force either mode explicitly, so
autodetection is never load-bearing in CI and a user can override it.

The local path must not regress. It is the only path that currently works.

### Version and asset resolution

**No GitHub API.** Unauthenticated it is 60 requests/hour per IP, shared across
GitHub-hosted runners; a scheduled 3-OS job would flake on it. Resolve the tag by
following the `/releases/latest` redirect instead:

- Unix: `curl -fsSLI -o /dev/null -w '%{url_effective}' <repo>/releases/latest`
  → `.../releases/tag/vX.Y.Z`, take the last segment.
- PowerShell 7: `$r.BaseResponse.RequestMessage.RequestUri`, same extraction.

Resolution is required regardless of platform, because the Linux tarball name
carries the version.

| Platform | Asset | Base |
| --- | --- | --- |
| linux x64 | `nimbus-headless-linux-amd64-v<ver>.tar.gz` | `/releases/download/v<ver>/` |
| macos arm64 | `nimbus-headless-macos-arm64.tar.gz` | `/releases/latest/download/` |
| macos x64 | `nimbus-headless-macos-x64.tar.gz` | `/releases/latest/download/` |
| windows x64 | `nimbus-headless-windows-x64.zip` | `/releases/latest/download/` |
| **linux arm64** | **none published** | fail with an explicit message |

Linux arm64 is a real gap, not a theoretical one: Ampere, Graviton, Raspberry Pi,
and any arm64 Linux container on an Apple Silicon host land there. The installer
must say "no Linux arm64 build is published — build from source, or use x64
emulation" rather than requesting a URL that 404s.

### Trust model

**Hash mandatory, signature best-effort, claims exact.**

1. Fetch `SHA256SUMS` from the same release.
2. Compute the archive digest — `sha256sum`, `shasum -a 256`, or `Get-FileHash`;
   one of these is present on every target platform, so this step can never be
   skipped for lack of tooling.
3. Mismatch or a missing manifest entry **aborts**. Nothing is extracted.
4. If `gpg` is available, fetch `SHA256SUMS.asc` and verify it against the pinned
   fingerprint `5A20457CCD8B53FFAA945240886ADA6B487CAB6E` (the value already in
   `scripts/release/nimbus-verify.sh`). A verification failure aborts.
5. If `gpg` is absent, continue, and print that the signature was **not**
   checked, naming `nimbus-verify.sh` as the way to check it.

The script prints exactly which of the two checks ran. It never reports a
signature check it did not perform. Mandatory GPG was rejected because it
hard-depends on `gpg` plus a keyserver fetch — absent on minimal containers and
most Windows boxes — which would reproduce the failure this work exists to fix.

### The two interactive traps

These are the substance of #1167, not incidental details.

**Unix — stdin is the script.** Under `curl ... | sh`, the script arrives on
stdin, so today's `read -r answer` would consume script text rather than user
input. Remote mode reads prompts from `/dev/tty` when one is available, and when
there is no tty it refuses to prompt and requires `--yes`, rather than silently
consuming input. The documented invocation form is
`curl -fsSL <url> | sh -s -- --yes`.

**Windows — `param()` does not bind under `iex`, and the script root is null.**
Treat a null `$PSScriptRoot` / `$PSCommandPath` as *remote mode* instead of an
error; that null-deref under `ErrorActionPreference = "Stop"` is the live bug.
The documented argument-passing form is
`& ([scriptblock]::Create((irm <url>))) -Yes`.

### Anti-drift

The asset-name table gets a TypeScript mirror under `scripts/install/lib/`
(alongside the existing `markers.ts` / `paths.ts`, which are pure logic mirrored
for testability), plus a test asserting that **every asset name the installer
requests is actually staged by `release.yml`**. This is the technique
`scripts/release/documented-asset-urls.ts` already applies to the docs, aimed
here at the installer — directly at the #1167 bug class, where a promised asset
and a produced asset diverged.

---

## Design — `nimbus doctor --fix-keyring` (#1168)

### Surface

`runDoctor(_args: string[], deps)` currently **ignores its arguments entirely**;
this introduces flag parsing to doctor for the first time.

Doctor is deliberately non-mutating today — `DOCTOR_VAULT_PROBE_ATTRS` is
documented as unable to "create, modify or leave behind anything". A mutating
flag changes doctor's character, so:

- It is **strictly opt-in**. A plain `nimbus doctor` remains read-only.
- It announces what it will do before doing it.
- It is Linux-only; elsewhere it reports not-applicable and exits 0.
- It goes through the existing `DoctorVaultExec` DI seam, so tests never touch a
  real `~/.local/share/keyrings`.

### The safety constraint

**If a keyring already exists, `--fix-keyring` refuses and explains. It never
overwrites.** Clobbering `login.keyring` would destroy every credential the user
has stored in the OS vault. This guard is the single most important behavior in
the feature and gets a dedicated test.

The command creates the collection and nothing else. It stores no secret and
writes no Nimbus credential.

### Mechanism: deliberately unspecified here

The available evidence is that pre-creating `~/.local/share/keyrings/login.keyring`
plus a `default` pointer was the only difference between a failing and a passing
container run. Whether `gnome-keyring-daemon` can be driven to create the
collection headlessly, versus Nimbus writing files in its on-disk format, is an
**empirical question, and this spec does not answer it from reasoning**.

The mechanism is settled by a container spike before implementation, and the
remedy string doctor prints is copied verbatim from a run that actually
succeeded. Writing down a command that was never executed is how `sudo dpkg -i`
— which exits 1, because the package depends on `bubblewrap` and `libcap2-bin` —
reached the docs in the first place.

---

## Testing

Three layers. The middle one is what would have caught #1167.

1. **Unit.** Asset-name mapping in `scripts/install/lib/`, plus the drift test
   against `release.yml` described above.
2. **PR-time, hermetic.** Extend `install-smoke.yml` — it already has the 3-OS
   matrix and a sandboxed `HOME` / `LOCALAPPDATA` — with a job that **serves** an
   archive + `SHA256SUMS` over localhost, points the script at it through the
   test-only base-URL override `NIMBUS_INSTALL_BASE_URL`, and runs the real
   script end to end.

   Naming caution: `install-smoke.yml` already has a step called *"Stage a fake
   release dir"* which does **not** serve anything — it is the local-staging
   copy. The new job must not reuse that name, or the workflow will read as
   though the remote path was already covered. Call it what it is: a served
   release fixture.

   `NIMBUS_INSTALL_BASE_URL` redirects where executable binaries are fetched
   from, so it is documented as testing-only. This is the same seam rustup and
   deno expose; an attacker able to set it can already run code as the user, so
   it adds no privilege — but it must never be presented as a user-facing knob.
3. **Post-release, real.** Extend `released-install-smoke.yml` with the true
   one-liner against published assets.

**Two of these must be red-proven or they are decoration:**

- The fake-release job must be observed **failing** against a deliberately
  broken script.
- The hash check must be observed **rejecting a tampered archive**. A
  verification step that has never failed proves nothing.

Any new CI gate must be added to `scripts/lib/preflight-gates.ts` or the drift
test fails.

---

## Sequencing

**The one-liner is not restored to the docs in this change.** The capability
becomes true for users only at the *next release*. Docs merged to `main` today
would again promise a command that does not work — the same shape as #1167.

Order:

1. This change: capability + CI + tests. No new install promises in the docs.
2. Next release publishes installers that can actually download.
3. `released-install-smoke.yml` is **dispatched by hand** — its `release:`
   trigger has never fired, because it merged after v2.2.0 was published, so it
   ships unproven until someone runs it.
4. Once green, a small follow-up restores the `curl | sh` / `irm | iex`
   one-liner to `README.md` and `install.mdx`.

## Also in scope

- `docs/install.md:31` and `docs/README.md:362` still say `sudo dpkg -i`, which
  exits 1 leaving the package unconfigured; the working command is
  `sudo apt install ./<file>.deb`. #1169 fixed the root `README.md` and
  `install.mdx` and missed these two surfaces.
- `release.yml:625-633` justifies staging the standalone scripts by citing a
  README quickstart that #1169 deleted. The comment is now false and is updated
  to state the real reason: the scripts are self-bootstrapping.

---

## Acceptance criteria

1. `install.sh` fetched standalone, with no binaries beside it, installs a
   working `nimbus` on Linux x64 and macOS (both arches).
2. `install.ps1` fetched via `irm | iex` installs a working `nimbus` on Windows
   x64 — no null-path throw.
3. Local mode is unchanged; `install-smoke.yml`'s existing assertions pass
   untouched.
4. A tampered archive is rejected, and this is demonstrated by a test that was
   observed to fail before the check existed.
5. On Linux arm64 the installer reports the missing build explicitly; it does
   not request a 404.
6. Without `gpg`, install succeeds and the output states the signature was not
   verified.
7. `nimbus doctor --fix-keyring` refuses to touch an existing keyring.
8. The remedy string doctor prints has been executed successfully in a clean
   container.
9. Every asset name the installer requests is staged by `release.yml`, enforced
   by test.
