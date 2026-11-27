import { stripControlChars } from "../lib/strip-control-chars.ts";
import type { CostWhyIpc, CostWhySink } from "./cost-why-cli.ts";

/**
 * `nimbus cost report schedule <name> [--channel slack|teams|gmail|outlook] [--json]` (Phase 7, the Cost Pack,
 * slice 4): saves one scheduled workflow per channel of a `[[cost.report]]`, `cost-<report>-<kind>`, through
 * `cost.reportSchedule`. A channel the send door would refuse is not saved, with the reason; the others are.
 * Nothing is sent now. A scheduled run posts only under a standing rule the owner approves with the printed
 * `nimbus approve add` line; without one, each run stops and waits for the owner (`nimbus workflow resume`).
 * Exit codes: 0 when every requested channel was saved; 1 when any was skipped, and for any IPC error.
 */
export type CostReportScheduleArgs = {
  readonly name: string;
  readonly channel: string | null;
  readonly json: boolean;
};

const KINDS = ["slack", "teams", "gmail", "outlook"];

/** Parses the arguments AFTER `schedule`; undefined for a usage error. */
export function parseCostReportScheduleArgs(
  args: readonly string[],
): CostReportScheduleArgs | undefined {
  const name = args[0];
  if (name === undefined || name === "" || name.startsWith("-")) return undefined;
  let channel: string | null = null;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--json" && !json) json = true;
    else if (a === "--channel" && channel === null && next !== undefined && KINDS.includes(next)) {
      channel = next;
      i++;
    } else return undefined;
  }
  return { name, channel, json };
}

type Scheduled =
  | {
      kind: string;
      workflow: string;
      status: "new" | "replaced" | "unchanged";
      schedule: string;
      tz: string;
      approve: string;
    }
  | { kind: string; workflow: string; status: "skipped"; reason: string };
type ScheduleResult = { report: string; channels: Scheduled[] };

const clean = (s: string): string => stripControlChars(s).slice(0, 300);

const STATUS_LINE: Record<"new" | "replaced" | "unchanged", string> = {
  new: "saved",
  replaced:
    "replaced (its content changed, so a standing rule for the old version no longer applies: approve it again)",
  unchanged: "unchanged",
};

function renderText(r: ScheduleResult, sink: CostWhySink): void {
  for (const c of r.channels) {
    if (c.status === "skipped") {
      sink.err(`${clean(c.workflow)}: not generated: ${clean(c.reason)}\n`);
      continue;
    }
    sink.out(
      `${clean(c.workflow)}: ${STATUS_LINE[c.status]}, runs ${clean(c.schedule)} (${clean(c.tz)})\n`,
    );
    sink.out(`  To let it post without asking you each time: ${clean(c.approve)}\n`);
  }
  if (r.channels.some((c) => c.status !== "skipped")) {
    sink.out(
      "Until you approve that rule, each scheduled run stops before posting and waits for you (nimbus workflow resume <run id>).\n",
    );
  }
}

export async function runCostReportScheduleWith(
  c: CostWhyIpc,
  a: CostReportScheduleArgs,
  sink: CostWhySink,
): Promise<number> {
  try {
    const params: Record<string, unknown> = { name: a.name };
    if (a.channel !== null) params["channel"] = a.channel;
    const r = (await c.call("cost.reportSchedule", params)) as ScheduleResult;
    if (a.json) sink.out(`${JSON.stringify(r)}\n`);
    else renderText(r, sink);
    return r.channels.every((ch) => ch.status !== "skipped") ? 0 : 1;
  } catch (e) {
    sink.err(`nimbus cost report schedule: ${clean(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}
