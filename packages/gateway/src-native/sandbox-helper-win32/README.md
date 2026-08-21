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

  ### ACL grants — leaf and explicit policy paths only, nothing else

  The helper grants exactly two kinds of path, both fail-closed, and **nothing above
  them**:

  | What | Rights | Inheritance | On grant failure |
  |---|---|---|---|
  | `--cwd` (the leaf) | Read + Execute + Write | `SUB_CONTAINERS_AND_OBJECTS_INHERIT` | **fail closed** — aborts the spawn with exit `66` |
  | `--grant-read` / `--grant-write` paths | Read+Execute, or Read+Execute+Write | `SUB_CONTAINERS_AND_OBJECTS_INHERIT` | **fail closed** — aborts the spawn with exit `66` |
  | anything else (`--cwd`'s ancestors, policy paths' ancestors) | — (no grant, ever) | n/a | n/a |

  The leaf and a policy path both inherit because each one's whole subtree is what it
  promises — the leaf is the working directory, a policy path means its subtree. Both are
  promises the policy made to the child, so a grant failure there (ACL write fails —
  including on a filesystem without ACL support such as FAT32/exFAT or a network share,
  or a plain access-denied) aborts the spawn with exit `66`. The helper never falls back
  to spawning unconfined: a policy path the child cannot read is a failure to enforce the
  policy, not a warning. A policy path's own ancestors get no grant either, because
  Windows bypasses traverse checking by default, so a known full path opens without
  listing rights on the way down — confirmed by hand against a real AppContainer
  spawn, not assumed.

  **There used to be a third category — granting each ancestor of `--cwd` read/list
  rights, so Bun's upward `package.json`/`bunfig.toml` search could enumerate each level —
  and it has been removed entirely, not merely made best-effort.** Two independent
  problems, not one: modifying the DACL of directories the helper does not own (a
  connector's `%LOCALAPPDATA%`, `AppData`, or the user's home directory) is itself a
  persistent, user-visible side effect on paths outside Nimbus's control, wrong on its own
  terms regardless of speed; separately, on at least one production-shaped tree that walk
  was measured to hang indefinitely (`icacls.exe` reproduced the same hang independently
  of this helper's code — root cause unconfirmed, not chased, since the removal makes it
  moot). The grant policy is now exactly the leaf plus explicit `--grant-read`/
  `--grant-write` paths; ancestors of `--cwd` are never touched.

  **Consequence, measured rather than assumed: Bun cannot currently run as a sandboxed
  child through this helper at all**, independent of where `--cwd` lives or whether a
  `package.json` sits in the leaf. A `--cwd` nested under `%LOCALAPPDATA%`
  (`...\Nimbus\extensions\<ext>\workdir`, the production shape — not a shallow path, which
  hid this from an earlier design spike), with a minimal `package.json` placed directly in
  that leaf and zero ancestor grants, produced this from a real spawn:
  ```
  error loading current directory
  error: An internal error occurred (CouldntReadCurrentDirectory)
  ```
  exit `1` — Bun's own exit code, not one of this helper's `65`–`68`, so the helper itself
  spawned the child successfully; Bun's own startup is what fails. A `package.json` at the
  leaf does not let Bun's search stop there — whatever Bun does at startup needs more than
  the leaf regardless. A plain Win32 console app with no such upward-search behavior (e.g.
  `powershell.exe`) spawns and runs fine through the identical helper invocation at the
  identical `%LOCALAPPDATA%` path with the identical zero ancestor grants, which isolates
  this to Bun's own startup requirement, not a generic AppContainer or Windows limitation.
  Relocating `--cwd` to work around this is out of this helper's scope (it belongs with
  whatever chooses the working directory — `assemble.ts`, the installer, or Task 5's
  `win32.ts`) and is deliberately not attempted here.

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
| 65 | AppContainer profile create/derive failed, or the `internetClient` capability SID could not be allocated (`AllocateAndInitializeSid`) |
| 66 | ACL grant failed — path is on a filesystem without ACL support, or access denied |
| 67 | Job Object creation or assignment failed |
| 68 | process-thread attribute list setup failed, or `CreateProcessW` itself failed |
| other | the child's own exit code |

## Build

```powershell
bun run build:sandbox-helper:win32
```

Compiles with MSVC (`cl.exe`) via `scripts/build-sandbox-helper-win32.ps1`, which
locates the toolchain through `vswhere.exe` — no Developer Command Prompt
required. `/W4 /WX` mirrors the Linux helper's `-Wall -Wextra -Werror`.

The build above writes `nimbus-sandbox-helper.exe` into this directory
(`src-native/sandbox-helper-win32/`), **not** beside `process.execPath` — that is where
`win32.ts`'s `helperPath()` resolves it by default in a packaged install
(`join(dirname(process.execPath), "nimbus-sandbox-helper.exe")`), which for a
contributor running `bun run` from source is nowhere near this directory. Set
`NIMBUS_SANDBOX_HELPER_PATH` to the built binary's path (`helperPath()` checks it first,
before the default) to point a locally-run Gateway at a helper you just built without
installing anything — e.g.
`$env:NIMBUS_SANDBOX_HELPER_PATH = (Resolve-Path .\nimbus-sandbox-helper.exe)`. CI uses
the same override (`sandbox-wrapper-spawn.test.ts`'s `WIN_HELPER`); the Linux helper
honors the analogous env var the same way (`linux.ts`'s `HELPER_PATH`).

## Design

See `docs/sandbox.md` and the PR 1 design spec §4 Windows.
