# Phase 5 T2 PR 3 — Auto-update with per-bump HITL — Design

> **Status:** Draft (rev 1, post-brainstorm)
> **Author:** asafgolombek
> **Date:** 2026-05-19
> **Type:** Per-PR design (locks the implementation surface for `phase-5-t2-pr3-auto-update`)
> **Parent:** [T2 sequencing spec](./2026-05-16-phase-5-t2-design.md) §2 PR 3
> **Predecessors:**
> - [T2 PR 1 sandbox design](./2026-05-16-phase-5-t2-pr1-sandbox-design.md) — merged 2026-05-17 (PR #329)
> - [T2 PR 2 verified-publisher design](./2026-05-17-phase-5-t2-pr2-verified-publisher-design.md) — merged 2026-05-18 (PR #343)

## Purpose

The Gateway polls the extension registry on a configurable cadence and writes every detected version bump into an in-memory cache. The cache is queryable via a new read-only IPC method and exposed through a new CLI verb. When the user explicitly opts in, applying a bump fires a per-version HITL consent gate; on approval, the new tarball is downloaded, signature-verified (re-using PR 2's `verifyManifestSignature`), SHA-256 verified, and atomically swapped on disk via a two-version directory layout that makes `nimbus extension downgrade <id>` a thin shim on top of the same machinery. No "auto-approve forever" toggle exists by design.

This PR introduces **no new structural security invariant**. It composes on top of I2 / I3 / I4 (HITL frozen set + gate semantics), I5 (LAN allowlist), I7 (Tauri renderer allowlist), I14 (typed `dbRun`), and I16 (PR 2's signature verification). The parent T2 sequencing spec floated I-numbering for the auto-update path; the brainstorming round on 2026-05-19 concluded that no new structural defense is added — every security property is provided by the existing invariants applied to two new HITL action types and two new IPC methods.

## Section 1 — Architecture overview

### 1.1 No new invariant

The two new HITL action types `extension.autoUpdate` and `extension.downgrade` are added to `HITL_REQUIRED_BACKING` in `engine/executor.ts`. The existing I2 enforcement test (`every member of HITL_REQUIRED_BACKING triggers the consent channel`) and I3/I4 semantics (gate consults `action.type` only; `hitlStatus` set only by the gate) automatically cover them.

The Tauri allowlist (I7) gains two methods and bumps the `allowlist_exact_size` assertion **60 → 62**. The LAN allowlist (I5) gains two `FORBIDDEN_OVER_LAN` entries. The HTTP write surface (I13) is **not** touched — auto-update is CLI/UI/IPC-only.

### 1.2 Component map

| New file | Role |
|---|---|
| `packages/gateway/src/extensions/auto-update-types.ts` | Shared types: `AvailableUpdate`, `AutoUpdateCache`, `UpdateChannel`, `VerificationStatus`, action-type literals. |
| `packages/gateway/src/extensions/auto-update.ts` | `ExtensionAutoUpdater` daemon class — owns the poll loop, the in-memory cache, the per-extension mutex map, the `AbortController` for shutdown. |
| `packages/gateway/src/extensions/auto-update-cache.ts` | Pure cache module — `AutoUpdateCache` keyed by extension id; insert / lookup / dedupe-by-(id, toVersion) / GC stale entries. No I/O. |
| `packages/gateway/src/extensions/auto-update-apply.ts` | Pure apply pipeline — `downloadTarball`, `verifyTarballSha256`, `atomicSwap`, `restorePrev`. Filesystem I/O via injected `fs` for tests. |
| `packages/gateway/src/extensions/auto-update-permissions-diff.ts` | Pure `diffPermissions(oldManifest, newManifest)` → `{ added, removed }` with sorted, deduplicated arrays. Used at cache-write time and rendered in the HITL payload. |
| `packages/gateway/src/extensions/auto-update-rpc.ts` | IPC dispatcher — `extension.checkForUpdates`, `extension.update`. Direction inference (upgrade vs downgrade) lives here; HITL action-type selection lives here. |
| `packages/cli/src/commands/extension-auto-update.ts` | CLI command implementations for `nimbus extension update`, `nimbus extension downgrade`, `nimbus extension info`. |

| Modified file | Change |
|---|---|
| `packages/gateway/src/engine/executor.ts` | Add `"extension.autoUpdate"` and `"extension.downgrade"` to `HITL_REQUIRED_BACKING` (alphabetically, near the other `extension.*` entry). |
| `packages/gateway/src/ipc/lan-rpc.ts` | Add `"extension.checkForUpdates"` and `"extension.update"` to `FORBIDDEN_OVER_LAN`. |
| `packages/gateway/src/ipc/dispatcher.ts` (or per-namespace handler aggregator) | Wire the two new methods to `dispatchAutoUpdateRpc`. |
| `packages/gateway/src/connectors/lazy-mesh/registry.ts` (or wherever the cached `ServerSpec` map lives) | Add `invalidateExtension(id)` so the apply pipeline can drop the cached spec after a swap. |
| `packages/gateway/src/extensions/manifest-schema.ts` | Add `updateChannel?: "stable" \| "beta"` (default `"stable"`) and `changelog?: string` (≤ 4 KiB after `.normalize("NFC")`) — validator rejects out-of-range. |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Insert `"extension.checkForUpdates"` and `"extension.update"` alphabetically in `ALLOWED_METHODS`; bump `allowlist_exact_size` 60 → 62. |
| `packages/ui/src/pages/Marketplace.tsx` (or the equivalent installed-extensions panel) | Pending-updates section that calls `extension.checkForUpdates`, shows the cache entries, and dispatches `extension.update` on click. |
| `packages/ui/src/components/hitl/StructuredPreview.tsx` | Special-case rendering for `extension.autoUpdate` / `extension.downgrade` payloads — version pair, changelog (in `<pre>`), publisher status badge, permission-diff table. |
| `packages/gateway/src/security-invariants.test.ts` | Extend the existing I5 and I7 assertion sets to cover the two new methods. |
| `packages/gateway/src/config/nimbus-toml.ts` | New `[extensions].update_check_interval_hours` config field (default 24, range 1–168). |

### 1.3 Storage layout on disk

Each extension's install directory becomes a two-slot layout:

```
<extensions-root>/<id>/
├── active/                # the live version (extension.install_path points here)
│   ├── nimbus.extension.json
│   └── ...
└── _prev/
    └── <previous-version>/
        ├── nimbus.extension.json
        └── ...
```

Single rolling backup: after every successful update, the prior `active/` is moved to `_prev/<prior-version>/`. Any pre-existing `_prev/<older-version>/` is moved aside to a holding location first and GC'd only after the new `active/` is in place, so a crash mid-swap never leaves an extension without **either** a working `active/` or a recoverable `_prev/*`. The exact rename / holding-dir mechanics are locked in the implementation plan, not this spec. `nimbus extension downgrade <id>` swaps the two directories. `nimbus extension uninstall <id>` (existing flow) removes the whole `<id>/` subtree including `_prev/`.

**Startup crash recovery.** If the Gateway crashes mid-swap and starts up with the extension in the DB but no `active/` directory, the existing `verify-extensions.ts` startup pass detects the inconsistency and recovers by promoting the most-recent `_prev/<version>/` directory to `active/`, audited as `extension.autoUpdate.crash_recovered`. If neither `active/` nor `_prev/*` exists, the extension is hard-disabled with reason `auto_update_install_path_missing` and the user re-installs.

The tarball cache is separate:

```
<dataDir>/extensions/_pending/
└── <id>-<toVersion>.tar.gz
```

Pending tarballs are GC'd on apply success, apply failure, or Gateway startup orphan-reap (any `_pending/*.tar.gz` whose `<id>-<version>` does not match a cached `AvailableUpdate` entry is deleted on the first poll cycle).

## Section 2 — Data flow

### 2.1 Polling pass (daemon-driven)

1. `ExtensionAutoUpdater.start()` is called by the Gateway init sequence. If `enforce_air_gap = true`, the daemon does not start; `nimbus diag --json` reports `extensions.auto_update.air_gap_blocked = true`.
2. On start, schedule the first poll after a jittered delay sampled uniformly from **[30 s, 300 s]** (`Math.random()` is acceptable here — this is a fairness/load-spreading mechanism, not a security primitive). Subsequent polls run every `update_check_interval_hours` (default 24, range 1–168).
3. Each poll iterates installed extensions where `enabled = 1` AND the extension has a `publisher` field (unsigned extensions are not auto-updateable in v1 — they can be reinstalled manually).
4. For each extension:
   - `registryClient.fetchLatestVersion(id, channel)` — channel comes from the manifest's `updateChannel` (default `stable`). The fetch reuses the bounded retry / `AbortController` / timeout posture from PR 2.
   - If the registry's `latest` semver matches the installed version, skip and emit nothing.
   - Else fetch the new manifest (single GET per detected bump — no batched index endpoint in v1).
   - **Publisher key check:** look up `extension.publisher_key.<publisher_id>` in vault. If missing or fingerprint mismatch, the cache entry records `verification_status = "needs_sync"` and the apply path will refuse. CLI / UI surface this with a hint to run `nimbus extension sync`. **No auto-sync** — defense-in-depth posture forces explicit user action when a publisher key rotates.
   - **Signature check:** if the key is present, call `verifyManifestSignature` (PR 2 helper). On success, `verification_status = "verified"`. On failure, `verification_status = "signature_failed"` and the cache entry is non-actionable (apply path refuses).
   - **Permission diff:** `diffPermissions(oldManifest, newManifest)` → `{ added: {...}, removed: {...} }` with sorted/deduplicated host and path arrays.
   - **Cache insert:** key `(id, toVersion)`; dedupe so re-polls of the same bump don't multi-audit.
5. **Detection audit:** first detection of a (id, toVersion) pair writes one `extension.autoUpdate.detected` audit row with the cached payload (signature included — it's public bytes, not a secret).
6. Registry fetch failures: structured log at `info` level; `nimbus diag --json` reports `extensions.auto_update.last_poll_outcome` per extension. No user-visible notification (per the brainstorm decision — detection UX is pull-only).

### 2.2 Apply pass (user-driven, gated)

The user invokes `nimbus extension update <id>` (CLI) or selects the bump in the Tauri Marketplace. Both paths call IPC `extension.update { id, toVersion }`.

```
extension.update { id, toVersion }
    │
    ├─ Validate cache entry exists
    │     └─ no entry         → return { applied: false, reason: "cache_miss" }
    │
    ├─ Validate verification_status === "verified"
    │     ├─ "needs_sync"      → return { applied: false, reason: "publisher_key_missing", hint: "run nimbus extension sync" }
    │     └─ "signature_failed"→ return { applied: false, reason: "signature_failed" }
    │
    ├─ Validate toVersion !== installedVersion
    │     └─ same             → return { applied: false, reason: "same_version" }
    │
    ├─ Compute direction
    │     ├─ toVersion > installedVersion  → actionType = "extension.autoUpdate"
    │     └─ toVersion < installedVersion  → actionType = "extension.downgrade"
    │           and require _prev/<toVersion>/ exists  → else "downgrade_unavailable"
    │
    ├─ Build PlannedAction
    │     payload = { id, displayName, fromVersion, toVersion, channel,
    │                 changelog, publisherStatus, addedPermissions, removedPermissions,
    │                 manifestHash, signatureB64 }
    │
    ├─ ToolExecutor.gate(action)   ← I2/I3/I4
    │     └─ rejected         → return { applied: false, reason: "user_rejected" }
    │                            (gate already wrote the audit row)
    │
    ├─ Acquire per-extension mutex (in-memory)
    │     └─ already held     → return { applied: false, reason: "update_in_flight" }
    │
    ├─ UPGRADE branch:
    │     ├─ Download tarball → _pending/<id>-<toVersion>.tar.gz
    │     │     └─ AbortController + MAX_DOWNLOAD_BYTES (reuse from updater.ts)
    │     ├─ Extract to _pending/<id>-<toVersion>/
    │     ├─ Verify SHA-256 against manifest.entry_hash
    │     │     └─ mismatch  → audit "failed { phase: sha256_mismatch }", GC, release mutex
    │     ├─ Re-verify Ed25519 signature against extracted manifest (defense in depth)
    │     │     └─ failure   → audit "failed { phase: signature_failed }", GC, release mutex
    │     ├─ Atomic swap (revert-on-failure; safe across mid-swap crash, per §1.3):
    │     │     - Move active/ → _prev/<fromVersion>/, retiring any pre-existing
    │     │       _prev/<older>/ to a holding location until success.
    │     │     - Move _pending/<id>-<toVersion>/ → active/.
    │     │     - On any rename failure: revert to the original active/ + _prev/
    │     │       layout, audit "failed { phase: swap_failed }", release mutex.
    │     ├─ dbRun: UPDATE extension SET version, manifest_hash, entry_hash, last_verified_at
    │     ├─ Audit "extension.autoUpdate.applied"
    │     ├─ lazyMeshRegistry.invalidateExtension(id)
    │     └─ Release mutex; GC the tarball
    │
    └─ DOWNGRADE branch:
          ├─ Atomic swap (revert-on-failure; safe across mid-swap crash, per §1.3):
          │     - Read manifest of _prev/<toVersion>/ to obtain manifest_hash + entry_hash.
          │     - Swap active/ with _prev/<toVersion>/ such that active/ ends as vOld
          │       and _prev/<fromVersion>/ ends as vNew. Exact rename order locked in
          │       the implementation plan.
          │     - On any rename failure: best-effort revert + audit "failed { phase: swap_failed }".
          ├─ dbRun: UPDATE extension SET version, manifest_hash, entry_hash, last_verified_at
          ├─ Audit "extension.downgrade.applied"
          ├─ lazyMeshRegistry.invalidateExtension(id)
          └─ Release mutex
```

### 2.3 Concurrent calls

- Two `extension.update {id: X}` calls in flight → second returns `update_in_flight` synchronously (mutex is a `Map<id, Promise<void>>`; `await` is on a sentinel, not the work).
- Two `extension.update` calls for **different** ids → run concurrently. Mutex is per-id, not global.
- `extension.checkForUpdates` is read-only against the cache; no mutex; safe to call from multiple windows.

### 2.4 Shutdown

`ExtensionAutoUpdater.stop()` aborts the daemon's `AbortController`. Any in-flight `fetch` (registry poll or tarball download) rejects with `AbortError`; the rejecting promise is logged and discarded. The mutex map is dropped. Pending swaps are not interrupted — `fs.rename` is a single syscall and runs to completion before stop returns.

## Section 3 — Security, invariants, manifest schema

### 3.1 Manifest schema additions

Both fields live in the SDK schema and are signature-covered by the existing canonical-JSON serializer used by `verifyManifestSignature`:

- **`updateChannel?: "stable" | "beta"`** — default `"stable"`. Validator rejects any other literal.
- **`changelog?: string`** — plain text, ≤ 4 KiB **after** `.normalize("NFC")`. No HTML / Markdown rendering on display: the CLI prints verbatim; the Tauri consent UI wraps in `<pre>` (no `dangerouslySetInnerHTML`).

No SDK API change is required for connector authors — they re-sign on the next release; the existing `nimbus extension sign` tooling automatically includes the new fields under the signature.

### 3.2 Invariant interactions

| # | Touched | Change |
|---|---|---|
| I2 | yes | Two new entries in `HITL_REQUIRED_BACKING`: `extension.autoUpdate`, `extension.downgrade`. Existing "every member triggers consent channel" enforcement test stays the assertion; its parameterized type list extends. |
| I3 | yes | HITL gate continues to consult `action.type` only. IPC handler computes direction from semver and passes the typed literal — never from a payload field. |
| I4 | yes | `hitlStatus` set only by the consent gate. The new RPC handler returns whatever the gate produced; never hardcodes `"approved"`. |
| I5 | yes | `extension.checkForUpdates` and `extension.update` added to `FORBIDDEN_OVER_LAN` in `ipc/lan-rpc.ts`. Existing `FORBIDDEN_OVER_LAN includes the exfiltration namespaces` test extends. |
| I7 | yes | `ALLOWED_METHODS` size **60 → 62** via alphabetical insertions. `allowlist_exact_size`, `allowlist_is_alphabetized`, `allowlist_has_no_duplicates`, `allowlist_rejects_vault_and_raw_db_writes` all stay green. `extension.install` stays **absent** (chain C1 / B1 audit). |
| I8 | indirect | Changelog and permission-diff render inside renderer CSP-safe components (`<pre>`, static table). No `dangerouslySetInnerHTML`. |
| I9 | yes | Every read against the `extension` table goes through bound parameters; no identifier interpolation needed (fixed column names). |
| I10 | indirect | `verifyManifestSignature` re-uses the SDK helper which already consumes `sha256HexEqualConstantTime` from `util/timing-safe-compare.ts`. No new constant-time call sites. |
| I11 | no | No LLM-facing surface. IPC handler returns structured `AvailableUpdate[]` to the CLI / UI, not to an agent. |
| I13 | no | No new HTTP write route. `WRITE_ROUTE_ALLOWLIST` size assertion stays at **1**. |
| I14 | yes | Every `UPDATE extension SET …` (and any future cache-related write) goes through `dbRun` / `dbExec` / `dbStmtRun`. Static `D12` audit catches violations. |
| I15 | indirect | After swap, the lazy-mesh registry invalidates its `ServerSpec` cache for this extension. Next spawn re-reads the manifest and re-routes through `wrapServerSpec(...)`. No new I15 wiring site — the existing one continues to be the single execution boundary. |
| I16 | yes | Reuses `verifyManifestSignature` at both cache-time (poll) AND apply-time (post-download). The new manifest fields (`updateChannel`, `changelog`) are signature-covered automatically. The I16 enforcement test stays green without modification; the I16 spec entry gains `auto-update.ts` as a third optional caller, but the invariant statement does not change. |

**No new invariant.** Every security property is provided by the existing invariants applied to two new HITL action types and two new IPC methods.

### 3.3 Vault keys

None new. Auto-update reads `extension.publisher_key.<id>` (PR 2 namespace) but never writes. `D11` vault-key allow-list unchanged.

### 3.4 Audit-row content

Consent payloads include: extension id, display name, version pair, channel, plain-text changelog, publisher status, permission diff (added + removed), manifest hash, Ed25519 signature (base64). None of those fields match `(token|key|secret|password|credential|bearer|auth)/i`, so `redactPayloadForConsentDisplay` passes them through unchanged. Audit display goes through `redactAuditPayload` per the existing pattern.

The Ed25519 signature is **not** a secret — it's a public byte string already on disk in the manifest. Including it in the audit payload provides forensic binding (the audit row proves exactly which manifest the user approved).

### 3.5 HITL consent prompts

Both action types route through the existing `formatConsentPrompt(action)` path. No new helper:

- `extension.autoUpdate` → "Action requires your approval\n\nType: extension.autoUpdate\n\nDetails: { … }"
- `extension.downgrade` → "Action requires your approval\n\nType: extension.downgrade\n\nDetails: { … }"

The Tauri renderer's `StructuredPreview.tsx` special-cases these two types to render a human-readable version pair, plain-text changelog inside `<pre>`, publisher-status badge, and a permission-diff table. The CLI displays the same fields in a sectioned plain-text format.

## Section 4 — Out of scope

- **First-spawn-failure auto-revert.** Parent T2 spec says lock only on usage-data evidence; we have none. Manual `nimbus extension downgrade <id>` covers the recovery surface.
- **Background pre-download before approval.** Explicitly locked by parent T2 spec — download happens *after* HITL approval.
- **"Auto-approve all updates from this publisher" toggle.** Explicitly forbidden by the parent T2 security model — per-bump HITL is non-negotiable.
- **Update target other than registry "latest" on the chosen channel.** Pinning to a specific intermediate version is an `extension install <id>@<version>` flow, not auto-update. `--to <version>` is reserved for downgrade only.
- **Channel-switch flow.** Moving from `stable` → `beta` requires `nimbus extension config <id> --channel beta` (locked in parent spec). PR 3 reads `updateChannel` but does not mutate it. Channel mutation lands as a T2 wrap-up if user demand emerges.
- **Persistent polling state (DB column / table).** In-memory only. Cache lost on restart; jittered startup poll rebuilds it in 30–300 s. Trade-off documented; no V32 migration.
- **`nimbus extension cache <id>` air-gap update flow.** Air-gap mode disables the daemon. PR 4's offline-dep concern is dep-resolution-specific; not in this PR.
- **Auto-`nimbus extension sync` on publisher-key rotation.** Defense-in-depth posture: rotated keys require explicit user sync. Cache surfaces `verification_status = "needs_sync"`.
- **Rate-limiting registry calls beyond the 24 h poll cadence.** PR 2's retry / backoff is sufficient.
- **Auto-update for unsigned (pre-T2 / no-`publisher`) extensions.** They keep working but are not polled. Reinstall manually to opt in to signed updates.
- **Apply-time interruption of in-flight tool calls.** New code is picked up on the *next* spawn (lazy-mesh re-reads the manifest); a currently-spawned long-running MCP keeps running on the old code until it exits naturally. No kill-running-spawn behavior.

## Section 5 — Exit criteria

All must hold before PR merges:

1. `nimbus extension update --check` on a fresh install with one extension whose registry exposes a newer version surfaces the bump within the first poll (or immediately with `--check`).
2. `nimbus extension update <id>` fires HITL with the locked payload shape (id / displayName / fromVersion / toVersion / channel / changelog / publisherStatus / addedPermissions / removedPermissions / manifestHash / signatureB64). User-approved path applies the update; user-rejected path leaves disk untouched.
3. Permission-diff is non-empty when the new version widens `permissions.network` or `permissions.filesystem`; payload renders the diff in both CLI (plain text) and Tauri (table).
4. `nimbus extension downgrade <id>` restores the `_prev/<prev-version>/` directory atomically; fires HITL with `extension.downgrade` action type; rejected path leaves disk untouched.
5. Concurrent `extension.update {id: X}` invocations: the second returns `update_in_flight` without touching disk.
6. Air-gap mode (`enforce_air_gap = true`) disables the daemon entirely; `nimbus diag --json` reports `extensions.auto_update.air_gap_blocked = true`.
7. Two new HITL types in `HITL_REQUIRED_BACKING`; existing "every member triggers consent" assertion stays green with no test edits beyond expanding the parameterized type list.
8. Tauri `ALLOWED_METHODS` size assertion bumped **60 → 62**; both methods alphabetically inserted; `allowlist_rejects_vault_and_raw_db_writes` continues to assert `extension.install` is absent. Both methods present in `FORBIDDEN_OVER_LAN`; existing test extends to assert this.
9. `bun run test:coverage:extensions` ≥ 85% — new code lands in the four `auto-update-*.ts` files plus `manifest-schema.ts` additions.
10. `bun run test:coverage:engine` ≥ 85% — new HITL types covered by the existing parameterized test.
11. UI Vitest coverage ≥ 80% / ≥ 75% — Marketplace pending-updates view + the new consent-dialog rendering for `extension.autoUpdate` / `extension.downgrade`.
12. `bun run test:ci` green on the Ubuntu PR gate; full 3-OS push matrix green after merge.
13. `bun run audit:invariants` (static) green — `D10`, `D11`, `D12` unchanged.
14. `docs/SECURITY-INVARIANTS.md` I2 row updated to name the new action types; `docs/architecture.md` extension subsection updated; `docs/cli-reference.md` documents the three new CLI verbs (`extension update`, `extension downgrade`, `extension info` if not already documented); `.claude/commands/nimbus-commands.md` adds the env-var override for `update_check_interval_hours`.
15. `CLAUDE.md` line 10 and `GEMINI.md` mirror gain `T2 PR 3 auto-update ✅ (<date>, PR #<n>)`; roadmap T2 PR 3 row + Extension Marketplace v2 auto-update row both flip to `[x]` with the merge date.

## Section 6 — Test layer assignments

| Layer | File(s) | What it asserts |
|---|---|---|
| Unit | `auto-update.test.ts` | Poll cadence, jitter range (30–300 s), `enforce_air_gap` disables daemon, `AbortController` cancels in-flight fetches, mutex denies concurrent same-id updates while allowing different-id concurrency. |
| Unit | `auto-update-cache.test.ts` | Cache insert / lookup / dedupe-by-(id, toVersion); GC of stale entries on next poll; `verification_status` transitions. |
| Unit | `auto-update-apply.test.ts` | Atomic-swap order, rollback-on-step-2-failure path, audit-row emission per phase, mocked filesystem. |
| Unit | `auto-update-permissions-diff.test.ts` | `diffPermissions` correctness — empty / disjoint / overlapping / removed-not-shown-as-added / sorted-deduplicated outputs. |
| Unit | `auto-update-rpc.test.ts` | Direction inference (upgrade vs downgrade), rejection paths (`cache_miss`, `same_version`, `publisher_key_missing`, `signature_failed`, `downgrade_unavailable`, `update_in_flight`, `user_rejected`). |
| Unit | `engine/executor.test.ts` (extend) | Both new types in `HITL_REQUIRED_BACKING`; parameterized "every member triggers consent" assertion includes them. |
| Unit | `ui/src-tauri` Rust | `allowlist_exact_size` bumped to 62; alphabetization and dedup pass; LAN forbidden-set extension test. |
| Integration | `extensions/auto-update.integration.test.ts` | End-to-end poll → HITL → apply → downgrade against real SQLite, real temp `<extensions-root>`, a fake registry HTTP server, a real test publisher key generated at test setup. |
| E2E CLI | `gateway/test/e2e/scenarios/extension-auto-update.e2e.test.ts` | Real Gateway subprocess; `nimbus extension update --check`; `nimbus extension update <id>`; `nimbus extension downgrade <id>`; assert zero leaked secrets in stdout / audit JSON. |
| UI Vitest | `Marketplace.test.tsx`, `HitlPopupPage.test.tsx`, `StructuredPreview.test.tsx` | Pending-updates list rendering; consent-dialog permission-diff and changelog rendering; rejected `<script>` tags in changelog do not execute. |

## Section 7 — Cadence and roadmap interactions

Per the parent T2 sequencing spec Section 4:

1. Worktree at `.worktrees/dev+asafgolombek+phase-5-t2-pr3-auto-update/` ✅ (set up before this spec).
2. Brainstorming sub-skill — done; two decisions locked (permission deltas, detection UX) and one scope decision (min-viable + downgrade CLI).
3. This design spec → `docs/superpowers/specs/2026-05-19-phase-5-t2-pr3-auto-update-design.md`.
4. Implementation plan → `docs/superpowers/plans/2026-05-19-phase-5-t2-pr3-auto-update.md` (next step).
5. Subagent-driven execution per the plan.
6. PR opened against `main`. Reviewed via `gh pr` or `/ultrareview` where useful. Merged after green CI (Ubuntu PR gate + 3-OS push matrix).
7. On merge: T2 PR 3 sub-checkbox → `[x]` with dated note + PR #; `Last updated:` line in `CLAUDE.md` / `GEMINI.md` extended with `T2 PR 3 auto-update ✅ (<date>)`; Extension Marketplace v2 auto-update bullet flipped to `[x]`.

The top-level T2 row stays unchecked until PR 5 (community ratings) merges, per the parent spec.

## See also

- [`./2026-05-16-phase-5-t2-design.md`](./2026-05-16-phase-5-t2-design.md) — parent T2 sequencing spec
- [`./2026-05-17-phase-5-t2-pr2-verified-publisher-design.md`](./2026-05-17-phase-5-t2-pr2-verified-publisher-design.md) — PR 2 design; `verifyManifestSignature`, vault key namespace, registry client
- [`../../SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md) — I2 / I5 / I7 / I14 / I16 (no new invariant in this PR)
- [`../../../.claude/commands/nimbus-security-invariants.md`](../../../.claude/commands/nimbus-security-invariants.md) — invariant triple rule
- [`../../../.claude/commands/nimbus-tauri-allowlist.md`](../../../.claude/commands/nimbus-tauri-allowlist.md) — Tauri allowlist procedure
- [`../../../.claude/commands/nimbus-ipc.md`](../../../.claude/commands/nimbus-ipc.md) — IPC method conventions
