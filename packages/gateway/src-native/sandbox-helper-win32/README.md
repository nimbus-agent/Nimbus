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

- `nimbus-sandbox-helper.exe --profile <name> --cwd <path> [--capability internetClient]
  [--grant-read <path>]… [--grant-write <path>]… -- <argv…>` — the spawn mode. Creates
  (or derives) the named AppContainer profile, grants its SID the ACEs described below,
  assigns a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so a crashed or killed
  helper cannot orphan the child, then `CreateProcessW`s `<argv…>` inside the container
  with stdio inherited from the helper. The helper waits on the child and exits with the
  child's own exit code (see the exit-code contract below — `65`–`68` are reserved for
  helper-originated failures that occur before the child ever runs).

  ### ACL grants — per level, not uniform

  A Task 1 spike measured, rather than assumed, that a Bun child cannot load a script
  from a leaf-only read grant: Bun walks **upward** from the working directory looking
  for `package.json` / `bunfig.toml` at every ancestor level, which needs *list* rights
  (not merely traverse) at each level, plus *write* on the leaf for its own housekeeping.
  So the grant is per-level, and the inheritance flag on each grant is deliberate, not
  incidental:

  | What | Rights | Inheritance | Why |
  |---|---|---|---|
  | `--cwd` (the leaf) | Read + Execute + Write | `SUB_CONTAINERS_AND_OBJECTS_INHERIT` | the child works inside it — an inheritable grant is correct because the leaf's whole subtree *is* the working directory |
  | `--cwd`'s ancestors | Read + Execute | `NO_INHERITANCE` | listable **only that directory**, never its children. An inheritable grant here would hand the container every sibling subtree beneath each ancestor — the parent directory's entire contents, not just the path down to `--cwd` |
  | `--grant-read` / `--grant-write` paths | Read+Execute, or Read+Execute+Write | `SUB_CONTAINERS_AND_OBJECTS_INHERIT` | a policy path means its whole subtree, so it inherits like the leaf |
  | policy paths' ancestors | — (no grant at all) | n/a | Windows bypasses traverse checking by default, so a known full path opens without listing rights on the way down — confirmed by hand (see Verification below), not assumed. If a connector ever needs more, that is a deliberate, recorded widening, not a default |

  A path that cannot be granted (ACL write fails — including on a filesystem without ACL
  support, such as FAT32/exFAT or some network shares) aborts the spawn with exit `66`.
  The helper never falls back to spawning unconfined: a policy path the child cannot read
  is a failure to enforce the policy, not a warning.

  **Caveat — `--cwd` under the real user profile.** The ancestor walk needs `WRITE_DAC`
  (permission to modify the DACL) on every ancestor up to the volume root. On a default,
  non-elevated Windows install, `C:\Users` itself denies `WRITE_DAC` to a standard user
  token even for that user's own subtree beneath it — confirmed on this machine with a
  real spawn attempt, which failed with exit `66` (`SetNamedSecurityInfoW(C:\Users):
  5` / `ERROR_ACCESS_DENIED`) once the ancestor walk reached `C:\Users`. Any `--cwd`
  nested under the user's real profile (`%TEMP%`, `%LOCALAPPDATA%`, `%APPDATA%`, the
  user's home directory, …) hits this wall. A `--cwd` outside that tree — under a
  directory the current user owns outright (verified here with a working directory
  under a git-cloned repo root) — does not, and spawns succeed. Choosing where a
  connector's working directory lives is outside this helper's scope (see Task 5's
  `win32.ts`); this note exists so that scope, if it lands `--cwd` under the user's
  own profile, does not rediscover this the hard way.

  ### Argv quoting

  The child's command line is rebuilt from `argv` — Windows has no `execv`-with-argv-array,
  only a single command-line string that the child's CRT re-splits. Naive
  `"arg1" "arg2"` quoting corrupts two reachable cases: an argument containing a literal
  double quote (a user-registered MCP server's `args_json` can carry one — see
  `connectors/lazy-mesh/user-mcp-store.ts`), and an argument ending in a backslash (any
  Windows directory path, e.g. `C:\dir\`), which would otherwise escape the closing quote
  and swallow the next argument. The helper implements the exact inverse of
  `CommandLineToArgvW`'s parsing rules: a run of backslashes is literal unless it precedes
  a double quote or the argument's closing quote, in which case each backslash doubles;
  a literal double quote is escaped as `\"`.

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
