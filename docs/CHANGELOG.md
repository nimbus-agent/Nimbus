# Nimbus Changelog

Reverse-chronological log of dated deliveries. This file is the **single source** for the running delivery log — `CLAUDE.md`, `GEMINI.md`, and `docs/architecture.md` carry only a one-line status pointer to here, and [`docs/roadmap.md`](./roadmap.md) carries the forward-looking acceptance criteria and per-phase Shipped summaries.

Phase-level history before `v0.1.0` (Phases 1–4) lives in [`docs/roadmap.md` § Shipped](./roadmap.md#shipped); this file tracks the Phase 5 (Extended Surface) delivery cadence and later releases.

---

## Phase 5 — The Extended Surface (🔵 Active)

Core sequencing: T1 → T3 → Wave A → T4 → T6 → T2 → Wave B. Status: T3 ✅ · Wave A ✅ · T4 ✅ · T6 ✅ · T2 ✅ · Wave B (partial) · Tier-2 (partial).

### 2026-05-25

- **Tier-1 connector — ArgoCD** ✅ — GitOps application sync/health (`argocd:application`); self-hosted Bearer auth, single GET /api/v1/applications walk; sandbox host extended from `argocd.url` (Grafana pattern). Applications-only (AppProjects + sync history deferred).
- **Tier-1 connector — Flux** ✅ — GitOps Toolkit CRs (kustomizations, helm releases, sources, image automations) read from the Kubernetes API (`flux:resource`); self-hosted SA-bearer auth, status.conditions Ready health. Writes (reconcile/suspend) deferred to Phase 6.

### 2026-05-24

- **Tier-2 connector — Wiz** ✅ — CSPM findings (Phase 8 security surface, delivered early).
- **Tier-1 connector — LaunchDarkly** ✅ — feature flags / experiments (Phase 7 Wave 3, delivered early).
- **Tier-1 connector — Flagsmith** ✅ — feature-flag definitions (`flagsmith:feature_flag`); `Authorization: Token` auth, walks `/api/v1/projects/ → /api/v1/projects/{id}/features/` (DRF-paged) + per-project tag resolution. Definitions-only (per-environment state + segments deferred).

### 2026-05-22

- **Tier-2 connector — Semgrep** ✅ — AppSec Platform SAST findings (`semgrep:finding`).
- **Tier-2 connector — SonarQube / SonarCloud** ✅ — code-quality issues (`sonarqube:code_issue`).
- **Pre-commit hook docs** ✅ — `docs/cli/pre-commit.md` + `docs/templates/nimbus-pre-commit.sh`.
- **Published OpenAPI spec** ✅ — `GET /v1/openapi.json` + `audit:openapi-drift` CI gate.
- **Coverage floor Phase 5** ✅.

### 2026-05-21

- **T2 PR 4 — dependency resolution** ✅ — manifest `dependsOn` + backtracking DFS solver, V31 `extension_dependency` table + reverse-dep index, reverse-dep guard on `nimbus extension remove` (`--force` override), `MissingDependencyRegistry`, local-first `RegistryFetcher`, `extension.info --deps` + `extension.list --tree`. Composes on I9 / I14 / I16.
- **T2 / Wave-A connector — Snyk** ✅ — `snyk:vulnerability` items.
- **Wave-B connector — Bitrise** ✅ — `bitrise:app` + `bitrise:build` items.
- **`nimbus security scan`** ✅ — local credential-hygiene scan over indexed content; CLI-only, `FORBIDDEN_OVER_LAN`, not in Tauri allowlist.
- **Coverage floor Phase 4** ✅.
- **T4 wrap-up — `nimbus query` in CI worked examples** ✅ — `docs/cli/use-in-ci.md`.

### 2026-05-20

- **T2 PR 3 — extension auto-update** ✅ (PR #367) — in-process polling daemon (`ExtensionAutoUpdater`, default 24h), `extension.autoUpdate` / `extension.downgrade` HITL actions, `extension.checkForUpdates` / `extension.update` IPC, `nimbus extension update` / `downgrade` CLI. Composes on I2/I3/I4/I5/I7/I14/I16; bumped Tauri `ALLOWED_METHODS` 60 → 62.
- **Coverage floor Phase 3A + 3B-rest** ✅.

### 2026-05-18

- **T2 PR 2 — verified publisher (I16)** ✅ (PR #343) — Ed25519-signed manifest verification at install and startup, `SignatureDisabledRegistry`, `nimbus extension keygen` / `sign` / `sync` CLI, verified-publisher badges. Composes on I5/I7/I16.
- **Coverage floor Phase 2A** ✅.

### 2026-05-17

- **T2 PR 1 — sandbox (I15)** ✅ — sandbox PAL + 3-OS isolation + `permissions.{network,filesystem}` schema + I15 + static rule `D10` + `@nimbus-dev/sdk` contract tests + pre-T2 extension reinstall flow.
- **Coverage floor Phase 1A** ✅.

### 2026-05-16

- **T6 complete** ✅ — all four PRs landed:
  - PR 1 — I10 timing-safe helper consolidation (`util/timing-safe-compare.ts`).
  - PR 2 — `tool_call_log` V29 audit table (forensic complement to I11).
  - PR 3 — `vec_items_1536` V30 + hybrid embedding routing + `nimbus index reembed` CLI.
  - PR 4 — typed `dbRun` / `dbExec` I14 migration (163 sites) + static rule `D12`.
- **T4 wrap-up — PagerDuty pagination + `severity_p1_aliases`** ✅.

### 2026-05-15

- **T6 PR 2 — `tool_call_log` V29** ✅.
- **T6 PR 3 — `vec_items_1536` V30** ✅.
- **Sub-project A** ✅ (PR #297) — README hero redesign (light/dark asciinema casts), OG social card + deterministic resvg-js renderer + render-and-diff CI gate.
- **Docs site — 29 first-party connector pages** ✅ (PR #243).
- **Roadmap restructured into Shipped / Active / Planned** ✅ (PR #247).

### 2026-05-14

- **T6 sequencing spec** ✅.
- **T4 wrap-up — PagerDuty connector enrichment** ✅ — `pagerduty-sync.ts` writes `opened_at_ms` / `pagerduty_service_id` / `severity`; `initialSyncDepthDays` 14 → 30.

### 2026-05-10

- **Phase 4 complete on `main`; Phase 5 in flight.**
- **T3 (Team Intelligence) epic complete** — `AgentCoordinator.executeAll` parallel sub-agent dispatch + `nimbus expert` (PR 1, 2026-05-09), `nimbus impact` (PR 2, 2026-05-09), `nimbus catchup` (PR 3, 2026-05-10).

### 2026-05-09

- **`v0.1.0` released** — headless Gateway + CLI + VS Code extension. The Tauri desktop UI is code-complete but its release vehicle (signed installers) is deferred to Phase 13 as the separate `desktop-v0.1.0` tag — see [`docs/roadmap.md` § Phase 13](./roadmap.md#desktop-release-vehicle).

---

## Earlier phases

Phases 1 (Foundation), 2 (The Bridge), 3 (Intelligence), 3.5 (Observability & Developer Experience), and 4 (Presence) are summarized with acceptance criteria in [`docs/roadmap.md` § Shipped](./roadmap.md#shipped).
