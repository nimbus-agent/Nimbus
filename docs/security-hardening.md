# Security hardening — status

Items marked **Automated** run in CI; **Manual** require human sign-off before a release.

| Item | Status | Evidence |
|------|--------|----------|
| `bun audit --audit-level high` clean, except advisories the registry has accepted and whose acceptance has not lapsed | **Automated** | `.github/workflows/security.yml` job `Dependency audit`, step `bun audit (retry transport failures only)`. Passes over an advisory only while that advisory has an open, well-formed row in the registry below. The `--ignore` arguments are derived from the registry by [`scripts/structure-audit/advisory-ignore-args.ts`](../scripts/structure-audit/advisory-ignore-args.ts) and never typed into the workflow. See [Accepting an advisory that has no fix](#accepting-an-advisory-that-has-no-fix). |
| Every live npm advisory has a written, dated decision | **Automated** | `security.yml` job `Dependency audit`, step `Accepted-advisory registry` (`bun run audit:advisories`). Registry: [`scripts/structure-audit/accepted-advisories.ts`](../scripts/structure-audit/accepted-advisories.ts). Covers what `--audit-level high` does not: a moderate/low advisory below the blocking threshold must be fixed or accepted with a reason, an unblocking condition and a `recheckBy` date. The gate fails on an unjudged advisory, an expired row, a stale row whose advisory has cleared, or a severity re-scored above the accepted level. It is also the package-scoped, severity-aware re-check of every advisory the blocking step passed over. JS-side mirror of the `[advisories].ignore` list in `packages/ui/src-tauri/deny.toml`. |
| Trivy on dependency / config surface | **Automated** | `security.yml` job `Trivy vulnerability scan` (filesystem scan of repo root; includes all workspace `package.json` and lockfiles) |
| `cargo audit` (Tauri / `Cargo.lock`) | **Automated** | `security.yml` job `Cargo audit (Tauri)` (`packages/ui/src-tauri`) |
| `cargo deny` (licenses + advisories + bans) | **Automated** | `security.yml` job `Cargo deny (licenses + advisories + bans)` (AGPL-compatibility + unmaintained-crate bans + registry pinning) |
| JS dependency license compliance (workspace-wide) | **Automated** | `security.yml` job `Dependency audit`, step `License compliance (workspace-wide)` (`bun run audit:js-licenses`). It was a standalone `JS license compliance` job until it was folded into that job, so a violation now fails the required check. |
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

## Accepting an advisory that has no fix

`Dependency audit` is a required check, and its `bun audit --audit-level high` step fails on any
HIGH or CRITICAL npm advisory, so one blocks every PR until something changes. Usually that change
is an upgrade: a root `overrides` pin in `package.json` lifts the vulnerable package out of the
advisory's range. When no patched release exists anywhere in the version graph, there is nothing to
upgrade to, so the decision is written down in one place instead. The order of preference, also
stated at the top of the registry, is:

1. **Upgrade.** Check every link in the chain `bun why <package>` prints, not only the vulnerable
   package. A parent's newer release may have dropped it.
2. **Prove the vulnerable path unreachable, and record the proof.** Name what depends on the
   package and whether anything that ships contains it (the compiled gateway and CLI, the desktop
   app, a published package), then explain why the specific flaw cannot be triggered.
3. **Accept, with a named unblocking condition.** Add a row to
   [`accepted-advisories.ts`](../scripts/structure-audit/accepted-advisories.ts) with `ghsa` (the
   exact `GHSA-xxxx-xxxx-xxxx` id), `package`, `severity`, `noFixReason`, `reachability`,
   `unblockedBy` (the upstream event that lets the row be deleted), `acceptedOn`, `recheckBy` and
   `owner`. `recheckBy` may be at most 92 days after `acceptedOn`, and shorter is better while a fix
   may still be coming. `acceptedOn` is the day of the decision: both steps refuse a row dated
   later than tomorrow (UTC), because the window counts from that date and a future one would
   keep the row open past the cap.

Both advisory steps of the `Dependency audit` job read that one list, so there is no second copy to
keep in step:

- **The blocking `bun audit` step** first runs `scripts/structure-audit/advisory-ignore-args.ts`, which
  turns each open, well-formed row into one `--ignore=<GHSA>` argument. A row is withheld if its
  window has closed (it holds through `recheckBy` and lapses the next day), if it breaks any row rule
  `audit:advisories` applies, if it is duplicated, if another row naming the same GHSA is withheld
  (bun cannot limit an ignore to one package, so a GHSA is passed over only while every row naming
  it is open), or if its id is not an exact GHSA id. The last rule matters because bun matches
  `--ignore` against a SUBSTRING of the advisory URL: a partial id such as `GHSA`, or a URL
  prefix, would silence every advisory there is. bun honours neither a CVE id
  (whatever its `--help` text says, nothing it matches against carries one) nor a comma-joined list,
  so each advisory gets an argument of its own. The step log lists every row passed over and warns
  about every row withheld, and a withheld row whose advisory is still live at HIGH or above fails
  the step with bun's own report.
- **`bun run audit:advisories`** runs next and never passes `--ignore`. It holds every live
  advisory, of any severity, to its row, matched by package as well as by id. It fails on an
  unaccepted advisory, an expired row, a stale row whose advisory has cleared, a severity re-scored
  above the accepted level, and a malformed or duplicate row. That covers what the blocking step
  cannot see for itself, since bun's `--ignore` is neither package-scoped nor severity-aware.

**When a row lapses**, the `Dependency audit` job goes red the next day. If the advisory is HIGH or
above, the blocking step fails on it, and because a failed step skips every later step in the job,
`audit:advisories` does not run until that is resolved. Below HIGH, `audit:advisories` reports the
row `expired`. Re-judge it. If the unblocking event has happened, take the upgrade and delete the
row. If not, re-verify the reachability proof against the current lockfile, record what you
checked, move `acceptedOn` to the date of that re-judgement and set a new `recheckBy`. **When the advisory clears**, for example because a fix was published and
installed, `audit:advisories` reports the row as stale until it is deleted. Retiring a row means
deleting it, never leaving it in place.

Trivy's filesystem scan runs with `ignore-unfixed: true`, so an advisory with no fix never fails the
Trivy check; `bun audit` is where such an advisory gets judged. The Rust tree's equivalent of the
registry is the `[advisories].ignore` list in `packages/ui/src-tauri/deny.toml`.

## Maintainer workflow

1. Before tagging: confirm **Manual** rows above for the delta since last release.
2. On PRs: required status checks live in the **General** ruleset (**GitHub → Settings → Rules → Rulesets**, id `14784377`), so merges are blocked when jobs fail — not only when checks are “green” in the UI. It requires ten contexts: **PR quality — required gates** (the aggregator over every PR-quality job), the six **Security** contexts (`Dependency audit`, `Trivy vulnerability scan`, `Gitleaks secret scan`, `Gateway audit JSON + connector.remove vault restore`, `Cargo audit (Tauri)`, `Cargo deny (licenses + advisories + bans)`), **Analyze (javascript-typescript)** and **Analyze (rust)** (CodeQL), and **cla**. Do not add individual jobs as required contexts. A reusable-workflow caller never reports under its own name (its checks are named `<caller> / <job>`), and a matrix leg that its `if:` skips reports only under its unexpanded `${{ matrix.os }}` name, so requiring either one by name leaves the PR waiting forever. A statically named job that its `if:` skips reports `skipped`, which passes, so it would not stall a PR, but `PR quality — required gates` already covers every PR-quality job, and requiring the label-gated **E2E Desktop (PR) — ubuntu-24.04** would only gate the PRs that carry its label. Exact names must match the Actions tab (see [`.github/BRANCH_PROTECTION.md`](../.github/BRANCH_PROTECTION.md)).
