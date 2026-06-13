# Spec Review — True Coverage Sub-project D (Shrink exclusions)

**Date:** 2026-06-13
**Reviewer:** adversarial design review (empirically verified against the tc-D worktree)
**Spec:** [`2026-06-13-true-coverage-D-shrink-exclusions-design.md`](./2026-06-13-true-coverage-D-shrink-exclusions-design.md)
**Verdict:** Sound to proceed to planning after the 3 MAJOR fixes below. No architectural BLOCKERs.

Each finding is dispositioned **FIX** (corrected in the spec), **DEFER** (handled at plan time),
or **EXPLAIN** (no change, rationale recorded). Confirmed-correct claims are listed last.

## MAJOR

1. **`chatops-tool-runner-e2e-sink.ts` is NOT test-only — production boot (`assemble.ts`) statically
   imports it.** `assemble.ts:13-16` imports `buildE2eSinkDispatcher`/`buildE2eSinkRunChatopsTool`
   and calls them at runtime (assemble.ts:1060/1332/1340) when `NIMBUS_CHATOPS_E2E_SINK_DIR` is set.
   Relocating it under `testing/` would point a production import into the coverage-skipped tree.
   The exclusions.ts comment ("imported solely by *.test.ts") is factually wrong.
   → **FIX.** §3(c) and §4 D3 now treat it as a separate **env-gated production-imported** case:
   keep excluded, **do not relocate**, correct the comment to "env-gated (`NIMBUS_CHATOPS_E2E_SINK_DIR`),
   inert in a normal boot" rather than "test-only." Only the 4 genuine pure test-helpers relocate.

2. **D2 prejudgment "start.ts/team.ts likely real; cores already covered" is half-wrong.**
   `team.ts`: `runTeamCommand` (the covered core) only handles the vault subset via
   `runTeamVaultRpc`; the ~80-line **federation switch** (discover/grant/query/pair/audit…) lives
   inside `runTeam` and is uncovered — a real extraction opportunity, not "core already covered."
   `start.ts` (258L) is mostly irreducible subprocess/socket I/O glue (`spawnGateway`,
   `IPCClient.connect` races, ready-polling, log-tailing), not arg-routing — honest-shrink likely
   **demotes most of it to documented**.
   → **FIX.** §4 D2 reframed to "triage on read": team.ts win = extract the federation switch to an
   injectable `runTeamFederationRpc(client, cmd)` sibling (mirrors `runTeamVaultRpc`); start.ts
   likely demotes to documented (extract its 3 small pure helpers if not already covered).

3. **`embedding-worker.ts` (133L) carries non-trivial INLINE orchestration**, not a thin shell:
   `setupDb`, the init IIFE (embedder + pipeline + backfill), `embed_texts`/`embed_item` handlers,
   and a serialized `embedChain` promise queue. Extraction is a real refactor (an
   `EmbeddingWorkerCore` taking injected `sendToMain`/db/embedder), not a quick probe.
   `query-guard-worker.ts` (27L) IS genuinely thin (security check already in `worker-security.ts`).
   → **FIX.** §6 now flags embedding-worker as needing a real, budgeted extraction; query-guard
   stays a documented thin shell. The documented exclusion remains the guaranteed fallback for both.

## MINOR

1. **`connectors/mapped-row.ts` double-listed** in §3(b) (correct, type-only) and §3(d) (stray
   duplicate). → **FIX.** Removed the §3(d) mention.

2. **`chatops/transport/transport.ts` not folded into the type-only group.** It is a 9th type-only
   file (existing comment confirms). → **FIX.** Added to the §3(b) group (now 9 files); D3 folds it
   into the shared type-only block.

3. **`cli/src/commands/tui.tsx` had no disposition.** React/Ink entry point. → **FIX.** Assigned to
   §3(d) genuinely-untestable (UI entry).

4. **Per-file relocation importer counts** (for D3 churn budget): `tui/test-helpers/context.ts` → 2
   (both tests); `identity/identity-test-helpers.ts` → 5 tests; `updater/updater-test-fixtures.ts`
   → 3 tests; `cli-test-helpers.ts` → ~0 importers (**possibly dead config** — confirm at plan time,
   may be a delete not a relocate). → **DEFER** to D3 plan (counts recorded here).

## NIT

1. **Seam signature changes understated.** team-tool-spawn, chatops-bot-spawn-call, and mdns-provider
   currently have NO injection point — each needs a new optional param / ctor-default (still
   zero-behavior-change per §7, but a real small public-signature edit). → **EXPLAIN/FIX.** Added a
   one-line note after the §3(a) table; §7 already covers the zero-behavior-change bar.

2. **mdns fake typing caveat:** `InstanceType<typeof BonjourLib>` makes the fake non-trivial to type
   without `any` (forbidden). → **DEFER** to D1 plan (use a structural interface for the seam, not
   the imported class type).

3. **chatops-bot happy-path also needs the seam** (tool-not-found + `${platform}_${toolId}` fallback
    branches), not just the creds-absent throw. → **EXPLAIN.** Already implied by "injected
    client-factory covers the happy path"; the plan will enumerate the branches.

## Confirmed correct (claims that empirically hold — no change)

- `cli/lib/gateway-process.ts` spawns nothing; pure state-file + `isProcessAlive` helpers →
  ≥80% with temp-dir/own-pid tests, no seam. **Slam-dunk.**
- `team-tool-spawn.ts` spawner-injection does **not** violate D15 static (`'teamvault.'` prefix
  check only) nor the I19 runtime test (which injects at the `invoke-gate`/`team-tool-invoke`
  layer, not `spawnTeamToolAndCall`); I1/I15 live inside the real spawners the seam *selects*.
- `chatops-bot-spawn-call.ts` creds-absent path throws **before** `new MCPClient`; not confined by
  any static audit (D17 only confines `slack_chat_post`/`teams_chat_post`; I15 is `lazy-mesh/`-scoped).
- All 8 (now 9 incl. transport) type-only files have **zero executable lines** — correct category.
- `sdk/testing/sandbox-probe.ts` exact exclusion **is** redundant (check.ts:160 `/testing/` skip).
- `repl.ts`/`doctor.ts` are genuinely thin (delegate to injected-deps `*-core.ts`) → documented.
- §5 reseed mechanics (PR-own-merge-lcov, removed-set check, `targets` round-trip, 3 drift classes)
  are consistent with the verified `check.ts` logic.
