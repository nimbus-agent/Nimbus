# True Coverage — Sub-project C: Depth (mutation + property-based testing) — Design

**Date:** 2026-06-13
**Branch:** `dev/asafgolombek/true-coverage-C`
**Status:** Design — awaiting review
**Owner:** AsafGolombek
**Umbrella spec:** [`2026-06-07-true-coverage-program-design.md`](./2026-06-07-true-coverage-program-design.md) (§7 sketches C; §9 the flagship targets overlay, now built; §11 the Stryker-runner open question, resolved here)

## 1. Context

The True Coverage program has shipped sub-projects **A** (the branch-coverage gate, PR #530), **B**
(every non-flagship source file clears the ≥80% line+branch floor; `coverage-baseline.json` `files`
map is `{}`, PRs #534–#587), and the **★ Flagship** (`executor.ts` + `tool-output-envelope.ts`
pinned at 100% line+branch via the `targets` overlay, PR #589).

Line and branch coverage are now saturated. The remaining *meaningful* gains are the two dimensions
line/branch cannot measure (umbrella spec §1, dimensions 2 and 3):

- **Mutation score** — proof the tests actually *fail* when the code breaks (assertion strength).
- **Eliminated blind spots** — property-based tests that explore the *input space* a hand-picked
  example set never reaches.

This is **Sub-project C**. (The fourth dimension — shrinking the ~40 `exclusions.ts` entries — is
**Sub-project D**, the program tail, specced separately when reached.)

## 2. Decomposition (3 slices, 3 PRs)

C is one sub-project delivered as three slices, each its own implementation plan and PR — mirroring
how A shipped as tasks and B as slices B0…B14:

| Slice | Delivers | New deps | CI impact |
|---|---|---|---|
| **C1** | The redaction security fix (an audit-redaction blind spot found by a fast-check spike) + its locking property test | none | none |
| **C2** | The fast-check property suite on the pure security core (envelope / timing-safe-compare / key parsers) | none | none |
| **C3** | StrykerJS mutation-testing harness (dev-only, advisory) | pinned dev-only | **none — never a CI gate in C3** |

Only **C1 is fully detailed here** (it ships next). C2 and C3 are sketched at the design level and
each get their own brainstorm-light → plan cycle when reached (the umbrella-spec convention for
downstream slices).

The **fast-check track (C1 + C2)** runs inside the normal `bun test` suite — `fast-check@4.8.0` is
already a `gateway` devDependency (importable, verified), so there is nothing to install, no Docker,
and no coverage-reseed machinery (we touch no source-coverage materially). The **Stryker track
(C3)** is a separate dev-only harness, never part of the shipped surface.

## 3. C1 — Redaction security fix + locking property test (detailed)

### 3.1 Root cause (reproduced on the live module)

`packages/gateway/src/audit/format-audit-payload.ts` scrubs credential-shaped substrings from audit
payloads via `SENSITIVE_VALUE_PATTERNS`, each anchored with `\b`. JavaScript's `\b` treats `_` as a
**word character**, so a token adjacent to — or containing — `_` sits between two word characters
and produces no boundary, and the match silently fails. Reproduced against the live regexes:

| Input | Result | Why |
|---|---|---|
| `ghp_<36 base62>` (alone) | ✅ redacted | works |
| `ghp_<36>_x` (token followed by `_`) | ❌ **ESCAPED** | trailing `\b` fails — `_` is a word char, no boundary after the body |
| `ghp_…_…` (underscore *inside* the run) | ❌ **ESCAPED** | body class `[A-Za-z0-9]` excludes `_`; the run truncates at `_`, then `\b` fails |
| `github_pat_…` (fine-grained PAT) | ❌ **ESCAPED** | prefix not matched at all + the token legitimately contains `_` |
| `x_ghp_<36>` (token preceded by `_`) | ❌ **ESCAPED** | leading `\b` fails — `_ghp` is word-word, no boundary |

The defect is **not gh-specific**: the same `\b`/underscore (and trailing-extra-char) class is
latent in the `sk-`, `sk-ant-`, `xox`, `Bearer`, JWT (`eyJ…`), and `AKIA`/`ASIA` patterns. A
property test that fuzzes all token families would surface them, so C1 fixes the whole class at
once.

### 3.2 Fix — systemic boundary fix, over-redaction-biased, precise cores

Replace the fragile `\b` anchors with explicit boundaries that treat `_` and other punctuation as a
boundary but **not** alphanumerics, and add the fine-grained PAT family:

- **Leading boundary:** `(?<![A-Za-z0-9])` — the token must start a fresh alphanumeric run. `_`,
  spaces, quotes, and other punctuation before the prefix all qualify as a boundary (fixing the
  `x_ghp_…` escape), while `loghp_…` mid-word does not match (avoids nuking ordinary words).
- **Trailing boundary:** `(?![<pattern charset>])` — not followed by another character of the
  token's own charset (fixing the `ghp_…_x` and "longer than real" escapes).
- **gh family** gains a `github_pat_[A-Za-z0-9_]{20,}` alternative (fine-grained PATs contain `_`):
  ```
  (?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9])
  ```
- **Token cores stay specific** (prefix + minimum length + charset) so non-secret prose is
  preserved — in particular the existing guard test `"sketch a plan"` stays un-redacted (`sk-`
  still requires the hyphen).

The bias is deliberate: in an audit-redaction scrubber, over-redacting surrounding context is far
safer than leaking a live credential. The precise cores bound that over-redaction.

Per-pattern boundary corrections (applied uniformly):

| Pattern | Trailing negative-lookahead charset |
|---|---|
| gh / github_pat | `[A-Za-z0-9]` |
| `sk-` / `sk-ant-` | `[A-Za-z0-9_-]` |
| `xox` | `[A-Za-z0-9-]` |
| `Bearer …` | drop the fragile trailing `\b` after `={0,2}` |
| JWT `eyJ…` | `[A-Za-z0-9_-]` |
| `AKIA` / `ASIA` | `[A-Z0-9]` |

`SENSITIVE_KEY` (the key-name matcher) is unchanged — it is unaffected by the boundary bug.

**Validated during design (2026-06-13):** the proposed regexes were run against all five §3.1
escape cases *and* every existing-test sample — all escapes now redact (the token body never
survives), all existing samples still redact, and the guard cases (`"sketch a plan"`, plain
scalars) are preserved. Bun's JSC engine supports the lookbehind/lookahead, confirmed by running
them. So C1 carries no regex-feasibility risk into implementation.

### 3.3 Locking property test (fast-check)

Added to `format-audit-payload.test.ts` (the established home; `import fc from "fast-check"`):

- **Positive property — "a valid-shaped token is always scrubbed, wherever it sits."** For each
  token family, a generator builds a structurally valid token (correct prefix + random body of the
  correct charset and ≥ the minimum length) embedded in random surrounding noise — including
  adjacent `_`, leading/trailing punctuation, and nesting the value under an arbitrary generic
  (non-sensitive) key. Assert the output contains **neither** the token's high-entropy body **nor**
  the prefix-with-body, **and** contains `[REDACTED]`.
- **Negative property — "ordinary prose is preserved."** Bounded generator of clearly-non-secret
  lowercase words (no token prefix) → asserts they survive verbatim. Keeps the over-redaction bias
  from degenerating into "redact everything."

These properties are the regression lock: they fail today on the live module (the §3.1 escapes) and
pass after §3.2.

### 3.4 Invariant / blast-radius

- This is the **audit-shipper redaction** path — a *sibling* defense to the I11 tool-output
  envelope, **not** the I11 wiring site itself. Expectation: no `security-invariants.test.ts`
  change. C1 will **confirm** that test asserts none of these exact regex literals before relying
  on that expectation.
- The 7 existing `format-audit-payload.test.ts` unit tests must stay green; since the change only
  ever redacts *more*, they are expected to be unaffected.
- Callers (`engine/agent.ts`, `engine/executor.ts`, `automation/workflow-runner.ts`) consume only
  the redacted string — no signature change.

## 4. C2 — fast-check property suite on the pure core (sketch)

Characterization property tests beside each module (no source change expected; any bug found is
fixed in-slice like C1). Targets, in priority order:

- **`engine/tool-output-envelope.ts` escaping (I11):** for arbitrary tool-output strings — including
  ones containing the envelope's own delimiter/sentinel sequences — the wrapped output cannot be
  broken out of (no crafted content lets tool output masquerade as envelope structure).
- **`util/timing-safe-compare.ts` oracle (I10):** property = **functional** equality with a naive
  comparator over random equal / unequal / length-mismatched byte pairs. **Explicitly documented:**
  fast-check verifies the *result*, **not** the constant-time guarantee — that stays a manual/review
  invariant (umbrella spec §9 note).
- **Vault / connector key parsers** (`CONNECTOR_VAULT_SECRET_KEYS` and the key parser/formatter):
  parse∘format is identity on valid keys; malformed `unknown` input is rejected without throwing.

Each test runs in the normal suite. Per-target findings get fixed in C2's plan.

## 5. C3 — StrykerJS mutation testing (sketch)

Resolved from the §11 background research (2026-06-13):

- **Versions:** `@stryker-mutator/core@9.6.1` (current 9.x; Node ≥20 — satisfied, Node v24 present)
  + `@hughescr/stryker-bun-runner` (requires Bun **≥1.3.7**; we run 1.3.14 — it depends on a
  *recent* Bun Inspector/TestReporter feature, so it tracks new Bun rather than being bit-rotted).
  The runner is a single-maintainer experimental community plugin outside the official
  `@stryker-mutator` org.
- **Adopt the bun-runner, but pre-wire the built-in `command` runner as a guaranteed fallback**
  (`testRunner: "command"`, `commandRunner.command: "bun test <scope>"`, judged by exit code; it is
  built into core, no separate package). If the bun-runner misbehaves on our suite we lose only
  perTest-coverage *speed*, not the capability.
- **Dev-only, pinned exact** (no `^`); resolve the runner's exact current version via
  `npm view @hughescr/stryker-bun-runner` at C3 start and pin it. Run the dependency-safety
  pre-flight (`nimbus-commands` skill) before `bun add`.
- **Advisory-first:** `thresholds.break: null` — **never a CI gate in C3**. `mutate` scoped per-PR
  via `git diff`, restricted to **at-or-above-floor files only**.
- **Order:** security core (`executor.ts` + `tool-output-envelope.ts`, now 100% line+branch — the
  ideal first substrate: any surviving mutant is a pure assertion-strength gap) → engine/HITL →
  vault pure → query-gate → connector mappers.
- **Per-subsystem mutation-score baseline** that ratchets up. Flipping `break` to a numeric floor
  per subsystem is a *later* decision once baselines are stable (not C3).
- **Up-front smoke test:** confirm `bunx stryker run` launches and produces a report on a tiny scope
  before depending on the harness.

## 6. Testing & verification

- C1/C2 property tests run in the standard gateway `bun test` suite, exercised by `preflight:fast`
  static gates + the suite. The authoritative CI gate is **PR quality — TS/Bun (ubuntu-24.04) /
  Unit + Coverage**; the windows-2025 cross-platform red is the chronic flake (rerun, not a real
  failure).
- No Docker / coverage-reseed is needed for C1/C2 — they add tests (and, in C1, tighten a regex);
  net source coverage only holds or increases, so the `coverage-baseline.json` `files` map stays
  `{}` and the `targets` overlay is untouched.
- Settled-tree `tsc --noEmit` + Biome before push (worktree skips Biome via `!**/.claude` — use the
  temp-config trick or rely on CI's `biome ci`).
- Fix every CodeRabbit + Sonar thread and resolve each.

## 7. Sequencing

C1 → merge → C2 → merge → C3 → merge → **Sub-project D** (shrink the ~40 `exclusions.ts` entries via
DI-refactor à la #505 `imap-client`; clear residual debt; document genuinely-untestable
FFI/boot/worker shells). D gets its own brainstorm → spec → plan.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| C1 over-redaction nukes audit context | Keep precise token cores; the 7 existing unit tests + the bounded negative property pin the floor |
| C1 misses a token family the property test doesn't model | Generators are built from the *actual* pattern charsets/lengths; add a family-coverage assertion that every `SENSITIVE_VALUE_PATTERN` has a generator |
| C3 experimental runner breaks | Pre-wired `command`-runner fallback; runner pinned exact + re-verified on any Bun bump; dev-only so a breakage never blocks CI |
| C3 mutation runs are slow | Advisory-only + per-PR `git diff` scope + at-or-above-floor files only |
| Stryker needs a Node runtime | Node v24 present; smoke-test `bunx stryker` first |

## 9. Open questions

- Exact pinned version of `@hughescr/stryker-bun-runner` — resolve via `npm view` at C3 start
  (sandboxed research could not read the registry JSON directly).
- Whether C2 surfaces a real bug in the envelope / key parsers (as the spike did for redaction) —
  handled in-slice if so.
