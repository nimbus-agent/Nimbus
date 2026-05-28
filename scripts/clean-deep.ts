#!/usr/bin/env bun
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, run } from "./lib/root.ts";

interface RootPackageJson {
  workspaces?: string[];
}

function readWorkspaces(): readonly string[] {
  const raw = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as RootPackageJson;
  if (!Array.isArray(pkg.workspaces) || pkg.workspaces.length === 0) {
    throw new Error("Root package.json has no `workspaces` array — refusing to deep-clean.");
  }
  for (const w of pkg.workspaces) {
    if (w.includes("*")) {
      throw new Error(
        `Workspace entry "${w}" contains a glob; clean-deep does not expand globs. ` +
          "Replace with explicit paths or extend this script to use bun's workspace resolver.",
      );
    }
  }
  return pkg.workspaces;
}

process.stdout.write("--- Nimbus Deep Clean ---\n");

process.stdout.write("Running bun run clean...\n");
run(["bun", "run", "clean"], REPO_ROOT);

process.stdout.write("Removing root node_modules and bun.lock...\n");
rmSync(join(REPO_ROOT, "node_modules"), { recursive: true, force: true });
rmSync(join(REPO_ROOT, "bun.lock"), { force: true });

const packages = readWorkspaces();
for (const pkg of packages) {
  const pkgDir = join(REPO_ROOT, pkg, "node_modules");
  process.stdout.write(`Removing ${pkg}/node_modules...\n`);
  rmSync(pkgDir, { recursive: true, force: true });
}

process.stdout.write("\nDone. Run `bun install` to restore dependencies.\n");
process.stdout.write("-------------------------\n");
