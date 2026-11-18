// `nimbus iac drift [--workdir <dir>] [--json]` and `nimbus iac drift --latest [--json]` (Phase 10 IaC
// drift D2, owner ruling OR-DRIFT-1): the owner's read-only Terraform drift check. It runs `terraform
// plan` in each approved workdir (`nimbus connector writes enable iac --workdir <dir>`) with that
// workdir's granted cloud credentials, asks nothing, applies nothing, and prints what Terraform reports as
// changed outside Terraform: object addresses and attribute NAMES, never values. `--latest` prints the
// stored findings without running a check. Exit 0 when every finding is clean, 1 when any shows drift,
// failed or found the workdir busy, 2 on a usage error.
import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { stripControl } from "./captures-format.ts";

export const IAC_USAGE = "usage: nimbus iac drift [--workdir <dir>] [--latest] [--json]";

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
  const at = new Date(f.checkedAt).toISOString().replace("T", " ").slice(0, 16);
  const planned =
    f.plannedChanges === null ? "" : `; an apply would make ${String(f.plannedChanges)} changes`;
  if (f.status === "drift") {
    return `DRIFT  ${where}: ${String(f.driftCount)} objects changed outside Terraform (checked ${at} UTC${planned})`;
  }
  if (f.status === "clean")
    return `CLEAN  ${where}: none reported by terraform (checked ${at} UTC${planned})`;
  const why = stripControl(f.reason ?? "unknown");
  return `${f.status === "busy" ? "BUSY " : "FAILED"} ${where}: ${why} (checked ${at} UTC)`;
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

/** How the command reaches the gateway: one IPC client per run (a seam for tests). */
export type IacIpc = (fn: (c: Pick<IPCClient, "call">) => Promise<number>) => Promise<number>;

const GATEWAY_IPC: IacIpc = (fn) =>
  // The handler awaits a terraform plan per workdir (each up to 10 minutes).
  withGatewayIpc(fn, getCliPlatformPaths(), { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS });

const PROCESS_SINK: Sink = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export async function runIacCmd(
  argv: string[],
  ipc: IacIpc = GATEWAY_IPC,
  sink: Sink = PROCESS_SINK,
): Promise<void> {
  const a = parseIacArgs(argv);
  if (a === undefined) {
    sink.err(`${IAC_USAGE}\n`);
    throw new CliExit(2);
  }
  const code = await ipc((c) => runIacWith(c, a, sink));
  if (code !== 0) throw new CliExit(code);
}
