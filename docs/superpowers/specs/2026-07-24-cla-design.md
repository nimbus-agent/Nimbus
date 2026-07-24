# CLA — Contributor License Agreement Design

A P6 sub-effort of the [infrastructure roadmap](../../infrastructure-roadmap.md).
P6a made the org's *access* model a gated property; this makes inbound
*contribution licensing* one too, before contributor two arrives.

> **Legal caveat.** The CLA documents this spec defines are a binding legal
> commitment by the project owner. This spec adapts widely-used, standard
> templates and calls out the legally-sensitive clause explicitly, but the final
> wording is the owner's (or counsel's) to ratify — it is **not** authoritative
> legal advice.

---

## Why a CLA (and why now)

The DCO-vs-CLA decision was **resolved to a CLA** (2026-07-24, org-program open
decision 6) for one reason a DCO cannot provide: a CLA can grant the project the
right to **relicense** contributions, preserving the option of future commercial
dual-licensing of the AGPL-3.0 core. `CONTRIBUTING.md` currently carries **no**
sign-off or CLA terms and the repos are **public**, so the first outside PR can
arrive any day; prospective collection is far cheaper than retroactive.

The dual license sharpens it: the gateway/CLI/connectors are **AGPL-3.0**, while
`@nimbus-dev/sdk` and `@nimbus-dev/client` are **MIT**. Code may flow **MIT →
AGPL** but never the reverse; a CLA (plus a restated one-way rule in
`CONTRIBUTING.md`) makes that a thing contributors *agree to*, not just a thing
architecture enforces.

## Decisions taken (this brainstorm)

1. **Mechanism:** the self-hosted **`contributor-assistant/github-action`** —
   sign by PR comment, signatures stored **in-repo** (shared store), a required
   status check. No external SaaS, no signature data off-machine, App-token auth
   (no PAT).
2. **Grant model:** a **broad license grant** — the contributor keeps copyright
   but grants `nimbus-agent` a perpetual, irrevocable, worldwide license
   *including the right to sublicense/relicense under any terms, including
   proprietary*. (Not copyright assignment.)
3. **Documents:** both an **ICLA** (individual) and a **CCLA** (corporate), now.
4. **Scope:** **all 6 public contribution repos** — `Nimbus`, `nimbus-sdk`,
   `nimbus-client`, `nimbus-vscode`, `nimbus-web-clipper`, `awesome-nimbus`.

---

## Architecture

### 1. The legal text (single source, org-wide)

- **`ICLA.md`** — Individual CLA, based on the **Apache ICLA** structure
  (copyright license, patent license, origin certification, "as-is"), with the
  **license-grant clause modified** so the contributor grants `nimbus-agent` a
  perpetual, irrevocable, worldwide, royalty-free license to reproduce, prepare
  derivative works of, publicly display/perform, sublicense, and distribute the
  contribution **and to license it under any terms, including terms that differ
  from the repository's then-current license (e.g. a commercial/proprietary
  license)**. This relicensing clause is the legally-sensitive part and the whole
  reason a CLA was chosen over a DCO — it is flagged for owner/counsel review.
- **`CCLA.md`** — Corporate CLA. The same grant made by a legal entity, with a
  **Schedule A** of covered employees the signer maintains, and a designated
  point of contact.
- **Home:** both live **once** in the org **`.github`** repo under `CLA/`
  (`CLA/ICLA.md`, `CLA/CCLA.md`) — GitHub's org community-health home. Every
  gated repo's Action links to the same canonical URLs.

### 2. The shared signature store (sign once, covered everywhere)

- Signatures are stored **once** — in a dedicated `cla-signatures` branch of the
  `.github` repo, at `signatures/version1/cla.json`, written by the Action.
- All 6 repos' workflows point at this **same** store, so a contributor **signs
  once and is covered across every gated repo** (the store is shared, not
  per-repo).
- Versioning: the store path carries a version (`version1`). Bumping the CLA text
  materially bumps the version, which re-requires signatures — a deliberate,
  visible event, not silent. **Version-bump SOP:** a bump must update the CLA doc
  **and** the `path-to-signatures` version in **all 6** workflows in **one
  coordinated PR** — otherwise a contributor is blocked on a not-yet-bumped repo
  while allowed on a bumped one. The `cla-coverage` gate (§4) asserts the version
  string is identical across the 6 repos, so a partial bump goes red.
- **Concurrent writes:** the action writes `cla.json` via a conditional API write
  to one shared file; the action documents **no** retry/back-off. Two *new*
  contributors signing within the same few seconds across different repos could
  collide (`non-fast-forward`), failing one run. This is **low-severity** —
  signing is a once-per-contributor-ever event, so the window is tiny — and
  self-recovering: the affected contributor re-comments `recheck` (or re-signs).
  The plan verifies the action's actual conflict behavior; no cross-repo write
  serialization is built (disproportionate for the volume).
- **Branch protection:** signatures live on the **non-default** `cla-signatures`
  branch, so `.github`'s `main`-targeted `General` ruleset does **not** gate it —
  the App token writes with plain `contents: write`, bypassing nothing on `main`.
  Do **not** add branch protection to `cla-signatures` (it would block the bot).

### 3. The enforcement Action (`.github/workflows/cla.yml`, per repo)

Each of the 6 repos gets an identical workflow (SHA-pinned actions, per org
policy):

- **Triggers:** `issue_comment` (types: `created`) + `pull_request_target`
  (types: `opened`, `synchronize`, `reopened`). A contributor signs by commenting
  a fixed phrase (e.g. *"I have read the CLA Document and I hereby sign the
  CLA"*) on their PR.
- **Runs** `contributor-assistant/github-action@<SHA>` configured with: the
  shared store (`remote-repository-name: .github`, `branch: cla-signatures`,
  `path-to-signatures`), the ICLA URL (`path-to-document`), a custom PR comment
  that also links the **CCLA** path for corporate contributors, and a **minimal
  `allowlist`** — the `bot*` wildcard (covers `dependabot[bot]`, the release bot,
  every bot) plus the single org owner's username. Keeping it to a pattern + one
  name minimizes the per-file duplication across the 6 (byte-identical) workflows;
  dynamic org-membership querying is a follow-up, YAGNI for a one-member org.
- **All commit authors must sign, not just the PR sender.** A PR can carry commits
  by multiple authors (co-authored-by, cherry-picks). The gate must require a
  signature from **every unique commit author/committer** in the PR — an unsigned
  co-author must not merge under a signed sender. The plan **verifies** that
  `contributor-assistant` enforces this (it is the expected behavior); if it only
  checks the sender, the plan adds a mitigation (a supplementary all-authors check
  or requiring external PRs be single-author). This is a correctness requirement,
  not a nicety.
- **Security invariant (`pull_request_target`):** this trigger runs the **base
  repo's** trusted workflow with base secrets **even on fork PRs**, so the workflow
  **must never** check out the PR head (`github.event.pull_request.head.sha`/`.ref`)
  and **must never** run repo scripts (`npm`/`bun`/`make` etc.) — it reads only PR
  metadata and the comment body. This is exactly what keeps a fork PR from
  exfiltrating the store token. Minimal `permissions:` and SHA-pinned actions.
- **Token (corrected):** the action's **required** `PERSONAL_ACCESS_TOKEN` input
  is fed a **minted GitHub App installation token** (via `create-github-app-token`
  at run time) — so no long-lived PAT is ever stored, consistent with the
  retiring-PATs stance. With a **remote** store the token's scope spans **both**
  the store repo (`contents: write` on `.github`) **and** the PR repo
  (`pull-requests: write`, `statuses: write`, `contents: read`) to post the
  comment + status. That means one App installed on `.github` + the 6 gated repos
  with those permissions — broader than a single repo, and likely needing an App
  permission/install step (as P6a's `members: read` did). The plan confirms an
  App token is accepted in the `PERSONAL_ACCESS_TOKEN` slot before rollout.

### 4. The gate — two layers (per the program's "goes red on regression" rule)

1. **Runtime gate (the sub-program's definition of done):** the `CLA Assistant`
   status check is made a **required** check in each repo's ruleset. It is
   **red-proven**: a test PR from a **non-allowlisted** account shows the CLA
   check **red** until the account comments its signature, then **green** — a
   gate that has been observed red, not merely assumed.
2. **Coverage drift gate:** a new **`cla-coverage`** job in the existing
   `org-drift-sweep` asserts that each of the 6 gated repos has
   `.github/workflows/cla.yml` present **and that its `path-to-signatures`
   version string matches across all 6** (so a partial version bump — §2 — goes
   red). This makes "the CLA is wired, and identically, in every gated repo" a
   checked, goes-red-on-regression property — so it cannot silently stop at one
   repo or drift between them (the exact "controls stop where they were written"
   pattern the program exists to break). It reuses the P1/P6a `_gh-audit.ts`
   fail-soft / `--strict`-in-CI plumbing and the App token.

### 5. `CONTRIBUTING.md`

Updated (in `Nimbus`, and mirrored as the org default in `.github` for the
satellites) to explain: the sign-by-PR-comment flow, **ICLA vs CCLA** (when a
contributor needs the corporate one), and a restated **MIT → AGPL one-way rule**
— a patch to the MIT packages must not be derived from AGPL-licensed parts of the
repo. The broad-grant CLA supersedes a DCO sign-off, so the two are **not**
stacked.

---

## The required-check context-name caveat

The required-status-check **context name** is per-repo and is the most
drift-prone part of a ruleset (P1's Task 2 deliberately omitted required checks
for this reason). The `contributor-assistant` action publishes a fixed context
(e.g. `CLA Assistant` / `license/cla`); the spec **pins the exact context name**
and the ruleset requires it verbatim. The `cla-coverage` gate is the backstop: it
catches a repo whose workflow (and thus its check) is missing.

---

## Rollout (phased; detailed in the plan)

1. **Foundation + Nimbus, red-proven:** author `ICLA.md`/`CCLA.md` in `.github`;
   create the `cla-signatures` store; mint the scoped App token; add `cla.yml`
   to **`Nimbus`**; update `CONTRIBUTING.md`; make the CLA check required on
   `Nimbus`; **red-prove** with a test PR.
2. **Propagate:** add the identical `cla.yml` to the other 6 repos and make the
   CLA check required in each repo's ruleset.
3. **Coverage gate:** add the `cla-coverage` job to `org-drift-sweep`, registered
   in `CI_ONLY_GATES`, and prove it green (and red on a missing wiring).

---

## Non-goals / explicitly deferred

- **CCLA automation.** The action gates against the ICLA; the corporate flow
  (employer signs, maintains Schedule A) is **document + manual review**, not an
  automated per-employee check. Automating CCLA employee rosters is a follow-up.
- **A bespoke CLA bot.** `contributor-assistant` is mature and self-hosted;
  writing our own is out of scope (rejected in the brainstorm).
- **cla-assistant.io SaaS** — rejected (external dependency + signatures
  off-machine).
- **Private repos** — not public, no external PRs; out of scope (revisit if one
  opens to contribution).
- **Retroactive signatures** — the store starts empty; there are no prior outside
  contributors to backfill.

---

## Security & non-negotiables

- **`pull_request_target` never runs PR code** (§3) — the one real security edge
  here; stated as an invariant, minimal-permissions, SHA-pinned.
- **No stored PAT** — the `PERSONAL_ACCESS_TOKEN` input receives a **minted** App
  installation token (§3), never a long-lived PAT. The App's **private-key org
  secret** is stored **`SELECTED`-scoped** to only the 6 gated repos (not `ALL`),
  and because `pull_request_target` runs the trusted base workflow (never fork
  code), a fork PR cannot read or exfiltrate it.
- **SHA-pinned actions** — `contributor-assistant/github-action` and any others
  are pinned to a full 40-hex SHA; `audit:action-sha-pins` enforces it.
- **No signature data off-machine** — stored in-repo, in the org.

---

## Definition of done

1. `ICLA.md` + `CCLA.md` (broad relicensable grant) are checked into `.github`;
   `CONTRIBUTING.md` explains the flow + the one-way rule.
2. The shared signature store + the scoped App token exist; `cla.yml` is wired in
   all 6 repos; the `CLA Assistant` check is **required** in each repo's ruleset.
3. The runtime gate is **red-proven** on a test PR (red unsigned → green signed).
4. The `cla-coverage` sweep gate is green and would go **red** if a repo's
   `cla.yml` regressed.
5. The roadmap records the CLA delivered + the CCLA-automation deferral.

---

## Design-review dispositions

Responses to [the review](./2026-07-24-cla-design-review.md); the action's
behaviour was verified against its published README.

| # | Point | Disposition |
| --- | --- | --- |
| 1a | Concurrent writes to the shared `cla.json` | **Fixed (documented).** Confirmed the action documents no retry. Low-severity (signing is once-ever per contributor); recovery = re-comment `recheck`; plan verifies actual behaviour; no cross-repo serialization built (§2). |
| 1b | Branch protection on the signature branch | **Fixed (clarified).** Signatures live on the non-default `cla-signatures` branch, so `.github`'s `main` ruleset doesn't gate it; App writes with plain `contents: write`; do not protect that branch (§2). |
| 2 | App-token distribution + secret scoping | **Fixed (corrected).** Token story rewritten: a minted App token is fed to the required `PERSONAL_ACCESS_TOKEN` input (no stored PAT); the private-key org secret is `SELECTED`-scoped to the 6 repos; `pull_request_target` running trusted base code is what prevents fork exfiltration (§3, Security). |
| 3 | `pull_request_target` never runs PR code | **Fixed (strengthened).** Invariant now names the exact anti-patterns (never checkout `head.sha`/`.ref`, never run `npm`/`bun`/`make`) (§3). |
| 4 | All commit authors must sign, not just the sender | **Fixed (requirement + plan-verify).** Added as a correctness requirement; the plan verifies `contributor-assistant` enforces it and adds a mitigation if not (§3). |
| 5 | Allowlist duplicated across 6 files → drift | **Fixed + partial defer.** Confirmed `bot*` wildcard works → allowlist shrinks to `bot*` + one owner name; 6 workflows byte-identical from one template; `cla-coverage` asserts consistency. Dynamic org-membership querying deferred (YAGNI, 1-member org) (§3). |
| 6 | Version-bump SOP | **Fixed.** Added a coordinated-bump SOP; `cla-coverage` asserts the version string matches across the 6 repos so a partial bump goes red (§2). |
