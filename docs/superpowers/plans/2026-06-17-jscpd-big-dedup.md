# jscpd Big-PR Duplication Reduction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive strict jscpd duplication (`bunx jscpd packages`, `.jscpd.json` = min-lines 5 / min-tokens 50 / threshold 3) from 4.83% to **< 2.3%** (lower if extractable) by extracting shared scaffolding into helpers, then tighten the CI duplication gate so local == CI.

**Architecture:** One big PR, cluster-batched commits. Wave 0 fixes a coverage-instrumentation gap (so new `mcp-connectors/shared/` helpers are Sonar-covered). Waves 1–3 extract 10 duplicate clusters into the correct home per dependency rules: gateway-internal → `gateway/src/connectors/_lib` (or a same-file local helper); cli-internal → `cli/src/lib`; cross-package (cli↔gateway types, gateway↔mcp pure logic) → `@nimbus-dev/sdk`; mcp-connector-shared → `packages/mcp-connectors/shared/`. Wave 4 re-measures and tightens the gate.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, zod, Biome, jscpd 4.2. Monorepo workspaces. Istanbul coverage via preload (`scripts/coverage/`).

**Spec:** [`docs/superpowers/specs/2026-06-17-jscpd-big-dedup-design.md`](../specs/2026-06-17-jscpd-big-dedup-design.md)

## Global Constraints

- **Pure dedup — zero behavior change.** Every existing connector / sync / command test MUST stay green **unedited**; a dedup commit's `git status` shows no `*.test.ts` modified (except a task that explicitly adds a new helper test). This is the behavior-fidelity proof.
- **No `any`** (Non-Negotiable #7) — external payloads stay `unknown` at the boundary; helpers are generic/structural.
- **No new jscpd ignores** to dodge the threshold; `.jscpd.json` is not relaxed.
- **Dependency rules:** `gateway` imports nothing from `cli`/`ui`; `mcp-connectors/*` import `@nimbus-dev/sdk` only; `sdk` imports nothing from gateway/cli/ui; circular deps forbidden. The only MIT package both `cli` and `gateway` import is `@nimbus-dev/sdk` — it is the home for all cross-package extraction.
- **SDK purity (hard):** anything hoisted to `@nimbus-dev/sdk` MUST be pure (parsing/validation/type-mapping only) — no fs/network/DB/process I/O, no secrets. I/O stays in the caller. If a cross-boundary pair's duplicated span is entirely I/O, **defer it** (don't force an impure sdk module).
- **SDK rebuild:** any task touching `@nimbus-dev/sdk` MUST `cd packages/sdk && bun run build` before cross-package typecheck/tests (consumers resolve sdk via `dist/`+`.d.ts`). Same for `packages/client`.
- **Strict tsc on `shared/`:** whenever a `packages/mcp-connectors/shared/` file changes, run `bunx tsc -p packages/mcp-connectors/{gmail,outlook,teams,google-meet,google-photos}/tsconfig.json` (these include `../shared/**` and check it under exactOptionalPropertyTypes + noUncheckedIndexedAccess). Always `bun run typecheck` and **grep for `error TS`** (the `--filter` aggregate can mask a sub-package failure).
- **Do NOT touch** perf surfaces (`packages/gateway/src/perf/**`) or the `sonar.cpd.exclusions` list (blanket family patterns; retiring them is a separate later cleanup).
- **Coverage-floor** (≥80% line+branch/file, baseline `{}`) applies to every new file under gateway/cli/sdk/client — each ships a direct unit test. Verify via the Docker-Linux lcov build before the first push.
- **Subagents cannot `git commit` or run the per-connector tsc loop** (harness permission); the controller runs tsc-loop + biome + commit after each implementer's edits.
- **Prereq (redo if the worktree is recreated):** `bun install`; `cd packages/sdk && bun run build`; `cd packages/client && bun run build` — else `sandbox.test.ts` fails `Cannot find module '@nimbus-dev/sdk/testing'`.
- **Strict baseline (fresh main `93270cad`):** 4.83% (6378 dup-lines / 604 clones). Re-measure after each wave.

---

## Task 1 (Wave 0): Fix coverage instrumentation scope for `mcp-connectors/shared/`

**Why first:** `scripts/coverage/instrument-scope.ts` never instruments `mcp-connectors/shared/` files (the regex requires a `/src/` segment that shared helpers lack), so their unit-test coverage reports 0% to SonarCloud — the exact gate that reddened PR #678. Fixing it unblocks every new shared helper in Waves 2. Verified locally: the patch flips `merge-coverage: merged 0 shard(s)` → `1` and surfaces all 8 shared helpers in the lcov.

**Files:**
- Modify: `scripts/coverage/instrument-scope.ts:5`
- Test: `scripts/coverage/instrument-scope.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `shouldInstrument(absPath: string): boolean` now returns `true` for `…/packages/mcp-connectors/shared/**` paths (unchanged signature).

- [ ] **Step 1: Extend the failing test**

Add these cases to `scripts/coverage/instrument-scope.test.ts` inside the existing `describe("shouldInstrument", …)` block:

```ts
  test("instruments mcp-connectors/shared helpers (flat, nested, tsx)", () => {
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/mcp-search-tool.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/sub/bar.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/widget.tsx")).toBe(true);
  });
  test("still instruments connector src and still skips shared test files", () => {
    expect(shouldInstrument("/repo/packages/mcp-connectors/zotero/src/server.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-connectors/shared/mcp-search-tool.test.ts")).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/coverage/instrument-scope.test.ts`
Expected: FAIL — the flat/nested/tsx `shared/` assertions return `false` (pre-fix regex misses `shared/`).

- [ ] **Step 3: Apply the one-line fix**

In `scripts/coverage/instrument-scope.ts`, change line 5:

```ts
// before
const CONNECTOR_SRC = /\/packages\/mcp-connectors\/[^/]+\/src\//;
// after
const CONNECTOR_SRC = /\/packages\/mcp-connectors\/(?:shared|[^/]+\/src)\//;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/coverage/instrument-scope.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Verify end-to-end coverage attribution (optional but recommended)**

Run (replicates the CI shared-coverage step):

```bash
export GITHUB_WORKSPACE="$PWD"; rm -rf coverage; mkdir -p coverage/.nyc-tmp
(cd packages/mcp-connectors/shared && bun test --timeout 60000 \
  --preload "$GITHUB_WORKSPACE/scripts/coverage/istanbul-register.ts" \
  --preload "$GITHUB_WORKSPACE/scripts/coverage/report-coverage.ts")
bun scripts/coverage/merge-coverage.ts
grep -c "^SF:.*mcp-connectors/shared" coverage/lcov.info
rm -rf coverage
```

Expected: `merge-coverage: merged 1 shard(s)` and a non-zero `SF:` count for `mcp-connectors/shared`.

- [ ] **Step 6: Commit**

```bash
git add scripts/coverage/instrument-scope.ts scripts/coverage/instrument-scope.test.ts
git commit -m "fix(coverage): instrument mcp-connectors/shared (Sonar new_coverage gap)

instrument-scope CONNECTOR_SRC required a /src/ segment, so shared/ helpers were
never instrumented -> 0% in the Sonar lcov (reddened #678). Mirror GHA_SRC's
shared alternation. Wave 0 of the jscpd big-PR dedup program."
```

---

## Wave 1 — Sonar-safe clean clusters (gateway / cli / sdk)

> Each new helper file ships a co-located unit test (coverage-floor ≥80%/file applies to gateway/cli/sdk). Every existing connector/command test stays green **unedited**.

### Task 2 (C1): Hoist identical agent-brief TYPES to `@nimbus-dev/sdk`

**Files:**
- Create: `packages/sdk/src/agents/brief-types.ts`
- Modify: `packages/sdk/src/index.ts` (add a root re-export of the new module)
- Modify: `packages/gateway/src/agents/_lib/findings.ts` (import the shared types from sdk; keep gateway-only `AgentBrief` union + `BriefReadyPayload<B>` + the 8 type-guards)
- Modify: `packages/cli/src/types/agents.ts` (import the shared types from sdk; keep cli-only divergent types)

**Interfaces:**
- Produces (in `@nimbus-dev/sdk`): the **genuinely-identical** types only — `Evidence`, `GapCategory`, `GapNote`, `AgentBriefBase`, `ExpertFinding`, `ImpactFinding`, `CatchupItem`, `CatchupSection`, `JanitorPeerTouch`, `PreflightDownstream`, and `ConflictType`.
- **Do NOT move (behavior-divergent — pure-dedup means don't unify a wire contract):** cli's `GhostFinding` (literal rank union) vs gateway's (`ExpertiseRank` + `FederatedItemLite[]`); cli `ConflictCollision` vs gateway `ConflictFinding` naming; gateway-only `AgentBrief` union, `BriefReadyPayload<B>`, `FederatedItemLite`; the per-side type-guards (they differ subtly). Leave those redeclared on each side.

- [ ] **Step 1: Read both files** (`packages/cli/src/types/agents.ts`, `packages/gateway/src/agents/_lib/findings.ts`) and confirm, per type, that the declaration is byte-identical before moving it. Only move identical ones.

- [ ] **Step 2: Create `packages/sdk/src/agents/brief-types.ts`** with the identical types above (copy the canonical gateway declarations verbatim). Add a one-line module doc. Re-export from `packages/sdk/src/index.ts`: `export * from "./agents/brief-types.ts";` (or a named re-export matching the sdk's existing index convention — read it first).

- [ ] **Step 3: Rewire gateway** — in `findings.ts`, replace the moved type declarations with `import { type Evidence, type GapNote, … } from "@nimbus-dev/sdk";` and re-export them if other gateway files import them from `findings.ts` (`export type { Evidence, … } from "@nimbus-dev/sdk";`). Keep `AgentBrief`, `BriefReadyPayload`, the guards, and divergent types in place.

- [ ] **Step 4: Rewire cli** — in `agents.ts`, replace the moved identical type declarations with imports from `@nimbus-dev/sdk`; keep cli-only/divergent types and the cli guards.

- [ ] **Step 5: Build sdk + typecheck** — `cd packages/sdk && bun run build && cd ../..` then `bun run typecheck 2>&1 | grep -i "error TS" && echo "TS ERRORS" || echo "tsc clean"`. Expected: clean (both cli and gateway resolve the shared types).

- [ ] **Step 6: Run the touched test suites** — `bun test packages/gateway/src/agents packages/cli/src` — all green, **no `*.test.ts` edited**.

- [ ] **Step 7: Commit** — `git commit -m "refactor(dedup): hoist identical agent-brief types to @nimbus-dev/sdk (C1)"`

---

### Task 3 (C2): Extract gateway email-mapping helpers to `connectors/_lib/email-mapping.ts`

**Files:**
- Create: `packages/gateway/src/connectors/_lib/email-mapping.ts` + `…/email-mapping.test.ts`
- Modify: `packages/gateway/src/connectors/{imap,protonmail,fastmail}-email-mapping.ts`

**Interfaces (Produces):**
```ts
export function clamp(s: string, max: number): string;
export function parseDateMs(date: string | number | null): number | null;
```
(The recon also sketched a generic `mapEmailToItem`; **prefer extracting only the two pure helpers `clamp` + `parseDateMs` first** — they are the verified-identical span. Only generalize the full mapper if the three `mapXToItem` bodies are byte-identical after that; if they differ in attachment-shape/external-id, leave each mapper's body in place. No force-fit.)

- [ ] **Step 1: Write `email-mapping.test.ts`** covering `clamp` (under/over max → ellipsis) and `parseDateMs` (number finite, ISO string, empty/invalid → null).
- [ ] **Step 2: Run it — FAIL** (`Cannot find module './_lib/email-mapping.ts'`).
- [ ] **Step 3: Create `email-mapping.ts`** with `clamp` + `parseDateMs` (copy verbatim from `protonmail-email-mapping.ts`).
- [ ] **Step 4: Run the test — PASS.**
- [ ] **Step 5: Migrate** the three mappers to `import { clamp, parseDateMs } from "./_lib/email-mapping.ts";` and delete their local copies. Keep each file's `*ExternalId()` and mapper body unchanged.
- [ ] **Step 6: Verify** — `bun test packages/gateway/src/connectors` (the three mapping tests green, unedited) + `bun run typecheck | grep "error TS"`.
- [ ] **Step 7: Commit** — `git commit -m "refactor(dedup): gateway email-mapping helpers → _lib (C2)"`

---

### Task 4 (C3): Extract CLI-shell sync helper to `connectors/_lib/cli-shell-sync.ts`

**Scope:** Only the 4 connectors that match the single-pass CLI-spawn shape: **cloudwatch, sagemaker, cloud-logging, vertex-ai**. **DEFER athena** (hierarchical multi-level pagination — no force-fit). bitrise/testflight/codemagic (HTTP build-poll) and google-meet/google-photos (HTTP) are **NOT** in this task (handled in Task 4b).

**Files:**
- Create: `packages/gateway/src/connectors/_lib/cli-shell-sync.ts` + `…/cli-shell-sync.test.ts`
- Modify: `packages/gateway/src/connectors/{cloudwatch,sagemaker,cloud-logging,vertex-ai}-sync.ts`

**Interfaces (Produces):**
```ts
export function isSafeCliArg(value: string): boolean; // verbatim from sagemaker/vertex-ai (identical copies)
export interface CliShellOutcome { readonly ok: boolean; readonly text: string; readonly bytes?: number; }
export interface ParsedCliPage { readonly items: readonly unknown[]; readonly hasMore: boolean; readonly nextPageCursor?: string; }
export interface CliShellSyncSpec<C> {
  readonly ensureRunning: () => Promise<void>;
  readonly loadCreds: () => Promise<C | null>;
  readonly pass1Cursor: () => string;
  readonly maxPages: number;
  readonly runCliPage: (creds: C, page: number, pageCursor: string) => Promise<CliShellOutcome>;
  readonly parsePage: (text: string, page: number) => ParsedCliPage;
  readonly map: (raw: unknown, creds: C, now: number) => SyncUpsertRow | null;
}
export function runSinglePassCliShellSync<C>(ctx: SyncContext, cursor: string | null, spec: CliShellSyncSpec<C>): Promise<SyncResult>;
```
Mirror the Stage-A precedent `connectors/_lib/paginated-sync.ts` (same `loadCreds → walk pages → first-page-error-empty / later-page-error-break → upsert → pass-1-success` shape). The recon's draft body for `runSinglePassCliShellSync` is the reference implementation.

- [ ] **Step 1: Write `cli-shell-sync.test.ts`** — unit-test `isSafeCliArg` (rejects empty, >1024, leading `-`, control chars; accepts normal) and `runSinglePassCliShellSync` with a fake spec: single page, multi-page via `nextPageCursor`, first-page `ok:false` → empty pass, unconfigured `loadCreds()===null` → noop, item mapping + upsert count. Inject a fake `ctx`/upsert per the existing `paginated-sync.test.ts` pattern (read it first).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `cli-shell-sync.ts`** per the interface above (lift `isSafeCliArg` verbatim; implement the loop exactly like `paginated-sync.ts`'s single-pass shape but with `runCliPage` instead of `fetchPage`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Migrate the 4 connectors** — each builds a `CliShellSyncSpec`, moves its argv-building into `runCliPage`, its JSON-array extraction into `parsePage`, its mapper into `map`. `cloud-logging`/`vertex-ai` are single-result (`maxPages: 1`, `hasMore:false`). `cloudwatch`/`sagemaker` are token-paginated (`nextPageCursor` from `nextToken`/`NextToken`). Keep `isSafeCliArg` guards on user-derived args. Delete each file's now-shared `isSafeCliArg` copy.
- [ ] **Step 6: Verify** — `bun test packages/gateway/src/connectors` (the 4 connectors' sync tests green, unedited) + `bun run typecheck | grep "error TS"`.
- [ ] **Step 7: Commit** — `git commit -m "refactor(dedup): CLI-shell sync helper, 4 connectors (C3; athena deferred)"`

---

### Task 4b (C3-HTTP): Build-poll + Google HTTP sync pairs (best-effort)

**Files:** `packages/gateway/src/connectors/{bitrise,testflight,codemagic}-sync.ts` (list-apps→fetch-builds-per-app HTTP shape, 41+40 dup-L) and `{google-meet,google-photos}-sync.ts` (Google paginated HTTP, 39 dup-L).

- [ ] **Step 1:** Read the three build-CI sync files; if they share an identical "list apps → for each app fetch builds via `connectorFetch` → map" skeleton, extract it to `connectors/_lib/per-app-poll-sync.ts` with a unit test. If they deviate, **defer** and note it.
- [ ] **Step 2:** Read the two google sync files; extract any shared `fetchGoogleJson` paginate-by-`pageToken` skeleton to a small `_lib` helper, or **defer** if it's already minimal.
- [ ] **Step 3:** Tests green unedited; typecheck clean; commit `refactor(dedup): HTTP per-app/Google sync helpers (C3b)` — or skip with a logged reason if both deferred.

---

### Task 5 (C4): Extract cli render + flag-parsing helpers

**Files:**
- Create: `packages/cli/src/lib/agent-brief-render.ts` + test; `packages/cli/src/lib/flag-parsing.ts` + test
- Modify: `packages/cli/src/commands/{catchup,impact}.ts` and `{run-workflow,workflow}.ts`

**Interfaces (Produces):**
```ts
// agent-brief-render.ts
export function awaitAgentBrief<T>(client: IPCClient, agentName: string, guard: (x: unknown) => x is T, onTimer: (t: ReturnType<typeof setTimeout>) => void): Promise<{ brief: string; findings: T }>;
export function renderAgentBrief<T extends { gaps: readonly { category: string }[] }>(brief: string, findings: T, json: boolean): void;
// flag-parsing.ts
export function hasFlag(args: string[], flag: string): boolean;
export function shiftFlag(args: string[], flag: string): string | undefined;
```
`awaitAgentBrief` parameterizes the `${agentName}.briefReady`/`.briefError` notification names + the guard; `renderAgentBrief` is the shared json/empty-index/print block. `hasFlag`/`shiftFlag` are verbatim-identical between run-workflow/workflow.

- [ ] **Step 1: Write tests** — `flag-parsing.test.ts` (hasFlag splices+returns bool; shiftFlag returns next arg or undefined, splices 2) and `agent-brief-render.test.ts` (renderAgentBrief: json → stringify; empty_index gap → stderr+exit; else print brief — use a mocked `process.stdout/stderr/exit`; awaitAgentBrief: resolves on briefReady w/ valid guard, rejects on malformed/briefError/timeout — inject a fake IPCClient).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement both helpers** (lift verbatim from catchup.ts/run-workflow.ts; parameterize agentName + guard in `awaitAgentBrief`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Migrate** catchup/impact to `awaitAgentBrief(client,"catchup",isCatchupBrief,…)` + `renderAgentBrief(…)`; run-workflow/workflow to import `hasFlag`/`shiftFlag` and delete local copies.
- [ ] **Step 6: Verify** — `bun test packages/cli/src` (command tests green unedited) + typecheck.
- [ ] **Step 7: Commit** — `git commit -m "refactor(dedup): cli brief-render + flag-parsing helpers (C4)"`

---

### Task 6 (C5): Gateway intra-file extraction (federation gate-commons + auth-handlers)

> **Order matters: do C5d (federation) first and run the security suite before touching anything else.**

**Files:**
- Create: `packages/gateway/src/federation/_lib/gate-commons.ts` + test
- Modify: `packages/gateway/src/federation/{audit-export,query-gate}.ts`
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` (same-file local helper)

**C5d — federation gate-commons (⚠️ I17 / static D13):**

**Interfaces (Produces):**
```ts
export async function enforceCommonGate<T>(ctx: CommonGateContext, req: FederationRequest, audit: (decision: GateDecision) => void): Promise<GateResult<void> | undefined>;
```
This extracts ONLY the shared **preamble**: I18 identity check → namespace-exists → active-grant → consent (cache/prompt/timeout). It returns `undefined` on pass-through; the caller then runs its OWN logic. **The I17 leak-proof scope compilation (declaredServices/declaredTypes/`computeEffectiveTypes`, the no-full-index-dump checks) MUST stay inside `query-gate.ts` — it is the single sanctioned federated-answer site (static D13).**

- [ ] **Step 1: Read** `scripts/structure-audit/check-nimbus-invariants.ts` D13 rule to confirm it gates on *answer generation* in `query-gate.ts`, not on the consent preamble — so moving the preamble to `_lib/gate-commons.ts` does NOT violate D13. If D13 pattern-matches anything in the preamble, **keep the preamble in query-gate.ts and skip C5d** (note it). 
- [ ] **Step 2: Write `gate-commons.test.ts`** — identity_invalid → error; namespace_unknown; no_grant; standing-grant skips prompt; cached-false → consent_denied; prompt approved → undefined (pass-through); prompt timeout → timeout error. (Mirror `query-gate.test.ts` fixtures.)
- [ ] **Step 3: Run — FAIL.**
- [ ] **Step 4: Implement `gate-commons.ts`** (lift the preamble verbatim per the recon draft; share the `withTimeout` helper).
- [ ] **Step 5:** Rewire `query-gate.ts` and `audit-export.ts` to call `enforceCommonGate(...)` then continue with their specific tails (query-gate's leak-proof scope; audit-export's `exportFederationAudit`).
- [ ] **Step 6: Run the security suite (gate):** `bun test packages/gateway/src/security-invariants.test.ts` AND `bun run audit:structure` (or the `check-nimbus-invariants.ts` runner) — both MUST pass. Also `bun test packages/gateway/src/federation`. If any federation/security test reds or D13 objects, revert C5d and keep the preamble in-file.

**C5a — auth.ts local helper:**

- [ ] **Step 7:** In `auth.ts`, add a same-file `function extractStringField(rec, ...aliases): string` (trim + first-non-undefined alias → trimmed string or "") and replace the ~9 repeated `const x = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "";` sites with it. Behavior-neutral. Run `bun test packages/gateway/src/ipc` (auth-handler tests green unedited) + typecheck.

**C5b/C5c — http-server.ts + peer-fanout.ts (optional):**

- [ ] **Step 8:** Inspect the 40/45 intra-file clones in `http-server.ts` and `peer-fanout.ts`. Extract a behavior-neutral local helper ONLY if the repeated blocks are genuinely identical handler/fan-out bodies; otherwise **skip and log** (recon judged these as single-definition utilities, low value). Do not risk behavior change for marginal lines.

- [ ] **Step 9: Commit** — `git commit -m "refactor(dedup): federation gate-commons + auth string-helper (C5; I17 scope kept in query-gate)"`

---

## Wave 2 — MCP shared (requires Wave 0; strict tsc on email tsconfigs)

> After any `mcp-connectors/shared/` edit, run `bunx tsc -p packages/mcp-connectors/{gmail,outlook,teams,google-meet,google-photos}/tsconfig.json`. Each new shared file ships a co-located `*.test.ts` (now coverage-counted via Task 1). Every connector `test/sandbox.test.ts` stays green **unedited**.

### Task 7 (C6): IMAP/JMAP email tool/server scaffolding → `mcp-connectors/shared/`

**Scope:** imap, protonmail, fastmail (IMAP/JMAP family). The Microsoft Graph / Google email connectors (outlook/onedrive/gmail) are REST → Task 8, not here.

**Files:**
- Create: `packages/mcp-connectors/shared/imap-tool-kit.ts` + `…/imap-tool-kit.test.ts`
- Modify: `packages/mcp-connectors/{imap,protonmail,fastmail}/src/tools.ts` (and `…/server.ts` for the shared helper funcs)

**Interfaces (Produces):**
```ts
export const emailToolSchemas: { listArgs; getArgs; searchArgs; sendArgs };   // shared zod schemas
export function viewEmailMessage<M>(m: M, formatAddr: (a) => string): Record<string, unknown>; // shared view transformer
```
Plus the byte-identical server.ts helper funcs (`envInt`, `previewFromParts`, `previewFetchQuery`, and the envelope/meta mappers) lifted to shared if they are identical across imap/protonmail.

- [ ] **Step 1: Write `imap-tool-kit.test.ts`** — schemas parse/reject correctly; `viewEmailMessage` maps a sample meta → the expected json shape (uid/mailbox/subject/from/to/cc/attachments/preview), Date→ISO. **Strict-tsc:** type the test inputs as the exact shared interfaces (exactOptionalPropertyTypes).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `imap-tool-kit.ts`** (schemas + `viewEmailMessage` + identical helper funcs). Keep it strictly typed; external payloads `unknown` at the boundary.
- [ ] **Step 4: Run the helper test — PASS.** Then `bunx tsc -p packages/mcp-connectors/{gmail,outlook,teams,google-meet,google-photos}/tsconfig.json` — clean (proves the new shared file passes strict tsc under the including connectors).
- [ ] **Step 5: Migrate tools.ts** for imap/protonmail/fastmail to import `emailToolSchemas` + `viewEmailMessage` and delete local copies. **server.ts class-body dedup (ImapFlowClient vs BridgeImapClient) is RISKY** (they implement different local interfaces `ImapClient`/`MailClient`): extract only the **identical free functions** to shared; **leave the class bodies** unless they collapse byte-for-byte behavior-neutrally — if not, log a defer for the class part.
- [ ] **Step 6: Verify** — `bun test packages/mcp-connectors/{imap,protonmail,fastmail}/` (sandbox tests green, unedited) + the email-tsconfig tsc loop + `bunx biome check` on the edited files.
- [ ] **Step 7: Commit** — `git commit -m "refactor(dedup): IMAP/JMAP email tool-kit → mcp shared (C6)"`

---

### Task 8 (C7): REST/Graph tool-registration scaffolding → `mcp-connectors/shared/`

**Scope:** github, github-actions, gitlab (REST) **and** outlook, onedrive, gmail (Graph/Google) — all share the "parse args → require token → fetch → wrap result" tool-registration body.

**Files:**
- Create: `packages/mcp-connectors/shared/rest-tool-kit.ts` + `…/rest-tool-kit.test.ts`
- Modify: the six connectors' `src/server.ts`

**Interfaces (Produces):**
```ts
export interface RestFetchResult { ok: boolean; status: number; json: unknown; text: string; }
export function restFetch(cfg: { apiBase: string; token: string; defaultHeaders?: Record<string,string>; tokenHeaderName?: string }, pathOrUrl: string, init?: RequestInit): Promise<RestFetchResult>;
export function resolvePaginationPath(input: { nextLink?: string; page?: number; perPage?: number }, buildPath: (page: number, perPage: number) => string, defaultPath: string): string;
// scope-gated registration (outlook/teams keep their own shouldRegister predicate)
export function registerRestScopedTool<A>(register: RegisterSimpleToolFn, grantedScopes: string[], input: { toolId: string; description: string; schema: ZodObjectSchema<A>; shouldRegister: (scopes: string[]) => boolean; handler: (parsed: A) => Promise<McpListResult> }): void;
```
Reuse the existing `shared/fetch-bearer-json.ts` / `mcp-tool-kit.ts` (`mcpJsonResultIfOk`) where possible — extend, don't duplicate. The `shouldRegister` scope predicates (`outlookToolShouldRegister` etc.) stay in each connector.

- [ ] **Step 1: Write `rest-tool-kit.test.ts`** — `restFetch` builds URL (path vs absolute), sets Bearer vs `PRIVATE-TOKEN` header, parses ok/non-ok JSON (fetch faked at the boundary); `resolvePaginationPath` (nextLink wins / page+perPage / default); `registerRestScopedTool` (registers only when `shouldRegister` true; rejects malformed args). Strict-tsc typed.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `rest-tool-kit.ts`.**
- [ ] **Step 4: Run — PASS** + email-tsconfig tsc loop (outlook/gmail include shared) clean.
- [ ] **Step 5: Migrate** the six connectors' repeated tool bodies to the helpers (keep per-connector base URL, headers, scope predicates, schemas, tool ids/descriptions). No force-fit — a tool whose body deviates stays inline.
- [ ] **Step 6: Verify** — `bun test packages/mcp-connectors/{github,github-actions,gitlab,outlook,onedrive,gmail}/` (sandbox tests green, unedited) + tsc loop + biome.
- [ ] **Step 7: Commit** — `git commit -m "refactor(dedup): REST/Graph tool-registration kit → mcp shared (C7)"`

---

## Wave 3 — Cross-boundary gateway↔mcp → `@nimbus-dev/sdk` (pure only)

> Each task: build sdk (`cd packages/sdk && bun run build`) before cross-package typecheck/tests. Each new sdk module ships a unit test (coverage-floor applies to sdk). I/O stays in callers.

### Task 9 (C8): Data-profile parsing → `sdk/src/data-profile/`

**Files:**
- Create: `packages/sdk/src/data-profile/index.ts` + `…/data-profile.test.ts`; re-export from `packages/sdk/src/index.ts`
- Modify: `packages/gateway/src/connectors/data-profile-mapping.ts`, `data-profile-sync.ts`; `packages/mcp-connectors/dataprofile/src/profile.ts`

**Interfaces (Produces — all PURE):**
```ts
export interface DataColumn { readonly name: string; readonly type: string | null; }
export interface ParquetMetadataLike { readonly schema?: ReadonlyArray<{ name?: unknown; type?: unknown }>; readonly num_rows?: number | bigint; }
export function jsKind(v: unknown): string;
export function parseCsvHeader(firstLine: string): DataColumn[];
export function parseJsonlColumns(firstLine: string): DataColumn[];
export function parseJsonColumns(parsed: unknown): { columns: DataColumn[]; rowCountEstimate: number | null };
export function parquetColumnsFromMetadata(meta: ParquetMetadataLike): { columns: DataColumn[]; rowCountEstimate: number | null };
export function firstLineAndRows(text: string, truncated: boolean): { firstLine: string; rowCountEstimate: number | null };
```
(`firstLineAndRows` is shared with C10b/localdb — this is its canonical home.) **I/O stays in callers:** `slurpFile`/`statViaHandle`/`sizeViaHandle`/`profileFile`/`profileParquet`.

- [ ] **Step 1: Write `data-profile.test.ts`** — table-driven cases for each function (csv header w/ quotes; jsonl key/type extraction never emitting values; json array vs object row-count; parquet schema→columns + num_rows bigint→number; firstLineAndRows truncated vs full). Assert the **no-cell-values** contract (only keys/types).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `data-profile/index.ts`** (copy the verified-identical pure functions verbatim from `profile.ts`). Re-export from sdk index. `cd packages/sdk && bun run build`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Migrate** gateway (both files) + the mcp connector to `import { … } from "@nimbus-dev/sdk";`, delete local copies. Keep all file I/O in place.
- [ ] **Step 6: Verify** — `bun test packages/gateway/src/connectors packages/mcp-connectors/dataprofile/` (green unedited) + `bun run typecheck | grep "error TS"`.
- [ ] **Step 7: Commit** — `git commit -m "refactor(dedup): data-profile parsing → @nimbus-dev/sdk (C8)"`

---

### Task 10 (C9): Fastmail JMAP request/response parsing → `sdk/src/jmap-fastmail/`

**Files:**
- Create: `packages/sdk/src/jmap-fastmail/index.ts` + test; re-export from sdk index
- Modify: `packages/gateway/src/connectors/fastmail-sync.ts`; `packages/mcp-connectors/fastmail/src/jmap-core.ts`

**Interfaces (Produces — all PURE):** `asRecord`, `asString`, `parseSession`, `formatAddress`, `formatAddresses`, `extractAttachments`, `capPreview`, `previewFor`, `viewEmail`, `buildListRequest`, `buildSearchRequest`, `buildGetRequest`, `methodResponseArgs`, `extractEmailList`, `validateApiUrl`, plus `JmapSession`/`JmapAttachmentMeta`/`JmapEmailView` types + the `EMAIL_PROPERTIES` / capability / max-bytes constants (signatures per recon). **I/O stays in callers:** `getSession`/`queryEmails` HTTP (`connectorFetch` / real `fetch`).

- [ ] **Step 1: Write the test** — `parseSession` (valid/missing fields → null), `viewEmail` (full email → view, missing id+messageId → null), `formatAddress(es)`, `capPreview` (whitespace-collapse + 2000 cap), `previewFor` (bodyValues vs preview fallback), `build*Request` (correct methodCalls shape), `methodResponseArgs`/`extractEmailList`, `validateApiUrl` (non-https / host-mismatch throws).
- [ ] **Step 2: Run — FAIL.** **Step 3:** Implement (verbatim pure functions), re-export, `bun run build` in sdk. **Step 4: PASS.**
- [ ] **Step 5: Migrate** gateway `fastmail-sync.ts` + mcp `jmap-core.ts` to import from sdk; keep HTTP transport + error handling in each caller.
- [ ] **Step 6: Verify** — `bun test packages/gateway/src/connectors packages/mcp-connectors/fastmail/` (green unedited) + typecheck.
- [ ] **Step 7: Commit** — `git commit -m "refactor(dedup): fastmail JMAP parsing → @nimbus-dev/sdk (C9)"`

---

### Task 11 (C10): flux / storybook → sdk; localdb partial

**Files:**
- Create: `packages/sdk/src/flux-cd/index.ts` + test; `packages/sdk/src/storybook/index.ts` + test; re-export both from sdk index
- Modify: `packages/gateway/src/connectors/flux-sync.ts` + `packages/mcp-connectors/flux/src/server.ts`; `packages/gateway/src/connectors/storybook-story-mapping.ts` + `packages/mcp-connectors/storybook/src/storybook-parse.ts`; `packages/gateway/src/connectors/localdb-sync.ts` + `packages/mcp-connectors/localdb/src/sql-scan.ts` (firstLineAndRows only)

**Interfaces (Produces — all PURE):**
```ts
// flux-cd
export interface FluxKindEntry { readonly kind: string; readonly group: string; readonly version: string; readonly plural: string; }
export const FLUX_KINDS: readonly FluxKindEntry[];
export function trimTrailingSlash(s: string): string;
// storybook
export interface StorybookStory { readonly id: string; readonly title: string | null; readonly name: string | null; readonly importPath: string | null; readonly tags: readonly string[]; readonly entryType: string | null; }
export function parseStorybookIndex(parsed: unknown): StorybookStory[];
```

- [ ] **Step 1: Write tests** — flux: `FLUX_KINDS` count/shape + `trimTrailingSlash`; storybook: `parseStorybookIndex` (entries vs stories container, id-required filter, tags filter).
- [ ] **Step 2: FAIL → implement both modules (verbatim) → re-export → `bun run build` sdk → PASS.**
- [ ] **Step 3: Migrate** flux (both sides) + storybook (both sides) to import from sdk; delete local copies.
- [ ] **Step 4 (localdb partial):** import the shared `firstLineAndRows` from `@nimbus-dev/sdk` (the C8 data-profile module) in both `localdb-sync.ts` and `sql-scan.ts`; delete their local copies. **Leave `collectSqlFiles` in each caller** (file-I/O — not hoistable). If C8 hasn't landed yet in branch order, sequence this after Task 9.
- [ ] **Step 5: Verify** — `bun test packages/gateway/src/connectors packages/mcp-connectors/{flux,storybook,localdb}/` (green unedited) + typecheck.
- [ ] **Step 6: Commit** — `git commit -m "refactor(dedup): flux/storybook → sdk; localdb firstLineAndRows shared (C10)"`

---

## Task 12 (Wave 4): Re-measure and tighten the CI duplication gate

**Do this LAST**, only after the cluster waves land and strict is confirmed `< 2.3%` (drive lower while clusters remain).

**Files:**
- Modify: `.github/workflows/ci.yml` (the `pr-quality-duplication` job, ~line 353)
- Verify: `.jscpd.json` (already min-lines 5 / threshold 3 — no change expected)

**Interfaces:** none (CI config + measurement).

- [ ] **Step 1: Re-measure strict jscpd**

Run: `bunx jscpd packages 2>&1 | tail -6`
Record the `Total:` strict % (baseline 4.83%). Confirm it is `< 2.3%`. If not yet under target, return to the residual tail (regenerate the report, re-rank by file-pair dup-lines, extract the next cluster) before tightening.

- [ ] **Step 2: Tighten the CI gate**

In `.github/workflows/ci.yml`, the `pr-quality-duplication` job currently runs:

```bash
bunx jscpd --min-lines 10 --min-tokens 50 --threshold 5 --reporters console -i "**/node_modules/**,**/*.test.ts,**/*.test.tsx,**/*.vitest.tsx" packages/
```

Replace it with the strict config-driven form (reads `.jscpd.json` = min-lines 5 / min-tokens 50 / threshold 3, the same settings as local `audit:duplication`):

```bash
bunx jscpd packages
```

- [ ] **Step 3: Confirm `.jscpd.json` matches**

Run: `cat .jscpd.json` — confirm `minLines: 5`, `minTokens: 50`, `threshold: 3` (already true). The `.jscpd.json` `ignore` set covers test files / SQL / fixtures; no new ignores are added.

- [ ] **Step 4: Verify the gate passes at the new threshold**

Run: `bunx jscpd packages; echo "exit: $?"`
Expected: exit 0 (strict % below 3% threshold, comfortably below 2.3%).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(dedup): tighten pr-quality-duplication to strict (min-lines 5 / threshold 3)

Local audit:duplication and CI now use identical .jscpd.json settings. Strict
duplication is under threshold after the big-PR extractions."
```

---

## Task 13 (Wave 4): Final verification + ship

**Files:** none (verification only).

- [ ] **Step 1: Full mcp-connectors + package test suites**

Run: `bun test packages/mcp-connectors/ 2>&1 | tail -8` then `bun test packages/gateway packages/cli packages/sdk packages/client 2>&1 | tail -8`
Expected: all pass (skips OK), 0 fail. `git status` shows no `*.test.ts` modified beyond the new helper tests.

- [ ] **Step 2: Coverage-floor (Docker-Linux authoritative)**

Run: `bash scripts/coverage-floor/build-lcov.sh && bun scripts/coverage-floor/check.ts` (or `reseed-docker.sh` for exact CI-Linux lcov). Only trust violations on files this PR changed; every new gateway/cli/sdk file must clear ≥80% line+branch.

- [ ] **Step 3: Full preflight (CI parity)**

Run: `bun run preflight`
Expected: green (tsc all packages — grep for `error TS`; lint; lint:markdown; structure audits incl. security-invariants + check-nimbus-invariants; tests). Fix any failure locally before pushing.

- [ ] **Step 4: Docs gates (a `.md` — spec + plan — is in this branch)**

Run: `bunx markdownlint-cli2 "docs/superpowers/specs/2026-06-17-jscpd-big-dedup-design.md" "docs/superpowers/plans/2026-06-17-jscpd-big-dedup.md"`
Then: `~/.cargo/bin/lychee --config lychee.toml --no-progress "docs/superpowers/specs/2026-06-17-jscpd-big-dedup-design.md" "docs/superpowers/plans/2026-06-17-jscpd-big-dedup.md"`
Expected: 0 errors each. **Delete any untracked `*-review.md` scratch first** (`rm docs/superpowers/specs/*-review.md`) — they break lychee/markdownlint and must never be committed.

- [ ] **Step 5: Whole-branch review + push**

Run a `/code-review` (or code-reviewer subagent) over `git diff main...HEAD`; fold in findings. Then push and open the PR. PR body records: strict 4.83% → <after>%; per-cluster summary; Wave-0 coverage fix; CI gate tightened to min-lines 5/threshold 3; pure dedup (no `*.test.ts` edited).

- [ ] **Step 6: Update memory**

Append the outcome to `jscpd-dedup-stage-a.md` + the `MEMORY.md` index line: PR #, strict delta, the Wave-0 instrument-scope fix, the sdk-as-shared-home decision, and any deferred pairs.
