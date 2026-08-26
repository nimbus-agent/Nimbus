#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCiTestSuite } from "./lib/ci-tests.ts";
import { assertWorkspaceInstalled, REPO_ROOT, run } from "./lib/root.ts";

const skipTests = process.argv.slice(2).includes("--skip-tests");

assertWorkspaceInstalled();
if (skipTests) {
  process.stdout.write("[build-debug] --skip-tests: skipping CI test suite\n");
} else {
  await runCiTestSuite();
}

mkdirSync(join(REPO_ROOT, "dist"), { recursive: true });
mkdirSync(join(REPO_ROOT, "packages/cli/dist"), { recursive: true });

// The connectors used to be built here, one debug bundle each. They ship from
// @nimbus-dev/connectors now and are bundled into the gateway binary by the
// compiled build, so a debug build of this repo has nothing connector-shaped to
// produce.

run([
  "bun",
  "build",
  "packages/gateway/src/index.ts",
  "--target",
  "bun",
  "--sourcemap=linked",
  "--outfile",
  "dist/nimbus-gateway.js",
]);

run([
  "bun",
  "build",
  "packages/cli/src/index.ts",
  "--target",
  "bun",
  "--sourcemap=linked",
  "--outfile",
  "packages/cli/dist/nimbus.js",
]);

run(["bunx", "vite", "build", "--mode", "development"], join(REPO_ROOT, "packages/ui"));
