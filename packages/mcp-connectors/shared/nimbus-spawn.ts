import { spawn } from "node:child_process";

export type SpawnResult = { code: number; stdout: string; stderr: string };

/**
 * Node implementation. Exported so it can be tested directly: the suite runs under Bun, so
 * `nimbusSpawn` would otherwise never exercise this branch and it would ship unverified.
 *
 * Two Node APIs are deliberately NOT used, and the reasons are not obvious:
 *
 *  - `spawnSync` blocks the event loop. In a stdio MCP server that must keep answering JSON-RPC —
 *    including an in-flight `elicitation/create` round-trip — a synchronous spawn deadlocks the
 *    consent gate against itself.
 *  - `execFile` caps captured output at a 1 MB `maxBuffer` by default and errors past it. The
 *    `Bun.spawn` path reads stdout uncapped, and `aws logs` / `gcloud logging` JSON routinely
 *    exceeds 1 MB, so `execFile` would be a silent-truncation regression dressed up as a
 *    portability fix.
 *
 * Output is accumulated as raw `Buffer`s and decoded ONCE at the end. Decoding each chunk with
 * `chunk.toString("utf8")` corrupts any multi-byte character that straddles a chunk boundary, and
 * chunk boundaries are a function of pipe timing — so it fails intermittently, on non-ASCII data,
 * in production.
 */
export function spawnViaNode(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<SpawnResult> {
  const [bin, ...args] = command;
  if (bin === undefined) {
    return Promise.resolve({ code: 1, stdout: "", stderr: "empty command" });
  }
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env } });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => {
      outChunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      errChunks.push(c);
    });
    const decode = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(outChunks).toString("utf8"),
      stderr: Buffer.concat(errChunks).toString("utf8"),
    });
    child.on("error", (e: Error) => {
      const d = decode();
      resolveP({ code: 1, stdout: d.stdout, stderr: `${d.stderr}${e.message}` });
    });
    child.on("close", (code: number | null) => {
      resolveP({ code: code ?? 1, ...decode() });
    });
  });
}

/** Bun implementation. Draining the whole stream decodes multi-byte characters correctly. */
export async function spawnViaBun(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<SpawnResult> {
  if (command.length === 0) {
    return { code: 1, stdout: "", stderr: "empty command" };
  }
  // `Bun.spawn` THROWS synchronously when the binary does not exist, where `child_process` emits
  // an "error" event instead. Both branches must honour the same contract — resolve with a
  // non-zero code, never reject — or a caller's behaviour would depend on the runtime.
  try {
    const proc = Bun.spawn([...command], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Spawn a CLI and collect its output, on Bun or Node.
 *
 * The runtime is chosen at CALL time, not module load, so a test that swaps `Bun.spawn` is still
 * honoured. That is not incidental: `cloudwatch/test/tools.test.ts` stubs `Bun.spawn` globally, and
 * routing unconditionally through Node made it spawn a real `aws` and hang the suite.
 *
 * Never rejects: a spawn failure resolves with a non-zero code, matching the previous behaviour.
 */
export function nimbusSpawn(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<SpawnResult> {
  const bunSpawnAvailable =
    typeof globalThis.Bun !== "undefined" && typeof globalThis.Bun.spawn === "function";
  return bunSpawnAvailable ? spawnViaBun(command, env) : spawnViaNode(command, env);
}
