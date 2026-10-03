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
 * Both advisory steps of `security.yml`'s required `Dependency audit` job read
 * this list. `audit:advisories` holds every live advisory to it. The blocking
 * `bun audit --audit-level high` step before it passes over a HIGH/CRITICAL
 * advisory only while that advisory's row here is open and well-formed, via
 * `advisory-ignore-args.ts`. There is no second list to keep in step: the day
 * after `recheckBy`, the row stops being passed to the blocking step, and that
 * step fails on the real advisory.
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

export const ACCEPTED_ADVISORIES: readonly AcceptedAdvisory[] = [
  // Two HIGH advisories that reached the npm advisory feed on 2026-10-02 with no patched release
  // anywhere in their version graphs, so the order of preference above stops at step 3 for both.
  // Each is reached only through tooling that never ships: markdownlint-cli2 (a root
  // devDependency) and astro (the private docs site's build). Each row carries the reachability
  // proof it rests on. The 30-day window is deliberately short (the cap is 92): an upstream fix is
  // most likely in the first weeks after disclosure, and the re-check should happen while one may
  // still be coming.
  //
  // History: the registry's only earlier row, `@ai-sdk/provider-utils` (GHSA-866g-f22w-33x8,
  // accepted 2026-07-29), was deleted when @mastra/core 1.64.0 met its unblocking condition (the
  // npm alias the row named had left bun.lock), per the retire rule above.
  {
    ghsa: "GHSA-vfj7-8cjw-p6xm",
    package: "braces",
    severity: "high",
    noFixReason:
      "No patched braces exists. The advisory (CVE-2026-93687, CVSS 7.5, CWE-674) covers <=3.0.3, 3.0.3 is the latest release, and GitHub lists no first patched version. Moving up the chain reaches no fix either: micromatch 4.0.8 (latest) requires braces ^3.0.3; fast-glob 3.3.3 (latest) requires micromatch ^4.0.8; globby 16.2.4 (latest) requires fast-glob ^3.3.3 and micromatch ^4.0.8; and markdownlint-cli2 0.23.3 (latest, already installed) pins globby 16.2.4 and micromatch 4.0.8 exactly. A root override has nothing to point at. Checked against the npm registry on 2026-10-03.",
    reachability:
      "Dev tooling only; nothing that ships contains it. `bun why braces`: the sole dependent is the root devDependency markdownlint-cli2 (directly through micromatch, and through globby > fast-glob > micromatch). `bun audit --production` does not report it, and no packages/* workspace depends on any package in that chain. The flaw is unbounded recursion while braces walks a deeply nested brace PATTERN. braces only expands glob patterns, never the paths or the Markdown matched against them, and markdownlint-cli2 takes patterns only from its argv and its config files (`globs`/`ignores`). `bun run lint:markdown`, locally and in docs-quality.yml, passes no globs, and .markdownlint-cli2.jsonc holds seven static globs with no brace expression in them. Worst case, a contributor commits a nested-brace glob there and crashes markdownlint in their own CI run, which costs one lint step's availability and exposes no data.",
    unblockedBy:
      "braces publishes a release outside <=3.0.3. A 3.x release satisfies micromatch's ^3.0.3, so a root `overrides` pin can take it the same day; a 4.x release needs micromatch to follow. markdownlint-cli2 dropping micromatch and globby would also clear it. Either way `bun audit` stops reporting it, and audit:advisories then fails on this row as stale until the row is deleted.",
    acceptedOn: "2026-10-03",
    recheckBy: "2026-11-02",
    owner: "asafgolombek",
  },
  {
    ghsa: "GHSA-ch52-4w7c-c8xp",
    package: "http-cache-semantics",
    severity: "high",
    noFixReason:
      "No patched http-cache-semantics exists. The advisory (CVE-2026-93748, CVSS 7.5, CWE-524) covers <=4.2.0, 4.2.0 is the latest release, and GitHub lists no first patched version. astro 7.3.5 (latest, already installed) requires ^4.2.0, and so do the 7.4.0-beta.0 and 7.4.0-beta.1 prereleases, so neither an astro upgrade nor a root override has anything to point at. Checked against the npm registry on 2026-10-03.",
    reachability:
      "Build-time only, inside the private docs site; nothing that ships contains it. `bun why http-cache-semantics`: the sole dependent is astro in the private @nimbus/docs workspace. It shows up under `bun audit --production` only because astro is a runtime dependency of that workspace; gateway, cli, ui and admin-console do not depend on astro. The only importer in the installed tree is astro/dist/assets/build/remote.js, the static build's remote-image cache, which builds a CachePolicy from a `new Request(src)` it constructs itself and calls only storable() and timeToLive(). The flaw is in the max-stale branch of evaluateRequest(), which satisfiesWithoutRevalidation() also goes through: a security-zeroed shared-cache entry gets served to ANOTHER client. astro calls neither method, and there is no shared multi-user cache and no attacker-supplied request. Our pages also use only local imported images and set no image.domains or remotePatterns, so the build never enters even that path. The site ships as static files: astro.config.mjs sets no `output`, and deploy-docs.yml uploads packages/docs/dist to GitHub Pages.",
    unblockedBy:
      "http-cache-semantics publishes a release outside <=4.2.0. A 4.x release satisfies astro's ^4.2.0, so a root `overrides` pin can take it the same day; a 5.x release needs astro to follow. astro dropping http-cache-semantics would also clear it. Either way `bun audit` stops reporting it, and audit:advisories then fails on this row as stale until the row is deleted.",
    acceptedOn: "2026-10-03",
    recheckBy: "2026-11-02",
    owner: "asafgolombek",
  },
];
