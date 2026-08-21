# Review response — Windows sandbox leg + the sandbox policy shape

Responding to [`2026-08-21-windows-sandbox-and-policy-design-review.md`](./2026-08-21-windows-sandbox-and-policy-design-review.md).

**Disposition: 4 accepted, 1 accepted-in-part with the other part pushed back
on. One finding of my own surfaced while verifying #1, and is the largest item
here.**

Everything below was checked against the tree at `5ce7505b` before being
accepted or refused.

---

## Q1 — Stable ID strategy for one-shot executions · **ACCEPTED**

Correct, and it lands on machinery that already exists.
`platform/sandbox/orphan-reap.ts` deletes AppContainer profiles whose
`nimbus-ext-<id>` name has no live extension — so any one-shot naming scheme
must either fit that prefix or extend the reaper. That is now a stated
constraint.

**One thing the review did not name, and it matters.** The suggested remedy —
"a single static profile name … or a fixed pool" — is not a free win. All
one-shot executions sharing one profile means they share one SID, so a path
ACL'd for one run is reachable by any concurrent run. That is a real loss of
isolation *between executions*, and a fixed pool bounds it rather than removing
it. The genuine trade is registry/ACL hygiene against cross-execution
isolation, and it deserves to be decided in the open rather than settled by
picking the tidier-looking option.

Spec now records the trade-off and defers the choice to the execution piece —
the surface that owns it — under two binding constraints: the reaper must
recognise whatever scheme is chosen, and the resulting cross-execution
isolation property must be written down in `docs/sandbox.md` rather than
inferred from the naming.

## Q2 — Non-NTFS filesystems · **ACCEPTED**

Correct. AppContainer filesystem isolation is NTFS ACLs and nothing else, so on
FAT32/exFAT or a share with different semantics the ACE cannot be applied and
the child is silently unable to read a path the policy grants.

Answer: **fail closed**, with a distinguishable exit code so the runner reports
the cause rather than surfacing a generic spawn failure. A silent inability to
read a granted path is the worst of the three options — it looks like a broken
connector, not a sandbox constraint.

Narrowing worth recording: the sandbox cwd lives under the config directory and
is not at risk. What is at risk is connector `permissions.filesystem.read`,
which includes the filesystem connector's `[filesystem.roots]` — a user can
point those at a removable exFAT drive. So this is reachable in normal use, not
a corner case.

## Q3 — Helper privileges and elevation · **ACCEPTED** (as a recorded property)

The answer is the one implied by the question, and it is worth stating because
it is a *difference* from Linux rather than a detail: the helper runs entirely
in user space. `CreateAppContainerProfile` is a per-user API and ACL edits
inside the user's own profile are ordinary user operations, so — unlike the
Linux helper with its `cap_net_admin+ep` `setcap` postinst — **the Windows leg
adds no install-time privilege step at all.**

A consequence the spec now notes: `--check-caps` is a borrowed name here. It
probes that profile creation *works*; it does not probe that a capability is
*held*. The Windows 11 / Server 2025 group-policy confirmation the review asks
for goes in the spike, where a restriction would surface as a `--check-caps`
failure with a reason instead of a mystery spawn error.

## S1 — Job Objects · **ACCEPTED for lifetime, DEFERRED for limits**

Two distinct things bundled in one suggestion, and they have different fates.

**`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is accepted into this piece.** It is the
Windows analogue of the `--die-with-parent` that `buildBwrapArgv` already
passes on Linux, and the design had no equivalent — a crashed gateway would
have left sandboxed children running. That is a gap in the *connector* path
today, so it belongs here rather than with the execution work.

**Wall-clock enforcement stays deferred**, per the stated non-goal:
`limits.wallClockMs` ships declared-and-unenforced in this piece. But the
review's point improves it — the mechanism is now named rather than left open,
so the execution piece adds a limit to a Job Object that already exists instead
of introducing one.

It also caught a real error in §4. I had described the fallback as "restricted
token plus a Job Object for limits", which framed the Job Object as belonging
to the alternative. It does not — it is assigned either way, and the fallback
swaps only the isolation mechanism. Corrected.

## S2 — Env-var rename blast radius · **ACCEPTED in-repo, PUSHED BACK on satellites**

**The satellite half is not a risk, and it is structural rather than
incidental.** `sandbox-wrapper.ts:44` strips both `NIMBUS_SANDBOX_MANIFEST_JSON`
and `NIMBUS_SANDBOX_CWD` out of the child environment before spawning, so a
connector process never observes either variable — there is nothing for
`packages/mcp-connectors/*` or the SDK to depend on. The VS Code extension, web
clipper and admin console reach the gateway over IPC/HTTP and never spawn a
connector, so they cannot see it either. The variable is an internal contract
between two invocations of one binary, by construction.

**The in-repo half is accepted, and is bigger than my acceptance criterion
implied.** I had written "no remaining references to the old name", which reads
as a source-only sweep. It is ~15 test call sites plus two documentation
surfaces: `docs/SECURITY-INVARIANTS.md` in three places — including the `D10`
wiring-table row — and `.claude/commands/nimbus-security-invariants.md` in two.
Under the triple rule those move in the same commit as the code. Criterion
rewritten to name them.

---

## Finding not in the review — the Windows sandbox is documented as a mitigation that does not run

Surfaced while verifying Q1, and it is the largest item on this page.

`reapOrphanedAppContainers` has **zero production callers** — only its own
test. Two documents state otherwise:

- `.claude/commands/nimbus-file-map.md` — "Windows AppContainer orphan-reap **at
  Gateway startup**".
- `docs/architecture.md` threat table — answers *Extension sandbox escape* with
  "bwrap + seccomp + per-host iptables on Linux, sandbox-exec SBPL on macOS,
  **AppContainer + orphan-reap on Windows**".

Neither half of the Windows answer executes: `spawn()` throws and the reaper is
never called. So the threat table currently credits a defense that is inert on
one of three supported platforms — the same orphan-defined-defense shape the
`nimbus-security-invariants` skill exists to catch.

Two consequences, both now in the spec. Wiring the reaper is pulled **into**
this piece — shipping real profile creation without it manufactures exactly the
registry leak Q1 is about. And both documents get corrected in the same commit
that makes them true, or corrected to whatever shipped if the Section 4
fallback is taken instead.
