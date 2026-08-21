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

  | What | Rights | Inheritance | On grant failure |
  |---|---|---|---|
  | `--cwd` (the leaf) | Read + Execute + Write | `SUB_CONTAINERS_AND_OBJECTS_INHERIT` | **fail closed** — aborts the spawn with exit `66` |
  | `--cwd`'s ancestors | Read + Execute | `NO_INHERITANCE` | **best-effort** — note on stderr, stop climbing, continue the spawn (see below) |
  | `--grant-read` / `--grant-write` paths | Read+Execute, or Read+Execute+Write | `SUB_CONTAINERS_AND_OBJECTS_INHERIT` | **fail closed** — aborts the spawn with exit `66` |
  | policy paths' ancestors | — (no grant at all) | n/a | n/a — never attempted; see below |

  The leaf inherits because the leaf's whole subtree *is* the working directory. An
  ancestor gets `NO_INHERITANCE` because it is being made listable **only as that one
  directory**, never its children — an inheritable grant there would hand the container
  every sibling subtree beneath each ancestor, not just the path down to `--cwd`. A
  policy path (`--grant-read`/`--grant-write`) inherits like the leaf because it means its
  whole subtree; its ancestors get **no grant at all**, because Windows bypasses traverse
  checking by default, so a known full path opens without listing rights on the way down
  — confirmed by hand (see Verification below), not assumed. If a connector ever needs
  more, that is a deliberate, recorded widening, not a default.

  **The leaf and every explicit policy path are promises the policy made to the child —
  they fail closed.** A path that cannot be granted there (ACL write fails — including on
  a filesystem without ACL support, such as FAT32/exFAT or some network shares, or a
  plain access-denied) aborts the spawn with exit `66`. The helper never falls back to
  spawning unconfined: a policy path the child cannot read is a failure to enforce the
  policy, not a warning.

  **An ancestor grant is not a promise to anything — it only helps Bun's own upward
  `package.json`/`bunfig.toml` enumeration list each level, so it is best-effort.** On the
  first ancestor `grant_path` cannot modify, the helper logs why on stderr and **stops
  climbing** rather than aborting the spawn or trying every remaining level — higher
  ancestors are strictly less likely to be modifiable than the one that just failed. This
  matters concretely: on a default, non-elevated Windows install, `C:\Users` itself denies
  `WRITE_DAC` to a standard user token even for that same user's own subtree beneath it
  (confirmed on this machine — `icacls C:\Users` shows only `SYSTEM`/`Administrators` with
  Full, `BUILTIN\Users` with `(RX)` only, while `icacls C:\Users\<user>` shows that same
  user with Full). Before this behavior existed, a `--cwd` nested under the user's real
  profile (`%TEMP%`, `%LOCALAPPDATA%`, `%APPDATA%`, the user's home directory, …) made
  the *helper* abort with exit `66` the moment the walk reached `C:\Users`. With the
  best-effort walk, the helper no longer aborts there — but the underlying obstacle is
  still real: Bun's own upward enumeration hits the same ungranted `C:\Users` and fails
  from *inside the child* instead, with `error: An internal error occurred
  (CouldntReadCurrentDirectory)` (confirmed by a real spawn attempt with `--cwd` under
  `%TEMP%`; propagated as the child's own exit code, not one of this helper's `65`–`68`).
  So a `--cwd` nested under the real user profile still does not work end to end — the
  failure just moved from a clean helper-side exit `66` to a Bun-side runtime error. A
  `--cwd` outside that tree — under a directory the current user owns outright (verified
  here with a working directory under a git-cloned repo root) — hits neither problem, and
  spawns succeed cleanly. Choosing where a connector's working directory lives is outside
  this helper's scope (see Task 5's `win32.ts`); this note exists so that scope does not
  rediscover this the hard way.

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
