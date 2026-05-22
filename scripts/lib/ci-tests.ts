/**
 * CI-parity test sequence (see `.github/workflows/_test-suite.yml` test steps).
 * On Linux, unit+coverage and vault coverage run via `scripts/ci/run-with-optional-dbus.sh` when
 * `dbus-run-session` is available (D-Bus session + Secret Service for secret-tool tests).
 */
import { join } from "node:path";

import { REPO_ROOT, run } from "./root.ts";

const DBUS_WRAPPER = join(REPO_ROOT, "scripts", "ci", "run-with-optional-dbus.sh");

const CI_ENV = { env: { CI: "true" as const } };

function dbusAvailable(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  const w = Bun.spawnSync(["which", "dbus-run-session"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return w.exitCode === 0;
}

function sleepFiveSeconds(): void {
  Bun.spawnSync(
    process.platform === "win32"
      ? ["powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 5"]
      : ["sleep", "5"],
    { stdout: "ignore", stderr: "ignore" },
  );
}

/** Run a bun test command, wrapping with dbus-run-session on Linux when available. */
function runBunTest(args: readonly string[], wrapDbus: boolean): void {
  const cmd = ["bun", "test", ...args];
  if (wrapDbus && process.platform === "linux" && dbusAvailable()) {
    run(["bash", DBUS_WRAPPER, ...cmd], REPO_ROOT, CI_ENV);
  } else {
    run(cmd, REPO_ROOT, CI_ENV);
  }
}

/** Unit tests + overall coverage — matches the "Unit tests" CI step exactly. */
function runInitialUnitTestsWithCoverage(): void {
  const args = [
    "packages/gateway",
    "packages/cli",
    "packages/sdk",
    "packages/client",
    "packages/mcp-connectors",
    "scripts",
    "--coverage",
  ];

  const runOnce = (): number => {
    const cmd = ["bun", "test", ...args];
    if (process.platform === "linux" && dbusAvailable()) {
      const p = Bun.spawnSync(["bash", DBUS_WRAPPER, ...cmd], {
        cwd: REPO_ROOT,
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...process.env, ...CI_ENV.env },
      });
      return p.exitCode ?? 1;
    }
    const p = Bun.spawnSync(cmd, {
      cwd: REPO_ROOT,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, ...CI_ENV.env },
    });
    return p.exitCode ?? 1;
  };

  if (process.platform === "linux") {
    const code = runOnce();
    if (code !== 0) process.exit(code);
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const code = runOnce();
    if (code === 0) return;
    if (attempt === 2) process.exit(code);
    process.stderr.write(`Attempt ${String(attempt)} failed, retrying in 5 s...\n`);
    sleepFiveSeconds();
  }
}

/**
 * Run all coverage gates in sequence.
 * Each maps 1-to-1 to an entry in the `coverage-gates` matrix in `_test-suite.yml`.
 */
function runCoverageGates(): void {
  const gates: Array<{ script: string; dbus?: boolean }> = [
    { script: "test:coverage:engine" },
    { script: "test:coverage:agents" },
    { script: "test:coverage:vault", dbus: true },
    { script: "test:coverage:sync" },
    { script: "test:coverage:rate-limiter" },
    { script: "test:coverage:people" },
    { script: "test:coverage:embedding" },
    { script: "test:coverage:workflow" },
    { script: "test:coverage:watcher" },
    { script: "test:coverage:extensions" },
    { script: "test:coverage:config" },
    { script: "test:coverage:client" },
    { script: "test:coverage:telemetry" },
    { script: "test:coverage:db" },
    { script: "test:coverage:deployment" },
    { script: "test:coverage:health" },
    { script: "test:coverage:metrics" },
    { script: "test:coverage:preflight" },
    { script: "test:coverage:doctor" },
    { script: "test:coverage:tui" },
    { script: "test:coverage:mcp" },
    { script: "test:coverage:updater" },
    { script: "test:coverage:lan" },
    { script: "test:coverage:perf" },
    { script: "test:coverage:sdk" },
    { script: "test:coverage:security" },
  ];

  for (const { script, dbus } of gates) {
    if (dbus && process.platform === "linux" && dbusAvailable()) {
      run(["bash", DBUS_WRAPPER, "bun", "run", script], REPO_ROOT, CI_ENV);
    } else {
      run(["bun", "run", script], REPO_ROOT, CI_ENV);
    }
  }
}

/** Run the same test steps as `_test-suite.yml` (typecheck, lint, build, tests, coverage gates, integration, e2e, UI). */
export async function runCiTestSuite(): Promise<void> {
  // Required before Typecheck — vscode-extension imports @nimbus-dev/client
  // whose exports field points at dist/index.d.ts. Without an explicit build
  // the workspace symlink resolves but the type declarations don't exist.
  // Mirrors the "Build @nimbus-dev/client (for vscode-extension typecheck)"
  // step in `_test-suite.yml`.
  run(["bun", "run", "build"], join(REPO_ROOT, "packages", "client"));

  run(["bun", "run", "typecheck"], REPO_ROOT);
  run(["bun", "run", "lint"], REPO_ROOT);
  run(["bun", "run", "build"], REPO_ROOT);

  runInitialUnitTestsWithCoverage();
  runCoverageGates();

  runBunTest(["packages/gateway/test/integration/", "packages/cli/test/integration/"], false);
  runBunTest(["packages/gateway/test/e2e/"], false);
  runBunTest(["packages/cli/test/e2e/"], false);

  // UI tests under Vitest: locally we run WITHOUT --coverage because
  // @vitest/coverage-v8 calls Node's `inspector.Session.post("Profiler.startPreciseCoverage")`,
  // which Bun does not implement on every host (Windows hosts in particular emit
  // "Error: Coverage APIs are not supported"). The threshold is still enforced in CI by
  // `_test-suite.yml`'s "UI unit coverage" step on the Linux runner — keeping local runs
  // clean here means contributors can actually trust `bun run test:ci` to exit 0 on a
  // green tree, instead of learning to ignore a chronic non-zero exit.
  run(["bun", "run", "--filter", "@nimbus/ui", "test"], REPO_ROOT, CI_ENV);
}
