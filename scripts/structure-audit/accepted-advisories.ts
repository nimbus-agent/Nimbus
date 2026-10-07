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
  /**
   * ISO date (YYYY-MM-DD) the decision was made. Never after today, beyond one day of slack for an
   * author whose local date is already tomorrow in UTC: the window cap counts from here, so a
   * future date would keep the row open past `MAX_ACCEPTANCE_DAYS`, and both gates refuse it.
   */
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
      "Dev tooling only; nothing that ships contains it. `bun why braces`: the sole dependent is the root devDependency markdownlint-cli2, through micromatch by three routes (directly, globby > micromatch, and globby > fast-glob > micromatch). `bun audit --production` does not report it, and no packages/* workspace depends on any package in that chain. The flaw is unbounded recursion while braces walks a deeply nested brace PATTERN. braces only expands glob patterns, never the paths or the Markdown matched against them, and markdownlint-cli2 takes patterns only from its argv and its config files (`globs`/`ignores`). `bun run lint:markdown`, locally and in docs-quality.yml, passes no globs, and .markdownlint-cli2.jsonc holds seven static globs with no brace expression in them. Worst case, a contributor commits a nested-brace glob there and crashes markdownlint in their own CI run, which costs one lint step's availability and exposes no data.",
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
  // Three LOW/MODERATE advisories surfaced on 2026-10-07, once the @modelcontextprotocol/client
  // override cleared the HIGH that had been failing `bun audit` and hiding this gate. A fourth from
  // the same batch, smol-toml GHSA-r4xh-jqrq-34v2, was fixed instead: 1.9.0 is published and a root
  // override took it. Each of the three below has a fixed release that no installed dependent
  // accepts, or no fixed release at all, so step 1 above has nothing to point at.
  {
    ghsa: "GHSA-238p-pmpm-9mq7",
    package: "katex",
    severity: "low",
    noFixReason:
      "The fix is katex 0.18.2, outside every installed dependent's range. The advisory (CWE-807) covers >=0.11.0 <0.18.2 and 0.16.47 is installed. The only dependent, micromark-extension-math 3.1.0 (latest), requires katex ^0.16.0, which a 0.x minor bump leaves; markdownlint 0.41.1 (latest) pins micromark-extension-math 3.1.0 exactly, and markdownlint-cli2 0.23.3 (latest, already installed) pins markdownlint 0.41.1 exactly. An override to 0.18.x would force a breaking 0.x minor under a library that declares it does not support it. Checked against the npm registry on 2026-10-07.",
    reachability:
      "Dev tooling only; nothing that ships contains it. `bun pm why katex`: the sole chain is the root devDependency markdownlint-cli2 > markdownlint > micromark-extension-math. No packages/* workspace depends on it, `bun audit --production` does not report it, and neither the compiled gateway nor the CLI binary contains the katex library. The flaw lets an ALREADY-EXISTING prototype pollution bypass katex's `trust` restriction when it renders math. markdownlint only parses Markdown to lint it, over the repository's own committed docs, and renders nothing for anyone; the input is our own files, not an attacker's.",
    unblockedBy:
      "micromark-extension-math, or markdownlint replacing it, accepts katex >=0.18.2, and markdownlint-cli2 ships a release that takes it. A root `overrides` pin can then follow. Either way `bun audit` stops reporting it, and audit:advisories then fails on this row as stale until the row is deleted.",
    acceptedOn: "2026-10-07",
    recheckBy: "2026-11-02",
    owner: "asafgolombek",
  },
  {
    ghsa: "GHSA-rj75-hqrm-r3gf",
    package: "postcss-selector-parser",
    severity: "moderate",
    noFixReason:
      "The fix is postcss-selector-parser 7.1.6, a major above what its dependent accepts. The advisory (CVSS 5.9, CWE-400/CWE-407) covers <7.1.6 and 6.1.4 is installed. The only dependent, postcss-nested 6.2.0, requires ^6.1.1; postcss-nested 8.0.1 does take ^7.1.4, but @expressive-code/core 0.44.2 (latest) requires postcss-nested ^6.0.1, and astro-expressive-code 0.44.2 and @astrojs/starlight 0.42.5 (both latest, already installed) sit above that. Overriding across a major under every one of them is a breaking change in a library none of them declares support for. Checked against the npm registry on 2026-10-07.",
    reachability:
      "Build-time only, inside the private docs site; nothing that ships contains it. `bun pm why postcss-selector-parser`: the sole chain is @nimbus/docs > @astrojs/starlight > astro-expressive-code > @expressive-code/core > postcss-nested. It shows up under `bun audit --production` only because starlight is a runtime dependency of that private workspace; gateway, cli, ui and admin-console do not depend on it, and neither compiled binary contains it. The flaw is quadratic CPU on a crafted flat selector. It runs only while the static docs build processes expressive-code's own theme CSS, which is fixed library input, not attacker input; the worst case is a slow docs build. The site ships as static files to GitHub Pages and the parser does not ship with it.",
    unblockedBy:
      "@expressive-code/core moves to postcss-nested 7+ or 8 (which take postcss-selector-parser ^7), and astro-expressive-code / @astrojs/starlight release with it. Either way `bun audit` stops reporting it, and audit:advisories then fails on this row as stale until the row is deleted.",
    acceptedOn: "2026-10-07",
    recheckBy: "2026-11-02",
    owner: "asafgolombek",
  },
  {
    ghsa: "GHSA-hp3w-g68c-fv3c",
    package: "sprintf-js",
    severity: "moderate",
    noFixReason:
      "No patched sprintf-js exists. The advisory (CVSS 5.3, CWE-1284) covers <=1.1.3, 1.1.3 is the latest release, and GitHub lists no first patched version. The installed 1.0.3 comes from argparse 1.0.10 (latest 1.x, requires ~1.0.2), from js-yaml 3.15.2 (latest 3.x, requires argparse ^1.0.7). js-yaml 4 dropped sprintf-js, but gray-matter 4.0.3 (latest) requires js-yaml ^3.13.1. A root override has nothing to point at. Checked against the npm registry on 2026-10-07.",
    reachability:
      "In the dependency GRAPH of a runtime package, but not in any shipped code path. `bun pm why sprintf-js` gives two chains: the root devDependency babel-plugin-istanbul > @istanbuljs/load-nyc-config > js-yaml 3, and the gateway's RUNTIME dependency @mastra/core 1.74.0 > gray-matter 4.0.3 > js-yaml 3.15.2 > argparse > sprintf-js. The second chain is why this row is not 'dev tooling only'. js-yaml 3 requires argparse only from its CLI entry point (bin/js-yaml.js); index.js and lib/ never import it, and gray-matter imports only the library. So the bundler never reaches argparse or sprintf-js: the compiled gateway binary built from this tree on 2026-10-07 contains no `sprintf-js`, `argparse` or `sprintf_format` string, and `bun audit --production` does not report it. The flaw is a denial of service through an unbounded precision specifier in a FORMAT string, which only argparse's own help/usage formatting would supply.",
    unblockedBy:
      "sprintf-js publishes a release outside <=1.1.3 (that is, newer than 1.1.3; a 1.0.x release would still be inside the vulnerable range), AND argparse can take it. Today argparse requires ~1.0.2, which a release newer than 1.1.3 does not satisfy, so one of these must also happen: argparse relaxes its range, js-yaml/gray-matter move off argparse 1.x, or a root `overrides` pin to the patched release proves compatible. Alternatively, gray-matter moves to js-yaml 4, or @mastra/core drops gray-matter. In every case `bun audit` stops reporting it, and audit:advisories then fails on this row as stale until the row is deleted.",
    acceptedOn: "2026-10-07",
    recheckBy: "2026-11-02",
    owner: "asafgolombek",
  },
];
