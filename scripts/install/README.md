# Nimbus Install Scripts

> **Package-manager & native-installer users:** see [`docs/install.md`](../../docs/install.md)
> for `brew`/`scoop` one-liners and the `.msi`/`.pkg`/`.rpm`/`.deb` matrix. The
> scripts below are the universal, read-it-yourself fallback.

Per-user installers bundled with v0.1.0+ release tarballs.

## Why scripts (alongside `.msi` / `.pkg`)

Native `.msi`/`.pkg` installers now ship (see [`docs/install.md`](../../docs/install.md))
but are currently **unsigned** until code-signing certificates are provisioned, so
SmartScreen / Gatekeeper warnings still apply — these scripts remain the universal,
read-it-yourself fallback you can inspect before running.

## What they do

| | Windows | macOS / Linux |
|---|---|---|
| Install dir | `%LOCALAPPDATA%\Programs\Nimbus\bin` | `~/.local/bin` |
| PATH update | `[Environment]::SetEnvironmentVariable("PATH", ..., "User")` (writes `HKCU\Environment`) | Idempotent block in `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, or `~/.profile` |
| Admin / sudo? | No | No |

`setx` is **not** used on Windows because it truncates `PATH` at 1024
characters. The `.NET` API has no such limit.

## Idempotency

The Unix scripts wrap their PATH line in sentinel comments:

```bash
# >>> nimbus PATH >>>
export PATH="…/.local/bin:$PATH"
# <<< nimbus PATH <<<
```

Re-running `install.sh` strips the existing block before appending a fresh one.
`uninstall.sh` removes only what's between the markers, never lines outside.

The Windows installer is idempotent via case-insensitive equality against the
install dir — re-running adds nothing if `%LOCALAPPDATA%\Programs\Nimbus\bin`
is already on User PATH.

## Usage

```bash
# Linux / macOS
./install.sh                        # interactive
./install.sh --yes                  # non-interactive
./install.sh --dry-run              # print planned actions, exit
./install.sh --local                # require binaries staged beside this script; never fetch a release
./install.sh --from-release         # download the latest release build over the network
./install.sh --from-release 2.2.0   # download a specific release build
```

```powershell
# Windows
.\install.ps1                            # interactive
.\install.ps1 -Yes                       # non-interactive
.\install.ps1 -DryRun                    # print planned actions, exit
.\install.ps1 -Local                     # require binaries staged beside this script; never fetch a release
.\install.ps1 -FromRelease 2.2.0         # download a specific release build
```

`-FromRelease` is a plain string parameter, so — unlike bash's `--from-release`
with no following token — it always requires an explicit version argument;
there is no bare `-FromRelease` short-hand for "latest" on Windows.

`--local`/`-Local` and `--from-release`/`-FromRelease` are mutually exclusive —
passing both is a hard error (`exit 2` / a thrown exception), not a
last-flag-wins fallback.

`--from-release`/`-FromRelease` always **forces remote mode**, even when
`nimbus`/`nimbus-gateway` binaries are already staged beside the script — this
matters because `release.yml` ships `install.sh`/`install.ps1` INSIDE every
macOS tarball and the Windows zip, alongside the binaries they unpack with.
Without that forcing behavior, running `--from-release 2.3.0` from inside an
already-extracted 2.2.0 archive would silently reinstall the 2.2.0 binaries
sitting next to the script instead of fetching 2.3.0.

Absent both flags (the default, "auto" mode), the script uses binaries staged
beside it if present, and falls back to fetching the latest release only if
none are found.

After install, **open a new shell** and run `nimbus --version`.

## Uninstall

```bash
./uninstall.sh --yes
```

```powershell
.\uninstall.ps1 -Yes
```
