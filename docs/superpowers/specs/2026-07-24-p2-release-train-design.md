# P2 — Release Train Design

A sub-program of the [infrastructure roadmap](../../infrastructure-roadmap.md),
next in the sequence after P1 (Org CI Foundation) and P6 (Access &
Contribution). P1 made cross-repo *config* drift a gated property; P6 did the
same for *access* and *contribution licensing*. P2 makes **release propagation**
one too: a version that publishes but fails to reach a downstream distribution
point should make a machine-checkable gate go red.

---

## The pattern this breaks

The infrastructure roadmap's founding observation is *controls stop where they
were written*. The release pipeline is the sharpest instance. One Nimbus release
fans out to five downstream landing points — winget (a PR against
`microsoft/winget-pkgs`), homebrew-tap, scoop-bucket, the apt/yum linux-repo, and
(for the satellite packages) npm — and **every one is fire-and-forget off a
`workflow_run` trigger**. Nothing checks, afterward, that the published version
actually *arrived*. When a publish step silently fails or a release phantoms, the
channel simply freezes and no signal is emitted.

This is not hypothetical. It is the single most-documented operational pain in
the project's memory:

- **Phantom releases** — the "chore: release main" PR merges and bumps the
  manifest, but no tag / no assets are ever created. Six recorded instances;
  each silently blocked *every* downstream until a human ran the manual
  tag-and-relabel dance.
- **Frozen package managers** — winget/scoop/brew froze at `0.16.0` for three
  releases (`v0.17`–`v0.19`) because each release's build chain failed on a
  different transient flake, leaving an asset-less GitHub Release that the
  package-manager publishers had nothing to submit.

The auto-reconcile step now in `release-please.yml` self-heals the phantom case
*when it works* — but it has its own failure modes (App `issues:write`,
tag-mismatch skip), and when it silently fails to complete, nothing notices.
There is no independent observer of the property "the latest built release has
reached every place it should."

## Operating principle (inherited)

A sub-program is **done** when its gate is green in CI and would go **red** if
the property regressed — not when its code merges. P2's gate is
`audit:release-staleness`: it must go red on a phantom release or on any channel
that lags the latest built release past a grace window, proven by a
red-before/green-after fixture (as P1's `ruleset-drift` and P6a's two gates
were).

---

## Decisions taken (this brainstorm)

1. **Unified staleness model, one spec, phased plan.** A single declarative
   *release-train manifest* models **both** propagation kinds — distribution
   *channels* and cross-repo *dependency* edges — and one gate reads each
   downstream's live version. The plan phases delivery: **Phase 1 = channel
   edges** (the proven pain; ships and goes green first); **Phase 2 = dep-DAG
   edges** added to the same manifest (plausible but unproven; de-risked by
   proving the mechanism on Phase 1 first).
2. **Enforcement = an independent scheduled sweep**, not an inline verify step.
   An inline step inside `release.yml` structurally cannot catch the worst case
   (the run that never produced assets — the step never executes). Only an
   independent check, keyed off nothing but the observable state of the release
   and the channels, catches the full class including phantom releases. This is
   also the roadmap's literal wording: a *staleness check*.
3. **Staleness semantics = grace window + "PR-opened counts" for winget.** A
   release becomes eligible for checking only once it is older than a grace
   window (default **6h** — covers the ~18–30 min build plus margin, so a
   just-merged release is never false-red). For our own repos (brew/scoop/linux)
   "caught up" = the repo's file shows the version. For winget — whose merge is on
   *Microsoft's* timeline and can take days — "caught up" = the version is merged
   **or** we *opened* a PR for it. Gating on Microsoft's merge would produce a
   red we cannot act on.
4. **Reader strategy = pure read-only observer** (no publish-workflow changes).
   The gate reads what is *actually serving users* — the live channel files —
   rather than a marker we write and hope lands. Zero changes to the four publish
   workflows (lower risk, faster to green), and the gate stays decoupled from the
   publishers.
5. **Placement = a new job in `org-drift-sweep.yml`**, so the property lands in
   the same green/red scheduled sweep the roadmap already frames as the program's
   gate. One dashboard, existing cron + `workflow_dispatch`, existing
   fail-soft-strict conventions.

---

## Architecture

### 1. The three heads

Every train has three version "heads" a healthy pipeline keeps equal:

```
intended            published                     distributed
(main claims)       (actually built)              (reached users)
────────────────    ──────────────────────        ───────────────────────────────
.release-please     latest stable vX.Y.Z          brew    Formula/nimbus.rb
-manifest.json      GitHub Release WITH            scoop   bucket/nimbus.json
  "." : 0.27.0      its SHA256SUMS asset           linux   apt Packages  Version:
                                                   winget  winget-pkgs dir / open PR
```

Two comparisons, each catching one documented failure:

- **intended > published** → *phantom release*. Eligible only once the
  manifest-bump commit is older than `graceHours` (so the build window is not
  flagged). This is the independent backstop for the `release-please.yml`
  auto-reconcile step: if reconcile silently failed, this goes red.
- **published > channel** → *frozen channel*. Eligible once the published
  Release is older than `graceHours`.

### 2. The manifest — `.github/release-train.json`

Checked in, matching the `.github/org-access.json` and
`.github/rulesets/*.json` precedent — one declarative place that lists every
propagation edge, so the edges are *declared* rather than scattered across
fire-and-forget publish workflows. That declaration *is* the fix for "controls
stop where they were written."

```jsonc
{
  "$comment": "Every propagation edge from a published artifact to its downstream distribution point. The release-staleness gate (scripts/structure-audit/check-release-staleness.ts) reads each downstream's LIVE version and fails when it lags the published source past graceHours. See docs/infrastructure-roadmap.md P2.",
  "graceHours": 6,
  "trains": [
    {
      "name": "nimbus-gateway",
      "source": {
        "manifestRepo": "nimbus-agent/Nimbus",
        "manifestFile": ".release-please-manifest.json",
        "manifestKey": ".",
        "releaseAsset": "SHA256SUMS"
      },
      "channels": [
        { "kind": "brew",   "repo": "nimbus-agent/homebrew-tap", "path": "Formula/nimbus.rb",  "pattern": "version \"([^\"]+)\"" },
        { "kind": "scoop",  "repo": "nimbus-agent/scoop-bucket", "path": "bucket/nimbus.json", "jsonKey": "version" },
        { "kind": "linux",  "repo": "nimbus-agent/linux-repo",   "path": "apt/dists/stable/main/binary-amd64/Packages", "pattern": "^Version: (.+)$" },
        { "kind": "winget", "package": "NimbusAgent.Nimbus", "wingetRepo": "microsoft/winget-pkgs" }
      ]
    }
  ]
}
```

Phase 1 = the `nimbus-gateway` train: **1 phantom edge + 4 channel edges = 5
checks.** A `source.releaseAsset` of `SHA256SUMS` is the definition of
"published": a Release counts only if that asset exists (an asset-less phantom
Release does not).

### 3. The gate — `scripts/structure-audit/check-release-staleness.ts`

Reuses `scripts/structure-audit/_gh-audit.ts` (`runGh` / `isStrict` /
`strictSkip` / `isRecord`). Split into **pure functions** (unit-testable, no
network) behind a thin gh-reading shell:

- `readPublished(train)` → the latest stable `vX.Y.Z` GitHub Release whose
  `releaseAsset` exists, plus its publish timestamp. (Stable = tag has no `-`,
  matching the publishers' own `!contains(head_branch, '-')` gate.)
- `readChannelVersion(channel)` → one version string per kind:
  - **brew / scoop** — `gh api …/contents/<path>` (base64-decode) → regex
    `pattern` (brew) or `JSON.parse` → `jsonKey` (scoop). Both are stable
    single-version files.
  - **linux** — reprepro emits `dists/stable/main/binary-amd64/Packages` **and**
    `Packages.gz`; the uncompressed file is not guaranteed to exist (some apt
    repos serve only the compressed list). The reader therefore reads whichever
    is present — preferring `Packages`, falling back to `Packages.gz` with an
    in-memory `Bun.gunzipSync` — then regexes the `Version:` control field.
    **Impl step verifies against the live `linux-repo` which files reprepro
    actually publishes**; if the pool layout proves more stable than the index,
    listing `pool/main/n/nimbus-headless/` (exactly one `.deb` after the
    workflow's `reprepro remove` + `includedeb`) and parsing the version from the
    filename is the fallback reader.
  - **winget** — caught-up iff the version dir
    `manifests/n/NimbusAgent/Nimbus/<published>/` exists in `winget-pkgs`
    **or** an open PR for that version exists. The PR check is an exact
    **title** search, not a branch (`head:`) filter — wingetcreate's branch name
    is not the package id, whereas its PR title is deterministic (`New version:
    NimbusAgent.Nimbus version <published>`):
    `gh pr list --repo microsoft/winget-pkgs --state open --search 'in:title
    NimbusAgent.Nimbus <published>' --json number`. Author-agnostic — robust to
    whichever account holds `WINGET_PAT`. This is the literal *"failed to open
    its downstream PR"* check. The 6h grace window absorbs GitHub's few-minutes
    search-index lag on a freshly-opened PR. **Benefit:** a winget PR that opened
    but was later *closed/rejected* by Microsoft's validation leaves neither a
    merged dir nor an open PR, so the gate correctly returns to **RED** — the
    stale state is re-surfaced, not lost.
- `compare(intended, published, channel, ages, graceHours)` → one of
  `ok | stale | phantom | indeterminate`. Pure semver + grace logic, no I/O.

**"Caught up" rules** (decision 3): brew/scoop/linux caught-up iff file-version ≥
published; winget caught-up iff merged-dir-exists OR open-PR-exists; the phantom
edge fires iff intended > published AND bump-commit age > `graceHours`; a channel
edge fires iff published > channel AND release age > `graceHours`.

Version comparison is **semver-aware** (not string equality): a channel ahead of
`published` — e.g. a hotfix landed directly on a channel — is *not* stale.

**Time is UTC epoch-ms throughout.** GitHub timestamps are `Z`-suffixed ISO-8601
(`2026-07-24T18:53:46Z`); the age math is `Date.now() - new Date(ts).getTime()`,
which is timezone-agnostic (both sides are UTC epoch ms). The reader never parses
a timestamp lacking an explicit `Z`/offset (which JS would treat as local time),
so a developer machine's clock offset cannot skew the grace-window decision.
(This is a plain audit script, not a Workflow script, so `Date.now()` is
available.)

### 4. Auth — none needed

Every source read is **public**: homebrew-tap, scoop-bucket, and the linux-repo
Pages repo are public (users `brew tap` / `scoop bucket add` / add the apt
source), `winget-pkgs` is public, and the Nimbus release list + manifest are
public. So — unlike the P6a admin-scoped gates — this gate needs **no App
token**: `github.token` in CI, the developer's `gh` locally. It therefore also
runs in local `preflight` for anyone authenticated (fail-soft when not).

### 5. Workflow wiring

- A new job **`release-staleness`** in `.github/workflows/org-drift-sweep.yml`,
  reusing the workflow's existing `schedule` + `workflow_dispatch` triggers. No
  App-token mint step (public reads). Runs `bun run audit:release-staleness
  --strict`.
- `package.json` script alias **`audit:release-staleness`** →
  `bun scripts/structure-audit/check-release-staleness.ts`.
- Registered in `scripts/lib/preflight-gates.ts` alongside the other drift gates
  (fail-soft locally, so an unauthenticated contributor is never blocked; the
  drift-manifest test that would otherwise fail on an unregistered CI gate stays
  green).

---

## Error handling — the false-red trap

A single channel read failing must **not** read as *stale*. The gate
distinguishes:

- **404** (channel file genuinely absent) → a real regression → **RED**.
- **non-404** (transient 5xx / network) → **indeterminate**, not stale — the
  `team-reachability` and CLA-coverage lesson.
- **403 rate-limit** (`X-RateLimit-Remaining: 0` / secondary-limit) →
  **indeterminate**, never stale. All reads go through `gh`, which authenticates
  with the ambient token (`GH_TOKEN` / `GITHUB_TOKEN` locally, `github.token` in
  CI) — so the request quota is the authenticated 5000/hr, not the unauthenticated
  60/hr, and one run's handful of reads plus one `winget-pkgs` search sits far
  under it. A 403 is therefore rare, but if it happens (e.g. a shared CI token
  near its ceiling) it must read as *indeterminate*, not as a stale channel.
- **version parse fails** (channel file format changed) → indeterminate + a loud
  `::warning::`; never silently "ok."
- **nothing readable at all** (no `gh`, no auth) → `strictSkip` (soft green
  locally, red under `--strict` / `GITHUB_ACTIONS`).

Today `runGh` collapses 404 and transient 5xx into a single `ok:false`, so it
cannot make the first distinction. **Phase 1 therefore includes a small
`_gh-audit.ts` enhancement**: surface the `gh` / HTTP status so a caller can
split a genuine 404 from a transient failure (5xx, network, or a 403
rate-limit). This *also closes the CLA-coverage
robustness follow-up already recorded in the roadmap* (that gate currently treats
any `gh` failure as "cla.yml absent"). One fix hardens two gates; the enhancement
is additive and preserves every existing caller's behavior.

---

## Testing

Per `nimbus-testing`, the pure functions carry table-driven unit tests:

- version parse per channel kind — brew regex, scoop json, linux `Version:`,
  winget dir-list + PR-search shapes;
- the semver + grace comparison — `ok` / `stale` / `phantom` boundary cases
  around `graceHours`;
- phantom detection (intended > published with an aged bump commit);
- the **404-vs-transient** branch of the enhanced `_gh-audit.ts`.

No live `gh` in unit tests — the gh-reading shell is injected as a fake reader
fed captured fixtures. `decideExit` mirrors the org-drift gates
(fail-soft-strict). **Live proof:** run the gate against the real channels once,
then red-prove by feeding a stale fixture (channel version pinned an older
release), confirming red-before / green-after.

> **Live-run heads-up.** At authoring time the manifest is `0.27.0` while the
> latest release is documented as `v0.26.0`. If no `v0.27.0` Release-with-assets
> exists and the bump commit is older than `graceHours`, the gate's **first real
> run will correctly go RED — a live phantom (a 7th instance)**. That is the gate
> working, not a bug. The implementation step will confirm the actual state:
> either it is genuinely stale (the gate earns its keep on day one) or `0.27.0`
> has published (green).

---

## Phase 2 — dependency-DAG edges (sketch, same engine)

Phase 2 adds `dep` edges to the same `trains[]` array; the engine does not
change, only a new reader kind:

- **source** = the npm `@latest` version of an upstream package
  (`@nimbus-dev/sdk`, `@nimbus-dev/client`).
- **downstreams** = consuming repos' `package.json` dependency on that package —
  `client ← sdk`; `cli` + `vscode ← client`.
- **reader** — reads the consumer's **lockfile** (`bun.lock` /
  `package-lock.json`), not just the `package.json` range. A range like `^1.2.0`
  *permits* a newer `1.3.0`, so stripping the caret and comparing `1.2.0` to a
  published `1.3.0` would false-flag a repo that would resolve to `1.3.0` on the
  next install. The lockfile carries the *resolved* version — the code that would
  actually ship — which is the honest "caught up" signal. Caught-up iff the
  resolved version ≥ published **or** an open bump PR referencing it exists. Same
  grace + indeterminate model.

**Open Phase-2 questions (deferred to its own spec pass):**
1. Whether the `source` for a dep edge is npm `@latest` (what consumers actually
   install) or the upstream repo's latest git release tag.
2. The exact lockfile parse per consumer (`bun.lock` is the Nimbus/vscode norm;
   confirm each satellite's lockfile format and that it is committed).

Neither affects the Phase 1 engine; both resolve when Phase 2 is specced.

---

## Out of scope

- **Fixing** propagation failures — P2 *detects* staleness; recovery stays the
  existing manual/auto-reconcile paths. (A future sub-program could auto-remediate.)
- **Release-build reliability** (flaky-flake hardening of `release.yml`) — a
  separate concern; P2 observes the outcome, it does not make the build more
  reliable.
- **Freshness of pinned action SHAs** — owned by P1's sha-pin audit; a "staleness
  vs unpinned" distinction already noted there.
- **Private repos** — all P2 sources are public; no Team-plan dependency.

---

## Definition of done

`audit:release-staleness` is green in the scheduled sweep and **would go red**
if any channel lags the latest built release past the grace window, or if a
release phantoms — proven by a red-before / green-after fixture, exactly as P1's
`ruleset-drift` and P6a's `org-settings-drift` / `team-reachability` were. Phase 1
closes when that gate is green end-to-end in a real `org-drift-sweep` run and the
`_gh-audit.ts` enhancement has hardened the CLA-coverage gate alongside.
