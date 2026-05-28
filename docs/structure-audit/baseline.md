# B3 Structure Audit — Phase 1 Baseline

**Generated at commit:** `a3f327be871c810ff7c86690bb059fa381d85a6e`
**Date:** 2026-04-30
**Phase 1 of:** B3 structure audit (2026-04-30)

This file is the measured starting state of the structure-audit dimensions on
the `dev/asafgolombek/structure-audit-design` branch.

## Per-dimension baselines

| # | Bucket | Dimension | Baseline | Source / threshold |
|---|---|---|---|---|
| D1 | A | Forbidden cross-package imports | 0 violations | `bun run audit:boundaries` (binary) |
| D2 | A | Cyclic imports within a workspace | 0 violations | `bun run audit:boundaries` (binary) |
| D3 | A | PAL leakage | 0 violations | `bun run audit:boundaries` (binary) |
| D4 | B | Files > 800 raw LOC | 6 files (top file: `packages/gateway/src/connectors/lazy-mesh.ts`:1401) | `docs/structure-audit/file-loc.json` |
| D5 | B | Functions with cognitive complexity > 15 | (pending — populated when Phase 2 uploads the first SonarQube analysis) | SonarQube dashboard (post-analysis) |
| D6 | C | Per-workspace duplication % | 3.62% overall (`statistics.total.percentage` from jscpd-report) | `docs/structure-audit/jscpd-report.json` |
| D7 | D | Unused exports / orphan files | 234 files with at least one finding (400 raw findings post-Task-14 cleanup) | `docs/structure-audit/knip-report.json` |
| D8 | D | `any` count | 2 (frozen in `any-baseline.json`) | `bun run audit:any` |
| D9 | D | Risky type assertions (informational) | 399 | `docs/structure-audit/risky-assertions.json` |
| D10 | F | Spawn under connectors/ not via `extensionProcessEnv()` | 5 violations | `bun run audit:invariants` (binary) |
| D11 | F | Vault-key construction outside allow-list | 0 violations under manifest-derived regex (closed 2026-05-02) | `bun run audit:invariants` (binary) |
| D12 | F | `db.run()` outside `db/write.ts` (census) | 94 sites | `docs/structure-audit/db-run-census.json` |

## Phase 2 follow-up — post Bucket B (2026-05-01)

D11 violations reduced from the Phase 1 baseline of 56 to **21** (Bucket C only):

- Bucket A (20 false positives) — suppressed by `audit-ignore-next-line` markers (PR #135).
- Bucket B (15 sites) — routed through `readConnectorSecret` helper or added to the now-frozen 5-entry allow-list (this PR).
- Bucket C (21 sites in `lazy-mesh.ts` + `connector-rpc-handlers.ts`) — deferred at the time; closed below in the post-Bucket-C update.

## Phase 2 follow-up — post Bucket C (2026-05-02)

D11 violations reduced from the post-Bucket-B count of 21 to **0**. **D11 closed.**

- Bucket C — 12 read sites in `lazy-mesh.ts` migrated through `readConnectorSecret` + `sharedOAuthKey` (PR #149); 9 sites in `connector-rpc-handlers.ts` (6 writes + 1 read + 2 sharedKey assignments) migrated through `writeConnectorSecret` + `sharedOAuthKey` (PR <PR-2-number>).

The frozen 5-entry `VAULT_KEY_ALLOW_LIST` was unchanged across Buckets B and C.

## Phase 2 follow-up — post manifest-derived widening (2026-05-02)

D11 stays at **0** violations under the broader manifest-derived regex.

The audit script now derives `VAULT_KEY_RE` from `CONNECTOR_VAULT_SECRET_KEYS`
at startup, so every entry across all 28 connectors (43 keys total) is
gated — not just the original 4-suffix subset (`oauth | token | pat | api_key`).

- PR #154 migrated 42 sites in `connector-rpc-handlers.ts` and added the `deleteConnectorSecret<S>` helper.
- PR #155 migrated 50 sites in `lazy-mesh.ts`.
- PR #156 migrated 37 sites across 14 per-connector sync files + 3 in `connector-rpc-shared.ts` + 1 audit-ignore marker in `drift-hints.ts`.
- This PR widens the regex, allow-lists `connector-secrets-manifest.ts` as the 6th entry, adds `stripComments` to the audit so JSDoc references stop firing, and bumps the frozen-count test 5 → 6.

The allow-list is now frozen at **6 entries** for the foreseeable future.

## Provenance

- `count-any-usage` script: `scripts/structure-audit/count-any-usage.ts` @ `a3f327be871c810ff7c86690bb059fa381d85a6e`
- `check-nimbus-invariants` script: `scripts/structure-audit/check-nimbus-invariants.ts` @ `a3f327be871c810ff7c86690bb059fa381d85a6e`
- `measure-file-loc` script: `scripts/structure-audit/measure-file-loc.ts` @ `a3f327be871c810ff7c86690bb059fa381d85a6e`
- `get-git-churn` script: `scripts/structure-audit/get-git-churn.ts` @ `a3f327be871c810ff7c86690bb059fa381d85a6e`
- `list-risky-assertions` script: `scripts/structure-audit/list-risky-assertions.ts` @ `a3f327be871c810ff7c86690bb059fa381d85a6e`
- `dependency-cruiser` config: `.dependency-cruiser.cjs` @ `a3f327be871c810ff7c86690bb059fa381d85a6e`
- `jscpd` config: `.jscpd.json` @ `a3f327be871c810ff7c86690bb059fa381d85a6e`
- `knip` config: `knip.json` @ `a3f327be871c810ff7c86690bb059fa381d85a6e`
- `knip.json` (post-Task-14 tuning) @ `16b2c58`

## Phase 2 thresholds derived from this baseline

- **D8 manual ratchet:** any new PR's `any` count must equal `2` from this file. Reductions require updating `any-baseline.json` in the same PR (see spec § 3.3).
- **D6 duplication threshold:** `> 3 %` per workspace, **or** any duplicated block ≥ 100 tokens (whichever fires first).
- **D4 LOC threshold:** `> 800` raw LOC per file.
- **D5 cognitive complexity threshold:** `> 15` per function (SonarQube).
- **`structural_impact_score = 4` cutoff:** files in the top 20% by 90-day commit count (`p80Threshold` in `churn-90d.json`).

## Files committed at Phase 1 close

- `docs/structure-audit/any-baseline.json`
- `docs/structure-audit/db-run-census.json`
- `docs/structure-audit/churn-90d.json`
- `docs/structure-audit/baseline.md` (this file)
- `docs/structure-audit/sonarqube-rule-tuning.md` (empty placeholder, populated only if Phase 2 needs rule tuning)
