# Nimbus Distribution Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Nimbus findable and contributable-to — narrow the public pitch to one provable command, close the contributor on-ramp's real defects, and finish the stalled discovery-surface work.

**Architecture:** Seven tasks, all copy, tooling, documentation or process — no product change. One is a genuine TDD engineering task (a CI gate closing a registry-drift hole); one is a decision task with two concrete branches; the rest are documentation and copy passes gated by the repository's existing audit scripts. Human outreach work is out of scope for this plan and is listed at the end as runbooks.

**Tech Stack:** Bun 1.2+, TypeScript strict, Biome, markdownlint-cli2, GitHub Actions.

**Spec:** [`2026-08-19-nimbus-distribution-program-design.md`](../specs/2026-08-19-nimbus-distribution-program-design.md)
**Review response:** [`2026-08-19-nimbus-distribution-program-design-review-response.md`](../specs/2026-08-19-nimbus-distribution-program-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **No new product features.** This plan is test, tooling, documentation and copy only. If a task appears to need a product change, stop and escalate rather than expanding scope.
- **Never commit on `main`.** All work lands on `dev/asafgolombek/distribution-program` in the worktree `.claude/worktrees/distribution-program`. Verify with `git rev-parse --abbrev-ref HEAD` before the first commit.
- **Cross-platform paths.** Use `path.join()` / `os.tmpdir()`, never hardcoded separators. `bun run audit:cross-platform` flags Windows-separator assertions.
- **`docs/**` is markdownlint-gated.** Validate with `bunx markdownlint-cli2 <files>` before committing. Trailing whitespace fails (MD009); every fenced block needs a language (MD040); every URL must be a real link, not bare (MD034); internal link fragments must resolve (MD051).
- **Biome false-fails in worktrees.** `bun run lint` reports "0 files processed" and exits 1 inside `.claude/worktrees/`. Validate with `bunx biome check packages scripts` instead.
- **Honesty guardrails are load-bearing** (`docs/launch-messaging.md`): never describe the `why` hover UI as shipped; never describe the egress ledger as capturing raw network traffic — it records the agent's dispatched actions at the `I29` executor chokepoint; never claim "Nimbus has no telemetry" (state the opt-in, default-off position instead); never put a connector count into launch copy that `scripts/audit/connector-verification.ts` does not support.
- **Commit messages are discarded on merge.** The PR title and description become the squash commit. Put the conventional-commit type in the PR title.

---

## Task 1: Correct the `@nimbus-dev/mcp` "published" claim

`CLAUDE.md` and `GEMINI.md` both describe `packages/mcp-launcher` as "the published `@nimbus-dev/mcp` npm launcher". The package is not on npm (`npm view @nimbus-dev/mcp version` returns E404, while `@nimbus-dev/sdk` and `@nimbus-dev/client` both resolve). This is the same class of false claim the launch guardrails exist to prevent, sitting in the two most-read context files in the repository.

`audit:status-drift` will not catch this — it matches only the `I<N>` and `V<N>` ceiling phrasings. The fix is a manual edit, verified by grep.

**Files:**

- Modify: `CLAUDE.md` (the `packages/mcp-launcher` bullet under "Subsystems (monorepo)")
- Modify: `GEMINI.md` (the mirrored bullet)

**Interfaces:**

- Consumes: nothing.
- Produces: nothing other tasks depend on. Task 7 may reverse this edit if it publishes the package.

- [ ] **Step 1: Confirm the package is still unpublished**

Run:

```bash
npm view @nimbus-dev/mcp version; npm view @nimbus-dev/sdk version
```

Expected: the first errors with `E404`, the second prints a version. If the first now prints a version, **stop** — the claim became true and this task is obsolete; skip to Task 2.

- [ ] **Step 2: Edit both files**

In `CLAUDE.md`, replace the launcher bullet:

```markdown
- `packages/mcp-launcher` — the `@nimbus-dev/mcp` npm launcher (`nimbus-mcp` bin) that resolves and execs the local gateway MCP server. **Not yet published to npm** — publishing it is what unblocks the official MCP Registry listing (see `docs/superpowers/specs/2026-08-19-nimbus-distribution-program-design.md`).
```

Apply the identical replacement in `GEMINI.md`, which mirrors this section.

- [ ] **Step 3: Verify no "published" claim survives**

Run:

```bash
grep -n "published .@nimbus-dev/mcp\|the published \`@nimbus-dev/mcp\`" CLAUDE.md GEMINI.md
```

Expected: no output (exit 1 from grep is the success case here).

- [ ] **Step 4: Verify both files still pass their gates**

Run:

```bash
bunx markdownlint-cli2 CLAUDE.md GEMINI.md && bun run audit:doc-refs && bun run audit:status-drift
```

Expected: all three pass.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md GEMINI.md
git commit -m "docs: stop describing @nimbus-dev/mcp as published"
```

---

## Task 2: Gate connector-registry drift

`scripts/gen-bundled-connector-registry.ts` scans `packages/mcp-connectors/` for directories containing `src/server.ts` and **writes a committed file**, `packages/gateway/src/connectors/bundled-connector-registry.ts`. Nothing regenerates-and-diffs it in CI, so a connector added without rerunning `bun run gen:connector-registry` leaves a stale registry and no gate fires.

`test:connector-boot` cannot catch this: it boots every connector *the registry ships*, so one missing **from** the registry is precisely the case it cannot see.

The check reuses the generator's own exported `bundledConnectorIds()` rather than re-implementing the scan, so the two cannot disagree about what counts as a connector. It parses ids out of the committed file by their **import path**, not their object key, because Biome's formatter strips unnecessary quotes from keys (`"monte-carlo"` keeps them, `airflow` does not) and a key-based regex would have to duplicate that policy.

This does **not** go in `check-nimbus-invariants.ts`: that file is the static complement to the numbered *security* invariants (I1, the vault-key allow-list, D10, D12–D22), and registration drift is not one. It goes beside the two connector audits that already exist.

**Files:**

- Create: `scripts/structure-audit/check-connector-registry-drift.ts`
- Create: `scripts/structure-audit/check-connector-registry-drift.test.ts`
- Modify: `package.json` (add the `audit:connector-registry-drift` script beside `audit:connector-deps` on line ~169)
- Modify: `scripts/lib/preflight-gates.ts` (add a gate entry beside `audit:connector-deps`)
- Modify: `.github/workflows/_test-suite.yml` (add a step beside the "Connector dependency allowlist" step, ~line 135)

**Interfaces:**

- Consumes: `bundledConnectorIds(dir?: string): string[]` — already exported from `scripts/gen-bundled-connector-registry.ts`.
- Produces: `checkConnectorRegistryDrift(connectorsDir?: string, registryFile?: string): RegistryDriftViolation[]`, where `RegistryDriftViolation` is `{ readonly connector: string; readonly reason: string }`. No later task consumes it.

- [ ] **Step 1: Write the failing test**

Create `scripts/structure-audit/check-connector-registry-drift.test.ts`:

```typescript
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConnectorRegistryDrift } from "./check-connector-registry-drift.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-registry-drift-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function connector(name: string): void {
  mkdirSync(join(ROOT, "connectors", name, "src"), { recursive: true });
  writeFileSync(join(ROOT, "connectors", name, "src", "server.ts"), "export {};\n");
}

function registry(ids: readonly string[]): string {
  const path = join(ROOT, `registry-${ids.join("-") || "empty"}.ts`);
  const entries = ids
    .map((id) => `  ${JSON.stringify(id)}: () => import("../../../mcp-connectors/${id}/src/server.ts"),`)
    .join("\n");
  writeFileSync(path, `export const BUNDLED_CONNECTORS = {\n${entries}\n};\n`);
  return path;
}

connector("airflow");
connector("monte-carlo");

const CONNECTORS = join(ROOT, "connectors");

describe("checkConnectorRegistryDrift", () => {
  test("passes when the registry lists exactly the connectors on disk", () => {
    expect(checkConnectorRegistryDrift(CONNECTORS, registry(["airflow", "monte-carlo"]))).toEqual([]);
  });

  test("flags a connector on disk that the registry omits", () => {
    const v = checkConnectorRegistryDrift(CONNECTORS, registry(["airflow"]));
    expect(v.map((e) => e.connector)).toEqual(["monte-carlo"]);
    expect(v[0]?.reason).toContain("gen:connector-registry");
  });

  test("flags a registry entry with no connector on disk", () => {
    const v = checkConnectorRegistryDrift(CONNECTORS, registry(["airflow", "monte-carlo", "ghost"]));
    expect(v.map((e) => e.connector)).toEqual(["ghost"]);
    expect(v[0]?.reason).toContain("no longer exists");
  });

  test("reads ids from the import path, not the object key", () => {
    // Biome strips unnecessary quotes from keys, so an unquoted key must still be found.
    const path = join(ROOT, "registry-unquoted.ts");
    writeFileSync(
      path,
      `export const BUNDLED_CONNECTORS = {\n  airflow: () => import("../../../mcp-connectors/airflow/src/server.ts"),\n  "monte-carlo": () => import("../../../mcp-connectors/monte-carlo/src/server.ts"),\n};\n`,
    );
    expect(checkConnectorRegistryDrift(CONNECTORS, path)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test scripts/structure-audit/check-connector-registry-drift.test.ts
```

Expected: FAIL — the module `./check-connector-registry-drift.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `scripts/structure-audit/check-connector-registry-drift.ts`:

```typescript
#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bundledConnectorIds } from "../gen-bundled-connector-registry.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const CONNECTORS_DIR = join(REPO_ROOT, "packages", "mcp-connectors");
export const REGISTRY_FILE = join(
  REPO_ROOT,
  "packages",
  "gateway",
  "src",
  "connectors",
  "bundled-connector-registry.ts",
);

export interface RegistryDriftViolation {
  readonly connector: string;
  readonly reason: string;
}

// Matched on the import PATH rather than the object key: Biome's formatter strips unnecessary
// quotes from keys, so a key-based pattern would have to duplicate that policy and would rot the
// next time the formatter's rules change. The path is always a quoted string literal.
//
// No platform normalization is needed and none should be added: the separators here are
// literal characters in the generator's template string, not the output of any path API, and
// the interpolated id is a readdirSync entry NAME, which never contains a separator. The
// generated file is byte-identical on Windows, macOS and Linux.
const ENTRY_RE = /import\("\.\.\/\.\.\/\.\.\/mcp-connectors\/([^"/]+)\/src\/server\.ts"\)/g;

export function registryIds(registryFile: string): string[] {
  if (!existsSync(registryFile)) return [];
  const src = readFileSync(registryFile, "utf8");
  return [...src.matchAll(ENTRY_RE)].map((m) => m[1] as string).sort((a, b) => a.localeCompare(b));
}

/**
 * The bundled connector registry is GENERATED into a committed file. Nothing else diffs it, and
 * `test:connector-boot` structurally cannot: it boots the connectors the registry ships, so one
 * missing FROM the registry is invisible to it. A stale registry means a connector that exists in
 * the tree, passes every other gate, and can never be started by the shipped binary.
 */
export function checkConnectorRegistryDrift(
  connectorsDir: string = CONNECTORS_DIR,
  registryFile: string = REGISTRY_FILE,
): RegistryDriftViolation[] {
  const onDisk = new Set(bundledConnectorIds(connectorsDir));
  const listed = new Set(registryIds(registryFile));
  const out: RegistryDriftViolation[] = [];

  for (const id of [...onDisk].sort((a, b) => a.localeCompare(b))) {
    if (listed.has(id)) continue;
    out.push({
      connector: id,
      reason:
        "exists in packages/mcp-connectors/ but is absent from the bundled registry: the shipped " +
        "binary can never start it. Run `bun run gen:connector-registry` and commit the result",
    });
  }
  for (const id of [...listed].sort((a, b) => a.localeCompare(b))) {
    if (onDisk.has(id)) continue;
    out.push({
      connector: id,
      reason:
        "is listed in the bundled registry but no longer exists on disk: the generated import " +
        "will fail to resolve. Run `bun run gen:connector-registry` and commit the result",
    });
  }
  return out;
}

if (import.meta.main) {
  const violations = checkConnectorRegistryDrift();
  for (const v of violations) {
    console.error(
      `::error file=packages/gateway/src/connectors/bundled-connector-registry.ts::${v.connector} ${v.reason}`,
    );
  }
  console.log(
    violations.length === 0
      ? "connector registry drift: ok"
      : `connector registry drift: ${violations.length} violation(s)`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bun test scripts/structure-audit/check-connector-registry-drift.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Red-prove the gate against the real tree**

A gate that cannot fail is worthless. Prove it fires on a real drift, then restore.

Run:

```bash
bun scripts/structure-audit/check-connector-registry-drift.ts
```

Expected: `connector registry drift: ok`, exit 0.

Now introduce real drift and confirm it is caught:

```bash
mkdir -p packages/mcp-connectors/zzz-drift-probe/src
echo 'export {};' > packages/mcp-connectors/zzz-drift-probe/src/server.ts
bun scripts/structure-audit/check-connector-registry-drift.ts; echo "exit=$?"
rm -rf packages/mcp-connectors/zzz-drift-probe
```

Expected: `1 violation(s)` naming `zzz-drift-probe`, `exit=1`. Confirm the directory is gone afterwards with `git status --porcelain packages/mcp-connectors`.

- [ ] **Step 6: Register the script**

In `package.json`, add immediately after the `"audit:connector-deps"` line:

```json
    "audit:connector-registry-drift": "bun scripts/structure-audit/check-connector-registry-drift.ts",
```

- [ ] **Step 7: Add the preflight gate**

In `scripts/lib/preflight-gates.ts`, add after the `audit:connector-deps` entry:

```typescript
  {
    // The bundled registry is GENERATED into a committed file and nothing else diffs it.
    // `test:connector-boot` cannot catch a connector missing FROM the registry — it boots what the
    // registry ships. A stale registry means a connector the shipped binary can never start.
    name: "audit:connector-registry-drift",
    cmd: ["bun", "run", "audit:connector-registry-drift"],
    tier: "fast",
  },
```

- [ ] **Step 8: Add the CI step**

In `.github/workflows/_test-suite.yml`, add after the "Connector dependency allowlist" step:

```yaml
      - name: Connector registry drift (generated file vs. tree)
        # The bundled registry is generated into a committed file. Nothing else diffs it, and
        # test:connector-boot cannot: it boots what the registry ships, so a connector missing
        # FROM the registry is invisible to it.
        run: bun run audit:connector-registry-drift
```

- [ ] **Step 9: Verify the manifest test and the workflow lint still pass**

Run:

```bash
bun test scripts/lib/preflight-gates.test.ts && bun run audit:workflow-lint && bunx biome check packages scripts
```

Expected: all pass. (`bun run lint` is the wrong command here — Biome false-fails inside `.claude/worktrees/`.)

- [ ] **Step 10: Commit**

```bash
git add scripts/structure-audit/check-connector-registry-drift.ts scripts/structure-audit/check-connector-registry-drift.test.ts scripts/lib/preflight-gates.ts .github/workflows/_test-suite.yml package.json
git commit -m "ci: gate bundled-connector-registry drift"
```

---

## Task 3: Verify and surface the connector scaffold

Two scaffolds exist and neither is reachable by someone who has not already installed Nimbus: `nimbus scaffold extension` (a registered CLI command — `packages/cli/src/commands/registry.ts` line 45, implemented in `scaffold.ts`) and the standalone public repo `create-nimbus-connector`. `docs/CONTRIBUTING.md` line 168 mentions only the first; `docs/README.md` mentions neither.

The open question the spec records is whether the scaffold emits **every** registration site a new connector must touch. This task answers it empirically rather than by reading, then documents the truth either way.

**Files:**

- Modify: `docs/CONTRIBUTING.md` (the "Adding a New MCP Connector" section, ~line 161)
- Modify: `docs/README.md` (the Contributing section)

**Interfaces:**

- Consumes: `audit:connector-registry-drift` from Task 2 — used as one of the checks the scaffolded connector must pass.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Scaffold a throwaway connector and record what it emits**

Run:

```bash
bun packages/cli/src/index.ts scaffold extension --name zzz-scaffold-probe --output packages/mcp-connectors/zzz-scaffold-probe
find packages/mcp-connectors/zzz-scaffold-probe -type f | sort
```

Record the file list. If the command fails or the subcommand name differs, read `packages/cli/src/commands/scaffold.ts` for the real surface and use that — do not guess.

- [ ] **Step 2: Run the gates against it and record which ones fail**

Run each and record pass/fail:

```bash
bun run audit:connector-registry-drift; echo "registry-drift=$?"
bun run audit:connector-entrypoints; echo "entrypoints=$?"
bun run audit:connector-deps; echo "deps=$?"
bun run typecheck; echo "typecheck=$?"
```

A failure here is the answer to the spec's open question: it names exactly which registration site the scaffold does not emit. Expect `registry-drift` to fail — the scaffold cannot have run the generator — which is correct behaviour, not a defect.

- [ ] **Step 3: Remove the probe**

```bash
rm -rf packages/mcp-connectors/zzz-scaffold-probe
git status --porcelain packages/mcp-connectors
```

Expected: no output. The probe must not reach a commit.

- [ ] **Step 4: Document the real procedure in CONTRIBUTING**

Rewrite the opening of "Adding a New MCP Connector" in `docs/CONTRIBUTING.md` to state which generator to use and the exact post-scaffold steps observed in Step 2. Use this shape, filling the numbered list with what Step 2 actually showed:

```markdown
## Adding a New MCP Connector

Two generators exist. Use the one that matches how you are working:

- **Inside this repo** (you have Nimbus checked out and built): `nimbus scaffold extension packages/mcp-connectors/your-service` — the id is a positional argument, not `--name`/`--output` flags, and it doubles as both the output directory and the `id` field written into the generated manifest.
- **Standalone** (you want a connector outside the monorepo): [`create-nimbus-connector`](https://github.com/nimbus-agent/create-nimbus-connector)

After scaffolding, these steps are **not** automatic and the gates will reject the PR without them:

1. `bun run gen:connector-registry` — registers the connector in the bundled registry. `bun run audit:connector-registry-drift` fails until you do, and the shipped binary cannot start an unregistered connector.
```

- [ ] **Step 5: Add the front-door pointer to the README**

In `docs/README.md`'s Contributing section, add:

```markdown
**Adding a connector is the easiest way in.** `nimbus scaffold extension packages/mcp-connectors/your-service` generates the package, or use [`create-nimbus-connector`](https://github.com/nimbus-agent/create-nimbus-connector) standalone. See [Contributing](./CONTRIBUTING.md#adding-a-new-mcp-connector).
```

- [ ] **Step 6: Verify the docs gates**

Run:

```bash
bunx markdownlint-cli2 docs/README.md docs/CONTRIBUTING.md && bun run audit:doc-refs && bun run audit:readme-cli
```

Expected: all pass. `audit:readme-cli` checks that CLI commands named in the README exist in the command registry — if it fails, the command name in Step 5 is wrong; fix the doc, not the audit.

- [ ] **Step 7: Commit**

```bash
git add docs/README.md docs/CONTRIBUTING.md
git commit -m "docs: make the connector scaffold discoverable and its follow-up steps explicit"
```

---

## Task 4: Close the two contributor frictions in CONTRIBUTING

The spec names two frictions that will cost contributors: a coverage ratchet a newcomer cannot reproduce locally, and response latency. Both are documentation, and the second is a public commitment.

The ratchet is `audit:coverage-floor` — **≥85% line and ≥80% branch per file**, two separate constants (`FLOOR_PCT` / `BRANCH_FLOOR_PCT` in `scripts/coverage-floor/baseline.ts`), and it is **CI-Linux-authoritative**: a Windows or macOS run produces false violations.

The Hacktoberfest policy also lands here, in its checkable form. `docs/CONTRIBUTING.md` currently says only "Open a discussion before starting any large PR" (line 52), which is advice and does not cover the unassigned-PR failure mode.

**Files:**

- Modify: `docs/CONTRIBUTING.md` (the "Find Something to Work On" section ~line 48, the "Before Opening a PR" section ~line 148, and the "Pull Request Process" section ~line 206)

**Interfaces:**

- Consumes: nothing.
- Produces: the published 72-hour commitment and the assignment rule, both of which the Hacktoberfest runbook depends on.

- [ ] **Step 1: Add the assignment rule to "Find Something to Work On"**

Append to that section in `docs/CONTRIBUTING.md`:

```markdown
- **Ask to be assigned before you start.** Comment on the issue and wait for it to be assigned to you. Pull requests from outside contributors are reviewed only for issues the author was assigned first — this keeps two people from building the same thing, and keeps the review queue honest during high-traffic periods.
```

- [ ] **Step 2: Document the coverage ratchet in "Before Opening a PR"**

Append to that section:

````markdown
### The per-file coverage floor

`audit:coverage-floor` enforces **≥85% line and ≥80% branch coverage on every non-exempt file**, including new ones. A new connector or script will be rejected by it unless its tests carry it over both floors.

It is **CI-Linux-authoritative** — running it on Windows or macOS produces false violations, so do not trust a local pass or panic at a local failure. Reproduce what CI sees with:

```bash
bun run verify:docker --full
```

If a file is genuinely untestable glue rather than logic, it can be excluded — but excluding is a reviewed decision, not a default. Say why in the PR description.
````

- [ ] **Step 3: Publish the response commitment in "Pull Request Process"**

Append to that section:

```markdown
### What to expect from the maintainer

**First response within 72 hours** on any new issue or pull request — a review, a question, or at minimum an acknowledgement that it is queued. Nimbus is maintained by one person, so a full review may take longer than the first response; if 72 hours pass with silence, a nudge on the thread is welcome and appropriate.

Write access follows contribution: the switches that move this repository from single-maintainer to two-maintainer mode are already written down in `.github/rulesets/general-branch.json` under `$contributor_two`.
```

- [ ] **Step 4: Verify the doc gates**

Run:

```bash
bunx markdownlint-cli2 docs/CONTRIBUTING.md && bun run audit:doc-refs
```

Expected: both pass. Note the nested fenced block in Step 2 — the outer block in this plan is illustrative; in `CONTRIBUTING.md` the `bash` fence must be a normal top-level fence with a language tag, or MD040/MD031 will fail.

- [ ] **Step 5: Commit**

```bash
git add docs/CONTRIBUTING.md
git commit -m "docs: state the coverage ratchet, the 72-hour response target and the assignment rule"
```

---

## Task 5: The wedge copy pass

Lead every public surface with `nimbus why <file>:<line>` — the one thing that is unique, needs no LLM, API key, cloud account or credentials, and is the only path proven on a foreign machine. The brief is deterministic: `agents/why.ts` renders from the index and `agents/_lib/synthesize.ts` fixes that render as the floor, so a machine with no local model gets the full brief rather than an error.

Nothing is removed. The connector count, the agents, federation and the egress ledger all stay — resequenced as depth behind the wedge.

**Files:**

- Modify: `docs/README.md` (the section between the badge block and "What It Does")
- Modify: `docs/launch-messaging.md` (add a section above "The three pillars")

**Interfaces:**

- Consumes: nothing.
- Produces: the canonical wedge sentence that every channel post in the runbooks derives from.

- [ ] **Step 1: Add "the one thing" to launch-messaging**

Insert directly above `## The three pillars` in `docs/launch-messaging.md`:

```markdown
## The one thing (lead with this)

> `nimbus why src/auth.ts:42` — who wrote this line, which PR, which ticket, which incident. No LLM, no API key, no cloud account, no credentials. Answered from a local index in under a second.

Every post, listing and landing page leads with this and nothing else. The connector count, the agents and the egress ledger are depth — they belong on the second screen, once someone has a reason to keep reading. The pillars below describe what makes people *stay*; this line is what makes them *start*.

**Why this one:** it is the only capability that is simultaneously unique, free of every prerequisite, and provable in under a minute — and it is the only path verified end-to-end on a machine the author does not own.
```

- [ ] **Step 2: Rewrite the README's opening**

In `docs/README.md`, immediately after the closing `</div>` of the badge/hero block and before the existing `Nimbus is an open-source, local-first AI agent...` paragraph, insert:

````markdown
## Start here

```bash
nimbus init            # index the repo you're standing in — no account, no API key
nimbus why src/auth.ts:42
```

Who wrote this line, which pull request carried it, which ticket asked for it, which incident it touched. Answered from a local index in under a second — with no LLM configured, no credentials, and nothing leaving your machine.

That is the whole first run. Everything below is what becomes available once you connect the tools you already use.
````

Keep the existing paragraph beneath it unchanged — it becomes the second screen rather than the first.

- [ ] **Step 3: Link the orphaned audiences doc from the README**

The spec says `docs/audiences.md` should sit deeper rather than compete with the wedge. Verified
during the pre-flight scan: **the README does not link it at all** (`grep -n audiences
docs/README.md` returns nothing), and the README's own audience content — `## Who It's For` —
already sits below `## What It Does`. The spec's intent is therefore already satisfied and nothing
needs moving.

What is actually wrong is that `docs/audiences.md` is orphaned. Add one line at the end of the
`## Who It's For` section:

```markdown
More detail on each role, including analytics and data roles: [Who Nimbus is for](./audiences.md).
```

Do not edit `docs/audiences.md` itself — its content is correct.

- [ ] **Step 4: Check every claim in the new copy against the guardrails**

Confirm by reading the diff:

- No mention of the `why` hover UI as shipped.
- No description of the egress ledger as capturing network traffic.
- No connector count introduced or changed.
- No "no telemetry" absolute.

Run:

```bash
grep -n -i "hover\|every byte\|no telemetry\|network traffic" docs/README.md docs/launch-messaging.md
```

Expected: no new occurrences introduced by this task. Pre-existing correct usages (the guardrail text itself in `launch-messaging.md`) are fine.

- [ ] **Step 5: Verify the docs gates and the links**

Run:

```bash
bunx markdownlint-cli2 docs/README.md docs/launch-messaging.md docs/audiences.md && bun run audit:doc-refs && bun run audit:readme-cli && bun run audit:status-drift
```

Expected: all pass. `audit:readme-cli` will fail if `nimbus why` or `nimbus init` is misspelled — it checks README commands against the CLI registry.

- [ ] **Step 6: Commit**

```bash
git add docs/README.md docs/launch-messaging.md docs/audiences.md
git commit -m "docs: lead with nimbus why on every public surface"
```

---

## Task 6: Cross-link the satellite repositories

Seven public satellite repositories sit at 0 stars and are unreferenced from the main README: `nimbus-sdk`, `nimbus-client`, `nimbus-vscode`, `nimbus-web-clipper`, `create-nimbus-connector`, `awesome-nimbus`, `nimbus-raycast`. Someone who finds the main repo cannot discover the ecosystem, and the ecosystem is evidence that the project is more than one repo.

`packages/github-actions/` (`annotate-action`, `preflight-query`) is built and unlisted on the GitHub Actions Marketplace — listing is a repo-settings action, not code, so it is a runbook item; the README pointer is this task.

**Files:**

- Modify: `docs/README.md` (add an Ecosystem section before Contributing)

**Interfaces:**

- Consumes: nothing.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Verify every repository is public before linking it**

Run:

```bash
for r in nimbus-sdk nimbus-client nimbus-vscode nimbus-web-clipper create-nimbus-connector awesome-nimbus nimbus-raycast; do
  echo -n "$r: "; gh repo view "nimbus-agent/$r" --json isPrivate --jq .isPrivate
done
```

Expected: all `false`. **Any repo printing `true` must be dropped from the list below** — linking a private repo from the README produces a 404 for every visitor and would fail the link check. Note that `nimbus-connector-registry`, `nimbus-recipes` and `nimbus-mcp-servers` are private and are deliberately absent from this list.

- [ ] **Step 2: Add the Ecosystem section**

Insert before the Contributing section in `docs/README.md`:

```markdown
## Ecosystem

Nimbus is a gateway plus a set of surfaces that talk to it. All of these are separate, independently released repositories:

| Repo | What it is |
|---|---|
| [nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) | The extension-authoring contract (MIT) — what a connector is written against |
| [nimbus-client](https://github.com/nimbus-agent/nimbus-client) | Typed IPC wrapper (MIT) — how a client talks to the gateway |
| [create-nimbus-connector](https://github.com/nimbus-agent/create-nimbus-connector) | Scaffolding generator for a new connector |
| [nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode) | VS Code / Open VSX extension |
| [nimbus-web-clipper](https://github.com/nimbus-agent/nimbus-web-clipper) | Chrome + Firefox MV3 web clipper |
| [nimbus-raycast](https://github.com/nimbus-agent/nimbus-raycast) | Raycast extension — quick-ask over the local gateway |
| [awesome-nimbus](https://github.com/nimbus-agent/awesome-nimbus) | Curated connectors, recipes, extensions and resources |

The SDK and client are **MIT**, not AGPL — building on Nimbus does not pull the core's license into your project.
```

- [ ] **Step 3: Verify the docs gates and that no link 404s**

Run:

```bash
bunx markdownlint-cli2 docs/README.md && bun run audit:doc-refs
```

Then verify each URL **as written in the README** — this is not redundant with Step 1, which
checks repo names via `gh`; this catches a typo in the markdown:

```bash
grep -o 'https://github.com/nimbus-agent/[a-z-]*' docs/README.md | sort -u | while read -r u; do
  echo -n "$u "; curl -s --retry 3 --retry-all-errors --max-time 15 -o /dev/null -w "%{http_code}\n" "$u"
done
```

Expected: every line ends in `200`.

- A `404` means the repo is private, renamed, or the URL is mistyped — fix the URL or remove the
  row rather than shipping a dead link.
- A `000` is **not** a verdict — it means curl got no response at all (a transient network
  failure). This was observed twice while writing this plan, on repos that were live both times.
  The retry flags above absorb it; if a `000` survives them, rerun before concluding anything.
- Do **not** add `-L`. No `nimbus-agent` repo redirects today — all seven return `200` directly —
  and following redirects would mask the one case worth catching: a renamed repo answers `301` at
  its old URL, and a README quietly relying on GitHub's rename redirect is a stale link waiting
  to break.

- [ ] **Step 4: Commit**

```bash
git add docs/README.md
git commit -m "docs: link the satellite repositories from the README"
```

---

## Task 7: Decide the `@nimbus-dev/mcp` publish route

Publishing the launcher is what unblocks the official MCP Registry — the highest-intent discovery surface for this product. It is **not** a one-command task, and the plan must not pretend otherwise:

- `NPM_TOKEN` is `state: "forbidden"` in `scripts/release/credential-registry.ts`, revoked 2026-07-19, with the note *"Publishing is OIDC-only; both packages are set to `mfa=publish`, so a token cannot publish. If this reappears, someone has reintroduced a bypass."*
- The monorepo contains **zero** `npm publish` steps. `@nimbus-dev/sdk` and `@nimbus-dev/client` publish from their own satellite repositories, which is exactly why they are live and this one is not.

So there is a real decision with two viable branches, and it must be recorded before anything is built. This task ends at a recorded decision; implementing the chosen branch is a follow-up plan, because the two branches have almost nothing in common.

**Files:**

- Create: `docs/superpowers/specs/2026-08-19-mcp-launcher-publish-route.md`

**Interfaces:**

- Consumes: Task 1's corrected claim (which this task may later reverse).
- Produces: a recorded decision; no code.

- [ ] **Step 1: Establish the current state, do not assume it**

Run:

```bash
npm view @nimbus-dev/mcp version
timeout 30 npm org ls nimbus-dev 2>&1 | head -5
grep -n "NPM_TOKEN" -A 12 scripts/release/credential-registry.ts | head -20
grep -rn "npm publish\|npm-publish\|trusted publish" .github/workflows/ | head
```

Record what each returns.

**Already verified on the author's machine (2026-08-19), so treat this as the expected result
rather than a surprise:** `npm whoami` and `npm org ls nimbus-dev` both fail with `E401` in about
a second — **there is no npm authentication on this machine at all.** The command does not hang
and does not open a browser, so the `timeout` above is insurance, not a fix. (`--no-audit` is not
a valid flag for `npm org`; do not add it.)

That absence is itself an input to the decision: whichever branch is chosen, publishing happens
from CI under OIDC rather than from a developer machine — consistent with `NPM_TOKEN` being
`forbidden`, and an argument in favour of the branch whose CI publish path already exists.

- [ ] **Step 2: Write the decision document with both branches costed**

Create `docs/superpowers/specs/2026-08-19-mcp-launcher-publish-route.md` covering:

- The verified state from Step 1, quoted exactly.
- **Branch A — publish from the monorepo via OIDC trusted publishing.** Cost: a new publish workflow in a repo that has never published to npm, plus a trusted-publisher configuration for a third package. Benefit: the launcher stays beside the gateway code it launches, and versioning stays with release-please. Risk: adds an outbound publish path to the repo that holds the release signing surface.
- **Branch B — move `packages/mcp-launcher` to its own satellite repo.** Cost: a repo split, a new CI setup, and one more repo to keep in the org drift sweep (`org-drift-sweep.yml` enumerates repos explicitly and would need the new name). Benefit: matches the pattern already proven twice — sdk and client both publish this way and both are live. Risk: the launcher version can drift from the gateway it launches.
- A recommendation with reasoning. Branch B is the one with working precedent in this org; Branch A is the one that keeps the code together. Say which and why.
- The consequence for `CLAUDE.md` / `GEMINI.md`: whichever branch ships, Task 1's "not yet published" wording is reversed at that point.

- [ ] **Step 3: Verify the doc gate**

Run:

```bash
bunx markdownlint-cli2 docs/superpowers/specs/2026-08-19-mcp-launcher-publish-route.md
```

Expected: PASS.

- [ ] **Step 4: Commit and stop**

```bash
git add docs/superpowers/specs/2026-08-19-mcp-launcher-publish-route.md
git commit -m "docs: cost both routes for publishing @nimbus-dev/mcp"
```

**Do not implement either branch in this plan.** Bring the decision back for approval; the chosen branch gets its own plan.

---

## Final verification

- [ ] **Run the fast preflight tier**

```bash
bun run preflight:fast
```

Expected: all gates pass, including the new `audit:connector-registry-drift`.

- [ ] **Confirm no probe artifacts survived**

```bash
git status --porcelain
```

Expected: clean. Specifically, neither `zzz-drift-probe` nor `zzz-scaffold-probe` may appear anywhere.

- [ ] **Confirm the branch**

```bash
git rev-parse --abbrev-ref HEAD
```

Expected: `dev/asafgolombek/distribution-program`, never `main`.

---

## Human runbooks (not implementable tasks)

These are rows 3 and 5–10 of the spec's sequencing table. They are outreach and judgement, not code, and no agent should tick them. Listed here so the plan and the work stay in one place.

- [ ] **Stock the issue shelf to 25–30.** Weighted to connector and docs work. Each issue needs an acceptance criterion and a pointer to the scaffold, or it is a wish rather than a good first issue. Split #1002 and the connector-index issues (#975, #974, #953, #952, #951) into per-connector items.
- [ ] **Finish the directory listings.** Chase `awesome-mcp-clients` PR #265 and `awesome-mcp-servers` PR #11216 to a verdict, confirm the Glama listing survived the v2.7.0 release, then run the untouched Tiers 2–4 from `2026-07-30-directory-listings-design.md`.
- [ ] **List the GitHub Actions on the Marketplace.** `packages/github-actions/annotate-action` and `preflight-query`. A repo-settings action, not code.
- [ ] **Contributor recruiting.** 10–20 targeted approaches to people who have already published an MCP server. The ask is the connector one: *"Nimbus doesn't see your $TOOL yet — here is the generator, it takes about an hour."*
- [ ] **Hacktoberfest opt-in** (October, ~6 weeks out). Requires Task 4's assignment rule to be published first. Add the repo topic; label deliberately; close low-effort PRs quickly and politely. No auto-reply bot — deferred by the review response, revisit only if volume appears.
- [ ] **Gate 1 Windows + macOS.** The human first-run proofs still owed from the launch plan. A docs/DX contributor who owns a Mac can close the macOS leg.
- [ ] **Gate 2 private alpha.** 5 testers reach `nimbus why` on their own repo unaided; 3 still using it at 14 days. Gates Gate 3 — do not skip it.
- [ ] **Gate 3 user channels**, in the launch spec's order: directories → Lobsters → r/selfhosted → r/devops and r/sre → Show HN last.
- [ ] **Direct vendor asks** (Microsoft / Google / Anthropic — credits, partner programs, amplification). After Gate 3 opens, never before. Verify each programme's current terms at the time of asking.
- [ ] **Read the contributor signals monthly**, from the spec's Section 5 table: PRs opened by non-maintainers, of those how many merged, median time-to-first-response, returning contributors, claim rate on `good first issue`. All are free from the GitHub API — no tooling is proposed here, because at zero outside PRs a dashboard would instrument a queue that does not exist. Build one only if the numbers become too large to read by hand.
- [ ] **Honour the stop conditions.** Thirty days of recruiting with zero outside PRs means the on-ramp is broken, not the recruiting — fix the first hour instead of posting more. Gate 2 failing with friendly testers means a public launch would have failed too — fix the product, do not open Gate 3. Time-to-first-response slipping past a week twice means cut scope (drop a channel, defer Hacktoberfest) rather than accumulate an unanswered queue.
