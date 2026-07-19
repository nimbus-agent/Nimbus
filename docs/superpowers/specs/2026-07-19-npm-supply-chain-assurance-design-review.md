# Design Review — npm Supply-Chain Assurance

**Date:** 2026-07-19
**Target:** [2026-07-19-npm-supply-chain-assurance-design.md](./2026-07-19-npm-supply-chain-assurance-design.md)

## Open Questions & Suggestions

### 1. Mitigation of Post-Publish Verification Failures

* **Problem:** `verify-npm-provenance` is a post-publish check. If the check fails (e.g., provenance was not generated or mismatched the expected source), the package has already been published to the npm registry. Since npm packages can only be unpublished within 72 hours (and under strict conditions), a silent failure or degradation that is only caught after publishing requires immediate human intervention.
* **Suggestion:**
  * Define a clear runbook or alert procedure for when `verify-npm-provenance` fails in the release workflow. The failure must trigger a high-severity notification (e.g., filing a critical issue with specific labels, sending a slack hook if available, or printing a clear step-by-step guide in the run logs on how to retract the release).
  * Consider adding a **pre-publish sanity check** in the CI workflow that asserts the presence of the `ACTIONS_ID_TOKEN_REQUEST_TOKEN` environment variable (which verifies that `id-token: write` permission is active and GitHub's OIDC provider is available) before running `npm publish`.

### 2. Registry Attestation API Retries and Backoff Strategy

* **Problem:** The npm registry's attestation endpoint (`/-/npm/v1/attestations/`) can have replication delays across CDN edges. A simple linear retry mechanism (5 attempts over 60 seconds) might be too tight during peak registry loads or minor outages, leading to false-positive build failures.
* **Suggestion:**
  * Implement an exponential backoff retry strategy with a jitter (e.g., starting at 5s, doubling each time up to a maximum of 30s) spanning a slightly longer window (e.g., 2–3 minutes total) to ensure maximum robustness against registry lag.

### 3. Masking & Redaction in `probe-publish-token`

* **Problem:** The `probe-publish-token` action will handle extremely sensitive credentials (`VSCE_PAT` and `OVSX_PAT`). If the API responses or debug logs accidentally output parts of the request payload, headers, or error messages, these credentials could be leaked into the public GitHub Actions execution logs.
* **Suggestion:**
  * The design must explicitly state that `probe-publish-token` will never log the tokens, request headers, or raw response bodies.
  * Ensure that standard `core.setSecret()` or environment masking is used if the tokens are processed dynamically, and sanitize any error outputs to strip potential credential leakages.

### 4. Azure DevOps PAT Retirement Fallback Plan

* **Problem:** The Microsoft Azure DevOps retirement of global PATs is scheduled for **2026-12-01**. The replacement path (`azure/login` + Entra user-assigned managed identity) requires an active Azure tenant and subscription, which adds overhead and configuration complexity.
* **Suggestion:**
  * The tracked issue for `nimbus-vscode` should prioritize confirming if org-scoped Azure DevOps PATs (which are NOT global PATs and might survive the transition) are supported for VS Marketplace publishing.
  * If org-scoped PATs are supported, they should be used as the immediate fallback to avoid having to provision an Azure tenant/subscription solely for vscode extension publishing.

### 5. Registry Attestation API Endpoint Structure

* **Problem:** The endpoint `https://registry.npmjs.org/-/npm/v1/attestations/<package>@<version>` is used to retrieve attestations. The package name might contain a scope (e.g., `@nimbus-dev/sdk`), which means it contains a `/` character (e.g., `/-/npm/v1/attestations/@nimbus-dev/sdk@1.3.0`).
* **Suggestion:**
  * Ensure the package name scope is properly URI-encoded when constructing the request URL (e.g., replacing `@nimbus-dev/sdk` with `%40nimbus-dev%2Fsdk` if required by the registry endpoint design). The design and testing implementation should verify the exact URL format accepted by npm for scoped packages.

## Resolutions

Recorded 2026-07-19 against design revision 2. Each item is accepted, modified, or resolved by evidence — none are deferred.

### 1. Post-publish failure mitigation — **ACCEPTED, and the design was strengthened beyond the suggestion**

The strongest finding in this review. The critique that post-publish verification is structurally late is correct, and the suggested `ACTIONS_ID_TOKEN_REQUEST_TOKEN` assertion is the right lever: that variable is injected only when `id-token: write` is in effect, so its absence detects the most likely regression — an unrelated permissions edit — *before* anything irreversible occurs.

The design now specifies a **pre-publish preflight** asserting both that variable's presence **and** an `npm >= 11.5.1` floor (the second dominant degradation cause, since it exceeds the npm bundled with Node 22 and both satellites currently paper over it with `npm install -g npm@latest`). The post-publish gate is retained — the preflight cannot prove an attestation was actually recorded — so the two are complementary, not alternatives.

A failure runbook is specified for the gate's failure path (package, version, failed assertion, whether the 72-hour unpublish window is open, deprecate-and-republish path otherwise). **Slack notification was not adopted:** the org has no release webhook today, and creating one would add an unowned integration to a program whose purpose is reducing unowned surface. The existing de-duped issue filer from sub-project 1 carries the alert instead.

### 2. Retry backoff — **ACCEPTED with one deliberate modification**

Exponential backoff adopted: 5s doubling to a 30s cap, spanning roughly 2.5 minutes, replacing the original 5-attempts-over-60s.

**Jitter was not adopted, deliberately.** Jitter decorrelates a *fleet* of clients retrying in lockstep. Here exactly one client retries per publish, so there is no correlated load to spread — it would only introduce nondeterminism into the backoff-schedule tests. The reasoning is recorded in the design so it is not re-proposed later.

### 3. Credential masking in `probe-publish-token` — **ACCEPTED**

Correct and load-bearing: this action handles two live publish credentials in a public repository's logs. The design now carries an explicit non-disclosure contract — tokens via environment only and never on argv (matching the cert-decoder precedent from sub-project 1), masking registered at entry, logging restricted to the derived classification and HTTP status, and **error paths scrubbed**, since client libraries routinely embed request headers in thrown errors. That last point is the one most easily missed, so it is called out separately and covered by a test asserting no token value appears on any path.

### 4. Azure DevOps fallback ordering — **ACCEPTED**

The suggestion to exhaust the cheap answer first is right, and the tracked issue is now explicitly **ordered**: (1) determine whether the current `VSCE_PAT` is global or org-scoped; (2) establish whether an org-scoped PAT is accepted for Marketplace publishing — the pivotal unknown, [microsoft/vscode#322741](https://github.com/microsoft/vscode/issues/322741), still open and unanswered; (3) price the Azure path **only** if both answers are unfavourable. If an org-scoped PAT works, this reduces from an infrastructure project to a credential swap and no Azure tenant is needed.

### 5. Scoped-package URL encoding — **RESOLVED BY MEASUREMENT; no change required**

Tested against the live registry rather than reasoned about. All three candidate forms return **HTTP 200**:

| Form | Result |
| --- | --- |
| Raw — `@nimbus-dev/sdk@1.3.0` | 200 |
| Fully percent-encoded — `%40nimbus-dev%2Fsdk@1.3.0` | 200 |
| Mixed — `%40nimbus-dev/sdk@1.3.0` | 200 |
| Nonexistent version — `@nimbus-dev/sdk@99.99.99` | 404 |

The registry normalises all three, so the concern does not manifest. The implementation uses the raw form; the 404 result also confirms the "no attestation published" signal shape the classifier depends on. Both are now recorded in the design with fixtures pinning them, so a registry-side change surfaces as a test failure rather than a release-time surprise.

### Note on the Alignment section below

One wording correction: OIDC trusted publishing was **not** introduced by this sub-project — it was already live before it began, having landed as a side-effect of the SDK and client extractions. What this sub-project eliminates is the **orphan** `NPM_TOKEN` secret (referenced by zero workflows) and the token-publishing bypass that made OIDC merely preferred rather than enforced. The described detection mechanism is accurate.

## Alignment with Invariants

* **Credentials Handling (Non-Negotiable 3):** The OIDC migration completely eliminates the long-lived `NPM_TOKEN`. The `NPM_TOKEN` orphan detection mechanism safely verifies non-existence in `check-secret-health.ts` using binary presence detection (empty/non-empty env check) without ever logging or exposing the value if it exists.
* **HITL Consent (Non-Negotiable 2 / I2):** Release checks and secret health checks operate entirely within the CI/CD pipeline and do not bypass local consent gates or execution controls on nimbus instances.
