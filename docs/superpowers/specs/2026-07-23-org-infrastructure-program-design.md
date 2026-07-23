# Org delivery infrastructure — program design

> **Status:** design drafted 2026-07-23, pending approval. Scope is the
> `nimbus-agent` org's **delivery machinery** — CI, release automation, PR review,
> and cross-repo coordination — across all nine active repos.
>
> Roadmap: [`docs/roadmap.md`](../../roadmap.md) is authoritative for gateway
> capability. Ecosystem: [`docs/ecosystem-roadmap.md`](../../ecosystem-roadmap.md)
> is authoritative for when capability becomes reachable. **This program owns
> neither** — it creates a third sibling document,
> `docs/infrastructure-roadmap.md`, and P1 delivers it.

---

## Contents

- [Goal](#goal)
- [The diagnosis](#the-diagnosis)
- [Correction 1 — CodeRabbit is not noisy, it is blind](#correction-1--coderabbit-is-not-noisy-it-is-blind)
- [Correction 2 — the merge queue is unjustified; main CI is the real defect](#correction-2--the-merge-queue-is-unjustified-main-ci-is-the-real-defect)
- [Correction 3 — App-as-credential already exists](#correction-3--app-as-credential-already-exists)
- [Operating principle](#operating-principle)
- [Document placement and precedence](#document-placement-and-precedence)
- [The sub-programs](#the-sub-programs)
- [Sequence](#sequence)
- [Design constraints](#design-constraints)
- [Explicit non-goals](#explicit-non-goals)
- [Open decisions](#open-decisions)
- [How to update this document](#how-to-update-this-document)

---

## Goal

Make the org's delivery machinery match the quality of the code it ships, and
make each improvement hold through a gate a machine can check.

Four outcomes, all in scope, none traded against the others:

1. **Cut manual toil** — the per-release manual tag push, the hand-opened
   downstream consumption PRs, the five hand-synced `ci.yml` files.
2. **Catch problems earlier** — invariants enforced in CI rather than only in
   local `preflight`.
3. **Reduce latency** — but only against measurement, never against a hunch.
4. **Make the org legible** — one place showing release state, downstream
   staleness, and secret expiry.

---

## The diagnosis

One fact explains all five sub-programs.

> **The org has good delivery engineering. It exists in exactly one repo.**

`Nimbus` has path-filtered change detection (the `filter` job), two local
reusable workflows (`_test-suite.yml`, `_structure.yml`), two composite actions
(`setup-nimbus-ci`, `setup-rust-tauri`), Actions caching, an 18-gate preflight
manifest in `scripts/lib/preflight-gates.ts` with a drift test that fails when a
CI gate goes missing, and a GitHub App (`nimbus-release-bot`) minting 1-hour
installation tokens across five workflows.

The other eight repos have a hand-copied `ci.yml`.

**The drift is already measurable, not hypothetical:**

| Action | `nimbus-client` / `nimbus-sdk` | `nimbus-web-clipper` |
| --- | --- | --- |
| `step-security/harden-runner` | `v2.20.0` | `v2.19.4` |
| `actions/checkout` | `v7.0.1` | `v7.0.0` |

And the sharpest evidence of the pattern: **Nimbus's own preflight runs
`audit:action-sha-pins`** — a gate built precisely to catch stale action pins —
scoped to one repo, while the drift it exists to catch happens one repo over,
unwatched. `audit:consumed-by` has the same shape and the same blind spot.

The org `.github` repo already hosts cross-repo composite actions
(`verify-npm-provenance`, `probe-publish-token`), so the promotion path exists
and was simply never extended to workflows.

**A second structural fact shapes P3.** There are no human reviewers. Of the last
80 merged PRs org-wide: 61 by `asafgolombek`, 18 by `nimbus-release-bot[bot]`,
1 by `dependabot[bot]`. "Improve PR review" therefore means improving *automated*
review of AI-assisted PRs — not routing work to teammates. `CODEOWNERS` routing,
review SLAs and reviewer round-robin are all out of scope by construction.

---

## Correction 1 — CodeRabbit is not noisy, it is blind

The initial framing was "CodeRabbit is non-required and noisy; demote or tune."
That was wrong, and the evidence points the other way.

**All four satellite repos carry a tuned `.coderabbit.yaml`. The `Nimbus`
monorepo does not.** The satellite configs are good — `nimbus-client`'s sets
`profile: chill`, disables `request_changes_workflow`, and carries real
`path_instructions` telling the bot to flag any `any`, any `console.*` in
published src, any new runtime dependency beyond `@nimbus-dev/sdk`, and any
exported-type change without a semver-relevant Conventional Commit.

So the bot is tuned in the four small repos and runs stock in the one with 30
security invariants, a triple rule, the D10–D22 static checks, and a "no `any`"
non-negotiable.

Its actual output on Nimbus [#813](https://github.com/nimbus-agent/Nimbus/pull/813),
untuned, included:

> `graph-populator-clear.test.ts:73-90` — **Exercise replacement, not just
> idempotency.** Both syncs target the same repo, so this passes even if stale
> `targets` edges are never cleared.

That is a real defect: a test that passes whether or not the code works. It also
flagged `findCommitEntityIds` performing an unindexable scan per SHA. This is a
competent reviewer operating without context, not a noise generator.

**Consequence.** "Tune or remove" is not an open decision — it is a task, and it
is P3's first step. It also materially cheapens P3: a large share of
Nimbus-aware review is likely reachable by writing the monorepo a
`.coderabbit.yaml` whose `path_instructions` encode I1–I30, the triple rule and
the PAL import ban. Days, not weeks. Whether a Claude-based review action is
*still* needed afterwards becomes a genuine open decision, answered by evidence
rather than pre-committed.

---

## Correction 2 — the merge queue is unjustified; main CI is the real defect

The initial framing proposed a merge queue. Challenged for evidence, it does not
survive — but chasing it surfaced a worse problem.

**Last 40 `ci.yml` runs on `main`: 16 success, 1 failure, 22 cancelled.**

`ci.yml` sets `concurrency.group: ${{ github.workflow }}-${{ github.ref }}` with
`cancel-in-progress: true`. That is correct for PR branches and harmful on
`main`, where every push shares one group: merging a PR starts a validation run,
and the next merge kills it.

On 2026-07-21, three PRs merged at 18:33:21, 18:33:33 and 18:33:46 — twelve
seconds apart. Two of those three runs were cancelled by the next merge. **The
single main-branch CI failure across all 40 runs is timestamped 18:33 on
2026-07-21**, on that same batch.

Treat the failure correlation as suggestive, not conclusive (n=1). The
cancellation rate needs no inference: **56% of main-branch CI runs never
complete.** The commit that actually ships frequently has no finished validation
behind it, so "main is green" is more often "main was never asked."

**Consequences.**

- **No repo needs a merge queue.** `Nimbus` is the only repo with the volume to
  theoretically want one, and its problem is a concurrency misconfiguration, not
  a merge race. The satellites merge a handful of PRs each; a queue there is
  ceremony. Dropped from the program.
- **The fix is two lines** — keep `cancel-in-progress: true` for `pull_request`,
  set it `false` for pushes to `main`. This becomes **P4a** and moves early.
- A merge queue may be revisited only if semantic conflicts appear *after* main
  is genuinely validated, at which point there will be evidence.

---

## Correction 3 — App-as-credential already exists

The initial framing proposed replacing PAT sprawl with
`actions/create-github-app-token` as new work. Per
[`docs/ci-secrets.md`](../../ci-secrets.md), the **`nimbus-release-bot` GitHub
App is already live**, minting 1-hour installation tokens from
`RELEASE_BOT_CLIENT_ID` + `RELEASE_BOT_PRIVATE_KEY` across `release.yml`,
`release-please.yml`, `publish-package-managers.yml`, `publish-linux-repo.yml`
and `secret-health.yml`.

P2(b) is therefore **propagation to the satellites**, not invention — a smaller
job, and the same structural pattern as the CI diagnosis.

Two refinements this forces:

- **`VSCE_PAT` cannot be replaced by a GitHub App.** It is an Azure DevOps token
  authenticating to the VS Code Marketplace, not to GitHub. It needs
  rotation-with-a-reminder (it expires **2026-12-01**), and it belongs in P5's
  expiry surface, not P2's migration.
- `WINGET_PAT` is documented as the one remaining human-owned classic PAT in
  `Nimbus` — it must fork an external repo the App cannot reach. It stays a PAT
  by necessity; P5 watches its expiry.

---

## Operating principle

**Every sub-program ends in a gate a machine can check.**

Borrowed verbatim from
[`ecosystem-roadmap.md`](../../ecosystem-roadmap.md#thesis-and-operating-principle),
where it was adopted because agent-driven delivery writes confident code against
wrong contracts. It applies at least as strongly to infrastructure work, where
the failure mode is silent: a workflow that stopped running looks exactly like a
workflow that passes.

A sub-program is **done when its gate is green in CI and would go red if the
property regressed** — not when its code merges. Concretely: P1 is not done when
the reusable workflow lands, it is done when an org-wide SHA-drift sweep goes red
if a stale action is pinned in *any* repo.

---

## Document placement and precedence

P1 creates **`docs/infrastructure-roadmap.md`** as a sibling to the two existing
roadmaps. Rejected alternatives: folding this into `ecosystem-roadmap.md` (whose
scope is *how capability reaches a human*, and which polices that scope with an
explicit non-goals section — only P2 of five sub-programs touches its subject);
and growing `docs/ci-secrets.md` (a 466-line reference inventory, not a roadmap).

The three-way precedence rule, stated in the same form the existing pair use:

| Document | Authoritative for |
| --- | --- |
| [`roadmap.md`](../../roadmap.md) | What the gateway **does** — phases, acceptance criteria |
| [`ecosystem-roadmap.md`](../../ecosystem-roadmap.md) | **When** capability becomes reachable — client surface width |
| `infrastructure-roadmap.md` | **How** it gets built, reviewed and shipped |

On disagreement about gateway capability, `roadmap.md` wins. On disagreement
about client reachability, `ecosystem-roadmap.md` wins. The new file yields to
both and owns only the machinery.

**Registration is not free.** `audit:doc-refs` scans a fixed doc set and
`audit:status-drift` watches status lines; a new tracked document must be
registered in both or it either rots silently or fails the gate. P1 includes that
registration and treats it as part of the deliverable.

---

## The sub-programs

| | Sub-program | Size | Infra tier | Gate |
| --- | --- | --- | --- | --- |
| **P1** | Org CI Foundation | S–M | Actions-only | Org-wide SHA-pin + workflow-drift sweep goes red on any repo |
| **P2** | Release Train | S–M | Actions + existing release-bot App | A publish that fails to open its downstream PR fails a scheduled staleness check |
| **P3** | Review Layer | S–M | Actions-only | An invariant violation is caught in CI, not only in local `preflight` |
| **P4a** | Main-CI concurrency fix | XS | Actions-only | Every commit on `main` has a completed CI run |
| **P4b** | Latency | S–M | Actions-only | Per-job wall-clock tracked; regressions visible |
| **P5** | Org Legibility | S | Actions-only | Dashboard regenerates on schedule; stale downstream and expiring secrets surface before they bite |

### P1 — Org CI Foundation

Promote the reusable-workflow pattern from repo scope to org scope. The org
`.github` repo gains `_ci-npm-package.yml` (consumed by `nimbus-sdk`,
`nimbus-client`) and `_ci-extension.yml` (consumed by `nimbus-vscode`,
`nimbus-web-clipper`), plus shared composites; each satellite `ci.yml` shrinks to
a short caller. One place to bump a SHA.

Extend `audit:action-sha-pins` from a Nimbus-local preflight gate into a
scheduled org-wide sweep — this is the gate, and it is what makes the drift in
the diagnosis table structurally impossible to reintroduce.

Also delivers `docs/infrastructure-roadmap.md` and its gate registration.

**Carved out as an immediate standalone fix:** `nimbus-client` has **zero
rulesets** — no branch protection and no required checks — while `nimbus-sdk`,
`nimbus-vscode` and `nimbus-web-clipper` each have `General` + `Protected release
tags`. It is the narrow waist both the CLI and the VS Code extension depend on.
This lands independently of the program, ahead of it.

### P2 — Release Train

Three parts:

1. **Root-cause the chronic manual tag push.** Every release parks at
   `autorelease: pending` and requires `git tag vX.Y.Z <merge-commit>` by hand,
   blocking the next run. This is chronic, not a regression. Diagnose against a
   working-versus-broken run diff before naming a cause — a previous
   investigation misattributed it to the GitHub App.
2. **Propagate App-as-credential to the satellites** (see Correction 3),
   retiring the undeleted release PATs and resolving the `RELEASE_PLEASE_PAT`
   visibility drift.
3. **Downstream auto-consumption.** An upstream publish fires
   `repository_dispatch` downstream: `sdk@x` opens the consumption PR in
   `nimbus-client`; `client@y` opens them in `Nimbus` and `nimbus-vscode`. This
   is the Stage-1 dance — eight waves, `0.7.0` → `0.11.0`, each hand-driven —
   automated.

### P3 — Review Layer

Step 1: give `Nimbus` a `.coderabbit.yaml` whose `path_instructions` encode
I1–I30, the triple rule, the PAL import ban and the "no `any`" rule (see
Correction 1). Step 2: rationalize the three installed bots — SonarCloud is
required and blocking (keep as-is), CodeRabbit becomes tuned, `google-labs-jules`
is assessed. Step 3: decide on a Claude-based review action *after* measuring
what the tuned config still misses.

### P4a — Main-CI concurrency fix

Two lines (see Correction 2). Early, because it is the difference between a
validated `main` and an unvalidated one.

### P4b — Latency

PR CI ~12–13 min; main pushes 18–31 min. Options: cache tuning, matrix sharding,
finer path filters. Deliberately last, and only against P5's measurements. Merge
queue explicitly dropped.

### P5 — Org Legibility

A scheduled workflow writing a dashboard: version per repo and which downstreams
are stale against it, secret-expiry countdown (`VSCE_PAT` 2026-12-01,
`WINGET_PAT`), open PRs by repo, CI pass-rate and per-job durations. **Tier A**
writes markdown to the `.github` repo profile or a pinned issue — zero hosting.
**Tier B** (a hosted receiver for a live view) is the only candidate in the whole
program for a real webhook service, and is deferrable indefinitely.

P5 precedes P4b because it supplies the measurements P4b must be justified
against.

---

## Sequence

**P1 → P4a → P2 → P5 → P3 → P4b**

- **P1 first** — it creates the shared home everything else installs into, and it
  is the cheapest.
- **P4a second** — two lines, and until it lands, no other CI improvement can be
  trusted to have been validated on `main`.
- **P2 third** — highest toil payoff, and smaller than first estimated
  (Correction 3).
- **P5 fourth** — small, and it instruments P4b.
- **P3 fifth** — its first step is cheap; its second step needs evidence P3's
  first step generates.
- **P4b last** — measured, never guessed.

`nimbus-client` rulesets land ahead of all of it, independently.

---

## Design constraints

- **The reusable-workflow secrets contract is a landmine, and P1 is entirely
  inside its blast radius.** Secrets do not cross into reusable workflows without
  `secrets: inherit` or explicit passing. `CODECOV_TOKEN` was silently broken by
  exactly this — it never reached Codecov, and was ultimately retired rather than
  rotated. Every workflow P1 promotes must have its secret path verified as
  *observed working*, not assumed.
- **Branch-only workflow changes need live proof.** A bare `workflow_dispatch`
  runs `main`'s version of the workflow and fakes a pass. Push the branch first,
  then `gh workflow run --ref <branch>`.
- **A conflicting PR runs no `pull_request` workflows at all**, which presents as
  a green PR with suspiciously few checks. Check `mergeStateStatus` before
  trusting `gh pr checks` on anything in this program.
- **Docs-only PRs were historically blocked** by a skipped job never expanding
  `${{ }}` in its `name:`, so a required context was never created. Fixed by
  `pr-quality-required` (#788), but the end-to-end case has not yet been observed
  green. P1 adds tracked docs and will exercise it.

---

## Explicit non-goals

- **No hosted webhook receiver.** Nothing in P1–P5 requires one. P5 Tier B is the
  sole candidate and is deferrable indefinitely.
- **No self-hosted runners.**
- **No merge queue** (Correction 2).
- **Not a second security document.**
  [`SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md) owns I1–I30; P3 links
  to it and never restates it.
- **Not a secrets inventory.** [`ci-secrets.md`](../../ci-secrets.md) owns that;
  P2 and P5 link to it.
- **No human-reviewer workflow** — `CODEOWNERS` routing, review SLAs and
  round-robin assignment are out of scope; there are no human reviewers.

---

## Open decisions

1. **Is a Claude-based review action still needed once `Nimbus` has a tuned
   `.coderabbit.yaml`?** Deliberately unanswered. Tune first, measure what it
   still misses on the invariants, then decide whether a second reviewer buys
   something real. (Correction 1 removed the two decisions that used to sit here
   alongside this one.)
2. **What is `google-labs-jules`' role?** Installed org-wide with no visible
   output on recent PRs. Either it has a job in P3 or it should be uninstalled;
   an idle app with org-wide access is a standing permission grant with no
   return.
3. **Does `_ci-extension.yml` genuinely fit both `nimbus-vscode` and
   `nimbus-web-clipper`?** They are both extensions but target different hosts
   (VS Code vs MV3 browsers). If the shared surface turns out to be thin, two
   thin workflows beat one over-parameterized one.

---

## How to update this document

- This spec is superseded by `docs/infrastructure-roadmap.md` once P1 delivers
  it. Until then, this is authoritative for the program.
- A sub-program is **done** when its gate is green in CI, not when its code
  merges.
- Corrections stay as written. They record why the program is shaped this way,
  and rewriting them after the fact erases the evidence.
