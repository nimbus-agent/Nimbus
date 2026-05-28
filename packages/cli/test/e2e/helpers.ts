import { fileURLToPath } from "node:url";

export type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const CLI_ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

export async function runCli(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode };
}
