# Security hardening — status

Items marked **Automated** run in CI; **Manual** require human sign-off before a release.

| Item | Status | Evidence |
|------|--------|----------|
| `bun audit --audit-level high` clean | **Automated** | `.github/workflows/security.yml` job `Dependency audit` |
| Every live npm advisory has a written, dated decision | **Automated** | `security.yml` job `Dependency audit`, step `Accepted-advisory registry` (`bun run audit:advisories`). Registry: [`scripts/structure-audit/accepted-advisories.ts`](../scripts/structure-audit/accepted-advisories.ts). Covers what `--audit-level high` does not: a moderate/low advisory below the blocking threshold must be fixed or accepted with a reason, an unblocking condition and a `recheckBy` date. The gate fails on an unjudged advisory, an expired row, a stale row whose advisory has cleared, or a severity re-scored above the accepted level. JS-side mirror of the `[advisories].ignore` list in `packages/ui/src-tauri/deny.toml`. |
| Trivy on dependency / config surface | **Automated** | `security.yml` job `Trivy vulnerability scan` (filesystem scan of repo root; includes all workspace `package.json` and lockfiles) |
| `cargo audit` (Tauri / `Cargo.lock`) | **Automated** | `security.yml` job `Cargo audit (Tauri)` (`packages/ui/src-tauri`) |
| `cargo deny` (licenses + advisories + bans) | **Automated** | `security.yml` job `Cargo deny (licenses + advisories + bans)` (AGPL-compatibility + unmaintained-crate bans + registry pinning) |
| JS dependency license compliance (workspace-wide) | **Automated** | `security.yml` job `JS license compliance` |
| Gitleaks secret scan (PRs + nightly) | **Automated** | `security.yml` job `Gitleaks secret scan` |
| CodeQL JavaScript/TypeScript and Rust | **Automated** | `.github/workflows/codeql.yml` (entire monorepo, including MCP connector packages; security-extended queries for both languages) |
| OpenSSF Scorecard (supply chain SARIF) | **Automated** | `.github/workflows/scorecard.yml`; see [`SECURITY.md`](./SECURITY.md) for **Security-Policy** and items that need GitHub settings (branch protection, reviews) or external programs (OSS-Fuzz, CII badge) |
| Build provenance attestation (release artifacts) | **Automated** | `.github/workflows/release.yml` `actions/attest-build-provenance` step (Gateway + CLI binaries on all four platforms); verify with `gh attestation verify` |
| CycloneDX SBOM on release | **Automated** | `release.yml` `anchore/sbom-action` step; SBOM published as `nimbus-v<ver>-sbom.cdx.json` release asset |
| `@nimbus-dev/client` npm provenance | **External repo** | Published from [nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client) `release.yml` `npm publish --provenance` (sigstore / GitHub OIDC trusted-publisher, no token); verify with `npm audit signatures` |
| Static-time invariant audit (I1 spawn rule + vault-key allow-list + I14 `D12` direct `db.run`/`db.exec` ban + I15 `D10` `wrapServerSpec` sandbox routing + I17 `D13` federation item-read import gate + I18 `D14` identity-token Vault-key gate) | **Automated** | `.github/workflows/_structure.yml` reusable workflow runs `bun run audit:invariants` (`scripts/structure-audit/check-nimbus-invariants.ts`); the runtime invariant tests in `packages/gateway/src/security-invariants.test.ts` remain authoritative |
| `pkce.ts` — no secrets in exchange-failure exceptions | **Automated** | `packages/gateway/src/auth/pkce.test.ts` (Google + Microsoft invalid_grant paths) |
| `pkce.ts` / IPC / logs — full manual pass | **Manual** | Spot-check on material PKCE or IPC changes |
| Connector layout — no per-connector `auth.ts` | **Automated, in the connectors repo** | Moved with the connectors to [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers); the contract is about connector source shape, which is no longer in this repository |
| Connector credential flow ends in Vault + env only | **Manual** | Review `connector-rpc-handlers.ts`, lazy mesh env injection, each connector's `src/server.ts` in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers) when those files change |
| `connector.remove` resilience (SQLite index in WAL + transaction; Vault rollback on failure) | **Partially automated** | Index deletes run in `LocalIndex.removeConnectorIndexData` (`db.transaction`); `handleConnectorRemove` snapshots and restores all Google OAuth keys (`google.oauth`, `google_drive.oauth`, `google_gmail.oauth`, `google_photos.oauth`) and `microsoft.oauth` (+ per-service Microsoft keys) on Vault errors — see `packages/gateway/test/integration/connector-remove-oauth-restore.integration.test.ts`. True power-cut across separate stores cannot be fully simulated in CI. |
| Discord off by default | **Automated / product** | Lazy mesh + vault keys; see plan acceptance checklist |
| Minimum-scope Outlook (`Calendars.Read` only) | **Automated + manual** | Policy: `connectors/outlook/src/tool-scope-policy.ts` + `tool-scope-policy.test.ts` in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers); Gateway passes vault `scopes` via `readMicrosoftOAuthScopesForOutlookEnv` → `MICROSOFT_OAUTH_SCOPES` (`oauth-vault-scopes.test.ts`). **Manual:** smoke in a real tenant after auth. |
| No credential fragments in audit payloads | **Automated** | `packages/gateway/src/engine/audit-payload-safety.test.ts` (regex scan of HITL / consent-related JSON). The audit log is the SQLite `audit_log` table only — there is no file-based `audit.jsonl` (single-source-of-truth decision documented in [`SECURITY.md`](./SECURITY.md#audit-log)). |

## Maintainer workflow

1. Before tagging: confirm **Manual** rows above for the delta since last release.
2. On PRs: in **GitHub → Settings → Branches → branch protection**, add **required status checks** so merges are blocked when jobs fail — not only when checks are “green” in the UI. Include at minimum: **PR quality — TS/Bun (ubuntu-24.04)**, **E2E Desktop (PR) — ubuntu-24.04** (if you want desktop covered on every PR), **Security** jobs (`Dependency audit`, `Trivy vulnerability scan`, `Gateway audit JSON + connector.remove vault restore`, `Cargo audit (Tauri)`), and **Analyze (JavaScript / TypeScript)** (CodeQL). Exact names must match the Actions tab (see [`.github/BRANCH_PROTECTION.md`](../.github/BRANCH_PROTECTION.md)).
