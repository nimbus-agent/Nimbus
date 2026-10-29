import { format } from "node:util";

import type { EvalReport } from "@nimbus-dev/registry-format";

import type { ServerSpec } from "../../connectors/lazy-mesh/slot.ts";
import type { SandboxPolicy } from "../../platform/sandbox/sandbox-policy.ts";
import type { EvalMcpClient, EvalRuntimeDeps } from "./eval-runtime.ts";
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

/** A flag's value: present and not itself a flag (`--package --json` is a usage error). */
function isFlagValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith("--");
}

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
    if (!isFlagValue(value)) return null;
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

/** What a run loads from outside this module; injected in tests, `REAL_EVAL_LOADERS` otherwise. */
export interface EvalRunLoaders {
  /** `@mastra/mcp`, imported only here: inside the run, after console output is redirected. */
  mcp: () => Promise<{
    createClient: (id: string, servers: ReturnType<typeof evalServerDefs>) => McpClientLike;
    readContent: ContentReader;
  }>;
  canConfine: () => Promise<(p: SandboxPolicy) => string | null>;
  sandboxDir: () => Promise<string>;
  runtimeReadPaths: () => Promise<readonly string[]>;
}

export const REAL_EVAL_LOADERS: EvalRunLoaders = {
  mcp: async () => {
    const { MCPClient, getMcpCallToolContent } = await import("@mastra/mcp");
    return {
      // MCPClient's tool type is wider than the slice an eval drives (EvalMcpClient).
      createClient: (id, servers) => new MCPClient({ id, servers }) as unknown as McpClientLike,
      readContent: getMcpCallToolContent,
    };
  },
  canConfine: async () => {
    const runner = await (await import("../../platform/sandbox/index.ts")).createSandboxRunner();
    return (p) => runner.canConfine(p);
  },
  sandboxDir: async () =>
    (await import("../../platform/paths.ts")).createPlatformPathsForCurrentOs().sandboxDir,
  runtimeReadPaths: async () =>
    (await import("../../exec/exec-runtimes.ts")).resolveRuntimeById("bun").requiredReadPaths(),
};

/**
 * The eval runtime's client factory over a dynamically imported `@mastra/mcp`: every server built
 * with `onToolError: "return"` and every reply normalised. Shared by the role and the gateway's
 * installed-extension eval, so the two can never drift apart.
 */
export async function loadEvalClientFactory(
  loaders: Pick<EvalRunLoaders, "mcp"> = REAL_EVAL_LOADERS,
): Promise<EvalRuntimeDeps["createClient"]> {
  const mcp = await loaders.mcp();
  return (id, servers) =>
    adaptEvalClient(mcp.createClient(id, evalServerDefs(servers)), mcp.readContent);
}

/** The real run: load and verify the package, then run its suites in the sandbox. */
export async function defaultEvalRun(
  args: RoleArgs,
  loaders: EvalRunLoaders = REAL_EVAL_LOADERS,
): Promise<EvalRoleDocument> {
  const runtime = await import("./eval-runtime.ts");
  const src = await loadEvalPackage(args.packageDir, {
    ...(args.suiteFile === undefined ? {} : { suiteFile: args.suiteFile }),
  });
  const [createClient, canConfine, sandboxDir, runtimeReadPaths] = await Promise.all([
    loadEvalClientFactory(loaders),
    loaders.canConfine(),
    loaders.sandboxDir(),
    loaders.runtimeReadPaths(),
  ]);
  const report = await runtime.runEvalSession(src, {
    sandboxDir,
    runtimeReadPaths,
    canConfine,
    createClient,
  });
  return { ok: true, extensionId: src.extensionId, version: src.version, report };
}

function toErrorDocument(e: unknown): EvalRoleDocument {
  if (e instanceof EvalRunError) return { ok: false, error: { code: e.code, message: e.message } };
  return { ok: false, error: { code: "ERR_EVAL_INTERNAL", message: messageOf(e) } };
}

/** The slice of a writable stream `exitAfterFlush` needs. */
interface FlushableStream {
  write(s: string, cb: () => void): boolean;
}

/** Exit once stdout has flushed: an empty write completes only after every earlier write. */
export function exitAfterFlush(
  code: number,
  out: FlushableStream = process.stdout,
  exit: (code: number) => void = process.exit.bind(process),
): void {
  out.write("", () => exit(code));
}

export const REAL_ROLE_DEPS: EvalRoleDeps = {
  writeStdout: (s) => {
    process.stdout.write(s);
  },
  writeStderr: (s) => {
    process.stderr.write(s);
  },
  exit: exitAfterFlush,
  run: defaultEvalRun,
};

async function runToDocument(deps: EvalRoleDeps, args: RoleArgs): Promise<EvalRoleDocument> {
  try {
    return await deps.run(args);
  } catch (e: unknown) {
    return toErrorDocument(e);
  }
}

export async function runEvalRole(
  argv: readonly string[],
  deps: EvalRoleDeps = REAL_ROLE_DEPS,
): Promise<void> {
  const args = parseArgs(argv);
  if (args === null) {
    deps.writeStderr(USAGE);
    deps.exit(2);
    return;
  }
  // The document is written INSIDE the redirect: a library line logged after the run but before
  // the restore still goes to stderr, never after the document on stdout.
  await withConsoleOnStderr(deps.writeStderr, async () => {
    const doc = await runToDocument(deps, args);
    deps.writeStdout(`${JSON.stringify(doc)}\n`);
  });
  deps.exit(0);
}
