import { nimbusSpawn } from "./nimbus-spawn.ts";

export type RunCliJsonResult = { ok: true; data: unknown } | { ok: false; message: string };

export async function runCliOk(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (command.length === 0) {
    return { ok: false, message: "empty command" };
  }
  const { code, stderr: err } = await nimbusSpawn(command, env);
  if (code !== 0) {
    return {
      ok: false,
      message: `${command[0] ?? "cli"} exited ${String(code)}: ${err.slice(0, 500)}`,
    };
  }
  return { ok: true };
}

export async function runCliOkThrowing(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<void> {
  const r = await runCliOk(command, env);
  if (!r.ok) {
    throw new Error(r.message);
  }
}

export async function runCliJson(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<RunCliJsonResult> {
  if (command.length === 0) {
    return { ok: false, message: "empty command" };
  }
  const { code, stdout: out, stderr: err } = await nimbusSpawn(command, env);
  if (code !== 0) {
    return {
      ok: false,
      message: `${command[0] ?? "cli"} exited ${String(code)}: ${err.slice(0, 500)}`,
    };
  }
  const trimmed = out.trim();
  if (trimmed === "") {
    return { ok: true, data: null };
  }
  try {
    return { ok: true, data: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false, message: `invalid JSON from CLI: ${out.slice(0, 200)}` };
  }
}
