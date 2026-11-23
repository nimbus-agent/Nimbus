// `nimbus team schedule <peerId> --from <t> --to <t> --duration <minutes> [--json]`: ask a paired peer
// for its free/busy blocks and print the slots both calendars leave free (Phase 10, OR-S4-SCHED,
// I17 (b)). The peer's owner approves each request on their side, so this command can wait for them.
// Only 30-minute free/busy blocks cross the wire: no titles, attendees, places or calendar names.
import { confirm, isCancel } from "@clack/prompts";
import type { IPCClient } from "../ipc-client/index.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export const TEAM_SCHEDULE_USAGE =
  "usage: nimbus team schedule <peerId> --from <time> --to <time> --duration <minutes> [--json]\n" +
  "  <time>: 2026-11-25T09:00 (your local time), 2026-11-25T09:00Z, 2026-11-25 (local midnight),\n" +
  "          now, or +90m / +6h / +3d from now. The window is 30 minutes to 14 days, within 21 days.";

const BLOCK_MS = 30 * 60 * 1000;
const MAX_SLOTS_SHOWN = 20;
/** The peer's owner may take a while to answer; this bounds how long this command waits. */
const ASK_TIMEOUT_MS = 120_000;

export type ScheduleArgs = {
  readonly peerId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly durationMin: number;
  readonly json: boolean;
};

const REL_RE = /^\+(\d{1,4})([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** One time spelling to epoch ms, or undefined. A zone-less ISO form reads as local time. */
export function parseWhen(raw: string, nowMs: number): number | undefined {
  if (raw === "now") return nowMs;
  const rel = REL_RE.exec(raw);
  if (rel !== null) {
    return nowMs + Number(rel[1]) * UNIT_MS[rel[2] as keyof typeof UNIT_MS];
  }
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/.test(raw))
    return undefined;
  const ms = Date.parse(raw.length === 10 ? `${raw}T00:00` : raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The window is widened inward to whole 30-minute blocks: from rounds up, to rounds down. */
export function parseScheduleArgs(
  argv: readonly string[],
  nowMs: number,
): ScheduleArgs | undefined {
  const peerId = argv[0];
  if (peerId === undefined || peerId.startsWith("--")) return undefined;
  const from = parseWhen(flag(argv, "--from") ?? "", nowMs);
  const to = parseWhen(flag(argv, "--to") ?? "", nowMs);
  const duration = Number(flag(argv, "--duration"));
  if (from === undefined || to === undefined || !Number.isInteger(duration)) return undefined;
  return {
    peerId,
    fromMs: Math.ceil(from / BLOCK_MS) * BLOCK_MS,
    toMs: Math.floor(to / BLOCK_MS) * BLOCK_MS,
    durationMin: duration,
    json: argv.includes("--json"),
  };
}

type Slot = { startMs: number; endMs: number };
type AskReply =
  | { kind: "ok"; slots: Slot[]; durationMs: number }
  | { kind: "error"; error: string };

const ERROR_TEXT: Readonly<Record<string, string>> = {
  declined: "The peer's owner did not approve the request (or did not answer in time).",
  invalid_window:
    "The window was refused: use 30 minutes to 14 days, starting now or later and ending within 21 days.",
  rate_limited: "The peer is limiting requests from you; try again later.",
  calendar_unavailable: "The peer has no fresh calendar data to answer from.",
  own_calendar_unavailable:
    "Your own calendar is not connected or has not synced in the last 24 hours.",
  peer_unreachable: "The peer could not be reached.",
  malformed_reply: "The peer sent an answer this version does not understand.",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function local(ms: number): string {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] ?? "";
  return `${day} ${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderSchedule(reply: AskReply): string {
  if (reply.kind === "error") return `${ERROR_TEXT[reply.error] ?? `Refused: ${reply.error}`}\n`;
  if (reply.slots.length === 0) {
    return `No ${String(reply.durationMs / 60_000)}-minute slot is free for both of you in that window.\n`;
  }
  const shown = reply.slots.slice(0, MAX_SLOTS_SHOWN);
  const lines = shown.map((s) => `  ${local(s.startMs)} - ${local(s.endMs).slice(-5)}`);
  const more = reply.slots.length - shown.length;
  return `Free for both (start anywhere inside a run that fits ${String(reply.durationMs / 60_000)} minutes):\n${lines.join("\n")}\n${more > 0 ? `  ... and ${String(more)} more\n` : ""}`;
}

export type ScheduleDeps = {
  readonly nowMs: () => number;
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
};

/** The testable core: parse, ask, print. Returns the process exit code. */
export async function runScheduleWith(
  argv: readonly string[],
  deps: ScheduleDeps,
): Promise<number> {
  const args = parseScheduleArgs(argv, deps.nowMs());
  if (args === undefined) {
    deps.err(`${TEAM_SCHEDULE_USAGE}\n`);
    return 2;
  }
  const reply = (await deps.call("scheduling.ask", {
    peerId: args.peerId,
    fromMs: args.fromMs,
    toMs: args.toMs,
    durationMin: args.durationMin,
  })) as AskReply;
  deps.out(args.json ? `${JSON.stringify(reply)}\n` : renderSchedule(reply));
  return reply.kind === "ok" && reply.slots.length > 0 ? 0 : 1;
}

type WithIpc = <T>(
  fn: (c: IPCClient) => Promise<T>,
  paths?: undefined,
  opts?: { requestTimeoutMs?: number },
) => Promise<T>;

export async function runTeamSchedule(
  argv: string[],
  run: WithIpc = withGatewayIpc,
  io: { out(s: string): void; err(s: string): void; nowMs(): number } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    nowMs: () => Date.now(),
  },
): Promise<void> {
  let code = 0;
  try {
    code = await run(
      async (c) => {
        await declareCliClientKind(c);
        return runScheduleWith(argv, { ...io, call: (m, p) => c.call(m, p) });
      },
      undefined,
      { requestTimeoutMs: ASK_TIMEOUT_MS },
    );
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}
`);
    code = 1;
  }
  if (code !== 0) process.exitCode = code;
}

// ---- the owner's side: answer a peer's request in `nimbus team listen` ---------------------------

type PromptFn = (opts: { message: string }) => Promise<boolean | symbol>;

/** Strips anything that could forge a second line or move the cursor from a peer-supplied string. */
function plain(s: string): string {
  return Array.from(s)
    .filter((ch) => ch >= " " && ch !== "\u007f")
    .join("")
    .slice(0, 64);
}

export function scheduleRequestMessage(p: Record<string, unknown>): string | undefined {
  if (typeof p["requestId"] !== "string") return undefined;
  const peer = typeof p["peerId"] === "string" ? plain(p["peerId"]) : "?";
  const from = typeof p["fromMs"] === "number" ? local(p["fromMs"]) : "?";
  const to = typeof p["toMs"] === "number" ? local(p["toMs"]) : "?";
  return `Peer ${peer} asks when you are free between ${from} and ${to}. It learns only which 30-minute blocks are busy (no titles, attendees or places). Approve?`;
}

/**
 * One inbound free/busy request: ask the person, answer as a human. Esc leaves it to time out (the
 * peer then gets the same refusal as a denial).
 */
export async function handleScheduleRequest(
  client: { call(method: string, params?: unknown): Promise<unknown> },
  params: unknown,
  prompt: PromptFn,
  cancelled: (v: unknown) => boolean,
): Promise<void> {
  if (typeof params !== "object" || params === null) return;
  const p = params as Record<string, unknown>;
  const message = scheduleRequestMessage(p);
  if (message === undefined) return;
  const ok = await prompt({ message });
  if (cancelled(ok)) return;
  try {
    // The interactive prompt at this terminal is a person answering.
    await client.call("scheduling.respond", {
      requestId: p["requestId"],
      approved: ok === true,
      answerSource: "human",
    });
  } catch (e) {
    process.stderr.write(
      `Error sending the scheduling decision: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/** Registers the free/busy prompt on a connection (used by `nimbus team listen`). */
export function registerScheduleListener(client: IPCClient): void {
  client.onNotification("federation.scheduleRequest", (params: unknown) => {
    void handleScheduleRequest(client, params, confirm, isCancel);
  });
}
