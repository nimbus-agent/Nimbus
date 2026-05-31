#!/usr/bin/env bun
import { runCiTestSuite } from "./lib/ci-tests.ts";
import { assertWorkspaceInstalled, REPO_ROOT, run } from "./lib/root.ts";

const skipTests = process.argv.slice(2).includes("--skip-tests");

assertWorkspaceInstalled();
if (skipTests) {
  process.stdout.write("[build-release] --skip-tests: skipping CI test suite\n");
} else {
  await runCiTestSuite();
}
run(["bun", "run", "build"], REPO_ROOT);
