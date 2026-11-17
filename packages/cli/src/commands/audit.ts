import type { IPCClient } from "../ipc-client/index.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

type AuditRow = {
  id: number;
  actionType: string;
  hitlStatus: string;
  actionJson: string;
  timestamp: number;
};

function parseAuditListLimit(args: string[]): number {
  let limit = 50;
  const q = [...args];
  while (q.length > 0) {
    const a = q.shift();
    if (a === "--limit") {
      const v = q.shift();
      if (v !== undefined) {
        limit = Number.parseInt(v, 10);
      }
    }
  }
  if (!Number.isFinite(limit) || limit < 1) {
    return 50;
  }
  return limit;
}

export async function runAuditList(
  client: IPCClient,
  limit: number,
  opts: { json?: boolean } = {},
): Promise<void> {
  const rows = await client.call<AuditRow[]>("audit.list", { limit });
  if (opts.json === true) {
    // Raw `audit.list` rows, unwrapped. `actionJson` stays the string the chain stored — parsing it
    // here would silently drop rows whose payload is malformed, which the human view tolerates.
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`${"Timestamp".padEnd(20)} ${"Action".padEnd(22)} ${"Status".padEnd(17)} Reason`);
  console.log("-".repeat(75));
  for (const r of rows) {
    const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19);
    let reason = "—";
    try {
      const j: unknown = JSON.parse(r.actionJson) as unknown;
      if (j !== null && typeof j === "object" && !Array.isArray(j)) {
        const hitl = (j as { hitlRejectReason?: unknown }).hitlRejectReason;
        if (typeof hitl === "string") {
          reason = hitl;
        }
      }
    } catch {
      // Skip malformed action_json; keep default reason.
    }
    console.log(`${ts.padEnd(20)} ${r.actionType.padEnd(22)} ${r.hitlStatus.padEnd(17)} ${reason}`);
  }
}

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

export function parseAuditDoorArgs(args: readonly string[], now: number): AuditDoorArgs {
  let door: string | undefined;
  let proposer: string | undefined;
  let sinceMs: number | undefined;
  let limit: number | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a.startsWith("--proposer=")) {
      // The unambiguous form: the label may start with `--`.
      if (proposer !== undefined) throw doorUsage("--proposer was given more than once.");
      proposer = a.slice("--proposer=".length);
      continue;
    }
    if (a !== "--door" && a !== "--proposer" && a !== "--since" && a !== "--limit") {
      throw doorUsage(
        a.startsWith("--")
          ? `Unknown option ${stripControlChars(a)}.`
          : "The door view takes no positional argument.",
      );
    }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw doorUsage(`${a} needs a value.`);
    i += 1;
    if (a === "--door") {
      if (door !== undefined) throw doorUsage("--door was given more than once.");
      door = v;
    } else if (a === "--proposer") {
      if (proposer !== undefined) throw doorUsage("--proposer was given more than once.");
      proposer = v;
    } else if (a === "--since") {
      if (sinceMs !== undefined) throw doorUsage("--since was given more than once.");
      sinceMs = now - parseSinceDurationToMs(v);
    } else {
      if (limit !== undefined) throw doorUsage("--limit was given more than once.");
      if (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1000) limit = Number(v);
      else throw doorUsage("--limit must be an integer from 1 to 1000.");
    }
  }
  if (proposer !== undefined) {
    if (proposer === "") throw doorUsage("--proposer needs a non-empty label.");
    if (door !== undefined && door !== "agent") {
      throw doorUsage("--proposer applies to the agent door only.");
    }
    door = "agent";
  }
  if (door === undefined) throw doorUsage("--door is required.");
  if (!(AUDIT_DOORS as readonly string[]).includes(door)) {
    throw doorUsage(`Unknown door ${stripControlChars(door)}.`);
  }
  return { door: door as AuditDoor, proposer, sinceMs, limit, json };
}

function doorLabelCell(r: AuditDoorRow): string {
  if (r.door !== "agent" || r.subStep) return "";
  if (r.label === undefined) return "UNVERIFIED label not recorded (older row)";
  return `UNVERIFIED label ${r.label === null ? "(no label)" : `"${stripControlChars(r.label)}"`}`;
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
    );
    lines.push("-".repeat(110));
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

export async function runAuditVerify(client: IPCClient, full: boolean): Promise<void> {
  const out = await client.call<{
    ok: boolean;
    verifiedRows: number;
    firstBreakAtId?: number;
    reason?: string;
  }>("audit.verify", { full });
  if (out.ok) {
    console.log(`[ok]   chain integrity — ${String(out.verifiedRows)} rows verified`);
    process.exitCode = 0;
  } else {
    console.log(
      `[FAIL] chain break at row ${String(out.firstBreakAtId)}: ${out.reason ?? "unknown"}`,
    );
    process.exitCode = 1;
  }
}

type StandingFireView = {
  fireId: string;
  ruleId: string;
  firedAt: number;
  actionType: string;
  matchedScopeSha256: string;
  audit: { id: number; timestamp: number; rowHash: string } | null;
};

/**
 * `nimbus audit standing [<rule>]` (Phase 10 SA3): the fires of one standing rule, or of all of
 * them, each joined to the audit row that recorded it. A fire with no audit row is shown as such.
 */
export async function runAuditStanding(
  client: Pick<IPCClient, "call">,
  ruleId: string | undefined,
  opts: { json?: boolean } = {},
): Promise<void> {
  const out = await client.call<{ fires: StandingFireView[] }>(
    "standing.fires",
    ruleId === undefined ? {} : { id: ruleId },
  );
  if (opts.json === true) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (out.fires.length === 0) {
    console.log("No standing-rule fires recorded.");
    return;
  }
  console.log(
    `${"Fired".padEnd(20)} ${"Rule".padEnd(20)} ${"Fire".padEnd(20)} ${"Action".padEnd(24)} Audit row`,
  );
  console.log("-".repeat(96));
  for (const f of out.fires) {
    const ts = new Date(f.firedAt).toISOString().replace("T", " ").slice(0, 19);
    const audit = f.audit === null ? "NO AUDIT ROW" : `#${String(f.audit.id)}`;
    console.log(
      `${ts.padEnd(20)} ${f.ruleId.padEnd(20)} ${f.fireId.padEnd(20)} ${f.actionType.slice(0, 24).padEnd(24)} ${audit}`,
    );
  }
}

// ---- `nimbus audit replay <incident-id>` (incident engine IC4) ------------------------------------

export const AUDIT_REPLAY_USAGE = "usage: nimbus audit replay <incident-id> [--json]";

export interface AuditReplayArgs {
  readonly id: string;
  readonly json: boolean;
}

export function parseAuditReplayArgs(args: readonly string[]): AuditReplayArgs {
  let json = false;
  let id: string | undefined;
  for (const a of args) {
    if (a === "--json") {
      if (json) throw new Error(`--json was given more than once.\n${AUDIT_REPLAY_USAGE}`);
      json = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown option ${stripControlChars(a)}.\n${AUDIT_REPLAY_USAGE}`);
    } else if (id !== undefined) {
      throw new Error(`Give one incident id.\n${AUDIT_REPLAY_USAGE}`);
    } else {
      id = a;
    }
  }
  if (id === undefined) throw new Error(`An incident id is required.\n${AUDIT_REPLAY_USAGE}`);
  return { id, json };
}

/** Mirrors `ReplayResult` in `gateway/src/audit/incident-replay.ts` (the CLI cannot import the gateway). */
interface ReplayRowView {
  readonly auditId: number;
  readonly timestamp: number;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly answerSource: string | null;
  readonly confirm: string | null;
  readonly linkVersion: number;
  readonly unknownVersion: boolean;
  readonly rowTruncated: boolean;
  readonly egress: {
    readonly id: number;
    readonly resultStatus: string;
    readonly paired: string;
    readonly summaryMismatch: boolean;
    readonly statusDiffers: boolean;
  } | null;
}
interface ReplayStepView extends ReplayRowView {
  readonly prompt: { readonly text: string; readonly cut: boolean; readonly sha256: string } | null;
  readonly subSteps: readonly ReplayRowView[];
}
interface ReplayRangeView {
  readonly anchorId: number;
  readonly toId: number;
  readonly rowsRead: number;
  readonly ok: boolean;
  readonly verifiedRows: number;
  readonly firstBreak: number | null;
  readonly reason: string | null;
}
export interface ReplayView {
  readonly ok: boolean;
  readonly record: {
    readonly id: string;
    readonly triggerItemId: string;
    readonly service: string | null;
    readonly currentVersion: number;
    readonly versions: readonly {
      readonly version: number;
      readonly assembledAtMs: number;
      readonly recordSha256: string;
      readonly changedKeys: readonly string[];
    }[];
  };
  readonly actions: readonly ReplayStepView[];
  readonly proposals: {
    readonly note: string;
    readonly items?: readonly {
      readonly id: string;
      readonly kind: string;
      readonly toolId: string;
      readonly status: string;
      readonly reversibility: string;
      readonly confidence: number | null;
      readonly actionId: string | null;
      readonly undoStatus: string | null;
    }[];
  };
  readonly verification: {
    readonly audit: ReplayRangeView | null;
    readonly egress: ReplayRangeView | null;
  };
  readonly notes: readonly string[];
}

const oneLineClean = (s: string): string => stripControlChars(s).replace(/\s+/g, " ").trim();
const utcSec = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;

/** The prompt escaped (`JSON.stringify` escapes controls and quotes), then stripped of what it leaves (bidi marks). */
function escapedPrompt(text: string): string {
  return stripControlChars(JSON.stringify(text)).replace(
    /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

function replayRowLine(r: ReplayRowView, indent: string): string[] {
  const parts = [
    `${indent}#${String(r.auditId)} ${utcSec(r.timestamp)} ${oneLineClean(r.actionType)}  ${oneLineClean(r.hitlStatus)}`,
    r.answerSource === null ? "" : `answered by ${oneLineClean(r.answerSource)}`,
    r.confirm === null ? "" : `typed confirmation: ${oneLineClean(r.confirm)}`,
    `record version ${String(r.linkVersion)}${r.unknownVersion ? " (not stored)" : ""}`,
    r.rowTruncated ? "(row cut by the audit cap)" : "",
  ].filter((p) => p !== "");
  const lines = [parts.join("  ")];
  if (r.egress !== null) {
    const flags = [
      r.egress.paired === "ambiguous" ? "pairing ambiguous" : "",
      r.egress.summaryMismatch ? "summary head does not name this record (summary_mismatch)" : "",
      r.egress.statusDiffers ? "status differs from the verdict" : "",
    ].filter((f) => f !== "");
    lines.push(
      `${indent}  egress #${String(r.egress.id)} ${oneLineClean(r.egress.resultStatus)}${flags.length === 0 ? "" : ` (${flags.join("; ")})`}`,
    );
  } else {
    lines.push(`${indent}  no egress row paired`);
  }
  return lines;
}

function rangeLine(label: string, r: ReplayRangeView | null): string {
  if (r === null) return `${label}: not verified (no rows read)`;
  const span = `rows after #${String(r.anchorId)} up to #${String(r.toId)} (${String(r.rowsRead)} read, ${String(r.verifiedRows)} verified)`;
  return r.ok
    ? `${label}: ok over ${span}`
    : `${label}: BROKEN at #${String(r.firstBreak)} over ${span}: ${oneLineClean(r.reason ?? "unknown")}`;
}

/** The replay as terminal text. Every field that came from a row passes through `stripControlChars`. */
export function formatReplay(r: ReplayView): string {
  const lines: string[] = [
    `Replay of incident record ${oneLineClean(r.record.id)} (trigger ${oneLineClean(r.record.triggerItemId)}, service ${r.record.service === null ? "(unbound)" : oneLineClean(r.record.service)})`,
    "",
    "Record versions:",
    ...r.record.versions.map(
      (v) =>
        `  v${String(v.version)}  ${utcSec(v.assembledAtMs)}  sha256 ${v.recordSha256.slice(0, 12)}  changed: ${v.changedKeys.length === 0 ? "nothing" : v.changedKeys.map(oneLineClean).join(", ")}`,
    ),
    "",
    "Nimbus actions for this record:",
  ];
  if (r.actions.length === 0) lines.push("  No linked actions.");
  for (const a of r.actions) {
    lines.push(...replayRowLine(a, "  "));
    if (a.prompt !== null) {
      lines.push(
        `    prompt shown${a.prompt.cut ? " (cut)" : ""}, sha256 ${a.prompt.sha256.slice(0, 12)}: ${escapedPrompt(a.prompt.text)}`,
      );
    }
    for (const s of a.subSteps) lines.push(...replayRowLine(s, "    sub-step "));
  }
  lines.push("", "Proposals:", `  ${oneLineClean(r.proposals.note)}`);
  for (const p of r.proposals.items ?? []) {
    const conf = p.confidence === null ? "not scored" : `confidence ${String(p.confidence)}`;
    const ran = p.actionId === null ? "" : `, action ${oneLineClean(p.actionId)}`;
    const undo = p.undoStatus === null ? "" : `, undo ${oneLineClean(p.undoStatus)}`;
    lines.push(
      `  ${oneLineClean(p.id)}  ${oneLineClean(p.kind)}  ${oneLineClean(p.toolId)}  [${oneLineClean(p.status)}]  ${oneLineClean(p.reversibility)}, ${conf}${ran}${undo}`,
    );
  }
  lines.push("", "Verification:");
  lines.push(`  ${rangeLine("audit chain", r.verification.audit)}`);
  lines.push(`  ${rangeLine("egress chain", r.verification.egress)}`);
  for (const n of r.notes) lines.push(`Note: ${oneLineClean(n)}`);
  return lines.join("\n");
}

/** Exit 0 when both chains verified over the range read, 1 when one is broken, 2 for an unknown id. */
export async function runAuditReplay(
  client: Pick<IPCClient, "call">,
  a: AuditReplayArgs,
): Promise<void> {
  await declareCliClientKind(client);
  let r: ReplayView;
  try {
    r = await client.call<ReplayView>("audit.replay", {
      id: a.id,
      ...(a.json ? { full: true } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ERR_INCIDENT_NOT_FOUND")) {
      console.error(oneLineClean(msg));
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (a.json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatReplay(r));
  process.exitCode = r.ok ? 0 : 1;
}

export async function runAuditExport(
  client: IPCClient,
  outPath: string,
  writeFile: (p: string, data: string) => Promise<unknown>,
): Promise<void> {
  const rows = await client.call<unknown[]>("audit.exportAll", {});
  await writeFile(outPath, JSON.stringify(rows, null, 2));
  console.log(`[ok] wrote ${String(rows.length)} audit rows to ${outPath}`);
}

export async function runAudit(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "verify") {
    const full = rest.includes("--full");
    await withGatewayIpc((c) => runAuditVerify(c, full));
    return;
  }
  if (sub === "export") {
    const outIdx = rest.indexOf("--output");
    const outPath = outIdx >= 0 ? rest[outIdx + 1] : undefined;
    if (outPath === undefined || outPath === "") {
      throw new Error("Usage: nimbus audit export --output <path>");
    }
    await withGatewayIpc((c) =>
      runAuditExport(c, outPath, (p, data) => Bun.write(p, data) as Promise<unknown>),
    );
    return;
  }
  if (sub === "replay") {
    const parsed = parseAuditReplayArgs(rest);
    await withGatewayIpc((c) => runAuditReplay(c, parsed));
    return;
  }
  if (sub === "standing") {
    const json = rest.includes("--json");
    const id = rest.find((a) => !a.startsWith("--"));
    await withGatewayIpc((c) => runAuditStanding(c, id, { json }));
    return;
  }
  if (wantsAuditDoorView(args)) {
    const parsed = parseAuditDoorArgs(args, Date.now());
    await withGatewayIpc((c) => runAuditByDoor(c, parsed));
    return;
  }
  const limit = parseAuditListLimit(args);
  const json = args.includes("--json");
  await withGatewayIpc((c) => runAuditList(c, limit, { json }));
}
