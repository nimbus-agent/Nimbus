# P5 + P3 infrastructure batch — four gates and a review config

**Status:** design approved 2026-07-26, implementation in progress.
**Sub-programs:** [P5 Org Legibility](../../infrastructure-roadmap.md#p5-progress-log)
and [P3 Review Layer](../../infrastructure-roadmap.md#sub-programs).
**Program design of record:** `2026-07-23-org-infrastructure-program-design.md`
(archived; read via `git show 06c6a144:docs/superpowers/specs/...`).

## Why these four together

Four independent efforts, batched into one spec because they were commissioned
together and share the program's operating principle — *a sub-program is done
when its gate is green in CI and would go red if the property regressed*. They
do **not** share code, and each ships as its own PR:

| Effort | Sub-program | Gate kind | PR |
| --- | --- | --- | --- |
| `audit:secret-inventory` | P5 | local, every PR | 1 |
| `audit:actions-allowlist` | P5 | network, scheduled sweep | 1 |
| SHA-pin freshness | P1 follow-up | network, scheduled sweep | 3 |
| Nimbus `.coderabbit.yaml` | P3 | advisory review config | 2 |

### Two corrections to the roadmap's stated scope

Both were established by reading the code rather than the doc, and both change
what is worth building.

**P3's stated gate is already met.** The roadmap's P3 row reads "An invariant
violation is caught in CI, not only in local `preflight`". It already is:
`.github/workflows/_structure.yml` runs `bun run audit:invariants`, and all
seventeen static checks execute there. The single branch excluded by
`--binary-only` is `db-run`, which is a **census** — it writes
`db-run-census.json` and always exits 0. Excluding a non-gate from CI is
correct, not a gap.

The real P3 content is the program design's own **Correction 1**: all four
satellite repos carry a tuned `.coderabbit.yaml`; the `Nimbus` monorepo does
not. That is instance 2 of the named pattern, running satellites → monorepo.

**One P5 item is already done.** The `secret-health` permission-superset fix
(a probe must request the superset of what its consumers request, or a revoked
permission is undetectable) landed in #837. Only the general rule needs
recording; no code is owed.

---

## Effort 1 — `audit:secret-inventory`

**Property:** every secret a workflow in this repo consumes is documented in
`docs/ci-secrets.md`.

**Why it matters here specifically.** Row 3 of the roadmap's opening table names
`ci-secrets.md`'s completeness claim as a control that stopped where it was
written — the doc did not cover `secret-health.yml`'s *own* credentials. That
drift is still present today, along with four more:

| Undocumented secret | Introduced by |
| --- | --- |
| `SECRET_AUDITOR_CLIENT_ID` | the secret-health probe itself |
| `SECRET_AUDITOR_PRIVATE_KEY` | the secret-health probe itself |
| `CLA_BOT_CLIENT_ID` | the CLA program |
| `CLA_BOT_PRIVATE_KEY` | the CLA program |
| `BENCHER_API_KEY` | the benchmark workflow |

### Direction: one-way, deliberately

The gate asserts **workflow → doc**, never the reverse. `ci-secrets.md` is an
**org-wide** inventory: it documents `VSCE_PAT`, `OVSX_PAT` and `NPM_TOKEN`,
which are consumed by workflows in `nimbus-vscode` and the npm repos, not here.
A bidirectional check would red on nine entries that are correct, and the fix
for that noise would be to *delete true information from the inventory* — the
opposite of the goal.

The reverse direction is still worth surfacing, so undocumented-elsewhere
entries are printed as an informational census line, never as a finding.

### Exclusions

`GITHUB_TOKEN` only. It is GitHub-provided, never configured by an operator, and
so cannot be missing from an inventory of things an operator must provision.
Anything else absent from the doc is a finding — a narrow exclusion list is the
point, since every past instance of this pattern hid inside a plausible-looking
exemption.

### Shape

Pure function over already-read text, mirroring `check-release-staleness.ts`:

- `collectWorkflowSecrets(files: {path, text}[]): Map<string, string[]>` — every
  `secrets.NAME` reference, mapped to the workflows naming it. Matches both
  `secrets.NAME` and `secrets['NAME']`.
- `documentedSecrets(doc: string): Set<string>` — every backtick-quoted
  `UPPER_SNAKE` token in `ci-secrets.md`. Deliberately loose: the doc's shape is
  prose plus a table, and a parser tied to the table would break the moment
  someone documents a secret in a paragraph.
- `evaluateInventory(used, documented, exclusions): Finding[]`.

**This gate is local and runs on every PR**, unlike the sweep gates — it reads
only checked-in files, needs no token, and is deterministic. It therefore joins
the `fast` tier of `scripts/lib/preflight-gates.ts`.

**Consequence that shapes the PR:** a local gate that ships red breaks every
subsequent PR. So unlike P2 — a scheduled sweep, where shipping red was correct
— this one must be **green at merge**. The five rows above are added to
`ci-secrets.md` in the same PR, and the red-before proof is captured in the PR
description rather than left in the tree.

---

## Effort 2 — `audit:actions-allowlist`

**Property:** for every org repo whose `allowed_actions` is `selected`, every
action a workflow `uses:` is permitted to run.

**Why:** this is the gate that would have caught the two-day CLA outage on day
zero. `Nimbus` is the only repo with a restricted allowlist, and
`contributor-assistant/github-action` was absent from `patterns_allowed`, so
GitHub rejected the workflow before any job started — 23 consecutive
`startup_failure` runs, a required check that never reported, and every PR
silently unmergeable. `cla-coverage` was green throughout, because it verifies a
control's *presence*, not its *ability to execute*.

### Reads

Both are public-shaped but need auth for org repos, so they reuse `runGh`:

- `repos/{owner}/{repo}/actions/permissions` → `{enabled, allowed_actions}`
- `repos/{owner}/{repo}/actions/permissions/selected-actions` →
  `{github_owned_allowed, verified_allowed, patterns_allowed}`

A repo whose `allowed_actions` is not `selected` is skipped — nothing to
violate.

### Coverage rules

An action reference `owner/repo@ref` (or `owner/repo/path@ref`) is covered when:

1. `github_owned_allowed` and the owner is `actions` or `github`; or
2. any entry of `patterns_allowed` matches. Supported forms, per GitHub's
   documented syntax: exact `owner/repo`, `owner/repo@ref`, `owner/*`, and a
   trailing `*` wildcard.

Local `./...` and Docker `docker://...` references are not subject to the
allowlist and are ignored.

**`verified_allowed` is the honest hard case.** Whether an action's creator is a
verified GitHub partner is not derivable from the repo's own API response. When
`verified_allowed` is true and a reference is not otherwise covered, the verdict
is **`indeterminate`, never a finding** — the same fail-closed-toward-silence
rule the rest of the program uses for anything unreadable. Reporting it as a
violation would produce false reds on legitimately-permitted verified actions;
reporting it as covered would reintroduce the blind spot. Saying "cannot tell"
is the only honest option, and under `--strict` a run that could evaluate
nothing is red anyway.

### Verdicts

`ok` / `not-permitted` (a finding) / `indeterminate`. Reuses `classifyReadFailure`
and the `--strict` / `strictSkip` contract from `_gh-audit.ts`; runs as a new
job on `org-drift-sweep`.

**Expected on arrival: green.** The allowlist was repaired on 2026-07-26, so
this gate cannot red-prove against production. It is therefore red-proved by
**unit test** — a fixture repo whose workflow uses an unpermitted action — and
the live run is the green-after half of the evidence.

---

## Effort 3 — SHA-pin freshness

**Property:** a SHA-pinned action is not merely pinned, but pinned to something
current.

**The gap this closes.** `audit:action-sha-pins` proves every `uses:` is a
40-hex SHA rather than a moving tag. It is *structurally* unable to notice that
the SHA is two years old: an ancient pin and a fresh pin are both equally
"pinned". P1's first sweep recorded exactly this — `harden-runner` v2.20.0 vs
v2.19.4 and `actions/checkout` v7.0.1 vs v7.0.0 across repos — and classified it
as staleness, not unpinning, with a freshness check deferred as "Plan B".

### Approach

For each distinct pinned action, resolve the pin against the action repo's
releases:

1. `repos/{owner}/{repo}/releases/latest` → the current release tag.
2. `repos/{owner}/{repo}/git/ref/tags/{tag}` → that tag's SHA (dereferencing an
   annotated tag object to its commit).
3. Compare against the pinned SHA. Equal → `ok`.

When they differ, the pin is behind. **Behind is not automatically a finding**:
a release published an hour ago must not red the org, for the same reason P2
grace-windows a fresh npm publish. The release's own `published_at` age is
compared against a grace window, and only a pin behind a release older than the
window is reported.

**Grace window: 30 days**, not P2's 6 hours. These are different failure classes.
A release-train edge is an automated pipeline that should propagate within
minutes, so hours of lag is a defect. An action pin is updated by a human or by
Dependabot, and a 6-hour window would mean a permanently red sweep that everyone
learns to ignore — which is worse than no gate. Thirty days says "this pin has
been stale across a full release cycle and nobody noticed", which is the
condition actually worth alerting on.

Verdicts: `ok` / `stale` / `indeterminate` (unreadable, no releases, or a tag
that cannot be dereferenced). Runs in the sweep alongside the existing pin
audit; the existing gate is untouched.

---

## Effort 4 — Nimbus `.coderabbit.yaml`

**Property:** the monorepo's automated reviewer knows the monorepo's rules.

**Why this is P3's whole first step.** There are no human reviewers: of the last
80 merged PRs org-wide, 61 were the owner, 18 the release bot, 1 Dependabot.
"Improve PR review" therefore means improving *automated* review of AI-assisted
PRs. The four satellites each carry a tuned config; `Nimbus` — the repo with 30
security invariants — gets stock review. The config is advisory by design:
CodeRabbit is not a required check and must not become one, so a false positive
costs a comment, never a blocked merge.

### Content

Modelled on `nimbus-client`'s config (`profile: chill`,
`request_changes_workflow: false`, `auto_review` on `main`, drafts excluded),
with `path_instructions` scoped to what actually differs per area:

- `packages/gateway/src/engine/**` — the HITL gate is structural (I2/I3/I4): the
  consent gate lives in the executor, keys off `action.type` only, and
  `hitlStatus` is set nowhere else.
- `packages/gateway/src/**` — no `any` (`unknown` + a guard); never import
  `platform/{win32,darwin,linux}` from business logic (PAL rule); Vault-only
  credentials, never in logs/IPC/config.
- `packages/gateway/src/ipc/**` — HTTP writes go through `WRITE_ROUTE_ALLOWLIST`
  (I13); anything renderer-reachable is an `ALLOWED_METHODS` decision (I7).
- `packages/gateway/src/**/*.test.ts` and `security-invariants.test.ts` — the
  triple rule: a new structural defense lands with wiring **and** docs **and** a
  test in the same commit.
- `scripts/structure-audit/**` — gates fail soft locally and hard under
  `--strict`; an unreadable input degrades to indeterminate, never to a finding.
- `packages/mcp-connectors/**` — connectors depend only on `@nimbus-dev/sdk`;
  the engine never calls cloud APIs directly.

`path_filters` exclude `dist/**`, `**/node_modules/**` and generated assets so
review attention lands on source.

**Verification is necessarily weaker than a gate**, and this spec should not
pretend otherwise. The config's effect is observable only as review comments on
a subsequent PR. What *is* checkable now — and is all that will be claimed — is
that the YAML parses, that its schema matches the four working satellite
configs, and that every invariant id it cites exists in
`docs/SECURITY-INVARIANTS.md`. A drift gate asserting all five repos carry a
config is a reasonable P5 follow-up, and is explicitly **not** in this batch.

---

## Testing

Each gate follows the established pattern: table-driven unit tests over pure
functions, no network, in `scripts/structure-audit/<name>.test.ts`.

- **secret-inventory** — reference found in `secrets.X` and `secrets['X']`
  forms; `GITHUB_TOKEN` excluded; a documented secret passes; an undocumented
  one is a finding naming the workflow; the reverse-direction census never
  produces a finding; the committed pair (`.github/workflows/**` +
  `docs/ci-secrets.md`) is clean.
- **actions-allowlist** — `owner/*`, exact, `@ref` and trailing-`*` patterns;
  `github_owned_allowed` covering `actions/checkout`; local `./` and
  `docker://` ignored; an unpermitted action is a finding; `verified_allowed`
  with an uncovered reference is `indeterminate`; a non-`selected` repo is
  skipped.
- **sha-pin freshness** — equal SHAs are `ok`; a differing SHA past grace is
  `stale`; differing but within grace is `ok`; an unreadable release, a repo
  with no releases, and an underivable tag SHA are each `indeterminate`.
- **coderabbit config** — parses as YAML; carries the same top-level keys as the
  satellite configs; every `I<n>` it names exists in `docs/SECURITY-INVARIANTS.md`.

## Out of scope

- **Fixing** anything the allowlist or freshness gates find. Both detect;
  remediation is a separate, reviewed change — and for the allowlist, a repo
  settings `PUT` that only the org owner can run (the endpoint is a full
  replace, so a careless write silently unpermits Trivy/CodeQL/gitleaks).
- **A CodeRabbit-config drift gate** across the five repos — a P5 follow-up.
- **Dependabot configuration** for action updates. The freshness gate reports;
  deciding to automate the bumps is a separate call.
- **The `awesome-nimbus` App-installation fix** and **`VSCE_PAT` rotation** —
  org-owner actions, tracked in the roadmap, not buildable here.
