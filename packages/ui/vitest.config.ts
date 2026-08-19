import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // 10 s locally keeps a genuine hang loud and fast. CI gets 30 s because a
    // jsdom worker on the 4-core Windows runner can lose whole seconds of
    // wall-clock to scheduling: run 32230537776 timed
    // `AuditPanel > renders summary and one row per fetched entry` out after a
    // reported 15222 ms, a test that takes ~700 ms on a green run of the same
    // job. The overshoot is the tell — vitest's own 10 s timeout timer fired
    // 5.2 s LATE, which a blocked event loop cannot do, so the worker was
    // starved rather than stuck. Every RTL wait in that test is internally
    // bounded to ~1 s (`asyncUtilTimeout`), so the test body cannot legitimately
    // consume 10 s and no product code was involved. This mirrors the 60 s
    // `--timeout` the Bun half of the same CI job already runs with.
    testTimeout: ci ? 30_000 : 10_000,
    // Retry once on CI only, for the residual outlier that even 30 s misses.
    // Same rationale — and the same "retry once" shape — as the
    // "Unit tests (with coverage) — macOS/Windows (retry once)" step in
    // `.github/workflows/_test-suite.yml`. A test that fails BOTH attempts
    // still fails the job, so this hides no genuine breakage; local runs keep
    // `retry: 0` so a newly-flaky test is visible the moment it is written.
    retry: ci ? 1 : 0,
    reporters: ci
      ? ["default", ["junit", { outputFile: "../../junit-reports/junit-vitest.xml" }]]
      : ["default"],
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "**/*.vitest.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/test/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      exclude: ["src/test-setup.ts", "**/*.d.ts", "dist/**", "**/test/e2e/**"],
    },
  },
});
