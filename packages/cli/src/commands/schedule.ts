// `nimbus schedule list [--json]` (Phase 10 SA4): every scheduled workflow with its cron expression and
// zone, its next and last fire, the status of its last run and, when a run is waiting for the owner,
// the exact command that resumes it. Read-only; the schedule itself is set by
// `nimbus workflow save --schedule` and cleared by `nimbus workflow unschedule`.
import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { stripControl } from "./captures-format.ts";

export const SCHEDULE_USAGE = "usage: nimbus schedule list [--json]";

export type ScheduleEntry = {
  name: string;
  schedule: string;
  timezone: string;
  nextFireAt: number | null;
  lastFireAt: number | null;
  lastRunStatus: string | null;
  blockedRunId: string | null;
  blockedStepLabel: string | null;
};

export type ScheduleArgs = { verb: "list"; json: boolean };

export function parseScheduleArgs(argv: string[]): ScheduleArgs | undefined {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const verb = rest[0] ?? "list";
  return verb === "list" && rest.length <= 1 ? { verb, json } : undefined;
}

function when(ms: number | null, zone: string): string {
  if (ms === null) return "never";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date(ms))
      .replace(",", "");
  } catch {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
  }
}

/** One line per workflow, plus an indented line naming the run that waits and how to resume it. */
export function formatScheduleTable(entries: readonly ScheduleEntry[]): string {
  if (entries.length === 0) return "No scheduled workflows.\n";
  const rows = entries.map((e) => [
    stripControl(e.name),
    stripControl(e.schedule),
    stripControl(e.timezone),
    when(e.nextFireAt, e.timezone),
    when(e.lastFireAt, e.timezone),
    e.blockedRunId === null ? stripControl(e.lastRunStatus ?? "no runs") : "waiting for approval",
  ]);
  const head = ["WORKFLOW", "SCHEDULE", "ZONE", "NEXT FIRE", "LAST FIRE", "STATUS"];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    `${cells.map((c, i) => c.padEnd(width[i] ?? 0)).join("  ")}\n`;
  const out = [line(head)];
  entries.forEach((e, i) => {
    out.push(line(rows[i] ?? []));
    if (e.blockedRunId !== null) {
      const step = e.blockedStepLabel === null ? "a write step" : stripControl(e.blockedStepLabel);
      out.push(
        `  step ${step} needs your approval: nimbus workflow resume ${stripControl(e.blockedRunId)}\n`,
      );
    }
  });
  return out.join("");
}

type Sink = { out(s: string): void; err(s: string): void };

export async function runScheduleWith(
  c: Pick<IPCClient, "call">,
  a: ScheduleArgs,
  sink: Sink,
): Promise<number> {
  try {
    const { schedules } = await c.call<{ schedules: ScheduleEntry[] }>("workflow.scheduleList", {});
    sink.out(
      a.json ? `${JSON.stringify({ schedules }, undefined, 2)}\n` : formatScheduleTable(schedules),
    );
    return 0;
  } catch (e) {
    sink.err(`${stripControl(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

export async function runScheduleCmd(argv: string[]): Promise<void> {
  const a = parseScheduleArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${SCHEDULE_USAGE}\n`);
    throw new CliExit(2);
  }
  const code = await withGatewayIpc(
    (c) =>
      runScheduleWith(c, a, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    getCliPlatformPaths(),
  );
  if (code !== 0) throw new CliExit(code);
}
