# P1 — Org CI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the propagation mechanism that carries a control past the repo it
was written in, and land the three carve-outs that are currently costing
something every day.

**Architecture:** Every gate follows the established `scripts/structure-audit/`
shape — a pure exported function taking a filesystem root or a plain object,
unit-tested against a temp fixture, plus an `if (import.meta.main)` CLI wrapper
registered in `package.json` and `scripts/lib/preflight-gates.ts`. Cross-repo
reach is achieved by checking other repos out in a scheduled workflow and
pointing the *same tested function* at them — no second parser, no API-shaped
duplicate of logic that already exists.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:test`, GitHub Actions,
`gh` CLI.

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict is
  non-negotiable.
- **Never commit on `main`** — this plan's work happens on
  `dev/asafgolombek/org-infrastructure-program` in the worktree at
  `.claude/worktrees/org-infra-program`. Read and Edit must use the **worktree
  absolute path**; a main-repo path silently edits main.
- **Cross-platform paths** — `path.join()` / `os.tmpdir()`, never hardcoded
  separators. `bun run audit:cross-platform` flags Windows-separator assertions.
- **Every new CI gate must be added to `scripts/lib/preflight-gates.ts`** or the
  manifest drift test fails.
- **Action refs are SHA-pinned** — every third-party `uses:` needs a full 40-hex
  SHA. The org rejects tag refs at run time, and `audit:action-sha-pins` will
  reject your own new workflow.
- **Conventional Commits** — release-please parses them. Use `ci:`, `docs:`,
  `feat:`, `fix:`, `test:`, `build:`.
- **Verify before claiming done** — run the command, read the output. `test:ci`
  is not the full gate set; `preflight` is.

## Scope

This plan covers **P1's Nimbus-repo foundation plus the three immediate
carve-outs**. It deliberately excludes the cross-repo reusable-workflow
consolidation (`_ci-npm-package.yml` / `_ci-extension.yml` in the org `.github`
repo, plus adoption in four satellites), which touches five repositories and
five PRs and is its own plan. Splitting here keeps this plan independently
shippable: everything below lands in the Nimbus repo except two `gh api`
operations and one licensing decision.

**Prerequisite for Plan B (the consolidation):** Task 4 and Task 5 below build
the org-wide sweep that will *prove* the consolidation worked. Doing them first
means the consolidation has a gate to land against instead of a hope.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `.github/workflows/ci.yml` (modify) | Split concurrency so `main` pushes stop cancelling each other |
| `docs/infrastructure-roadmap.md` (create) | The tracked sibling roadmap; owns "how it gets built, reviewed and shipped" |
| `scripts/structure-audit/check-doc-references.ts` (modify) | Register the new roadmap in `DOCS_FILES` |
| `scripts/structure-audit/check-action-sha-pins.ts` (modify) | Add `--root` so the tested function can be aimed at a checkout of another repo |
| `scripts/structure-audit/check-action-sha-pins.test.ts` (modify) | Cover `--root` argument parsing |
| `.github/workflows/org-drift-sweep.yml` (create) | Scheduled matrix that checks out each org repo and runs the sweep against it |
| `.github/rulesets/general-branch.json` (create) | Declarative desired ruleset shape — the source of truth |
| `scripts/structure-audit/check-ruleset-drift.ts` (create) | Pure diff of desired vs live ruleset; CLI wrapper fetches live via `gh` |
| `scripts/structure-audit/check-ruleset-drift.test.ts` (create) | Unit tests for the pure diff |
| `package.json` (modify) | Register `audit:ruleset-drift` |
| `scripts/lib/preflight-gates.ts` (modify) | Register the new gate so the manifest drift test passes |
| `docs/CONTRIBUTING.md` (modify) | DCO sign-off terms |
| `.github/workflows/dco.yml` (create) | Enforce `Signed-off-by` on PR commits |

---

### Task 1: Stop `main` CI from cancelling itself (P4a)

**Files:**

- Modify: `.github/workflows/ci.yml:10-12`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by later tasks. Independent; ship first.

**Why:** Of the last 40 `ci.yml` runs on `main`, 22 were cancelled. The
concurrency group is keyed on `${{ github.ref }}`, which is identical for every
push to `main`, so each merge kills the previous merge's validation. On
2026-07-21 three PRs merged twelve seconds apart and the only main-branch CI
failure in 40 runs sits on that batch.

- [ ] **Step 1: Read the current concurrency block**

Run: `sed -n '8,14p' .github/workflows/ci.yml`

Expected output:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

- [ ] **Step 2: Make cancellation conditional on event type**

Replace that block with:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  # Cancel superseded PR runs (cheap, the branch head moved), but NEVER cancel a
  # push to a protected branch: consecutive merges share this group key, so
  # `true` here means merge N+1 kills merge N's validation and the commit that
  # actually ships is never fully tested. Measured at 22 cancelled / 40 runs.
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

- [ ] **Step 3: Verify the YAML still parses and the pin gate is clean**

Run: `bun run audit:action-sha-pins`
Expected: `audit:action-sha-pins: OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: never cancel in-progress CI on main pushes

Concurrency was keyed on github.ref with cancel-in-progress: true, which is
correct for PR branches and wrong for main — every push to main shares one
group key, so each merge cancelled the previous merge's validation. 22 of the
last 40 main-branch ci.yml runs were cancelled, meaning the commit that ships
frequently has no completed CI behind it.

Cancellation is now conditional on the event being a pull_request."
```

- [ ] **Step 5: Confirm the fix on the next main push**

After this branch merges, run: `gh run list --workflow=ci.yml --branch main --limit 5 --json conclusion --jq '.[].conclusion'`
Expected: no `cancelled` entries appear for pushes that were not superseded by a
force-push. Record the observation — this is the gate for P4a.

---

### Task 2: Give `nimbus-client` branch protection

**Files:**

- No repo files. This is two `gh api` calls against `nimbus-agent/nimbus-client`.

**Interfaces:**

- Consumes: nothing.
- Produces: a live ruleset that Task 6's drift gate will later assert against.

**Why:** `nimbus-client` is the only active repo with **zero** rulesets, while
`nimbus-sdk`, `nimbus-vscode` and `nimbus-web-clipper` each have `General` +
`Protected release tags`. It is the narrow waist both `packages/cli` and the VS
Code extension consume.

- [ ] **Step 1: Confirm the gap is still real**

Run: `gh api repos/nimbus-agent/nimbus-client/rulesets --jq 'length'`
Expected: `0`

- [ ] **Step 2: Read the sibling repo's ruleset as the template**

Run: `gh api repos/nimbus-agent/nimbus-sdk/rulesets --jq '.[] | select(.name=="General") | .id'`

Then, with that id: `gh api repos/nimbus-agent/nimbus-sdk/rulesets/<id> > /tmp/sdk-general.json`

Read `/tmp/sdk-general.json`. `nimbus-sdk` is the closest analogue — same
language, same publish path, same `ci.yml` shape.

- [ ] **Step 3: Create the ruleset on `nimbus-client`**

This deliberately omits a `required_status_checks` rule. Required contexts are
per-repo job names, they are the most drift-prone part of a ruleset (a skipped
job never creates its context and the PR waits forever), and Task 6's declarative
shape does not cover them either. Protection first; required checks are a
follow-up once `nimbus-client`'s job names are stable under Plan B's
consolidation.

```bash
gh api --method POST repos/nimbus-agent/nimbus-client/rulesets \
  --input - <<'JSON'
{
  "name": "General",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 1, "actor_type": "OrganizationAdmin", "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["squash"],
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": true
      }
    }
  ]
}
JSON
```

**Note on the review settings:** zero required approvals and no code-owner review
mirror the rest of the org and are correct for a single-member org. They are the
solo-mode switches P6 flips; do not set them to contributor values now or you
will lock yourself out of your own repo.

- [ ] **Step 4: Verify it took effect**

Run: `gh api repos/nimbus-agent/nimbus-client/rulesets --jq '.[] | "\(.name) \(.enforcement)"'`
Expected: `General active`

- [ ] **Step 5: Record it**

No commit — this is remote state. Note the ruleset id; Task 6 needs it.

---

### Task 3: Create `docs/infrastructure-roadmap.md` and register it

**Files:**

- Create: `docs/infrastructure-roadmap.md`
- Modify: `scripts/structure-audit/check-doc-references.ts:78-94` (the
  `DOCS_FILES` array)

**Interfaces:**

- Consumes: nothing.
- Produces: the tracked doc that all later sub-programs update. `DOCS_FILES`
  grows from 15 to 16 entries, so the `audit:doc-refs` summary line changes from
  "across 15 docs" to "across 16 docs".

**Note:** Only `audit:doc-refs` needs the registration. `check-status-drift.ts`
watches four specific surfaces (`CLAUDE.md`, `GEMINI.md`,
`docs/architecture.md`, `docs/SECURITY-INVARIANTS.md`) for invariant-count and
version sync; a roadmap doc carrying neither does not belong in it. The design
spec overstated this as "register in both" — it is wrong and should be corrected
when the spec is next touched.

- [ ] **Step 1: Write the roadmap doc**

Create `docs/infrastructure-roadmap.md`:

```markdown
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
[`superpowers/specs/2026-07-23-org-infrastructure-program-design.md`](./superpowers/specs/2026-07-23-org-infrastructure-program-design.md).

| | Sub-program | Status | Gate |
| --- | --- | --- | --- |
| P1 | Org CI Foundation | 🔨 in progress | Org-wide SHA-pin + ruleset drift sweep goes red on any repo |
| P2 | Release Train | ⬜ not started | A publish that fails to open its downstream PR fails a staleness check |
| P3 | Review Layer | ⬜ not started | An invariant violation is caught in CI, not only in local `preflight` |
| P4a | Main-CI concurrency | ⬜ not started | Every commit on `main` has a completed CI run |
| P4b | Latency | ⬜ not started | Per-job wall-clock tracked; regressions visible |
| P5 | Org Legibility | ⬜ not started | `audit:secret-inventory` fails on any workflow secret missing from `ci-secrets.md` |
| P6 | Access & Contribution Model | ⬜ not started | Every repo reachable through a team; contributor-two switches live in checked-in config |

**Sequence:** P1 → P6 → P2 → P5 → P3 → P4b. Three items ignore the sequence and
land immediately: P4a, `nimbus-client` rulesets, and the DCO decision.

---

## How to update this document

- A sub-program is **done** when its gate is green in CI, not when its code
  merges.
- When a gate lands, record the command that runs it, so the claim is checkable.
- When this file and [`roadmap.md`](./roadmap.md) disagree about gateway
  capability, `roadmap.md` wins — fix this one.
```

- [ ] **Step 2: Register it in the doc-refs scanned set**

In `scripts/structure-audit/check-doc-references.ts`, add to the `DOCS_FILES`
array, after the `"docs/architecture.md"` entry:

```typescript
  "docs/infrastructure-roadmap.md",
```

- [ ] **Step 3: Verify the doc is now scanned and its links resolve**

Run: `bun run audit:doc-refs`
Expected: `Doc-reference check: <N> refs across 16 docs — all resolve.`

The **"16 docs"** is the proof the registration took. If it still says 15, the
array edit did not land.

- [ ] **Step 4: Red-prove the registration**

Temporarily add a broken link to `docs/infrastructure-roadmap.md`:

```markdown
[broken](./does-not-exist.md)
```

Run: `bun run audit:doc-refs`
Expected: **FAIL**, naming `docs/infrastructure-roadmap.md`.

This is the step that proves the gate actually covers the new file rather than
silently skipping it. Remove the broken link afterwards and re-run to confirm
green.

- [ ] **Step 5: Lint and link-check**

Run: `bun run lint:markdown`
Expected: `Summary: 0 error(s)`

Run: `~/.cargo/bin/lychee --config lychee.toml docs/infrastructure-roadmap.md`
Expected: `0 Errors`

- [ ] **Step 6: Commit**

```bash
git add docs/infrastructure-roadmap.md scripts/structure-audit/check-doc-references.ts
git commit -m "docs(infra): add infrastructure-roadmap.md as the third roadmap

Sibling to roadmap.md (what the gateway does) and ecosystem-roadmap.md (when
capability becomes reachable); this one owns how it gets built, reviewed and
shipped, with an explicit three-way precedence rule.

Registered in check-doc-references.ts DOCS_FILES so its links are gated
(15 -> 16 docs) rather than rotting silently."
```

---

### Task 4: Let the SHA-pin audit target any checkout

**Files:**

- Modify: `scripts/structure-audit/check-action-sha-pins.ts:74-82` (the
  `import.meta.main` block)
- Modify: `scripts/structure-audit/check-action-sha-pins.test.ts`

**Interfaces:**

- Consumes: the existing `auditActionShaPins(repoRoot: string): AuditResult`
  export — **unchanged**, do not alter its signature or logic.
- Produces: `parseRootArg(argv: string[]): string` (exported), and a CLI that
  accepts `--root <path>`. Task 5's workflow calls
  `bun scripts/structure-audit/check-action-sha-pins.ts --root ./target`.

**Why:** The pure function already accepts any directory. The only thing pinning
it to one repo is the CLI hardcoding `process.cwd()`. Adding a flag is a
four-line change that turns a repo-local gate into an org-wide one, and reuses
logic that is already tested rather than writing a second parser.

- [ ] **Step 1: Write the failing test**

Append to `scripts/structure-audit/check-action-sha-pins.test.ts`:

```typescript
import { parseRootArg } from "./check-action-sha-pins.ts";

describe("parseRootArg", () => {
  test("defaults to cwd when --root is absent", () => {
    expect(parseRootArg([])).toBe(process.cwd());
  });

  test("returns the path following --root", () => {
    expect(parseRootArg(["--root", "/tmp/other-repo"])).toBe("/tmp/other-repo");
  });

  test("throws when --root is passed with no value", () => {
    expect(() => parseRootArg(["--root"])).toThrow("--root requires a path");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test scripts/structure-audit/check-action-sha-pins.test.ts`
Expected: FAIL — `parseRootArg` is not exported from the module.

- [ ] **Step 3: Implement it**

In `scripts/structure-audit/check-action-sha-pins.ts`, add above the
`import.meta.main` block:

```typescript
/**
 * Resolves the repository root to audit. Defaults to the process cwd so the
 * local preflight gate is unchanged; `--root <path>` lets the org-wide sweep
 * aim the same audited logic at a checkout of another repository.
 */
export function parseRootArg(argv: string[]): string {
  const ix = argv.indexOf("--root");
  if (ix === -1) return process.cwd();
  const value = argv[ix + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--root requires a path");
  }
  return value;
}
```

Then change the CLI block to use it:

```typescript
if (import.meta.main) {
  const root = parseRootArg(process.argv.slice(2));
  const result = auditActionShaPins(root);
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:action-sha-pins: ${err}`);
    process.exit(1);
  }
  console.log("audit:action-sha-pins: OK");
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test scripts/structure-audit/check-action-sha-pins.test.ts`
Expected: PASS, all tests including the three new ones.

- [ ] **Step 5: Verify the default path is unchanged**

Run: `bun run audit:action-sha-pins`
Expected: `audit:action-sha-pins: OK` — identical to before. The local gate must
not have changed behaviour.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors. (`scripts/` is typechecked — a `string | undefined` leak
here will fail.)

- [ ] **Step 7: Commit**

```bash
git add scripts/structure-audit/check-action-sha-pins.ts scripts/structure-audit/check-action-sha-pins.test.ts
git commit -m "test(audit): let check-action-sha-pins target any checkout via --root

The pure auditActionShaPins() already accepts any directory; only the CLI
pinned it to process.cwd(). A --root flag turns a repo-local gate into one the
org-wide sweep can aim at a checkout of another repository, reusing tested
logic instead of adding a second parser."
```

---

### Task 5: Sweep every org repo for stale action pins

**Files:**

- Create: `.github/workflows/org-drift-sweep.yml`

**Interfaces:**

- Consumes: `parseRootArg` / the `--root` CLI from Task 4.
- Produces: a scheduled workflow named **`Org drift sweep`** with a job named
  `sha-pins (${{ matrix.repo }})`. P1's gate.

**Why:** `harden-runner` is `v2.20.0` in `nimbus-client`/`nimbus-sdk` and
`v2.19.4` in `nimbus-web-clipper`; `actions/checkout` is `v7.0.1` versus
`v7.0.0`. The gate that exists to catch exactly this runs against one repo.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/org-drift-sweep.yml`:

```yaml
name: Org drift sweep

on:
  schedule:
    # 07:00 UTC Mondays — early enough to act on during the week.
    - cron: "0 7 * * 1"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: org-drift-sweep
  cancel-in-progress: false

jobs:
  sha-pins:
    name: sha-pins (${{ matrix.repo }})
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        repo:
          - nimbus-client
          - nimbus-sdk
          - nimbus-vscode
          - nimbus-web-clipper
          - .github
          - linux-repo
          - homebrew-tap
          - scoop-bucket
    steps:
      - name: Checkout Nimbus (for the audit script)
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Checkout ${{ matrix.repo }}
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: nimbus-agent/${{ matrix.repo }}
          path: target
          persist-credentials: false

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: latest

      - name: Audit action pins in ${{ matrix.repo }}
        run: bun scripts/structure-audit/check-action-sha-pins.ts --root ./target
```

**Note:** no `bun install` is needed — the audit script imports only `node:fs`
and `node:path`.

- [ ] **Step 2: Verify the new workflow is itself SHA-pinned**

Run: `bun run audit:action-sha-pins`
Expected: `audit:action-sha-pins: OK`

If it fails naming `org-drift-sweep.yml`, the SHAs above are stale — resolve
current ones with
`gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.sha'` and pin
those.

- [ ] **Step 3: Commit and push the branch**

```bash
git add .github/workflows/org-drift-sweep.yml
git commit -m "ci: sweep every org repo for stale action pins

audit:action-sha-pins existed to catch drifted action refs and ran against one
repo, while harden-runner sat at v2.20.0 in client/sdk and v2.19.4 in
web-clipper. A scheduled matrix now checks each repo out and points the same
tested function at it via --root."
git push -u origin dev/asafgolombek/org-infrastructure-program
```

- [ ] **Step 4: Prove it live on the branch — do not skip this**

A bare `gh workflow run` executes `main`'s copy of the workflow and fakes a
pass. The branch **must** be pushed first (Step 3), then:

Run: `gh workflow run org-drift-sweep.yml --ref dev/asafgolombek/org-infrastructure-program`

Then: `gh run list --workflow=org-drift-sweep.yml --limit 1 --json databaseId,status --jq '.[0]'`

Wait for completion, then: `gh run view <databaseId> --json jobs --jq '.jobs[] | "\(.name) \(.conclusion)"'`

- [ ] **Step 5: Read the result — a failure here is the gate working**

Expected: `nimbus-web-clipper` **fails**, reporting `harden-runner` and
`actions/checkout` refs that are SHA-pinned but to older SHAs than the siblings.

**Important:** the audit checks that refs are *SHA-pinned*, not that they are the
*newest* SHA. If all eight jobs pass, the sweep is working correctly and the
version drift found in the diagnosis is a *staleness* problem the SHA gate does
not detect. Record which it is — that determines whether Plan B needs a separate
freshness check, and it is a real finding either way.

- [ ] **Step 6: Record the outcome in the roadmap**

Update the P1 row of `docs/infrastructure-roadmap.md` with the observed result
and the command that produced it. Commit:

```bash
git add docs/infrastructure-roadmap.md
git commit -m "docs(infra): record the first org drift sweep result"
```

---

### Task 6: Make rulesets declarative and drift-checked

**Files:**

- Create: `.github/rulesets/general-branch.json`
- Create: `scripts/structure-audit/check-ruleset-drift.ts`
- Create: `scripts/structure-audit/check-ruleset-drift.test.ts`
- Modify: `package.json` (the `audit:*` script block, near line 162)
- Modify: `scripts/lib/preflight-gates.ts` (the `fast` tier array)

**Interfaces:**

- Consumes: the live ruleset created in Task 2.
- Produces: `diffRuleset(desired: DesiredRuleset, live: unknown): AuditResult`
  and `DesiredRuleset`. P6 will add the contributor-two switches to the JSON
  file this task creates.

**Why:** Fixing `nimbus-client` by hand fixes one repo once. Checked-in config
plus a divergence check makes uniform protection a gated property — and gives P6
somewhere to write the contributor-two switches so the transition is one reviewed
diff instead of four remembered UI clicks.

- [ ] **Step 1: Write the desired-shape file**

Create `.github/rulesets/general-branch.json`:

```json
{
  "$comment": "Desired shape of the 'General' branch ruleset on every active org repo. audit:ruleset-drift diffs this against live config. P6 flips the contributor-two switches here — see docs/infrastructure-roadmap.md.",
  "repos": [
    "Nimbus",
    "nimbus-client",
    "nimbus-sdk",
    "nimbus-vscode",
    "nimbus-web-clipper"
  ],
  "name": "General",
  "target": "branch",
  "enforcement": "active",
  "pull_request": {
    "allowed_merge_methods": ["squash"],
    "dismiss_stale_reviews_on_push": true,
    "required_review_thread_resolution": true,
    "require_code_owner_review": false,
    "require_last_push_approval": false,
    "required_approving_review_count": 0
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `scripts/structure-audit/check-ruleset-drift.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { type DesiredRuleset, diffRuleset } from "./check-ruleset-drift.ts";

const DESIRED: DesiredRuleset = {
  repos: ["nimbus-client"],
  name: "General",
  target: "branch",
  enforcement: "active",
  pull_request: {
    allowed_merge_methods: ["squash"],
    dismiss_stale_reviews_on_push: true,
    required_review_thread_resolution: true,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
  },
};

function liveRuleset(overrides: Record<string, unknown> = {}) {
  return {
    name: "General",
    target: "branch",
    enforcement: "active",
    rules: [
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash"],
          dismiss_stale_reviews_on_push: true,
          required_review_thread_resolution: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          ...overrides,
        },
      },
    ],
  };
}

describe("diffRuleset", () => {
  test("passes when live matches desired", () => {
    const result = diffRuleset(DESIRED, liveRuleset());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a drifted pull_request parameter", () => {
    const result = diffRuleset(DESIRED, liveRuleset({ required_approving_review_count: 1 }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("required_approving_review_count");
    expect(result.errors[0]).toContain("expected 0");
    expect(result.errors[0]).toContain("got 1");
  });

  test("flags disabled enforcement", () => {
    const live = { ...liveRuleset(), enforcement: "disabled" };
    const result = diffRuleset(DESIRED, live);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("enforcement");
  });

  test("flags a missing ruleset entirely", () => {
    const result = diffRuleset(DESIRED, null);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("no 'General' ruleset");
  });

  test("flags a missing pull_request rule", () => {
    const result = diffRuleset(DESIRED, { name: "General", target: "branch", enforcement: "active", rules: [] });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("pull_request");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `bun test scripts/structure-audit/check-ruleset-drift.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the pure diff**

Create `scripts/structure-audit/check-ruleset-drift.ts`:

```typescript
#!/usr/bin/env bun

/**
 * audit:ruleset-drift — asserts each active org repo's live `General` branch
 * ruleset matches the declarative shape in `.github/rulesets/general-branch.json`.
 *
 * Manual UI configuration drifts: `nimbus-client` had zero rulesets while its
 * three sibling repos each had two. Checking the desired shape into the repo and
 * diffing it turns uniform protection from a one-time task into a gated property.
 *
 * The diff is pure and unit-tested; the CLI wrapper fetches live config via `gh`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

export interface DesiredRuleset {
  repos: string[];
  name: string;
  target: string;
  enforcement: string;
  pull_request: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality for the JSON-shaped values a ruleset parameter can hold. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffRuleset(desired: DesiredRuleset, live: unknown): AuditResult {
  const errors: string[] = [];

  if (!isRecord(live)) {
    return { ok: false, errors: [`no '${desired.name}' ruleset found (or it is not an object)`] };
  }

  for (const field of ["name", "target", "enforcement"] as const) {
    if (live[field] !== desired[field]) {
      errors.push(`${field}: expected ${String(desired[field])}, got ${String(live[field])}`);
    }
  }

  const rules = Array.isArray(live.rules) ? live.rules : [];
  const prRule = rules.find((r) => isRecord(r) && r.type === "pull_request");
  if (!isRecord(prRule)) {
    return { ok: false, errors: [...errors, "no pull_request rule present"] };
  }

  const params = isRecord(prRule.parameters) ? prRule.parameters : {};
  for (const [key, want] of Object.entries(desired.pull_request)) {
    const got = params[key];
    if (!sameValue(got, want)) {
      errors.push(
        `pull_request.${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

export function loadDesired(repoRoot: string): DesiredRuleset {
  const raw = readFileSync(join(repoRoot, ".github/rulesets/general-branch.json"), "utf8");
  return JSON.parse(raw) as DesiredRuleset;
}

if (import.meta.main) {
  const desired = loadDesired(process.cwd());
  const allErrors: string[] = [];

  for (const repo of desired.repos) {
    const proc = Bun.spawnSync([
      "gh",
      "api",
      `repos/nimbus-agent/${repo}/rulesets`,
      "--jq",
      `.[] | select(.name=="${desired.name}") | .id`,
    ]);
    const id = new TextDecoder().decode(proc.stdout).trim();
    if (id === "") {
      allErrors.push(`${repo}: no '${desired.name}' ruleset found`);
      continue;
    }
    const detail = Bun.spawnSync(["gh", "api", `repos/nimbus-agent/${repo}/rulesets/${id}`]);
    const live: unknown = JSON.parse(new TextDecoder().decode(detail.stdout));
    const result = diffRuleset(desired, live);
    for (const err of result.errors) allErrors.push(`${repo}: ${err}`);
  }

  if (allErrors.length > 0) {
    for (const err of allErrors) console.error(`audit:ruleset-drift: ${err}`);
    process.exit(1);
  }
  console.log(`audit:ruleset-drift: OK (${desired.repos.length} repos)`);
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test scripts/structure-audit/check-ruleset-drift.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Register the gate in `package.json`**

Add next to the other `audit:` entries:

```json
    "audit:ruleset-drift": "bun scripts/structure-audit/check-ruleset-drift.ts",
```

- [ ] **Step 7: Register it in the preflight manifest**

**This is mandatory** — `scripts/lib/preflight-gates.ts` has a drift test that
fails if a CI gate is missing from the manifest. Add to the `fast` tier array:

```typescript
  { name: "audit:ruleset-drift", cmd: ["bun", "run", "audit:ruleset-drift"], tier: "fast" },
```

- [ ] **Step 8: Run the gate live against the real org**

Run: `bun run audit:ruleset-drift`
Expected: `audit:ruleset-drift: OK (5 repos)` — Task 2 created the missing
`nimbus-client` ruleset, so this should now pass.

If it reports drift, that is a genuine finding: some repo's live config differs
from the declared shape. Read the diff and decide whether the *file* or the
*repo* is wrong before changing either.

- [ ] **Step 9: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: both clean. If `lint` reports 0 files in the worktree, validate with
`bunx biome check packages scripts` instead — that is a known worktree
false-negative.

- [ ] **Step 10: Commit**

```bash
git add .github/rulesets/general-branch.json scripts/structure-audit/check-ruleset-drift.ts scripts/structure-audit/check-ruleset-drift.test.ts package.json scripts/lib/preflight-gates.ts
git commit -m "feat(audit): check rulesets into code and gate their drift

nimbus-client had zero rulesets while its three siblings had two each — manual
UI config drifts. The desired General ruleset shape now lives in
.github/rulesets/general-branch.json and audit:ruleset-drift diffs it against
live config for all five active code repos.

The diff is pure and unit-tested; only the CLI wrapper touches the network.
P6 writes the contributor-two switches into this file, so that transition
becomes one reviewed diff instead of four remembered UI clicks."
```

---

### Task 7: Adopt DCO for inbound contributions

> **SUPERSEDED (2026-07-24).** Open decision 6 was resolved in favour of a **CLA**,
> not a DCO — a CLA preserves relicensing optionality for a possible future
> commercial dual-licensing of the AGPL-3.0 core. This task (the `Signed-off-by`
> DCO + `dco.yml` check) is **replaced, not amended**, per its own note below. P1
> ships with Tasks 1–6 only; the CLA is a separate sub-effort tracked under **P6
> (Access & Contribution Model)** in `docs/infrastructure-roadmap.md`. The DCO
> steps below are retained for the record — **do not implement them.**

**Files:**

- Modify: `docs/CONTRIBUTING.md`
- Create: `.github/workflows/dco.yml`

**Interfaces:**

- Consumes: nothing.
- Produces: a required-able check named `DCO`.

> **BLOCKED ON A DECISION — do not start without an answer.** Open decision 6 in
> the design spec: **DCO or CLA?** This task implements **DCO**, the
> recommendation. If a CLA is chosen instead — which preserves relicensing
> optionality for any future commercial dual-licensing — this task is replaced,
> not amended. Ask before implementing.

**Why:** `docs/CONTRIBUTING.md` contains no sign-off or CLA terms and the repo is
public, so the first outside PR can arrive any day. Retroactive sign-off
collection is far worse than prospective. The AGPL-3.0 core / MIT SDK split
sharpens it: a contributor patching the MIT `nimbus-sdk` with work derived from
reading the AGPL gateway breaks the one-way rule that architecture currently
enforces but nothing a contributor agrees to.

- [ ] **Step 1: Add the sign-off section to `docs/CONTRIBUTING.md`**

Append:

````markdown
## Developer Certificate of Origin (DCO)

Every commit must carry a `Signed-off-by` line certifying you wrote the patch or
otherwise have the right to submit it under the repository's license. See
[developercertificate.org](https://developercertificate.org/).

```text
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it automatically. The `DCO` check enforces this on every
pull request.

**Why this project cares more than most.** Nimbus is dual-licensed: the gateway,
CLI and connectors are AGPL-3.0, while `@nimbus-dev/sdk` and
`@nimbus-dev/client` are MIT. Code may flow **MIT → AGPL** but never the
reverse. If you contribute to the MIT packages, your patch must not be derived
from AGPL-licensed parts of this repository. If you are unsure which side of the
line your change sits on, ask in the pull request before pushing.
````

- [ ] **Step 2: Add the enforcement workflow**

Create `.github/workflows/dco.yml`:

```yaml
name: DCO

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

concurrency:
  group: dco-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: DCO
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Verify every commit is signed off
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          set -euo pipefail
          missing=0
          while read -r sha; do
            [ -z "$sha" ] && continue
            author="$(git show -s --format='%an <%ae>' "$sha")"
            if ! git show -s --format='%B' "$sha" | grep -qiF "Signed-off-by: $author"; then
              echo "::error::commit $sha is missing 'Signed-off-by: $author'"
              missing=1
            fi
          done < <(git rev-list "$BASE_SHA".."$HEAD_SHA")
          if [ "$missing" -ne 0 ]; then
            echo "Add sign-off with: git commit --amend -s   (or: git rebase --signoff $BASE_SHA)"
            exit 1
          fi
          echo "DCO: all commits signed off"
```

- [ ] **Step 3: Verify pins and markdown**

Run: `bun run audit:action-sha-pins && bun run lint:markdown`
Expected: both clean.

- [ ] **Step 4: Red-prove the check**

Push a commit **without** `-s` to the branch, then confirm the `DCO` job fails
naming that SHA. Then amend with `git commit --amend -s`, force-push, and confirm
it passes.

A gate that has never been observed red is not a gate. This step is the proof.

- [ ] **Step 5: Commit**

```bash
git add docs/CONTRIBUTING.md .github/workflows/dco.yml
git commit -s -m "feat(ci): require DCO sign-off on contributions

CONTRIBUTING.md carried no sign-off or CLA terms while the repo is public, so
the first outside PR could arrive with no record of the contributor's right to
submit. The AGPL-core / MIT-SDK split sharpens it: a patch to the MIT packages
derived from AGPL code breaks the one-way rule that architecture enforces but
nothing a contributor agreed to."
```

---

## Verification

Before opening the PR, run the full local gate set — `test:ci` is **not** it:

- [ ] `bun run preflight:fast` — all fast-tier gates including the two new ones
- [ ] `bun test scripts/structure-audit/` — the new and modified audit tests
- [ ] `bun run lint:markdown` — expect `0 error(s)`
- [ ] `bun run audit:doc-refs` — expect **16 docs**
- [ ] `~/.cargo/bin/lychee --config lychee.toml docs/*.md docs/superpowers/**/*.md` —
      match CI's link total for the whole branch, not just edited files. A
      pre-existing broken link elsewhere still fails your PR.
- [ ] `bun run audit:ruleset-drift` — expect `OK (5 repos)`
- [ ] Confirm the `Org drift sweep` run on the branch completed (Task 5 Step 4)

**Known worktree caveats:** full `preflight` is unusable in a worktree; `bun run
lint` may report 0 files — use `bunx biome check packages scripts`. If anything
touches coverage, `audit:coverage-floor` is Linux-authoritative and must be run
under Docker `oven/bun:latest`, not native Windows.

---

## Deferred to Plan B

The cross-repo reusable-workflow consolidation: `_ci-npm-package.yml` and
`_ci-extension.yml` in the org `.github` repo, plus adoption PRs in
`nimbus-sdk`, `nimbus-client`, `nimbus-vscode` and `nimbus-web-clipper`. Five
repos, five PRs, and a dev loop with its own trap — a caller pointed at
`@dev-branch` for testing must be flipped back to `@main` before merge, or
production CI is pinned to a branch.

Task 5's sweep is the gate that consolidation lands against, which is why it
comes first.
