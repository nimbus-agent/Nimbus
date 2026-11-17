import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

/**
 * `nimbus incident update ...` (Phase 10 IC9b): a stakeholder or engineer update drafted from an incident record,
 * the owner's send of it (or of an edited file) to ONE Slack or Teams channel, and the scribe's queue.
 *
 *   nimbus incident update <id> [--audience stakeholders|engineers] [--version <n>] [--out <file>] [--force] [--json]
 *   nimbus incident update <id> --send slack:<channel-id>|teams:<team-id>/<channel-id> [--from <file>] [--audience ..] [--version <n>]
 *   nimbus incident update --queued [--json]
 *
 * The draft is deterministic and drafted from the local index alone. The send asks YOU at this terminal: the typed
 * preview of the post appears as an ordinary approval, and this command offers no `--yes`. Everything printed from
 * the gateway is stripped of control and invisible characters.
 */

export const UPDATE_USAGE =
  "Usage: nimbus incident update <id> [--audience stakeholders|engineers] [--version <n>] [--out <file>] [--force] [--json]\n" +
  "       nimbus incident update <id> --send slack:<channel-id>|teams:<team-id>/<channel-id> [--from <file>] [--audience <a>] [--version <n>]\n" +
  "       nimbus incident update --queued [--json]";

export type UpdateDest =
  | { readonly platform: "slack"; readonly channel: string }
  | { readonly platform: "teams"; readonly teamId: string; readonly channelId: string };

type Common = {
  readonly id: string;
  readonly audience?: "stakeholders" | "engineers";
  readonly version?: number;
};

export type UpdateArgs =
  | { readonly mode: "queue"; readonly json: boolean }
  | (Common & {
      readonly mode: "draft";
      readonly json: boolean;
      readonly out?: string;
      readonly force: boolean;
    })
  | (Common & { readonly mode: "send"; readonly dest: UpdateDest; readonly from?: string });

const VALUE_FLAGS = ["--audience", "--version", "--out", "--send", "--from"];
const BOOL_FLAGS = ["--force", "--json", "--queued"];

type Flags = { values: Map<string, string>; bools: Set<string>; id: string | undefined };

function scan(argv: readonly string[]): Flags | undefined {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  let id: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (BOOL_FLAGS.includes(a)) {
      if (bools.has(a)) return undefined;
      bools.add(a);
    } else if (VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--") || values.has(a)) return undefined;
      values.set(a, v);
      i += 1;
    } else if (a.startsWith("--") || id !== undefined) {
      return undefined;
    } else {
      id = a;
    }
  }
  return { values, bools, id };
}

/** `slack:C0123` or `teams:<team-id>/<19:...thread id>`; `undefined` is a usage error. */
export function parseDest(raw: string): UpdateDest | undefined {
  if (raw.startsWith("slack:")) {
    const channel = raw.slice("slack:".length);
    return /^[A-Z0-9]{2,32}$/.test(channel) ? { platform: "slack", channel } : undefined;
  }
  if (raw.startsWith("teams:")) {
    const rest = raw.slice("teams:".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return undefined;
    const teamId = rest.slice(0, slash);
    const channelId = rest.slice(slash + 1);
    if (!/^[0-9A-Za-z-]{1,64}$/.test(teamId) || !/^19:\S{1,200}$/.test(channelId)) return undefined;
    return { platform: "teams", teamId, channelId };
  }
  return undefined;
}

/** Parses the arguments after `update`; `undefined` is a usage error. */
export function parseUpdateArgs(argv: readonly string[]): UpdateArgs | undefined {
  const f = scan(argv);
  if (f === undefined) return undefined;
  if (f.bools.has("--queued")) {
    if (f.id !== undefined || f.values.size > 0 || f.bools.has("--force")) return undefined;
    return { mode: "queue", json: f.bools.has("--json") };
  }
  if (f.id === undefined) return undefined;
  const audienceRaw = f.values.get("--audience");
  if (audienceRaw !== undefined && audienceRaw !== "stakeholders" && audienceRaw !== "engineers") {
    return undefined;
  }
  const versionRaw = f.values.get("--version");
  let version: number | undefined;
  if (versionRaw !== undefined) {
    if (!/^[1-9][0-9]{0,8}$/.test(versionRaw)) return undefined;
    version = Number(versionRaw);
  }
  const common: Common = {
    id: f.id,
    ...(audienceRaw === undefined ? {} : { audience: audienceRaw }),
    ...(version === undefined ? {} : { version }),
  };
  const sendRaw = f.values.get("--send");
  if (sendRaw === undefined) {
    if (f.values.has("--from")) return undefined;
    const out = f.values.get("--out");
    return {
      ...common,
      mode: "draft",
      json: f.bools.has("--json"),
      force: f.bools.has("--force"),
      ...(out === undefined ? {} : { out }),
    };
  }
  if (f.values.has("--out") || f.bools.size > 0) return undefined;
  const dest = parseDest(sendRaw);
  if (dest === undefined) return undefined;
  const from = f.values.get("--from");
  return { ...common, mode: "send", dest, ...(from === undefined ? {} : { from }) };
}

/** Control, format (bidi, zero-width) and line or paragraph separator characters out of third-party text. */
function safeText(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

/** Line by line, keeping the line structure. */
function cleanLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => stripControlChars(l))
    .join("\n");
}

export interface UpdateSink {
  out(s: string): void;
  err(s: string): void;
}

/** The file system the command touches, injected so tests use a temp directory and nothing else. */
export interface UpdateFs {
  readText(path: string, maxBytes: number): string;
  /** Creates the parent directory (0700) and writes the file (0600); `exclusive` refuses an existing path. */
  writeText(path: string, text: string, exclusive: boolean): void;
}

export const realUpdateFs: UpdateFs = {
  readText(path, maxBytes) {
    // One open file descriptor for the size check and the read, so the file cannot change in between.
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size > maxBytes) throw new Error(`${path} is larger than ${String(maxBytes)} bytes`);
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  },
  writeText(path, text, exclusive) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { flag: exclusive ? "wx" : "w", mode: 0o600 });
  },
};

type DraftReply = {
  recordId: string;
  version: number;
  currentVersion: number;
  audience: string;
  text: string;
};

type SendReply =
  | { outcome: "sent" }
  | { outcome: "refused"; code: string; reason: string }
  | { outcome: "denied"; reason: string };

type QueueReply = { entries: Array<{ recordId: string; version: number; queuedAtMs: number }> };

/** The update file limit: the gateway refuses more than 12,000 characters, so a larger file is never read. */
const FROM_MAX = 64_000;

function draftParams(a: Common): Record<string, unknown> {
  return {
    id: a.id,
    ...(a.audience === undefined ? {} : { audience: a.audience }),
    ...(a.version === undefined ? {} : { version: a.version }),
  };
}

async function runDraft(
  c: Pick<IPCClient, "call">,
  a: Extract<UpdateArgs, { mode: "draft" }>,
  sink: UpdateSink,
  fs: UpdateFs,
): Promise<number> {
  await declareCliClientKind(c);
  const r = await c.call<DraftReply>("incident.update", draftParams(a));
  if (a.json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return 0;
  }
  if (a.out === undefined) {
    sink.out(cleanLines(r.text));
    if (r.version !== r.currentVersion) {
      sink.err(
        `This is version ${String(r.version)}; the record is now at version ${String(r.currentVersion)}.\n`,
      );
    }
    return 0;
  }
  try {
    fs.writeText(a.out, r.text, !a.force);
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") {
      sink.err(`${safeText(a.out)} already exists; pass --force to overwrite it.\n`);
      return 1;
    }
    throw e;
  }
  sink.out(
    `Wrote the ${safeText(r.audience)} update for ${safeText(r.recordId)} (version ${String(r.version)}) to ${safeText(a.out)}\n`,
  );
  return 0;
}

function sendMessage(r: SendReply): { code: number; text: string } {
  switch (r.outcome) {
    case "sent":
      return { code: 0, text: "Sent.\n" };
    case "refused":
      return { code: 1, text: `Not sent (${safeText(r.code)}): ${safeText(r.reason)}\n` };
    default:
      return { code: 1, text: `Not sent: ${safeText(r.reason)}. Nothing was posted.\n` };
  }
}

async function runSend(
  c: Pick<IPCClient, "call">,
  a: Extract<UpdateArgs, { mode: "send" }>,
  sink: UpdateSink,
  fs: UpdateFs,
): Promise<number> {
  let text: string;
  if (a.from === undefined) {
    await declareCliClientKind(c);
    text = (await c.call<DraftReply>("incident.update", draftParams(a))).text;
  } else {
    try {
      text = fs.readText(a.from, FROM_MAX);
    } catch {
      sink.err(`Cannot read ${safeText(a.from)}.\n`);
      return 1;
    }
    await declareCliClientKind(c);
  }
  const dest =
    a.dest.platform === "slack"
      ? { platform: "slack", channel: a.dest.channel }
      : { platform: "teams", teamId: a.dest.teamId, channelId: a.dest.channelId };
  const r = await c.call<SendReply>("incident.updateSend", { id: a.id, ...dest, text });
  const m = sendMessage(r);
  if (m.code === 0) sink.out(m.text);
  else sink.err(m.text);
  return m.code;
}

async function runQueue(
  c: Pick<IPCClient, "call">,
  a: Extract<UpdateArgs, { mode: "queue" }>,
  sink: UpdateSink,
): Promise<number> {
  await declareCliClientKind(c);
  const r = await c.call<QueueReply>("incident.updateQueue", {});
  if (a.json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return 0;
  }
  if (r.entries.length === 0) {
    sink.out(
      "No update drafts are waiting. The scribe queues one per new record version when [incident.scribe] enabled = true.\n",
    );
    return 0;
  }
  for (const e of r.entries) {
    const at = new Date(e.queuedAtMs).toISOString().slice(0, 16).replace("T", " ");
    sink.out(
      `${safeText(e.recordId)} v${String(e.version)}  queued ${at} UTC  nimbus incident update ${safeText(e.recordId)} --version ${String(e.version)}\n`,
    );
  }
  return 0;
}

export async function runUpdateWith(
  c: Pick<IPCClient, "call">,
  a: UpdateArgs,
  sink: UpdateSink,
  fs: UpdateFs,
): Promise<number> {
  try {
    if (a.mode === "queue") return await runQueue(c, a, sink);
    if (a.mode === "draft") return await runDraft(c, a, sink, fs);
    return await runSend(c, a, sink, fs);
  } catch (e) {
    sink.err(`${safeText(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

export async function runUpdateCommand(args: string[]): Promise<void> {
  const a = parseUpdateArgs(args);
  if (a === undefined) {
    process.stderr.write(`${UPDATE_USAGE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(
    (c) =>
      runUpdateWith(
        c,
        a,
        {
          out: (s) => process.stdout.write(s),
          err: (s) => process.stderr.write(s),
        },
        realUpdateFs,
      ),
    getCliPlatformPaths(),
    // A send blocks on the executor's prompt, which only a person answers (as `nimbus incident remediate`).
    a.mode === "send"
      ? { consent: { kind: "human" }, requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS }
      : undefined,
  );
  if (code !== 0) throw new CliExit(code);
}
