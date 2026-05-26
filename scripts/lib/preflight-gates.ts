/**
 * Single source of truth for what `bun run preflight[:fast]` executes.
 * The drift test (scripts/preflight.test.ts) asserts every `bun run`/`bunx`
 * gate referenced in .github/workflows/ appears here or in CI_ONLY_GATES.
 */

export type GateTier = "fast" | "full";

export interface Gate {
  /** Human label shown in the summary. */
  readonly name: string;
  /** argv executed via Bun.spawn (no shell). */
  readonly cmd: readonly string[];
  /** "fast" = cheap static; "full" = heavy (also runs in full tier). */
  readonly tier: GateTier;
  /** Report failure but do not fail the run. Default false. */
  readonly soft?: boolean;
}

/** Fast tier — cheap static gates, ~2-3 min, no full test run. */
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
  { name: "audit:exclusion-parity", cmd: ["bun", "run", "audit:exclusion-parity"], tier: "fast" },
  // jscpd flags mirror ci.yml's duplication job exactly (keep in sync).
  {
    name: "duplication (jscpd)",
    cmd: [
      "bunx",
      "jscpd",
      "--min-lines",
      "10",
      "--min-tokens",
      "50",
      "--threshold",
      "5",
      "--reporters",
      "console",
      "-i",
      "**/node_modules/**,**/*.test.ts,**/*.test.tsx,**/*.vitest.tsx",
      "packages/",
    ],
    tier: "fast",
  },
];

/** Full tier — heavy: build + full suite + coverage floor (needs lcov from the run). */
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

/**
 * Workflow `bun run`/`bunx` invocations that CI runs but preflight intentionally
 * does NOT (external services, packaging, publish, slow benches). The drift test
 * requires every workflow gate to be here OR in PREFLIGHT_GATES.
 */
export const CI_ONLY_GATES: readonly string[] = [
  "test:scripts", // run by `bun test scripts` separately
  "audit:coverage-floor:build-lcov", // composed into the full-tier gate above
  "package:headless",
  "package:installers:linux",
  "docs:build",
  "tauri", // bunx tauri build — desktop app build (needs Rust); not part of local static/test parity
  "playwright", // bunx playwright install — E2E desktop browsers; E2E desktop runs on push-to-main only
  "render:og-card", // OG-card PNG render check — doc-asset generation, regenerated + committed separately
  "record-casts", // asciinema cast recording check — doc-asset generation, regenerated separately
  "test", // `bun run test` (publish-vscode) — VS Code extension's own test suite, run in the publish workflow
  "vsce", // bunx vsce — VS Code Marketplace publish tooling
  "ovsx", // bunx ovsx — Open VSX publish tooling
  "regen-slo:check", // SLO doc regeneration check — doc-gen check run separately, not a code gate
  "build:sandbox-helper", // make native C helper — platform-specific (Linux) native build, not a portable gate
  "vitest", // bunx vitest — UI component tests (packages/ui), run via the separate Vitest runner
];

/** Pure: fast → [fast...]; full → [fast..., full...]. */
export function selectGates(tier: GateTier): Gate[] {
  if (tier === "fast") return PREFLIGHT_GATES.filter((g) => g.tier === "fast");
  return [...PREFLIGHT_GATES];
}
