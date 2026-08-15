import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/**
 * Render the provenance attribution chip for a received/forwarded share (spec §9.3).
 * Inlined from packages/gateway/src/share/attribution.ts — CLI cannot import gateway source.
 */
function formatAttributionChipInline(p: { originLabel: string; hops: number }): string {
  if (p.hops <= 0) return `from ${p.originLabel} (direct)`;
  const unit = p.hops === 1 ? "hop" : "hops";
  return `forwarded from ${p.originLabel}, ${p.hops} ${unit} away`;
}

export type ShareSinkArg =
  | { readonly type: "file"; readonly path?: string }
  | { readonly type: "http" }
  | { readonly type: "peer"; readonly peerId: string };

export interface ShareCreateArgs {
  readonly sessionId: string;
  readonly sink: ShareSinkArg;
  readonly expiresMs: number | null;
  readonly redact: readonly string[];
  readonly asRecipe: boolean;
}

/** Minimal client surface used by the share dispatcher — satisfied by IPCClient. */
export interface ShareIpc {
  call<T>(method: string, params?: unknown): Promise<T>;
}

export type ShareCommand =
  | { kind: "create"; create: ShareCreateArgs }
  | { kind: "list"; all: boolean }
  | { kind: "prune" }
  | { kind: "pubkey" }
  | { kind: "approval"; approve: boolean; requestId: string }
  | { kind: "forward"; contentHash: string; peerId: string }
  | { kind: "inbox"; all: boolean };

const SHARE_USAGE =
  "Usage: nimbus share <create|list|prune|pubkey|approve|reject|forward|inbox> ...";
const CREATE_USAGE =
  "Usage: nimbus share create <session-id> [--out <file> | --http | --to-peer <id>]";
const FORWARD_USAGE = "Usage: nimbus share forward <contentHash> --to-peer <peerId>";

const DURATION = /^(\d+)([smhd])$/;
function parseDuration(s: string): number | null {
  const m = DURATION.exec(s);
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? "0", 10);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "s"] ?? 1000;
  return n * unit;
}

export function parseShareCreateArgs(args: readonly string[]): ShareCreateArgs {
  const sessionId = args[0] ?? "";
  // Reject an option whose value is missing or is itself another flag (e.g. `--out --http`),
  // rather than silently consuming the next token as the value.
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return v;
  };
  const out = flag("--out");
  const peer = flag("--to-peer");
  // Precedence: explicit --out file > --http > --to-peer > default file. Early returns keep each
  // branch a positive guard (no negated-condition-with-else) and avoid a nested ternary.
  const resolveSink = (): ShareSinkArg => {
    if (out !== undefined) return { type: "file", path: out };
    if (args.includes("--http")) return { type: "http" };
    if (peer !== undefined) return { type: "peer", peerId: peer };
    return { type: "file" };
  };
  const sink = resolveSink();
  const exp = flag("--expires");
  const redact: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--redact") continue;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error("--redact requires a value");
    redact.push(v);
  }
  return {
    sessionId,
    sink,
    expiresMs: exp === undefined ? null : parseDuration(exp),
    redact,
    asRecipe: args.includes("--as-recipe"),
  };
}

function parseApprovalArgs(sub: "approve" | "reject", rest: readonly string[]): ShareCommand {
  const requestId = rest[0];
  if (requestId === undefined || requestId.startsWith("--")) {
    throw new Error(`Usage: nimbus share ${sub} <request-id>`);
  }
  return { kind: "approval", approve: sub === "approve", requestId };
}

function parseForwardArgs(rest: readonly string[]): ShareCommand {
  const contentHash = rest[0];
  if (contentHash === undefined || contentHash.startsWith("--")) {
    throw new Error(FORWARD_USAGE);
  }
  const peerIdx = rest.indexOf("--to-peer");
  const peerId = peerIdx >= 0 ? rest[peerIdx + 1] : undefined;
  if (peerId === undefined || peerId.startsWith("--")) {
    throw new Error(FORWARD_USAGE);
  }
  return { kind: "forward", contentHash, peerId };
}

/**
 * Parse `nimbus share …` argv into a command. Throws with the exact usage text the user sees on
 * stderr; the caller turns that into `exitCode = 1` without ever opening an IPC connection.
 */
export function parseShareArgs(argv: readonly string[]): ShareCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "create": {
      const create = parseShareCreateArgs(rest);
      // The session id is positional, so `nimbus share create --out f.json` would otherwise bind
      // `--out` as the id, clear the `length === 0` check, and open an IPC connection with a bogus
      // session. Reject a flag-shaped positional the way parseApprovalArgs/parseForwardArgs do.
      if (create.sessionId.length === 0 || create.sessionId.startsWith("--")) {
        throw new Error(CREATE_USAGE);
      }
      return { kind: "create", create };
    }
    case "list":
      return { kind: "list", all: rest.includes("--all") };
    case "prune":
      return { kind: "prune" };
    case "pubkey":
      return { kind: "pubkey" };
    case "approve":
    case "reject":
      return parseApprovalArgs(sub, rest);
    case "forward":
      return parseForwardArgs(rest);
    case "inbox":
      return { kind: "inbox", all: rest.includes("--all") };
    default:
      throw new Error(SHARE_USAGE);
  }
}

interface ShareRecordRow {
  readonly contentHash: string;
  readonly kind: string;
  readonly createdAt: number;
}

async function runShareCreate(c: ShareIpc, a: ShareCreateArgs): Promise<void> {
  const r = await c.call<{ status: string; contentHash?: string }>("share.create", {
    sessionId: a.sessionId,
    kind: a.asRecipe ? "recipe" : "transcript",
    sink: a.sink,
    expiresMs: a.expiresMs,
    redact: a.redact,
  });
  if (r.status === "ok") {
    console.log(`Shared: ${r.contentHash ?? "(no content hash)"}`);
  } else {
    console.log(`Share ${r.status}`);
    process.exitCode = 1;
  }
}

async function runShareList(c: ShareIpc, all: boolean): Promise<void> {
  const { shares } = await c.call<{ shares: ShareRecordRow[] }>("share.list", {
    includeExpired: all,
  });
  for (const row of shares) {
    console.log(`${row.contentHash}  ${row.kind}  ${new Date(row.createdAt).toISOString()}`);
  }
}

async function runSharePrune(c: ShareIpc): Promise<void> {
  const r = await c.call<{ removed: number }>("share.prune", {});
  console.log(`Pruned ${r.removed}`);
}

async function runSharePubkey(c: ShareIpc): Promise<void> {
  const r = await c.call<{ pubkey: string }>("share.pubkey", {});
  console.log(r.pubkey);
}

async function runShareApproval(c: ShareIpc, approve: boolean, requestId: string): Promise<void> {
  const r = await c.call<{ matched: boolean }>("share.approvalRespond", {
    requestId,
    approved: approve,
  });
  const verb = approve ? "approved" : "rejected";
  console.log(r.matched ? `${verb} ${requestId}` : "no pending share request with that id");
}

async function runShareForward(c: ShareIpc, contentHash: string, peerId: string): Promise<void> {
  const r = await c.call<{ status: string; delivered?: boolean }>("federation.shareForward", {
    contentHash,
    recipient: peerId,
  });
  if (r.status === "rejected") {
    console.log(`rejected ${contentHash} (owner did not approve the forward)`);
    return;
  }
  console.log(
    r.delivered
      ? `delivered ${contentHash}`
      : `queued ${contentHash} (recipient not yet paired — will deliver on first pair)`,
  );
}

async function runShareInbox(c: ShareIpc, all: boolean): Promise<void> {
  const { inbox } = await c.call<{
    inbox: Array<{ contentHash: string; kind: string; originLabel: string; hops: number }>;
  }>("share.inbox", { all });
  for (const row of inbox) {
    const chip = formatAttributionChipInline({ originLabel: row.originLabel, hops: row.hops });
    console.log(`${chip}  ${row.contentHash}  ${row.kind}`);
  }
}

/** Execute a parsed share subcommand over an injected client (test entry point + runtime path). */
export async function runShareCommand(client: ShareIpc, cmd: ShareCommand): Promise<void> {
  switch (cmd.kind) {
    case "create":
      return runShareCreate(client, cmd.create);
    case "list":
      return runShareList(client, cmd.all);
    case "prune":
      return runSharePrune(client);
    case "pubkey":
      return runSharePubkey(client);
    case "approval":
      return runShareApproval(client, cmd.approve, cmd.requestId);
    case "forward":
      return runShareForward(client, cmd.contentHash, cmd.peerId);
    case "inbox":
      return runShareInbox(client, cmd.all);
  }
}

export async function runShare(args: string[]): Promise<void> {
  let cmd: ShareCommand;
  try {
    cmd = parseShareArgs(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }
  await withGatewayIpc((c) => runShareCommand(c, cmd));
}

interface ReplayStepShape {
  readonly stepId: string;
  readonly tool: string;
  readonly service: string;
  readonly status: string;
  readonly originalStatus: string;
  readonly detail?: string;
}
interface ReplayReportShape {
  readonly sourceSessionId: string;
  readonly steps: readonly ReplayStepShape[];
  readonly summary: {
    readonly total: number;
    readonly match: number;
    readonly diverged: number;
    readonly missingConnector: number;
    readonly skippedNonRead: number;
    /** Steps whose params failed the gateway's shape guard and were not executed. */
    readonly skippedInvalidParams?: number;
    readonly error: number;
    /** Steps beyond the gateway's per-replay ceiling that were not executed. */
    readonly capped?: number;
  };
}

/** Pure renderer for the replay divergence report (one line per step + a summary). */
export function formatReplayReport(report: ReplayReportShape): string {
  const lines: string[] = [
    `Replay of session ${report.sourceSessionId} (${report.summary.total} steps):`,
  ];
  if (report.steps.length === 0) {
    lines.push("  (no replayable steps in this share)");
  }
  for (const s of report.steps) {
    const suffix = s.detail === undefined ? "" : ` — ${s.detail}`;
    lines.push(`  ${s.stepId}  ${s.status.padEnd(18)} ${s.tool}${suffix}`);
  }
  const m = report.summary;
  lines.push(
    `Summary: match ${m.match}, diverged ${m.diverged}, missing-connector ${m.missingConnector}, skipped-non-read ${m.skippedNonRead}, skipped-invalid-params ${m.skippedInvalidParams ?? 0}, error ${m.error}`,
  );
  // Never let a truncated replay read as a complete one.
  if (m.capped !== undefined && m.capped > 0) {
    lines.push(`  ${m.capped} further step(s) were NOT executed (per-replay ceiling reached).`);
  }
  return lines.join("\n");
}

export interface VerifyShareRequest {
  readonly replay: boolean;
  /**
   * Either a passthrough URL (`share.verify` fetches it) or the base64 bytes of a local file.
   * `allowUnsigned` is present only when the caller explicitly opted out of verification gating.
   */
  readonly params:
    | { readonly input: string; readonly allowUnsigned?: true }
    | { readonly bytesB64: string; readonly allowUnsigned?: true };
}

/**
 * Resolve `nimbus verify-share …` argv into a request for the gateway. A URL is passed through
 * as-is; a local path is read up front with a friendly error (a missing/unreadable path otherwise
 * crashes with an unhandled rejection). Returns `null` after printing the user-facing error and
 * setting the exit code, so the caller never opens an IPC connection for an unusable input.
 */
export async function resolveVerifyShareRequest(
  args: readonly string[],
): Promise<VerifyShareRequest | null> {
  const replay = args.includes("--replay");
  // Replay refuses an unverifiable share by default; this makes that override reachable, and
  // deliberately spells out what it means rather than hiding behind a terse flag name.
  const allowUnsigned = args.includes("--allow-unsigned");
  const input = args.find((a) => !a.startsWith("--"));
  if (input === undefined) {
    console.error("Usage: nimbus verify-share <file|url> [--replay] [--allow-unsigned]");
    process.exitCode = 1;
    return null;
  }
  const extra: { allowUnsigned?: true } = allowUnsigned ? { allowUnsigned: true } : {};
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return { replay, params: { input, ...extra } };
  }
  try {
    const bytesB64 = Buffer.from(await Bun.file(input).bytes()).toString("base64");
    return { replay, params: { bytesB64, ...extra } };
  } catch {
    console.error(`Cannot read share file: ${input}`);
    process.exitCode = 1;
    return null;
  }
}

interface VerifyOutcome {
  readonly ok: boolean;
  readonly signatureValid: boolean;
  readonly expired: boolean;
  readonly errors: string[];
}

function printSignatureLine(v: { signatureValid: boolean; expired: boolean }): void {
  console.log(
    `signature: ${v.signatureValid ? "VALID" : "INVALID"}${v.expired ? " (expired)" : ""}`,
  );
}

/** Execute a resolved verify/replay request over an injected client. */
export async function runVerifyShareCommand(
  client: ShareIpc,
  req: VerifyShareRequest,
): Promise<void> {
  if (req.replay) {
    const r = await client.call<{ verify: VerifyOutcome; report: ReplayReportShape }>(
      "share.replay",
      req.params,
    );
    printSignatureLine(r.verify);
    console.log(formatReplayReport(r.report));
    if (!r.verify.ok) {
      console.error(r.verify.errors.join("; ")); // surface why the share is invalid (tamper/expiry)
      process.exitCode = 1;
    }
    return;
  }
  const r = await client.call<VerifyOutcome & { contentHashValid: boolean }>(
    "share.verify",
    req.params,
  );
  printSignatureLine(r);
  if (!r.ok) {
    console.error(r.errors.join("; "));
    process.exitCode = 1;
  }
}

export async function runVerifyShare(args: string[]): Promise<void> {
  const req = await resolveVerifyShareRequest(args);
  if (req === null) return;
  await withGatewayIpc((c) => runVerifyShareCommand(c, req));
}
