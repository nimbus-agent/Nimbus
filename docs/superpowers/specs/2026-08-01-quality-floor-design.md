# A ratcheted code-quality floor — file length, function length, per-file complexity, module testability

> **Status:** design, 2026-08-01. Proposed off `dev/asafgolombek/deps-and-quality-floor`.
> **This is a spec, not an implementation.** No gate is wired by this document and no source file
> changes because of it.
>
> It is the structural follow-on to the line-coverage floor
> (`scripts/coverage-floor/`, `FLOOR_PCT = 85` / `BRANCH_FLOOR_PCT = 80`), and it deliberately
> reuses that subsystem's shape rather than inventing a second ratchet idiom. Read
> `scripts/coverage-floor/{baseline,check,exclusions}.ts` before this document; most of §6 is
> "the same thing with the comparison flipped".
>
> Every number below marked **measured** was produced against this worktree today by a throwaway
> probe (§7.3), not quoted from a dashboard. Numbers marked **reported** come from work done
> elsewhere today and are labelled as such.

## 1. Why now

Two defects were found today. Both were pure quality debt, both had a large measurable cost, and
**neither was visible to any gate this repo runs** — not typecheck, not Biome, not the coverage
floor, not Sonar, not `audit:structure`.

**The first: a package whose tests could not exist.** *(reported — satellite repo
`create-nimbus-connector`, not this monorepo.)* Its `scripts/` directory was untestable *by
construction*, not by neglect:

- every harness self-executed — a bare `await main()` at module scope, with no `import.meta.main`
  guard;
- `parseSdkArgs(process.argv)` ran at **import time**, so importing the module read the test
  runner's own argv;
- importing `snapshot-update.ts` **rewrote every checked-in snapshot** as a side effect.

`grep -rn "^export" scripts/` returned exactly **one** line. There was nothing to call. Making the
modules importable moved exports **1 → 33** and new-code coverage **55.1% → 87.4%**. No test was
"hard to write"; the test was *impossible* until the module changed shape.

**The second: a CLI command missing a seam its siblings already had.**
`packages/cli/src/commands/share.ts` sat at **28.06% line / 28.30% branch**, and its entry in
`scripts/coverage-floor/exclusions.ts` justified that with "no injection seam". That rationale was
false. Four siblings — `policy.ts`, `chatops.ts`, `admin.ts`, `tribal.ts` — already exported an
`XIpc` interface plus a `runXCommand(client, cmd)` dispatcher. `share.ts` had simply never been
given one. Adding it took the file to **93.15% / 93.40%**, and the exclusion was deleted rather
than re-justified.

The common shape is the point: **in both cases the coverage number was a symptom, and the defect
was structural.** A coverage floor can only say "this file is under-tested". It cannot say "this
file is *shaped* so that testing it is impossible", which is the condition that produced the
number. Nothing in the toolchain measures shape.

That gap is now sized, and it is not small — **26 of the 33 CLI command modules that talk IPC have
no injected-client seam** (§4.4, measured). `share.ts` was not an outlier; it was the first one
anybody looked at.

## 2. Decisions already made

Recorded, not reopened. Each is the maintainer's call as of 2026-08-01.

| # | Decision |
| --- | --- |
| D1 | The goal is to **enforce structurally, going forward**, then fix only what the new gates flag. This is not a refactoring campaign with a gate attached; it is a gate, and the campaign is whatever the gate reports. |
| D2 | **Ratchet now, hard ceilings later** — exactly how the line floor went 80 → 85. Day one is green-with-watermarks, not a wall of red. |
| D3 | **All four gates are in scope**: file length (LOC), longest function per file, per-file cognitive complexity, and a module-testability/DIP rule. |
| D4 | Complexity is computed **locally, in one AST pass** — offline, deterministic, network-free. **Not** via the SonarCloud API. Sonar remains an *independent cross-check*, never an input. |
| D5 | The SOLID requirement is expressed as something machine-checkable: **"a module must be importable without side effects, and command modules must expose an injected-client seam."** No attempt is made to check SRP or OCP directly. |
| D6 | **Never fix a gate by exclusion** (standing rule, predates this spec). §9 makes the mechanism that honours it explicit. |

D4 deserves one line of rationale beyond "offline is nice": a gate whose verdict depends on a
network service can be *green because the service was down*, and its history is owned by someone
else. The coverage floor is already the repo's answer to that — `audit:coverage-floor` reads a local
lcov, not a Sonar measure — and the same reasoning applies here. Sonar's value is precisely that it
is computed differently; that value evaporates if the local gate and Sonar are the same reading.

## 3. The measured shape of this codebase

### 3.1 Length

**Measured** with `rawLoc()` semantics from `scripts/structure-audit/measure-file-loc.ts`:

| Scan set | Files | > 1000 | > 500 | > 400 | > 300 |
| --- | --- | --- | --- | --- | --- |
| `structure-audit` `iterateSourceFiles()` (`packages/*/src/**/*.ts`, minus test/`-sql`/`.d.ts`/fixtures) | 1092 | 7 | 33 | 52 | 82 |
| `coverage-floor` `discoverSourceFiles()` (gateway + cli `.ts`/`.tsx` + mcp-connectors) | 1113 | 7 | 32 | 50 | 81 |
| All `packages/*/src` incl. `ui` and `.tsx` | 1197 | 7 | 33 | — | — |

**"7 over 1000" is the only headline stable across every set.** The **> 500 count is not**: 32 in
the `coverage-floor` set, 33 in the other two. Measured, the difference is exactly one file —
`packages/ui/src/ipc/client.ts`, the only >500-line file the `coverage-floor` globs never reach —
and the three sets are otherwise identical above 500. So **32 is the `coverage-floor` figure and
must be quoted as such**; that is the set this gate is pinned to (§7.1), which is why §5 and §6 are
all in it.

**The file *total* is not stable either** — it moves by ~100 depending on whether `.tsx`,
`packages/ui`, `-sql.ts` and `scripts/` are in scope, and `scripts/` alone adds 126 more non-test
modules (125 on `main`; this branch's own `check-override-drift.ts` is the 126th, which is itself a
small demonstration of why a count belongs to a scan set *and* a commit). The commonly-quoted figure
of ~1251 does not correspond to any of the three sets above.

That is not a nitpick, it is a requirement: **the gate must pin its scan set in code and state it in
its own error output**, or two people will disagree about whether a file is even gated. §7.1 pins
it; §13 records which set.

### 3.2 Length and complexity are decoupled here

**Measured** (§7.3 probe; `ncloc` = non-blank, non-`//`-only lines; `fileCC` = sum of per-function
cognitive complexity with each function scored independently):

| File | ncloc | functions | fileCC | CC/fn | max fn CC | longest fn (lines) |
| --- | --- | --- | --- | --- | --- | --- |
| `platform/assemble.ts` | 1884 | 193 | 128 | 0.7 | 13 | **551** |
| `connectors/lazy-mesh/phase3-config.ts` | 1625 | 72 | 109 | 1.5 | 6 | 70 |
| `ipc/server/dispatchers.ts` | 1270 | 81 | **273** | 3.4 | 13 | 72 |
| `config/nimbus-toml.ts` | 1427 | 128 | 228 | 1.8 | 15 | 43 |
| `cli/src/commands/extension.ts` | 701 | 59 | **131** | 2.2 | 13 | 54 |
| `extensions/verify-extensions.ts` | 481 | 18 | 93 | 5.2 | 14 | 53 |
| `engine/agent.ts` | 467 | 22 | 59 | 2.7 | 11 | **391** |
| `ipc/federation-rpc.ts` | 548 | 41 | 50 | 1.2 | 14 | **478** |
| `platform/assemble-sync-registrations.ts` | 555 | 89 | **0** | 0.0 | 0 | **453** |

Read the table as four independent failure modes:

- **`assemble.ts` is the longest file in the repo and mid-pack on complexity** (0.07 CC per ncloc).
  It is a wiring table. A pure length gate puts it at the very top of the fix list, where the
  correct action is to do nothing.
- **`extension.ts` is 37% of `assemble.ts`'s length and slightly *more* complex** (131 vs 128). A
  length gate never sees it.
- **`assemble-sync-registrations.ts` has a 453-line function at cognitive complexity zero** — one
  function holding 82% of the file's lines and contributing not a single branch. Both complexity
  gates are silent; it is straight-line registration calls.
- **`federation-rpc.ts` has a 478-line function inside a 676-line file** (548 ncloc). The file
  clears any plausible length ceiling, its complexity is unremarkable, and Sonar's S3776 does not
  fire — the function is long and *flat*.

This is the empirical justification for D3. A single metric picks the wrong files.

### 3.3 What Sonar already covers, and precisely where it stops

`biome.json` was read in full: the `linter.rules.complexity` block sets `useLiteralKeys: "off"` and
`noForEach: "error"` and **nothing else**. There is **no** `noExcessiveCognitiveComplexity`, no
`noExcessiveLinesPerFunction`, no file-size rule, and no `nursery` block enabling one. Biome
contributes zero size or complexity enforcement today. *(Verified by reading the file, not by
trusting a survey.)*

SonarCloud **does** enforce cognitive complexity > 15 **per function** via `S3776`, and that gate is
live and bites — the tip of this very branch is
`refactor(extensions): extract parseEntry helper to satisfy cognitive complexity gate`.

And it works. **Measured: across 1061 scanned files and 8666 functions, the number of functions
exceeding cognitive complexity 15 is zero** (scoring each function independently, Sonar-style).

That single number reshapes the design:

> **A per-function complexity gate would catch nothing.** S3776 has already driven that population
> to empty. The uncovered dimension is the **per-file aggregate** — `dispatchers.ts` carries 273
> units of cognitive complexity across 81 functions and every one of them is ≤ 13, so it passes
> S3776 81 times while being, as a unit, the most complex file in the repo.

Gate 3 is therefore explicitly and only a **per-file** gate (§4.3). It is not a re-implementation of
S3776; it measures the thing S3776 structurally cannot see, which is what makes Sonar a genuine
independent cross-check rather than a duplicate reading.

## 4. The four gates

### 4.1 G1 — file length (LOC)

- **Metric:** `rawLoc(contents)` — the function already shipping in
  `scripts/structure-audit/measure-file-loc.ts`. Raw physical lines, comments and blanks included.
- **Catches:** the file nobody can hold in their head, and the file that has become a junk drawer
  because appending was easier than placing.
- **Missed by the others:** `phase3-config.ts` (1625 ncloc, CC 109, max fn 6) is a legitimately
  large data table today — but a length gate is what notices when a *seventh* one appears, before
  anyone has an opinion about it.
- **Its own blind spot:** everything in §3.2. Length is the weakest of the four signals, and it is
  in scope because it is nearly free (the measurement already exists), not because it is the most
  informative.

**The measurement half of G1 already exists and was deliberately left advisory.**
`measure-file-loc.ts` writes `docs/structure-audit/file-loc.json` and never exits non-zero;
`audit-structure.ts` closes with the comment *"Don't exit non-zero on individual tool failures — the
orchestrator's job is to collect signal, not gate."* That was the right call at the time. G1 is the
decision to promote the signal, and it must be a **new check script** that imports `rawLoc` — the
reporter keeps reporting, and the gate never writes a file as a side effect of checking (§10.4).

### 4.2 G2 — longest function per file

- **Metric:** for each function-like node (`FunctionDeclaration`, `FunctionExpression`,
  `ArrowFunctionExpression`, `ObjectMethod`, `ClassMethod`, `ClassPrivateMethod`), the span
  `loc.end.line - loc.start.line + 1`. The file's score is the maximum over its functions.
- **Catches:** the long *flat* function. This is the single most distinctive gate of the four,
  because a long flat function is invisible to **every** other signal: its file may be short, its
  cognitive complexity is near zero *because* it is flat, and it is perfectly importable.
- **Proof it is not redundant** (measured): `assemble-sync-registrations.ts` — 453-line function,
  file CC **0**. `federation-rpc.ts` — 478-line function, file CC 50, file 548 ncloc.
- **Why per-file-max and not per-function rows:** it keeps the baseline one row per file, identical
  in shape to the coverage baseline, and it keeps the ratchet from churning when functions are
  reordered or renamed. The cost is that shortening the second-longest function is invisible until
  it becomes the longest. Accepted; §13 revisits.

### 4.3 G3 — per-file cognitive complexity

- **Metric:** Sonar-style cognitive complexity, computed locally (§7.2), **summed over the file's
  functions**, with each function scored independently (a nested function's score is its own, never
  folded into its parent).
- **Catches:** the file that is death by a thousand small branches — many functions, each
  individually reasonable, aggregating into something no one can reason about. `dispatchers.ts`
  (CC 273) and `nimbus-toml.ts` (CC 228) are the live examples.
- **Missed by the others:** `extension.ts` at 701 ncloc / CC 131 clears a 1000-line ceiling
  comfortably, has no function over 54 lines, and no function over CC 13.
- **Explicitly not:** a per-function gate. S3776 owns that and has already zeroed it (§3.3).

**A third metric was considered and rejected: complexity density (CC per ncloc).** Measured, the
densest files in the repo are `config/nimbus-toml-workday.ts` (0.30), `embedding/chunker.ts` (0.28),
`policy/policy-toml.ts` (0.27), `extensions/manifest.ts` (0.26) — small, dense parsers and
validators, which are *supposed* to be dense. Density would fire hardest on the files with the
best reason to be dense, so it is measured for the report and never gated.

### 4.4 G4 — module testability / DIP

This is D5 made mechanical. Two independent rules, both static:

**G4a — a module must be importable without side effects.** A source module must not, at module
scope, perform I/O, mutate global state, read process state, or invoke its own entry point.
Detected as AST predicates over top-level statements:

- an unguarded top-level `await main()` / `await run()` — that is, one not inside
  `if (import.meta.main) { … }`;
- a top-level `const x = process.argv…` / `process.env` read that escapes into module state;
- a top-level call to a known-effectful surface (`Bun.write`, `writeFileSync`, `Bun.spawn`,
  `mkdirSync`, network `fetch`);
- a top-level `Database(...)` open, or any top-level statement whose callee resolves to a
  module-local function that transitively does one of the above *within the same file*.

Measured today, `packages/*/src` is largely healthy on G4a — 65 modules across `packages/` and
`scripts/` already use the `import.meta.main` guard, and only 2 files under `packages/*/src` carry
an unguarded top-level `await main()`/`await run()`. `scripts/` is where the debt is: 6 modules read
`process.argv` at module scope (`build-debug.ts`, `build-release.ts`, `build-update-manifest.ts`,
`package-headless-bundle.ts`, `run-with-timeout.ts`, `sign-ed25519.ts`) — the exact shape that made
the satellite repo's harnesses untestable. Whether `scripts/` is in scope is §13's first open
question, and it is the question that decides whether G4a earns its keep or is a formality.

**G4b — a command module must expose an injected-client seam.** A module under
`packages/cli/src/commands/**` that references `IPCClient` or `withIpc` must also:

1. export an interface named `*Ipc`, and
2. export an async `run*Command` whose **first parameter is typed as that interface**, and
3. **actually use that parameter on the dispatcher path.** Inside the body of `run*Command` — and
   inside any same-module function it calls — the parameter identifier must be referenced at least
   once, and there must be **no** `withIpc(...)` call and no `new IPCClient(...)`. Acquiring a real
   client is the job of the thin `runX(args)` wrapper that sits *outside* the dispatcher.

**All three rules are load-bearing, and rule 3 is the one that makes the gate mean anything.**
Rule 1 alone is satisfiable by declaring an interface nobody injects. **Rules 1 + 2 alone are
satisfiable by accepting the parameter and then ignoring it** — a `run*Command(ipc: XIpc, …)` whose
body calls `withIpc()` and talks to the real client passes a declaration-only check while remaining
*exactly* as untestable as `share.ts` was, which is the failure this gate exists to catch. A
declaration-shaped gate would have reported `share.ts` as fixed the moment someone added a
parameter, which is worse than not having the gate: it converts a real defect into a green check.

Verified against the seven compliant modules today: in every one of them the client acquisition
(`new IPCClient(state.socketPath)`, or `share.ts`'s module-local `withIpc` helper) sits in the
`runX` wrapper, **never** inside `run*Command`. Rule 3 therefore costs the current population
nothing — it is a fence around the shape they already have, not a new demand.

The negative fixture that PR 4 must ship, red-proved before the rule is written:

```ts
// commands/__fixtures__/g4b-unused-param.ts — MUST FAIL G4b on rule 3
export interface WidgetIpc {
  listWidgets(): Promise<string[]>;
}
export async function runWidgetCommand(_ipc: WidgetIpc, cmd: WidgetCommand): Promise<void> {
  // Declares the seam, ignores it, acquires a real client anyway.
  await withIpc((c) => c.request("widget.list", cmd));
}
```

Its positive twin is the same file with the body changed to `await _ipc.listWidgets()` and the
`withIpc` import deleted; the pair must be asserted together, so the fixture proves the rule fires
*for the stated reason* rather than because of an unrelated parse difference.

**Measured: 33 command modules talk IPC; 7 comply** — `admin.ts`, `chatops.ts`, `identity.ts`,
`policy.ts`, `scim.ts`, `share.ts`, `tribal.ts`. The 26 that do not: `_agent-brief-cli.ts`,
`ask.ts`, `audit.ts`, `clip.ts`, `connector.ts`, `data.ts`, `deploy-annotate.ts`, `deploy.ts`,
`doctor.ts`, `expert.ts`, `extension.ts`, `metrics.ts`, `people.ts`, `preflight.ts`, `prove.ts`,
`repl.ts`, `run-workflow.ts`, `search.ts`, `security.ts`, `session.ts`, `start.ts`, `status.ts`,
`team.ts`, `vault.ts`, `watch.ts`, `workflow.ts`.

Two honest qualifications:

- **Compliance does not imply coverage.** Four of the seven compliant modules (`policy.ts`,
  `admin.ts`, `chatops.ts`, `tribal.ts`) are *still* excluded from the coverage floor for their
  residual `runX` wrapper. G4b makes a file testable; it does not test it.
- **Not all 26 are equally guilty.** Some are thin. The gate's job is to make each one a decision
  with a name on it rather than an accident, which is precisely what did not happen for `share.ts`
  for months.

### 4.5 Independence, measured

Every ✅ below is a gate that **fires at its §5.2 landing ceiling** (LOC 1000 / longest fn 200 /
file CC 200) on a real file measured today.

| File | LOC | fn | CC | G1 | G2 | G3 | G4 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `platform/assemble.ts` | 2202 | 551 | 128 | ✅ | ✅ | — | — |
| `platform/assemble-sync-registrations.ts` | 557 | 453 | 0 | — | ✅ | — | — |
| `ipc/federation-rpc.ts` | 676 | 478 | 50 | — | ✅ | — | — |
| `ipc/server/dispatchers.ts` | 1343 | 72 | 273 | ✅ | — | ✅ | — |
| `cli/commands/extension.ts` | 758 | 54 | 131 | — | — | — | ✅ |
| `cli/commands/prove.ts` | 187 | 32 | 26 | — | — | — | ✅ |

**G2 and G4 are unambiguously independent.** Rows 2 and 3 are caught by G2 alone — two files under
700 lines, of unremarkable complexity, each with a function longer than most *files* in the repo.
Rows 5 and 6 are caught by G4 alone.

**G3 is the honest exception, and this must be said plainly rather than buried.** At the landing
ceiling of 200, G3 has **no unique catch**: both files over CC 200 (`dispatchers.ts` 273,
`nimbus-toml.ts` 228) are also over 1000 lines, so G1 already reports them. G3 earns its place two
other ways:

1. **Triage, immediately.** G1 reports `assemble.ts` (2202 lines, CC 128) and `dispatchers.ts`
   (1343 lines, CC 273) identically, and the correct response differs completely: the first is a
   wiring table that should be left alone, the second is genuinely tangled. **G3 is what tells you
   which of G1's reports is worth acting on** — which is precisely the "a pure length gate would
   target the wrong files" concern, answered rather than restated.
2. **Detection, once its target lands.** At the declared CC target of 100, five files fire that a
   1000-line G1 ceiling misses entirely: `install-from-local.ts` (811 lines, CC 118),
   `extension.ts` (758, 131), `http-server.ts` (806, 102), `sync/scheduler.ts` (677, 115),
   `filesystem-v2-sync.ts` (619, 109).

So three of the four gates are independent today and the fourth is independent at its target and
useful before then. That is the argument for four gates — stated with its weakest link visible,
because the weakest link is the one a reviewer will find.

## 5. Thresholds

### 5.1 Measured distributions

Files over each candidate threshold. The G1 column is measured across the **1113-file** gated set of
§3.3 (`coverage-floor`'s `discoverSourceFiles()`); G2 and G3 come from the **1061-file** AST scan of
§7.3, which parses a slightly narrower set. The two counts are not interchangeable, and a future
edit should not harmonise them:

| Rank | G1 — file LOC | G2 — longest function | G3 — file cognitive complexity |
| --- | --- | --- | --- |
| loosest | > 1000 → **7** | > 200 → **7** | > 250 → **1** |
| | > 500 → **32** | > 150 → **13** | > 200 → **2** |
| | > 400 → **50** | > 120 → **19** | > 150 → **2** |
| | > 300 → **81** | > 100 → **26** | > 120 → **6** |
| | | > 80 → **48** | > 100 → **11** |
| | | > 60 → **152** | > 80 → **16** |
| tightest | | > 50 → **241** | > 60 → **29** |

### 5.2 Proposed ceilings

Per D2, **each metric gets a ceiling that is live from day one and a declared target that is not**,
mirroring `FLOOR_PCT = 85` / `BRANCH_FLOOR_PCT = 80` living as two separate constants because line
was raised ahead of branch.

| Gate | Ceiling at landing | Files above it | Declared target | Files above target today |
| --- | --- | --- | --- | --- |
| G1 file LOC | **1000** | 7 | 500 | 32 |
| G2 longest function | **200** | 7 | 80 | 48 |
| G3 file cognitive complexity | **200** | 2 | 100 | 11 |
| G4a/G4b | binary — no threshold | 2 + 26 † | — | — |

† `packages/`-only, and therefore provisional: G4a's population is not settled until §13's first
open question is (§7.1). Including `scripts/` raises the G4a half from 2 to at least 8.

The landing ceilings are chosen so each gate's initial debt list is **7, 7, 2** files — small enough
that every entry can be read and understood by one person in one sitting, which is the property that
makes a ratchet a plan rather than a wall. Files above the ceiling are seeded into the baseline at
their current value and are green (§6); the ceilings bite on *new* files immediately.

The targets are aspirational and **live in the spec, not in code**, until a separate decision moves
them. Precedent: line coverage sat at 80 for months with 85 written down before `FLOOR_PCT` changed.

**Why not tighter on day one:** a 500-line ceiling fires on 32 files, an 80-line-function ceiling on
48, and a 100 file-CC ceiling on 11 — **up to 91 metric findings**, which is a list nobody reads.

That "91" is a sum of **per-metric exceedances, not of baseline rows.** The baseline stores one row
per file with a watermark per axis (§6.1), so a file over two ceilings is two findings and one row;
the three sets are not disjoint and the row count is strictly smaller. It is quoted here as the
upper bound on *review load*, which is the quantity this paragraph is actually about — the exact
row count falls out of seeding and belongs in the seeding PR, not in a spec that would have to
guess at the intersection. The ratchet's value comes from each entry being individually retirable
and individually understood; that property is the first thing lost by seeding aggressively.

**Why not looser:** a ceiling above every existing file (say LOC 2500) makes the gate a no-op that
nobody notices is broken. Seven entries proves the plumbing works against real files on day one.

## 6. How the ratchet works

Structurally identical to `scripts/coverage-floor/`, with the comparison inverted: coverage
ratchets **up** toward a floor, quality ratchets **down** toward a ceiling. Where this section says
"the same as coverage", it means literally the same algorithm with `<` and `>` swapped — but **the
`Math.max` → `Math.min` flip is not uniform**, and applying it uniformly is a live bug rather than a
typo. `computeUpdatedBaseline` has two independent terms, and only one of them flips:

```ts
// coverage-floor/check.ts (higher is better):
const storeLine = line >= FLOOR_PCT ? FLOOR_PCT : Math.max(existing?.line ?? 0, line);
// quality-floor (lower is better):
const storeLoc = loc <= LOC_CEILING ? LOC_CEILING : Math.min(existing?.loc ?? Infinity, loc);
```

- **The pin** — `line >= FLOOR ? FLOOR` inverts to `value <= CEILING ? CEILING`. A satisfied axis
  stores **the ceiling**, never the actual. Writing `Math.min(actual, ceiling)` here is the bug: a
  file at 80 against a ceiling of 100 would store 80, and a later — still perfectly compliant — 90
  would then be reported as a `regression`. Stated without reference to either function:
  **a value at or under the ceiling stores the ceiling; a value above the ceiling keeps its actual
  value.** §6.1's `max_file_cc` bullet is exactly this rule, and the two must not drift apart.
- **The watermark** — `Math.max(existing, actual)` ("keep the best seen; `--update-baseline` may
  never relax a watermark") inverts to `Math.min(existing, actual)`, because for a lower-is-better
  metric the better number is the smaller one. This is the **only** `Math.max` → `Math.min` in the
  transliteration, and it applies only on the above-ceiling branch, where a watermark exists at all.

`computeBaselineDiff` inverts by comparison alone, with no `Math.*` involved: `actual < watermark`
(regression) becomes `actual > watermark`, and the `floor.line < FLOOR_PCT && lineActual > floor.line`
must-raise guard becomes `watermark > CEILING && actual < watermark` (`must_lower`). That guard's
purpose survives the inversion unchanged and is the same bug seen from the other side — an axis
pinned *at* the ceiling must never produce `must_lower`, or every mixed file loops forever, which is
the failure `baseline.ts:186-193` documents having actually shipped.

### 6.1 Baseline shape

`docs/structure-audit/quality-baseline.json`:

```json
{
  "version": 1,
  "generated_at": "2026-08-01T00:00:00.000Z",
  "gates": ["g1", "g2", "g3", "g4a", "g4b"],
  "files": {
    "packages/gateway/src/platform/assemble.ts": {
      "max_loc": 2202,
      "max_fn_lines": 551,
      "max_file_cc": 128
    }
  },
  "seamless_commands": ["packages/cli/src/commands/ask.ts"],
  "side_effect_modules": []
}
```

- **`files`** — above-ceiling debt only, exactly like the coverage baseline's `files`. A file that
  clears **every** ceiling has **no entry**; its absence is the assertion that it is clean.
- Per-axis watermarks, not one row per violated axis: a file over the LOC ceiling but under the CC
  ceiling stores `max_file_cc` **pinned at the ceiling**, mirroring how `computeUpdatedBaseline`
  stores `line: FLOOR_PCT` for an axis that is already satisfied. Without that pin, every mixed
  file loops forever between `must_raise` and green — a bug that the coverage baseline's comment at
  `baseline.ts:186-193` documents having actually shipped.
- **`seamless_commands` / `side_effect_modules`** — G4's debt lists. Path arrays, no watermark:
  the rule is binary. A path may be **removed** by `--update-baseline`, never added by it (§6.4).
- **No `targets` section in v1.** The coverage baseline's hand-curated 100% ceilings exist because
  two security-core files must never regress. There is no equivalent claim to make about file
  length yet. Adding one later is additive; inventing one now is speculative.
- **Every metric key and both G4 arrays are optional, and the shape above is the *complete* one.**
  The staged rollout (§11) lands the gates one at a time, so PR 1's baseline has `max_loc` and
  nothing else. **Absent means "no gate wrote this"** — a third state, distinct from
  present-at-the-ceiling ("the gate ran and this axis is satisfied") and from an absent file
  ("every gate that ran found it clean"). A gate never reads a key it did not write. §11 specifies
  the upgrade path.
- **`gates`** — a top-level array (`"gates": ["g1"]`) naming which gates this baseline was written
  by. It is what makes "absent" readable: without it, a G1-only baseline and a four-gate baseline
  over a repo with no long functions are the same document, and §10.2's "an empty baseline is not a
  clean baseline" trap comes back one level up.

### 6.2 The violation kinds

Same taxonomy as `check.ts`'s `Violation` union, in two groups. **The numeric kinds** — every one of
them presupposes a metric *and* a watermark, which is precisely why G4 cannot reuse them:

| Kind | Condition | Message |
| --- | --- | --- |
| `above_ceiling` | file not in baseline, metric > ceiling | *"…is 1240 lines, over the 1000 ceiling; split it, or seed it with `--update-baseline` and say why in the PR"* |
| `regression` | file in baseline, metric > its watermark | *"…grew from 2202 to 2260 lines"* |
| `must_lower` | file in baseline, metric strictly better than watermark on a still-above-ceiling axis | *"…improved; run `bun run audit:quality-floor:update-baseline`"* |
| `must_remove` | file in baseline, now clears **every** ceiling | *"…now clears all ceilings; remove its baseline entry"* |

**The G4 kinds.** G4's rules are binary and its debt lists are path arrays with no watermark, so
"above ceiling", "regressed from" and "improved to" are all unsayable about them. A new
side-effecting module and a command missing its seam get their own kinds and their own messages:

| Kind | Condition | Message |
| --- | --- | --- |
| `side_effect` | module **not** in `side_effect_modules`, G4a finds a top-level effect | *"…performs `writeFileSync` at module scope, so importing it does it; move it into a function or guard it with `if (import.meta.main)`. This list is hand-edited — `--update-baseline` will not add you (§6.4)"* |
| `missing_seam` | `commands/**` module **not** in `seamless_commands`, references `IPCClient`/`withIpc`, and fails G4b rule 1, 2 or 3 | *"…acquires its own client inside `runFooCommand`; export `interface FooIpc`, take it as the first parameter, and use it — see `policy.ts` (§4.4 G4b)"* |
| `seam_resolved` | path listed in `seamless_commands` whose G4b rules now all pass | *"…now has a working seam; run `bun run audit:quality-floor:update-baseline` to drop it from `seamless_commands`"* |
| `side_effect_resolved` | path listed in `side_effect_modules` that G4a now finds clean | *"…is now importable without side effects; run `…:update-baseline` to drop it from `side_effect_modules`"* |

`side_effect` and `missing_seam` name the *specific* failing rule in their message, not just the
file: "fails G4b" is unactionable when three rules can produce it.

**A G4 finding is retired per rule, never per file.** The two `*_resolved` kinds are evaluated
entirely independently of `files` and of each other, because there is no watermark to couple them
to: a module that gains its seam is dropped from `seamless_commands` by the next
`--update-baseline` **even though it is still 1300 lines and still sits in `files` at its LOC
watermark**, and a module that stops writing at import time leaves `side_effect_modules` while its
`seamless_commands` entry stays put. One file may legitimately appear in `files`,
`seamless_commands` and `side_effect_modules` at once, and each of the three exits on its own
condition alone. §6.4's asymmetry is only about *addition*.

`must_lower`, `must_remove` and the two `*_resolved` kinds are why this is a ratchet and not a
snapshot: **improvement without updating the baseline fails the build.** The precedent is
`count-any-usage.ts`, which fails on
`total < baseline.count` with an explicit "then commit the baseline in the same PR" instruction.
Without it, a file quietly improves, the watermark stays loose, and the next regression up to the
old watermark passes silently.

### 6.3 How a file exits the ratchet

1. Someone shortens / decomposes / seams the file.
2. The gate fails with `must_lower` (or `must_remove` if every ceiling is now clear).
3. They run `bun run audit:quality-floor:update-baseline` and commit the baseline **in the same
   PR** as the change.
4. On `must_remove`, the entry is deleted outright. The file is now held to the ceiling forever;
   there is no path back into the baseline except an explicit human `--update-baseline` on a
   regression, which shows up as a baseline **addition** in the diff and is a reviewable event.

The one-directional property is what makes step 4 safe: a regression cannot re-enter the baseline
by accident, because `--update-baseline` is never run by CI or by `preflight` (§10.1).

### 6.4 The G4 asymmetry

`--update-baseline` may **remove** a path from `seamless_commands` / `side_effect_modules` and may
never **add** one. This is deliberate and is the one place the design departs from
`computeUpdatedBaseline`, which happily re-adds a regressed file at its new (worse) value.

The reason: a numeric watermark records "this much debt, no more" and a diff makes it obvious when
it moves. A path list records "this file is exempt from a binary rule", and a tool that
auto-appends to it turns "fix the seam" into "run the update command" — the exact failure mode D6
exists to prevent. Adding a G4 path is a hand edit, with a dated rationale comment, reviewed like an
exclusion.

### 6.5 Seeding

The initial baseline is generated once, committed in the landing PR, and **read in review**. Up to
16 numeric findings (7 + 7 + 2) plus the G4 paths is a reviewable diff.

Both of those are ranges rather than counts, deliberately. The 16 is again per-metric exceedances,
not rows: §4.5 already shows `assemble.ts` over both the LOC and the longest-function ceiling and
`dispatchers.ts` over both the LOC and the file-CC ceiling, so those 16 findings land in **at most
14 rows**. The G4 figure is 28 (2 + 26) **only if G4a is scoped to `packages/` alone** — §7.1 and
§13's first open question can move it, and PR 3 recomputes it against whichever set is chosen.

If the seeded list is surprising, that is a finding, not a formality — the coverage baseline's own
history shows five entries retired on 2026-08-01 alone once someone actually read their rationales.

## 7. Where the data comes from

### 7.1 One pass, one scan set

A single script walks the source tree **once**, parses each file **once**, and derives all four
metrics from that one AST. Concretely: `scripts/quality-floor/measure.ts` exporting

```ts
export interface FileQuality {
  readonly path: string;       // repo-relative, forward slashes
  readonly loc: number;        // rawLoc(), reused from measure-file-loc.ts
  readonly maxFnLines: number; // G2
  readonly fileCc: number;     // G3
  readonly sideEffects: readonly string[]; // G4a findings, empty = clean
  readonly seam: "n/a" | "present" | "missing"; // G4b
}
export function measureFile(relPath: string, source: string): FileQuality;
```

`measureFile` is **pure** — string in, record out, no filesystem, no `process`. That is what makes
the whole thing unit-testable against inline fixtures, which matters more here than in most gates:
a quality gate that is itself untestable would be self-refuting.

The scan set matches **`coverage-floor`'s `discoverSourceFiles()`** (gateway + cli `.ts`/`.tsx` +
`mcp-connectors/*/src`, minus `.test.*`, `.d.ts`, `__fixtures__`, `test/fixtures`, `testing/`) —
1113 files — so that a file is either gated by both floors or by neither, and there is one answer to
"is this file gated". §13 records the two files-in-question sets that this excludes.

**But "matches" is not "calls", and the difference is the whole point.** Importing
`discoverSourceFiles()` freezes nothing: the next time someone changes the coverage floor's scope —
adds `packages/ui`, drops a connector, stops excluding `testing/` — this gate's population, its
baseline and every number in this document move silently, from a PR that never mentions quality.
That is the same class of defect as an exclusion whose rationale went stale unnoticed (§9), and the
countermeasure is the same: make it a **stated contract that fails loudly when it drifts.**

So the set is declared **as its own versioned constant** — `QUALITY_SCAN_SET_V1` in
`scripts/quality-floor/scan-set.ts`, holding the glob and exclusion lists **literally**, with a
comment recording that it was copied from `coverage-floor` on 2026-08-01 and that re-reconciling is
a decision, not a refresh. Two tests hold it up:

1. **Membership.** `QUALITY_SCAN_SET_V1` resolves to a non-zero count (§10.5) and contains/excludes
   a fixed handful of named files — `packages/gateway/src/platform/assemble.ts` in;
   `packages/ui/src/ipc/client.ts`, `*.test.ts`, `*.d.ts`, `__fixtures__/` out. Named files, not a
   total, so the test survives ordinary file churn and still fails on a scope change.
2. **Drift.** It asserts `QUALITY_SCAN_SET_V1` and `discoverSourceFiles()` still yield the same set
   and **fails when they diverge**, naming the added and removed paths. Divergence is then a
   decision someone makes — adopt it by bumping to `_V2` and reseeding, or keep the pin — rather
   than a population change nobody sees.

**The gates do not all share one set, and pretending otherwise is where the counts go wrong.**
Three sets, stated:

| Gate | Scan set | Population |
| --- | --- | --- |
| G1 / G2 / G3 | `QUALITY_SCAN_SET_V1` | 1113 files (measured) |
| G4a | `QUALITY_SCAN_SET_V1`, plus the `scripts/` tree if §13.1 resolves that way | 1113, or 1239 with `scripts/` (+126 non-test modules, measured) |
| G4b | `packages/cli/src/commands/**` — a subset by construction | 33 modules that talk IPC (measured) |

The G4a row is why **"2 + 26" and "28 G4 paths" are provisional, not final.** They are the
`packages/`-only figures. If `scripts/` is in scope the G4a debt is at least the 6 module-scope
`process.argv` readers of §4.4 — and probably more, because a module-scope `process.env` read is
arguably the same defect and there are three further modules doing that today
(`package-linux-installers.ts`, `test-preload/hermetic-credentials.ts`,
`coverage-floor/build-lcov.ts`, measured). The exact number depends on the final G4a predicate and
is computed in PR 3, which is where the decision lands; §5.2 and §6.5 carry the caveat.

### 7.2 Computing cognitive complexity locally

**No new dependency is needed, and this is verified rather than assumed.** `@babel/core@8.0.1`,
`@babel/preset-typescript@8.0.1` and `@babel/plugin-syntax-jsx@8.0.1` are already root
`devDependencies`, and `scripts/coverage/istanbul-register.ts` already parses every TS and TSX file
in the repo with exactly that trio for the coverage preload. The parse configuration is a solved,
in-repo, cross-platform problem — reuse it, do not re-derive it.

(`typescript@^6.0.3` is also present and `ts.createSourceFile` would work. Babel is preferred only
because the working configuration already exists in `scripts/coverage/`.)

The scoring rules, stated so the implementation is not left to taste:

- **+1** for each of: `if`, `else` / `else if`, ternary, `switch`, `for` / `for…in` / `for…of`,
  `while`, `do…while`, `catch`, labelled `break` / `continue`.
- **+ nesting depth** additionally for each *structural* increment (everything above except `else`
  and labelled jumps), where depth counts enclosing structural increments **within the same
  function**.
- **+1** per sequence of like binary logical operators (`a && b && c` scores 1, `a && b || c`
  scores 2).
- **An `else if` chain does not deepen nesting** — that is the defining property of cognitive
  complexity as opposed to cyclomatic.
- **A nested function is scored as its own unit** and its score is *not* folded into its parent's.

That last rule is the one that must be pinned in the spec, because it is worth a factor of three.
**Measured both ways** on the same three files:

| File | fold-nested-into-parent | score-nested-separately |
| --- | --- | --- |
| `platform/assemble.ts` | fileCC 264, max fn 37 | fileCC 128, max fn 13 |
| `engine/agent.ts` | fileCC 176, max fn **112** | fileCC 59, max fn 11 |
| `extensions/verify-extensions.ts` | fileCC 101, max fn 18 | fileCC 93, max fn 14 |

The folding variant reports `createNimbusEngineAgent` at 112 — a number Sonar does not agree with
and that would be indefensible in a PR comment, because the "complexity" is a series of independent
tool-definition callbacks that a reader never holds simultaneously. **Score nested functions
separately.** The corroboration is external: under separate scoring, zero functions in the repo
exceed 15, which is exactly what a live S3776 gate should produce; under folding, dozens do, which
would mean Sonar has been silently broken.

### 7.3 The prototype, and what it proves

The probe run today (throwaway, in the scratchpad, never committed) parsed and scored the tree with
the Babel trio above:

- **1061 files scored in 1.4 seconds** on a Windows dev box, cold. Five individual files parse +
  score in 92 ms.
- Whole-repo function count: **8666**.
- Its per-file numbers land where the reported Sonar figures land — `verify-extensions.ts` at
  **5.2 CC/fn** against a reported 5.6; `assemble.ts` at 1884 ncloc against a reported 1807 (the
  probe's `ncloc` does not strip block comments, so it reads slightly high).
- Its per-function conclusion (**zero functions over 15**) matches the observable fact that S3776 is
  green.

Two claims follow. First, **the pass is cheap enough for the fast preflight tier** — it is faster
than most gates already in `FAST`. Second, **it is close enough to Sonar to be credible and far
enough to be independent**, which is exactly the relationship D4 asks for. It is *not* bit-identical
and must never be presented as such (§13).

### 7.4 Why G4 is static-only

G4a detects import-time side effects. The obvious implementation is to **import the module and
watch what happens**. That must not be built.

The proof is the incident that motivates the gate: importing `snapshot-update.ts` **rewrote every
checked-in snapshot**. A detector that imports modules to find import-time side effects triggers
every side effect it is looking for — and the worst ones, by construction, are the ones that
mutate the repository. A probe process with a read-only filesystem would bound the damage and would
still execute arbitrary code, spawn subprocesses, and open network connections.

So G4 is **AST-only, no execution**, and it accepts a real false-negative: a side effect inside an
imported module is invisible unless the callee resolves within the same file. That is the correct
trade — a gate that is 80% accurate and cannot damage the tree beats one that is 100% accurate and
can.

## 8. How it runs

Following `nimbus-commands` and `scripts/lib/preflight-gates.ts` conventions:

| Script | Command | Behaviour |
| --- | --- | --- |
| `audit:quality-floor` | `bun scripts/quality-floor/check.ts` | Checks. Exits 1 on any violation. **No file writes.** |
| `audit:quality-floor:update-baseline` | `bun scripts/quality-floor/check.ts --update-baseline` | Rewrites the baseline. Never run by CI or preflight. |
| `audit:quality-floor:report` | `bun scripts/quality-floor/check.ts --report` | Human-readable distribution table. Still **exits on the check result** (§10.4). |

**Preflight tier: `fast`.** It has no build dependency, no lcov dependency, no Docker dependency and
no network dependency; it is a static gate in the same class as `audit:invariants` and
`audit:cross-platform`, and it runs in ~2 s. It goes in `FAST` in `scripts/lib/preflight-gates.ts`,
which the manifest drift test then requires the CI workflow to run.

**CI: the `pr-quality` Ubuntu job**, beside the other static audits. Unlike the coverage floor there
is **no CI-Linux authority problem** — the input is file text, not an instrumented lcov, so the
numbers are byte-identical on Windows, macOS and Linux for the same commit. That is a real advantage
of D4 and is worth stating: this gate can be trusted locally, which the coverage floor cannot.

Output uses the `::error file=…::` GitHub annotation form that `coverage-floor/check.ts` already
emits, so violations land on the offending line in the PR diff.

## 9. Exclusion policy

**The standing rule is: never fix a gate by exclusion.** The mechanism that makes the rule livable:

> **The ratchet baseline *is* the exclusion mechanism.** A file that violates a ceiling gets a
> **watermark**, not an exemption. It stays reported, stays in the diff, can only get better, and
> is individually retirable. There is no second, quieter list to be added to.

That distinction is the whole design. A watermark says "this much debt, no more, and here is the
number". An exemption says "stop looking". `scripts/coverage-floor/exclusions.ts` is today an
object lesson in the difference: on 2026-08-01 alone, seven entries were retired because someone
read their rationales and found them false — among them `share.ts` ("no injection seam" — there was
one, four siblings had it), the `index/*-v<N>-sql.ts` block ("no executable lines" — all 43 measure
100/100), `chatops-tool-runner-e2e-sink.ts` ("env-gated shell" — the env var *was* the seam), and two
`types.ts` regexes matched on **filename** while asserting a property of **content**, quietly
un-gating an OIDC token parser.

Read that as the base rate: **a meaningful share of long-lived exclusions in this repo were wrong,
and each one was a regression guard silently switched off.**

Only three exclusion classes are legitimate here, and all are *structural*, never quality-based:

1. **Generated / vendored files** — `*-sql.ts` template-literal modules, bundled `nimbus-*.js`.
   Not authored, so length and complexity are not statements about anyone's work.
2. **Non-source** — `.d.ts`, fixtures, `__fixtures__/`, `testing/`, `.test.*`. Already excluded by
   the shared scan set (§7.1), so this needs no separate list.
3. **Genuinely inapplicable G4b targets** — a `commands/**` module that references `IPCClient` only
   inside a type import. A code-shape carve-out, not a quality one.

"This file is complex because the domain is complex" is **not** an exclusion class. It is a baseline
entry with a comment.

Every exclusion carries a **dated rationale and its retirement condition**, following the format the
coverage exclusions converged on: *"Trailing comments are the last measured value. Delete the entry
the moment its file clears the ceiling."*

**There is no Sonar parity partner, and none should be invented.** `check-exclusion-parity.ts`
exists because `sonar.coverage.exclusions` and `coverage-floor/exclusions.ts` measure the same thing
in two places, making some exclusions a **two-file edit**. Sonar has no per-file LOC ceiling, no
aggregate per-file cognitive complexity gate, and no module-shape rule — so there is nothing to keep
in parity. Building a parity checker anyway would create the two-file-edit tax with none of the
benefit. Recorded explicitly so a future reader does not "fix" the asymmetry.

## 10. Traps this design must survive

Each was learned the hard way in this repo. Each has a specific countermeasure.

### 10.1 Update-before-check absorbs the violation

`scripts/coverage-floor/reseed-docker.sh` ends with:

```bash
bun run audit:coverage-floor:update-baseline
bun run audit:coverage-floor
```

**The gate runs against a baseline that was just rewritten from the very run being gated.** It
cannot fail. That is correct for a deliberate human reseed, and catastrophic if the ordering ever
leaks into an automated path.

Countermeasures, all three:

1. `--update-baseline` **refuses to run when `CI` is set**, exiting 2 with an explanatory message.
2. `--update-baseline` prints a full diff of what it changed (added / removed / relaxed entries) so
   a reseed is never silent.
3. No `reseed-*.sh` equivalent is shipped. The quality gate needs no Docker and no instrumented
   run, so the script that embodies the trap has no reason to exist here.

### 10.2 An empty baseline is not a clean baseline

`docs/structure-audit/coverage-baseline.json` currently reads `"files": {}`. For coverage that is a
genuine achievement — every non-exempt file clears 85/80 — and **driving it back up would be a
regression**, so the quality gate must not touch it, borrow from it, or take it as a template for
"what a baseline looks like when things are fine".

For the quality baseline, `{}` means something different: **either everything clears every ceiling,
or seeding never ran.** Those must not be confusable. So `check.ts` treats a **missing** baseline
file as a hard error (`exit 2`, "run seeding first"), never as an empty one — matching how
`count-any-usage.ts --check` exits 2 when its baseline is absent rather than passing vacuously.

### 10.3 Some exclusions are two-file edits

Recorded in §9: this design has no parity partner by construction. Stated here as a trap because the
*reflex* to add one is the trap.

### 10.4 A print mode that always exits 0

`bun run audit:any` **without `--check` always exits 0**, so invoking it the obvious way produces a
confident false PASS. `measure-file-loc.ts` never exits non-zero at all. Both are correct as
reporters and lethal if mistaken for gates.

Countermeasures:

- **The default mode of `check.ts` is check.** There is no bare invocation that reports without
  gating; `--report` adds output and still exits on the check result.
- The `package.json` script `audit:quality-floor` maps to the checking invocation, and the
  `PREFLIGHT_GATES` entry is derived from that name — never a hand-retyped command string. (Retyping
  is how `audit:any` lost its `--check` in a prior incident.)
- The reporter (`measure-file-loc.ts`) stays a reporter. The gate is a separate file that imports
  `rawLoc`. A single script that both writes `file-loc.json` and gates would make the gate's exit
  code depend on a filesystem write succeeding.

### 10.5 The `.claude/worktrees/` false green

`biome.json` ignores `**/.claude`, and `.markdownlint-cli2.jsonc` globs exclude
`!.claude/worktrees/**`. Inside a worktree, `bun run lint` checks **0 files** and `lint:markdown`
lints **0 files** — both exit 0 having done nothing.

The new gate must **not** inherit that. Its scan set is anchored at `REPO_ROOT` computed from
`import.meta.dir` (the `coverage-floor/check.ts` pattern) and resolves correctly inside a worktree.
Its own test asserts a non-zero file count — a scan that finds zero files is a **failure**
(`exit 2`), never a pass. This document itself was linted from a scratch directory outside the repo
for exactly this reason.

### 10.6 Rename churn

Baselines are keyed by path. A rename presents as a removed entry plus a new above-ceiling file, and
the new file fails `above_ceiling` even though nothing got worse. Accepted for v1: it is
self-announcing, the fix is one `--update-baseline`, and the alternative (content-hash keys) makes
the baseline unreadable, which forfeits §6.5. §13 revisits.

## 11. Rollout order

Four PRs, smallest blast radius first.

| PR | Contents | Why here |
| --- | --- | --- |
| **1** | The ratchet engine (`baseline.ts` / `check.ts` / `exclusions.ts` / `scan-set.ts`), seeded with **G1 only** (`"gates": ["g1"]`, §11.1). Wired to `preflight` FAST + `pr-quality`. | G1's measurement already exists (`rawLoc`), so this PR is *entirely* ratchet plumbing with a metric that cannot be wrong. It proves seeding, the four numeric violation kinds, the scan-set contract (§7.1), the CI annotation format and the manifest drift test against 7 real files, with zero new analysis code to argue about. |
| **2** | The AST pass (`measure.ts`) + **G2 + G3**. Adds 7 + 2 findings, and the first `gates` upgrade. | One parse, two metrics, one PR — splitting them would parse the tree twice or land a parser with one consumer. The scoring convention (§7.2) gets its own tests and a Sonar cross-check in the PR body. |
| **3** | **G4a** (importable without side effects) + the `side_effect` / `side_effect_resolved` kinds. | Small debt in `packages/` (2 files). The PR's real content is the §13 decision about `scripts/`, which sets G4a's scan set and therefore its count (§7.1). |
| **4** | **G4b** (injected-client seam, all three rules) + the `missing_seam` / `seam_resolved` kinds + the §4.4 negative fixture + the first tranche of seam adoptions. | The largest debt (26 files) and the largest payoff. Landing it last means the ratchet is proven and uncontroversial before the gate that asks for the most work arrives. |

**The counter-argument, recorded rather than dismissed:** G4 has by far the strongest evidence —
two independent proofs today, one of them a measured 28% → 93% coverage swing — and G1 has the
weakest (§4.1 admits length is the least informative signal). An order of G4 → G2/G3 → G1 delivers
value soonest.

It is rejected because G4b is also the gate most likely to draw design debate (what counts as a
command module? does `_agent-brief-cli.ts` count? is `repl.ts` exempt?), and a debate about G4b
would block the *ratchet mechanism* if they land together. Shipping the mechanism first on an
uncontentious metric means the G4b discussion is about G4b alone. If PR 1 lands cleanly and quickly,
reordering 3 and 4 ahead of 2 is cheap.

### 11.1 Baseline compatibility across the four PRs

The rollout and the baseline shape have to agree, and as first drafted they did not: PR 1 is
G1-only, but §6.1's shape already carries `max_fn_lines`, `max_file_cc`, `seamless_commands` and
`side_effect_modules` — none of which PR 1 can populate, because the measurement passes that
produce them do not exist until PRs 2–4. A baseline that PR 1 physically cannot write is not a
schema.

The resolution is **one format with optional, gate-scoped sections** — not four formats, and not a
migration per PR:

- **`gates` is the authority.** `"gates": ["g1"]` after PR 1; `["g1","g2","g3"]` after PR 2. A gate
  whose name is absent **does not run** and its keys are not read; a gate whose name is present
  **must** find its section, or `check.ts` exits 2 with the §10.2 "run seeding first" message,
  per gate rather than per file. That is what stops a half-seeded baseline from passing vacuously.
- **Enabling a gate is one reviewed command, in the PR that adds it.** `--update-baseline` under a
  binary that knows about G2 appends `"g2"` to `gates` and fills `max_fn_lines` for every file it
  seeds. It is not automatic and it is not CI's to run (§10.1).
- **The check is fail-closed on the gap between "wired" and "seeded".** A gate wired into `check.ts`
  but missing from `gates` fails the build with *"g2 is not in this baseline's `gates`; run
  `bun run audit:quality-floor:update-baseline` and commit the result in this PR"* — never a silent
  skip. An un-seeded gate must be loud, because a silently-skipped gate is §10.4's false PASS with
  extra steps.
- **`version` stays `1` throughout.** The shape does not change across the rollout; only which
  optional parts are populated does, and `gates` already records that. `version` bumps only when a
  key's *meaning* changes — which is what a reader will assume it means, so it must not be spent on
  anything else.

The upgrade is where this can go wrong quietly, so PR 2 owns an explicit test for it: **a G1-only
baseline (`"gates": ["g1"]`, no `max_fn_lines` anywhere) run through `--update-baseline` under the
G1+G2+G3 binary must produce `"gates": ["g1","g2","g3"]`, add the two new keys, and leave every
existing `max_loc` watermark byte-identical.** That last clause is the one to red-prove: an upgrade
that silently re-derives LOC watermarks from the current tree would relax every entry that has
improved since seeding, turning a schema migration into an unreviewed ratchet reset.

## 12. Security invariants

**None.** No new HITL action type, no egress, no HTTP route, no Tauri-exposed method, no Vault key,
no IPC surface. This is a build-time static gate over file text, in the same class as
`audit:cross-platform`. Stated explicitly so a later audit reads the absence as deliberate.

One adjacency worth naming: G4a's "importable without side effects" rule overlaps the *motivation*
behind `check-nimbus-invariants.ts` (a static check that confines dangerous call sites), but shares
no mechanism and makes no security claim. It must not be added to
`packages/gateway/src/security-invariants.test.ts` or given an `I<N>` number — the triple rule
exists for defenses, and a quality gate is not one.

## 13. Open questions

Honest, and none of them blocking PR 1.

1. **Is `scripts/` in scope?** The evidence motivating G4a comes from a `scripts/` directory in a
   satellite repo, and this repo's own `scripts/` has 6 module-scope `process.argv` reads (plus 3
   module-scope `process.env` reads, if those count — the predicate is part of the question) and
   126 non-test modules, none currently gated by any floor. Including it makes G4a meaningful and
   expands G4a's population by ~11% (1113 → 1239, measured). Excluding it means G4a lands with 2
   findings and looks like a formality. **Leaning: include `scripts/` for G4a only**, since
   `scripts/` modules are exactly the population whose testability is decided by their shape.
   Unresolved — and until it is, the "2 + 26" of §5.2 and the "28 G4 paths" of §6.5 are the
   `packages/`-only lower bound, per the per-gate scan-set table in §7.1.
2. **`packages/ui` and `packages/admin-console`.** Both are outside the coverage floor's scan set
   (admin-console by explicit exclusion; `ui` by never being globbed). `ui` is `.tsx` React and
   would need JSX-aware span rules that mean something. **Leaning: out of scope for v1**, recorded
   rather than silently omitted.
3. **How closely must the local scorer track Sonar?** §7.3 shows it is close but not identical. The
   proposal is that the local number is **authoritative for the gate** and Sonar is a *directional*
   cross-check — if Sonar's S3776 count and the local per-function count ever disagree about
   *direction*, that is a bug in the local scorer. Nobody should be asked to reconcile the two
   numerically. Needs an explicit sign-off, because the first person surprised by a discrepancy will
   assume the gate is broken.
4. **Per-file-max vs per-function rows for G2** (§4.2). Max keeps the baseline readable and rename-
   stable; per-function rows would let the second-longest function's improvement register. If G2's
   `must_lower` traffic turns out to be dominated by "improved a function that wasn't the longest",
   revisit.
5. **Rename churn** (§10.6). Revisit if it actually bites; content-hash keys are the known fix and
   the known cost.
6. **Does G4b's type check survive real TypeScript?** The rule "first parameter is typed as the
   exported `*Ipc` interface" is stated against AST shape. Aliased type imports, generic wrappers,
   and `Pick<XIpc, "foo">` parameter types are all plausible in this codebase and all need a
   decision before PR 4. This is the single most likely source of false positives in the design.
7. **What happens when a baseline entry is legitimately permanent?** `assemble.ts` is a wiring table
   and will never be under 1000 lines. Today it sits in the baseline forever at 2202, which is
   honest but indistinguishable from unaddressed debt. A `permanent: true` flag would say so — and
   would also be the exact hole D6 forbids. **Leaning: no flag**; a permanent entry with a comment
   is more honest than a permanent exemption. Recorded because someone will ask.
8. **`docs/structure-audit/file-loc.json` is not committed** (the directory holds only a
   `.gitkeep` plus baselines). The quality baseline **is** committed, so the audit-output directory
   would then hold both ephemeral reports and load-bearing state. Consider a separate location.

## 14. Claims that become false on landing

Per the triple rule, corrected in the same PR as the code:

- **`scripts/structure-audit/audit-structure.ts`'s closing comment** — *"the orchestrator's job is
  to collect signal, not gate"* — stays true of the orchestrator, but the accompanying belief that
  the LOC signal is advisory does not. The comment needs a pointer to the gate that now consumes it.
- **`scripts/lib/preflight-gates.ts`** — a new `FAST` entry, or the manifest drift test fails.
- **`CLAUDE.md` and `GEMINI.md`** — the *Development Workflow* section lists the gates; both mirror
  each other and both must be updated.
- **`nimbus-preflight` and `nimbus-commands` skills** — gate catalogue and script names.
- **`docs/CHANGELOG.md`**, and `docs/roadmap.md` if the ceiling-raise campaign is tracked there.
- **`scripts/coverage-floor/exclusions.ts`** — the `share.ts` warning comment ("read that as a
  warning about the four entries still in this block") becomes the *second* place that argument is
  made; it should point at §9 rather than restate it.

Grep targets before claiming this list complete: `measure-file-loc`, `file-loc.json`,
`PREFLIGHT_GATES`, `audit:coverage-floor`, `structure-audit`, and the phrase "signal collector".

## 15. Acceptance

- [ ] `bun run audit:quality-floor` exits 0 on the landing commit, with a seeded baseline whose
      every entry was read in review.
- [ ] Adding a 1200-line file to `packages/gateway/src/` fails the gate with an
      `::error file=…::` annotation naming the ceiling and the two ways forward.
- [ ] Growing `assemble.ts` by one line fails as `regression`; shrinking it below its watermark
      fails as `must_lower`; both name the update command.
- [ ] A file that drops below every ceiling fails as `must_remove`, and after
      `--update-baseline` its entry is gone from the baseline diff.
- [ ] `--update-baseline` exits 2 under `CI=true`.
- [ ] A missing baseline file exits 2 with "run seeding first" — never a vacuous pass.
- [ ] A scan that matches zero files exits 2 (the worktree false-green guard), proven by running
      the gate from inside `.claude/worktrees/`.
- [ ] The gate's own measurement functions are unit-tested against inline fixtures, and every test
      is red-proved.
- [ ] Whole-repo runtime is under 5 s on the CI Ubuntu runner, and the gate appears in
      `PREFLIGHT_GATES` FAST without the drift test failing.
- [ ] The local per-function complexity count and SonarCloud's S3776 issue count agree in
      *direction* on a deliberately-complex probe file, and the discrepancy is written into the PR
      body rather than left for someone to discover.
- [ ] A `commands/**` module that references `IPCClient` without exporting an `*Ipc`-typed
      `run*Command` fails G4b as `missing_seam`, and one that only type-imports it does not.
- [ ] **The unused-parameter fixture (§4.4).** A module that exports an `*Ipc` interface *and* an
      async `run*Command` whose first parameter is typed as it, but whose body ignores that
      parameter and calls `withIpc()` to acquire a real client, fails G4b on **rule 3** — and the
      message names rule 3, not "G4b". Its positive twin, identical except that the body uses the
      parameter, passes. Both are asserted in the same test, so the fixture cannot go green for an
      unrelated reason.
- [ ] All seven modules listed as compliant in §4.4 still pass under rule 3 — the rule is a fence
      around the shape they already have, and a run that reclassifies any of them is a bug in the
      rule, not a finding.
- [ ] A new module with a top-level `writeFileSync` fails as `side_effect`, naming the callee;
      wrapping it in `if (import.meta.main)` clears it, and `--update-baseline` adds **nothing** to
      `side_effect_modules` in either state (§6.4).
- [ ] A `seamless_commands` entry that gains its seam fails as `seam_resolved` and is dropped by
      `--update-baseline` **while the same file keeps its `files` row at its LOC watermark** — G4
      retires per rule, not per file.
- [ ] A G1-only baseline (`"gates": ["g1"]`) upgraded by `--update-baseline` under the G1+G2+G3
      binary yields `"gates": ["g1","g2","g3"]`, adds `max_fn_lines`/`max_file_cc`, and leaves every
      `max_loc` byte-identical; a gate wired but absent from `gates` fails the build rather than
      skipping silently (§11.1).
- [ ] The scan-set drift test (§7.1) fails when `QUALITY_SCAN_SET_V1` and `discoverSourceFiles()`
      diverge, naming the added and removed paths — red-proved by adding one glob to a copy.
