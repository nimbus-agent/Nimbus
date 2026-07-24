export type GateTier = "fast" | "full";

export interface Gate {
  readonly name: string;
  readonly cmd: readonly string[];
  readonly tier: GateTier;
  readonly soft?: boolean;
}

const FAST: readonly Gate[] = [
  { name: "typecheck", cmd: ["bun", "run", "typecheck"], tier: "fast" },
  { name: "lint (biome)", cmd: ["bun", "run", "lint"], tier: "fast" },
  { name: "lint:markdown", cmd: ["bun", "run", "lint:markdown"], tier: "fast" },
  { name: "audit:doc-refs", cmd: ["bun", "run", "audit:doc-refs"], tier: "fast" },
  { name: "audit:openapi-drift", cmd: ["bun", "run", "audit:openapi-drift"], tier: "fast" },
  { name: "audit:boundaries", cmd: ["bun", "run", "audit:boundaries"], tier: "fast" },
  { name: "audit:invariants", cmd: ["bun", "run", "audit:invariants"], tier: "fast" },
  { name: "audit:any", cmd: ["bun", "run", "audit:any", "--check"], tier: "fast" },
  { name: "audit:release-please", cmd: ["bun", "run", "audit:release-please"], tier: "fast" },
  { name: "audit:js-licenses", cmd: ["bun", "run", "audit:js-licenses"], tier: "fast" },
  { name: "audit:svg-assets", cmd: ["bun", "run", "audit:svg-assets"], tier: "fast" },
  { name: "audit:readme-cli", cmd: ["bun", "run", "audit:readme-cli"], tier: "fast" },
  { name: "audit:package-readmes", cmd: ["bun", "run", "audit:package-readmes"], tier: "fast" },
  { name: "audit:cross-platform", cmd: ["bun", "run", "audit:cross-platform"], tier: "fast" },
  { name: "audit:status-drift", cmd: ["bun", "run", "audit:status-drift"], tier: "fast" },
  { name: "audit:action-sha-pins", cmd: ["bun", "run", "audit:action-sha-pins"], tier: "fast" },
  { name: "audit:consumed-by", cmd: ["bun", "run", "audit:consumed-by"], tier: "fast" },
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
];

export function selectGates(tier: GateTier): Gate[] {
  if (tier === "fast") return PREFLIGHT_GATES.filter((g) => g.tier === "fast");
  return [...PREFLIGHT_GATES];
}
