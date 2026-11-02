import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { format } from "node:util";

import {
  buildRecordedSuite,
  type EvalBaselineDocument,
  type EvalRecordDocument,
  type EvalRecordInputs,
  type EvalRoleDocument,
  MAX_EVAL_RECORD_INPUTS_BYTES,
  parseEvalRecordInputs,
  RegistryError,
} from "@nimbus-dev/registry-format";

import type { ServerSpec } from "../../connectors/lazy-mesh/slot.ts";
import type { SandboxPolicy } from "../../platform/sandbox/sandbox-policy.ts";
import type { EvalBaselineDeps, EvalMcpClient, EvalRuntimeDeps } from "./eval-runtime.ts";
import { EvalRunError, loadEvalPackage, messageOf } from "./eval-source.ts";

/**
 * The `__nimbus-eval` role: runs one eval and prints EXACTLY ONE JSON document to stdout.
 * Nothing here reads the Vault, the DB or IPC; `@mastra/mcp` is imported only inside the default
 * `run`, after `console.log/info/debug` are routed to stderr, so a stray log line can never
 * corrupt the document. The document's type and its one validator live in registry-format.
 */

export interface EvalRoleDeps {
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  exit: (code: number) => void;
  run: (args: { packageDir: string; suiteFile?: string }) => Promise<EvalRoleDocument>;
  runBaseline: (args: { packageDir: string }) => Promise<EvalBaselineDocument>;
  runRecord: (args: { packageDir: string; inputsFile: string }) => Promise<EvalRecordDocument>;
}

const USAGE =
  "usage: __nimbus-eval --package <absolute dir> [--suite <file> | --baseline | --record <absolute file>] [--json]\n";

type RoleArgs =
  | { packageDir: string; baseline: true }
  | { packageDir: string; inputsFile: string; record: true }
  | { packageDir: string; suiteFile?: string };

/** A flag's value: present and not itself a flag (`--package --json` is a usage error). */
function isFlagValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith("--");
}

interface ParsedFlags {
  packageDir?: string;
  suiteFile?: string;
  inputsFile?: string;
  baseline: boolean;
}

const VALUE_FLAGS = {
  "--package": "packageDir",
  "--suite": "suiteFile",
  "--record": "inputsFile",
} as const;

/** Take the flag at `argv[i]` (a value flag also takes `argv[i + 1]`); the next index, or null. */
function takeFlag(argv: readonly string[], i: number, f: ParsedFlags): number | null {
  const a = argv[i];
  if (a === "--json") return i + 1;
  if (a === "--baseline") {
    if (f.baseline) return null;
    f.baseline = true;
    return i + 1;
  }
  if (a === undefined || !Object.hasOwn(VALUE_FLAGS, a)) return null;
  const slot = VALUE_FLAGS[a as keyof typeof VALUE_FLAGS];
  const value = argv[i + 1];
  if (!isFlagValue(value) || f[slot] !== undefined) return null;
  f[slot] = value;
  return i + 2;
}

/**
 * `--json` is a no-op; anything unknown, repeated or valueless is a usage error (null), and so is
 * more than one of `--baseline`, `--suite` and `--record`. `--record` takes an absolute path.
 */
function parseArgs(argv: readonly string[]): RoleArgs | null {
  const f: ParsedFlags = { baseline: false };
  for (let i = 0; i < argv.length; ) {
    const next = takeFlag(argv, i, f);
    if (next === null) return null;
    i = next;
  }
  const { packageDir, suiteFile, inputsFile, baseline } = f;
  if (packageDir === undefined) return null;
  if ([baseline, suiteFile !== undefined, inputsFile !== undefined].filter(Boolean).length > 1) {
    return null;
  }
  if (baseline) return { packageDir, baseline: true };
  if (inputsFile !== undefined) {
    return isAbsolute(inputsFile) ? { packageDir, inputsFile, record: true } : null;
  }
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

type EvalListingClientLike = ReturnType<EvalBaselineDeps["createClient"]>;

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
  /** The baseline's listing client factory; `@mastra/mcp` is imported inside the call. */
  listingClient: () => Promise<EvalBaselineDeps["createClient"]>;
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
    // No network by construction (I49), so no forwarder to probe.
    const { createSandboxRunner } = await import("../../platform/sandbox/index.ts");
    const runner = await createSandboxRunner({ forwarderStartProbe: false });
    return (p) => runner.canConfine(p);
  },
  sandboxDir: async () =>
    (await import("../../platform/paths.ts")).createPlatformPathsForCurrentOs().sandboxDir,
  runtimeReadPaths: async () =>
    (await import("../../exec/exec-runtimes.ts")).resolveRuntimeById("bun").requiredReadPaths(),
  listingClient: async () => {
    const { MCPClient } = await import("@mastra/mcp");
    // The one client the baseline drives, over the same server definitions as a suite run.
    return (id, servers) =>
      new MCPClient({ id, servers: evalServerDefs(servers) }) as unknown as EvalListingClientLike;
  },
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
  args: { packageDir: string; suiteFile?: string },
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

/** The baseline run: load and verify the package (no suites read), then list its tools in the sandbox. */
export async function defaultEvalBaselineRun(
  args: { packageDir: string },
  loaders: EvalRunLoaders = REAL_EVAL_LOADERS,
): Promise<EvalBaselineDocument> {
  const runtime = await import("./eval-runtime.ts");
  const src = await loadEvalPackage(args.packageDir, { baselineOnly: true });
  const [createClient, canConfine, sandboxDir, runtimeReadPaths] = await Promise.all([
    loaders.listingClient(),
    loaders.canConfine(),
    loaders.sandboxDir(),
    loaders.runtimeReadPaths(),
  ]);
  const baseline = await runtime.runEvalBaselineSession(src, {
    sandboxDir,
    runtimeReadPaths,
    canConfine,
    createClient,
  });
  return { ok: true, extensionId: src.extensionId, version: src.version, baseline };
}

function inputsInvalid(why: string): EvalRunError {
  return new EvalRunError("ERR_EVAL_RECORD_INPUTS_INVALID", `inputs file: ${why}`);
}

/** At most MAX + 1 bytes from `fd`, however large or endless the source is. */
function readBounded(fd: number): Buffer {
  const buf = Buffer.alloc(MAX_EVAL_RECORD_INPUTS_BYTES + 1);
  let filled = 0;
  while (filled < buf.length) {
    const n = readSync(fd, buf, filled, buf.length - filled, null);
    if (n === 0) break;
    filled += n;
  }
  return buf.subarray(0, filled);
}

/**
 * The inputs file, read through ONE descriptor: it must be a regular file within the cap, and the
 * read itself stops one byte past the cap, so a file that grows, or a device, is never read
 * without limit. Text from the OS is not copied into the error.
 */
function readInputsFile(path: string): Uint8Array {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    throw inputsInvalid("could not be opened");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw inputsInvalid("not a regular file");
    if (st.size > MAX_EVAL_RECORD_INPUTS_BYTES) throw inputsInvalid("too large");
    const bytes = readBounded(fd);
    if (bytes.byteLength > MAX_EVAL_RECORD_INPUTS_BYTES) throw inputsInvalid("too large");
    return bytes;
  } catch (e) {
    if (e instanceof EvalRunError) throw e;
    throw inputsInvalid("could not be read");
  } finally {
    closeSync(fd);
  }
}

function parseInputsFile(path: string): EvalRecordInputs {
  const bytes = readInputsFile(path);
  try {
    return parseEvalRecordInputs("inputs", bytes);
  } catch (e) {
    if (e instanceof RegistryError) throw inputsInvalid(e.message);
    throw e;
  }
}

/**
 * The record run: load and verify the package (no suites read), read the inputs once, call each
 * input twice in the sandbox, and keep what both passes agree on. Writes nothing.
 */
export async function defaultEvalRecordRun(
  args: { packageDir: string; inputsFile: string },
  loaders: EvalRunLoaders = REAL_EVAL_LOADERS,
): Promise<EvalRecordDocument> {
  const runtime = await import("./eval-runtime.ts");
  const src = await loadEvalPackage(args.packageDir, { baselineOnly: true });
  const inputs = parseInputsFile(args.inputsFile);
  const [createClient, canConfine, sandboxDir, runtimeReadPaths] = await Promise.all([
    loadEvalClientFactory(loaders),
    loaders.canConfine(),
    loaders.sandboxDir(),
    loaders.runtimeReadPaths(),
  ]);
  const { first, second } = await runtime.runEvalRecordSession(src, inputs, {
    sandboxDir,
    runtimeReadPaths,
    canConfine,
    createClient,
  });
  const { suite, skipped } = buildRecordedSuite(inputs, first, second);
  if (suite.cases.length === 0) {
    return {
      ok: false,
      error: { code: "ERR_EVAL_RECORD_EMPTY", message: "no case could be recorded", skipped },
    };
  }
  return { ok: true, extensionId: src.extensionId, version: src.version, suite, skipped };
}

function toErrorDocument(e: unknown): { ok: false; error: { code: string; message: string } } {
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
  runBaseline: defaultEvalBaselineRun,
  runRecord: defaultEvalRecordRun,
};

async function runToDocument(
  deps: EvalRoleDeps,
  args: RoleArgs,
): Promise<EvalRoleDocument | EvalBaselineDocument | EvalRecordDocument> {
  try {
    if ("baseline" in args) return await deps.runBaseline({ packageDir: args.packageDir });
    if ("record" in args) {
      return await deps.runRecord({ packageDir: args.packageDir, inputsFile: args.inputsFile });
    }
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
