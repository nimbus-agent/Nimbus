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
4. **Scope:** **all 7 public contribution repos** — `Nimbus`, `nimbus-sdk`,
   `nimbus-client`, `nimbus-vscode`, `nimbus-web-clipper`, `awesome-nimbus`,
   `nimbus-recipes`.

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
- All 7 repos' workflows point at this **same** store, so a contributor **signs
  once and is covered across every gated repo** (the store is shared, not
  per-repo).
- Versioning: the store path carries a version (`version1`). Bumping the CLA text
  materially bumps the version, which re-requires signatures — a deliberate,
  visible event, not silent.

### 3. The enforcement Action (`.github/workflows/cla.yml`, per repo)

Each of the 7 repos gets an identical workflow (SHA-pinned actions, per org
policy):

- **Triggers:** `issue_comment` (types: `created`) + `pull_request_target`
  (types: `opened`, `synchronize`, `reopened`). A contributor signs by commenting
  a fixed phrase (e.g. *"I have read the CLA Document and I hereby sign the
  CLA"*) on their PR.
- **Runs** `contributor-assistant/github-action@<SHA>` configured with: the
  shared store (`remote-repository-name: .github`, `branch: cla-signatures`,
  `path-to-signatures`), the ICLA URL (`path-to-document`), a custom PR comment
  that also links the **CCLA** path for corporate contributors, and an
  **allowlist** of org members + bots (`dependabot[bot]`, the release bot, the
  owner) so their PRs auto-pass and never block on a signature.
- **Security invariant (`pull_request_target`):** this trigger runs with the base
  repo's secrets **even on fork PRs**, so the workflow **must never check out or
  execute PR head code** — it reads only PR metadata and the comment body.
  Minimal `permissions:` (`contents: read`, `pull-requests: write`,
  `statuses: write`, `actions: write`) and pinned action SHAs. Writing to the
  signature store uses a separate scoped token, below — never the fork's code.
- **Token:** writing the signature file to the shared store needs
  `contents: write` on the `.github` repo. Supplied as a **GitHub App token
  scoped to `contents: write`** on that one repo (no PAT — consistent with the
  retiring-PATs stance). This may require an App permission/install step, like
  P6a's `members: read` grant.

### 4. The gate — two layers (per the program's "goes red on regression" rule)

1. **Runtime gate (the sub-program's definition of done):** the `CLA Assistant`
   status check is made a **required** check in each repo's ruleset. It is
   **red-proven**: a test PR from a **non-allowlisted** account shows the CLA
   check **red** until the account comments its signature, then **green** — a
   gate that has been observed red, not merely assumed.
2. **Coverage drift gate:** a new **`cla-coverage`** job in the existing
   `org-drift-sweep` asserts that each of the 7 gated repos has
   `.github/workflows/cla.yml` present. This makes "the CLA is wired in every
   gated repo" a checked, goes-red-on-regression property — so it cannot silently
   stop at one repo (the exact "controls stop where they were written" pattern
   the program exists to break). It reuses the P1/P6a `_gh-audit.ts` fail-soft /
   `--strict`-in-CI plumbing and the App token.

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
- **No PAT** — the store-write token is a scoped GitHub App token
  (`contents: write` on `.github` only).
- **SHA-pinned actions** — `contributor-assistant/github-action` and any others
  are pinned to a full 40-hex SHA; `audit:action-sha-pins` enforces it.
- **No signature data off-machine** — stored in-repo, in the org.

---

## Definition of done

1. `ICLA.md` + `CCLA.md` (broad relicensable grant) are checked into `.github`;
   `CONTRIBUTING.md` explains the flow + the one-way rule.
2. The shared signature store + the scoped App token exist; `cla.yml` is wired in
   all 7 repos; the `CLA Assistant` check is **required** in each repo's ruleset.
3. The runtime gate is **red-proven** on a test PR (red unsigned → green signed).
4. The `cla-coverage` sweep gate is green and would go **red** if a repo's
   `cla.yml` regressed.
5. The roadmap records the CLA delivered + the CCLA-automation deferral.
