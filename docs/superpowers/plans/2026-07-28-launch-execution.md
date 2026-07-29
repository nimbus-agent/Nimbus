# Nimbus Launch Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Nimbus's first-run path provably work on machines the author does not own, then run a gated private alpha and a sequenced public launch.

**Architecture:** Four engineering tasks harden and instrument the quickstart path, followed by three human runbooks (the gates themselves). The engineering work extends existing infrastructure rather than adding new: `install-smoke.yml` gains real product assertions, a new audit script classifies connector verification evidence, and two documentation fixes close honesty gaps found during design review.

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, GitHub Actions, Biome, markdownlint-cli2.

**Source spec:** [`2026-07-28-launch-plan-design.md`](../specs/2026-07-28-launch-plan-design.md)
**Review response:** [`2026-07-28-launch-plan-design-review-response.md`](../specs/2026-07-28-launch-plan-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Never commit on `main`.** All work lands on `dev/asafgolombek/launch-plan` in the worktree `.claude/worktrees/launch-plan`.
- **Cross-platform paths.** Use `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **`docs/superpowers/**` is markdownlint-gated.** Validate with `bunx markdownlint-cli2 <files>` before committing.
- **Biome false-fails in worktrees.** `bun run lint` reports "0 files processed" and exits 1 inside `.claude/worktrees/`. Validate with `bunx biome check packages scripts` instead.
- **Honesty guardrails are load-bearing** (`docs/launch-messaging.md`): never describe the `why` hover UI as shipped; never describe the egress ledger as capturing raw network traffic — it records the agent's dispatched actions at the `I29` executor chokepoint.
- **No new product features before launch.** Tasks 1–4 are test, tooling, and documentation only. If a task appears to require a product change, stop and escalate rather than expanding scope.
- **CI budget is a live concern.** PRs #894/#897/#899 cut a push run from 105 to 69 jobs. Do not widen a 3-OS matrix onto every PR without the split described in Task 1.

---

## Task 1: Make `install-smoke` prove the product works, not just that files landed

`.github/workflows/install-smoke.yml` already runs a 3-OS matrix, stages real built binaries, and executes `install.sh` / `install.ps1` against a sandboxed `HOME` / `LOCALAPPDATA`. Its only product assertion is `nimbus --help`, which passes even when indexing is completely broken — this is exactly how #895 shipped.

**Files:**

- Modify: `.github/workflows/install-smoke.yml`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: a CI job named `<os> install smoke` that fails if `nimbus init` cannot index or `nimbus why` cannot resolve authorship. No other task depends on its output.

**Design note — CI cost.** Widening `paths:` to all gateway and CLI changes would add three 15-minute jobs to most PRs, undoing recent CI-latency work. The split below keeps PR cost at one job while preserving 3-OS coverage where it is affordable:

- `pull_request` touching gateway/CLI source → **Ubuntu only**.
- `pull_request` touching `scripts/install/**` or the release workflow → **all three OSes** (unchanged from today).
- `workflow_dispatch` → all three, so the branch can be proven before merge.

- [x] **Step 1: Add `workflow_dispatch` so the change can be proven on the branch**

A `pull_request`-only workflow cannot be triggered manually, so there is no way to verify the edit before merging. Add the trigger first.

In `.github/workflows/install-smoke.yml`, change the `on:` block to:

```yaml
on:
  workflow_dispatch:
  pull_request:
    paths:
      - "scripts/install/**"
      - "scripts/package-linux-installers.ts"
      - ".github/workflows/install-smoke.yml"
      - ".github/workflows/release.yml"
      - "packages/gateway/src/**"
      - "packages/cli/src/**"
```

- [x] **Step 2: Restrict the matrix on gateway/CLI-only PRs**

Replace the `strategy` block with one that collapses to Ubuntu unless an install-path or release file changed. Add this step before the matrix job, and gate the matrix on its output.

Add a new job above `smoke`:

```yaml
jobs:
  scope:
    name: Decide smoke matrix
    runs-on: ubuntu-24.04
    outputs:
      matrix: ${{ steps.pick.outputs.matrix }}
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 0

      - name: Pick matrix
        id: pick
        shell: bash
        env:
          EVENT_NAME: ${{ github.event_name }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          set -euo pipefail
          FULL='["ubuntu-24.04","macos-14","windows-2022"]'
          if [ "$EVENT_NAME" != "pull_request" ]; then
            echo "matrix=$FULL" >> "$GITHUB_OUTPUT"; exit 0
          fi
          # Use the SHAs from the PR payload rather than an `origin/<branch>`
          # tracking ref: actions/checkout does not reliably map remote branch
          # refs on a pull_request checkout, and `origin/main` can fail with
          # "ambiguous argument". Both SHAs are present because fetch-depth: 0.
          CHANGED=$(git diff --name-only "$BASE_SHA...$HEAD_SHA")
          if echo "$CHANGED" | grep -qE '^(scripts/install/|scripts/package-linux-installers\.ts|\.github/workflows/(install-smoke|release)\.yml)'; then
            echo "matrix=$FULL" >> "$GITHUB_OUTPUT"
          else
            echo 'matrix=["ubuntu-24.04"]' >> "$GITHUB_OUTPUT"
          fi
```

Values are passed through `env:` rather than interpolated directly into the
script body. GitHub expressions are substituted as raw text before `bash` runs,
so interpolating a ref name inline is a script-injection seam; the SHAs here are
hex and safe, but `env:` is the pattern this repo's Scorecard posture expects.

Then change the `smoke` job header to consume it:

```yaml
  smoke:
    name: ${{ matrix.os }} install smoke
    needs: scope
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        os: ${{ fromJSON(needs.scope.outputs.matrix) }}
```

Note the timeout rises from 15 to 20 minutes — indexing adds real work.

- [x] **Step 3: Fix the stale `--version` comment**

The workflow asserts in two comments that `nimbus --version` does not exist. It does — v1.4.1 prints `1.4.1`. Leaving the comment misleads the next author.

Replace both occurrences of:

```bash
          # Smoke: invoke a no-arg command that doesn't require a running Gateway.
          # `nimbus --version` does NOT exist; `--help` is in HELP_ALIASES (cli/index.ts).
          nimbus --help
```

and the Windows variant:

```powershell
          # Smoke: `--version` is NOT a valid nimbus flag; `--help` is in HELP_ALIASES.
          nimbus --help
```

with, respectively:

```bash
          # Smoke: both work without a running Gateway.
          nimbus --help
          nimbus --version
```

```powershell
          # Smoke: both work without a running Gateway.
          nimbus --help
          nimbus --version
```

- [x] **Step 4: Add the quickstart assertion (Unix)**

Insert this step immediately after the existing "Run install.sh + verify (Unix)" step, and before the uninstall assertions in that step. Extract the uninstall portion into its own step if it is currently inline, so the quickstart runs while the binaries are still installed.

```yaml
      - name: Quickstart smoke — init + why (Unix)
        if: runner.os != 'Windows'
        shell: bash
        run: |
          set -euo pipefail
          export HOME="$RUNNER_TEMP/fake-home"
          for rc in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
            if [ -f "$rc" ]; then . "$rc"; break; fi
          done

          REPO="$RUNNER_TEMP/demo-repo"
          mkdir -p "$REPO" && cd "$REPO"
          printf 'export function verifyToken(raw: string): boolean {\n  return raw.length > 0;\n}\n' > auth.ts
          git init -q
          git config user.email "smoke@example.com"
          git config user.name  "Smoke Test"
          git add -A && git commit -q -m "add auth helpers"

          nimbus init | tee "$RUNNER_TEMP/init.log"
          # `nimbus init` EXITS 0 even when indexing fails: syncAndPickDemo()
          # catches every error and degrades to null, by design, because the
          # config edit is the durable half of the work. So the exit code proves
          # nothing here and these string assertions are load-bearing.
          if grep -q "indexing did not complete" "$RUNNER_TEMP/init.log"; then
            echo "::error::nimbus init reported that indexing did not complete"; exit 1
          fi
          # Positive proof, and race-free: "Try it:" is printed ONLY when
          # index.demoSymbol returned a real symbol, which requires a populated
          # index. The generic "Next:" block is what an empty index produces.
          grep -q "Try it:" "$RUNNER_TEMP/init.log" || {
            echo "::error::nimbus init did not produce a demo symbol — index is empty"; exit 1; }

          # Regression guard for #895 specifically: this exact invocation
          # returned "Invalid serviceId" and exit 1 before the fix.
          nimbus connector sync filesystem
          nimbus why auth.ts:1 | tee "$RUNNER_TEMP/why.log"
          grep -q "## Authorship" "$RUNNER_TEMP/why.log" || {
            echo "::error::nimbus why produced no Authorship section"; exit 1; }
          grep -q "Smoke Test" "$RUNNER_TEMP/why.log" || {
            echo "::error::nimbus why did not resolve the commit author"; exit 1; }

          nimbus stop || true
```

- [x] **Step 5: Add the quickstart assertion (Windows)**

Insert the equivalent immediately after the existing "Run install.ps1 + verify (Windows)" step, before its uninstall assertions.

```yaml
      - name: Quickstart smoke — init + why (Windows)
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          $ErrorActionPreference = "Stop"
          $env:LOCALAPPDATA = Join-Path $env:RUNNER_TEMP "fake-localappdata"
          $userPath = [Environment]::GetEnvironmentVariable("PATH","User")
          $env:PATH = "$userPath;$env:PATH"

          $repo = Join-Path $env:RUNNER_TEMP "demo-repo"
          New-Item -ItemType Directory -Path $repo -Force | Out-Null
          Set-Location $repo
          "export function verifyToken(raw: string): boolean {`n  return raw.length > 0;`n}" |
            Set-Content -Path (Join-Path $repo "auth.ts") -Encoding utf8
          git init -q
          git config user.email "smoke@example.com"
          git config user.name  "Smoke Test"
          git add -A; git commit -q -m "add auth helpers"

          $init = nimbus init 2>&1 | Out-String
          Write-Host $init
          # `nimbus init` exits 0 even when indexing fails (syncAndPickDemo
          # degrades to null by design), so these string checks are the real
          # assertions — the exit code proves nothing.
          if ($init -match "indexing did not complete") {
            Write-Error "nimbus init reported that indexing did not complete"; exit 1
          }
          # Positive, race-free proof: "Try it:" appears only when
          # index.demoSymbol returned a real symbol from a populated index.
          if ($init -notmatch "Try it:") {
            Write-Error "nimbus init did not produce a demo symbol — index is empty"; exit 1
          }

          # Regression guard for #895: this exact call returned
          # "Invalid serviceId" and exit 1 before the fix.
          nimbus connector sync filesystem
          $why = nimbus why auth.ts:1 2>&1 | Out-String
          Write-Host $why
          if ($why -notmatch "## Authorship") {
            Write-Error "nimbus why produced no Authorship section"; exit 1
          }
          if ($why -notmatch "Smoke Test") {
            Write-Error "nimbus why did not resolve the commit author"; exit 1
          }

          nimbus stop
```

- [x] **Step 6: Validate the workflow file parses**

Run: `bunx --bun js-yaml .github/workflows/install-smoke.yml > /dev/null && echo "YAML OK"`
Expected: `YAML OK`. If `js-yaml` is unavailable, run `gh workflow view install-smoke --ref dev/asafgolombek/launch-plan` after pushing — a parse error surfaces there.

- [x] **Step 7: Commit and push, then prove it live**

A workflow edit cannot be verified locally. Push first, then dispatch.

```bash
git add .github/workflows/install-smoke.yml
git commit -m "ci(install-smoke): assert init+why, not just --help

The workflow's only product assertion was `nimbus --help`, which passes
even when indexing is entirely broken — that is how #895 shipped. Adds a
real quickstart run (init, connector sync, why) with author resolution
asserted, widens the trigger to gateway/CLI source, and collapses the
matrix to Ubuntu on source-only PRs so the CI budget is unchanged."
git push -u origin dev/asafgolombek/launch-plan
gh workflow run install-smoke --ref dev/asafgolombek/launch-plan
```

- [x] **Step 8: Confirm the run is green on all three OSes**

Run: `gh run list --workflow install-smoke --branch dev/asafgolombek/launch-plan --limit 1`
then `gh run watch <id>`.
Expected: three jobs (`ubuntu-24.04`, `macos-14`, `windows-2022`) all green.

**If macOS fails here, that is a real finding, not a flake** — macOS is the platform the spec flags as unverified. Capture the log and fix before proceeding; do not disable the job.

- [x] **Step 9: Red-prove the assertion**

A guard that never fails is not a guard. Temporarily break it to confirm it catches the #895 class of bug.

Locally, edit the Unix step's grep target from `"## Authorship"` to `"## ThisWillNeverAppear"`, push, dispatch, and confirm the job **fails**. Then revert:

```bash
git revert --no-edit HEAD   # or restore the correct string and amend
git push
```

Expected: the deliberately broken run fails with `nimbus why produced no Authorship section`; the reverted run is green.

---

## Task 2: Connector verification audit script

The spec calls for an inventory backing the "80+ services" claim. During planning, the "some connectors are stubs" premise was **disproved**: no `not implemented` markers exist anywhere in `packages/mcp-connectors/`, and the eleven 6-line `server.ts` files are the `runReadOnlyMcpConnector` helper pattern with real logic in a sibling `tools.ts`.

The honest risk is narrower and still real: there are 95 connector packages and 99 manifest entries, and almost none have been exercised against a live API. This script classifies what evidence exists so launch copy can cite a defensible number.

**Files:**

- Create: `scripts/audit/connector-verification.ts`
- Create: `scripts/audit/connector-verification.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `export type ConnectorTier = "tier1" | "implemented" | "unknown";`
  - `export type ConnectorEvidence = { readonly id: string; readonly hasTools: boolean; readonly hasTests: boolean; readonly makesOutboundCalls: boolean; readonly tier: ConnectorTier };`
  - `export function classifyConnector(input: { id: string; files: readonly string[]; sources: readonly string[] }): ConnectorEvidence;`
  - `export function summarize(rows: readonly ConnectorEvidence[]): { tier1: number; implemented: number; unknown: number; total: number };`

`classifyConnector` is pure — it takes already-read file names and file contents so it can be tested without touching disk. Disk access lives in the `import.meta.main` CLI block, mirroring `scripts/audit/package-readmes.ts`.

Tier definitions, which the script prints so the classification is never mistaken for live-API proof:

- `tier1` — registers MCP tools, makes outbound calls, and has at least one test file.
- `implemented` — registers MCP tools and makes outbound calls, but has no test.
- `unknown` — anything else.

- [x] **Step 1: Write the failing test**

Create `scripts/audit/connector-verification.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";

import {
  classifyConnector,
  summarize,
  type ConnectorEvidence,
} from "./connector-verification.ts";

describe("classifyConnector", () => {
  it("rates a connector with tools, outbound calls, and tests as tier1", () => {
    const row = classifyConnector({
      id: "github",
      files: ["server.ts", "server.test.ts"],
      sources: ["const r = await fetch(url); registerTool('gh_x', h);"],
    });
    expect(row.tier).toBe("tier1");
    expect(row.hasTools).toBe(true);
    expect(row.hasTests).toBe(true);
    expect(row.makesOutboundCalls).toBe(true);
  });

  it("rates an untested but working connector as implemented", () => {
    const row = classifyConnector({
      id: "bigeye",
      files: ["server.ts", "tools.ts"],
      sources: ["await fetchWithTimeout(url); reg.tool('bigeye_issues', h);"],
    });
    expect(row.tier).toBe("implemented");
    expect(row.hasTests).toBe(false);
  });

  it("counts a CLI-backed connector reached via the shared helper", () => {
    // Real shape: kubernetes/src/server.ts never calls fetch — it routes
    // through shared/run-cli-json.ts to shell out to kubectl.
    const row = classifyConnector({
      id: "kubernetes",
      files: ["server.ts"],
      sources: ["const out = await runCliJson(kubectlBase(), kubeEnv()); reg.tool('k8s', h);"],
    });
    expect(row.makesOutboundCalls).toBe(true);
    expect(row.tier).toBe("implemented");
  });

  it("counts a connector using the shared REST fetcher factory", () => {
    // Real shape: github/src/server.ts builds its client via makeRestFetcher.
    const row = classifyConnector({
      id: "github",
      files: ["server.ts"],
      sources: ["const f = makeRestFetcher({ apiBase: GH_API }); reg.tool('gh', h);"],
    });
    expect(row.makesOutboundCalls).toBe(true);
  });

  it("rates a connector with no tool registration as unknown", () => {
    const row = classifyConnector({
      id: "empty",
      files: ["server.ts"],
      sources: ["export const nothing = 1;"],
    });
    expect(row.tier).toBe("unknown");
  });

  it("summarizes counts by tier", () => {
    const rows: readonly ConnectorEvidence[] = [
      classifyConnector({ id: "a", files: ["server.test.ts"], sources: ["fetch(u); reg.tool('a', h)"] }),
      classifyConnector({ id: "b", files: [], sources: ["fetch(u); reg.tool('b', h)"] }),
      classifyConnector({ id: "c", files: [], sources: ["nothing"] }),
    ];
    expect(summarize(rows)).toEqual({ tier1: 1, implemented: 1, unknown: 1, total: 3 });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/audit/connector-verification.test.ts`
Expected: FAIL — `Cannot find module './connector-verification.ts'`.

- [x] **Step 3: Write the minimal implementation**

Create `scripts/audit/connector-verification.ts`:

```typescript
/**
 * Classify each first-party MCP connector by what evidence exists that it
 * actually works. This is a STATIC audit: it proves a connector registers
 * tools and issues outbound calls, NOT that any live API accepted them.
 * Launch copy must not describe `tier1` as "verified against the live API".
 */

export type ConnectorTier = "tier1" | "implemented" | "unknown";

export type ConnectorEvidence = {
  readonly id: string;
  readonly hasTools: boolean;
  readonly hasTests: boolean;
  readonly makesOutboundCalls: boolean;
  readonly tier: ConnectorTier;
};

export type ClassifyInput = {
  readonly id: string;
  /** File names within the connector's `src/` directory. */
  readonly files: readonly string[];
  /** Full text of every `.ts` source file in that directory. */
  readonly sources: readonly string[];
};

const TOOL_REGISTRATION = /\b(reg|registrar)\.tool\(|registerTool\(|register[A-Z]\w*Tools?\(/;

/**
 * Outbound-call detection — case-insensitive and helper-aware on purpose.
 *
 * Connectors here rarely call `fetch` directly; they route through
 * `mcp-connectors/shared/`: `fetchWithTimeout`, `fetchBearerJson` and
 * `makeRestFetcher` for HTTP, and `runCliJson` / `runCliOk` /
 * `runCliOkThrowing` for CLI-backed connectors (kubernetes shells out to
 * kubectl; aws, gcp, azure and iac do the same). Matching only `\bfetch(`
 * would file every CLI-backed connector as `unknown` and understate the
 * product — the exact false negative this audit exists to avoid.
 *
 * There are deliberately NO cloud-SDK patterns: `packages/mcp-connectors/`
 * has zero cloud-SDK runtime dependencies (verified 2026-07-28), and the
 * published SDK is dep-free by policy. Adding speculative SDK regexes would
 * only create false positives.
 */
const OUTBOUND_CALL = /fetch\w*\(|Bun\.spawn\(|execFile\(|spawnSync\(|runCli\w*\(/i;

export function classifyConnector(input: ClassifyInput): ConnectorEvidence {
  const blob = input.sources.join("\n");
  const hasTools = TOOL_REGISTRATION.test(blob);
  const makesOutboundCalls = OUTBOUND_CALL.test(blob);
  const hasTests = input.files.some((f) => f.endsWith(".test.ts"));

  let tier: ConnectorTier = "unknown";
  if (hasTools && makesOutboundCalls) {
    tier = hasTests ? "tier1" : "implemented";
  }

  return { id: input.id, hasTools, hasTests, makesOutboundCalls, tier };
}

export function summarize(rows: readonly ConnectorEvidence[]): {
  tier1: number;
  implemented: number;
  unknown: number;
  total: number;
} {
  return {
    tier1: rows.filter((r) => r.tier === "tier1").length,
    implemented: rows.filter((r) => r.tier === "implemented").length,
    unknown: rows.filter((r) => r.tier === "unknown").length,
    total: rows.length,
  };
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/audit/connector-verification.test.ts`
Expected: PASS, 6 tests.

- [x] **Step 5: Add the disk-reading CLI entry point**

Append to `scripts/audit/connector-verification.ts`:

```typescript
if (import.meta.main) {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const root = join(import.meta.dir, "..", "..", "packages", "mcp-connectors");
  const rows: ConnectorEvidence[] = [];

  for (const id of readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "shared")
    .map((e) => e.name)
    .sort()) {
    const srcDir = join(root, id, "src");
    if (!existsSync(srcDir)) {
      rows.push(classifyConnector({ id, files: [], sources: [] }));
      continue;
    }
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    const sources = files.map((f) => readFileSync(join(srcDir, f), "utf8"));
    rows.push(classifyConnector({ id, files, sources }));
  }

  const s = summarize(rows);
  console.log("# Connector verification audit\n");
  console.log("STATIC audit only — proves tool registration and outbound calls,");
  console.log("NOT that any live API accepted a request.\n");
  console.log(`| Connector | Tier | Tools | Outbound | Tests |`);
  console.log(`| --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    console.log(
      `| ${r.id} | ${r.tier} | ${r.hasTools ? "yes" : "no"} | ${r.makesOutboundCalls ? "yes" : "no"} | ${r.hasTests ? "yes" : "no"} |`,
    );
  }
  console.log(
    `\ntier1=${String(s.tier1)} implemented=${String(s.implemented)} unknown=${String(s.unknown)} total=${String(s.total)}`,
  );
}
```

- [x] **Step 6: Run it against the real tree and record the number**

Run: `bun run scripts/audit/connector-verification.ts | tail -20`
Expected: a table plus a final counts line. **Write the `tier1` and `total` numbers down** — they are the input to Task 3 and to the launch copy decision.

Investigate by hand any connector reported `unknown`; the regexes are heuristics and a false negative there would understate the product.

Check these six first — they were confirmed during planning to make **no direct
`fetch` call**, and are the most likely false negatives if the helper patterns
above are ever narrowed: `aws`, `azure`, `gcp`, `iac`, `kubernetes`, `obsidian`.
`kubernetes` is the known-good reference — it reaches `kubectl` through
`runCliJson`, so it must classify as `implemented` or better. If it comes back
`unknown`, the regex is wrong, not the connector.

- [x] **Step 7: Typecheck and lint**

Run: `bunx tsc --noEmit -p tsconfig.json` (or the repo's script if narrower)
Run: `bunx biome check scripts`
Expected: both clean. Remember `bun run lint` false-fails inside the worktree.

- [x] **Step 8: Commit**

```bash
git add scripts/audit/connector-verification.ts scripts/audit/connector-verification.test.ts
git commit -m "chore(audit): classify connectors by verification evidence

Backs the '80+ services' launch claim with a reproducible static audit.
Explicitly NOT a live-API check — the header and CLI output both say so,
because conflating the two is the overclaim the launch guardrails exist
to prevent."
```

---

## Task 3: State the telemetry position before someone asks

`docs/cli-reference.md` documents a default endpoint of `https://telemetry.nimbus-agent.dev/v1/collect`. A reader who finds that string without noticing `[telemetry] enabled = false` will conclude Nimbus phones home — on a project whose entire pitch is that it does not.

**Files:**

- Modify: `docs/launch-messaging.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: nothing.
- Produces: launch copy other tasks and the runbooks quote verbatim.

- [x] **Step 1: Add the telemetry position to the launch messaging sheet**

In `docs/launch-messaging.md`, add a new section immediately after "Honesty guardrails (do NOT claim)":

```markdown
## Pre-empt: the telemetry question

Nimbus ships an **opt-in, aggregate-only** telemetry collector that defaults to
`[telemetry] enabled = false`. `docs/cli-reference.md` documents a default
endpoint (`https://telemetry.nimbus-agent.dev/v1/collect`), so a reader who
greps for URLs will find one and may assume it is live.

State the position first, in these words:

> Telemetry is opt-in and off by default. Nothing is sent unless you set
> `[telemetry] enabled = true`. `nimbus telemetry show` prints exactly what
> would be sent; `nimbus telemetry disable` writes a local marker that stops
> the flush scheduler outright.

Do **not** say "Nimbus has no telemetry" — the collector exists, and being
caught in an absolute that is technically false costs more than the nuance.
```

- [x] **Step 2: Verify the claim is still true before publishing it**

Run: `grep -n "enabled" docs/cli-reference.md | grep -A2 -B2 telemetry`
Run: `grep -rn "cfg.enabled" packages/gateway/src/telemetry/flush-scheduler.ts`
Expected: the documented default is `false`, and the flush scheduler short-circuits on `!cfg.enabled`. If either has changed, fix the copy rather than the code.

- [x] **Step 3: Add a one-line privacy note to the README**

In `README.md`, in the "Three load-bearing words" section, append to the **local** bullet:

```markdown
Telemetry is opt-in and off by default (`[telemetry] enabled = false`).
```

- [x] **Step 4: Lint the docs**

Run: `bunx markdownlint-cli2 docs/launch-messaging.md README.md`
Expected: `0 error(s)`.

- [x] **Step 5: Commit**

```bash
git add docs/launch-messaging.md README.md
git commit -m "docs(launch): state the opt-in telemetry position up front

cli-reference documents a default collector endpoint. A reader who finds
that string without noticing enabled=false will conclude Nimbus phones
home. Says it plainly instead of answering it live during a launch."
```

---

## Task 4: Confirm `nimbus doctor` is safe to paste in public

Gate 2 tells alpha testers to paste `nimbus doctor` output into an issue. `doctor` prints the data directory and gateway-state path, which on a real machine contain the user's name and possibly employer-identifying repo paths. This must be checked before the instruction is given, not after.

**Files:**

- Modify: `packages/cli/src/commands/doctor-core.ts` (only if the check below finds a leak)
- Modify: `packages/cli/src/commands/doctor-core.test.ts` (only if the above changes)

**Interfaces:**

- Consumes: nothing.
- Produces: a documented verdict used by the Gate 2 runbook.

- [x] **Step 1: Capture real output in an isolated sandbox**

Never run this against the real config — use the isolation pattern proven in this session.

```bash
export SANDBOX="$(mktemp -d)"
export APPDATA="$SANDBOX/roaming" LOCALAPPDATA="$SANDBOX/local"
export NIMBUS_CONFIG_DIR="$SANDBOX/config"
export NIMBUS_GATEWAY_SOCKET="/tmp/nimbus-doctor-check.sock"
mkdir -p "$APPDATA" "$LOCALAPPDATA" "$NIMBUS_CONFIG_DIR"
nimbus doctor | tee "$SANDBOX/doctor.txt"
```

On Windows, set the same four variables in PowerShell and use `\\.\pipe\nimbus-doctor-check`.

`NIMBUS_CONFIG_DIR` is belt-and-braces, and the ordering matters: it moves the
**config dir only** — `platform/paths.ts` deliberately leaves `dataDir` on
`APPDATA`/`LOCALAPPDATA` so a test-isolation mistake cannot silently repoint a
live gateway's database. Setting `NIMBUS_CONFIG_DIR` alone is therefore *not*
isolation; the OS variables are the load-bearing ones.

- [x] **Step 2: Audit the captured output**

Read `$SANDBOX/doctor.txt` and answer, in writing:

- Does it print absolute paths containing a username?
- Does it print connector IDs that reveal an employer's tooling?
- Does it print any value sourced from the Vault?

The third is the only hard blocker — invariant 3 forbids credentials in any interface. The first two are judgement calls about what a tester is comfortable sharing.

- [x] **Step 3: Decide, and record the decision**

If **no Vault values appear and paths are the only concern**, no code change is needed. Record in the Gate 2 runbook: *"`nimbus doctor` output contains local filesystem paths; redact your username before pasting publicly, or send it directly."*

If **any Vault-sourced value appears**, stop. That is a security-invariant violation, not a launch task — escalate, file it, and fix it under the invariant triple rule (wiring + docs + test in one commit) before continuing.

- [x] **Step 4: Commit the runbook note**

Only if Step 3 produced a documentation change:

```bash
git add docs/superpowers/plans/2026-07-28-launch-execution.md
git commit -m "docs(launch): record doctor paste-safety verdict for Gate 2"
```

---

## Gate runbooks (human process, not code)

The three gates in the spec are human process. They are checklists, not tasks — an agent cannot complete them, and marking them done without doing them defeats the entire design.

### Gate 1 runbook — foreign-machine proof

**Two Gate 1 blockers are already known — CI found them before a human did.**
Task 1's assertions caught both on their first real run; `nimbus --help` had
been passing on machines where `nimbus init` cannot work at all.

- **[#925](https://github.com/nimbus-agent/Nimbus/issues/925) — Linux `init`
  fails on any headless machine.** Installing `secret-tool` is necessary but
  not sufficient: libsecret reaches a Secret Service provider over D-Bus, so
  with no session bus and no unlocked keyring every Vault operation fails and
  the Gateway aborts. That is the state of any server, container, SSH session,
  or WSL install — a large share of the ICP's machines. The README quickstart
  never named the prerequisite; that half is fixed. Note `nimbus doctor` shares
  the blind spot: it reports `[ok] Vault: secret-tool is on PATH` from a
  `Bun.which` check alone, so it says OK where the Vault cannot work.
- **[#928](https://github.com/nimbus-agent/Nimbus/issues/928) — first run
  blocks on a HuggingFace fetch.** The Gateway does not bind its socket until
  the embedding runtime initializes, which on a cold machine means downloading
  MiniLM (`DEFAULT_EMBEDDING_INIT_TIMEOUT_MS = 600_000`). The macOS runner sat
  at "starting embedding runtime" for a full 300 s without binding. For the
  first command a new user ever runs, this is indistinguishable from a hang.

Both are product-behaviour changes, deliberately **not** made under this plan's
freeze. Gate 1 cannot pass while either stands: they are exactly the
"works only on the author's machine" failures this gate exists to catch.

- [ ] Linux: clean `ubuntu:24.04` container, no Bun preinstalled. Run the README quickstart verbatim against a **cloned third-party repo**, not Nimbus. **Blocked by [#925](https://github.com/nimbus-agent/Nimbus/issues/925).**
- [ ] Windows: fresh local user account or a VM (Win 11 Home has neither Hyper-V nor Windows Sandbox). Same quickstart, same foreign repo.
- [ ] macOS: covered by Task 1's `macos-14` job, or defer to a Gate 2 tester with a Mac and label it unverified. **Caveat:** that job now sets `NIMBUS_SKIP_EMBEDDING_RUNTIME=1`, so it does **not** cover the cold first-run model fetch ([#928](https://github.com/nimbus-agent/Nimbus/issues/928)) — a human still has to run one genuinely cold macOS first-run.
- [ ] Every break gets a fix **and** a regression test at the real-gateway layer. A unit test with an injected fake does not count.
- [ ] **Exit:** Linux and Windows complete with zero manual intervention.

### Gate 2 runbook — private alpha

- [ ] Recruit 5–10 ICP engineers privately (network, ex-colleagues, zaalgol, communities you already belong to). Do **not** post publicly — that spends Gate 3's ammunition.
- [ ] Ask each for a 15-minute screenshare of their *first* run, or an async note: where did you stop, what did you expect, would you run it again next week.
- [ ] Point them at `nimbus doctor` as step one of troubleshooting, with the caveat from Task 4:

  > `nimbus doctor` output contains local filesystem paths; redact your username
  > before pasting publicly, or send it directly.

  **Verdict (Task 4, audited 2026-07-29 — safe to paste with that one caveat).**
  No Vault-sourced value can reach the output: `doctor` makes no `vault.*` call
  at all, and its only vault interaction is a `Bun.which("secret-tool")`
  presence check on Linux. The three gateway RPCs it does make are bounded —
  `gateway.ping` returns an uptime number, `config.validate` returns two fixed
  literal strings with no interpolated config content, and `diag.snapshot`
  yields an item count plus `connectorId`/`state` pairs.

  Two judgement-call disclosures remain, neither a blocker:

  - **Absolute paths containing the username** — `Data dir` and `Gateway state
    file` always print them (confirmed live: `C:\Users\<name>\...`), and a
    `[voice]` misconfiguration additionally echoes `piper_path` / `whisper_path`.
  - **Connector IDs** — when a gateway is running, the connector-health block
    lists every registered `connectorId`, which can reveal an employer's
    tooling. Testers on a work machine should skim that block before pasting.
- [ ] **Exit:** ≥5 reach `nimbus why` on their own repo unaided; ≥3 still using it 14 days after their own first run.
- [ ] If the exit criterion fails, fix the product. Do not proceed to Gate 3.

### Gate 3 runbook — public launch

- [ ] Confirm launch copy cites the Task 2 audit numbers, not "80+", unless the audit supports it.

  **Audit result (run 2026-07-29):** `tier1=4 implemented=85 unknown=5 total=94`.
  So **89 of 94 connectors register MCP tools and make outbound calls** — the
  "80+ services" claim is supported on the static evidence, provided it is
  never phrased as live-API verification (only 4 have any test at all).

  **Known tier-definition gap — decide before writing copy.** All 5 `unknown`
  connectors (`dataprofile`, `great-expectations`, `localdb`, `obsidian`,
  `storybook`) register tools but are pure local-filesystem readers, so
  `makesOutboundCalls` is legitimately `false` for them. They are implemented;
  the tier scheme just has no "local-only" bucket. Treat 89 as a floor, not a
  ceiling — the honest full count of implemented connectors is 94 of 94.
- [ ] Confirm the telemetry position from Task 3 is in the copy.
- [ ] Re-read `docs/launch-messaging.md` honesty guardrails immediately before posting.
- [ ] Fire channels in order, spaced out — MCP directories and `awesome-*` lists, then Lobsters and r/selfhosted, then r/devops and r/sre, then Show HN last.
- [ ] **Exit:** Show HN posted with the funnel already known-good.

---

## Self-review

**Spec coverage.** Gate 1's manual proof → Gate 1 runbook; its regression protection → Task 1. Gate 2's process → Gate 2 runbook; its diagnostics dependency → Task 4. Gate 3's sequencing → Gate 3 runbook; its connector-claim risk → Task 2; its telemetry-messaging risk → Task 3. The spec's measurement section needs no task — it lists signals to read, not systems to build.

**Placeholder scan.** No TBD/TODO. Every code step carries runnable content. Task 4's conditional file list is deliberate, not vague: the condition and both outcomes are stated explicitly in Step 3.

**Type consistency.** `ConnectorEvidence`, `ConnectorTier`, `ClassifyInput`, `classifyConnector`, and `summarize` are used identically in the test, the implementation, and the CLI block. `summarize`'s return shape matches the test's `toEqual` exactly.

**Known gap, stated rather than hidden.** Task 2 is a static audit. It cannot prove a live API accepted a request, and both the module header and its CLI output say so. Closing that gap for all 95 connectors would require credentials for 95 services and is out of scope for a launch.
