# True Coverage — Sub-project D2: Heavy / borderline triage (Design)

**Date:** 2026-06-14
**Branch:** `dev/asafgolombek/true-coverage-D2` (worktree `.claude/worktrees/tc-D2`, off `origin/main` 1ca2e77e — includes D1 #607 `8a6f0d6b`)
**Status:** Design — awaiting review
**Owner:** AsafGolombek
**Umbrella spec:** [`2026-06-13-true-coverage-D-shrink-exclusions-design.md`](./2026-06-13-true-coverage-D-shrink-exclusions-design.md) §4 D2 (the heavy/borderline triage), §3(a) (demotions), §5 (reseed mechanics), §7 (invariants/quality bars)
**Predecessor:** D1 — PR #607 (un-excluded `mdns-discovery-provider` / `team-tool-spawn` [I19] / `chatops-bot-spawn-call` [I15/I23]).

## 1. Goal

D2 is the middle slice of Sub-project D (the program-close sub-project). It walks the **heavy /
borderline** exclusion entries the umbrella spec deferred to D2 — `imap-client.ts`, `team.ts`,
`start.ts`, `ipc/server/options.ts`, and the thin CLI shells (`repl`/`doctor`/`policy`/`admin`/
`chatops`) — and, per the program's **honest-shrink** philosophy, **un-excludes only where a clean
seam yields genuinely meaningful tests**, documenting the irreducible rest with accurate rationale.

**Honest-shrink (carried from the umbrella spec):** un-exclude a file *only* where real
orchestration logic is exercised — not "the wrapper called the injected factory." Forcing a seam
into irreducible I/O glue just to mark a file covered is the vanity the program rejects. The #505
`imap-client` model — extract logic to covered siblings, leave the irreducible thin shell — governs.

## 2. Triage-on-read findings (these update the umbrella §4 D2 guesses)

Per the umbrella spec's own rule ("READ first, then decide; size ≠ testable logic"), each D2 file
was read on 2026-06-14. The reads **materially corrected** several umbrella assumptions:

| File | LOC | Umbrella §4 D2 guess | Triage-on-read finding | D2 disposition |
|---|---|---|---|---|
| `connectors/_lib/imap-client.ts` | 227 | "inject an ImapFlow factory seam; test the orchestration" | **Seam + comprehensive tests already exist** (see §3) | **Un-exclude (verify-only)** |
| `cli/src/commands/team.ts` | 588 | "extract the ~80-line federation switch to `runTeamFederationRpc`" | Correct, **plus** a second extraction is needed for the consent-listener (see §4) | **Un-exclude (two-extraction refactor)** |
| `cli/src/commands/start.ts` | 258 | "likely demotes to documented" | Confirmed — irreducible subprocess/socket/timer glue (see §5) | **Document (add rationale comment)** |
| `ipc/server/options.ts` | 103 | "boot shell; likely stays documented" | **Pure `export type`, zero executable lines** — type-only, not a shell (see §6) | **Reclassify → type-only (b), regroup now** |
| `repl`/`doctor`/`policy`/`admin`/`chatops` | 18–100 | "thin IPC shells, cores covered → keep documented" | Confirmed — already documented with accurate comments | **No change** |

## 3. `imap-client.ts` — un-exclude (verify-only)

The umbrella spec assumed the ImapFlow seam still had to be built. It does not: the file **already
carries** the `ImapClientLike` structural interface and an injectable `ImapClientFactory`
(`fetchImapMessages(config, limit, makeClient = defaultImapClientFactory)`), and
`imap-client.test.ts` **already exists** with full coverage:

- Every pure helper: `capPreview`, `addresses`, `findTextPlainPart`, `extractAttachments`,
  `previewFromParts`, `toInput` (incl. the missing-envelope / string-date / undefined-structure arms).
- `fetchImapMessages` through a fake factory: most-recent-sorted-by-uid, empty mailbox (no fetch),
  unselectable mailbox (`false`), connect-failure `{ ok:false }`, fetch-throws-still-logs-out.
- The real `defaultImapClientFactory` line via a port-1 loopback refusal (`{ ok:false }`).

**The stale exclusion comment is wrong** — it claims "no injection seam," written before the seam
landed and never updated when the exclusion should have been dropped.

**D2 action:** remove the `exclusions.ts` entry (lines ~114–119) for `imap-client.ts`. It is **not**
present in `sonar-project.properties` `sonar.coverage.exclusions` (confirmed), so no Sonar edit is
needed. Confirm ≥80% line+branch in the Docker dry-run and the PR merge lcov; the tests already run
in the gateway suite, so this is a one-line removal that rejoins the floor at high headroom. If the
dry-run surfaces a sub-80 branch (unlikely given the test breadth), add the targeted arm before push
— but the bar is honest: if a branch genuinely can't be reached without a real socket, the file
stays documented instead.

## 4. `team.ts` — un-exclude via two extractions

**Current coverage:** `parseTeamArgs` (`team.test.ts`) and `runTeamVaultRpc` (`team-vault.test.ts`
via `runTeamCommand`) are covered. **Uncovered:** the federation switch inside `runTeam`
(`discover` / `namespacePublish` / `namespaceGrant` / `namespaceRevoke` / `query` / `whoKnows` /
`pair` / `consent` / `audit`), the helpers `respondToConsent`, `renderAuditTable` + `cellText`, and
`runConsentListener`.

**Why one extraction is not enough:** extracting only the federation switch leaves
`runConsentListener` (~35 lines, ~6 branches) uncovered. Its body is **real logic** — parse the
notification params, `confirm()` the prompt, `isCancel` → leave-to-timeout (do **not** submit a
deny), `client.call("federation.consentRespond", …)`, error-handling — wrapped around an irreducible
`await new Promise<void>(() => {})` infinite wait that runs until Ctrl-C. The infinite wait is
untestable; the logic around it is not.

**Decision (chosen 2026-06-14):** extract **both** testable units, leaving only the irreducible
shell residual in `runTeam`:

1. **`runTeamFederationRpc(client, cmd): Promise<void>`** — the federation `switch` (everything
   except `listen`), taking a `TeamRpcClient` (the existing `{ call }` interface). Folds in
   `respondToConsent` (currently typed `IPCClient` but only uses `.call` → widen to `TeamRpcClient`)
   and the `audit` rendering (`renderAuditTable`/`cellText`). Mirrors the existing
   `runTeamVaultRpc(client, cmd)` sibling exactly.
2. **`handleConsentNotification(client, params): Promise<void>`** — the body of the
   `client.onNotification("federation.consentRequest", …)` callback. Takes `TeamRpcClient` +
   `unknown` params; covers the typeof-requestId guard, the `confirm`/`isCancel` branches, the
   respond call, and the error arm. `runConsentListener` shrinks to the irreducible
   `onNotification(handler) + await new Promise(()=>{})` registration + infinite wait.

**Residual `runTeam` shell (stays uncovered, no branches that matter):** read gateway state,
construct the real `IPCClient`, `connect`, dispatch `runTeamVaultRpc` ‖ `runConsentListener` (for
`listen`) ‖ `runTeamFederationRpc`, `disconnect` in `finally`. This is the same thin-IPC-shell
residual as the un-excluded D1 files — ~30 lines, no decision logic.

**Tests (new `team-federation.test.ts`, or extend `team.test.ts`):** drive `runTeamFederationRpc`
with a fake `TeamRpcClient` for each federation subcommand (assert the right method + params +
stdout/exit-code), incl. the `audit` empty-vs-rows rendering and the `consent` matched/unmatched/
error arms; drive `handleConsentNotification` for approve / deny / cancel-leaves-to-timeout / bad
params / call-error. Output captured via the existing `captureOutput` helper; no `process.std*`
global reliance (B10/B13 cross-file-leak lesson). **No `mock.module`** — DI only (the cli combined
run is process-global; `team.ts` is the unit under test and its deps are injected).

**Coverage estimate:** covered = `parseTeamArgs` + `runTeamVaultRpc` + `runTeamFederationRpc` +
`handleConsentNotification` + `renderAuditTable`/`cellText` + `respondToConsent`; uncovered = the
`runTeam` shell (~30L) + the `runConsentListener` registration/infinite-wait (~6L). ≈ 94% line and
all material branches → clears the ≥80% floor with headroom.

**Sonar:** `team.ts` **is** in `sonar.coverage.exclusions` (line 74) with a comment block (lines
68–73). Remove the path from the list **and** delete the now-stale comment block (umbrella spec
trap: "if you remove a file from gate `exclusions.ts`, also remove it from
`sonar-project.properties`").

**Zero behavior change:** the extractions are pure code moves behind the same public `runTeam(argv)`
signature; no CLI behavior, output, or exit code changes. No invariant is touched (team.ts is a CLI
client over IPC; the federation gates live gateway-side).

## 5. `start.ts` — document (add rationale comment)

`decideStartAction` and `wantsNoWizard` are exported and unit-tested; `start.test.ts` additionally
drives the single "already-running reuse" `runStart` path through the `cli-mocks` fixture. The
remainder is irreducible: `spawnGateway` (subprocess), `waitForGatewayReady` /
`probeSocketReachable` (socket race + 250 ms poll loop), `maybePrintFirstRunHints` (30-iteration
TTY-gated onboarding loop), `reportGatewayNotReady` (SIGTERM + state-file unlink). Driving these to
80% needs fixture + fake-timer machinery against mocked I/O for marginal, vanity coverage —
**honest-shrink keeps it documented.**

**D2 action:** the `start.ts` entry in `exclusions.ts` is currently a **bare line with no rationale
comment** (unlike `team`/`policy`/`admin`/`chatops`). Add a comment in the same style: the testable
pure helpers (`decideStartAction`, `wantsNoWizard`) are exported + unit-tested; the residual is
subprocess/socket/timer boot glue with no injection seam (same class as a connector `server.ts`).
Stays in both `exclusions.ts` and `sonar.coverage.exclusions`.

**Observed-but-out-of-scope (flag in the spec, do NOT fix in D2 — scope creep):**
`resolveReadyWaitTimeoutMs` is the only untested pure logic, and `decideStartAction` is **dead**
(`runStart` inlines the equivalent decision via `handleExistingGatewayState`, never calling
`decideStartAction`). Both are pre-existing; a separate cleanup PR can extract/remove them. D2
**characterizes existing structure**, zero behavior change.

## 6. `ipc/server/options.ts` — reclassify to type-only (b), regroup now

The umbrella spec guessed "boot shell." The read shows otherwise: the file is **100% type
declarations** — `export type BunSessionData` and `export type CreateIpcServerOptions` over a block
of `import type` lines, with **zero executable statements**. Like the `types.ts`/`-types.ts` regex
class and the documented `chatops/transport/transport.ts`, it emits **no `SF:` lcov record**, so the
gate reads it as 0% and it can **never** rejoin the floor. It is bucket (b) type-only, not (d)
documented-shell.

**D2 action (chosen 2026-06-14 — reclassify now, not deferred to D3):** move the `options.ts`
exclusion entry next to the type-only cluster in `exclusions.ts` and give it the type-only
rationale (zero executable lines / no `SF:` record — same class as the `types.ts` basenameRegex and
`transport.ts`). It stays excluded; this is a **comment/placement correction only**, no code change.
It remains in `sonar.coverage.exclusions` (Sonar also reads it as uncoverable). This pre-does the
small slice of D3's type-only grouping that D2's read surfaced — D3 still owns grouping the
remaining type-only files.

## 7. Scope summary

| File | Action | exclusions.ts | sonar.coverage.exclusions |
|---|---|---|---|
| `imap-client.ts` | **Un-exclude** (verify-only; tests exist) | Remove entry | Absent (no edit) |
| `team.ts` | **Un-exclude** (extract `runTeamFederationRpc` + `handleConsentNotification` + tests) | Remove entry | Remove path + comment block |
| `start.ts` | **Document** | Add rationale comment | Keep |
| `ipc/server/options.ts` | **Reclassify** type-only | Move to type-only block + comment | Keep |
| `repl`/`doctor`/`policy`/`admin`/`chatops` | No change | — | — |

**Expected baseline outcome:** both un-excluded files land ≥80% → **no new `files` entry**
(`coverage-baseline.json` `files` stays `{}`; the flagship `targets` overlay round-trips untouched).
A clean D2 PR keeps `files: {}`. If `imap-client` or `team` were to land <80, that is a failed
honest-shrink call → the file stays documented, **not** added to the baseline.

## 8. Coverage mechanics & traps (D touches coverage — CI-Linux-authoritative)

Identical to the umbrella spec §5 — do **not** deviate:

1. **Local dry-run** with `scripts/coverage-floor/reseed-docker.sh` (oven/bun:latest = Linux-
   authoritative) to confirm the suite passes and both un-excluded files cross 80%.
2. **Open the PR**; let the merge-commit CI run.
3. **Reseed the committed baseline from the PR's OWN merge lcov** only:
   `gh run download <pr-run-id> -n coverage-lcov-merged` → `cp` to `coverage/lcov.info` →
   `bun run audit:coverage-floor:update-baseline`. **Never** from local Docker or main.
4. **Confirm** both un-excluded files are absent from the baseline `files` (i.e. cleared the floor),
   not merely that the gate says `ok` (the B4/B5 ratcheted-but-stuck-below-80 trap).

Watch the three drift classes on **untouched** files: (a) environment drift (revert to main),
(b) incidental-coverage (my tests exercise siblings — accept; CI reproduces), (c) stale-main-
watermark (the merge lcov agrees with Docker — keep the higher value). Disambiguate from the PR
merge lcov, never guess from main. Verify the flagship `targets` (`executor.ts`,
`tool-output-envelope.ts` @100/100) survive each reseed.

Since `team.ts` is a CLI file, watch the **`mock.module` process-global** trap: this PR uses DI
only; `team.ts` is the unit under test (deps injected), so it is not shadowed like
`gateway-process.ts` (D1's demotion). Its real code executes and earns real coverage.

## 9. Invariants, testing & code-quality bars (carry from umbrella §7)

- **DI seams = pure code moves / visibility exports, zero behavior change.** No `mock.module`
  (process-global; leaks in the combined cli run) — DI only.
- **No `any`** (use `unknown`), **no `biome-ignore`**, **no `istanbul-ignore`**. A provably-dead
  branch is removed via a type-safe refactor, never suppressed. (`decideStartAction` dead-code +
  `resolveReadyWaitTimeoutMs` are flagged out-of-scope, §5 — not "fixed" in D2.)
- **No new invariant.** `team.ts` is a CLI IPC client; federation authorization gates are gateway-
  side (`query-gate.ts` / `invoke-gate.ts`). The extractions move no gate and add no `*.message.post`
  or KB-append tool id. `security-invariants.test.ts` (currently 69/69) + `audit:invariants` stay
  green in the same PR.
- **Tests** follow the cli/connector exemplars: deterministic, `captureOutput` for stdio,
  URL-keyed/`fetch` fakes restored in `afterEach`, no reliance on global `process.std*`/`env`
  defaults (B10/B13 lessons).

## 10. CI gates & doc traps (carry forward)

- Authoritative gate = **"PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage"**; the
  windows-2025 cross-platform red is the chronic flake (rerun).
- **markdownlint** is a CI gate: run `bun run lint:markdown` from **inside the worktree** and read
  the output; a wrapped prose line must never begin with a plus-then-space (MD004); `--fix` can
  corrupt prose — re-verify.
- **biome** `bun run lint` false-fails in a `.claude/worktree` → validate changed files via
  `bunx biome check packages scripts`.
- Fix + resolve every CodeRabbit + Sonar thread (branch protection BLOCKS merge on any unresolved
  conversation). Keep-as-is for the user's squash-merge.

## 11. Success criteria (DoD for D2)

- `imap-client.ts` un-excluded, ≥80% line+branch in the PR merge lcov, absent from baseline `files`.
- `team.ts` un-excluded via `runTeamFederationRpc` + `handleConsentNotification` extractions + tests,
  ≥80% line+branch, absent from baseline `files`; public `runTeam` signature + behavior unchanged.
- `start.ts` documented with an accurate rationale comment; stays excluded.
- `ipc/server/options.ts` regrouped under the type-only block with corrected rationale; stays excluded.
- `coverage-baseline.json` `files` stays `{}`; flagship `targets` intact; invariants 69/69 green.
- PR green on the authoritative gate; all review threads resolved.
- On merge: memory updated; **D3 is the only remaining slice → program close in sight.**

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `imap-client` lands <80 after un-exclude (unexpected branch gap) | Docker dry-run first; if a branch needs a real socket, add the arm or keep documented (honest-shrink) — never baseline it |
| `team.ts` extraction changes CLI behavior | Pure code moves behind the same `runTeam(argv)` signature; assert output/exit-code parity in tests; zero behavior change |
| `runConsentListener` infinite-wait drags branch coverage | Extract `handleConsentNotification` (the logic) out; leave only the irreducible `await new Promise(()=>{})` registration in the shell |
| Reseed picks up environment/incidental/stale drift on untouched files | Reseed from the PR's own merge lcov; disambiguate the three drift classes per §8 |
| `mock.module` leak from a cli test | DI only; `team.ts` is the unit under test with injected deps — not shadowed |
| markdownlint `+`-as-bullet / suppressed-output regression | Run `lint:markdown` in-worktree, read output, comma prose |
