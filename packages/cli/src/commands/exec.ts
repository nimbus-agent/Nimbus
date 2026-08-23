import { resolve } from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/**
 * Control outcomes, in the 124–127 band the shell already reserves for "the command did not run":
 * 124 is GNU `timeout`'s kill code, 125 is `git bisect`'s "cannot test", and 126/127 mean found-but-
 * not-executed and not-found. A script's own exit code passes through unchanged.
 *
 * The collision is real and cannot be designed away: a script is free to `exit 126` itself, and
 * nothing in-band can distinguish that from a denial. Picking this band minimises it — 10–14, the
 * obvious first choice, sits exactly where ordinary scripts put their own error codes — and
 * `docs/cli-reference.md` states the residual ambiguity plainly rather than promising a distinction
 * that does not exist. stderr carries the unambiguous reason in every control case.
 *
 * There is deliberately no `timeout` entry. `ExecGateOutcome` has no timeout variant: the consent
 * broker resolves `false` on TTL, so a timed-out approval IS a denial and reports as one. A code
 * for it would be documented and unreachable.
 *
 * Changing any value is a breaking change for anything scripting `nimbus exec`.
 */
export const EXEC_EXIT_CODES = {
  wallClock: 124,
  outputCap: 125,
  denied: 126,
  refused: 127,
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
  // A timed-out approval arrives here as "denied" -- the broker resolves false on TTL -- so there
  // is no separate timeout branch to write.
  if (outcome.status === "denied") return EXEC_EXIT_CODES.denied;
  if (outcome.status === "refused") return EXEC_EXIT_CODES.refused;
  const r = outcome.result;
  if (outcome.status !== "ran" || r === undefined) return EXEC_EXIT_CODES.refused;
  if (r.terminationReason === "wall_clock") return EXEC_EXIT_CODES.wallClock;
  if (r.terminationReason === "output_cap") return EXEC_EXIT_CODES.outputCap;
  return r.exitCode ?? 1;
}

/** Where rendered output goes. Injected so the rendering is testable without a live process. */
export interface OutcomeSink {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

/**
 * Write a gate outcome to the user.
 *
 * Pure over an injected sink, because this is the half of `runExec` worth testing: the rest is
 * connect / call / disconnect that only an e2e can exercise honestly. Truncation is DISCLOSED
 * rather than left implicit — a short buffer that looks complete is the failure mode a silent cap
 * would produce, and stderr is what a script should read for the unambiguous reason, since the
 * exit code alone cannot separate a control outcome from a script that chose the same number.
 */
export function renderOutcome(outcome: ExecOutcomeShape, sink: OutcomeSink): void {
  const r = outcome.result;
  if (r !== undefined) {
    if (r.stdout !== undefined && r.stdout !== "") sink.out(r.stdout);
    if (r.stderr !== undefined && r.stderr !== "") sink.err(r.stderr);
    if (r.truncated === true) sink.err("nimbus: output truncated at the configured cap\n");
  }
  if (outcome.status === "refused") sink.err(`nimbus: refused (${outcome.code ?? "unknown"})\n`);
  if (outcome.status === "denied") sink.err("nimbus: execution denied\n");
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

/** What an `exec.approvalRequest` broadcast carries. Every field is validated before use. */
type ApprovalBroadcast = Partial<ExecApprovalPrompt> & { requestId?: string };

/**
 * Answer one approval broadcast.
 *
 * Extracted from `runExec` because this is the decision-making half — what the owner is shown, and
 * how their answer is read — while what remains there is connect / call / disconnect that only an
 * e2e can exercise honestly. `confirm` and the responder are injected so both can be driven here.
 *
 * A broadcast with no usable `requestId` is IGNORED rather than answered: replying to an unknown
 * id would at best do nothing and at worst answer a different prompt.
 */
export async function handleApprovalBroadcast(
  params: unknown,
  ask: (message: string) => Promise<unknown>,
  respond: (requestId: string, approved: boolean) => Promise<unknown>,
): Promise<void> {
  const p = (params ?? {}) as ApprovalBroadcast;
  if (typeof p.requestId !== "string" || p.requestId === "") return;
  const answer = await ask(
    formatApprovalPrompt({
      runtime: p.runtime ?? "unknown",
      codeBody: p.codeBody ?? "",
      grants: p.grants ?? { fsRead: [], fsWrite: [], network: [] },
      wallClockMs: p.wallClockMs ?? 0,
      cwd: p.cwd ?? "",
    }),
  );
  // Only an explicit `true` approves. Cancelling the prompt (Ctrl-C) is a DENIAL, and so is any
  // other value -- fail-closed, because the alternative is approving arbitrary code by accident.
  await respond(p.requestId, !isCancel(answer) && answer === true);
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
        c.onNotification("exec.approvalRequest", (params: unknown) =>
          handleApprovalBroadcast(
            params,
            (message) => confirm({ message }),
            (requestId, approved) => c.call("exec.approvalRespond", { requestId, approved }),
          ),
        );
        return (await c.call("exec.run", { ...parsed, cwd: process.cwd() })) as ExecOutcomeShape;
      },
      undefined,
      // The call blocks on a human answering, so it needs the interactive budget rather than the
      // 30s default.
      { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS },
    );

    renderOutcome(outcome, {
      out: (s) => void process.stdout.write(s),
      err: (s) => void process.stderr.write(s),
    });
    process.exitCode = exitCodeFor(outcome);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = EXEC_EXIT_CODES.refused;
  }
}
