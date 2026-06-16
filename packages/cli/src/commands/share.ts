import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

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
  const sink: ShareSinkArg =
    out !== undefined
      ? { type: "file", path: out }
      : args.includes("--http")
        ? { type: "http" }
        : peer !== undefined
          ? { type: "peer", peerId: peer }
          : { type: "file" };
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

export async function runShare(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "create") {
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
    return;
  }
  if (sub === "list") {
    await withIpc(async (c) => {
      const { shares } = await c.call<{ shares: ShareRecordRow[] }>("share.list", {
        includeExpired: rest.includes("--all"),
      });
      for (const row of shares) {
        console.log(`${row.contentHash}  ${row.kind}  ${new Date(row.createdAt).toISOString()}`);
      }
    });
    return;
  }
  if (sub === "prune") {
    await withIpc(async (c) => {
      const r = await c.call<{ removed: number }>("share.prune", {});
      console.log(`Pruned ${r.removed}`);
    });
    return;
  }
  if (sub === "pubkey") {
    await withIpc(async (c) => {
      const r = await c.call<{ pubkey: string }>("share.pubkey", {});
      console.log(r.pubkey);
    });
    return;
  }
  if (sub === "approve" || sub === "reject") {
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
    return;
  }
  console.error("Usage: nimbus share <create|list|prune|pubkey|approve|reject> ...");
  process.exitCode = 1;
}

export async function runVerifyShare(args: string[]): Promise<void> {
  const input = args[0];
  if (input === undefined) {
    console.error("Usage: nimbus verify-share <file|url>");
    process.exitCode = 1;
    return;
  }
  const isUrl = input.startsWith("http://") || input.startsWith("https://");
  await withIpc(async (c) => {
    const params = isUrl
      ? { input }
      : { bytesB64: Buffer.from(await Bun.file(input).bytes()).toString("base64") };
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
