#!/usr/bin/env bun

export type InstallDecision =
  | { action: "install" }
  | { action: "noop" }
  | { action: "warn"; current: string };

export function decideHookInstall(current: string | null, force: boolean): InstallDecision {
  if (current === ".githooks") return { action: "noop" };
  if (current === null || current === "" || force) return { action: "install" };
  return { action: "warn", current };
}

async function gitConfigGet(key: string): Promise<string | null> {
  const p = Bun.spawn(["git", "config", "--local", "--get", key], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function main(): Promise<void> {
  const force = Bun.argv.slice(2).includes("--force");
  const current = await gitConfigGet("core.hooksPath");
  const decision = decideHookInstall(current, force);

  if (decision.action === "noop") {
    console.log("git hooks already installed (core.hooksPath=.githooks).");
    return;
  }
  if (decision.action === "warn") {
    console.error(
      `core.hooksPath is already set to "${decision.current}". Installing .githooks will ` +
        `supersede it AND any manual .git/hooks/ scripts. Re-run with --force to proceed:\n` +
        `  bun run hooks:install --force`,
    );
    process.exit(1);
  }
  const p = Bun.spawn(["git", "config", "--local", "core.hooksPath", ".githooks"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await p.exited) !== 0) process.exit(1);
  console.log(
    "Installed git hooks (core.hooksPath=.githooks). pre-commit blocks default-branch commits; pre-push runs preflight:fast.",
  );
}

if (import.meta.main) await main();
