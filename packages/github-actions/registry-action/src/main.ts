import { emitAnnotation, getInput } from "../../shared/gha-io.ts";
import { runCheck } from "./check.ts";
import { runSign } from "./sign.ts";

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

function workspace(): string {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

export async function main(): Promise<void> {
  try {
    const mode = parseMode(getInput("mode"));
    if (mode === "check") {
      await runCheck({ workspace: workspace(), baseRef: process.env.GITHUB_BASE_REF ?? "" });
    } else {
      await runSign({ workspace: workspace(), rootKey: requireInput("root-key") });
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
