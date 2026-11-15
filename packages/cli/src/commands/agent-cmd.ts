/**
 * `nimbus agent`: the production wiring of `agent.ts` (Phase 28 AD7b). Glue only: the real home
 * directory, the real terminal, the real gateway connection. Every decision is in `agent.ts` and
 * `agent-kits/`, which take all of this as parameters.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";

import { applyPlan } from "../agent-kits/apply.ts";
import { agentVersion, nodeKitEnv, resolveNimbusCommand } from "../agent-kits/production.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { readLine } from "../lib/read-line.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { type CliPlatformPaths, getCliPlatformPaths } from "../paths.ts";
import { type AgentCmdDeps, runAgentWith } from "./agent.ts";

const VERSION_TIMEOUT_MS = 3_000;
const GATEWAY_TIMEOUT_MS = 2_000;

/** The process-level inputs, replaceable so a test never reads the real terminal or gateway. */
export interface AgentIo {
  paths(): CliPlatformPaths;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  which(name: string): string | null;
}

const REAL_IO: AgentIo = {
  paths: getCliPlatformPaths,
  readStdin: () => Bun.stdin.text(),
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
  which: (name) => Bun.which(name),
};

/** Starts the program directly: no shell, a hard time limit, stdout only. */
function runForOutput(path: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      [...args],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: false },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

async function gatewayAnswers(paths: CliPlatformPaths): Promise<boolean> {
  try {
    await withGatewayIpc((c) => c.call<unknown>("capture.status", {}), paths, {
      requestTimeoutMs: GATEWAY_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export function productionAgentDeps(over: Partial<AgentIo> = {}): AgentCmdDeps {
  const io: AgentIo = { ...REAL_IO, ...over };
  return {
    env: () =>
      nodeKitEnv({
        home: homedir(),
        cwd: process.cwd(),
        nimbus: resolveNimbusCommand(process.execPath, io.which),
        envVar: (name) => process.env[name],
      }),
    tty: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    ask: (q) => readLine(q),
    out: io.stdout,
    err: io.stderr,
    apply: (plan) => applyPlan(plan),
    versionOf: (program) => agentVersion(program, io.which, runForOutput),
    gatewayAnswers: () => gatewayAnswers(io.paths()),
    readStdin: io.readStdin,
  };
}

export async function runAgentCmd(argv: string[], over: Partial<AgentIo> = {}): Promise<void> {
  const code = await runAgentWith(argv, productionAgentDeps(over));
  if (code !== 0) throw new CliExit(code);
}
