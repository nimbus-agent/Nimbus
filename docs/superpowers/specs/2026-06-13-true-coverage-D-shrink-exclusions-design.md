# True Coverage — Sub-project D: Shrink exclusions (Design)

**Date:** 2026-06-13
**Branch:** `dev/asafgolombek/true-coverage-D` (worktree `.claude/worktrees/tc-D`, off `origin/main` 4d63cada)
**Status:** Design — awaiting review
**Owner:** AsafGolombek
**Umbrella spec:** [`2026-06-07-true-coverage-program-design.md`](./2026-06-07-true-coverage-program-design.md) §8 (D sketch), §5.3 (Worker probe), §5 (policy)

## 1. Goal

D is the **final** sub-project of the True Coverage program. On merge, the program
(A · B · ★ Flagship · C · **D**) is complete.

Walk the ~40 entries in `scripts/coverage-floor/exclusions.ts`. For each I/O shell where
logic can be extracted behind an injection seam (DI à la PR #505 `imap-client` and the
B-series DI seams), refactor + add tests + **drop the exclusion** so the file rejoins the
≥80% line+branch floor. Document the genuinely-untestable with per-category rationale, and
resolve the deferred §5.3 Worker-instrumentation probe.

**Guiding philosophy — honest-shrink (chosen 2026-06-13):** un-exclude a file *only* where a
clean DI seam yields genuinely meaningful tests (real orchestration logic exercised, not
"the wrapper called the injected factory"). This mirrors the #505 `imap-client` model
(extract logic to covered siblings, leave the irreducible thin shell excluded) and the
program's anti-vanity stance. Forcing a seam into a 3-line `process.exit` wrapper just to mark
it covered is exactly the vanity the program avoids.

## 2. The 2 line-debt files are already cleared (no-op)

The program spec §8 lists "clear the 2 debt files (`gmail/history.ts`, `gmail-sync.ts`) over
80%." **This is already done** — Sub-project B6 (PR #575) cleared both, and Sub-project B
drove `coverage-baseline.json` `files` to `{}` (every non-flagship file clears the floor).
Neither file appears in `exclusions.ts`. D's handling: **verify-only** (confirm absent from
both `files` and exclusions; no work).

## 3. Categorization of the ~40 entries (the first concrete step)

Every entry receives one of five dispositions:

### (a) DI-refactorable I/O shells — *un-exclude* (the real work)

Files with real executable logic reachable behind a clean seam:

| File | LOC | Seam | Notes |
|---|---|---|---|
| `cli/src/lib/gateway-process.ts` | 67 | **none** | Despite the name it spawns nothing now — pure state-file helpers (`isGatewayStateRaw`, `readGatewayState`, `gatewayStatePath`, `ensureGatewayDirs`) + `isProcessAlive`. Slam-dunk, temp-dir + own-pid tests. |
| `federation/mdns-discovery-provider.ts` | 54 | bonjour factory (ctor default) | `find`-callback host-extraction (`addresses[0] ?? host` + type guards), `advertise`/`stop`/`list`/`addManualPeer`. |
| `teamvault/team-tool-spawn.ts` | 78 | spawner injection (optional param, real default) | `spawnerFor` map lookup + spawn/call/not-found/disconnect lifecycle without a subprocess. **⚠️ I19/D15** — seam injects *which spawner*, never touches the spec-build / `extensionProcessEnv` (I1) / `wrapServerSpec` (I15) path. |
| `chatops/chatops-bot-spawn-call.ts` | 55 | client-factory injection | A creds-absent `vaultView` drives the fail-closed `servers===undefined` throw with no subprocess; injected client-factory covers happy/not-found/disconnect. **⚠️ I15/I23** — reuses the already-covered sandbox-wrapped spec builders, authors no `ServerSpec`. |
| `platform/sandbox/sandbox-wrapper.ts` | 66 | TBD (read in planning) | Include in D1 only if a clean seam clears ≥80%; else demote to documented. |
| `client/src/stream-events.ts` | 47 | TBD (read in planning) | Include in D1 only if a clean seam clears ≥80%; else demote to documented. |

> **Seam-signature note:** `team-tool-spawn`, `chatops-bot-spawn-call`, and `mdns-discovery-provider`
> currently have **no** injection point — each un-exclude adds a new optional param / ctor-default
> (still zero-behavior-change per §7, but a real small public-signature edit, not a pure test
> addition). The mdns fake should be typed against a **structural interface** for the seam, not the
> imported `InstanceType<typeof BonjourLib>` class type (avoids an `any`).

### (b) Type-only / zero-executable — *keep excluded, document + group* (decided: no rename)

These emit **no `SF:` lcov record** (zero executable lines) → the gate reads them as 0% and
they can **never** rejoin the floor — same class as the `types.ts`/`-types.ts` `basenameRegex`
and the documented `chatops/transport/transport.ts`. They are not I/O shells; there is nothing
to test.

`index/ranked-item.ts`, `embedding/embedding-runtime.ts`, `vault/nimbus-vault.ts`,
`ipc/agent-invoke.ts`, `ipc/workflow-invoke.ts`, `connectors/mapped-row.ts`,
`ipc/connector-rpc-handlers/context.ts`, `connectors/lazy-mesh/slot.ts`, and the
already-documented `chatops/transport/transport.ts` (9 files total — `transport.ts` is the same
class, just currently commented separately).

**Disposition (D3):** move all 9 into a single clearly-labeled "type-only / zero executable lines"
block in `exclusions.ts` with a shared rationale comment. **No rename** (avoids import churn
across every consumer for marginal gain; decided 2026-06-13).

### (c) Test-only support — *relocate to make exemption self-enforcing*

`discoverSourceFiles` (check.ts:160) already auto-skips any `/testing/` path (verified).

**Genuine pure test-helpers → relocate under a `testing/` dir** (e.g. `cli/src/tui/testing/context.ts`),
update importers, **drop the exact exclusions** (importer counts from grep, for the D3 churn budget):

- `cli/src/tui/test-helpers/context.ts` → 2 test importers.
- `gateway/src/identity/identity-test-helpers.ts` → 5 test importers.
- `gateway/src/updater/updater-test-fixtures.ts` → 3 test importers.
- `cli/src/commands/cli-test-helpers.ts` → ~0 importers — **possibly dead config**; D3 plan confirms,
  then either delete the file outright or relocate.

**Already self-enforcing / redundant:**

- `sdk/src/testing/sandbox-probe.ts` is **already** under a `testing/` dir → already auto-skipped →
  its exact exclusion is **redundant dead config**: delete the entry (D3).

**NOT a test-helper — keep excluded, correct the comment (⚠️ MAJOR review finding):**

- `gateway/src/chatops/chatops-tool-runner-e2e-sink.ts` is **statically imported by production boot**
  (`platform/assemble.ts:13-16`, called at runtime when `NIMBUS_CHATOPS_E2E_SINK_DIR` is set) — the
  current exclusions.ts comment "imported solely by *.test.ts" is **false**. Relocating it under
  `testing/` would point a production import into the coverage-skipped tree. **Do NOT relocate.** Keep
  it excluded and **correct the comment** to "env-gated (`NIMBUS_CHATOPS_E2E_SINK_DIR`), inert in a
  normal boot — the file-backed mock ChatOps transport" (moves to category (d), genuinely-untestable).

### (d) Genuinely-untestable — *document with per-category rationale*

Keep excluded; D3 ensures each carries a clear category comment.

- **FFI (Vault):** `vault/{win32,darwin,linux,ffi-ptr}.ts` — DPAPI / Keychain / libsecret FFI.
- **Platform-gated:** `platform/{win32,darwin,linux,browser}.ts`, `platform/sandbox/{linux,darwin,win32,orphan-reap,sandbox-runner}.ts` — OS-specific; a single CI-Linux runner takes one branch per OS.
- **Boot orchestrators / index barrels / factories:** `gateway/src/index.ts`, `cli/src/index.ts`, `platform/assemble.ts`, `platform/assemble-sync-registrations.ts`, `platform/index.ts`, `platform/sandbox/index.ts`, `connectors/index.ts`, `vault/factory.ts`, `ipc/server/options.ts` (unless D2 finds a seam), `sdk/src/ipc/index.ts`, `client/src/index.ts`.
- **Workers:** `db/query-guard-worker.ts`, `embedding/embedding-worker.ts` — see §6.
- **Generated SQL:** `index/*-v\d+-sql.ts` (pathRegex).
- **Connect-shell regexes:** `mcp-connectors/*/src/{server,tools}.ts`, `github-actions/*/src/main.ts`.
- **Benchmarks / native:** `perf/` (dirPrefix), `src-native/` (dirPrefix).
- **UI / React-Ink entry:** `cli/src/commands/tui.tsx` (renders the Ink TUI; not unit-testable as a shell).
- **Env-gated production-imported mock:** `chatops/chatops-tool-runner-e2e-sink.ts` (see (c) — moved here, comment corrected).
- **Real-subprocess / socket shells the seam doesn't reach:** `embedding/load-feature-extraction-pipeline.ts` (one-line dynamic `import()` of `@xenova/transformers` — no meaningful seam).

### (e) The 2 debt files — verify-only (see §2)

## 4. Slicing (3 PRs, value-first, each its own plan+PR)

Final per-file assignment firms up in each slice's plan, but the structure is fixed.

### D1 — Gateway I/O-shell un-excludes (high-value, clean seams)

`cli/lib/gateway-process.ts`, `federation/mdns-discovery-provider.ts`,
`teamvault/team-tool-spawn.ts`, `chatops/chatops-bot-spawn-call.ts`, and
`platform/sandbox/sandbox-wrapper.ts` + `client/src/stream-events.ts` **if** they clear ≥80%
with a clean seam (else demoted). Coverage-touching → reseed dance (§5). Security-care on
`team-tool-spawn` (I19) and `chatops-bot-spawn-call` (I15/I23).

### D2 — Heavy / borderline triage

Each file kept **only if** it genuinely clears ≥80% with *real* tests, else documented as
irreducible:

- `connectors/_lib/imap-client.ts` (227L) — `ImapFlow`-factory seam over the fetch
  orchestration (structure walk, preview part selection, BODYSTRUCTURE/ENVELOPE mapping,
  `{ok}` outcome shaping). Pure helpers (`capPreview`, `leafParts`) testable directly.
- `ipc/server/options.ts` (103L) — boot shell; likely stays documented.
- **CLI command wrappers** `start`/`team`/`policy`/`admin`/`chatops`/`repl`/`doctor`:
  **triage on read** (decided 2026-06-13; size is not a proxy for testable logic — review finding):
  - `team.ts` (588L): the covered core `runTeamCommand` only handles the **vault subset**
    (`runTeamVaultRpc`); the ~80-line **federation switch** inside `runTeam`
    (discover/grant/query/pair/audit…) is uncovered. The real win = **extract it to an injectable
    `runTeamFederationRpc(client, cmd)` sibling** (mirrors `runTeamVaultRpc`) + test → then the
    residual `runTeam` is a thin IPC shell. A real refactor, not a one-line seam.
  - `start.ts` (258L): mostly **irreducible subprocess/socket I/O glue** (`spawnGateway`,
    `IPCClient.connect` races, ready-polling, log-tailing) — large because of I/O, not routing.
    Honest-shrink likely **demotes most of it to documented**; extract its small pure helpers
    (`decideStartAction`/`wantsNoWizard`/`resolveReadyWaitTimeoutMs`) only if not already covered.
  - `repl.ts`/`doctor.ts` (~18L): genuinely thin — already delegate to injected-deps
    `repl-core.ts`/`doctor-core.ts` (the #505 pattern). **Stay documented.**
  - `policy`/`admin`/`chatops` (~100L): triage per-file; cores (`parseXArgs`/`runXCommand`) covered,
    residual `runX` is an `IPCClient`+`process.exit` shell — keep documented unless a federation-switch
    -style extraction surfaces real logic.

### D3 — Program close (the finale)

- Relocate the **4 genuine pure test-helpers** to `testing/` dirs (confirm `cli-test-helpers.ts`
  isn't dead first) + delete the redundant `sandbox-probe.ts` entry (c). **Do NOT relocate**
  `chatops-tool-runner-e2e-sink.ts` (production-imported via `assemble.ts`) — correct its comment and
  move it to (d).
- Group + document the **9 type-only files** in one block (b).
- Per-category rationale pass over the genuinely-untestable bucket, incl. `tui.tsx` (d).
- **Worker handling (resolves §5.3):** see §6.
- Verify the 2 debt files (e).
- Final `exclusions.ts` fully categorized & commented → **PROGRAM COMPLETE** (update CHANGELOG
  and memory).

## 5. Coverage mechanics & traps (D touches coverage — unlike C)

Dropping an exclusion changes the instrumented file set **and** `coverage-baseline.json`, so D
is **CI-Linux-authoritative for coverage-floor**. The ironclad B-series rule:

1. Local dry-run with `reseed-docker.sh` (oven/bun:latest = Linux-authoritative; recipe in the
   workstream memory) to confirm tests pass + the target files cross 80%.
2. Open the PR; let the merge-commit CI run.
3. **Reseed the committed baseline from the PR's OWN merge-commit lcov**:
   `gh run download <pr-run-id> -n coverage-lcov-merged` → `cp` to `coverage/lcov.info` →
   `bun run audit:coverage-floor:update-baseline`. **NOT** from local Docker or main.
4. Confirm **every** un-excluded file is in the baseline's **removed** set (diff baseline vs
   main) — not just that the gate says `ok` (the B4/B5 "ratcheted-but-stuck-below-80" trap: a
   file can improve yet stay <80 and remain baselined).

Watch the three drift classes on **untouched** files (B7/B9): (a) environment drift
(revert to main), (b) incidental-coverage (my tests exercise siblings — accept, CI reproduces),
(c) stale-main-watermark (main never reseeded; the merge lcov agrees with Docker — keep the
higher value). Disambiguate with the PR merge lcov, never guess from main.

The flagship `targets` overlay (`executor.ts`, `tool-output-envelope.ts` at 100/100) is
**untouched** — `update-baseline` round-trips `targets` verbatim; verify they survive each reseed.

Since `files` is currently `{}`, **un-excluding a file that lands ≥80 adds NO baseline entry**
(it just rejoins the floor at 100% headroom). If an un-excluded file lands *below* 80 it would
add a `files` entry — that is a **failure of the honest-shrink bar** for that file → it should
have stayed documented, not un-excluded. So a clean D PR keeps `files: {}`.

## 6. Worker handling — resolving the §5.3 deferred probe

The 2 Bun Workers (`db/query-guard-worker.ts`, `embedding/embedding-worker.ts`) run in a
separate realm the `[test].preload` istanbul plugin cannot reach (parity with Bun's native
`--coverage`, which also misses workers).

The two workers differ in shape (review finding — verified):

- **`query-guard-worker.ts` (27L):** genuinely thin — the security check already lives in a sibling
  (`worker-security.ts`); the `onmessage` just opens a readonly DB, runs SQL, posts back. Little to
  extract → **stays a documented thin onmessage shell**.
- **`embedding-worker.ts` (133L):** **NOT thin** — it carries real inline orchestration (`setupDb`
  migrations+vec-load+pragmas, the init IIFE wiring embedder+pipeline+backfill, the
  `embed_texts`/`embed_item` handlers, and a serialized `embedChain` promise queue). Honest-shrink
  here is a **real, budgeted refactor**: extract to an `EmbeddingWorkerCore` taking injected
  `sendToMain`/db/embedder and unit-test the dispatch + queue serialization directly; the residual
  `onmessage` wiring stays documented. **Not** a quick probe.

**Honest-shrink approach — prefer extract-over-instrument:**

1. Extract each worker's non-trivial logic to a pure/injectable sibling and unit-test it directly
   (the #505 pattern) — no worker realm needed. Budget for `embedding-worker` being a real extraction.
2. Run the §5.3 realm-instrumentation probe (a worker-side preload re-register + `__coverage__`
   flush) **only if** non-trivial logic is irreducibly in-realm after extraction. Time-boxed; if
   cheap, instrument and drop the exclusion; otherwise the documented exclusion stands as the
   accepted fallback (reviewer concurred this is solid).

Either path **terminates** with a documented outcome. The probe is not on the critical path —
the documented exclusion is the guaranteed fallback.

## 7. Invariants, testing, and code-quality bars

- **DI seams** = optional-param-real-default / visibility-export, **zero behavior change**
  (B-series precedent). No `mock.module` (process-global; leaks in the combined cli run) — DI only.
- **No `any`** (use `unknown`), **no `biome-ignore`**, **no `istanbul-ignore`**. A provably-dead
  branch is removed via a type-safe refactor (§5 policy / the flagship `serviceOf` precedent),
  not suppressed.
- **Security invariants:** the `team-tool-spawn` (I19/D15) and `chatops-bot-spawn-call`
  (I15/I23) seams must leave the spec-build/sandbox path untouched; assert
  `security-invariants.test.ts` (currently 69/69) + `audit:invariants` (static D10/D15/D17)
  stay green in D1.
- **Tests** follow the connector/cli exemplars already in the tree (real in-memory SQLite, no DB
  mocks; URL-keyed `globalThis.fetch` fakes restored in `afterEach`; deterministic state — no
  reliance on global `process.std*`/`env` defaults per the B10/B13 cross-file-leak lessons).

## 8. CI gates & doc traps (carry forward)

- Authoritative gate = **"PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage"**; the
  windows-2025 cross-platform red is the chronic flake (rerun).
- **markdownlint** is a CI gate on docs: run `bun run lint:markdown` from **inside the worktree**
  and **read the output** (never suppress it in a chained command). A wrapped prose line must
  never begin with a plus-then-space (markdownlint reads it as an MD004 bullet) — use comma prose.
  `markdownlint-cli2 --fix` can corrupt prose — re-verify after `--fix`.
- **biome** `bun run lint` false-fails in a `.claude/worktree` (`!**/.claude` exclude) → validate
  changed files via `bunx biome check <files>` or the temp-config trick.
- Fix + resolve every CodeRabbit + Sonar thread (branch protection BLOCKS merge on any
  unresolved conversation). Keep-as-is for the user's squash-merge.

## 9. Success criteria (DoD for the program)

- D1+D2: every file that clears the honest-shrink bar is un-excluded, tested ≥80% line+branch,
  and confirmed in the baseline's removed set; `files` stays `{}`; invariants green.
- D3: test-helpers relocated (self-enforcing); type-only + genuinely-untestable buckets fully
  categorized & documented; redundant `sandbox-probe.ts` entry deleted; §5.3 Worker probe
  resolved (instrumented or documented); debt files verified.
- All 3 PRs merged green on the authoritative gate; CHANGELOG + memory updated; **PROGRAM
  COMPLETE (A · B · ★ · C · D all ✅)**.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A seam weakens a security invariant (I19/I15/I23) | Seam injects only the client/spawner *selection*, never the spec-build/sandbox path; assert invariant tests + static audit green in the same PR |
| Un-excluded file lands <80 → adds a `files` entry | That's a failed honest-shrink call → keep it documented instead; a clean D PR keeps `files:{}` |
| Reseed picks up environment/incidental/stale drift on untouched files | Reseed from the PR's own merge lcov; disambiguate the three drift classes per §5 |
| Test-helper relocation breaks importers / CI | Update all importers in the same commit; `tsc` + scoped test run before push; `/testing/` auto-skip verified |
| Worker realm-instrumentation probe rabbit-holes | Time-boxed; documented exclusion is the guaranteed fallback; prefer extract-to-sibling |
| markdownlint `+`-as-bullet / suppressed-output regression | Run `lint:markdown` from in-worktree, read output, comma prose |
