/**
 * Runs `git` or `gh` for `nimbus extension publish`: argv only (never a shell string), hidden on
 * Windows, stdin closed so neither tool can stop to prompt. A tool that cannot be started at all
 * (not on PATH, cwd gone) is reported as exit code 127, the shell's "command not found", so a
 * caller treats a missing `gh` as an ordinary failed run rather than a crash.
 */
export interface ToolResult {
  code: number;
  stdout: string;
  /** The same output as raw bytes, for content that must not be decoded (`git show <file>`). */
  stdoutBytes: Uint8Array;
  stderr: string;
}

export type RunTool = (
  cmd: "git" | "gh",
  args: string[],
  opts: { cwd: string },
) => Promise<ToolResult>;

export const TOOL_NOT_STARTED = 127;

export const runTool: RunTool = async (cmd, args, opts) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      // `git` must never open an editor or a credential prompt; `gh` must never prompt either.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
  } catch (e) {
    return {
      code: TOOL_NOT_STARTED,
      stdout: "",
      stdoutBytes: new Uint8Array(),
      stderr: `${cmd} could not be started: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const [stdoutBuffer, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  const stdoutBytes = new Uint8Array(stdoutBuffer);
  return { code, stdout: new TextDecoder().decode(stdoutBytes), stdoutBytes, stderr };
};
