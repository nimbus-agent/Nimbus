import { format } from "node:util";

import type { EvalReport } from "@nimbus-dev/registry-format";

import type { ServerSpec } from "../../connectors/lazy-mesh/slot.ts";
import type { EvalMcpClient } from "./eval-runtime.ts";
import { EvalRunError, loadEvalPackage, messageOf } from "./eval-source.ts";

/**
 * The `__nimbus-eval` role: runs one eval and prints EXACTLY ONE JSON document to stdout.
 * Nothing here reads the Vault, the DB or IPC; `@mastra/mcp` is imported only inside the default
 * `run`, after `console.log/info/debug` are routed to stderr, so a stray log line can never
 * corrupt the document.
 */
export type EvalRoleDocument =
  | { ok: true; extensionId: string; version: string; report: EvalReport }
  | { ok: false; error: { code: string; message: string } };

export interface EvalRoleDeps {
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  exit: (code: number) => void;
  run: (args: { packageDir: string; suiteFile?: string }) => Promise<EvalRoleDocument>;
}

const USAGE = "usage: __nimbus-eval --package <absolute dir> [--suite <file>] [--json]\n";

type RoleArgs = { packageDir: string; suiteFile?: string };

/** `--json` is a no-op; anything unknown, repeated or valueless is a usage error (null). */
function parseArgs(argv: readonly string[]): RoleArgs | null {
  let packageDir: string | undefined;
  let suiteFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") continue;
    const isPkg = a === "--package";
    if (!isPkg && a !== "--suite") return null;
    const value = argv[++i];
    if (value === undefined) return null;
    if (isPkg ? packageDir !== undefined : suiteFile !== undefined) return null;
    if (isPkg) packageDir = value;
    else suiteFile = value;
  }
  if (packageDir === undefined) return null;
  return suiteFile === undefined ? { packageDir } : { packageDir, suiteFile };
}

/** Route console.log/info/debug to `write` for the duration of `fn`; always restored. */
export async function withConsoleOnStderr<T>(
  write: (s: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const c = console;
  const saved = { log: c.log, info: c.info, debug: c.debug };
  const redirect =
    () =>
    (...a: unknown[]): void =>
      write(`${format(...a)}
`);
  c.log = redirect();
  c.info = redirect();
  c.debug = redirect();
  try {
    return await fn();
  } finally {
    c.log = saved.log;
    c.info = saved.info;
    c.debug = saved.debug;
  }
}

type ContentReader = (output: unknown) => unknown;
type McpClientLike = {
  listToolsWithErrors(): Promise<{
    tools: Record<string, unknown>;
    errors: Record<string, unknown>;
  }>;
  disconnect(): Promise<void>;
};

/**
 * Every server is built with `onToolError: "return"`: the default ("throw") turns an `isError`
 * reply into a thrown error, which the runtime would score as a crash and respawn over.
 */
export function evalServerDefs(
  servers: Record<string, ServerSpec>,
): Record<string, ServerSpec & { onToolError: "return" }> {
  return Object.fromEntries(
    Object.entries(servers).map(([k, v]) => [k, { ...v, onToolError: "return" as const }]),
  );
}

function isEnvelope(v: unknown): boolean {
  return typeof v === "object" && v !== null && Array.isArray((v as { content?: unknown }).content);
}

/**
 * Normalise a tool result to an MCP envelope. A server that sent `structuredContent` gets its
 * original `content` hidden on a non-enumerable property by `@mastra/mcp`; recover it. `isError`
 * is lost on that path, so such a reply is judged a non-error -- a stated v1 limit.
 */
export function normaliseEvalReply(result: unknown, readContent: ContentReader): unknown {
  if (isEnvelope(result)) return result;
  if (typeof result === "object" && result !== null) {
    const content = readContent(result);
    if (Array.isArray(content)) return { content };
  }
  return result;
}

/** Wrap a client so each tool's `execute` resolves to a normalised envelope. */
export function adaptEvalClient(client: McpClientLike, readContent: ContentReader): EvalMcpClient {
  return {
    disconnect: () => client.disconnect(),
    listToolsWithErrors: async () => {
      const listing = await client.listToolsWithErrors();
      const tools: Awaited<ReturnType<EvalMcpClient["listToolsWithErrors"]>>["tools"] = {};
      for (const [name, tool] of Object.entries(listing.tools)) {
        const execute = (tool as { execute?: (i: unknown, c?: unknown) => Promise<unknown> })
          .execute;
        tools[name] =
          execute === undefined
            ? { ...(tool as object) }
            : {
                ...(tool as object),
                execute: async (input, ctx) =>
                  normaliseEvalReply(await execute.call(tool, input, ctx), readContent),
              };
      }
      return { tools, errors: listing.errors };
    },
  };
}

/** The real run: exported so a test can drive it up to the first thing that fails. */
export async function defaultEvalRun(args: RoleArgs): Promise<EvalRoleDocument> {
  const [{ MCPClient, getMcpCallToolContent }, runtime, sandbox, paths, runtimes] =
    await Promise.all([
      import("@mastra/mcp"),
      import("./eval-runtime.ts"),
      import("../../platform/sandbox/index.ts"),
      import("../../platform/paths.ts"),
      import("../../exec/exec-runtimes.ts"),
    ]);
  const src = await loadEvalPackage(args.packageDir, {
    ...(args.suiteFile === undefined ? {} : { suiteFile: args.suiteFile }),
  });
  const runner = await sandbox.createSandboxRunner();
  const report = await runtime.runEvalSession(src, {
    sandboxDir: paths.createPlatformPathsForCurrentOs().sandboxDir,
    runtimeReadPaths: runtimes.resolveRuntimeById("bun").requiredReadPaths(),
    canConfine: (p) => runner.canConfine(p),
    // MCPClient's tool type is wider than the slice an eval drives (EvalMcpClient).
    createClient: (id, servers) =>
      adaptEvalClient(
        new MCPClient({ id, servers: evalServerDefs(servers) }) as unknown as McpClientLike,
        getMcpCallToolContent,
      ),
  });
  return { ok: true, extensionId: src.extensionId, version: src.version, report };
}

function toErrorDocument(e: unknown): EvalRoleDocument {
  if (e instanceof EvalRunError) return { ok: false, error: { code: e.code, message: e.message } };
  return { ok: false, error: { code: "ERR_EVAL_INTERNAL", message: messageOf(e) } };
}

const REAL_DEPS: EvalRoleDeps = {
  writeStdout: (s) => {
    process.stdout.write(s);
  },
  writeStderr: (s) => {
    process.stderr.write(s);
  },
  // An empty write completes only after every earlier stdout write has flushed.
  exit: (code) => {
    process.stdout.write("", () => process.exit(code));
  },
  run: defaultEvalRun,
};

export async function runEvalRole(
  argv: readonly string[],
  deps: EvalRoleDeps = REAL_DEPS,
): Promise<void> {
  const args = parseArgs(argv);
  if (args === null) {
    deps.writeStderr(USAGE);
    deps.exit(2);
    return;
  }
  let doc: EvalRoleDocument;
  try {
    doc = await withConsoleOnStderr(deps.writeStderr, () => deps.run(args));
  } catch (e: unknown) {
    doc = toErrorDocument(e);
  }
  deps.writeStdout(`${JSON.stringify(doc)}\n`);
  deps.exit(0);
}
