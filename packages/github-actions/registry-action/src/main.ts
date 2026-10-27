import { emitAnnotation, getInput, inputEnvName } from "../../shared/gha-io.ts";
import { runCheck } from "./check.ts";
import { runSign, type SignOptions } from "./sign.ts";
import { runTrustCheck } from "./trust-check.ts";
import { runTrustSign } from "./trust-sign.ts";

export type Mode = "check" | "sign" | "trust-check" | "trust-sign";

const MODES: readonly Mode[] = ["check", "sign", "trust-check", "trust-sign"];

/** The `mode` input, refused unless it is exactly one of `MODES`. */
export function parseMode(raw: string): Mode {
  const mode = MODES.find((m) => m === raw);
  if (mode !== undefined) return mode;
  throw new Error(
    `input "mode" must be "check", "sign", "trust-check" or "trust-sign"; got ${JSON.stringify(raw)}`,
  );
}

/** The `root-key` input, masked and dropped from the environment before anything else runs. */
function takeRootKey(): string {
  const rootKey = requireInput("root-key");
  maskSecret(rootKey);
  // Every git child inherits this process's environment: the key must not ride along.
  delete process.env[inputEnvName("root-key")];
  return rootKey;
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
 * was pushed first to an empty repository. `repository` (`GITHUB_REPOSITORY`) is passed on when
 * set; the caller reads it, so this stays a pure function of its arguments.
 */
export function signOptions(
  workspace: string,
  rootKey: string,
  defaultBranch: string,
  repository: string | undefined,
): SignOptions {
  return {
    workspace,
    rootKey,
    ...(defaultBranch !== "" && { defaultBranch }),
    ...(repository !== undefined && repository !== "" && { repository }),
  };
}

/**
 * The optional `github-token` input (provenance: `gh attestation verify` fetches with it), masked
 * and dropped from the environment like the root key; empty means no provenance is verified.
 */
function takeGithubToken(): string {
  const token = getInput("github-token");
  if (token !== "") maskSecret(token);
  delete process.env[inputEnvName("github-token")];
  return token;
}

function workspace(): string {
  return process.env["GITHUB_WORKSPACE"] ?? process.cwd();
}

export async function main(): Promise<void> {
  try {
    const mode = parseMode(getInput("mode"));
    const baseRef = process.env["GITHUB_BASE_REF"] ?? "";
    if (mode === "check") {
      await runCheck({ workspace: workspace(), baseRef, githubToken: takeGithubToken() });
    } else if (mode === "trust-check") {
      await runTrustCheck({ workspace: workspace(), baseRef });
    } else if (mode === "trust-sign") {
      const rootKey = takeRootKey();
      const defaultBranch = getInput("default-branch");
      await runTrustSign({
        workspace: workspace(),
        rootKey,
        ...(defaultBranch !== "" && { defaultBranch }),
      });
    } else {
      const rootKey = takeRootKey();
      const githubToken = takeGithubToken();
      await runSign({
        ...signOptions(
          workspace(),
          rootKey,
          getInput("default-branch"),
          process.env["GITHUB_REPOSITORY"],
        ),
        githubToken,
      });
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
