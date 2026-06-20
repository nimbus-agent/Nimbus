# jscpd Dedup Wave-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive strict `bunx jscpd packages` duplication below the 4.38% baseline by pure extraction across 5 deferred clusters, then lower the `.jscpd.json` ratchet to just above the new strict %.

**Architecture:** Each cluster extracts byte-identical duplicated code into an existing/new shared
helper (sdk for cli↔gateway, `mcp-connectors/shared/` for connectors, `gateway/_lib/` for gateway),
migrates the call sites, and proves zero behavior change by keeping every existing test green
**unedited**. New helpers get co-located TDD tests.

**Tech Stack:** Bun 1.2+ / TypeScript 6 strict, Biome, jscpd, zod, bun:test.

## Global Constraints

- **Pure dedup, zero behavior change.** Every existing connector/guard/sync test stays GREEN UNEDITED. No `.jscpd.json` ignore added.
- **Defer-on-deviation:** if a candidate cannot be unified byte-faithfully (byte/upsert accounting, error text, TLS config, structural types), revert that part and record the deferral. Do not force-fit.
- **No `any`** — use `unknown` for external data (Non-Negotiable #7).
- Cross-package cli↔gateway shared code → `@nimbus-dev/sdk` (MIT). Connector-shared → `packages/mcp-connectors/shared/`. Gateway-shared → `gateway/src/connectors/_lib/`.
- **sdk uses `exactOptionalPropertyTypes`** — never pass `{ x: undefined }` in sdk tests.
- **★ After ANY `mcp-connectors/shared/` change**, run the strict tsc loop (the email connectors include `../shared/**` under `noPropertyAccessFromIndexSignature`):
  `for c in gmail outlook teams google-meet google-photos; do bunx tsc -p packages/mcp-connectors/$c/tsconfig.json || echo "FAIL $c"; done`
- **`git checkout -- docs/structure-audit/`** before every commit (jscpd + audit:structure regenerate those JSONs).
- Controller (not subagent) runs the tsc loop + biome + `git commit` + jscpd re-measure after each cluster. Background subagents can run `bun test` but not commit. Verify file state; don't trust self-reports.
- Build sdk + client first in the worktree (`cd packages/sdk && bun run build`; `cd packages/client && bun run build`) — already done this session; rebuild sdk after C1 before cross-package typecheck.

---

### Task C1: agent-brief guards → sdk guard-factory

**Files:**

- Create: `packages/sdk/src/agents/guard-factory.ts`
- Create: `packages/sdk/src/agents/guard-factory.test.ts`
- Modify: `packages/sdk/src/index.ts` (barrel: export `createBriefGuard`)
- Modify: `packages/cli/src/types/agents.ts` (replace 8 guard bodies with factory calls, `requireQuery` omitted)
- Modify: `packages/gateway/src/agents/_lib/findings.ts` (replace 8 guard bodies with factory calls, `requireQuery: true`)

**Interfaces:**

- Produces: `createBriefGuard<T>(kind: string, extra: (b: Record<string, unknown>) => boolean, opts?: { requireQuery?: boolean }): (x: unknown) => x is T`

- [ ] **Step 1 — Read the two source files fully.** `packages/cli/src/types/agents.ts` (guards at lines ~34–276) and `packages/gateway/src/agents/_lib/findings.ts` (guards at lines ~148–269). Record each guard's exact `extra` predicate (the brief-specific field checks) and confirm gateway adds `typeof b["query"]==="object" && b["query"]!==null` while CLI does not.

- [ ] **Step 2 — Write `guard-factory.test.ts` (failing).** Cover both branches:

```ts
import { describe, expect, it } from "bun:test";
import { createBriefGuard } from "./guard-factory.ts";

describe("createBriefGuard", () => {
  const base = { kind: "x", agentVersion: 1, generatedAt: 0, latencyMs: 0, gaps: [] };
  const isX = createBriefGuard<unknown>("x", (b) => Array.isArray(b["items"]));
  const isXq = createBriefGuard<unknown>("x", (b) => Array.isArray(b["items"]), { requireQuery: true });

  it("matches base shape + extra when requireQuery is off (CLI behaviour)", () => {
    expect(isX({ ...base, items: [] })).toBe(true);           // no query needed
    expect(isX({ ...base, items: [] , query: { a: 1 } })).toBe(true);
  });
  it("rejects wrong kind / version / non-array gaps / extra-fail", () => {
    expect(isX({ ...base, kind: "y", items: [] })).toBe(false);
    expect(isX({ ...base, agentVersion: 2, items: [] })).toBe(false);
    expect(isX({ ...base, gaps: "no", items: [] })).toBe(false);
    expect(isX({ ...base, items: "no" })).toBe(false);
  });
  it("requires a query object only when requireQuery is on (gateway behaviour)", () => {
    expect(isXq({ ...base, items: [] })).toBe(false);          // missing query
    expect(isXq({ ...base, items: [], query: null })).toBe(false);
    expect(isXq({ ...base, items: [], query: { a: 1 } })).toBe(true);
  });
  it("rejects null / non-object", () => {
    expect(isX(null)).toBe(false);
    expect(isX("s")).toBe(false);
  });
});
```

- [ ] **Step 3 — Run it, expect FAIL** (`bun test packages/sdk/src/agents/guard-factory.test.ts`) → "Cannot find module ./guard-factory.ts".

- [ ] **Step 4 — Implement `guard-factory.ts`:**

```ts
/**
 * Build a discriminated-union type guard for an agent brief. The base shape
 * (kind / agentVersion===1 / Array.isArray(gaps) / numeric generatedAt+latencyMs)
 * plus a connector-supplied `extra` predicate. `requireQuery` adds the
 * `typeof query === "object" && query !== null` check used by the gateway-side
 * guards (the CLI-side guards omit it — preserved by defaulting it off).
 */
export function createBriefGuard<T>(
  kind: string,
  extra: (b: Record<string, unknown>) => boolean,
  opts?: { requireQuery?: boolean },
): (x: unknown) => x is T {
  const requireQuery = opts?.requireQuery ?? false;
  return (x: unknown): x is T => {
    if (x === null || typeof x !== "object") return false;
    const b = x as Record<string, unknown>;
    if (
      b["kind"] !== kind ||
      b["agentVersion"] !== 1 ||
      !Array.isArray(b["gaps"]) ||
      typeof b["generatedAt"] !== "number" ||
      typeof b["latencyMs"] !== "number"
    ) {
      return false;
    }
    if (requireQuery && (typeof b["query"] !== "object" || b["query"] === null)) {
      return false;
    }
    return extra(b);
  };
}
```

- [ ] **Step 5 — Run test, expect PASS.**

- [ ] **Step 6 — Barrel export** in `packages/sdk/src/index.ts`: `export { createBriefGuard } from "./agents/guard-factory.ts";` (follow the existing brief-types export style).

- [ ] **Step 7 — Rebuild sdk:** `cd packages/sdk && bun run build`.

- [ ] **Step 8 — Migrate CLI guards** in `packages/cli/src/types/agents.ts`: replace each `export function isXxxBrief(x): x is XxxBrief { … }` body with `export const isXxxBrief = createBriefGuard<XxxBrief>("xxx", (b) => <the exact extra predicate>);` — import `createBriefGuard` from `@nimbus-dev/sdk`. `requireQuery` OMITTED. Match each `extra` to the file's current per-brief checks verbatim (e.g. expert→`Array.isArray(b["ranked"])`, impact→`Array.isArray(b["affected"])`, catchup→`Array.isArray(b["sections"])`, ghost→`Array.isArray(b["findings"])`, conflict→`Array.isArray(b["collisions"])`, huddle→`Array.isArray(b["contributions"])`, janitor→`Array.isArray(b["peersTouched"]) && typeof b["idle"]==="boolean"`, preflight→`Array.isArray(b["downstreams"]) && typeof b["anyFailed"]==="boolean" && typeof b["anyIncomplete"]==="boolean"`). **Verify each predicate against the actual file** — the field names above are from recon; confirm before trusting.

- [ ] **Step 9 — Migrate gateway guards** in `packages/gateway/src/agents/_lib/findings.ts`: same, but pass `{ requireQuery: true }`.

- [ ] **Step 10 — Run both existing guard suites UNEDITED:** `bun test packages/cli/src/types/agents.test.ts packages/gateway/src/agents/_lib/findings.test.ts` → all PASS. If any fail, the `extra`/`requireQuery` mapping is wrong — fix the mapping, never the test.

- [ ] **Step 11 — Controller:** strict tsc (`bunx tsc -p packages/cli/tsconfig.json`, `bunx tsc -p packages/gateway/tsconfig.json`, `bunx tsc -p packages/sdk/tsconfig.json`), `bunx biome check --write packages/sdk packages/cli packages/gateway`, `git checkout -- docs/structure-audit/`, commit `refactor(dedup): C1 agent-brief guards → sdk createBriefGuard`.

- [ ] **Step 12 — jscpd re-measure:** `bunx jscpd packages` — confirm the `cli/types/agents.ts ↔ gateway/agents/_lib/findings.ts` 107-line pair is gone; record new total.

---

### Task C2: imap/protonmail email connectors → shared

**Files:**

- Modify: `packages/mcp-connectors/shared/imap-mail-core.ts` (add free helpers; attempt shared client base)
- Modify: `packages/mcp-connectors/shared/imap-tool-kit.ts` (add `registerEmailConnectorTools` factory)
- Modify/Test: `packages/mcp-connectors/shared/imap-tool-kit.test.ts`, `imap-mail-core.test.ts` (or new co-located tests)
- Modify: `packages/mcp-connectors/imap/src/server.ts`, `imap/src/tools.ts`
- Modify: `packages/mcp-connectors/protonmail/src/server.ts`, `protonmail/src/tools.ts`

**Interfaces:**

- Consumes: existing `emailToolSchemas`, `viewEmailMessage`, `EmailMessageMeta`, `RegisterSimpleToolFn` from `imap-tool-kit.ts`/`mcp-tool-kit.ts`.
- Produces: free helpers `toImapAddress`, `envelopeFromImap`, `toMessageMeta`, `previewFetchQuery` (exact existing signatures); `registerEmailConnectorTools(opts)` (see spec C2b).

**Sub-part C2a — free helpers (server.ts):**

- [ ] **Step 1 — Confirm byte-identity.** Diff the 4 helpers between `imap/src/server.ts` (~lines 36–94) and `protonmail/src/server.ts` (~lines 38–90). They must be identical modulo whitespace. If any differs, only hoist the identical ones; note the rest.

- [ ] **Step 2 — Write failing co-located test** in `imap-mail-core.test.ts` for at least `envelopeFromImap` + `toMessageMeta` (feed a sample imapflow envelope, assert the mapped shape — copy expected values from the current behavior).

- [ ] **Step 3 — Run, expect FAIL.**

- [ ] **Step 4 — Move the 4 helpers verbatim** into `imap-mail-core.ts`, exported. Keep their exact bodies + types. (If a helper references a connector-local type, widen to the shared `EmailMessageMeta`/a small shared input type without changing runtime behavior.)

- [ ] **Step 5 — Run test, expect PASS.**

- [ ] **Step 6 — Replace both connectors' local copies with imports** from `../../shared/imap-mail-core.ts`.

**Sub-part C2b — tools.ts registration factory:**

- [ ] **Step 7 — Read both `tools.ts` fully** (`imap/src/tools.ts`, `protonmail/src/tools.ts`, ~1–106). Confirm the 4 `registerSimpleTool` blocks differ only in tool-name prefix + description strings + the local client/mailer types.

- [ ] **Step 8 — Write failing test** in `imap-tool-kit.test.ts` for `registerEmailConnectorTools`: pass a fake `registerSimpleTool` that records `(name, description)` tuples + a fake client/mailer, assert it registers exactly `${prefix}_list|_get|_search|_mail_send` with the supplied descriptions, and that invoking the recorded handlers calls the fake client/mailer (1 assertion per tool) and returns `mcpJsonResult`-shaped output.

- [ ] **Step 9 — Run, expect FAIL.**

- [ ] **Step 10 — Implement `registerEmailConnectorTools(opts)`** in `imap-tool-kit.ts` per spec C2b. Internally reuse `emailToolSchemas`, `viewEmailMessage`, and the existing parse-guard pattern (mirror the current tools.ts handler bodies verbatim — same `safeParse`/`clampLimit`/`client.search` calls). Define minimal `EmailClientLike`/`EmailMailerLike` structural interfaces that both connectors' clients satisfy.

- [ ] **Step 11 — Run test, expect PASS.**

- [ ] **Step 12 — Migrate both `tools.ts`** to a single `registerEmailConnectorTools({...})` call, passing each connector's exact tool descriptions verbatim and its client/mailer.

**Sub-part C2c — class-body merge (ATTEMPT, defer-on-deviation):**

- [ ] **Step 13 — Attempt** a shared `newClient`/`withMailbox` factory in `imap-mail-core.ts` parameterized on `{ secure: boolean; tls?: {...}; host; port; auth }` that `ImapFlowClient` and `BridgeImapClient` both delegate to. Preserve protonmail's `secure:false`+`rejectUnauthorized:false` and imap's `secure:true` exactly.

- [ ] **Step 14 — Gate:** run imap + protonmail `sandbox.test.ts` + gateway `imap-sync.test.ts`/`protonmail-sync.test.ts`. If green AND strict tsc clean → keep. If ANY deviation/type-friction → **revert C2c only**, record the deferral in the PR body, keep C2a+C2b.

- [ ] **Step 15 — Run all four connectors' existing tests UNEDITED:** `bun test packages/mcp-connectors/imap packages/mcp-connectors/protonmail` (+ gateway imap/protonmail sync tests) → PASS.

- [ ] **Step 16 — Controller:** **strict tsc loop** (`for c in gmail outlook teams google-meet google-photos; do bunx tsc -p packages/mcp-connectors/$c/tsconfig.json; done`) PLUS `bunx tsc -p packages/mcp-connectors/imap/tsconfig.json` + `…/protonmail/tsconfig.json`; `bunx biome check --write packages/mcp-connectors`; `git checkout -- docs/structure-audit/`; commit `refactor(dedup): C2 imap/protonmail → shared helpers + tool factory`.

- [ ] **Step 17 — jscpd re-measure**, record new total.

---

### Task C3: cloudwatch/sagemaker async-enrichment CLI-shell helper

**Files:**

- Modify: `packages/gateway/src/connectors/_lib/cli-shell-sync.ts` (add `runAsyncEnrichmentCliShellSync` + spec type)
- Create: `packages/gateway/src/connectors/_lib/cli-shell-enrich-sync.test.ts` (co-located unit test for the new helper)
- Modify: `packages/gateway/src/connectors/cloudwatch-sync.ts`, `sagemaker-sync.ts`

**Interfaces:**

- Consumes: `isSafeCliArg`, `CliShellOutcome`, `ParsedCliPage`, `SyncUpsertRow` from `cli-shell-sync.ts`; `syncPassCursorParseEmpty`/`syncPassCursorSuccess`/`syncNoopResult`.
- Produces:

  ```ts
  export interface AsyncEnrichmentCliShellSyncSpec<C, E> {
    readonly ensureRunning: () => Promise<void>;
    readonly loadCreds: () => Promise<C | null>;
    readonly pass1Cursor: () => string;
    readonly maxPages: number;
    readonly maxEnrichmentPerPage?: number;
    readonly runCliPage: (creds: C, page: number, pageCursor: string) => Promise<CliShellOutcome>;
    readonly parsePage: (text: string, page: number) => ParsedCliPage;
    readonly enrichOne?: (creds: C, raw: unknown) => Promise<{ enrichment: E | undefined; bytes: number }>;
    readonly map: (raw: unknown, enrichment: E | undefined, creds: C, now: number) => SyncUpsertRow | null;
  }
  export async function runAsyncEnrichmentCliShellSync<C, E>(ctx: SyncContext, cursor: string | null, spec: AsyncEnrichmentCliShellSyncSpec<C, E>): Promise<SyncResult>
  ```

- [ ] **Step 1 — Read `cloudwatch-sync.ts` + `sagemaker-sync.ts` fully** and the two test files (`test/unit/connectors/cloudwatch-sync.test.ts`, `sagemaker-sync.test.ts`). Record EXACT accounting: outer page bytes (`state.bytes += res.text.length`), per-enrichment bytes (`state.bytes += summary.bytes` / `+= d.bytes`), enrichment cap (`MAX_DESCRIBE`), best-effort enrichment failure handling (enrich error → still upsert), upsert-count semantics (one per group/model).

- [ ] **Step 2 — Write `cli-shell-enrich-sync.test.ts` (failing)** that drives the helper with fakes and asserts the fidelity rules: (a) total bytes = list-page bytes + Σ enrich bytes within cap; (b) upsert count = mapped non-null items; (c) enrichment beyond `maxEnrichmentPerPage` is NOT called; (d) an `enrichOne` that throws/returns `{enrichment: undefined, bytes: N}` still upserts and still counts its bytes; (e) first-page `ok:false` → `syncPassCursorParseEmpty`; (f) `loadCreds → null` → `syncNoopResult`; (g) token pagination threads `pageCursor`.

- [ ] **Step 3 — Run, expect FAIL.**

- [ ] **Step 4 — Implement `runAsyncEnrichmentCliShellSync`** mirroring `runSinglePassCliShellSync` but: after `parsePage`, iterate items; for each item up to `maxEnrichmentPerPage`, call `enrichOne` (try/catch → `{enrichment:undefined, bytes:0}` on throw, matching connector best-effort), add its bytes, then `map(raw, enrichment, creds, now)`; items beyond the cap call `map(raw, undefined, …)`. **Match the connectors' exact best-effort + byte rules** (read them — if a connector adds enrich bytes even on failure, replicate that). Keep all the single-pass error/cursor handling identical.

- [ ] **Step 5 — Run test, expect PASS.**

- [ ] **Step 6 — Migrate `cloudwatch-sync.ts`** to call the helper: `runCliPage` = describe-log-groups page; `enrichOne` = `peekStreams` returning `{enrichment, bytes}`; `map` builds the log-group row using the enrichment. Preserve `isSafeCliArg` guards, MAX cap, and the exact mapped row.

- [ ] **Step 7 — Migrate `sagemaker-sync.ts`** similarly: `enrichOne` = `describeModel`, cap = `MAX_DESCRIBE`.

- [ ] **Step 8 — Run existing tests UNEDITED:** `bun test packages/gateway/test/unit/connectors/cloudwatch-sync.test.ts packages/gateway/test/unit/connectors/sagemaker-sync.test.ts` → PASS. If byte/upsert assertions fail, the accounting deviates — fix the helper/wiring, never the test. **If cloudwatch or sagemaker cannot reach byte-exactness, defer that connector and record it.**

- [ ] **Step 9 — Leave athena/cloud-logging/vertex-ai untouched** (deferred per spec).

- [ ] **Step 10 — Controller:** `bunx tsc -p packages/gateway/tsconfig.json`, `bunx biome check --write packages/gateway/src/connectors`, `git checkout -- docs/structure-audit/`, commit `refactor(dedup): C3 cloudwatch/sagemaker → async-enrichment CLI-shell helper`.

- [ ] **Step 11 — jscpd re-measure**, record new total. Note: cloudwatch/sagemaker `tools.ts` (34L) — fold into `mcp-search-tool`/`registerZodTool` only if byte-faithful, else leave (record).

---

### Task C4: REST registrar migration (gmail / outlook / onedrive / gitlab)

**Files:**

- Modify: `packages/mcp-connectors/gmail/src/server.ts`, `outlook/src/server.ts`, `onedrive/src/server.ts`, `gitlab/src/server.ts`
- (No shared change needed — `registerZodTool`/`createZodToolRegistrar` already exist in `shared/mcp-tool-kit.ts`.)

**Interfaces:**

- Consumes: `createZodToolRegistrar(registerSimpleTool)` → `<T>(name, description, schema, handler:(args:T)=>Promise<McpListResult>)=>void` from `shared/mcp-tool-kit.ts`. On parse failure it throws `new Error(parsed.error.message)` — identical to the manual guard being removed.

- [ ] **Step 1 — Read gmail/server.ts fully.** Confirm each tool uses `registerSimpleTool(name, desc, schema.shape, async (args:unknown)=>{ const parsed = schema.safeParse(args); if(!parsed.success) throw new Error(parsed.error.message); … })`. Confirm NO tool uses custom error text or extra pre-parse logic (those stay hand-written).

- [ ] **Step 2 — Migrate gmail:** at the top, `const reg = createZodToolRegistrar(registerSimpleTool);` then convert each tool to `reg("gmail_x", "desc", schemaObj, async (data) => { …use data instead of parsed.data… });` removing the manual `safeParse` guard. `schemaObj` must be the `z.object` (with `.safeParse`/`.shape`), not `.shape`. Leave the per-tool URL/fetch/return bodies byte-identical (just rename `parsed.data` → `data`).

- [ ] **Step 3 — Run gmail tests UNEDITED:** `bun test packages/mcp-connectors/gmail` → PASS (incl. the invalid-arg test that asserts the thrown message).

- [ ] **Step 4 — Repeat for outlook** (preserve the `outlookToolShouldRegister(...)` conditional wrapper around each `reg(...)` call — only the parse guard moves into the registrar).

- [ ] **Step 5 — Run outlook tests UNEDITED** → PASS.

- [ ] **Step 6 — Repeat for onedrive and gitlab** where the tool shape matches (manual safeParse guard only). Their custom fetchers (`graphRequest` arrayBuffer/bytes; `glFetch` PRIVATE-TOKEN) stay untouched. Any tool with custom error text → skip, record.

- [ ] **Step 7 — Run onedrive + gitlab tests UNEDITED** → PASS.

- [ ] **Step 8 — Controller:** **strict tsc loop** (gmail/outlook/teams/google-meet/google-photos) + `bunx tsc -p` for onedrive/gitlab; `bunx biome check --write packages/mcp-connectors`; `git checkout -- docs/structure-audit/`; commit `refactor(dedup): C4 gmail/outlook/onedrive/gitlab → shared zod tool registrar`.

- [ ] **Step 9 — jscpd re-measure**, record new total.

---

### Task C5: gateway email-mapping bodies → `_lib`

**Files:**

- Modify: `packages/gateway/src/connectors/_lib/email-mapping.ts` (+ `buildEmailPayload`), `email-mapping.test.ts`
- Create (or extend `_lib`): a `parsePortSecret` helper (place in `_lib/cli-shell-sync.ts`'s sibling or a new `_lib/secret-parsers.ts` with co-located test)
- Modify: `packages/gateway/src/connectors/imap-email-mapping.ts`, `protonmail-email-mapping.ts`, `fastmail-email-mapping.ts`, `imap-sync.ts`, `protonmail-sync.ts`

**Interfaces:**

- Produces: `buildEmailPayload(input) → { title, bodyPreview, modifiedAt, attachments, participants }` (see spec C5a); `parsePortSecret(raw: string | null | undefined, fallback: number): number`.

- [ ] **Step 1 — Read all three `*-email-mapping.ts` fully.** Confirm the common transform block (subject→title clamp, preview clamp, date→ms, attachment map, participants) is identical modulo field-name aliases. Record the per-connector ID-validation + metadata that must stay inline.

- [ ] **Step 2 — Write failing `buildEmailPayload` tests** in `email-mapping.test.ts`: empty subject → `"(no subject)"`, clamp at `TITLE_MAX`/`PREVIEW_MAX`, `dateMs ?? syncedAt` fallback, attachment `filename ?? name ?? null` aliasing, participants = `[...from, ...to, ...(cc ?? [])]`.

- [ ] **Step 3 — Run, expect FAIL.**

- [ ] **Step 4 — Implement `buildEmailPayload`** in `email-mapping.ts` (reuse the existing `clamp`/`parseDateMs`/`TITLE_MAX`/`PREVIEW_MAX`). Pure function, no I/O.

- [ ] **Step 5 — Run, expect PASS.**

- [ ] **Step 6 — Migrate the three mappers** to call `buildEmailPayload(...)` for the common block, keeping each connector's ID validation + `metadata` object inline.

- [ ] **Step 7 — Write failing `parsePortSecret` test** (empty/whitespace → fallback; valid 1–65535 → trunc; 0/negative/>65535/NaN → fallback).

- [ ] **Step 8 — Implement `parsePortSecret`**, then replace `intFromSecret` in `imap-sync.ts` + `protonmail-sync.ts` with imports.

- [ ] **Step 9 — (Optional C5c) sync batch loop:** if `imap-sync.ts`/`protonmail-sync.ts` share the rate-limit→fetch→map→upsert body byte-faithfully, extract `syncImapLikeBatch(ctx, {...})` to `_lib` with a co-located test; else skip and record.

- [ ] **Step 10 — Run existing tests UNEDITED:** `bun test packages/gateway/test/unit/connectors/imap-sync.test.ts packages/gateway/test/unit/connectors/protonmail-sync.test.ts packages/gateway/test/unit/connectors/fastmail-sync.test.ts packages/gateway/src/connectors/_lib/email-mapping.test.ts` → PASS.

- [ ] **Step 11 — Coverage check:** if extracting pure fns dropped a mapper's branch% under 80, add a co-located test (verify via Docker lcov in the ship task).

- [ ] **Step 12 — Controller:** `bunx tsc -p packages/gateway/tsconfig.json`, `bunx biome check --write packages/gateway/src/connectors`, `git checkout -- docs/structure-audit/`, commit `refactor(dedup): C5 gateway email-mapping → _lib buildEmailPayload + parsePortSecret`.

- [ ] **Step 13 — jscpd re-measure**, record new total.

---

### Task SHIP: lower ratchet + full preflight + push

**Files:**

- Modify: `.jscpd.json` (`threshold`)

- [ ] **Step 1 — Final strict measure:** `bunx jscpd packages`. Record the new total %.

- [ ] **Step 2 — Lower the ratchet:** set `.jscpd.json` `"threshold"` to just above the new strict total (round up ~0.1, e.g. new 3.7% → `3.8`). Leave `ci.yml` running `bunx jscpd packages`. Re-run `bunx jscpd packages` → must EXIT 0 (under threshold). `git checkout -- docs/structure-audit/` after.

- [ ] **Step 3 — Full preflight:** `bun run preflight` (all-package tsc, lint, lint:markdown, structure audits, full tests). Fix any red.

- [ ] **Step 4 — Coverage-floor (Docker-Linux authoritative):** `bash scripts/coverage-floor/build-lcov.sh && bun scripts/coverage-floor/check.ts`. Trust only files we changed; the 5 false-local violations (ipc-transport/ipc-server/socket-listeners/telemetry/collector) + mcp-connector files are expected noise. If a changed file is under 80, add a co-located test. Use `reseed-docker.sh` for exact CI lcov if in doubt.

- [ ] **Step 5 — markdownlint + lychee** (docs changed): `bunx markdownlint-cli2 "docs/**/*.md" "*.md"` and `lychee --config lychee.toml --no-progress 'docs/**/*.md' '*.md'`. Fix. **Do NOT commit any superpowers `*-review.md` scratch** (rm untracked scratch before re-verifying).

- [ ] **Step 6 — Whole-branch review:** `/code-review` (or a code-reviewer subagent over `git diff main...HEAD`). Fold findings in pre-push.

- [ ] **Step 7 — Final guard:** `git checkout -- docs/structure-audit/`; `git status` clean except intended files; confirm no `*-review.md` tracked.

- [ ] **Step 8 — Push + open PR** with a body listing: clusters landed, deferrals recorded (C2c if reverted, athena, cloud-logging/vertex-ai, gateway-process twin), strict %% before→after, and the ratchet change.

## Self-Review

- **Spec coverage:** C1✓ C2(a/b/c)✓ C3✓ C4✓ C5(a/b/c)✓ ship+ratchet✓ deferrals recorded✓.
- **Placeholder scan:** new-helper code + test code provided in full; migration steps cite exact files + the verbatim-copy rule for existing bodies (intentional — the implementer copies existing connector code, not re-invents it).
- **Type consistency:** `createBriefGuard`, `runAsyncEnrichmentCliShellSync`/`AsyncEnrichmentCliShellSyncSpec`, `registerEmailConnectorTools`, `buildEmailPayload`, `parsePortSecret` names are used consistently across tasks and the spec.
