# `nimbus security scan` v2 — Design

**Status:** Approved 2026-06-04. One PR (branch `dev/asafgolombek/security-scan-v2`). Closes the Phase 5 roadmap item "`nimbus security scan` v2" (six deferred enhancements).

**Goal:** Take the v1 secret scanner from a fixed-pattern, all-or-nothing, blocking scan to a configurable, CI-friendly, attributable one — without a live `git` subprocess at scan time.

---

## Background (v1, current state)

- CLI `packages/cli/src/commands/security.ts` → `client.call("security.scan", {})`.
- Gateway `packages/gateway/src/ipc/security-rpc.ts` — `dispatchSecurityRpc`, `iterateScannableItems` (SELECT items where `sync_state.depth != 'metadata_only'`), `SecurityFinding` type, and a `security.scan_completed` audit entry via `appendAuditEntry`.
- Core `packages/gateway/src/security/scan.ts` — `scanItemsForSecrets()` scans each item's **`body_preview`** only.
- Patterns `packages/gateway/src/security/secret-patterns.ts` — `SECRET_PATTERNS` (20 high-confidence patterns; categories `api_key | private_key | token`).
- The only git-tracked scannable surface is `code_symbol` items from `filesystem-v2-sync.ts`: `body_preview = "<relPath>\n<excerpt>"` (≈380-char slice around an exported symbol), `metadata = { name, kind, file, repoRoot }`. **No excerpt start line is stored, and no blame data exists.** `git_commit` items carry only SHA/subject/timestamp (`author_id` is null).
- Latest migration is **V31**; next is **V32**.
- Long-running pattern: `LongRunningJobRegistry` (`ipc/_lib/long-running.ts`), canonical consumer `ipc/index-reembed-rpc.ts`.

---

## Enhancements

### 1. `[security.allowlist]` mute-list (known false positives)

**Config:** new `[security]` section in `config/nimbus-toml.ts` (mirrors the `[audit]`/`[extensions]` bounded parsers).

- `[[security.allowlist]]` array-of-tables, each entry `fingerprint = "<hex>"`.
- A finding's **fingerprint** = `sha256Hex(${service}:${external_id}:${pattern_name}:${match_redacted}:${sha256Hex(context_snippet)})`.
  - `match_redacted` is `first4****last4` (`redactSecret`). For patterns that match a **fixed literal** (`pem_private_key`, `pgp_private_key`, `gcp_service_account_json` → e.g. `"type":"service_account"`), every occurrence in a file redacts identically — so `match_redacted` alone would collide and muting one would mute all. Folding in `sha256Hex(context_snippet)` (the existing `buildContextSnippet`: `before[REDACTED]after`, 40-char radius) disambiguates co-located same-pattern secrets by their **surrounding content**, not their offset/line — so it stays resilient to line-number shifts while keeping distinct secrets distinct. The snippet carries only `[REDACTED]` in place of the secret, so the fingerprint still leaks no secret bytes.
  - **Documented residual:** two identical secrets with byte-identical 40-char surrounding context in the same item still collide. Acceptable — that is effectively the same finding duplicated.
- Surfaced in scan output (pretty + JSON) so a user copies it into config — the gitleaks `.gitleaksignore` UX.
- Muted findings are removed from the returned `findings[]` and reported separately as `muted_count`.

**Type:** `NimbusSecurityToml = { extendedPatterns: boolean; allowlistFingerprints: string[] }`, default `{ extendedPatterns: false, allowlistFingerprints: [] }`. Loaders `parseNimbusSecurityToml` / `loadNimbusSecurityFromConfigDir`.

### 2. `--fail-on-finding` CI exit-code flag

CLI flag on `nimbus security scan`. When set, the command exits **1** if ≥1 **non-muted** finding remains (else 0). Pure CLI concern — the gateway result is unchanged; the CLI inspects `findings.length`. Default (flag absent) keeps today's exit-0 behavior.

**CI guidance (review #5):** `--extended --fail-on-finding` will fail the build on low-confidence false positives. This is intended, but it puts the burden on a well-maintained `[security.allowlist]`. The CLI help for `--extended` carries an explicit warning that combining it with `--fail-on-finding` in CI requires curating the mute-list to avoid flaky pipelines.

### 3. Opt-in extended Gitleaks low-confidence pattern tier

- `secret-patterns.ts` gains `EXTENDED_SECRET_PATTERNS` — generic, lower-confidence patterns (e.g. high-entropy `["']?[A-Za-z0-9+/]{32,}["']?` assigned to a `key|secret|token|password`-named identifier; generic `xox`-less bearer-looking strings). Each carries `category` and a `confidence: "extended"` marker.
- Active only when `[security].extended_patterns = true` **or** the CLI `--extended` flag is passed. Default scan uses only the 20 high-confidence patterns. The effective pattern list = `SECRET_PATTERNS` (always) `+ EXTENDED_SECRET_PATTERNS` (when enabled).

### 4. `--service <name>` scope filter

`iterateScannableItems` gains an optional `service?: string` → `AND i.service = ?`. CLI `--service <name>` passes it through `security.scan` params. Absent = scan all services (today's behavior).

### 5. Long-running progress + cancellation

`security.scan` becomes a long-running job (the `index.reembed` shape): a `securityScanRegistry = new LongRunningJobRegistry(...)` runs the scan under an `AbortSignal`.

- Notifications: `security.scanProgress` (`{ scanned: number; total: number }`), `security.scanDone` (`{ findings, muted_count, scanned, ... }`), `security.scanError` (`{ message }`).
- The iterate loop checks `signal.aborted` between items and emits progress every N items (e.g. 200).
- **Memory (review #4):** `iterateScannableItems` is already a `function*` over `db.query(...).iterate()` (row-by-row streaming, **not** `.all()`), and `scanItemsForSecrets` already takes an `Iterable<ScanItem>` — so there is no all-items memory spike. The `service` filter and progress emission are added **without** breaking that streaming (no buffering into an array). The total for `scanProgress` comes from a separate `SELECT COUNT(*)` (cheap), not from materializing the rows.
- The CLI starts the job, subscribes to progress (renders a counter), and awaits done/error; small indexes finish in one tick. `Ctrl-C` in the CLI cancels via the registry.
- **Tauri:** not exposed to the renderer — `security.scan` is CLI-only; no `ALLOWED_METHODS`/I7 change. (Recorded explicitly so a future UI exposure is a conscious decision.)

### 6. Line-level git-blame attribution (Approach A — bounded `git_blame_line` table)

**V32 migration** (`nimbus-db-migrations`, append-only `simpleStep`):

```sql
CREATE TABLE IF NOT EXISTS git_blame_line (
  repo_root        TEXT NOT NULL,
  file_path        TEXT NOT NULL,   -- repo-relative, forward-slash normalized
  line_no          INTEGER NOT NULL,
  commit_sha       TEXT NOT NULL,
  author_name      TEXT,
  author_email     TEXT,
  author_time_ms   INTEGER,
  PRIMARY KEY (repo_root, file_path, line_no)
) WITHOUT ROWID;
```

**Indexer (`filesystem-v2-sync.ts`):**

- (a) Persist `excerptStartLine` (1-based absolute line of the excerpt's first line) in `code_symbol` metadata. `excerptAroundExportedSymbol` already computes the `from` line index — return + store it.
- (b) For each git-tracked file we index symbols from (only those — bounds the surface), run `git blame --line-porcelain -L <from>,<to> -- <file>` once over the **union of indexed excerpt line-ranges** for that file (one spawn per file), parse the porcelain header (`<sha>`, `author`, `author-mail`, `author-time`), and upsert one `git_blame_line` row per covered line. Reuses the existing `Bun.spawn` git pattern in this module (already spawns `git log`). Per-file guard: skip files whose covered range exceeds `MAX_BLAME_LINES` (default 5000) — surfaced in sync stats. Sticky-delete semantics match the existing sync (stale rows for re-synced files are replaced).
- **Spawn timeout (review #1):** `git blame` on a file with a very deep history can be pathologically slow. The blame spawn is bounded by `BLAME_TIMEOUT_MS` (default **20000**) via an `AbortSignal` (`AbortSignal.timeout`) passed to `Bun.spawn`; on timeout the child is killed and that file gets **no blame rows** (same fallback as any blame error) — the sync never stalls. The `git log` commit-walk spawn already in this module gets the same timeout treatment.
- `git blame` failures (not a repo, detached, transient, **timeout**) are caught per-file → no blame rows for that file, sync continues.

**Scanner (`security/scan.ts` + `security-rpc.ts`):**

- `SecurityFinding` gains `fingerprint: string`, `external_id: string`, and `blame: { commit_sha; author_name; author_email; author_time_ms } | null`.
- For a `code_symbol` finding: compute the secret's line within `body_preview` by counting newlines up to `match_offset`, subtract 1 for the `relPath` header line, add `excerptStartLine` → absolute file line; look up `git_blame_line` for `(repoRoot, file, line)` from the item's metadata. A pure indexed read — **no scan-time git call**.
- Non-`code_symbol` / non-git findings (Slack, Notion, etc.) get `blame: null`. Items lacking `excerptStartLine` (older index, indexed before this change) get `blame: null` gracefully.
- **Backfill for existing users (review #3):** `excerptStartLine` + `git_blame_line` populate on the **next filesystem sync**. A user who wants blame attribution immediately forces it with `nimbus connector sync filesystem` (→ `connector.sync` → `syncScheduler.forceSync("filesystem")`). This is a re-extract from disk, not a re-embed, so `nimbus index reembed` is **not** the path. Documented in the `nimbus security scan` CLI help and the blame section of the scan output footer.

---

## Data flow

```text
nimbus security scan [--service S] [--fail-on-finding] [--extended]
   │  CLI → security.scan { service?, extended? }  (long-running job)
   ▼
LongRunningJobRegistry.run(signal):
   iterateScannableItems(db, { service })        ── progress every 200 items, signal-checked
     → scanItemsForSecrets(items, patterns)       ── patterns = base [+ extended]
       → for each match: build finding
            fingerprint = sha256(service:ext_id:pattern:redacted:sha256(context))
            if fingerprint ∈ allowlist → muted_count++ , skip
            if code_symbol → resolve abs line → git_blame_line lookup → blame
   emit security.scanDone { findings, muted_count, scanned }
   appendAuditEntry("security.scan_completed", { scanned, finding_count, muted_count })
   ▼
CLI renders findings (+ fingerprint + blame); exits 1 iff --fail-on-finding && findings.length>0
```

Indexing side (independent, during git-aware filesystem sync):

```text
filesystem-v2-sync: per git-tracked file →
   index code_symbol (now with excerptStartLine)
   git blame --line-porcelain -L ranges → upsert git_blame_line rows (≤ MAX_BLAME_LINES)
```

---

## Files

**Create**

- `packages/gateway/src/index/git-blame-line-v32-sql.ts` — the V32 DDL constant.
- `packages/gateway/src/security/blame-store.ts` — `upsertBlameLines`, `lookupBlame(db, repoRoot, file, line)`, the porcelain parser `parseBlamePorcelain`.
- `packages/gateway/src/security/finding-fingerprint.ts` — `computeFindingFingerprint`.
- Tests alongside each (`*.test.ts`) + an e2e extension.

**Modify**

- `config/nimbus-toml.ts` — `[security]` section (type, default, parser, loaders).
- `security/secret-patterns.ts` — `EXTENDED_SECRET_PATTERNS` + a `confidence` field.
- `security/scan.ts` — fingerprint + allowlist mute + blame enrichment + extended patterns; `SecurityFinding` shape.
- `ipc/security-rpc.ts` — long-running job, `service` filter, progress/done/error notifications, audit `muted_count`.
- `index/migrations/runner.ts` — register V32 `simpleStep`.
- `connectors/filesystem-v2-sync.ts` — `excerptStartLine` + `git blame` → `git_blame_line` upserts.
- `cli/commands/security.ts` — `--service`, `--fail-on-finding`, `--extended`; progress rendering; fingerprint + blame in output.
- `docs/roadmap.md` checkbox + `docs/CHANGELOG.md` entry (the per-delivery convention; the Phase 5 ✅ flip is PR B).

---

## Testing

- **Config:** `[security]` parser — default, `extended_patterns` true/false, allowlist fingerprint array, ignores out-of-section.
- **Fingerprint:** deterministic; independent of offset; no secret bytes leak (uses redacted match).
- **Allowlist:** a finding whose fingerprint is configured is muted (dropped from `findings`, counted in `muted_count`).
- **Patterns:** extended patterns inactive by default, active under config/flag; base patterns always active.
- **`--service`:** only the named service's items scanned (seed two services, assert scope).
- **Fingerprint disambiguation (review #2):** two `pem_private_key` matches (identical redaction) in the **same** item with **different** surrounding context produce **distinct** fingerprints (muting one keeps the other live); byte-identical context → identical fingerprint (accepted duplicate). Fingerprint contains no secret bytes.
- **Blame:** `parseBlamePorcelain` parses porcelain; offset→absolute-line mapping is correct across the `relPath` header line and a multi-line excerpt; `lookupBlame` returns the right commit; missing `excerptStartLine` → `blame: null`. Fixture: a tiny temp git repo with two authored commits.
- **Blame timeout (review #1):** a fake/slow blame spawn that exceeds `BLAME_TIMEOUT_MS` is aborted and yields no rows for that file; the sync completes (inject a fake spawn that never resolves; assert the child is signalled and the pass still succeeds).
- **Long-running:** progress emitted, `signal.aborted` stops the loop, done payload carries findings; CLI exit-code e2e for `--fail-on-finding` (0 when clean / muted-only, 1 when a live finding remains).
- **e2e:** extend `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts` — the existing planted-credential test now also asserts a `fingerprint` and (for a git-tracked planted secret) a `blame` author.

---

## Invariants & conventions

- **I14:** every write (V32 upserts, blame upserts) routes through `dbRun`/`dbExec`/`dbStmtRun`.
- **Migrations:** append-only; `simpleStep(31, 32, …)`; pre-migration backup + ledger handled by the runner; no edits to past steps.
- **Audit:** `security.scan_completed` continues via `appendAuditEntry` (chained `audit_log`), now carrying `muted_count`. No new HITL action type (the scan is read-only; no executor/I2–I4 change).
- **git spawn:** the blame spawn lives in `connectors/filesystem-v2-sync.ts`, which already spawns `git log`; it follows that module's existing spawn pattern (and `extensionProcessEnv()` usage if/as that module already applies it for git — match the sibling `git log` call exactly).
- **No `any`:** porcelain parsing and IPC params use `unknown` + narrowing.
- **CHANGELOG convention:** log the delivery in `docs/CHANGELOG.md`; do **not** touch the CLAUDE.md/GEMINI.md status line.

---

## Out of scope (YAGNI)

- Whole-file / whole-repo blame (Approach C) — only indexed excerpt ranges are blamed.
- Line-level blame for non-`code_symbol` items — those get `blame: null`.
- Tauri/renderer exposure of the scan.
- Auto-remediation / secret rotation (a separate, later Phase 8 item).

---

## Design-review disposition (2026-06-04)

Responses to `2026-06-04-security-scan-v2-design-review.md`:

1. **git blame timeout** — *Fixed.* Added `BLAME_TIMEOUT_MS` (20 s) via `AbortSignal.timeout` on the blame (and `git log`) spawn; timeout → no blame rows for that file, sync continues. (§ Enhancement 6 indexer; Testing.)
2. **Fingerprint uniqueness** — *Fixed.* Confirmed real (fixed-literal patterns redact identically). Fingerprint now folds in `sha256(context_snippet)` — content-based, offset-independent disambiguation; residual identical-context collision documented as an accepted duplicate. (§ Enhancement 1; Testing.)
3. **excerptStartLine for existing users** — *Fixed (docs).* Verified the resync path exists (`connector.sync` → `forceSync("filesystem")`); documented `nimbus connector sync filesystem` as the backfill trigger and that `index reembed` is **not** it. No new code. (§ Enhancement 6 scanner.)
4. **Streaming iterate** — *Already satisfied.* `iterateScannableItems` is a `function*` over `db.query().iterate()` and `scanItemsForSecrets` takes `Iterable`; the spec now pins that the `service` filter + progress preserve streaming, with the progress total from a separate `COUNT(*)`. (§ Enhancement 5.)
5. **`--extended` + `--fail-on-finding` CI** — *Fixed (docs).* Intended behavior; added a CLI-help warning that the combination needs a curated `[security.allowlist]`. (§ Enhancement 2.)
