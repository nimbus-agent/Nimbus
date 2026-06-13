# Nimbus Install Scripts

> **Package-manager & native-installer users:** see [`docs/install.md`](../../docs/install.md)
> for `brew`/`scoop` one-liners and the `.msi`/`.pkg`/`.rpm`/`.deb` matrix. The
> scripts below are the universal, read-it-yourself fallback.

Per-user installers bundled with v0.1.0+ release tarballs.

## Why scripts (not signed `.msi` / `.pkg`)

v0.1.0 ships unsigned on macOS and Windows. A signed installer would still trip
SmartScreen / Gatekeeper warnings until the publisher reputation builds, so we
keep the install surface as a plain text script you can read before running.

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
./install.sh             # interactive
./install.sh --yes       # non-interactive
./install.sh --dry-run   # print planned actions, exit
```

```powershell
# Windows
.\install.ps1            # interactive
.\install.ps1 -Yes       # non-interactive
.\install.ps1 -DryRun    # print planned actions, exit
```

After install, **open a new shell** and run `nimbus --version`.

## Uninstall

```bash
./uninstall.sh --yes
```

```powershell
.\uninstall.ps1 -Yes
```
