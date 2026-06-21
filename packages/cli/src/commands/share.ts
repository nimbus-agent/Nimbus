import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

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

async function withIpc<T>(fn: (c: IPCClient) => Promise<T>): Promise<T> {
  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

interface ShareRecordRow {
  readonly contentHash: string;
  readonly kind: string;
  readonly createdAt: number;
}

async function runShareCreate(rest: string[]): Promise<void> {
  const a = parseShareCreateArgs(rest);
  if (a.sessionId.length === 0) {
    console.error(
      "Usage: nimbus share create <session-id> [--out <file> | --http | --to-peer <id>]",
    );
    process.exitCode = 1;
    return;
  }
  await withIpc(async (c) => {
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
  });
}

async function runShareList(rest: string[]): Promise<void> {
  await withIpc(async (c) => {
    const { shares } = await c.call<{ shares: ShareRecordRow[] }>("share.list", {
      includeExpired: rest.includes("--all"),
    });
    for (const row of shares) {
      console.log(`${row.contentHash}  ${row.kind}  ${new Date(row.createdAt).toISOString()}`);
    }
  });
}

async function runSharePrune(): Promise<void> {
  await withIpc(async (c) => {
    const r = await c.call<{ removed: number }>("share.prune", {});
    console.log(`Pruned ${r.removed}`);
  });
}

async function runSharePubkey(): Promise<void> {
  await withIpc(async (c) => {
    const r = await c.call<{ pubkey: string }>("share.pubkey", {});
    console.log(r.pubkey);
  });
}

async function runShareApproval(sub: "approve" | "reject", rest: string[]): Promise<void> {
  const requestId = rest[0];
  if (requestId === undefined || requestId.startsWith("--")) {
    console.error(`Usage: nimbus share ${sub} <request-id>`);
    process.exitCode = 1;
    return;
  }
  await withIpc(async (c) => {
    const r = await c.call<{ matched: boolean }>("share.approvalRespond", {
      requestId,
      approved: sub === "approve",
    });
    const verb = sub === "approve" ? "approved" : "rejected";
    console.log(r.matched ? `${verb} ${requestId}` : "no pending share request with that id");
  });
}

async function runShareForward(rest: string[]): Promise<void> {
  const contentHash = rest[0];
  if (contentHash === undefined || contentHash.startsWith("--")) {
    console.error("Usage: nimbus share forward <contentHash> --to-peer <peerId>");
    process.exitCode = 1;
    return;
  }
  const peerIdx = rest.indexOf("--to-peer");
  const peerId = peerIdx >= 0 ? rest[peerIdx + 1] : undefined;
  if (peerId === undefined || peerId.startsWith("--")) {
    console.error("Usage: nimbus share forward <contentHash> --to-peer <peerId>");
    process.exitCode = 1;
    return;
  }
  await withIpc(async (c) => {
    const r = await c.call<{ status: string; delivered?: boolean }>("federation.shareForward", {
      contentHash,
      recipient: peerId,
    });
    if (r.status === "rejected") {
      console.log(`rejected ${contentHash} (owner did not approve the forward)`);
    } else {
      console.log(
        r.delivered
          ? `delivered ${contentHash}`
          : `queued ${contentHash} (recipient not yet paired — will deliver on first pair)`,
      );
    }
  });
}

async function runShareInbox(rest: string[]): Promise<void> {
  await withIpc(async (c) => {
    const { inbox } = await c.call<{
      inbox: Array<{ contentHash: string; kind: string; originLabel: string; hops: number }>;
    }>("share.inbox", { all: rest.includes("--all") });
    for (const row of inbox) {
      const chip = formatAttributionChipInline({ originLabel: row.originLabel, hops: row.hops });
      console.log(`${chip}  ${row.contentHash}  ${row.kind}`);
    }
  });
}

export async function runShare(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "create") return runShareCreate(rest);
  if (sub === "list") return runShareList(rest);
  if (sub === "prune") return runSharePrune();
  if (sub === "pubkey") return runSharePubkey();
  if (sub === "approve" || sub === "reject") return runShareApproval(sub, rest);
  if (sub === "forward") return runShareForward(rest);
  if (sub === "inbox") return runShareInbox(rest);
  console.error("Usage: nimbus share <create|list|prune|pubkey|approve|reject|forward|inbox> ...");
  process.exitCode = 1;
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
    readonly error: number;
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
    `Summary: match ${m.match}, diverged ${m.diverged}, missing-connector ${m.missingConnector}, skipped-non-read ${m.skippedNonRead}, error ${m.error}`,
  );
  return lines.join("\n");
}

export async function runVerifyShare(args: string[]): Promise<void> {
  const replay = args.includes("--replay");
  const input = args.find((a) => !a.startsWith("--"));
  if (input === undefined) {
    console.error("Usage: nimbus verify-share <file|url> [--replay]");
    process.exitCode = 1;
    return;
  }
  const isUrl = input.startsWith("http://") || input.startsWith("https://");
  // Read the local file up front with a friendly error (a missing/unreadable path otherwise crashes
  // with an unhandled rejection). Applies to both the verify and replay paths.
  let params: { input: string } | { bytesB64: string };
  if (isUrl) {
    params = { input };
  } else {
    try {
      params = { bytesB64: Buffer.from(await Bun.file(input).bytes()).toString("base64") };
    } catch {
      console.error(`Cannot read share file: ${input}`);
      process.exitCode = 1;
      return;
    }
  }
  await withIpc(async (c) => {
    if (replay) {
      const r = await c.call<{
        verify: { ok: boolean; signatureValid: boolean; expired: boolean; errors: string[] };
        report: ReplayReportShape;
      }>("share.replay", params);
      console.log(
        `signature: ${r.verify.signatureValid ? "VALID" : "INVALID"}${r.verify.expired ? " (expired)" : ""}`,
      );
      console.log(formatReplayReport(r.report));
      if (!r.verify.ok) {
        console.error(r.verify.errors.join("; ")); // surface why the share is invalid (tamper/expiry)
        process.exitCode = 1;
      }
      return;
    }
    const r = await c.call<{
      ok: boolean;
      signatureValid: boolean;
      contentHashValid: boolean;
      expired: boolean;
      errors: string[];
    }>("share.verify", params);
    console.log(
      `signature: ${r.signatureValid ? "VALID" : "INVALID"}${r.expired ? " (expired)" : ""}`,
    );
    if (!r.ok) {
      console.error(r.errors.join("; "));
      process.exitCode = 1;
    }
  });
}
