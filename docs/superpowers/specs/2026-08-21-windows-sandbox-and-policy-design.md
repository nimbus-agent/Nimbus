# Windows sandbox leg + the sandbox policy shape

> Goal: make the platform sandbox real on all three platforms, and change its
> input from "an extension manifest" to "a capability policy" so a one-shot
> execution can use it.
>
> This is the entry point to **Spine S2 (Local Compute Fleet)**. It is not an S2
> feature. It is the repair and the widening that every S2 feature stands on.
>
> Status: designed 2026-08-21. Not yet planned, not yet built.

## Context — the sandbox is two thirds implemented, and the missing third throws

`packages/gateway/src/platform/sandbox/` dispatches by platform to three
runners behind one `SandboxRunner` interface:

| Platform | Implementation | State |
|---|---|---|
| Linux | `bwrap` + a compiled seccomp BPF filter + an optional `CAP_NET_ADMIN` helper for per-host network gating | Real |
| macOS | Generated SBPL profile → `/usr/bin/sandbox-exec` | Real |
| Windows | AppContainer profile-name + capability derivation only | **`spawn()` throws unconditionally** |

`win32.ts`'s `spawn()` raises *"Windows sandbox spawn FFI is a work-in-progress
in PR 1 — the AppContainer profile + capability surface is locked but the
`CreateProcessAsUserW` FFI binding lands in the tracked follow-up."*
`win32.test.ts` asserts that throw, under the name
`"fails closed: spawn throws instead of running the extension unsandboxed"`.

The fail-closed posture is correct. The consequence is not contained to
extensions, because **every** connector `ServerSpec` is rewritten by
`wrapServerSpec()` (invariant `I15` / static `D10`) into a self-spawn of the
`__nimbus-sandbox` role of the same executable, which calls
`createSandboxRunner()`. On Windows that path terminates in the throw.

Verified by execution on 2026-08-21, Windows 11 / Bun 1.3.14, on `main` at
`5ce7505b`:

```console
$ NIMBUS_SANDBOX_MANIFEST_JSON='{...}' NIMBUS_SANDBOX_CWD="$PWD" \
    bun packages/gateway/src/index.ts __nimbus-sandbox cmd /c echo hello
error: Windows sandbox spawn FFI is a work-in-progress in PR 1 — ...
      at spawn (packages/gateway/src/platform/sandbox/win32.ts:21:17)
      at runSandboxWrapper (packages/gateway/src/platform/sandbox/sandbox-wrapper.ts:49:24)
EXIT=1
```

So on Windows, **no MCP connector process can start**. Connector *sync* is
unaffected — the `*-sync.ts` modules fetch in-process and never spawn — so
indexing works and the mesh tool path does not. That asymmetry is why this
went unnoticed.

There is no open issue tracking it, notwithstanding the code comment's
"the tracked follow-up".

### Why CI never caught it

The push matrix runs `windows-2025` and is green. Nothing on it spawns
through `__nimbus-sandbox` for real. The only real-spawn test anywhere is
`packages/gateway/test/integration/platform/sandbox/sandbox-helper-strace.test.ts`,
gated twice:
`skipIf(process.platform !== "linux")` and `skipIf(!existsSync(helperPath))`.
Windows and macOS have no equivalent at all.

This is the failure mode recorded as *"fakes can't catch a contract
mismatch"*: both ends of the seam are tested and the wire between them is not.

## Non-goals

Named explicitly, because each is a plausible thing to fold in and none of it
belongs here:

- **`nimbus exec` itself** — the CLI surface, a `code.execute` entry in the `I2`
  frozen set, and the `I29` question of whether a sandboxed process that reaches
  the network needs its own egress coverage class. This spec delivers the
  substrate and a policy shape that accepts a per-execution capability set. The
  execution surface is the next piece, on top of it.
- **Closing the Windows per-host network asymmetry.** `docs/sandbox.md` already
  documents and accepts it: Windows gets all-or-nothing `internetClient` because
  true per-host filtering needs a Windows Filtering Platform callout driver with
  kernel-mode signing. This work does not close that gap and must not claim to.
- **Computer use, multimodal I/O, sub-agent fleets, model routing** — the rest
  of S2.
- **Advancing the documented build slot from S1 to S2.** That is a separate
  decision with its own docs change across `CLAUDE.md`, `GEMINI.md` and the
  roadmap spine table. This work stands on its own as a platform-equality
  repair whether or not the slot moves.

## Section 1 — The Windows helper binary

Mirror the Linux design rather than the one the stub's error message assumes.
Linux does not call `bwrap` through FFI; it spawns an external binary, and a
607-line C helper (`packages/gateway/src-native/sandbox-helper/main.c`, built
by a Makefile, packaged into the `.deb`/`.rpm` with a `setcap` postinst) does
the privileged part. The Windows leg gets a sibling.

**Why a helper and not `bun:ffi`.** The helper is spawned by Node with pipes,
so the AppContainer child inherits those handles directly and MCP JSON-RPC over
stdio keeps working with no extra plumbing. `ChildProcess` semantics — which
the entire mesh depends on — survive untouched. The FFI route would have to
build the pipes by hand and adopt raw HANDLEs as Node streams, and synchronous
`bun:ffi` calls block the event loop and cannot be bounded by `Promise.race`.

### Surface

`packages/gateway/src-native/sandbox-helper-win32/` → `nimbus-sandbox-helper.exe`,
with the same two-mode shape as the Linux helper:

- `--check-caps` — print `OK` and exit 0 iff the helper can create/derive an
  AppContainer profile; otherwise print the reason and exit 1. This is what
  makes `isFullyActive()` and `degradedReason()` report measured state instead
  of returning constants.
- `--profile <name> [--capability internetClient] [--grant-read <path>]…
  [--grant-write <path>]… -- <argv…>` — create-or-derive the AppContainer
  profile SID, add the container-SID ACEs the child needs, `CreateProcessW`
  inside the container with `EXTENDED_STARTUPINFO_PRESENT` +
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, wait, exit with the child's
  code.

Language — Rust with the `windows` crate, or C with MSVC — is deliberately left
to the plan. Rust marshals `PROC_THREAD_ATTRIBUTE_LIST` and
`SECURITY_CAPABILITIES` far more safely and cargo is already in the repo and CI
for Tauri; C mirrors `main.c` exactly and adds no new toolchain to the release
path. Decide it against the ACL spike's findings (Section 4), not in advance.

### The runner

`platform/sandbox/win32.ts` stops throwing. It resolves the helper (reusing the
existing `NIMBUS_SANDBOX_HELPER_PATH` override; default beside the executable),
probes it once at construction exactly as `probeHelper()` does on Linux, and
spawns through it. `profileNameFor()` and `capabilitiesForManifest()` —
currently the only real code in the file — are finally consumed rather than
only tested.

`degradedReason()` keeps explaining the per-host network gap, because that gap
is still there.

### Profile lifecycle, process lifetime, and privilege

**The helper is unprivileged.** Unlike the Linux helper — which carries
`cap_net_admin+ep` granted by a `setcap` postinst — nothing on this leg needs
elevation. `CreateAppContainerProfile` is a per-user API, and adding ACEs to
paths inside the user's own profile is an ordinary user operation. So the
Windows leg adds **no install-time privilege step**, and `--check-caps` is a
borrowed name rather than an accurate one here: it probes that profile creation
*works*, not that a capability is *held*. Confirm against Windows 11 and Server
2025 during the spike — a local group policy could in principle restrict
profile creation, and that would show up as a `--check-caps` failure with a
useful reason rather than a mystery spawn error.

**Profiles are registry state, so they must be reaped — and the reaper already
exists and is inert.** `platform/sandbox/orphan-reap.ts` deletes AppContainer
profiles whose `nimbus-ext-<id>` name has no live extension. It has **zero
production callers**: only its own test. Two documents already describe it as
running — `.claude/commands/nimbus-file-map.md` says "orphan-reap **at Gateway
startup**", and `docs/architecture.md`'s threat table lists "AppContainer +
orphan-reap on Windows" as the mitigation for *Extension sandbox escape*. Both
halves of that mitigation are currently inert. Wiring the reaper belongs in this
piece: shipping real profile creation without it manufactures exactly the
registry leak the naming question below is about.

**One-shot executions need a deliberate id scheme, and it is not free.** A
connector has a stable extension id, so its profile SID is stable and its ACEs
resolve. A one-shot execution has no such id. Minting a fresh profile per spawn
leaks a registry key per run and leaves orphaned SIDs on every path it touched
(the `S-1-15-…` / *Account Unknown* entries in Explorer). But the obvious
alternative — one static profile for all one-shot executions — means every
execution shares one SID, so a path ACL'd for one run is reachable by any
concurrent run. That is a real isolation downgrade between executions, not a
free win, and a fixed pool only bounds it rather than removing it.

This spec does not settle that choice, because the execution surface is a
non-goal. It sets two constraints the execution piece must satisfy:

1. Whatever scheme is chosen, `reapOrphanedAppContainers` must recognise it —
   today it matches on the `nimbus-ext-` prefix only.
2. The cross-execution isolation property of the chosen scheme must be stated
   in `docs/sandbox.md`, not left to be inferred from the naming.

**Process lifetime: a Job Object.** Linux gets `--die-with-parent` from bwrap;
Windows has no analogue in the current design, so a crashed gateway would leave
sandboxed children running. Assign the child to a Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the OS terminates it when the helper's
handle closes. This is lifetime hygiene needed by connectors today, not a
resource limit, and it is complementary to AppContainer rather than an
alternative to it.

**Non-NTFS paths fail closed.** AppContainer filesystem isolation is NTFS ACLs
and nothing else. On FAT32/exFAT, or a network share with different semantics,
the ACE cannot be applied and the child would silently be unable to read a path
the policy grants. The helper must fail with a distinguishable exit code so the
runner reports *why* rather than surfacing a generic spawn failure. This is not
hypothetical: connector `permissions.filesystem.read` paths include the
filesystem connector's `[filesystem.roots]`, which a user can point at a
removable exFAT drive. The sandbox cwd is under the config directory and is not
at risk.

### Build and ship

- A `build:sandbox-helper:win32` package script, beside the existing
  `build:sandbox-helper`.
- A `windows-2025` CI job that builds it and runs the language's equivalent of
  the Linux job's `cppcheck` gate.
- Two additions to the release path: the Windows zip, and the MSI job's
  `dist/msi-bin` copy list (which already hand-copies `nimbus-gateway.exe`,
  `nimbus.exe` and `vec0.dll`).

## Section 2 — From manifest to policy

`SandboxRunner.spawn` takes a whole `ExtensionManifest` and reads exactly two
things from it: `.permissions` and `.id`. `SandboxPermissions` is already an
exported standalone type in `extensions/permissions-validator.ts`. So the
widening is small and mechanical:

```ts
export interface SandboxPolicy {
  /** Profile / naming key. Derived from the extension id for a connector. */
  readonly id: string;
  readonly permissions: SandboxPermissions;
  /** One-shot executions only; a long-lived connector process sets nothing. */
  readonly limits?: { readonly wallClockMs?: number };
}
```

- `SandboxSpawnOptions.manifest` becomes `policy`.
- One derivation, `policyFromManifest()`, is the only place a manifest becomes a
  policy. `wrapServerSpec()` calls it; nothing else does.
- The wrapper's env contract renames `NIMBUS_SANDBOX_MANIFEST_JSON` →
  `NIMBUS_SANDBOX_POLICY_JSON`. This is safe to do outright with no
  compatibility shim: the wrapper **is** the same executable as its parent
  (`selfSpawn`), so there is no version skew to bridge.
- The Linux and macOS bodies change nothing but their parameter type.

`limits.wallClockMs` is declared here and enforced by the runners in the
execution piece. It exists in this spec so the shape is right, not so the
timeout ships — a declared-but-unenforced field must be documented as such and
must not be read as a guarantee by anything. The mechanism is named even though
the enforcement is deferred: on Windows it is the same Job Object that
Section 1 assigns for lifetime hygiene, so the execution piece adds a limit to
an object that already exists rather than introducing one.

**What this unlocks.** A one-shot execution builds a `SandboxPolicy` from
per-execution capability flags directly. Today the only way to reach the
sandbox is to fabricate an `ExtensionManifest` for something that is not an
extension.

## Section 3 — Testing

The hole in verification is the reason this defect survived, so the test plan
is the load-bearing part of this spec.

### The primary deliverable test

A **cross-platform wrapper integration test** that runs on all three OSes and
spawns a real process through the real `__nimbus-sandbox` role:

1. stdout round-trips through the pipes (this is the property MCP depends on),
2. the child's exit code propagates,
3. a filesystem path outside the policy is refused.

Assertion 3 is what makes it a sandbox test rather than a spawn test. Without
it the suite would pass against an unsandboxed spawn.

### Red-proving

Given how this failed, green is not evidence. Revert `win32.ts` to the throwing
stub and confirm the new test goes red on Windows. Confirm the revert applied
by reading the file — a revert that silently fails to apply also looks green.

### Unit level

`win32.test.ts` inverts. Its `"fails closed: spawn throws"` case currently
asserts the bug as intended behaviour; it becomes an argv-construction test
over the helper invocation, in the same shape as `buildBwrapArgv` and
`generateSbplProfile`. The file's existing top comment explains why it carries
no `skipIf(process.platform !== "win32")` — the derivation is pure, and gating
it made the file read 0% on the CI-Linux-authoritative coverage run. The new
tests preserve that property; only a case that genuinely calls into Windows
gets a skip.

### Manual acceptance

The exact command that failed in Context must print `hello` and exit 0 on a
Windows machine.

## Section 4 — Risks

### The AppContainer ACL surface — the one real unknown

A process inside an AppContainer can only open files whose ACL names its
package SID or `ALL_APPLICATION_PACKAGES`. `System32` qualifies. A compiled
Nimbus binary in a user-profile directory does not. So spawn must add
container-SID ACEs for the runtime binary and the working directory.

This is very likely why the FFI route stalled, and it is the first thing the
plan probes: create a profile, ACL a scratch directory to its SID, spawn a real
Bun process inside it with working stdio pipes. Probe before building, not
after.

**If it proves unworkable**, the fallback is a restricted token
(`CreateRestrictedToken`, dropping admin and deny-only SIDs), spawning normally.
The Job Object is not part of that trade — it is assigned either way, for
lifetime hygiene — so the fallback swaps only the isolation mechanism. That is a
genuine OS-enforced reduction with no ACL problem, but it has no network
capability model at all: `internetClient`
stops meaning anything and `capabilitiesForManifest()` becomes dead code. Taking
that fallback requires rewriting `docs/sandbox.md`'s Windows row **downward**,
not leaving it as-is. The guarantee documented must be the guarantee shipped.

### Second-order

- The helper ships unsigned inside a signed MSI.
- EDR and antivirus products are known to interfere with AppContainer spawns,
  so this can be environment-dependent in ways CI will not reveal. The
  `degradedReason()` path needs to say something useful when it happens.
- The all-or-nothing `internetClient` asymmetry remains open and documented.

### Two honesty items that are not code

The `win32.ts` comment calls the FFI binding "the tracked follow-up" and no such
issue exists. Whatever ships, either the issue gets opened or the comment gets
corrected. A claim like that should not outlive its referent.

The larger one: **the Windows sandbox is documented as a mitigation that does
not run.** `docs/architecture.md`'s threat table answers *Extension sandbox
escape* with "AppContainer + orphan-reap on Windows", and
`.claude/commands/nimbus-file-map.md` places orphan-reap "at Gateway startup".
Neither half executes — `spawn()` throws and `reapOrphanedAppContainers` has no
production caller. Both statements get corrected in the same commit that makes
them true, and if the fallback of Section 4 is taken instead, they get corrected
to whatever actually shipped.

## Acceptance criteria

- [ ] `bun packages/gateway/src/index.ts __nimbus-sandbox cmd /c echo hello`
      succeeds on Windows with the documented policy env var.
- [ ] `createWin32SandboxRunner().spawn()` no longer throws; `isFullyActive()`
      and `degradedReason()` report probed state rather than constants.
- [ ] A cross-platform wrapper integration test runs on Linux, macOS and
      Windows, asserting stdout round-trip, exit-code propagation, and refusal
      of an out-of-policy path — red-proven by reverting the win32 runner.
- [ ] `SandboxRunner.spawn` takes a `SandboxPolicy`; `policyFromManifest()` is
      the single manifest→policy derivation; `wrapServerSpec` is its only
      caller.
- [ ] `NIMBUS_SANDBOX_POLICY_JSON` replaces `NIMBUS_SANDBOX_MANIFEST_JSON`
      everywhere it is named — not only the ~15 test call sites, but
      `docs/SECURITY-INVARIANTS.md` (three places, including the `D10` wiring
      table row) and `.claude/commands/nimbus-security-invariants.md` (two),
      all in the same commit per the invariant triple rule.
- [ ] `reapOrphanedAppContainers` has a production caller, and recognises every
      profile-name scheme this leg can create.
- [ ] The sandboxed child is assigned to a Job Object with
      `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; killing the gateway leaves no
      surviving sandboxed process.
- [ ] A policy path on a non-ACL filesystem fails closed with a cause the
      runner can report, not a generic spawn error.
- [ ] `docs/architecture.md`'s threat-table row and
      `.claude/commands/nimbus-file-map.md`'s orphan-reap line describe what
      actually runs.
- [ ] The helper builds in CI on `windows-2025` and ships in both the Windows
      zip and the MSI.
- [ ] `docs/sandbox.md`'s Windows section describes what actually shipped —
      including a downgrade, if the fallback was taken.
- [ ] `limits.wallClockMs` is documented as declared-but-not-enforced.
- [ ] The "tracked follow-up" comment either has a tracking issue or is gone.
- [ ] `bun run preflight` green.

## Open questions for the plan

1. Rust + the `windows` crate, or C + MSVC? Decide from the ACL spike.
2. For connectors the profile is created once per extension id and derived
   thereafter — the stable id makes that straightforward, and the reaper
   collects it. The open half is one-shot executions, whose id scheme trades
   registry/ACL hygiene against cross-execution isolation; see Section 1. That
   choice belongs to the execution piece, under the two constraints stated
   there.
3. Should macOS get a real-spawn integration test in this piece, or does the
   cross-platform test cover it by construction? (It should be the latter, but
   confirm macOS actually exercises it in CI rather than skipping.)
