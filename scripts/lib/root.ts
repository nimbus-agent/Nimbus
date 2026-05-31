import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function assertWorkspaceInstalled(): void {
  if (existsSync(join(REPO_ROOT, "node_modules"))) return;
  process.stderr.write(
    "error: node_modules is missing. Run 'bun install' from the repo root before building.\n",
  );
  process.exit(1);
}

export type RunOptions = {
  env?: Record<string, string>;
};

export function run(cmd: readonly string[], cwd: string = REPO_ROOT, options?: RunOptions): void {
  const proc = Bun.spawnSync([...cmd], {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
    env: options?.env === undefined ? process.env : { ...process.env, ...options.env },
  });
  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode ?? 1);
  }
}
