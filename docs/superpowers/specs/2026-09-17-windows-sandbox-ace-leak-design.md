# Windows sandbox ACE leak — design

Planning artifact. Stripped before the PR; durable content moves to the helper `README.md`,
`docs/sandbox.md` and `docs/CHANGELOG.md`.

## 1. Problem

`sandbox-helper-win32/main.c` `grant_path` adds an `ACCESS_ALLOWED` ACE for the AppContainer SID on
`--cwd` and every `--grant-read`/`--grant-write` path, and nothing removes it. Deleting the profile
(`--delete-profile`, the boot reaper) leaves the ACE as an unresolvable `S-1-15-2-*` entry.

Measured 2026-09-17 on a temp dir:

| step | ACEs on a granted dir |
| --- | --- |
| start | 5 |
| spawn, profile `aclspike-same` | 7 |
| spawn again, SAME profile | 7 — `SetEntriesInAclW(GRANT_ACCESS)` merges into the existing ACE |
| spawn, DIFFERENT profile | 9 |
| delete both profiles | 9 — the ACEs survive |

So growth comes only from **distinct SIDs**, landing on paths that **outlive the run**:

| caller | policy id | persistent paths granted |
| --- | --- | --- |
| I33 `nimbus exec` | `exec-<executionId>` — new per run | the runtime bin dir (`dirname(process.execPath)`), owner `fsRead`/`fsWrite` dirs |
| I35 terminal lane | `cu-terminal-<sessionId>` — new per session | the owner's cwd |
| I39/I40 toolgen | `toolgen.<toolId>` — one per tool | the runtime bin dir |
| extensions (I15) | `<extension id>` — stable | — does not grow |

The dev machine reached 1366 ACEs on `~/.bun/bin` (140,830-byte SDDL); `SetEntriesInAclW` then
returns 87 and every confined spawn fails closed with `ERR_*_CONFINEMENT_FAILED`.

## 2. Design

### 2.1 Helper: two new modes

- `--revoke-grants --profile <name> [--path <p>]...` — derive the SID with
  `DeriveAppContainerSidFromAppContainerName` (works whether or not the profile still exists, since
  the SID is a hash of the name), then for each path remove every EXPLICIT ACE for that SID via
  `SetEntriesInAclW(REVOKE_ACCESS)`. A path that no longer exists is success (the caller may have
  removed a temp cwd already). Exit `0` when every path succeeded, `1` if any failed (each failure
  named on stderr), `64` usage. Refuses a profile outside `nimbus-` (exit 64), like
  `--delete-profile`.
- `--sweep-orphaned-aces <path>...` — for each path, remove every explicit `ACCESS_ALLOWED` ACE
  whose SID is under `S-1-15-2` AND has no subkey under the per-user `MAPPINGS_KEY` AND does not
  resolve via `LookupAccountSidW`. Prints `removed <n> <path>` per path. Exit `0`/`1`/`64` as above.

  The Mappings key lists installed packages too (verified: `microsoft.windowsnotepad_*`,
  `microsoft.vclibs.*`), so a Store app's ACE is not an orphan; the lookup check is a second
  independent guard.

### 2.2 Gateway: release per-run grants when the child exits

- `SandboxSpawnOptions.releaseGrantsOnExit?: boolean`. Linux/macOS ignore it (bwrap/SBPL leave no
  host state).
- The win32 runner, when set, attaches an `exit` listener to the helper process and runs
  `--revoke-grants --profile <p> --path <cwd> --path <read...> --path <write...>` then
  `--delete-profile <p>`, asynchronously (`execFile`, `windowsHide`), best-effort, never throwing
  into the caller.
- **In the gateway, not the helper**: terminal close and exec timeouts `child.kill()` the helper,
  which on Windows is `TerminateProcess` — code after `WaitForSingleObject` never runs on those
  paths. The `exit` event fires for all of them.
- Set by exactly two callers, whose ids are unique per run so no concurrent spawn shares the SID:
  `exec/exec-run.ts` and the terminal lane's `spawnShell` in `computer-use/cu-lanes/terminal.ts`.
  Never for extensions or toolgen (shared SIDs — revoking would strip a concurrent run's access).

### 2.3 Boot: sweep what already leaked

`reapAppContainersAtBoot` runs the sweep AFTER the existing profile reap (so a reaped toolgen/exec
profile's ACE is orphaned by the time the sweep looks), over the Bun runtime's required read paths
(`exec-runtimes.ts` `requiredReadPaths()` — `[binDir]` on Windows). Best-effort, logged, non-fatal,
independent of the DB live-set (it deletes no profile, and only touches ACEs of SIDs with no
registration at all).

Toolgen needs nothing more: the reaper deletes `nimbus-ext-toolgen.*` profiles at boot and the
sweep then clears their runtime-dir ACEs, so between boots the count is bounded by distinct tools
spawned.

### 2.4 Residuals (stated, not fixed)

- A gateway crash mid-run leaves that run's ACEs on OWNER dirs (exec grants, terminal cwd): the boot
  sweep covers only the runtime dir, since the gateway does not record which owner dirs past runs
  were granted.
- Two gateways for one user racing: the pre-existing boot reaper can delete another live gateway's
  per-run profile (observed as `hr=0x800703fa`), after which the sweep may remove that run's ACE.
  Single-gateway is the supported shape; not widened here.
- A per-user install is assumed. On a shared install dir, another Windows user's live SID is not in
  THIS user's Mappings key and would be swept.

## 3. Follow-ups bundled in the same PR

1. **Sandbox-unavailable is `refused`, not `failed`** (`toolgen-invoke-gate.ts`): before `spawn`,
   ask the runner `canConfine` for the tool's policy; non-null → `refused` with the existing
   `ERR_TOOLGEN_CONFINEMENT_FAILED`, one audit row, no spawn.
2. **`help.test.ts`** asserts every `ParsedToolArgs` `sub` appears in both `tool.ts`'s usage and the
   `help.ts` tool block, derived from the source rather than a hand-written list.
3. **`nimbus tool run`** human output prints `durationMs`; `--json` unchanged.

## 4. Testing

- Unit: `buildRevokeArgv`/`buildSweepArgv` are pure and cross-platform; the win32 runner attaches
  the release only when the option is set (injected spawn/execFile); exec and terminal pass it;
  `reapAppContainersAtBoot` sweeps after reaping and survives a sweep failure.
- Integration (Windows, real helper, CI-fail-if-missing like `exec-sandbox.test.ts`): N `runExecution`
  calls leave the runtime bin dir's ACE count where it started (polled with a bounded wait, since the
  release is asynchronous); a manufactured orphan (spawn, delete profile, ACE remains) is removed by
  `--sweep-orphaned-aces` while a live profile's ACE on the same dir survives.
- Follow-ups: unit tests in `toolgen-invoke-gate.test.ts`, `help.test.ts`, `tool.test.ts`.
