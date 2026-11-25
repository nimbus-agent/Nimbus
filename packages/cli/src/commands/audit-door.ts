import type { IPCClient } from "../ipc-client/index.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";

// ---- `nimbus audit --door` (agent door AD4) ---------------------------------------------------

/** The doors `audit.listByDoor` knows; mirrors `DOORS` in `gateway/src/audit/agent-door-proof.ts`. */
const AUDIT_DOORS = ["agent", "model", "workflow", "other"] as const;
type AuditDoor = (typeof AUDIT_DOORS)[number];

export const AUDIT_DOOR_USAGE =
  "usage: nimbus audit --door <agent|model|workflow|other> [--proposer <label> | --proposer=<label>] [--since <dur>] [--limit N] [--json]\n" +
  "       --proposer applies to the agent door only and implies --door agent\n" +
  "       use --proposer=<label> for a label that starts with --";

export interface AuditDoorArgs {
  readonly door: AuditDoor;
  readonly proposer: string | undefined;
  readonly sinceMs: number | undefined;
  readonly limit: number | undefined;
  readonly json: boolean;
}

/** Mirrors `DoorRow` in `gateway/src/audit/agent-door-proof.ts`. */
export interface AuditDoorRow {
  readonly id: number;
  readonly timestamp: number;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly door: string;
  readonly subStep: boolean;
  readonly captureId?: string;
  readonly label?: string | null;
  readonly labelSource?: string;
  readonly reason?: string;
}

export interface AuditDoorListing {
  readonly labelsVerified: false;
  readonly rows: readonly AuditDoorRow[];
  readonly scanCut: boolean;
}

/** True when the arguments ask for the door view; the unfiltered command never reaches it. */
export function wantsAuditDoorView(args: readonly string[]): boolean {
  return (
    args.includes("--door") ||
    args.includes("--proposer") ||
    args.some((a) => a.startsWith("--proposer="))
  );
}

function doorUsage(why: string): Error {
  return new Error(`${why}\n${AUDIT_DOOR_USAGE}`);
}

/** The flags as they are read; each one may be given once. */
interface DoorScan {
  door: string | undefined;
  proposer: string | undefined;
  sinceMs: number | undefined;
  limit: number | undefined;
  json: boolean;
}

const DOOR_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--door",
  "--proposer",
  "--since",
  "--limit",
]);

function once<T>(current: T | undefined, flag: string): void {
  if (current !== undefined) throw doorUsage(`${flag} was given more than once.`);
}

function parseDoorLimit(v: string): number {
  if (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1000) return Number(v);
  throw doorUsage("--limit must be an integer from 1 to 1000.");
}

/** Takes one value flag (`--door`, `--proposer`, `--since`, `--limit`) into the scan. */
function takeDoorValue(s: DoorScan, flag: string, v: string, now: number): void {
  if (flag === "--door") {
    once(s.door, flag);
    s.door = v;
  } else if (flag === "--proposer") {
    once(s.proposer, flag);
    s.proposer = v;
  } else if (flag === "--since") {
    once(s.sinceMs, flag);
    s.sinceMs = now - parseSinceDurationToMs(v);
  } else {
    once(s.limit, flag);
    s.limit = parseDoorLimit(v);
  }
}

/** Reads every argument into the scan; refuses an unknown option, a positional or a missing value. */
function scanDoorArgs(args: readonly string[], now: number): DoorScan {
  const s: DoorScan = {
    door: undefined,
    proposer: undefined,
    sinceMs: undefined,
    limit: undefined,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (a === "--json") {
      s.json = true;
    } else if (a.startsWith("--proposer=")) {
      // The unambiguous form: the label may start with `--`.
      once(s.proposer, "--proposer");
      s.proposer = a.slice("--proposer=".length);
    } else if (DOOR_VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw doorUsage(`${a} needs a value.`);
      i += 1;
      takeDoorValue(s, a, v, now);
    } else {
      throw doorUsage(
        a.startsWith("--")
          ? `Unknown option ${stripControlChars(a)}.`
          : "The door view takes no positional argument.",
      );
    }
  }
  return s;
}

/** The door the scan names: `--proposer` implies the agent door and refuses any other. */
function resolveDoor(s: DoorScan): AuditDoor {
  let door = s.door;
  if (s.proposer !== undefined) {
    if (s.proposer === "") throw doorUsage("--proposer needs a non-empty label.");
    if (door !== undefined && door !== "agent") {
      throw doorUsage("--proposer applies to the agent door only.");
    }
    door = "agent";
  }
  if (door === undefined) throw doorUsage("--door is required.");
  if (!(AUDIT_DOORS as readonly string[]).includes(door)) {
    throw doorUsage(`Unknown door ${stripControlChars(door)}.`);
  }
  return door as AuditDoor;
}

export function parseAuditDoorArgs(args: readonly string[], now: number): AuditDoorArgs {
  const s = scanDoorArgs(args, now);
  const door = resolveDoor(s);
  return { door, proposer: s.proposer, sinceMs: s.sinceMs, limit: s.limit, json: s.json };
}

function doorLabelCell(r: AuditDoorRow): string {
  if (r.door !== "agent" || r.subStep) return "";
  if (r.label === undefined) return "UNVERIFIED label not recorded (older row)";
  const label = r.label === null ? "(no label)" : `"${stripControlChars(r.label)}"`;
  return `UNVERIFIED label ${label}`;
}

export function formatAuditDoorListing(a: AuditDoorArgs, listing: AuditDoorListing): string {
  const lines: string[] = [`Audit rows through the ${a.door} door, newest first.`];
  if (a.door === "agent") {
    lines.push(
      "Every label is the client's own claim and is UNVERIFIED; it does not identify a program.",
    );
  }
  if (a.door === "other") {
    lines.push(
      "Other covers every row the gateway does not mark with a door (the owner's own commands, ChatOps, delegates, the gateway's own actions); it is not claimed to be the owner's.",
    );
  }
  if (listing.rows.length === 0) {
    lines.push(
      a.proposer === undefined
        ? `No rows came through the ${a.door} door in this window.`
        : `No row through the ${a.door} door in this window has the label "${stripControlChars(a.proposer)}".`,
    );
  } else {
    lines.push(
      `${"Timestamp".padEnd(20)} ${"Action".padEnd(28)} ${"Status".padEnd(17)} ${"Capture".padEnd(36)} Label / reason`,
      "-".repeat(110),
    );
  }
  for (const r of listing.rows) {
    const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19);
    const tail = [
      doorLabelCell(r),
      r.subStep ? "(sub-step of the proposal)" : "",
      r.reason === undefined ? "" : `reason: ${stripControlChars(r.reason)}`,
    ]
      .filter((x) => x !== "")
      .join("  ");
    lines.push(
      `${ts.padEnd(20)} ${stripControlChars(r.actionType).padEnd(28)} ${stripControlChars(r.hitlStatus).padEnd(17)} ${(r.captureId ?? "-").padEnd(36)} ${tail}`.trimEnd(),
    );
  }
  if (listing.scanCut) {
    lines.push("The scan was cut at its row cap: older rows were not examined.");
  }
  return lines.join("\n");
}

function isMethodNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === -32601;
}

export async function runAuditByDoor(client: IPCClient, a: AuditDoorArgs): Promise<void> {
  await declareCliClientKind(client);
  const params: Record<string, unknown> = { door: a.door };
  if (a.proposer !== undefined) params["proposer"] = a.proposer;
  if (a.sinceMs !== undefined) params["sinceMs"] = a.sinceMs;
  if (a.limit !== undefined) params["limit"] = a.limit;
  let listing: AuditDoorListing;
  try {
    listing = await client.call<AuditDoorListing>("audit.listByDoor", params);
  } catch (e) {
    if (!isMethodNotFound(e)) throw e;
    console.log(
      "This gateway is too old to list audit rows by door (it does not serve audit.listByDoor). Update the gateway.",
    );
    process.exitCode = 1;
    return;
  }
  if (a.json) console.log(JSON.stringify(listing, null, 2));
  else console.log(formatAuditDoorListing(a, listing));
}
