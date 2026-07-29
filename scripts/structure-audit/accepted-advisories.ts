/**
 * The accepted-advisory registry: every npm advisory `bun audit` reports that
 * this repository has deliberately decided NOT to fix, with the reason and a
 * date by which the decision must be re-made.
 *
 * This is the JS-side mirror of the `[advisories].ignore` list in
 * `packages/ui/src-tauri/deny.toml` — same contract, same culture: an advisory
 * is either fixed or it is written down here. A row is not permission to stop
 * looking; `audit:advisories` fails once `recheckBy` passes, and fails again if
 * the row is still here after the advisory has cleared (retire = delete the row,
 * never leave drift).
 *
 * Adding a row is a last resort. The order of preference is:
 *   1. Upgrade. Root `overrides` in package.json is this repo's mechanism.
 *   2. Prove the vulnerable code path unreachable AND record that proof here.
 *   3. Only then, accept — with a named unblocking condition.
 *
 * `docs/security-hardening.md` carries the human narrative; this file is
 * authoritative for anything machine-checkable.
 */

/** npm advisory severities, ordered low -> critical by `severityRank`. */
export type AdvisorySeverity = "info" | "low" | "moderate" | "high" | "critical";

export interface AcceptedAdvisory {
  /**
   * The GHSA id, matched against the advisory URL `bun audit --json` reports.
   * For a non-GHSA advisory this is the full URL instead.
   */
  readonly ghsa: string;
  /** npm package name, exactly as `bun audit` keys it. */
  readonly package: string;
  /**
   * Severity at the time of acceptance. If the advisory is later re-scored
   * ABOVE this, the gate fails: the decision was made against the old score.
   */
  readonly severity: AdvisorySeverity;
  /** Why no upgrade resolves it — the state of the published version graph. */
  readonly noFixReason: string;
  /** Why the vulnerable code path cannot be reached, or what bounds the impact. */
  readonly reachability: string;
  /** The concrete event that would let this row be deleted. */
  readonly unblockedBy: string;
  /** ISO date (YYYY-MM-DD) the decision was made. */
  readonly acceptedOn: string;
  /** ISO date (YYYY-MM-DD) after which the gate fails until the row is re-judged. */
  readonly recheckBy: string;
  readonly owner: string;
}

/**
 * The longest an advisory may be accepted without being re-judged. One quarter,
 * matching `MANUAL_AUDIT_MAX_AGE_DAYS` in `scripts/release/credential-registry.ts`
 * so the two hygiene cadences cannot drift apart.
 */
export const MAX_ACCEPTANCE_DAYS = 92;

const OWNER = "@AsafGolombek";

export const ACCEPTED_ADVISORIES: readonly AcceptedAdvisory[] = [
  {
    ghsa: "GHSA-866g-f22w-33x8",
    package: "@ai-sdk/provider-utils",
    severity: "low",
    noFixReason:
      'No patched version exists and no override can reach this one. (1) The advisory range is `<=3.0.97` while the published 3.x line ends at 3.0.30 (npm dist-tag `ai-v5`) — GitHub lists the patched version as `None`. (2) The copy in the graph is pinned by @mastra/core under an npm ALIAS, `"@ai-sdk/provider-utils-v5": "npm:@ai-sdk/provider-utils@3.0.25"`, and root `overrides` cannot retarget an alias: with bun 1.3.14, regenerating bun.lock from scratch with either `"@ai-sdk/provider-utils": "4.0.40"` or `"@ai-sdk/provider-utils-v5": "npm:@ai-sdk/provider-utils@4.0.40"` still resolves the alias to 3.0.25 — the override is recorded in the lockfile and ignored by the resolver. (3) Upgrading @mastra/core does not help either: 1.54.0 (latest as of acceptance) still pins the v5 alias at 3.0.30, inside the range. Forcing the alias to 4.x would also collapse @mastra/core\'s deliberate AI-SDK-v5/v6 dual-pin.',
    reachability:
      "The advisory is CWE-400 in `createJsonResponseHandler` / `createJsonErrorResponseHandler` (`response-handler.ts`), which read a provider's HTTP response with an unbounded `await response.text()`. Neither is reached through the flagged package: @mastra/core@1.43.0 imports only `convertUint8ArrayToBase64`, `convertBase64ToUint8Array`, `isUrlSupported`, `injectJsonInstructionIntoMessages` and `isAbortError` from `@ai-sdk/provider-utils-v5`. It VENDORS its own copy of both response handlers into `dist/chunk-RTETZOAY.js`, a bundle that imports nothing from provider-utils. So bumping the npm package would be security theatre — it would clear the audit line without changing a byte of executing code. The residual risk is that vendored copy, which carries the identical unbounded read: triggering it needs the configured LLM provider endpoint (or a MITM of it) to return a hostile body, and the impact is availability of one single-user gateway process bound to 127.0.0.1. CVSS v3.1 4.3 / v4 2.1, A:L only — no confidentiality or integrity impact.",
    unblockedBy:
      "@mastra/core bounds the read in its VENDORED `createJsonResponseHandler` (that, not a dependency bump, is the real fix), or publishes a release whose `@ai-sdk/provider-utils-v5` alias resolves outside `<=3.0.97`. Read @mastra/core's `dependencies` field and re-grep `dist/chunk-*.js` for the vendored handler — do not judge this row on the version number alone.",
    acceptedOn: "2026-07-29",
    recheckBy: "2026-10-27",
    owner: OWNER,
  },
];
