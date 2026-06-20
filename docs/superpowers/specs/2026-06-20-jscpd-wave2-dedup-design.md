# jscpd Dedup — Wave 2 Design

**Date:** 2026-06-20 · **Branch:** `worktree-jscpd-dedup-wave2` (off `origin/main` `5613f7d3`)
**Predecessor:** PR #688 (Big-PR, 10 clusters, strict 4.83%→4.41%). This Wave-2 finishes the
deferred residuals and lowers the CI ratchet.

## Goal

Drive **strict** jscpd duplication (`bunx jscpd packages`, `.jscpd.json` min-lines 5 / min-tokens 50
/ threshold 4.5) lower by **pure extraction** (never ignores), then **lower the `.jscpd.json`
threshold** to just above the new strict %. Standing program target remains **< 3%**.

Fresh-main baseline re-measured live this session: **strict total 4.38%** (5819 dup-lines; typescript
4.67% / 5701 dup-lines across 559 clones).

## Non-negotiable: pure dedup, zero behavior change

Every connector / guard / sync test stays **GREEN UNEDITED**. No `.jscpd.json` ignore added. Each
extraction is byte-faithful: if a candidate cannot be unified without changing behavior (byte/upsert
accounting, error text, TLS config), it is **deferred and reported**, not force-fit (the #688/#673
fidelity rule).

## Clusters (live-ranked by file-pair dup-lines)

### C1 — agent-brief type guards → sdk guard-factory (~107 dup-lines)

- **Pair:** `cli/src/types/agents.ts` ↔ `gateway/src/agents/_lib/findings.ts` (107L, 9 clones).
- **What:** 8 byte-mechanical guards (`isExpertBrief`…`isPreflightBrief`). All share the base shape
  (`kind` / `agentVersion===1` / `Array.isArray(gaps)` / `typeof generatedAt==="number"` /
  `typeof latencyMs==="number"` + one brief-specific array check; janitor/preflight add boolean
  checks).
- **Divergence (must preserve):** the **gateway** guards additionally require
  `typeof b["query"]==="object" && b["query"]!==null`; the **CLI** guards do **not**. This is a real
  behavioral difference. The factory parameterizes it; we do **not** silently tighten CLI.
- **Extraction:** new `packages/sdk/src/agents/guard-factory.ts`:

  ```ts
  export function createBriefGuard<T>(
    kind: string,
    extra: (b: Record<string, unknown>) => boolean,
    opts?: { requireQuery?: boolean },
  ): (x: unknown) => x is T
  ```

  Base body checks kind/agentVersion/gaps/generatedAt/latencyMs, then (if `requireQuery`) the query
  object, then `extra(b)`. Exported from `packages/sdk/src/index.ts` barrel.
- **Call sites:** CLI `agents.ts` → `createBriefGuard<ExpertBrief>("expert", b => Array.isArray(b["ranked"]))`
  (requireQuery omitted → false, matches CLI today). Gateway `findings.ts` → same with
  `{ requireQuery: true }` (matches gateway today).
- **Tests green unedited:** `cli/src/types/agents.test.ts` (all "true" cases pass a `query`) and
  `gateway/src/agents/_lib/findings.test.ts` (asserts `query:null → false`). Add a co-located sdk
  test `guard-factory.test.ts` proving both branches (requireQuery on/off).
- **Coverage-floor:** extracting the guard bodies out of `findings.ts` may drop its branch% — verify
  via Docker lcov; add a co-located test if it dips below 80.

### C2 — imap/protonmail email connectors → mcp-connectors/shared (~133 + 86 dup-lines)

Two safe sub-parts plus one attempted-risky part.

- **C2a free helpers (server.ts, ~70L safe):** `toImapAddress`, `envelopeFromImap`, `toMessageMeta`,
  `previewFetchQuery` are byte-identical across `imap/src/server.ts` and `protonmail/src/server.ts`.
  Hoist to `shared/imap-mail-core.ts` (existing). Both import.
- **C2b tools.ts registration factory (~75L safe):** the 4 `registerSimpleTool` blocks
  (`*_list`/`*_get`/`*_search`/`*_mail_send`) are structurally identical; differ only in tool-name
  prefix + description text + the local client/mailer types. Add a factory to `shared/imap-tool-kit.ts`:

  ```ts
  export function registerEmailConnectorTools(opts: {
    registerSimpleTool: RegisterSimpleToolFn;
    toolPrefix: string;            // "imap" | "protonmail"
    descriptions: { list: string; get: string; search: string; send: string };
    client: EmailClientLike; mailer: EmailMailerLike;
    formatAddr: (a) => string;
  }): void
  ```

  Descriptions passed verbatim from each connector so tool metadata is byte-identical.
- **C2c class-body merge (ATTEMPT, defer-on-deviation):** `ImapFlowClient` (imap) vs
  `BridgeImapClient` (protonmail) differ in implemented interface (`ImapClient` vs `MailClient`),
  `newClient()` TLS (`secure:true` vs `secure:false`+`rejectUnauthorized:false`), and env prefixes.
  Attempt a shared base/factory in `shared/imap-mail-core.ts` parameterized on `{ tls, envPrefix }`
  that both client classes delegate to (e.g. a shared `withMailbox` + `newClient` factory). **Hard
  rule:** if structural-type or TLS fidelity forces any behavior change, revert to C2a/C2b only and
  record the deferral in the PR body. The `*-sync-fake-server`/`sandbox` tests are the guardrail.
- **Tests green unedited:** imap/protonmail `sandbox.test.ts`, `search-filter.test.ts`, gateway
  `imap-sync.test.ts` / `protonmail-sync.test.ts`.
- **FastMail (JMAP) stays out** — different protocol; already diverged in #688.

### C3 — cloudwatch/sagemaker async-enrichment CLI-shell helper (~69 + 34 dup-lines)

- **Pairs:** `cloudwatch-sync.ts` ↔ `sagemaker-sync.ts` (69L); `mcp-connectors/cloudwatch/tools.ts`
  ↔ `sagemaker/tools.ts` (34L).
- **Why #688 deferred:** both do **two-tier byte accounting** — bytes accumulate from the list page
  **and** from each per-item enrichment CLI call (`describe-log-streams` / `describe-model`), with a
  per-page enrichment cap (`MAX_DESCRIBE`). The existing single-pass `runSinglePassCliShellSync`
  models only one page's bytes.
- **Extraction:** new **sibling** helper in `gateway/src/connectors/_lib/cli-shell-sync.ts` (or a new
  `_lib/cli-shell-enrich-sync.ts`):

  ```ts
  export async function runAsyncEnrichmentCliShellSync<C, E>(
    ctx, cursor, spec: AsyncEnrichmentCliShellSyncSpec<C, E>): Promise<SyncResult>
  ```

  Spec adds, on top of `CliShellSyncSpec`: `maxEnrichmentPerPage?: number`;
  `enrichOne?: (creds, raw) => Promise<{ enrichment: E | undefined; bytes: number }>`;
  `map: (raw, enrichment: E | undefined, creds, now) => SyncUpsertRow | null`.
  **Byte fidelity:** `totalBytes += listPage.bytes` then, for each enriched item within the cap,
  `totalBytes += enrich.bytes`. Enrichment is **best-effort** (a thrown/failed enrich must not stop
  the upsert and must match the connectors' current behavior). Upsert count = one per mapped item,
  enrichment success irrelevant — exactly as today.
- **Defer:** `athena-sync.ts` (3-level catalog→database→table nested walk — does not fit the
  single-list+enrich shape). Record the deferral.
- **Residual note:** `cloud-logging-sync ↔ vertex-ai-sync` (46L) is service-specific `gcloud` spawn
  boilerplate (different argv, region handling) — **not** unifiable without behavior change; leave.
- **tools.ts (34L):** the cloudwatch/sagemaker MCP `tools.ts` share a search-registration tail —
  fold into the existing `mcp-search-tool.ts` / `registerZodTool` pattern if byte-faithful, else
  leave.
- **Tests green unedited:** `cloudwatch-sync.test.ts`, `sagemaker-sync.test.ts` (and untouched
  `cloud-logging-sync.test.ts`, `vertex-ai-sync.test.ts`, `athena-sync.test.ts`).

### C4 — REST registrar migration: gmail / outlook / onedrive / gitlab (~60 + 55 + intra-file)

- **Existing primitive:** `shared/mcp-tool-kit.ts` already exports `registerZodTool` /
  `createZodToolRegistrar`, which calls `schema.safeParse(args)` and on failure
  `throw new Error(parsed.error.message)` — **byte-identical** to the manual `safeParse` guard the
  unmigrated connectors repeat. So this is an **error-fidelity-preserving** migration, not risky.
- **What:** gmail (8 tools, ~75 intra-file dup-L) and outlook (10 tools, ~105 intra-file dup-L) call
  `registerSimpleTool` with a hand-written 5-line `safeParse`+throw guard per tool. Migrate each to
  `createZodToolRegistrar` so the parse boilerplate lives once in the shared registrar and the
  handler receives `parsed.data`. onedrive/gitlab likewise where the tool shape matches (their
  *fetcher* stays per-connector — gitlab `PRIVATE-TOKEN`, onedrive `arrayBuffer/bytes` — only the
  registration boilerplate is shared).
- **Fidelity rule:** the thrown error text must remain `parsed.error.message` (it does). Any tool
  whose current guard differs (custom error text, extra pre-checks) stays hand-written.
- **Tests green unedited:** each connector's `sandbox.test.ts` / `search-filter.test.ts`.
- **tsconfig trap:** gmail & outlook already `include: ["../shared/**/*.ts"]` → they typecheck every
  shared file incl. new `*.test.ts` under strict `noPropertyAccessFromIndexSignature`. Run the strict
  tsc loop (below) after any shared change.

### C5 — gateway email-mapping bodies → gateway `_lib` (~55 + 38 + 36 dup-lines)

- **Pairs:** `imap-email-mapping.ts` ↔ `protonmail-email-mapping.ts` (55L); `fastmail-` ↔
  `protonmail-email-mapping.ts` (38L); `imap-sync.ts` ↔ `protonmail-sync.ts` (36L).
- **C5a `buildEmailPayload` (common transform):** the subject→title clamp, preview clamp, date→ms,
  participants aggregation, and attachment-meta map are identical across the three mappers (modulo
  field-name aliases `filename`/`name`, `date`/`receivedAt`). Extract a pure helper into the existing
  `gateway/src/connectors/_lib/email-mapping.ts`:

  ```ts
  export function buildEmailPayload(input: {
    subject: string | null; preview: string; dateMs: number | null; syncedAt: number;
    attachments: readonly { filename?: string|null; name?: string|null; sizeBytes: number|null; mimeType: string|null }[];
    from: readonly string[]; to: readonly string[]; cc?: readonly string[];
  }): { title: string; bodyPreview: string; modifiedAt: number; attachments: …[]; participants: string[] }
  ```

  Per-connector ID-validation + service-specific `metadata` object **stay inline** (genuinely
  divergent — not force-fit).
- **C5b `parsePortSecret` (intFromSecret):** the 7-line port/secret numeric parser duplicated in
  `imap-sync.ts` + `protonmail-sync.ts` → a pure helper in `_lib` (e.g. `_lib/cli-shell-sync.ts`
  already hosts `isSafeCliArg`, or a small `_lib/secret-parsers.ts`).
- **C5c sync fetch/upsert loop (~29L, optional):** `imap-sync.ts` + `protonmail-sync.ts` share the
  rate-limit→fetch→outcome-check→map-loop→upsert→return body (protonmail already factored
  `transientResult()`). Extract `syncImapLikeBatch(ctx, { serviceId, ensureMcp, loadConfig,
  fetchMessages, mapMessage, pass1Cursor })` to `_lib` **only if** byte/upsert/cursor semantics stay
  exact; else ship C5a/C5b and defer.
- **Tests green unedited:** `_lib/email-mapping.test.ts` (+ new `buildEmailPayload` cases),
  `imap-sync.test.ts`, `protonmail-sync.test.ts`, `fastmail-sync.test.ts`. Add a co-located test for
  any helper that drops a caller's branch% under 80.

## Dependency placement (load-bearing)

- Cross-package types/logic shared by **cli ↔ gateway** → `@nimbus-dev/sdk` (MIT; the only pkg both
  import). C1 lives here.
- Shared **mcp-connector** logic → `packages/mcp-connectors/shared/` (NOT sdk). C2, C4 live here.
- Shared **gateway** logic → `gateway/src/connectors/_lib/`. C3, C5 live here.
- sdk uses `exactOptionalPropertyTypes` — never pass `{ x: undefined }` in sdk tests.

## Execution discipline (from #688)

- **Subagent-driven TDD**, one cluster per implementer subagent. Background subagents **can** run
  `bun test` but **cannot** `git commit` — the controller runs the strict tsc loop + biome + commit +
  jscpd re-measure after each cluster, verifying file state (don't trust self-reports). No
  `SendMessage` resume of a rested agent → dispatch a fresh "complete from state X".
- **★ Strict-tsc loop after EVERY `mcp-connectors/shared/` change** (TS4111 trap — `bun test` passes
  but the email connectors fail):
  `for c in gmail outlook teams google-meet google-photos; do bunx tsc -p packages/mcp-connectors/$c/tsconfig.json; done`
- **`git checkout -- docs/structure-audit/`** before every commit (jscpd + `audit:structure`
  regenerate those JSONs).
- The 5 false-local coverage-floor violations are ipc-transport / ipc-server / socket-listeners /
  telemetry / collector — ignore for files we didn't touch.
- Do **not** put `bun run <script>` / `bunx <tool>` literals in ci.yml comments (the preflight drift
  guard regex scans comments).

## Ship sequence

1. Land clusters C1→C5 (commit per cluster, jscpd re-measure after each).
2. Re-measure final strict %; **lower `.jscpd.json` `threshold`** to just above it (round up ~0.1).
   Keep `ci.yml` → `bunx jscpd packages` (already local==CI).
3. Full `bun run preflight` (all-package tsc, lint, lint:markdown, structure audits, tests) +
   Docker coverage-floor (`build-lcov.sh` + `check.ts`) + `bunx markdownlint-cli2` + lychee (docs
   changed) + whole-branch `/code-review`. Fix findings BEFORE the first push.
4. Never commit superpowers `*-review.md` scratch.

## Out of scope (deferred, recorded)

- `gateway-process.ts` ↔ `gw-state-helpers.ts` (67L) — documented un-dedupable twin.
- imap/protonmail SMTP mailer class merge (env-prefix/transport divergence) unless C2c proves clean.
- athena async-enrichment (3-level nested walk); cloud-logging↔vertex-ai gcloud spawn boilerplate.
- Wholesale connector-template restructuring for the final push to < 3% (separate future project).
