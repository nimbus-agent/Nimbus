// `nimbus iac drift [--workdir <dir>] [--json]` and `nimbus iac drift --latest [--json]` (Phase 10 IaC
// drift D2, owner ruling OR-DRIFT-1): the owner's read-only Terraform drift check. It runs `terraform
// plan` in each approved workdir (`nimbus connector writes enable iac --workdir <dir>`) with that
// workdir's granted cloud credentials, asks nothing, applies nothing, and prints what Terraform reports as
// changed outside Terraform: object addresses and attribute NAMES, never values. `--latest` prints the
// stored findings without running a check. Exit 0 when every finding is clean, 1 when any shows drift,
// failed or found the workdir busy, 2 on a usage error.
//
// `nimbus iac accept-drift --workdir <dir> [--json]` (OR-S4-ACCEPT-DRIFT) accepts the drift the check found
// into the Terraform state of an approved workdir: the gateway settles a refresh-only plan, shows the drift,
// and you approve by TYPING `iac/accept-drift <dir>` at this terminal. Only a person can: `--yes`, scripted
// consent and a non-terminal are refused. Exit 0 accepted, 1 declined or failed, 2 usage or no terminal.
import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { stripControl } from "./captures-format.ts";

export const IAC_USAGE = [
  "usage: nimbus iac drift [--workdir <dir>] [--json]",
  "       nimbus iac drift --latest [--json]",
  "       nimbus iac accept-drift --workdir <dir> [--json]   accept the drift into state (you type the confirmation)",
].join("\n");

/** `--help` / `-h` anywhere after `iac`: print the usage and exit 0. */
export function wantsIacHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export type IacDriftFinding = {
  workdir: string;
  checkedAt: number;
  startedBy: "owner_cli" | "schedule";
  status: "drift" | "clean" | "failed" | "busy";
  driftCount: number | null;
  plannedChanges: number | null;
  lines: string[];
  reason?: string;
};

export type IacArgs = { latest: boolean; json: boolean; workdir?: string };

export function parseIacArgs(argv: readonly string[]): IacArgs | undefined {
  if (argv[0] !== "drift") return undefined;
  const out: IacArgs = { latest: false, json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--latest") out.latest = true;
    else if (a === "--workdir") {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) return undefined;
      out.workdir = v;
      i++;
    } else return undefined;
  }
  if (out.latest && out.workdir !== undefined) return undefined;
  return out;
}

function statusLine(f: IacDriftFinding): string {
  const where = stripControl(f.workdir);
  const when = new Date(f.checkedAt);
  // A stored time outside what a Date can hold reads as unknown, never a throw that hides every entry.
  const at = Number.isNaN(when.getTime())
    ? "at an unknown time"
    : `${when.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  const planned =
    f.plannedChanges === null ? "" : `; an apply would make ${String(f.plannedChanges)} changes`;
  if (f.status === "drift") {
    return `DRIFT  ${where}: ${String(f.driftCount)} objects changed outside Terraform (checked ${at}${planned})`;
  }
  if (f.status === "clean")
    return `CLEAN  ${where}: none reported by terraform (checked ${at}${planned})`;
  const why = stripControl(f.reason ?? "unknown");
  return `${f.status === "busy" ? "BUSY " : "FAILED"} ${where}: ${why} (checked ${at})`;
}

/** The human view: one status line per workdir, and for drift the renderer's own lines under it. */
export function formatIacDrift(findings: readonly IacDriftFinding[], latest: boolean): string {
  if (findings.length === 0) {
    return latest
      ? "No drift findings stored yet. Run: nimbus iac drift\n"
      : "No approved Terraform workdirs. Approve one with: nimbus connector writes enable iac --wave 4 --workdir <dir>\n";
  }
  const out: string[] = [];
  for (const f of findings) {
    out.push(`${statusLine(f)}\n`);
    // Drift lines start with "Drift:" (the summary) then indented objects; the summary is restated above.
    for (const l of f.lines.slice(1)) out.push(`  ${stripControl(l)}\n`);
  }
  return out.join("");
}

type Sink = { out(s: string): void; err(s: string): void };

export type AcceptArgs = { workdir: string; json: boolean };

/** `accept-drift --workdir <dir> [--json]`; `--yes`, `-y`, a consent-source flag and anything else is a usage error. */
export function parseAcceptArgs(argv: readonly string[]): AcceptArgs | undefined {
  if (argv[0] !== "accept-drift") return undefined;
  let workdir: string | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--workdir") {
      const v = argv[i + 1];
      if (workdir !== undefined || v === undefined || v === "" || v.startsWith("--")) {
        return undefined;
      }
      workdir = v;
      i++;
    } else return undefined;
  }
  return workdir === undefined ? undefined : { workdir, json };
}

export type AcceptOutcome =
  | { status: "accepted" }
  | { status: "declined" | "failed"; reason: string; nonHuman: boolean };

export const ACCEPT_TTY_REFUSAL =
  "Accepting drift needs an interactive terminal (TTY): you approve it by typing the confirmation at this terminal. Nothing was sent to the gateway.";

/** The owner's view of the outcome, one line; the gateway's reason is shown stripped of control characters. */
export function formatAccept(workdir: string, o: AcceptOutcome): string {
  const where = stripControl(workdir);
  if (o.status === "accepted") {
    return `Accepted: the drift in ${where} is now in the Terraform state; no infrastructure was changed. Run nimbus iac drift to check.\n`;
  }
  if (o.nonHuman) {
    return "Not accepted: only a person at this terminal can approve this (--yes, scripts and older clients cannot).\n";
  }
  return `Not accepted (${o.status}): ${stripControl(o.reason)}\n`;
}

type Tty = { readonly stdin: boolean; readonly stdout: boolean };

export async function runAcceptWith(
  c: Pick<IPCClient, "call">,
  a: AcceptArgs,
  sink: Sink,
  tty: Tty,
): Promise<number> {
  if (!(tty.stdin && tty.stdout)) {
    sink.err(`${ACCEPT_TTY_REFUSAL}\n`);
    return 2;
  }
  try {
    await declareCliClientKind(c);
    const { outcome } = await c.call<{ outcome: AcceptOutcome }>("iac.acceptDrift", {
      workdir: a.workdir,
    });
    sink.out(a.json ? `${JSON.stringify({ outcome })}\n` : formatAccept(a.workdir, outcome));
    if (outcome.status === "accepted") return 0;
    return outcome.status === "declined" && outcome.nonHuman ? 2 : 1;
  } catch (e) {
    sink.err(`${stripControl(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

export async function runIacWith(
  c: Pick<IPCClient, "call">,
  a: IacArgs,
  sink: Sink,
): Promise<number> {
  try {
    await declareCliClientKind(c);
    const method = a.latest ? "iac.driftLatest" : "iac.driftCheck";
    const params = a.workdir === undefined ? {} : { workdir: a.workdir };
    const { findings } = await c.call<{ findings: IacDriftFinding[] }>(method, params);
    sink.out(
      a.json
        ? `${JSON.stringify({ findings }, undefined, 2)}\n`
        : formatIacDrift(findings, a.latest),
    );
    return findings.every((f) => f.status === "clean") ? 0 : 1;
  } catch (e) {
    sink.err(`${stripControl(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

/**
 * How the command reaches the gateway: one IPC client per run (a seam for tests). `long` is true for a
 * check, which awaits a terraform plan per workdir; `--latest` reads a file and keeps the 30 s default.
 */
export type IacIpc = (
  fn: (c: Pick<IPCClient, "call">) => Promise<number>,
  long: boolean,
  human?: boolean,
) => Promise<number>;

/** `human`: the run blocks on the executor's prompt, so consent ignores NIMBUS_SCRIPT_CONSENT_SOURCE (a person only). */
const GATEWAY_IPC: IacIpc = (fn, long, human) =>
  withGatewayIpc(fn, getCliPlatformPaths(), {
    ...(long ? { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS } : {}),
    ...(human === true ? { consent: { kind: "human" as const } } : {}),
  });

const PROCESS_SINK: Sink = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** Whether stdin and stdout are terminals, read at each call. */
function processTty(): Tty {
  return { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true };
}

export async function runIacCmd(
  argv: string[],
  ipc: IacIpc = GATEWAY_IPC,
  sink: Sink = PROCESS_SINK,
  tty: Tty = processTty(),
): Promise<void> {
  if (wantsIacHelp(argv)) {
    sink.out(`${IAC_USAGE}\n`);
    return;
  }
  if (argv[0] === "accept-drift") {
    const acc = parseAcceptArgs(argv);
    if (acc === undefined) {
      sink.err(`${IAC_USAGE}\n`);
      throw new CliExit(2);
    }
    const code = await ipc((c) => runAcceptWith(c, acc, sink, tty), true, true);
    if (code !== 0) throw new CliExit(code);
    return;
  }
  const a = parseIacArgs(argv);
  if (a === undefined) {
    sink.err(`${IAC_USAGE}\n`);
    throw new CliExit(2);
  }
  const code = await ipc((c) => runIacWith(c, a, sink), !a.latest);
  if (code !== 0) throw new CliExit(code);
}
