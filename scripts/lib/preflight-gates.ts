export type GateTier = "fast" | "full";

export interface Gate {
  readonly name: string;
  readonly cmd: readonly string[];
  readonly tier: GateTier;
  readonly soft?: boolean;
}

const FAST: readonly Gate[] = [
  { name: "typecheck", cmd: ["bun", "run", "typecheck"], tier: "fast" },
  {
    // Test directories are NOT in any package's tsconfig `include`, so `typecheck` is blind to
    // them: in #1038 five ToolExecutor call sites broke and `bun run typecheck` still exited 0.
    // Gated against a committed baseline of pre-existing debt; only NEW errors fail.
    name: "typecheck:tests",
    cmd: ["bun", "run", "typecheck:tests"],
    tier: "fast",
  },
  { name: "lint (biome)", cmd: ["bun", "run", "lint"], tier: "fast" },
  { name: "lint:markdown", cmd: ["bun", "run", "lint:markdown"], tier: "fast" },
  { name: "audit:doc-refs", cmd: ["bun", "run", "audit:doc-refs"], tier: "fast" },
  { name: "audit:openapi-drift", cmd: ["bun", "run", "audit:openapi-drift"], tier: "fast" },
  { name: "audit:boundaries", cmd: ["bun", "run", "audit:boundaries"], tier: "fast" },
  { name: "audit:invariants", cmd: ["bun", "run", "audit:invariants"], tier: "fast" },
  { name: "audit:any", cmd: ["bun", "run", "audit:any", "--check"], tier: "fast" },
  { name: "audit:release-please", cmd: ["bun", "run", "audit:release-please"], tier: "fast" },
  {
    // A root `overrides` pin outranks every declared range, so a divergence
    // between the two is invisible: the Dependabot PR that bumps the declared
    // range merges green and changes nothing in the installed tree. Offline and
    // instant (pure manifest reads), so it belongs in the FAST tier.
    name: "audit:override-drift",
    cmd: ["bun", "run", "audit:override-drift"],
    tier: "fast",
  },
  { name: "audit:js-licenses", cmd: ["bun", "run", "audit:js-licenses"], tier: "fast" },
  { name: "audit:svg-assets", cmd: ["bun", "run", "audit:svg-assets"], tier: "fast" },
  { name: "audit:readme-cli", cmd: ["bun", "run", "audit:readme-cli"], tier: "fast" },
  { name: "audit:package-readmes", cmd: ["bun", "run", "audit:package-readmes"], tier: "fast" },
  { name: "audit:cross-platform", cmd: ["bun", "run", "audit:cross-platform"], tier: "fast" },
  { name: "audit:status-drift", cmd: ["bun", "run", "audit:status-drift"], tier: "fast" },
  { name: "audit:action-sha-pins", cmd: ["bun", "run", "audit:action-sha-pins"], tier: "fast" },
  {
    name: "audit:workflow-run-triggers",
    cmd: ["bun", "run", "audit:workflow-run-triggers"],
    tier: "fast",
  },
  {
    // An invalid workflow file is uniquely expensive to diagnose: GitHub
    // records a run with ZERO jobs and a failure conclusion, so there is no
    // log or annotation to read. Catch it before the push, not after.
    name: "audit:workflow-lint",
    cmd: ["bun", "run", "audit:workflow-lint"],
    tier: "fast",
  },
  {
    name: "audit:coverage-gate-pal",
    cmd: ["bun", "run", "audit:coverage-gate-pal"],
    tier: "fast",
  },
  { name: "audit:consumed-by", cmd: ["bun", "run", "audit:consumed-by"], tier: "fast" },
  { name: "audit:secret-inventory", cmd: ["bun", "run", "audit:secret-inventory"], tier: "fast" },
  { name: "audit:exclusion-parity", cmd: ["bun", "run", "audit:exclusion-parity"], tier: "fast" },
  {
    // Reads .jscpd.json (min-lines 5 / min-tokens 50 / threshold ratchet / shared
    // ignore) so preflight and CI measure identically — matches the ci.yml
    // pr-quality-duplication step verbatim.
    name: "duplication (jscpd)",
    cmd: ["bunx", "jscpd", "packages"],
    tier: "fast",
  },
];

const FULL: readonly Gate[] = [
  { name: "build", cmd: ["bun", "run", "build"], tier: "full" },
  { name: "test:ci (suite + coverage)", cmd: ["bun", "run", "test:ci"], tier: "full" },
  {
    name: "coverage-floor: build lcov",
    cmd: ["bun", "run", "audit:coverage-floor:build-lcov"],
    tier: "full",
  },
  { name: "audit:coverage-floor", cmd: ["bun", "run", "audit:coverage-floor"], tier: "full" },
];

export const PREFLIGHT_GATES: readonly Gate[] = [...FAST, ...FULL];

export const CI_ONLY_GATES: readonly string[] = [
  "typecheck:no-docs", // per-OS matrix de-flake: docs excluded there; full typecheck (incl. docs) is the local gate + ubuntu _test-suite.yml
  "test:scripts", // run by `bun test scripts` separately
  "audit:coverage-floor:build-lcov", // composed into the full-tier gate above
  "package:headless", // headless gateway+CLI bundle — packaging step, not a local correctness gate
  "package:installers:linux", // Linux .deb/tarball build — packaging step, not a local correctness gate
  "docs:build", // Astro Starlight docs site build — run via workspace filter in CI, not a code gate
  "tauri", // bunx tauri build — desktop app build (needs Rust); not part of local static/test parity
  "playwright", // bunx playwright install — E2E desktop browsers; E2E desktop runs on push-to-main only
  "render:og-card", // OG-card PNG render check — doc-asset generation, regenerated + committed separately
  "record-casts", // asciinema cast recording check — doc-asset generation, regenerated separately
  "regen-slo:check", // SLO doc regeneration check — doc-gen check run separately, not a code gate
  "build:sandbox-helper", // make native C helper — platform-specific (Linux) native build, not a portable gate
  "vitest", // bunx vitest — UI component tests (packages/ui), run via the separate Vitest runner
  "audit:ruleset-drift", // needs network + gh auth + org-read; runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:org-settings-drift", // needs network + gh auth + org-read; runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:team-reachability", // needs network + gh auth + org-read; runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:cla-coverage", // needs network + gh (reads each public repo's cla.yml, contents:read); runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:review-coverage", // needs network + gh (reads each public repo's .coderabbit.yaml, contents:read); runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:pin-freshness", // needs network + gh (release + tag reads per pinned action); runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:ci-latency", // needs network + gh (Actions API across 9 repos); runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:ci-latency:update-baseline", // explicit human action that rewrites the committed baseline; never a gate
  "audit:release-staleness", // needs network + gh (public reads across release + channel repos); runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:actions-allowlist", // needs network + gh (reads each repo's Actions permissions); runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:advisories", // needs network (npm registry via `bun audit`); runs beside `bun audit` in security.yml, never the local FAST tier
  "audit:bypass-actors", // needs an OWNER gh token (admin:org) — the CI App token cannot read bypass_actors; an explicit human action, never a gate
  "audit:bypass-attestation", // local + deterministic, but its red depends on the OWNER's re-attestation cadence; sweep-only so a stale attestation never blocks a contributor's PR
];

export function selectGates(tier: GateTier): Gate[] {
  if (tier === "fast") return PREFLIGHT_GATES.filter((g) => g.tier === "fast");
  return [...PREFLIGHT_GATES];
}
