# P6a — Access & Contribution Model (core) Design

Second sub-program of the [infrastructure roadmap](../../infrastructure-roadmap.md),
per the sequence **P1 → P6 → P2 → P5 → P3 → P4b**. P1 built the propagation
mechanism (the org-wide drift sweep); P6a uses it to make the org's *access model*
a checked-in, drift-gated property before contributor two arrives.

> **Scope cut.** P6 as written in the
> [program design](./2026-07-23-org-infrastructure-program-design.md) bundles
> three efforts: the access model (this spec), the **CLA** (its own spec, next),
> and a higher-privilege **bypass-actor audit** (deferred follow-up, below). P6a
> is the access-model core only.

---

## The pattern this continues

P1's finding — *controls stop where they were written* — recurs in **org
configuration**, not just CI. Teams were created for the periphery and the
monorepo and never extended to the publishing chain; four solo-mode ruleset
settings are correct for one person and become wrong silently with a second; two
org settings grant broad default access. None of these is watched, so each can
drift (or stay wrong) unnoticed. P6a applies the same remedy P1 did: make the
desired state checked-in config, and add a scheduled gate that goes red on
divergence.

**Operating principle (unchanged):** P6a is *done* when its gates are green in CI
and would go red if the property regressed — not when the changes are applied.

---

## Current state (validated 2026-07-24)

- **Teams:** three `closed` teams, one member each — `maintainers` (maintain on
  `Nimbus`/`homebrew-tap`/`scoop-bucket`, admin on nine others),
  `connector-authors` (write on the three connector-tooling repos),
  `community-contributors` (triage on `awesome-nimbus`/`nimbus-recipes`).
- **Six repos reachable through no team:** `.github`, `linux-repo`,
  `nimbus-client`, `nimbus-sdk`, `nimbus-vscode`, `nimbus-web-clipper` — the npm
  narrow waist plus the shared-workflow home.
- **Org settings:** `members_can_create_repositories: true`,
  `default_repository_permission: read`, plan **Free**, 2FA required org-wide.
- **18 repos total**, 6 private (`nimbus-recipes`, `create-nimbus-connector`,
  `nimbus-connector-registry`, `nimbus-mcp-servers`, `nimbus-raycast`,
  `nimbus-statuspage`).

## Decisions taken (this brainstorm)

1. **Scope:** access-model core first; CLA and the bypass-actor audit are
   separate/deferred.
2. **Plan ceiling:** **stay on Free.** Reachability + team grants + org-settings
   hardening cover all 18 repos (teams work on Free). Ruleset protection stays
   public-only (the 5 code repos already gated by P1); private-repo ruleset
   protection is **blocked-on-Team** and documented as such, revisited when
   contributor two needs private access.
3. **Gating ambition:** **gate everything** — flip the real changes now *and* add
   drift gates, because org settings are exactly what reverts silently.

---

## Architecture

No new machinery. Every gate follows the established `scripts/structure-audit/`
shape — a pure exported diff function over a plain object, unit-tested against a
fixture, plus an `import.meta.main` CLI wrapper — and is added as a **job in the
existing `.github/workflows/org-drift-sweep.yml`**, reusing the
`nimbus-release-bot` App-token mint. Desired state lives in checked-in files
under `.github/`. This is the same idiom as P1's `check-ruleset-drift.ts` and
`check-action-sha-pins.ts`.

Both new gates are **fail-soft** (exit 0 "skipped" when `gh` is unavailable /
unauthorized, exactly like `ruleset-drift`) so they never false-block a local
`preflight` or an external contributor, and are registered in `CI_ONLY_GATES`
(network + App auth), not the fast tier.

---

## Deliverables

### 1. Team reachability

**Change (apply-time, org-owner):** grant `maintainers` the six teamless repos —
`maintain` on the four code repos (`nimbus-client`, `nimbus-sdk`,
`nimbus-vscode`, `nimbus-web-clipper`, mirroring `Nimbus`), `admin` on `.github`
and `linux-repo`. The role is a judgment call and easily changed; the gate is
role-agnostic.

**Gate — `scripts/structure-audit/check-team-reachability.ts`:**

- Pure fn `findUnreachable(allRepos: string[], teamRepos: string[], exempt: string[]): AuditResult`
  — returns the repos in `allRepos` that appear in no team's grant list and are
  not exempt.
- CLI wrapper fetches, via the App token: all org repos
  (`GET /orgs/nimbus-agent/repos`) and, for each team, its repo grants
  (`GET /orgs/nimbus-agent/teams/{slug}/repos`), unions the grants, and diffs.
- An explicit **exemption allowlist** (checked-in, empty initially) for any repo
  intentionally reachable through no team — so an exemption is a reviewed diff,
  never a silent gap.
- Fail-soft on auth/network failure; fails **red** naming each teamless repo.

### 2. Org-settings hardening + gate

**Change (apply-time, org-owner `PATCH /orgs/nimbus-agent`):**
`members_can_create_repositories: false`, `default_repository_permission: none`.
Both are safe today — the sole owner is unaffected by `default_repository_permission`
and by the repo-creation restriction.

**Gate — `.github/org-settings.json` + `scripts/structure-audit/check-org-settings-drift.ts`:**

- `.github/org-settings.json` holds the desired values (a small, explicit set:
  `members_can_create_repositories`, `default_repository_permission`; more can be
  added later).
- Pure fn `diffOrgSettings(desired, live): AuditResult` diffs declared vs live.
- CLI wrapper reads live settings via the App token
  (`GET /orgs/nimbus-agent`, covered by `organization_administration: read`).
- Fail-soft; fails **red** on any reverted setting. This is the piece that stops
  the two settings drifting back unwatched.

### 3. Contributor-two switch set (checked-in, no new gate)

The four solo→team switches:

| Switch | Solo (now) | Contributor-two |
| --- | --- | --- |
| `required_approving_review_count` | `0` | `1` |
| `require_code_owner_review` | `false` | `true` |
| `require_last_push_approval` | `false` | `true` |
| OrganizationAdmin bypass mode | `always` | `pull_request` (or remove) |

The first three are **already enforced solo-values** in
`.github/rulesets/general-branch.json`, so `ruleset-drift` already catches a UI
flip on them. This deliverable adds a documented **`$contributor_two` advisory
block** to that file recording the four switches and their targets, so onboarding
contributor two is **one reviewed diff** (edit the enforced fields; the gate then
enforces the new values). `require_code_owner_review: true` is the highest-value
switch — `CODEOWNERS` already maps every invariant-bearing file and is
documentary until a second maintainer gains write access.

No new gate: the block is advisory (`$`-prefixed, ignored by the audit like
`$comment`); the enforcement for three of the four already exists.

### 4. Bypass-actor audit — deferred, documented

The fourth switch is the `bypass_actors` field the CI App token **cannot read**
(proven in P1: `Administration: read` returns an empty `bypass_actors` for
org-level actors, and `organization-administration: read` does not restore it;
reading it needs `Administration: write`, which a read-only audit must not hold).
Gating it needs an **org-owner credential**, not the App token. P6a documents the
intended approach — a periodic check run with an org-owner credential, out of
band from the App-token sweep — and does **not** build it. The switch isn't
flipped until contributor two, so the gap is not load-bearing yet. Recorded as a
roadmap follow-up.

### 5. Roadmap update

Mark P6a delivered; record the two new gates and their commands
(`audit:team-reachability`, `audit:org-settings-drift`); note the deferred
bypass-actor audit and the Free-plan private-repo deferral (blocked-on-Team).

---

## Dependency / risk: the App token's `members` permission

Both P1's saga and this one turn on what the `nimbus-release-bot` App token can
read. Current App permissions: `metadata: read`, `contents: write`,
`issues: write`, `pull_requests: write`, `administration: read`,
`organization_administration: read`.

- **Org settings** (`GET /orgs/{org}`) — covered by `organization_administration: read`. Expected to work.
- **Teams + team repos** (`GET /orgs/{org}/teams`, `.../teams/{slug}/repos`) —
  need the org **`members: read`** permission, which the App does **not** have.
  The reachability gate will therefore fail token-mint / read until the App is
  granted `members: read` (an org-owner UI action; same playbook as P1's
  `Administration: read` grant + web-clipper install).

**Mitigation:** both gates are fail-soft, so an ungranted permission yields a
skip-green, never a false red. The apply steps include granting `members: read`
and a **live validation** (dispatch the sweep, confirm both new jobs go green)
before P6a is called done — the same "prove the gate green on `main`" close-out
P1 used. If a permission genuinely cannot be granted, that gate is descoped to a
documented follow-up rather than left silently skipping.

---

## Non-goals / explicitly deferred

- **The CLA** (ICLA/CCLA text + signature bot) — its own spec, next.
- **Private-repo ruleset protection** — blocked-on-Team (Free-plan ceiling);
  revisited when contributor two needs private access.
- **The bypass-actor audit** — needs an org-owner credential; documented follow-up.
- **A strict repo→team→role map.** The reachability gate asserts "reachable
  through ≥1 team," matching the spec's named gate, not a declared exact grant
  map. A strict map (catching role changes / grant removal on a still-reachable
  repo) is a possible future tightening, not P6a.
- **Actually flipping the contributor-two switches** — they are recorded, not
  flipped; flipping them is the contributor-two onboarding event.

---

## Testing

- `check-team-reachability.test.ts` — the pure `findUnreachable` over fixtures:
  all-reachable → OK; a teamless repo → red naming it; an exempt teamless repo →
  OK; empty inputs.
- `check-org-settings-drift.test.ts` — `diffOrgSettings`: match → OK; a reverted
  setting → red naming the field with expected/got; a missing field → red.
- Both CLI wrappers' `decideExit`-style fail-soft path covered (queried-zero →
  skip green), mirroring `ruleset-drift`.
- Live validation post-apply: `gh workflow run org-drift-sweep.yml --ref main`
  and confirm `team-reachability` + `org-settings-drift` jobs are green.

---

## Definition of done

1. The six teamless repos are granted to `maintainers`; the two org settings are
   flipped; the App has `members: read`.
2. `.github/org-settings.json` and the `$contributor_two` block are checked in;
   both new gates are registered (`package.json` + `CI_ONLY_GATES`) and wired as
   jobs in `org-drift-sweep.yml`.
3. A live `org-drift-sweep` run on `main` is **green** across all jobs, and each
   new gate would go **red** if its property regressed (a teamless repo; a
   reverted setting).
4. The roadmap records P6a delivered plus the two documented deferrals.
