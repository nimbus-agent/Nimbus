#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync } from "node:fs";
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

const MCP_ROOT = join(REPO_ROOT, "packages", "mcp-connectors");
const MCP_CONNECTORS: readonly { dir: string; outfileBase: string }[] = readdirSync(MCP_ROOT, {
  withFileTypes: true,
})
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((dir) => existsSync(join(MCP_ROOT, dir, "src", "server.ts")))
  .sort((a, b) => a.localeCompare(b))
  .map((dir) => ({ dir, outfileBase: `nimbus-mcp-${dir}` }));

for (const { dir } of MCP_CONNECTORS) {
  mkdirSync(join(REPO_ROOT, "packages/mcp-connectors", dir, "dist"), {
    recursive: true,
  });
}

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

for (const { dir, outfileBase } of MCP_CONNECTORS) {
  const pkgRoot = join(REPO_ROOT, "packages/mcp-connectors", dir);
  run(
    [
      "bun",
      "build",
      "src/server.ts",
      "--target",
      "bun",
      "--sourcemap=linked",
      "--outfile",
      `dist/${outfileBase}.js`,
    ],
    pkgRoot,
  );
}
