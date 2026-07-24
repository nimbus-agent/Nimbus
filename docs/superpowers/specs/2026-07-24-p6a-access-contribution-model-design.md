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

Both new gates are **fail-soft locally** (exit 0 "skipped" when `gh` is
unavailable / unauthorized, like `ruleset-drift`) so they never false-block a
local `preflight` or an external contributor, and are registered in
`CI_ONLY_GATES` (network + App auth), not the fast tier.

**CI visibility — a skip in the scheduled sweep is loud, not silent.** Fail-soft
green is correct *locally* (a contributor has no `gh`/org auth) but wrong in the
*scheduled CI sweep*: there the App token must work, so a skip means the token or
a permission broke — precisely the "a control that silently passes is the enemy"
failure. So:

- On any skip, the script emits a GitHub Actions `::warning::` annotation (surfaces
  in the run summary), not just a plain log line.
- The `org-drift-sweep` jobs invoke the gates with a **`--strict`** flag (or the
  gates detect `GITHUB_ACTIONS`): under strict mode a would-be skip becomes a
  **red failure** with a clear "could not authenticate — the App token/permission
  is broken" message. Local/`preflight` runs stay fail-soft green.
- The same `--strict`-in-sweep treatment is applied to the existing
  `ruleset-drift` job in the same PR — it shares the fail-soft `decideExit` and
  the same silent-skip risk; keeping the three sweep gates consistent is a
  one-line-per-job change.

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
  - **Must paginate.** The GitHub list endpoints default to 30 results per page,
    so a bare call silently truncates once the org exceeds 30 repos — a truncated
    list is a *false green* (a dropped repo looks reachable). Use `gh api
    --paginate` (Link-header traversal) for both the repo and team-repo listings.
    The org has 18 repos today; this is future-proofing against exactly the silent
    gap the program exists to close.
  - **Excludes archived repos.** An archived repo is read-only and needs no active
    team maintenance, so the CLI filters `archived == true` out of `allRepos`
    before diffing. (None are archived today; this keeps a future archive from
    false-failing the gate.)
- An explicit **exemption allowlist** — `team_reachability.exempt` in
  `.github/org-access.json` (see Deliverable 2), a checked-in array, empty
  initially — for any repo intentionally reachable through no team, so an
  exemption is a reviewed diff, never a silent gap.
- Fail-soft locally, **strict in CI** (see "CI visibility" below); fails **red**
  naming each teamless repo.

### 2. Org-settings hardening + gate

**Change (apply-time, org-owner `PATCH /orgs/nimbus-agent`):**
`members_can_create_repositories: false`, `default_repository_permission: none`.
Both are safe today — the sole owner is unaffected by `default_repository_permission`
and by the repo-creation restriction.

**Gate — `.github/org-access.json` + `scripts/structure-audit/check-org-settings-drift.ts`:**

- **One consolidated config file, `.github/org-access.json`**, is the single
  source for org-access config. It holds two sections: `settings` (the desired
  org-settings values — a small explicit set: `members_can_create_repositories`,
  `default_repository_permission`; more can be added later) and
  `team_reachability.exempt` (Deliverable 1's exemption array). Both new gates
  read their own section of this one file:

  ```json
  {
    "$comment": "Desired org-access config; audited by check-org-settings-drift.ts and check-team-reachability.ts.",
    "settings": {
      "members_can_create_repositories": false,
      "default_repository_permission": "none"
    },
    "team_reachability": { "exempt": [] }
  }
  ```

- Pure fn `diffOrgSettings(desired, live): AuditResult` diffs the `settings`
  section against live.
- CLI wrapper reads live settings via the App token
  (`GET /orgs/nimbus-agent`, covered by `organization_administration: read`).
- Fail-soft locally, **strict in CI**; fails **red** on any reverted setting.
  This is the piece that stops the two settings drifting back unwatched.

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
intended approach and does **not** build it, for two reasons: (a) a check that
isn't scheduled and machine-enforced is not a "gate" by this program's bar, so it
would not change P6a's done-definition; and (b) the switch is not flipped until
contributor two, so the gap is not load-bearing yet.

**Intended mechanism (correcting the review's PAT suggestion):** when built, it
runs as a **local, owner-invoked** CLI check using the owner's **ambient `gh`
auth** — no new PAT. The org owner's existing `gh` credentials already read
`bypass_actors` correctly (verified during P1), and the secrets program is
actively *retiring* PATs, so introducing a PAT-based flow — even a local one —
cuts against the org's direction. The diff logic is cheap (the same
`structure-audit` shape) and can be added as a small follow-up; it is deferred
here to keep P6a scoped and because it earns nothing until contributor two.
Recorded as a roadmap follow-up.

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
  OK; an archived teamless repo → OK (excluded); empty inputs.
- `check-org-settings-drift.test.ts` — `diffOrgSettings`: match → OK; a reverted
  setting → red naming the field with expected/got; a missing field → red.
- Fail-soft vs strict: the `decideExit`-style path returns skip-green when
  unauthenticated **without** `--strict`, and a **red failure** with `--strict`
  (the CI-sweep mode), for both gates. This is the test that pins the "loud in
  CI" behavior.
- Pagination is a CLI-wrapper concern (uses `gh api --paginate`); the pure
  functions receive the already-complete list, so their tests pass fixtures large
  enough to prove no 30-item assumption leaks into the pure logic.
- Live validation post-apply: `gh workflow run org-drift-sweep.yml --ref main`
  and confirm `team-reachability` + `org-settings-drift` jobs are green.

---

## Definition of done

1. The six teamless repos are granted to `maintainers`; the two org settings are
   flipped; the App has `members: read`.
2. `.github/org-access.json` and the `$contributor_two` block are checked in;
   both new gates are registered (`package.json` + `CI_ONLY_GATES`) and wired as
   jobs in `org-drift-sweep.yml`.
3. A live `org-drift-sweep` run on `main` is **green** across all jobs, and each
   new gate would go **red** if its property regressed (a teamless repo; a
   reverted setting).
4. The roadmap records P6a delivered plus the two documented deferrals.

---

## Design-review dispositions

Responses to [the review](./2026-07-24-p6a-access-contribution-model-design-review.md):

| # | Point | Disposition |
| --- | --- | --- |
| 1a | Archived-repo handling | **Fixed** — the reachability CLI excludes `archived == true` (none today; future-proofing). |
| 1b | Pagination (30/page default) | **Fixed** — `gh api --paginate` mandated for the repo + team-repo listings; a truncated list is a false green, the exact anti-pattern. |
| 2 | Fail-soft silent-green visibility | **Fixed** — `::warning::` on skip **and** `--strict` in the CI sweep turns a skip into a red failure (a skip there means the token broke); same treatment back-ported to `ruleset-drift`. |
| 3 | Bypass-actor: build now, local PAT | **Deferred (refined).** Kept deferred — a non-scheduled check isn't a "gate" by this program's bar and the switch isn't live until contributor two. Corrected the mechanism: when built it uses the owner's **ambient `gh` auth, no PAT** (the secrets program is retiring PATs; owner `gh` already reads `bypass_actors`). |
| 4 | Exemption allowlist location | **Fixed** — consolidated into one `.github/org-access.json` (`settings` + `team_reachability.exempt`), the single org-access config source. |
