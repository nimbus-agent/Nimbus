import { resolve } from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/**
 * Distinct codes so a wrapper script can tell "you said no" from "your code returned 1".
 * Documented in `docs/cli-reference.md`; changing one is a breaking change for any script.
 */
export const EXEC_EXIT_CODES = {
  denied: 10,
  timeout: 11,
  refused: 12,
  wallClock: 13,
  outputCap: 14,
} as const;

export interface ParsedExecArgs {
  readonly code?: string;
  readonly filePath?: string;
  readonly runtimeId?: string;
  readonly fsRead: string[];
  readonly fsWrite: string[];
  readonly timeoutMs?: number;
}

const USAGE =
  "Usage: nimbus exec (--code <src> | --file <path>) [--runtime <id>] " +
  "[--allow-fs-read <path>]... [--allow-fs-write <path>]... [--timeout <ms>]";

/**
 * Parse argv, resolving every path to absolute against THIS process's cwd.
 *
 * The gateway is a separate process whose working directory is unrelated, so a relative path is
 * meaningless by the time it crosses the IPC boundary. The gate refuses anything still relative
 * rather than resolving it -- so an omission here is a loud error there, never a grant of the
 * wrong directory.
 *
 * Unknown flags THROW. Silently ignoring one is the worst failure this parser could have: a user
 * typing `--allow-net` would believe they granted network and read the run's success as proof.
 */
export function parseExecArgs(args: readonly string[]): ParsedExecArgs {
  const fsRead: string[] = [];
  const fsWrite: string[] = [];
  let code: string | undefined;
  let filePath: string | undefined;
  let runtimeId: string | undefined;
  let timeoutMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${flag} requires a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case "--code":
        code = next();
        break;
      case "--file":
        filePath = resolve(process.cwd(), next());
        break;
      case "--runtime":
        runtimeId = next();
        break;
      case "--allow-fs-read":
        fsRead.push(resolve(process.cwd(), next()));
        break;
      case "--allow-fs-write":
        fsWrite.push(resolve(process.cwd(), next()));
        break;
      case "--timeout": {
        const raw = next();
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout must be a positive integer`);
        timeoutMs = n;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${flag}\n${USAGE}`);
    }
  }

  if (code === undefined && filePath === undefined) {
    throw new Error(`nimbus exec requires either --code or --file\n${USAGE}`);
  }
  return {
    ...(code === undefined ? {} : { code }),
    ...(filePath === undefined ? {} : { filePath }),
    ...(runtimeId === undefined ? {} : { runtimeId }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    fsRead,
    fsWrite,
  };
}

export interface ExecOutcomeShape {
  readonly status: string;
  readonly code?: string;
  readonly result?: {
    readonly exitCode: number | null;
    readonly terminationReason: string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly truncated?: boolean;
  };
}

/**
 * Map a gate outcome to a process exit code.
 *
 * Kept pure so every branch is testable without a gateway. An unrecognised shape maps to
 * `refused`, never 0: exiting 0 on something we did not understand would read as "it ran fine".
 */
export function exitCodeFor(outcome: ExecOutcomeShape): number {
  if (outcome.status === "denied") return EXEC_EXIT_CODES.denied;
  if (outcome.status === "timeout") return EXEC_EXIT_CODES.timeout;
  if (outcome.status === "refused") return EXEC_EXIT_CODES.refused;
  const r = outcome.result;
  if (outcome.status !== "ran" || r === undefined) return EXEC_EXIT_CODES.refused;
  if (r.terminationReason === "wall_clock") return EXEC_EXIT_CODES.wallClock;
  if (r.terminationReason === "output_cap") return EXEC_EXIT_CODES.outputCap;
  return r.exitCode ?? 1;
}

export interface ExecApprovalPrompt {
  readonly runtime: string;
  readonly codeBody: string;
  readonly grants: {
    readonly fsRead: readonly string[];
    readonly fsWrite: readonly string[];
    readonly network: readonly string[];
  };
  readonly wallClockMs: number;
  readonly cwd: string;
}

const list = (v: readonly string[]): string => (v.length === 0 ? "none" : v.join(", "));

/**
 * Render what the owner is being asked to approve.
 *
 * The body is shown VERBATIM and never as a digest -- the human is the entire security boundary
 * for this capability, and "run script sha256:a1b2..." is a rubber stamp with extra steps. Network
 * is printed even though it is always empty in this release: an absent line reads as "not
 * mentioned", where the owner should positively see that it is none.
 */
export function formatApprovalPrompt(p: ExecApprovalPrompt): string {
  return [
    `Run this code in the ${p.runtime} sandbox?`,
    "",
    p.codeBody,
    "",
    `  cwd:            ${p.cwd}`,
    `  fs read:        ${list(p.grants.fsRead)}`,
    `  fs write:       ${list(p.grants.fsWrite)}`,
    `  network:        ${list(p.grants.network)}`,
    `  time limit:     ${p.wallClockMs} ms`,
  ].join("\n");
}

export async function runExec(args: string[]): Promise<void> {
  let parsed: ParsedExecArgs;
  try {
    parsed = parseExecArgs(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = EXEC_EXIT_CODES.refused;
    return;
  }

  try {
    const outcome = await withGatewayIpc(
      async (c) => {
        // The gate's approval arrives as a BROADCAST, not a consent.request, so it needs its own
        // handler. Registered before the call because the notification can share a socket chunk
        // with the response.
        c.onNotification("exec.approvalRequest", async (params: unknown) => {
          const p = params as Partial<ExecApprovalPrompt> & { requestId?: string };
          if (typeof p.requestId !== "string") return;
          const answer = await confirm({
            message: formatApprovalPrompt({
              runtime: p.runtime ?? "unknown",
              codeBody: p.codeBody ?? "",
              grants: p.grants ?? { fsRead: [], fsWrite: [], network: [] },
              wallClockMs: p.wallClockMs ?? 0,
              cwd: p.cwd ?? "",
            }),
          });
          await c.call("exec.approvalRespond", {
            requestId: p.requestId,
            // Cancel (Ctrl-C at the prompt) is a denial, never an approval.
            approved: !isCancel(answer) && answer === true,
          });
        });
        return (await c.call("exec.run", { ...parsed, cwd: process.cwd() })) as ExecOutcomeShape;
      },
      undefined,
      // The call blocks on a human answering, so it needs the interactive budget rather than the
      // 30s default.
      { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS },
    );

    const r = outcome.result;
    if (r !== undefined) {
      if (r.stdout !== undefined && r.stdout !== "") process.stdout.write(r.stdout);
      if (r.stderr !== undefined && r.stderr !== "") process.stderr.write(r.stderr);
      // Disclose truncation rather than handing back a short buffer that looks complete.
      if (r.truncated === true) console.error("nimbus: output truncated at the configured cap");
    }
    if (outcome.status === "refused")
      console.error(`nimbus: refused (${outcome.code ?? "unknown"})`);
    if (outcome.status === "denied") console.error("nimbus: execution denied");
    process.exitCode = exitCodeFor(outcome);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = EXEC_EXIT_CODES.refused;
  }
}
