# SonarCloud Cleanup 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the 13 live SonarCloud code smells on `nimbus-agent_Nimbus` to 0 and pragmatically reduce duplication, keeping the quality gate green.

**Architecture:** Fix-in-code, never rule-exclude. Behaviour-preserving edits guarded by the existing test suite (subsystems ~90.9% covered) + per-package `tsc --noEmit`. Commits grouped by rule-family. Stop before pushing.

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, Biome. Tests: `bun test` (gateway/cli/sdk), the security-invariants test for I22/I25.

**Spec:** `docs/superpowers/specs/2026-06-13-sonar-cleanup-7-design.md` (+ `-review.md`).

---

## Conventions for every task

- **Read with the worktree absolute path** (`C:/gitrep/Nimbus/.claude/worktrees/sonar-cleanup-7b/...`), never the bare `C:/gitrep/Nimbus/...` (that hits the main checkout — see `[[worktree-path-edit-gotcha]]`).
- **`tsc` is the oracle**, not `bun test`. After each gateway change: `cd packages/gateway && bun run typecheck`. CLI: `cd packages/cli && bun run typecheck`. SDK: `cd packages/sdk && bun run typecheck`.
- **Format before commit:** `bunx biome check --write --linter-enabled=false <changed files>` (worktree `bun run lint` false-fails — `[[biome-claude-worktree-lint-false-fail]]`).
- Line numbers are against base HEAD `1d504a23`; if an edit's `old_string` doesn't match, re-grep the construct (drift-safe).

---

## Task 1: S7735 negated conditions ×4 (Commit 1, part a)

**Files:**
- Modify: `packages/cli/src/commands/update.ts:62`
- Modify: `packages/gateway/src/updater/factory.ts:30`
- Modify: `packages/cli/src/commands/huddle.ts:38`
- Modify: `packages/gateway/src/ipc/index-reembed-rpc.ts:264`

- [ ] **Step 1: Edit `update.ts:62`** — invert the negated `!== undefined` and swap branches.

Before:
```ts
const channel = opts.channel !== undefined ? opts.channel : resolveDistributionChannel();
```
After:
```ts
const channel = opts.channel === undefined ? resolveDistributionChannel() : opts.channel;
```

- [ ] **Step 2: Edit `factory.ts:29-30`** — same inversion.

Before:
```ts
const channel =
  args._channelOverride !== undefined ? args._channelOverride : resolveDistributionChannel();
```
After:
```ts
const channel =
  args._channelOverride === undefined ? resolveDistributionChannel() : args._channelOverride;
```

- [ ] **Step 3: Edit `huddle.ts:38`** — invert the spread ternary.

Before:
```ts
    ...(parsed.sinceMs !== undefined ? { sinceMs: parsed.sinceMs } : {}),
```
After:
```ts
    ...(parsed.sinceMs === undefined ? {} : { sinceMs: parsed.sinceMs }),
```

- [ ] **Step 4: Edit `index-reembed-rpc.ts:263-266`** — invert and swap.

Before:
```ts
  const pipeline: ReembedSink =
    ctx._sinkFactory !== undefined
      ? ctx._sinkFactory(embedder)
      : new SqliteEmbeddingPipeline({ db: ctx.db, embedder, logger: ctx.logger });
```
After:
```ts
  const pipeline: ReembedSink =
    ctx._sinkFactory === undefined
      ? new SqliteEmbeddingPipeline({ db: ctx.db, embedder, logger: ctx.logger })
      : ctx._sinkFactory(embedder);
```

- [ ] **Step 5: Typecheck both packages.**

Run: `cd packages/cli && bun run typecheck` then `cd packages/gateway && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Run touched-file tests.**

Run: `cd packages/cli && bun test src/commands/update.test.ts src/commands/huddle.test.ts` and `cd packages/gateway && bun test src/updater src/ipc/index-reembed-rpc.test.ts`
Expected: PASS (re-grep the actual test filenames with `Glob` if a path differs).

---

## Task 2: S6606 + S7781 (Commit 1, part b)

**Files:**
- Modify: `packages/gateway/compile-gateway.ts:105`
- Modify: `packages/sdk/src/distribution-channel.ts:59`

- [ ] **Step 1: Edit `compile-gateway.ts:105`** — ternary → nullish (`r.status` is `number | null`, so `?? 1` is equivalent).

Before:
```ts
  const status = r.status === null ? 1 : r.status;
```
After:
```ts
  const status = r.status ?? 1;
```

- [ ] **Step 2: Edit `distribution-channel.ts:59`** — `replace` global-regex → `replaceAll` literal.

Before:
```ts
  const p = resolved.replace(/\\/g, "/").toLowerCase();
```
After:
```ts
  const p = resolved.replaceAll("\\", "/").toLowerCase();
```

- [ ] **Step 3: Typecheck.**

Run: `cd packages/gateway && bun run typecheck` and `cd packages/sdk && bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Test the sdk channel resolver.**

Run: `cd packages/sdk && bun test src/distribution-channel.test.ts`
Expected: PASS (the Homebrew/Scoop path-classification tests still pass — `replaceAll("\\","/")` is byte-equivalent to the global-regex replace).

---

## Task 3: S5914 — `test.skipIf` in obsidian test (Commit 1, part c)

**Files:**
- Modify: `packages/gateway/src/connectors/obsidian-daily-note.test.ts:183-207`

- [ ] **Step 1: Confirm the test import** supports `.skipIf`.

Run: `grep -n "from \"bun:test\"" packages/gateway/src/connectors/obsidian-daily-note.test.ts`
Expected: `test` (or `it`) is imported from `bun:test`. `test.skipIf` is a Bun built-in.

- [ ] **Step 2: Replace the sentinel with `test.skipIf`.**

Before (lines 183-188):
```ts
test("resolveDailyNotePath emits a warning when daily-notes.json exists but is unreadable", () => {
  if (platform() === "win32") {
    // chmod 000 is not reliably enforceable on Windows; skip this branch there.
    expect(true).toBe(true); // placeholder so the test is counted
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
```
After:
```ts
// chmod 000 is not reliably enforceable on Windows; skip this branch there.
test.skipIf(platform() === "win32")(
  "resolveDailyNotePath emits a warning when daily-notes.json exists but is unreadable",
  () => {
    const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
```

Then fix the trailing close: the test's body now ends with `});` → re-indent the body one level and close with `  },\n);`. (The `finally` cleanup block and assertions stay verbatim, just indented one extra level.)

- [ ] **Step 3: Typecheck + run the file.**

Run: `cd packages/gateway && bun run typecheck` then `bun test src/connectors/obsidian-daily-note.test.ts`
Expected: typecheck clean; on this (Windows) box the test reports **skipped**, others PASS. No `expect(true)` sentinel remains.

---

## Task 4: S3358 — nested ternary in preflight-gate (Commit 1, part d)

**Files:**
- Modify: `packages/gateway/src/federation/preflight-gate.ts:127-132`

- [ ] **Step 1: Replace the nested ternary with an if/else chain** assigned to a typed `let`.

Before:
```ts
  const hitlStatus =
    entry.decision === "answered"
      ? "approved"
      : entry.decision === "denied"
        ? "rejected"
        : "not_required";
```
After:
```ts
  let hitlStatus: "approved" | "rejected" | "not_required" = "not_required";
  if (entry.decision === "answered") hitlStatus = "approved";
  else if (entry.decision === "denied") hitlStatus = "rejected";
```

- [ ] **Step 2: Typecheck + test.**

Run: `cd packages/gateway && bun run typecheck` then `bun test src/federation/preflight-gate.test.ts`
Expected: PASS — the three decision→hitlStatus mappings (`answered`→approved, `denied`→rejected, else→not_required) are unchanged.

- [ ] **Step 3: Format + Commit 1.**

```bash
bunx biome check --write --linter-enabled=false packages/cli/src/commands/update.ts packages/gateway/src/updater/factory.ts packages/cli/src/commands/huddle.ts packages/gateway/src/ipc/index-reembed-rpc.ts packages/gateway/compile-gateway.ts packages/sdk/src/distribution-channel.ts packages/gateway/src/connectors/obsidian-daily-note.test.ts packages/gateway/src/federation/preflight-gate.ts
git add -A
git commit -m "refactor(sonar): clear 8 minor/major smells (S7735, S6606, S7781, S5914, S3358)"
```

---

## Task 5: S4144 — collapse identical kv-line helpers (Commit 2, part a)

**Files:**
- Modify: `packages/gateway/src/config/nimbus-toml.ts` (functions @1028 `applyQuorumKvLine` and @1211 `applyPreflightKvLine`)

`applyQuorumKvLine` and `applyPreflightKvLine` are byte-identical (verified). Collapse to one shared `applyKvLine`.

- [ ] **Step 1: Rename `applyQuorumKvLine` to `applyKvLine`** at its definition (~line 1028) and keep the body identical:
```ts
/** Records a `key = value` line into the current sub-table's bucket, if any. */
function applyKvLine(bucket: Record<string, string> | undefined, trimmed: string): void {
  if (bucket === undefined) return;
  const kv = splitKeyValue(trimmed);
  if (kv !== undefined) bucket[kv.key] = kv.valRaw;
}
```

- [ ] **Step 2: Delete the `applyPreflightKvLine` definition** (~lines 1210-1215, including its `/** Records... */` doc comment).

- [ ] **Step 3: Update both call sites.**

Run: `grep -n "applyQuorumKvLine\|applyPreflightKvLine" packages/gateway/src/config/nimbus-toml.ts`
Replace each call to `applyQuorumKvLine(` and `applyPreflightKvLine(` with `applyKvLine(`. (Same arg order — both take `(bucket, trimmed)`.)

- [ ] **Step 4: Typecheck.**

Run: `cd packages/gateway && bun run typecheck`
Expected: no errors, no "unused function" (both old names gone, both callers updated).

- [ ] **Step 5: Test the toml parser.**

Run: `cd packages/gateway && bun test src/config/nimbus-toml.test.ts`
Expected: PASS — both the quorum and preflight `[...]` sub-table kv parsing tests still pass.

---

## Task 6: S107 — too many params in filesystem-v2-sync (Commit 2, part b)

**Files:**
- Modify: `packages/gateway/src/connectors/filesystem-v2-sync.ts` (`upsertCodeSymbolsForFile` @276 + caller @357)

Bundle the 6 file-context params into one `file` options object → 3 params total.

- [ ] **Step 1: Change the signature (lines 276-285) and destructure** at the top of the body.

Before:
```ts
function upsertCodeSymbolsForFile(
  ctx: SyncContext,
  src: string,
  symbols: readonly { name: string; kind: string }[],
  root: string,
  relNorm: string,
  rk: string,
  mtime: number,
  now: number,
): { upserted: number; blameRanges: BlameRange[] } {
  let upserted = 0;
```
After:
```ts
function upsertCodeSymbolsForFile(
  ctx: SyncContext,
  symbols: readonly { name: string; kind: string }[],
  file: { src: string; root: string; relNorm: string; rk: string; mtime: number; now: number },
): { upserted: number; blameRanges: BlameRange[] } {
  const { src, root, relNorm, rk, mtime, now } = file;
  let upserted = 0;
```
(The rest of the body references `src`/`root`/`relNorm`/`rk`/`mtime`/`now` as locals — unchanged.)

- [ ] **Step 2: Update the call site (line 357).**

Before:
```ts
    const fileResult = upsertCodeSymbolsForFile(ctx, src, symbols, root, relNorm, rk, mtime, now);
```
After:
```ts
    const fileResult = upsertCodeSymbolsForFile(ctx, symbols, { src, root, relNorm, rk, mtime, now });
```

- [ ] **Step 3: Typecheck + test + Commit 2.**

Run: `cd packages/gateway && bun run typecheck` then `bun test src/connectors/filesystem-v2-sync.test.ts` (re-glob the exact test filename if needed).
Expected: PASS.
```bash
bunx biome check --write --linter-enabled=false packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/connectors/filesystem-v2-sync.ts
git add -A
git commit -m "refactor(sonar): dedupe kv-line helper (S4144) + options-object for upsertCodeSymbolsForFile (S107)"
```

---

## Task 7: S3776 — `applyTribalEntry` 16→15 (Commit 3, part a)

**Files:**
- Modify: `packages/gateway/src/config/nimbus-toml.ts:1288` (`applyTribalEntry`)

Only 1 over. The three numeric cases (`min_occurrences`, `window_days`, `cooldown_days`) repeat the `parseIntDec` + positive-guard + assign pattern. Extract one helper to remove two `if` branches' worth of complexity.

- [ ] **Step 1: Add a small helper above `applyTribalEntry`:**
```ts
/** Parse a positive integer kv value; returns undefined when absent/non-numeric/below `min`. */
function parsePositiveIntOrUndefined(valRaw: string, min: number): number | undefined {
  const n = parseIntDec(valRaw);
  return n !== undefined && n >= min ? n : undefined;
}
```

- [ ] **Step 2: Rewrite the three numeric cases** to use it (note the differing floors: occurrences/days `> 0` i.e. min 1; cooldown `>= 0` i.e. min 0).

After:
```ts
    case "min_occurrences": {
      const n = parsePositiveIntOrUndefined(valRaw, 1);
      if (n !== undefined) out.minOccurrences = n;
      return;
    }
    case "window_days": {
      const n = parsePositiveIntOrUndefined(valRaw, 1);
      if (n !== undefined) out.windowDays = n;
      return;
    }
    case "cooldown_days": {
      const n = parsePositiveIntOrUndefined(valRaw, 0);
      if (n !== undefined) out.cooldownDays = n;
      return;
    }
```
(Each case still has exactly one `if`, but the inner `&&`-compound condition moved into the helper — that's what drops the count below 16.)

- [ ] **Step 3: Typecheck + test.**

Run: `cd packages/gateway && bun run typecheck` then `bun test src/config/nimbus-toml.test.ts`
Expected: PASS — the `[tribal]` parsing tests (min_occurrences/window_days/cooldown_days accept/reject) unchanged; cooldown still accepts 0, occurrences/days still reject 0.

- [ ] **Step 4: Commit 3a.**
```bash
bunx biome check --write --linter-enabled=false packages/gateway/src/config/nimbus-toml.ts
git add -A
git commit -m "refactor(sonar): reduce applyTribalEntry cognitive complexity 16->15 (S3776)"
```

---

## Task 8: S3776 — `runHuddle` 17→15 (Commit 3, part b)

**Files:**
- Modify: `packages/gateway/src/agents/huddle.ts:44` (`runHuddle`) — extract the per-peer contribution loop.

- [ ] **Step 1: Add a module-scope helper** (place it just above `runHuddle`, after the `lite(...)` helper). Move the triple-nested loop body (current lines 61-87) into it:
```ts
function aggregateContributions(
  queryResults: Array<{ gaps: GapNote[]; perPeer: PerPeerResult[] }>,
  cutoff: number,
  gaps: GapNote[],
): HuddleContribution[] {
  const byPeer = new Map<string, HuddleContribution>();
  for (const q of queryResults) {
    gaps.push(...q.gaps);
    for (const peer of q.perPeer) {
      const contrib =
        byPeer.get(peer.peerId) ??
        ({
          peerId: peer.peerId,
          who: peer.displayName,
          prs: [],
          tickets: [],
          incidents: [],
        } satisfies HuddleContribution);
      for (const it of peer.items) {
        if (it.modifiedAt < cutoff) continue;
        if (it.type === "pr") contrib.prs.push(lite(it));
        else if (it.type === "issue") contrib.tickets.push(lite(it));
        else if (it.type === "incident") contrib.incidents.push(lite(it));
      }
      byPeer.set(peer.peerId, contrib);
    }
  }
  return [...byPeer.values()];
}
```
**Verify the exact element types** of `queryResults` / `perPeer` / `PerPeerResult` by reading the return type of `fanOutQuery` and the `q.perPeer` element shape; use the real exported type names (don't invent `PerPeerResult` if it's named differently — `grep` for `perPeer` and the `fanOutQuery` return type). Adjust the helper's param types to match.

- [ ] **Step 2: Replace the inline loop in `runHuddle` (lines 61-87)** with:
```ts
  const contributions = aggregateContributions(queryResults, cutoff, gaps);
```

- [ ] **Step 3: Update the return** to filter `contributions` instead of `byPeer`:
```ts
    contributions: contributions.filter(
      (c) => c.prs.length + c.tickets.length + c.incidents.length > 0,
    ),
```

- [ ] **Step 4: Typecheck + test.**

Run: `cd packages/gateway && bun run typecheck` then `bun test src/agents/huddle.test.ts` (glob for the real test path; also run any `huddle` e2e under `test/`).
Expected: PASS — same contributions, same gaps, same filtering. Behaviour identical.

- [ ] **Step 5: Commit 3b.**
```bash
bunx biome check --write --linter-enabled=false packages/gateway/src/agents/huddle.ts
git add -A
git commit -m "refactor(sonar): extract aggregateContributions from runHuddle 17->15 (S3776)"
```

---

## Task 9: S3776 — `assemblePlatformServices` 34→15 (Commit 3, part c)

**Files:**
- Modify: `packages/gateway/src/platform/assemble.ts:921` (`assemblePlatformServices`)

The dominant complexity is the inline `if (tribalCfg.enabled) { ... }` block (starts ~line 1079) — it contains the `gatherSources` closure (for-loop + `if` + try/catch + `typeof` guard), the `tribalSynthesize` closure, and the watcher wiring. Extract that whole block into a helper.

**Invariant guard (I22/I25):** the extraction is a *verbatim move* — it must preserve (a) the policy-gate boot ordering (I22) untouched and (b) the tribal write-gate wiring (I25). The security-invariants test is the proof.

- [ ] **Step 1: Read the full tribal block** to find its closing brace.

Run: `grep -n "if (tribalCfg.enabled)" packages/gateway/src/platform/assemble.ts` then read from that line to where the block (and the chatops wiring that consumes `tribalSend`/`tribalBoot`/`tribalInterceptCommand`) closes. Identify exactly which of `{ tribalSend, tribalBoot, tribalInterceptCommand }` are read *after* the block — those are the helper's return values.

- [ ] **Step 2: Extract `bootTribalKnowledge(...)`** as a module-scope `async function` (or sync if no await inside) that takes the inputs the block reads (`tribalCfg`, `rt`, `db`, `syncLogger`, `paths`, and whatever else the block closes over) and returns the late-bound values:
```ts
async function bootTribalKnowledge(deps: {
  tribalCfg: NimbusTribalToml;
  rt: EmbeddingRuntime | undefined;  // use the real type from createLocalIndexWithEmbeddingRuntime
  db: Database;
  syncLogger: Logger;
  // ...any other captured deps the block references
}): Promise<{
  tribalSend: (target: ReplyTarget, text: string) => Promise<void>;
  tribalBoot: TribalBoot | undefined;
  tribalInterceptCommand: ((m: ChatMessage) => Promise<boolean>) | undefined;
}> {
  // ... the moved block body, returning the three values ...
}
```
Move the body **verbatim** (the `gatherSources`/`tribalSynthesize` closures and the watcher build). Where the original mutated outer `let`s, return them instead.

- [ ] **Step 3: Replace the inline block in `assemblePlatformServices`** with the late-bound declarations + a call:
```ts
  const tribalCfg = loadNimbusTribalFromConfigDir(paths.configDir);
  const { tribalSend, tribalBoot, tribalInterceptCommand } = tribalCfg.enabled
    ? await bootTribalKnowledge({ tribalCfg, rt, db, syncLogger /* + captured deps */ })
    : { tribalSend: async () => {}, tribalBoot: undefined, tribalInterceptCommand: undefined };
```
Keep the downstream chatops wiring (the rebind of `tribalSend` to `chatopsBoot.replyTo`) working — if `tribalSend` was reassigned later via `let`, preserve that by keeping the `let` and reassigning after the chatops boot (read the original to mirror the cycle exactly).

- [ ] **Step 4: Typecheck.**

Run: `cd packages/gateway && bun run typecheck`
Expected: no errors. Resolve any type mismatches by importing the real types used in the moved block.

- [ ] **Step 5: Run the invariants + assemble + tribal tests.**

Run: `cd packages/gateway && bun test src/security-invariants.test.ts src/platform/assemble.test.ts` and any tribal tests under `src/tribal` / `src/config`.
Expected: PASS — **I22 and I25 invariant assertions must stay green** (proves policy-gate + tribal-write-gate wiring intact).

- [ ] **Step 6: Run the static invariants audit** (I22 D16 / I25 D19 are also enforced statically).

Run: `bun run scripts/structure-audit/check-nimbus-invariants.ts` (or the `audit:*` script that wraps it — `grep check-nimbus-invariants package.json`).
Expected: PASS.

- [ ] **Step 7: Commit 3c.**
```bash
bunx biome check --write --linter-enabled=false packages/gateway/src/platform/assemble.ts
git add -A
git commit -m "refactor(sonar): extract bootTribalKnowledge from assemblePlatformServices 34->15 (S3776); I22/I25 preserved"
```

> **Fallback:** if a post-PR Sonar re-scan still shows S3776 on `assemblePlatformServices` (>15), extract a second cohesive step (e.g. `bootCoreStorage` for the dir/vault/db opening, or the chatops wiring into `bootChatops`) and re-commit. Don't over-split preemptively — one extraction likely suffices.

---

## Task 10: Duplication — investigate + build the worklist (Commit 4 prep)

**Files:** none yet (analysis).

- [ ] **Step 1: Run the repo-wide jscpd oracle** (Sonar matches blocks project-wide; single-dir runs miss cross-file dups).

Run: `bunx jscpd@4 --min-lines 10 --min-tokens 70 --reporters json --output "$TEMP/jscpd-7" --format typescript,tsx packages`
(Non-zero exit is jscpd's own threshold — the JSON in `$TEMP/jscpd-7/jscpd-report.json` is still written.)

- [ ] **Step 2: Read the report** and confirm the live duplicated clusters against the Sonar list in the spec. Prioritise these **clear-win** extractions, and **skip** `auth/oauth-registry.ts` + `connectors/lazy-mesh/phase3-config.ts` (declarative — DRY hurts readability):
  - `packages/github-actions/{annotate-action,preflight-query}/src/main.ts` + `output.ts` (cross-package twins — strongest candidate)
  - connector `search-filter.ts` (dependencytrack/airflow) + `gx-parse.ts` / `localdb/sql-scan.ts` / `dataprofile/profile.ts`
  - `gateway/src/engine/search-ranking.ts`, `connectors/_lib/gitlab/events.ts`, `ipc/lan-client.ts`, `agents/_lib/findings.ts`, `agents/expert.ts`

- [ ] **Step 3: For each candidate, decide extract-vs-leave.** Extract only when a shared helper genuinely improves the code (no forced indirection, no readability loss). Record the decision list (extract / skip + one-line reason) as a comment in this task before proceeding.

---

## Task 11: Duplication — extract clear-win shared helpers (one commit per cluster)

**Files:** per the Task 10 worklist. Each extraction is its own commit.

For **each** cluster decided "extract" in Task 10:

- [ ] **Step 1: Identify the shared module location.**
  - Cross-package (`github-actions`): the twin `main.ts`/`output.ts` blocks — extract the shared logic into a small local module in each package, or a shared util if one package already depends on the other. **Do not** introduce a new cross-package dependency that violates the dependency rules (gateway imports nothing from cli/ui; sdk dep-free). When in doubt, duplicate the *type* but share via an existing shared location.
  - `mcp-connectors` `search-filter.ts` twins: extract into `packages/mcp-connectors/shared/` (relative-import folder; no external deps — `[[shared-folder-external-deps]]`).
  - gateway internal twins: a `_lib/` helper next to the consumers.

- [ ] **Step 2: Write/extend the helper**, replace each duplicated block with a call. Preserve every call site's behaviour and public signatures.

- [ ] **Step 3: Typecheck the affected package(s)** (`cd packages/<pkg> && bun run typecheck`). For `mcp-connectors/shared/` additions, run the **whole-workspace** typecheck (older connector tsconfigs vary — `[[mcp-connector-tsconfig-include-variance]]`): `bun run typecheck`.

- [ ] **Step 4: Run the affected tests** (`bun test <files>`; ui/vscode use `bunx vitest run`).

- [ ] **Step 5: Format + commit** this cluster:
```bash
bunx biome check --write --linter-enabled=false <changed files>
git add -A
git commit -m "refactor(sonar): extract shared <name> helper to cut duplication"
```

- [ ] **Step 6: Repeat** for the next cluster. Stop when the remaining dups are only the skipped declarative blocks or where extraction would trade clarity for a lower number. `log` what was intentionally left.

---

## Task 12: Final verification (no commit — handoff to user)

**Files:** none.

- [ ] **Step 1: Run the fast preflight gates.**

Run: `bun run preflight:fast`
Expected: PASS (cheap static gates: typecheck, biome via `bunx biome check packages scripts`, structure audits).

- [ ] **Step 2: Lint the plan + spec docs** (they live under `docs/**`, which IS markdown-linted even though the worktree path is excluded — `[[doc-status-drift-surfaces]]`).

Run: `bun run lint:markdown` (or the documented markdown-lint script — `grep "lint:markdown" package.json`)
Expected: PASS (MD031/MD032/MD040-clean).

- [ ] **Step 3: Summarise for the user** — commits made, issues addressed (13 → expect 0 after the PR scan), duplication clusters extracted vs. skipped, and **STOP** (do not push or open the PR — the user does this). Note that SonarCloud only re-scans on PR/push-to-main, so the live "open" count won't change until the PR's analysis runs.

---

## Self-review notes

- **Spec coverage:** all 13 issues map to Tasks 1-9; duplication → Tasks 10-11; verification/skip-list → Task 12. ✅
- **Types:** `applyKvLine` (Task 5) used consistently. `aggregateContributions` / `bootTribalKnowledge` flagged as "verify real type names" since the exact exported types must be read at implementation time (huddle's `perPeer` element, assemble's `rt`/`TribalBoot`). ✅
- **No silent caps:** Task 11 Step 6 requires logging intentionally-skipped dups. ✅
- **Invariants:** Task 9 has explicit I22/I25 runtime + static guards. ✅
