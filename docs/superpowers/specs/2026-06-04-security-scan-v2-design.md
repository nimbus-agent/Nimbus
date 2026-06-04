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
- A finding's **fingerprint** = `sha256Hex(`​`${service}:${external_id}:${pattern_name}:${match_redacted}`​`)`. Stable across re-scans (does not depend on offset, which can shift), and reveals no secret bytes (uses the already-redacted match). Surfaced in scan output (pretty + JSON) so a user copies it into config — the gitleaks `.gitleaksignore` UX.
- Muted findings are removed from the returned `findings[]` and reported separately as `muted_count`.

**Type:** `NimbusSecurityToml = { extendedPatterns: boolean; allowlistFingerprints: string[] }`, default `{ extendedPatterns: false, allowlistFingerprints: [] }`. Loaders `parseNimbusSecurityToml` / `loadNimbusSecurityFromConfigDir`.

### 2. `--fail-on-finding` CI exit-code flag

CLI flag on `nimbus security scan`. When set, the command exits **1** if ≥1 **non-muted** finding remains (else 0). Pure CLI concern — the gateway result is unchanged; the CLI inspects `findings.length`. Default (flag absent) keeps today's exit-0 behavior.

### 3. Opt-in extended Gitleaks low-confidence pattern tier

- `secret-patterns.ts` gains `EXTENDED_SECRET_PATTERNS` — generic, lower-confidence patterns (e.g. high-entropy `["']?[A-Za-z0-9+/]{32,}["']?` assigned to a `key|secret|token|password`-named identifier; generic `xox`-less bearer-looking strings). Each carries `category` and a `confidence: "extended"` marker.
- Active only when `[security].extended_patterns = true` **or** the CLI `--extended` flag is passed. Default scan uses only the 20 high-confidence patterns. The effective pattern list = `SECRET_PATTERNS` (always) `+ EXTENDED_SECRET_PATTERNS` (when enabled).

### 4. `--service <name>` scope filter

`iterateScannableItems` gains an optional `service?: string` → `AND i.service = ?`. CLI `--service <name>` passes it through `security.scan` params. Absent = scan all services (today's behavior).

### 5. Long-running progress + cancellation

`security.scan` becomes a long-running job (the `index.reembed` shape): a `securityScanRegistry = new LongRunningJobRegistry(...)` runs the scan under an `AbortSignal`.

- Notifications: `security.scanProgress` (`{ scanned: number; total: number }`), `security.scanDone` (`{ findings, muted_count, scanned, ... }`), `security.scanError` (`{ message }`).
- The iterate loop checks `signal.aborted` between items and emits progress every N items (e.g. 200).
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
- `git blame` failures (not a repo, detached, transient) are caught per-file → no blame rows for that file, sync continues.

**Scanner (`security/scan.ts` + `security-rpc.ts`):**

- `SecurityFinding` gains `fingerprint: string`, `external_id: string`, and `blame: { commit_sha; author_name; author_email; author_time_ms } | null`.
- For a `code_symbol` finding: compute the secret's line within `body_preview` by counting newlines up to `match_offset`, subtract 1 for the `relPath` header line, add `excerptStartLine` → absolute file line; look up `git_blame_line` for `(repoRoot, file, line)` from the item's metadata. A pure indexed read — **no scan-time git call**.
- Non-`code_symbol` / non-git findings (Slack, Notion, etc.) get `blame: null`. Items lacking `excerptStartLine` (older index, pre-reembed) get `blame: null` gracefully.

---

## Data flow

```
nimbus security scan [--service S] [--fail-on-finding] [--extended]
   │  CLI → security.scan { service?, extended? }  (long-running job)
   ▼
LongRunningJobRegistry.run(signal):
   iterateScannableItems(db, { service })        ── progress every 200 items, signal-checked
     → scanItemsForSecrets(items, patterns)       ── patterns = base [+ extended]
       → for each match: build finding
            fingerprint = sha256(service:ext_id:pattern:redacted)
            if fingerprint ∈ allowlist → muted_count++ , skip
            if code_symbol → resolve abs line → git_blame_line lookup → blame
   emit security.scanDone { findings, muted_count, scanned }
   appendAuditEntry("security.scan_completed", { scanned, finding_count, muted_count })
   ▼
CLI renders findings (+ fingerprint + blame); exits 1 iff --fail-on-finding && findings.length>0
```

Indexing side (independent, during git-aware filesystem sync):

```
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
- **Blame:** `parseBlamePorcelain` parses porcelain; offset→absolute-line mapping is correct across the `relPath` header line and a multi-line excerpt; `lookupBlame` returns the right commit; missing `excerptStartLine` → `blame: null`. Fixture: a tiny temp git repo with two authored commits.
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
