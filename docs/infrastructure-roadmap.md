# Nimbus Infrastructure Roadmap

The delivery machinery for everything the org builds: CI, release automation,
PR review, and cross-repo coordination.

> **Three roadmaps, three axes.** [`roadmap.md`](./roadmap.md) is authoritative
> for **what the gateway does** — phases, acceptance criteria.
> [`ecosystem-roadmap.md`](./ecosystem-roadmap.md) is authoritative for **when
> capability becomes reachable** — client surface width. This file is
> authoritative for **how it gets built, reviewed and shipped**.
>
> On disagreement about gateway capability, `roadmap.md` wins. On disagreement
> about client reachability, `ecosystem-roadmap.md` wins. This file yields to
> both and owns only the machinery.

---

## The pattern this exists to break

**Controls stop where they were written.** Three instances, found across
unrelated areas of the org:

| Control | Written in | Where the risk is | Propagation |
| --- | --- | --- | --- |
| `audit:action-sha-pins` | `Nimbus` | the satellites — pins already drifted | never made |
| `.coderabbit.yaml` (tuned) | the 4 satellites | `Nimbus` — 30 invariants, reviewed stock | never made |
| `ci-secrets.md` completeness claim | when authored | `secret-health.yml`'s own credentials | never made |

Two point in opposite directions, so this is not "the periphery lags." A control
here is scoped to whatever context its author was in, and nothing carries it
further — not to another repo, not to a later day.

**Operating principle:** every sub-program ends in a gate a machine can check. A
sub-program is done when its gate is green in CI and would go red if the
property regressed — not when its code merges. A control that has stopped
covering the risk looks exactly like one that is passing; only a gate that would
go red tells them apart.

---

## Sub-programs

Design of record:
`superpowers/specs/2026-07-23-org-infrastructure-program-design.md`.

| | Sub-program | Status | Gate |
| --- | --- | --- | --- |
| P1 | Org CI Foundation | ✅ done | The scheduled sweep goes red on drift: SHA-pins across the 8 public org repos, ruleset shape across the 5 active code repos — proven green end-to-end (run 30060920603) |
| P2 | Release Train | ⬜ not started | A publish that fails to open its downstream PR fails a staleness check |
| P3 | Review Layer | ⬜ not started | An invariant violation is caught in CI, not only in local `preflight` |
| P4a | Main-CI concurrency | ✅ shipped | Every commit on `main` has a completed CI run |
| P4b | Latency | ⬜ not started | Per-job wall-clock tracked; regressions visible |
| P5 | Org Legibility | ⬜ not started | `audit:secret-inventory` fails on any workflow secret missing from `ci-secrets.md` |
| P6 | Access & Contribution Model | 🔨 P6a done | Every repo reachable through a team + org settings gated (both in the sweep); contributor-two switches recorded in checked-in config. Remaining: CLA, bypass-actor audit |

**Sequence:** P1 → P6 → P2 → P5 → P3 → P4b. Three items ignore the sequence and
land immediately: P4a, `nimbus-client` rulesets, and the contribution-licensing
decision (resolved 2026-07-24 — **CLA**, see the P1 progress log; implementation
moves to P6).

### P1 progress log

- **Main-CI concurrency (P4a)** — shipped: `cancel-in-progress` is now conditional
  on `github.event_name == 'pull_request'`, so consecutive `main` merges no longer
  cancel each other's validation.
- **`nimbus-client` rulesets** — shipped: a `General` branch ruleset (id
  `19635616`, active) now protects the narrow-waist repo that had none, matching
  the shape the other active code repos share (squash-only, thread-resolution
  required, zero required approvals in solo mode).
- **Contribution-licensing decision (2026-07-24)** — resolved to a **CLA** over a
  DCO. A CLA preserves relicensing optionality for any future commercial
  dual-licensing of the AGPL-3.0 core; that optionality is the deciding factor,
  since both mechanisms establish a contributor's right to submit. The P1 plan's
  Task 7 (a `Signed-off-by` DCO + `dco.yml` check) is therefore **superseded, not
  amended** — P1 ships with Tasks 1–6 only. The CLA is its own sub-effort (an
  ICLA/CCLA text + a signature-capture bot) and moves to its natural home in **P6
  (Access & Contribution Model)**; it is *not* a blocker for the P1 PR.
- **Ruleset-drift coverage** — the diff pins name/target/enforcement,
  `ref_name.include` **and `ref_name.exclude`** (an `exclude` naming the default
  branch is a silent total-bypass), the required rule types, and the pull-request
  parameters. **Bypass actors are deliberately NOT diffed** (finding from the
  first live run, below): the CI credential is a repo-scoped App installation
  token with `Administration: read`, and GitHub returns an **empty
  `bypass_actors`** to it for org-level actors (`OrganizationAdmin`). Proven live
  that adding `organization-administration: read` does **not** restore it, and
  reading the field otherwise needs `Administration: write` — which a read-only
  audit gate must not hold. Diffing it therefore false-failed on every repo that
  carries an org-level bypass. **Follow-up:** audit bypass actors from a
  higher-privilege context (a scheduled org-owner credential, not the sweep's App
  token). The intended shape is recorded in `.github/rulesets/general-branch.json`:
  `OrganizationAdmin` on Nimbus/nimbus-vscode/nimbus-web-clipper, none on
  nimbus-client/nimbus-sdk.
- **First post-merge sweep run (2026-07-24)** — P1 merged (#818), so the
  net-new `workflow_dispatch` could finally fire. **`sha-pins`: green across all 8
  repos** — the propagation mechanism works end-to-end. **`ruleset-drift`:** the
  App-token path works (token mint succeeds once `nimbus-release-bot` has
  `Administration: read` and is installed on all 5 repos), and the audit then
  surfaced the `bypass_actors` token-visibility limitation above — closed by
  dropping that one field from the diff. Every other check reads reliably.
- **First org drift sweep (2026-07-23)** — all 8 repos pass `audit:action-sha-pins`
  (run locally as `bun scripts/structure-audit/check-action-sha-pins.ts --root
  <checkout>` against fresh clones, pending the workflow's first post-merge run —
  a net-new `workflow_dispatch` cannot fire on a feature branch). **Finding:** the
  version drift noted in the design (`harden-runner` v2.20.0 vs v2.19.4,
  `actions/checkout` v7.0.1 vs v7.0.0) is *staleness*, not *unpinning* — every ref
  is correctly SHA-pinned, just to older SHAs. The SHA-pin gate is green and
  structurally cannot detect staleness; a freshness check is a **Plan B**
  follow-up.

### P6a progress log

- **Delivered (2026-07-24) — checked-in config + gates:** `.github/org-access.json`
  (desired org settings + team-reachability exemptions); the two gates
  `audit:org-settings-drift` + `audit:team-reachability` wired into
  `org-drift-sweep` (fail-soft locally, `--strict` in CI); and the four
  contributor-two switches recorded in the `$contributor_two` block of
  `.github/rulesets/general-branch.json`.
- **Applied (2026-07-24, org-owner):** the six teamless repos (`.github`,
  `linux-repo`, the four npm narrow-waist repos) are granted to `maintainers`;
  `members_can_create_repositories` → false and `default_repository_permission`
  → none; the `nimbus-release-bot` App granted `members: read`.
- **Proven green end-to-end (run 30071156534):** a dispatched `org-drift-sweep`
  is green across all 11 jobs — `sha-pins` (8), `ruleset-drift`,
  `org-settings-drift`, and `team-reachability` — with the two new gates
  authenticating via their scoped App tokens (org-administration read /
  members read). Both were **red** before the apply (they detect the un-applied
  state) and green after: the gate would go red on regression, which is this
  file's definition of *done*.
- **Deferred:** the CLA (own spec) and a higher-privilege **bypass-actor audit**
  (the CI App token cannot read `bypass_actors`; a future owner-`gh`-run check,
  no PAT). Private-repo ruleset protection stays **blocked-on-Team** (Free plan).

### CLA progress log

- **Delivered (config + gate):** broad-relicensable ICLA + CCLA drafted
  (`docs/cla/`, pending ratification), the reusable `cla.yml` template, the
  `cla-coverage` drift gate (all 7 public repos have `cla.yml` at one version),
  and `CONTRIBUTING.md` terms.
- **Pending apply (org-owner):** ratify the CLA wording; create the dedicated CLA
  App + `SELECTED` private-key secret; create the `.github` `cla-signatures`
  branch + deploy `CLA/ICLA.md`/`CLA/CCLA.md`; deploy `cla.yml` to all 7 repos;
  make the `CLA Assistant` check required in each ruleset; **red-prove** with a
  test PR; confirm `cla-coverage` green.
- **Deferred:** CCLA employee-roster automation; private repos; retroactive
  signatures. See `docs/superpowers/specs/2026-07-24-cla-design.md`. Robustness
  follow-up: `check-cla-coverage` treats any per-repo `gh` failure as "cla.yml
  absent" (a public-repo 404 is genuine, but a transient 5xx/rate-limit would
  false-red until the next run) — surface the `gh` exit code in `_gh-audit.ts`
  and treat a non-404 failure as indeterminate, like `team-reachability`.

---

## How to update this document

- A sub-program is **done** when its gate is green in CI, not when its code
  merges.
- When a gate lands, record the command that runs it, so the claim is checkable.
- When this file and [`roadmap.md`](./roadmap.md) disagree about gateway
  capability, `roadmap.md` wins — fix this one.
