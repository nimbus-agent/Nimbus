import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

/**
 * `nimbus incident postmortem <id> ...` (Phase 10 IC7a): a post-mortem draft from an incident record, and the
 * owner's push of the (edited) draft to a Notion or Confluence page.
 *
 *   nimbus incident postmortem <id> [--out <file>] [--force] [--template <file>] [--synthesize] [--json]
 *   nimbus incident postmortem <id> --push notion --parent <page-id> [--file <file>] [--title <t>]
 *   nimbus incident postmortem <id> --push confluence --space <key> [--parent <id>] [--file <file>] [--title <t>]
 *
 * The draft is deterministic; `--synthesize` asks the gateway's model for a rewrite of the prose sections
 * (the timeline, decision log and disclosures are kept verbatim). The push asks YOU at this terminal: the
 * typed preview of the page create appears as an ordinary approval, and this command offers no `--yes`.
 * Everything printed from the gateway is stripped of control and invisible characters.
 */

export const POSTMORTEM_USAGE =
  "Usage: nimbus incident postmortem <id> [--out <file>] [--force] [--template <file>] [--synthesize] [--json]\n" +
  "       nimbus incident postmortem <id> --push notion --parent <page-id> [--file <file>] [--title <t>]\n" +
  "       nimbus incident postmortem <id> --push confluence --space <key> [--parent <id>] [--file <file>] [--title <t>]";

export type PostmortemArgs =
  | {
      readonly mode: "draft";
      readonly id: string;
      readonly json: boolean;
      readonly out?: string;
      readonly force: boolean;
      readonly template?: string;
      readonly synthesize: boolean;
    }
  | {
      readonly mode: "push";
      readonly id: string;
      readonly target: "notion" | "confluence";
      readonly parent?: string;
      readonly space?: string;
      readonly file?: string;
      readonly title?: string;
    };

const VALUE_FLAGS = ["--out", "--template", "--push", "--parent", "--space", "--file", "--title"];
const BOOL_FLAGS = ["--force", "--synthesize", "--json"];

type Flags = { values: Map<string, string>; bools: Set<string>; id: string };

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
  return id === undefined ? undefined : { values, bools, id };
}

function onlyThese(f: Flags, values: readonly string[], bools: readonly string[]): boolean {
  return (
    [...f.values.keys()].every((k) => values.includes(k)) &&
    [...f.bools].every((k) => bools.includes(k))
  );
}

/** Parses the arguments after `postmortem`; `undefined` is a usage error. */
export function parsePostmortemArgs(argv: readonly string[]): PostmortemArgs | undefined {
  const f = scan(argv);
  if (f === undefined) return undefined;
  const push = f.values.get("--push");
  if (push === undefined) {
    if (!onlyThese(f, ["--out", "--template"], BOOL_FLAGS)) return undefined;
    const out = f.values.get("--out");
    const template = f.values.get("--template");
    return {
      mode: "draft",
      id: f.id,
      json: f.bools.has("--json"),
      force: f.bools.has("--force"),
      synthesize: f.bools.has("--synthesize"),
      ...(out === undefined ? {} : { out }),
      ...(template === undefined ? {} : { template }),
    };
  }
  if (push !== "notion" && push !== "confluence") return undefined;
  if (!onlyThese(f, ["--push", "--parent", "--space", "--file", "--title"], [])) return undefined;
  const parent = f.values.get("--parent");
  const space = f.values.get("--space");
  if (push === "notion" && (parent === undefined || space !== undefined)) return undefined;
  if (push === "confluence" && space === undefined) return undefined;
  const file = f.values.get("--file");
  const title = f.values.get("--title");
  return {
    mode: "push",
    id: f.id,
    target: push,
    ...(parent === undefined ? {} : { parent }),
    ...(space === undefined ? {} : { space }),
    ...(file === undefined ? {} : { file }),
    ...(title === undefined ? {} : { title }),
  };
}

/** Control, format (bidi, zero-width) and line or paragraph separator characters out of third-party text. */
export function safeText(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

export interface PostmortemSink {
  out(s: string): void;
  err(s: string): void;
}

/** The file system the command touches, injected so tests use a temp directory and nothing else. */
export interface PostmortemFs {
  readText(path: string, maxBytes: number): string;
  /** Creates the parent directory (0700) and writes the file (0600); `exclusive` refuses an existing path. */
  writeText(path: string, text: string, exclusive: boolean): void;
}

export const realPostmortemFs: PostmortemFs = {
  readText(path, maxBytes) {
    const size = statSync(path).size;
    if (size > maxBytes) throw new Error(`${path} is larger than ${String(maxBytes)} bytes`);
    return readFileSync(path, "utf8");
  },
  writeText(path, text, exclusive) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { flag: exclusive ? "wx" : "w", mode: 0o600 });
  },
};

export type PostmortemEnv = { readonly dataDir: string; readonly fs: PostmortemFs };

type DraftReply = {
  recordId: string;
  version: number;
  markdown: string;
  synthesis: { attempted: boolean; used?: boolean; reason?: string; model?: string } | null;
};

type PushReply =
  | { outcome: "pushed"; pageId: string | null }
  | { outcome: "refused"; code: string; reason: string }
  | { outcome: "denied"; reason: string }
  | { outcome: "partial"; code: string; pageId: string; reason: string }
  | { outcome: "unavailable"; code: string; reason: string };

type GetReply = { record: { summary: { id: string } } | null };

const TEMPLATE_MAX = 70_000;
const FILE_MAX = 300_000;

function defaultPath(env: PostmortemEnv, recordId: string): string {
  return join(env.dataDir, "postmortems", `${recordId}.md`);
}

function synthesisNote(s: DraftReply["synthesis"]): string | undefined {
  if (s === null) return undefined;
  if (s.attempted === false) {
    return `No model was used (${safeText(s.reason ?? "unavailable")}); this is the deterministic draft.\n`;
  }
  if (s.used === true) return `Prose sections rewritten by ${safeText(s.model ?? "the model")}.\n`;
  return `The model's rewrite was not used (${safeText(s.reason ?? "unknown")}); this is the deterministic draft.\n`;
}

async function runDraft(
  c: Pick<IPCClient, "call">,
  a: Extract<PostmortemArgs, { mode: "draft" }>,
  sink: PostmortemSink,
  env: PostmortemEnv,
): Promise<number> {
  const template = a.template === undefined ? undefined : env.fs.readText(a.template, TEMPLATE_MAX);
  await declareCliClientKind(c);
  const r = await c.call<DraftReply>("incident.postmortem", {
    id: a.id,
    ...(template === undefined ? {} : { template }),
    ...(a.synthesize ? { synthesize: true } : {}),
  });
  if (a.json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return 0;
  }
  const path = a.out ?? defaultPath(env, r.recordId);
  try {
    env.fs.writeText(path, r.markdown, !a.force);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "EEXIST") {
      sink.err(
        `${safeText(path)} already exists; pass --force to overwrite it or --out to write elsewhere.\n`,
      );
      return 1;
    }
    throw e;
  }
  sink.out(
    `Wrote the post-mortem draft for ${safeText(r.recordId)} (record version ${String(r.version)}) to ${safeText(path)}\n`,
  );
  const note = synthesisNote(r.synthesis);
  if (note !== undefined) sink.err(note);
  return 0;
}

function pushMessage(r: PushReply): { code: number; text: string } {
  switch (r.outcome) {
    case "pushed":
      return {
        code: 0,
        text: `Pushed. ${r.pageId === null ? "The page was created." : `The page id is ${safeText(r.pageId)}.`}\n`,
      };
    case "refused":
      return { code: 1, text: `Not pushed (${safeText(r.code)}): ${safeText(r.reason)}\n` };
    case "denied":
      return {
        code: 1,
        text: `Not pushed: ${safeText(r.reason)}. Nothing was written.\n`,
      };
    case "partial":
      return {
        code: 1,
        text: `The page was created WITHOUT its body (${safeText(r.code)}). Its id is ${safeText(r.pageId)}; add the body by hand or delete the page.\nReason: ${safeText(r.reason)}\n`,
      };
    default:
      return {
        code: 1,
        text: `The page was created, but its id could not be read, so its body was not added (${safeText(r.code)}). Find the empty page in Notion.\nReason: ${safeText(r.reason)}\n`,
      };
  }
}

async function runPush(
  c: Pick<IPCClient, "call">,
  a: Extract<PostmortemArgs, { mode: "push" }>,
  sink: PostmortemSink,
  env: PostmortemEnv,
): Promise<number> {
  await declareCliClientKind(c);
  const got = await c.call<GetReply>("incident.get", { id: a.id });
  if (got.record === null) {
    sink.err("No incident record has that id; show the incident first so it is assembled.\n");
    return 1;
  }
  const recordId = got.record.summary.id;
  const path = a.file ?? defaultPath(env, recordId);
  let markdown: string;
  try {
    markdown = env.fs.readText(path, FILE_MAX);
  } catch {
    sink.err(
      `Cannot read ${safeText(path)}. Draft it first (nimbus incident postmortem ${safeText(a.id)}) or pass --file.\n`,
    );
    return 1;
  }
  const r = await c.call<PushReply>("incident.postmortemPush", {
    id: a.id,
    target: a.target,
    markdown,
    ...(a.parent === undefined ? {} : { parent: a.parent }),
    ...(a.space === undefined ? {} : { space: a.space }),
    ...(a.title === undefined ? {} : { title: a.title }),
  });
  const m = pushMessage(r);
  if (m.code === 0) sink.out(m.text);
  else sink.err(m.text);
  return m.code;
}

export async function runPostmortemWith(
  c: Pick<IPCClient, "call">,
  a: PostmortemArgs,
  sink: PostmortemSink,
  env: PostmortemEnv,
): Promise<number> {
  try {
    return a.mode === "draft" ? await runDraft(c, a, sink, env) : await runPush(c, a, sink, env);
  } catch (e) {
    sink.err(`${safeText(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

export async function runPostmortemCommand(args: string[]): Promise<void> {
  const a = parsePostmortemArgs(args);
  if (a === undefined) {
    process.stderr.write(`${POSTMORTEM_USAGE}\n`);
    throw new CliExit(1);
  }
  const paths = getCliPlatformPaths();
  const code = await withGatewayIpc(
    (c) =>
      runPostmortemWith(
        c,
        a,
        {
          out: (s) => process.stdout.write(s),
          err: (s) => process.stderr.write(s),
        },
        { dataDir: paths.dataDir, fs: realPostmortemFs },
      ),
    paths,
    // A push waits on the owner's answer, and a synthesis waits on a model.
    { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS },
  );
  if (code !== 0) throw new CliExit(code);
}
