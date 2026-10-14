import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  formatCaptureDetail,
  formatCaptureTable,
  parseDetail,
  parseList,
  stripControl,
} from "./captures-format.ts";

export const CAPTURES_USAGE =
  "usage: nimbus captures [list] [--state live|proposed|accepted|rejected|revoked] [--kind note|decision|term|link] [--limit 1-200] [--json]\n" +
  "       nimbus captures show <id> [--json]\n" +
  "       nimbus captures revoke <id> [--json]\n" +
  "       nimbus captures accept <id> [--json]\n" +
  "       nimbus captures reject <id> [--json]";

export type CapturesArgs =
  | { verb: "list"; state?: string; kind?: string; limit?: number; json: boolean }
  | { verb: "show" | "revoke" | "accept" | "reject"; id: string; json: boolean };

export function parseCapturesArgs(argv: string[]): CapturesArgs | undefined {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const verb = rest[0] ?? "list";
  if (verb === "show" || verb === "revoke" || verb === "accept" || verb === "reject") {
    const id = rest[1];
    if (id === undefined || id.startsWith("--") || rest.length !== 2) return undefined;
    return { verb, id, json };
  }
  if (verb !== "list" && !verb.startsWith("--")) return undefined;
  const flags = verb === "list" ? rest.slice(1) : rest;
  const out: { verb: "list"; state?: string; kind?: string; limit?: number; json: boolean } = {
    verb: "list",
    json,
  };
  for (let i = 0; i < flags.length; i += 2) {
    const k = flags[i];
    const v = flags[i + 1];
    if (v === undefined || v.startsWith("--")) return undefined;
    if (k === "--state") out.state = v;
    else if (k === "--kind") out.kind = v;
    else if (k === "--limit") {
      if (!/^\d+$/.test(v)) return undefined;
      const n = Number(v);
      if (n < 1 || n > 200) return undefined;
      out.limit = n;
    } else return undefined;
  }
  return out;
}

function kindNoun(nativeRef: string): string {
  if (nativeRef.startsWith("capture:")) return "decision";
  return nativeRef.includes("|") ? "link" : "glossary term";
}

function confirmation(verb: "revoke" | "accept" | "reject", id: string, raw: unknown): string {
  if (verb === "reject") {
    return `Rejected ${id}. Nothing was written; the record is kept 90 days, then pruned.\n`;
  }
  if (verb === "accept") {
    const ref = (raw as { nativeRef?: unknown } | null)?.nativeRef;
    const nativeRef = typeof ref === "string" ? stripControl(ref) : "";
    return `Accepted ${id}: it now counts as a ${kindNoun(nativeRef)} (${nativeRef}) and is labelled agent-authored.\n`;
  }
  return `Revoked ${id}: its item and embeddings are deleted; the record keeps no payload.\n`;
}

type Sink = { out(s: string): void; err(s: string): void };

export async function runCapturesWith(
  c: Pick<IPCClient, "call">,
  a: CapturesArgs,
  sink: Sink,
): Promise<number> {
  try {
    if (a.verb === "list") {
      const params: Record<string, unknown> = {};
      if (a.state !== undefined) params["state"] = a.state;
      if (a.kind !== undefined) params["kind"] = a.kind;
      if (a.limit !== undefined) params["limit"] = a.limit;
      const raw = await c.call<unknown>("captures.list", params);
      sink.out(
        a.json
          ? `${JSON.stringify(raw, undefined, 2)}\n`
          : formatCaptureTable(parseList(raw), Date.now()),
      );
      return 0;
    }
    if (a.verb === "show") {
      const raw = await c.call<unknown>("captures.get", { id: a.id });
      sink.out(
        a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : formatCaptureDetail(parseDetail(raw)),
      );
      return 0;
    }
    const raw = await c.call<unknown>(`captures.${a.verb}`, { id: a.id });
    sink.out(a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : confirmation(a.verb, a.id, raw));
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    // A refusal can quote agent text (a term key, an item id): strip it like every other print.
    else sink.err(`${stripControl(msg)}\n`);
    return 1;
  }
}

export async function runCapturesCmd(argv: string[]): Promise<void> {
  const a = parseCapturesArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${CAPTURES_USAGE}\n`);
    throw new CliExit(2);
  }
  const paths = getCliPlatformPaths();
  const code = await withGatewayIpc(
    (c) =>
      runCapturesWith(c, a, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    paths,
  );
  if (code !== 0) throw new CliExit(code);
}
