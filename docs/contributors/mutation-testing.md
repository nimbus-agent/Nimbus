# Mutation testing (dev-only, advisory)

StrykerJS measures **assertion strength** — whether tests actually *fail* when the
code changes — which line/branch coverage cannot. It is a **local developer tool**,
**not a CI gate** (`thresholds.break: null` → it never fails a build) and is not in
the preflight-gate manifest.

## Running it

- `bun run mutation` — mutate the configured security core (`engine/executor.ts`
  - `engine/tool-output-envelope.ts`).
- `bun run mutation:diff` — mutate only the `packages/gateway/src/*.ts` files
  changed vs the base ref (`origin/main`, falling back to local `main`). An empty
  diff exits cleanly without running Stryker.

Config: [`stryker.conf.json`](../../stryker.conf.json). Reports land in `reports/`
(git-ignored) — open `reports/mutation/mutation.html` for the per-mutant detail.

### Runner choice (command runner, not the bun-runner)

The harness uses Stryker's **built-in `command` runner** (`bun test <scoped files>`,
exit-code judged), not the experimental `@hughescr/stryker-bun-runner`. The
bun-runner relies on Bun's Inspector WebSocket for per-test coverage, and that
connection **fails locally** (observed on Windows: `Failed to connect to Bun
inspector: WebSocket connection failed`). The command runner is reliable
cross-platform; the trade-off is no per-test coverage, so it reruns the whole
scoped command per mutant (kept fast by a tight test scope). The bun-runner is
still installed — if a future Bun/runner release fixes the Inspector connection,
switch `testRunner` back to `"bun"` + `coverageAnalysis: "perTest"`.

`inPlace: true` instruments the real source files and restores them from a backup
under `.stryker-tmp/`. If a run is killed mid-restore, `git restore` recovers.

## Baseline (2026-06-13)

First run, security core:

| File | Mutation score | Killed | Survived |
|---|---|---|---|
| `engine/tool-output-envelope.ts` | **100.00%** | 14 | 0 |
| `engine/executor.ts` | 35.21% (scope-limited — see below) | 75 | 138 |

**`tool-output-envelope.ts` → 100%.** The first run surfaced 3 survivors in
`escapeAttr`: a mutant replacing the entity with `""` (dropping `&`/`<`/`>` rather
than escaping it) survived, because the tests asserted "no raw `<`" but never that
the named entity was *present* — and dropping the char also satisfies "no raw `<`".
Fixed in-slice by asserting the exact escaped form
(`<tool_output service="a&amp;b&lt;c&gt;d" …>`), killing all three. This is
mutation testing doing its job on a 100%-line/branch-covered file.

**`engine/executor.ts` → 35.21% is *command-scope-limited*, not a statement that
executor's tests are weak.** The command runner cannot do per-test coverage, so it
runs one fixed test command per mutant. That command runs only
`executor-delegation.test.ts` + `executor-flagship.test.ts` (the two files the
flagship added to pin executor.ts to 100% line+branch). executor.ts's *behavioural*
suite actually spans ~8 files (also `hitl-obsidian`, several `ipc/*-rpc`, and
`security-invariants`); running all of them per mutant is impractical with the
command runner, and `security-invariants.test.ts` makes source-text assertions that
break under in-place instrumentation (so it is excluded from scope entirely). Treat
35.21% as a **fixed-scope ratchet starting point** for this exact command — not a
quality verdict. A complete executor.ts score awaits the perTest bun-runner (once
its Inspector connection works) or a curated broader command.

## Policy / roadmap

Advisory-first. Per-subsystem mutation-score baselines and flipping `break` to a
numeric floor are **later** decisions, once scores are stable across subsystems
(intended order: security core → engine/HITL → vault → query-gate → connector
mappers). For now, use `bun run mutation:diff` locally to spot weak assertions on
files you change.
