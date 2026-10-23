import { emitAnnotation, getInput, inputEnvName } from "../../shared/gha-io.ts";
import { runCheck } from "./check.ts";
import { runSign, type SignOptions } from "./sign.ts";

export type Mode = "check" | "sign";

/** The `mode` input, refused unless it is exactly `check` or `sign`. */
export function parseMode(raw: string): Mode {
  if (raw === "check" || raw === "sign") return raw;
  throw new Error(`input "mode" must be "check" or "sign"; got ${JSON.stringify(raw)}`);
}

function requireInput(name: string): string {
  const v = getInput(name);
  if (v === "") throw new Error(`input "${name}" is required`);
  return v;
}

/**
 * Register `secret` with the runner's log masking (`::add-mask::`) before anything else touches it.
 * Each line is masked on its own too, since a multi-line value is masked line by line, and the
 * value is escaped with the runner's command encoding so a `%` in it cannot alter what is masked.
 */
export function maskSecret(
  secret: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
): void {
  const parts = new Set([secret, secret.trim(), ...secret.split(/[\r\n]+/).map((l) => l.trim())]);
  parts.delete("");
  for (const p of parts) {
    if (/[\r\n]/.test(p)) continue; // covered by its lines
    write(`::add-mask::${p.replaceAll("%", "%25")}\n`);
  }
}

/**
 * What `sign` runs with. The `default-branch` input is passed on when set; empty (an older
 * workflow, or none given) leaves `sign` to ask origin's HEAD, which is gh-pages when that branch
 * was pushed first to an empty repository.
 */
export function signOptions(
  workspace: string,
  rootKey: string,
  defaultBranch: string,
): SignOptions {
  return { workspace, rootKey, ...(defaultBranch !== "" && { defaultBranch }) };
}

function workspace(): string {
  return process.env["GITHUB_WORKSPACE"] ?? process.cwd();
}

export async function main(): Promise<void> {
  try {
    const mode = parseMode(getInput("mode"));
    if (mode === "check") {
      await runCheck({ workspace: workspace(), baseRef: process.env["GITHUB_BASE_REF"] ?? "" });
    } else {
      const rootKey = requireInput("root-key");
      maskSecret(rootKey);
      // Every git child inherits this process's environment: the key must not ride along.
      delete process.env[inputEnvName("root-key")];
      await runSign(signOptions(workspace(), rootKey, getInput("default-branch")));
    }
  } catch (err) {
    emitAnnotation("error", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Run only as the action entrypoint, so unit tests can import `parseMode` without running a mode.
if (import.meta.main) {
  await main();
}
