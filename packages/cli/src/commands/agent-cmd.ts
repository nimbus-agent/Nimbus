/**
 * `nimbus agent`: the production wiring of `agent.ts` (Phase 28 AD7b). Glue only: the real home
 * directory, the real terminal, the real gateway connection. Every decision is in `agent.ts` and
 * `agent-kits/`, which take all of this as parameters.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";

import { applyPlan } from "../agent-kits/apply.ts";
import {
  agentVersion,
  answers,
  type ExecFileLike,
  execForOutput,
  nodeKitEnv,
  readProcessEnv,
  resolveNimbusCommand,
} from "../agent-kits/production.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { readLine } from "../lib/read-line.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { type CliPlatformPaths, getCliPlatformPaths } from "../paths.ts";
import { type AgentCmdDeps, runAgentWith } from "./agent.ts";

const GATEWAY_TIMEOUT_MS = 2_000;

/** The process-level inputs, replaceable so a test never reads the real terminal or gateway. */
export interface AgentIo {
  paths(): CliPlatformPaths;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  which(name: string): string | null;
  exec: ExecFileLike;
}

export const REAL_AGENT_IO: AgentIo = {
  paths: getCliPlatformPaths,
  readStdin: Bun.stdin.text.bind(Bun.stdin),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  which: (name) => Bun.which(name),
  exec: execFile as ExecFileLike,
};

export function productionAgentDeps(over?: Partial<AgentIo>): AgentCmdDeps {
  const io: AgentIo = { ...REAL_AGENT_IO, ...over };
  return {
    env: () =>
      nodeKitEnv({
        home: homedir(),
        cwd: process.cwd(),
        nimbus: resolveNimbusCommand(process.execPath, io.which),
        envVar: readProcessEnv,
      }),
    tty: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    ask: readLine,
    out: io.stdout,
    err: io.stderr,
    apply: applyPlan,
    versionOf: (program) => agentVersion(program, io.which, execForOutput(io.exec)),
    gatewayAnswers: () =>
      answers(() =>
        withGatewayIpc((c) => c.call<unknown>("capture.status", {}), io.paths(), {
          requestTimeoutMs: GATEWAY_TIMEOUT_MS,
        }),
      ),
    readStdin: io.readStdin,
  };
}

export async function runAgentCmd(argv: string[], over?: Partial<AgentIo>): Promise<void> {
  const code = await runAgentWith(argv, productionAgentDeps(over));
  if (code !== 0) throw new CliExit(code);
}
