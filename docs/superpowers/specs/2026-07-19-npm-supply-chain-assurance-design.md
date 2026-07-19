# npm Supply-Chain Assurance — Design

> **Status:** Design — approved in brainstorm (2026-07-19); ready for implementation plan.
> **Sub-project 3 of 4** in the org secrets-management program. Sub-project 1 (release-health verification + secret-health monitor) shipped in #768; sub-project 2 (GitHub App migration) shipped in #772. The remaining sub-project is #4 (rotation calendar + env/push-protection hardening).

## Problem

This sub-project was scoped as *"npm OIDC trusted publishing + keyless signing, to retire the long-lived `NPM_TOKEN`."* **That work is already live.** Verified against the registry, not the docs:

| Check | Finding |
| --- | --- |
| `nimbus-sdk` / `nimbus-client` `release.yml` | `id-token: write`, `npm publish --provenance`, **no `NODE_AUTH_TOKEN`** — OIDC trusted publishing |
| `@nimbus-dev/sdk@1.3.0` attestations | `npm/publish/v0.1` **and** `slsa.dev/provenance/v1` |
| `@nimbus-dev/client@0.5.0` attestations | same, both predicates |
| `NPM_TOKEN` referenced by any workflow in any of the 5 repos | **zero references** |

It landed as a side-effect of the SDK and client extractions. So the residual risk is not *"we lack OIDC"* — it is that **the OIDC guarantee is unverified, silently degradable, and bypassable**:

1. **`NPM_TOKEN` is a live orphan credential** on `nimbus-agent/Nimbus` (created 2026-06-14), consumed by nothing. A standing publish credential with no purpose.
2. **Nothing verifies provenance actually landed.** `npm publish --provenance` degrades quietly — a missing `id-token: write`, an npm older than 11.5.1, or a registry hiccup can yield a *successful publish with no attestation*. npm versions cannot be unpublished after 72 hours, so a degraded release is permanent.
3. **Nothing verifies provenance points at *us*.** "An attestation exists" is a weaker claim than "attested to this repo, this workflow, this commit."
4. **Token publishing remains a bypass.** While the packages accept classic/granular tokens, OIDC is merely *preferred*, not *enforced*.
5. **`nimbus-vscode` still carries two long-lived publish PATs** (`VSCE_PAT`, `OVSX_PAT`) with no expiry visibility — the exact failure mode that caused the v0.17–v0.21 phantom releases.

## Goals

- Revoke and remove the orphan `NPM_TOKEN`, and assert it never returns.
- Make OIDC **load-bearing** rather than preferred, by disallowing token publishing on both packages.
- **Verify** at release time that each publish produced a full attestation set naming this repo, this workflow, and this commit — failing the job when it does not.
- Monitor published provenance **continuously**, folded into the existing weekly secret-health report.
- Gain expiry/liveness **visibility** on `VSCE_PAT` and `OVSX_PAT`, and surface the 2026-12-01 Azure DevOps deadline as tracked work.
- Ship the shared logic once, consumed by all repos that need it.

## Non-goals

- **Azure/Entra tenancy for Marketplace OIDC.** See "Marketplace and Open VSX — what is actually possible" below. Deliberately deferred to #4 as an informed decision, not an oversight.
- **Open VSX federation.** Does not exist (see below).
- **cosign for the Nimbus binaries.** `release.yml` already runs `actions/attest-build-provenance`; adding a second signing scheme is duplicated surface, not added assurance.
- **The sub-project #2 leftovers** — deleting the three retired PATs after a full release cycle, and tightening `release-please.yml` job permissions to `contents: read`. Both stay on their own track.
- **A new `release-tooling` repo.** Considered and rejected: the shareable surface is one small checker used by three repos, and a dedicated repo would need its own CI, branch protection, and publish pipeline — adding release surface to a program whose purpose is shrinking it. Revisit if the shared surface grows beyond two or three actions.

## Marketplace and Open VSX — what is actually possible

Researched 2026-07-19. This section exists so the deferral in Non-goals is auditable rather than assumed.

- **Visual Studio Marketplace.** True trusted publishing (GitHub OIDC to Marketplace, npm-style) is an open, unassigned feature request: [microsoft/vsmarketplace#1422](https://github.com/microsoft/vsmarketplace/issues/1422). The only shipped token-less path is `azure/login` (GitHub OIDC to a federated credential on an Entra user-assigned managed identity) followed by `vsce publish --azure-credential` (requires `vsce` >= 2.26.1). That path needs **an Azure subscription and tenant**, and for GitHub Actions it is community-documented, not officially supported.
- **Deadline.** Global Azure DevOps PATs were blocked from creation on **2026-03-15** and are decommissioned on **2026-12-01** ([retirement announcement](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/)). If the current `VSCE_PAT` is a global PAT, vscode publishing breaks then and the PAT **cannot be regenerated**. Whether an org-scoped PAT is even accepted for Marketplace publishing is itself unresolved: [microsoft/vscode#322741](https://github.com/microsoft/vscode/issues/322741).
- **Auto-rotation is not available.** The Azure DevOps PAT Lifecycle Management API refuses service principals and managed identities, so a workflow cannot rotate its own `VSCE_PAT` unattended.
- **Open VSX.** Long-lived `OVSX_PAT` is the only option. Trusted publishing is [eclipse-openvsx/openvsx#1534](https://github.com/eclipse-openvsx/openvsx/issues/1534) — open, unassigned, nothing shipped.
- **`.vsix` signing.** The Marketplace performs *repository* signing (proving "served by the Marketplace"), not publisher signing; publisher-held signing remains a proposal. A `attest-build-provenance` attestation on a `.vsix` is therefore verifiable only by someone who downloads the **GitHub release asset** and runs `gh attestation verify` deliberately.

## Credential cleanup — ordered, human-gated

Order matters: revoking before deleting preserves the token id needed to find it.

1. **Human:** `npm token list`, then revoke the token backing `NPM_TOKEN` on npmjs.com. *This is the step that removes the risk* — deleting the GitHub secret only removes a copy.
2. **Automated:** `gh secret delete NPM_TOKEN --repo nimbus-agent/Nimbus`. Safe at any time: zero workflows reference it.
3. **Human:** on both `@nimbus-dev/sdk` and `@nimbus-dev/client`, set publishing access to **require two-factor authentication and disallow tokens**. This is what converts OIDC from preferred to enforced.
4. **Automated:** a regression assertion in the weekly monitor that fails if an `NPM_TOKEN` secret ever reappears.

Steps 1 and 3 are owner actions on npmjs.com and are prerequisites recorded in the plan, not something the implementation performs.

## Architecture: shared actions in `nimbus-agent/.github`

The org's `.github` repo already exists, is public, and currently holds only community-health files. It gains an `actions/` directory. Consumers pin by SHA, matching the org's existing `sha_pinning_required` discipline.

Both actions are **composite actions running dependency-free Node** (GitHub runners ship Node 20, so no setup step and no install), with **pure classifier functions separated from all I/O** so the decision logic is unit-testable without network.

### `actions/verify-npm-provenance`

| Input | Meaning |
| --- | --- |
| `package` | npm package name, e.g. `@nimbus-dev/sdk` |
| `version` | version just published |
| `expected-repo` | `owner/repo` that must appear in the provenance source claim |
| `expected-workflow` | *(optional)* workflow path that must have produced it |
| `expected-sha` | *(optional)* commit the build must have come from |

Fetches `https://registry.npmjs.org/-/npm/v1/attestations/<package>@<version>` and asserts:

**URL form for scoped packages — empirically settled 2026-07-19.** All three candidate encodings return HTTP 200 against the live registry: the raw form (`@nimbus-dev/sdk@1.3.0`), the fully percent-encoded form (`%40nimbus-dev%2Fsdk@1.3.0`), and the mixed form (`%40nimbus-dev/sdk@1.3.0`). The implementation uses the **raw form**; no encoding gymnastics are required. A nonexistent version returns **404**, confirming 404 as the "no attestation published" signal. Fixtures pin both shapes so a registry-side change to either surfaces as a test failure.

- **Both** predicate types are present — `https://github.com/npm/attestation/tree/main/specs/publish/v0.1` **and** `https://slsa.dev/provenance/v1`. A publish attestation alone means provenance silently degraded.
- The SLSA predicate's `buildDefinition` source claim matches `expected-repo` (and `expected-workflow` / `expected-sha` when supplied). This is the difference between "an attestation exists" and "attested to us".

**Attestation lag.** Attestations can trail the publish, and the registry is CDN-fronted with edge replication delay, so the action retries before concluding absence: **exponential backoff starting at 5s and doubling to a 30s cap, spanning roughly 2.5 minutes total** (5s, 10s, 20s, 30s, 30s, 30s…). A 404 is only conclusive once that window is exhausted.

**Jitter is deliberately omitted.** Jitter exists to decorrelate a *fleet* of clients retrying in lockstep. Here there is exactly one client per publish, so jitter adds nondeterminism to the test surface and buys nothing. Recorded so it isn't re-proposed later.

**Failure semantics differ by caller, deliberately:**

| Condition | Post-publish gate | Weekly monitor |
| --- | --- | --- |
| Predicate missing / source mismatch | **fail** | **fail** (files an issue) |
| Registry 404 after retries | **fail** | `indeterminate` |
| Registry 5xx / network error | **fail** | `indeterminate` |

The monitor must not convert a registry hiccup into issue spam; the release gate must not let a possibly-degraded publish through. Same classifier, different severity mapping supplied by the caller.

### Pre-publish preflight — catching degradation *before* it is permanent

Post-publish verification is necessary but structurally late: npm versions cannot be unpublished after 72 hours, so a failed gate reports damage rather than preventing it. The two dominant causes of silent provenance degradation are both detectable **before** `npm publish` runs, so the satellites gain a preflight step that converts a permanent problem into an ordinary job abort:

- **Assert `ACTIONS_ID_TOKEN_REQUEST_TOKEN` is present.** This variable is injected into the job environment only when `id-token: write` is in effect. Its absence means OIDC is unavailable — the single most likely regression, since it can be introduced by an unrelated permissions edit. It is a short-lived request token, never logged; the check tests presence only.
- **Assert `npm --version` is at least 11.5.1.** Trusted publishing requires it, and it is newer than the npm bundled with Node 22. Both satellites currently install `npm@latest` to compensate; asserting the floor means a regression in that step fails loudly instead of silently degrading to a token-era publish path.

The post-publish gate remains — the preflight cannot prove the attestation was actually recorded — but the expensive, irreversible failure mode is now caught early.

**Failure runbook.** When the post-publish gate fails, the release job prints an explicit operator runbook: the affected package and version, which assertion failed, whether the 72-hour unpublish window is still open, and the deprecate-and-republish path once it is not. The weekly monitor's finding routes through the **existing** de-duped issue filer from sub-project 1 rather than a new alerting channel. No Slack notification is specified: the org has no release webhook today, and inventing one here would add an unowned integration to a program about reducing unowned surface.

### `actions/probe-publish-token`

Liveness probes for the two credentials that cannot be retired: `VSCE_PAT` against the Azure DevOps Marketplace API, `OVSX_PAT` against the open-vsx API. Classification matches the existing `check-secret-health.ts` vocabulary — HTTP 200 is `ok`, 401 is `dead`, anything else is `indeterminate`.

**Non-disclosure contract (Non-Negotiable 3).** This action handles two live publish credentials in a public repository's logs. It therefore: passes tokens only via environment, never on argv (matching the cert-decoder precedent from sub-project 1); registers each token for masking at entry; logs **only** the derived classification and HTTP status — never the token, request headers, or raw response bodies; and scrubs error paths, since client libraries routinely embed request headers in thrown errors. Tests assert that no probe output contains the token value on **any** path, including the error path.

The `.github` repo gains a minimal `bun test` CI workflow to cover both actions' classifiers. This is the cost of the chosen topology and is accepted.

## Wiring

| Repo | Change |
| --- | --- |
| `nimbus-sdk`, `nimbus-client` | A **pre-publish preflight** (OIDC token present, npm floor met) that aborts before anything irreversible happens, plus a **post-publish** step calling `verify-npm-provenance` (SHA-pinned) with the just-published version. A degraded publish now fails loudly at release time — the 72-hour unpublish window makes late detection worthless. |
| `Nimbus` (this repo) | `scripts/release/check-secret-health.ts` gains one provenance row per package (latest published version attested to the expected repo) plus the no-orphan-`NPM_TOKEN` assertion. Both feed the **existing** de-duped issue filer from sub-project 1 — no new alerting surface. The registry endpoint is public, so this needs no credentials. |
| `nimbus-vscode` | Its own `secret-health.yml` calling `probe-publish-token` **where the secrets already live**. `VSCE_PAT` / `OVSX_PAT` are deliberately **not** copied into the monorepo — spreading credentials to centralise monitoring would be a net loss. Also adds `attest-build-provenance` over the packaged `.vsix`. |

**How the no-orphan assertion works.** `GITHUB_TOKEN` *cannot* list repository secrets — the Actions secrets API requires admin scope and there is no `secrets: read` workflow permission — so absence is asserted by binding rather than by listing. `secret-health.yml` passes `NPM_TOKEN: ${{ secrets.NPM_TOKEN }}` into the check's environment; an absent secret interpolates to the empty string. The check asserts the variable is empty and reports `ok`, or non-empty and reports a failure row. This reuses the `not-configured` detection already in `check-secret-health.ts`, requires no new permission, and — consistent with sub-project 1 — tests only for emptiness, never logging or passing the value onward.

## Deadline de-risk

A tracked issue on `nimbus-vscode`, with an explicitly **ordered** investigation so the cheap answer is exhausted before the expensive one:

1. **Determine whether the current `VSCE_PAT` is global or org-scoped.** If org-scoped, it is not covered by the 2026-12-01 decommission and the cliff may not apply at all.
2. **Establish whether an org-scoped PAT is accepted for Marketplace publishing.** This is the pivotal unknown ([microsoft/vscode#322741](https://github.com/microsoft/vscode/issues/322741), open, unanswered). If yes, an org-scoped PAT is the immediate fallback and **no Azure tenant is required** — reducing this from an infrastructure project to a credential swap.
3. **Only if both answers are unfavourable**, price the `azure/login` + Entra managed-identity path. Provisioning an Azure subscription solely to publish one VS Code extension is a real cost and must be a deliberate, evidenced decision rather than a default.

Combined with weekly probes, a dead token surfaces within seven days instead of at the next release — which is precisely the regression class this whole program exists to eliminate.

## Documentation

`docs/ci-secrets.md` gains a provenance-verification section plus expiry and owner notes for the two surviving publish PATs.

The `.vsix` documentation states plainly that `gh attestation verify` covers **the GitHub-release copy**. Whether the Marketplace serves byte-identical `.vsix` bytes could not be confirmed, so no claim is made that the attestation covers a Marketplace download.

## Testing

Pure classifiers are unit-tested against **real captured** attestation bundles, trimmed and committed as fixtures. No test touches the network. Failure paths are covered explicitly, not just the happy path:

- missing `slsa.dev/provenance/v1` predicate (the silent-degradation case)
- missing `npm/publish/v0.1` predicate
- source repo mismatch, workflow mismatch, commit mismatch
- registry 404 (distinguishing "retries exhausted" from "first attempt")
- registry 5xx and network error
- malformed / truncated JSON
- the severity-mapping split: identical input classified `fail` for the gate and `indeterminate` for the monitor
- backoff schedule shape (deterministic, since jitter is omitted) and the retry-exhaustion boundary
- scoped-package URL construction, pinned against the empirically confirmed forms
- preflight: missing `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, and npm below the 11.5.1 floor
- **non-disclosure**: no probe output on any path — success, `dead`, `indeterminate`, or thrown error — contains a token value

Monorepo-side changes follow the existing `scripts/release/` conventions — pure functions, injected API surface, Bun tests alongside.

## Risks

| Risk | Mitigation |
| --- | --- |
| Attestation lag causes false release failures | Bounded retry with backoff before concluding absence; tested against the retry-exhaustion path |
| npm's attestation response shape changes | Classifier fails closed on unrecognised shape and reports the reason; fixtures are real captures, so a shape change surfaces as a test-visible diff |
| Disallowing tokens breaks an unknown publish path | Verified zero workflow references to `NPM_TOKEN` across all five repos before step 3; OIDC path is already proven by the two live published versions |
| `.github` repo becomes an untested dumping ground | It gains real CI in this sub-project; the topology decision is revisited if the shared surface exceeds two or three actions |
| Five repos in one sub-project causes partial landing | Each repo lands as its own PR gated green; the monorepo PR is independently useful, and the satellite gates are additive — no repo depends on another's merge to keep working |

## Sequencing

The satellite gates depend on the shared actions existing and being SHA-pinnable, so `.github` lands first. Nothing else is order-dependent.

1. `nimbus-agent/.github` — both composite actions plus their CI.
2. `Nimbus` — monitor rows, no-orphan assertion, `docs/ci-secrets.md`.
3. `nimbus-sdk`, `nimbus-client` — post-publish verification gates.
4. `nimbus-vscode` — `secret-health.yml`, `.vsix` attestation, tracked deadline issue.
5. Human prerequisites (npm revoke, disallow tokens), then the `NPM_TOKEN` secret deletion.
