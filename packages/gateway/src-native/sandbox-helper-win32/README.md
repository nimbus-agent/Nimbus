# nimbus-sandbox-helper (Windows)

AppContainer helper for the extension sandbox on Windows (I15).

Unlike the Linux helper, this one is **unprivileged**. `CreateAppContainerProfile`
is a per-user API and ACL edits inside the user's own profile need no elevation —
there is no install-time `setcap` equivalent, and no privilege step is added by
installing Nimbus on Windows. `--check-caps` accordingly probes that AppContainer
profile creation **works** on this machine, not that a capability is **held**.

## Modes

- `nimbus-sandbox-helper.exe --check-caps` — create (or derive) a throwaway
  `nimbus-ext-probe` AppContainer profile, delete it again, print `OK` and exit 0
  on success. Otherwise print a reason to stderr and exit 1. Used by the Gateway
  startup probe.

- `nimbus-sandbox-helper.exe --list-profiles` — print every `nimbus-`-prefixed
  AppContainer moniker registered under the current user's mappings key, one per
  line, exit 0.

- `nimbus-sandbox-helper.exe --delete-profile <name>` — delete the named
  AppContainer profile. Exit 0 on success or if the profile is already absent.
  Refuses (exit 64) to delete anything outside the `nimbus-` namespace.

- `nimbus-sandbox-helper.exe --profile <name> [...] -- <argv>` — **not yet
  implemented.** The spawn mode lands in a later task; until then this exits 64
  as an unknown mode.

## Exit-code contract

The helper cannot `execv` on Windows — it must wait on the child and propagate
its exit code — so helper-originated failures share the code space with the
child's own exit codes. Resolve this the way `sandbox-wrapper.ts` already does:
**stderr is authoritative**, every helper-originated line is prefixed
`nimbus-sandbox-helper:`, and the codes below are a hint, not a guarantee.

| Code | Meaning |
|---|---|
| 64 | usage error |
| 65 | AppContainer profile create/derive failed |
| 66 | ACL grant failed — path is on a filesystem without ACL support, or access denied |
| 67 | Job Object creation/assignment failed |
| 68 | `CreateProcessW` failed |
| other | the child's own exit code |

## Build

```powershell
bun run build:sandbox-helper:win32
```

Compiles with MSVC (`cl.exe`) via `scripts/build-sandbox-helper-win32.ps1`, which
locates the toolchain through `vswhere.exe` — no Developer Command Prompt
required. `/W4 /WX` mirrors the Linux helper's `-Wall -Wextra -Werror`.

## Design

See `docs/sandbox.md` and the PR 1 design spec §4 Windows.
