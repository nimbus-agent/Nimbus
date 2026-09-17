# Windows sandbox ACE leak + tool-run follow-ups — plan

Spec: `docs/superpowers/specs/2026-09-17-windows-sandbox-ace-leak-design.md`. Planning artifact,
stripped before the PR. TDD throughout: failing test first, watch it fail for the right reason.

**Global constraints.** No `any`. Paths via `path.join`. `windowsHide: true` on every Windows child
(`audit:windows-console`). Sandboxed tests never run beside a background preflight (profile
collisions, `hr=0x800703fa`). The helper builds with `/W4 /WX`.

## Task 1 — helper modes (`sandbox-helper-win32/main.c`, `README.md`)

- `--revoke-grants --profile <name> [--path <p>]...`: refuse outside `nimbus-` (64); SID via
  `DeriveAppContainerSidFromAppContainerName`; per path `GetNamedSecurityInfoW` →
  `SetEntriesInAclW(REVOKE_ACCESS)` → `SetNamedSecurityInfoW`. `ERROR_FILE_NOT_FOUND` /
  `ERROR_PATH_NOT_FOUND` on read = success. Any other failure: name it on stderr, continue, exit 1.
- `--sweep-orphaned-aces <path>...`: per path walk explicit `ACCESS_ALLOWED_ACE_TYPE` ACEs; orphan iff
  SID authority is 15 with first sub-authority 2, AND `RegOpenKeyExW(MAPPINGS_KEY\<sid string>)`
  fails with `ERROR_FILE_NOT_FOUND`, AND `LookupAccountSidW` fails with `ERROR_NONE_MAPPED`.
  Collect unique orphan SIDs, remove each via one `SetEntriesInAclW` with N `REVOKE_ACCESS`
  entries, print `removed <n> <path>`. Missing path = `removed 0`.
- Build clean; verify by hand against a temp dir (grant → revoke returns count; orphan → sweep).
- README: both modes in "Modes", exit codes, the "why in the gateway" note.

## Task 2 — argv builders (`platform/sandbox/win32-argv.ts`)

`buildRevokeGrantsArgv(policy, { cwd })` → `["--revoke-grants", "--profile", <p>, "--path", cwd,
...read, ...write]` (each prefixed `--path`, de-duplicated, order-preserving);
`buildSweepArgv(paths)` → `["--sweep-orphaned-aces", ...paths]`. Unit tests, all platforms.

## Task 3 — release on exit (`sandbox-runner.ts`, `win32.ts`)

- `SandboxSpawnOptions.releaseGrantsOnExit?: boolean` with a docstring stating the shared-SID hazard.
- `win32.ts`: export `releaseGrantsFor(run, helper, policy, cwd)` — runs revoke then
  `--delete-profile`, swallows every error, resolves `void`. Runner `spawn` attaches
  `child.once("exit", () => void releaseGrantsFor(...))` only when the option is true, using the
  SAME canonicalised cwd/policy it spawned with.
- Unit tests for `releaseGrantsFor` with an injected `run` (argv order, revoke before delete,
  a throwing revoke still attempts delete, never rejects).

## Task 4 — callers (`exec/exec-run.ts`, `computer-use/cu-lanes/terminal.ts`)

Pass `releaseGrantsOnExit: true`. Assert via the existing fake-runner tests that the spawn options
carry it. Grep that no other `runner.spawn(` caller passes it.

## Task 5 — boot sweep (`platform/sandbox/win32-reap.ts`)

After `reapWith`, run `buildSweepArgv(resolveRuntimeById("bun").requiredReadPaths())` through the
helper; log `removed` lines at info when non-zero; a failure logs warn and is non-fatal; runs even
when the live-set computation threw (it deletes no profile). Injectable seam for tests.

## Task 6 — Windows integration (`test/integration/platform/sandbox/win32-ace-release.test.ts`)

Same readiness guard as `exec-sandbox.test.ts` (CI fails if the helper is missing). (a) record the
runtime bin dir's explicit ACE count, run `runExecution` 3 times, poll (≤ 20 s) until the count is
back; (b) manufacture an orphan on a temp dir (helper spawn, then `--delete-profile`), keep a live
profile's ACE on the same dir, run the sweep, assert orphan gone and live kept, then clean the live
profile. Count ACEs with `icacls`-free PowerShell `Get-Acl`, or via a tiny helper-free reader.

## Task 7 — follow-ups

1. `toolgen-invoke-gate.ts`: dep `confinementUnavailable: (toolId) => string | null`; checked after
   input validation, before `serialise`; non-null → `refuse(ERR_TOOLGEN_CONFINEMENT_FAILED, reason)`.
   `assemble.ts` binds it to `sandboxRunner.canConfine(policyFromManifest(buildGeneratedManifest(
   toolId, { runtimeReadPaths })))`. Tests: refused + one audit row + spawn never called.
2. `help.test.ts`: derive `sub` literals from `tool.ts`'s `ParsedToolArgs` source; each must appear
   in `tool.ts` `USAGE` and in `nimbus help`'s output. Fix `help.ts` (missing `credential set`).
3. `renderToolInvokeOutcome`: human mode writes `(<n> ms)` to STDERR for `executed` and `failed`
   when `durationMs` is present; stdout stays the bare result; `--json` unchanged.

## Task 8 — docs + gates

Helper README; `docs/sandbox.md` (Windows ACE lifecycle + residuals); `docs/cli-reference.md`
(duration note); `docs/CHANGELOG.md` entry. `bun run preflight` (not concurrently with sandboxed
tests). Strip `docs/superpowers/**` before the PR.
