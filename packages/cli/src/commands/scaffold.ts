import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { deriveExtensionServiceId, PUBLISHER_ID_RE } from "@nimbus-dev/registry-format";
import { CliExit } from "../lib/cli-exit.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import {
  buildExtensionScaffoldFiles,
  resolveExtensionId,
  SCAFFOLD_MCP_SDK_VERSION,
  SCAFFOLD_SERVER_TEST_TS,
  type ScaffoldFile,
  ScaffoldIdRefusedError,
} from "./scaffold-extension.ts";
import { buildOpenApiScaffoldFiles, openApiReportLines } from "./scaffold-openapi/generate.ts";
import { loadOpenApiDocument, OpenApiLoadError } from "./scaffold-openapi/load.ts";
import { buildOperationModel, OpenApiModelError } from "./scaffold-openapi/model.ts";

export {
  buildExtensionScaffoldFiles,
  extensionNamespaceNote,
  extensionReadmeSteps,
  resolveExtensionId,
  SCAFFOLD_MCP_SDK_VERSION,
  type ScaffoldFile,
  ScaffoldIdRefusedError,
} from "./scaffold-extension.ts";

const EXTENSION_FLAGS_USAGE =
  "nimbus scaffold extension <name> [--publisher <id>] [--from-openapi <path|url> [--max-operations <n>]]";
const USAGE = `Usage: nimbus scaffold mcp <name>  (name: lowercase letters, digits, underscores; 1-62 chars)\n       ${EXTENSION_FLAGS_USAGE}`;
const EXTENSION_USAGE = `Usage: ${EXTENSION_FLAGS_USAGE}  (name: lowercase letters, digits, underscores, starting with a letter or digit; 1-62 chars)`;
const NAME_RE = /^[a-z0-9_]{1,62}$/;
// A published id segment may not start with `_` (GitHub Pages' Jekyll drops it).
const EXTENSION_NAME_RE = /^[a-z0-9][a-z0-9_]{0,61}$/;
const MAX_PUBLISHER_ID_LENGTH = 64;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;
const EXTENSION_FLAGS: ReadonlySet<string> = new Set([
  "--publisher",
  "--from-openapi",
  "--max-operations",
]);

export type ScaffoldArgs =
  | { kind: "mcp"; name: string }
  | {
      kind: "extension";
      name: string;
      publisher?: string;
      fromOpenApi?: string;
      maxOperations?: number;
    };

/** `--flag value` pairs, each flag known and given once with a value that is not itself a flag. */
function readExtensionFlags(rest: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? "";
    const value = rest[i + 1]?.trim();
    if (!EXTENSION_FLAGS.has(flag)) throw new Error(EXTENSION_USAGE);
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${flag} needs a value\n${EXTENSION_USAGE}`);
    }
    if (flags.has(flag)) throw new Error(`${flag} given more than once`);
    flags.set(flag, value);
  }
  return flags;
}

function parseMaxOperations(
  raw: string | undefined,
  fromOpenApi: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  if (fromOpenApi === undefined) throw new Error("--max-operations needs --from-openapi");
  const n = Number(raw);
  if (!POSITIVE_INTEGER_RE.test(raw) || !Number.isSafeInteger(n)) {
    throw new Error(`--max-operations must be a positive integer, got ${raw}`);
  }
  return n;
}

function parseExtensionArgs(args: string[]): ScaffoldArgs {
  const name = args[1]?.trim() ?? "";
  if (!EXTENSION_NAME_RE.test(name)) {
    throw new Error(EXTENSION_USAGE);
  }
  const flags = readExtensionFlags(args.slice(2));
  const publisher = flags.get("--publisher");
  if (publisher !== undefined) {
    const problem = publisherIdProblem(publisher);
    if (problem !== undefined) throw new Error(problem);
  }
  const fromOpenApi = flags.get("--from-openapi");
  const maxOperations = parseMaxOperations(flags.get("--max-operations"), fromOpenApi);
  return {
    kind: "extension",
    name,
    ...(publisher === undefined ? {} : { publisher }),
    ...(fromOpenApi === undefined ? {} : { fromOpenApi }),
    ...(maxOperations === undefined ? {} : { maxOperations }),
  };
}

/**
 * Why `id` cannot be a `--publisher` id, or undefined when it can. Shared by `nimbus scaffold
 * extension` and `nimbus extension clone`, so the two cannot disagree.
 */
export function publisherIdProblem(id: string): string | undefined {
  // A trailing `.` or `.lock` is a git ref component git refuses (`publish/<id>/<version>`).
  if (
    id.length > MAX_PUBLISHER_ID_LENGTH ||
    !PUBLISHER_ID_RE.test(id) ||
    id.endsWith(".") ||
    id.endsWith(".lock")
  ) {
    return `--publisher must match [a-z0-9][a-z0-9._-]*, not ending in '.' or '.lock' (max ${String(MAX_PUBLISHER_ID_LENGTH)} chars)`;
  }
  return undefined;
}

export function parseScaffoldArgs(args: string[]): ScaffoldArgs {
  const kind = args[0]?.trim() ?? "";
  if (kind === "extension") {
    return parseExtensionArgs(args);
  }
  const name = args[1]?.trim() ?? "";
  if (kind !== "mcp" || !NAME_RE.test(name)) {
    throw new Error(USAGE);
  }
  return { kind: "mcp", name };
}

const SERVER_TS = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Build the server. Exported so the test can drive it in memory. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "__NAME__", version: "0.1.0" });
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport());
}
`;

function buildReadme(name: string, platform: NodeJS.Platform, absDir: string): string {
  const isWin = platform === "win32";
  const pathMod = isWin ? win32 : posix;
  const binary = pathMod.join(absDir, "dist", isWin ? `${name}.exe` : name);
  const inputExample = isWin ? String.raw`"{\"text\":\"hi\"}"` : `'{"text":"hi"}'`;
  const inputNote = isWin
    ? "\nWindows PowerShell 5.1 mangles embedded quotes in native-command arguments; use PowerShell 7+ or cmd.\n"
    : "";
  const winNote = isWin
    ? "\nOn Windows, any `--net` grant is all-or-nothing: it opens every internet host rather than one host at a time.\n"
    : "";
  const macNote =
    platform === "darwin"
      ? "\nOn macOS, a `--net` grant limits the port, not the host: the server can reach any host on a declared port.\n"
      : "";
  return `# ${name}

A minimal MCP server with one \`echo\` tool, ready to register with Nimbus.

## Install

\`\`\`
bun install
\`\`\`

## Test

\`\`\`
bun test
\`\`\`

## Build

\`\`\`
bun run build
\`\`\`

This produces \`dist/${name}${isWin ? ".exe" : ""}\`.

## Register

\`\`\`
nimbus connector add --mcp mcp_${name} -- "${binary}"
\`\`\`

## Granting more

By default the server runs confined, with no extra access. Add \`--read <dir>\` for
directories it must read, and \`--net <host>\` for hosts it must reach.
${winNote}${macNote}
## Calling it

\`\`\`
nimbus connector tools mcp_${name}
nimbus connector call mcp_${name} echo --input ${inputExample}
\`\`\`
${inputNote}
Each call asks for your approval first.
`;
}

export function buildScaffoldFiles(
  name: string,
  platform: NodeJS.Platform,
  absDir: string,
): readonly ScaffoldFile[] {
  const pkg = {
    name: `nimbus-mcp-${name}`,
    private: true,
    type: "module",
    scripts: {
      start: "bun src/server.ts",
      test: "bun test",
      build: `bun build --compile src/server.ts --outfile dist/${name}`,
    },
    dependencies: {
      "@modelcontextprotocol/sdk": SCAFFOLD_MCP_SDK_VERSION,
      zod: "^4.6.5",
    },
  };
  return [
    { path: ["package.json"], content: `${JSON.stringify(pkg, undefined, 2)}\n` },
    { path: ["src", "server.ts"], content: SERVER_TS.replaceAll("__NAME__", name) },
    {
      path: ["src", "server.test.ts"],
      content: SCAFFOLD_SERVER_TEST_TS.replaceAll("__NAME__", name),
    },
    { path: ["README.md"], content: buildReadme(name, platform, absDir) },
    { path: [".gitignore"], content: "node_modules/\ndist/\n" },
  ];
}

/** The operation cap when `--max-operations` is not given. */
export const DEFAULT_MAX_OPERATIONS = 200;

/** What `runScaffold` writes and prints, decided before anything touches the disk. */
interface ScaffoldPlan {
  readonly files: readonly ScaffoldFile[];
  readonly summary: string;
  /** Printed after the summary, one line each, control characters already stripped. */
  readonly report: readonly string[];
}

function nextSteps(name: string): string {
  return `next: cd ${name} && bun install && bun test && bun run build`;
}

async function planFromOpenApi(
  name: string,
  publisher: string | undefined,
  source: string,
  maxOperations: number,
  dir: string,
): Promise<ScaffoldPlan> {
  const serviceId = deriveExtensionServiceId(resolveExtensionId(name, publisher));
  const doc = await loadOpenApiDocument(source, {
    fetch,
    readFile: (p) => readFile(p),
    now: Date.now,
  });
  const model = buildOperationModel(doc, { serviceId, maxOperations });
  return {
    files: buildOpenApiScaffoldFiles(name, publisher, process.platform, dir, model),
    summary: `Scaffolded extension at ./${name}/ from ${model.operations.length} operation(s) — ${nextSteps(name)}`,
    report: openApiReportLines(model),
  };
}

async function planScaffold(parsed: ScaffoldArgs, dir: string): Promise<ScaffoldPlan> {
  if (parsed.kind === "mcp") {
    return {
      files: buildScaffoldFiles(parsed.name, process.platform, dir),
      summary: `Scaffolded MCP server at ./${parsed.name}/ — ${nextSteps(parsed.name)}`,
      report: [],
    };
  }
  if (parsed.fromOpenApi !== undefined) {
    return await planFromOpenApi(
      parsed.name,
      parsed.publisher,
      parsed.fromOpenApi,
      parsed.maxOperations ?? DEFAULT_MAX_OPERATIONS,
      dir,
    );
  }
  return {
    files: buildExtensionScaffoldFiles(parsed.name, parsed.publisher, process.platform, dir),
    summary: `Scaffolded extension at ./${parsed.name}/ — ${nextSteps(parsed.name)}`,
    report: [],
  };
}

/** An input the scaffold refuses (exit code 2), as opposed to a usage error or a bug. */
function isRefusal(e: unknown): e is Error {
  return (
    e instanceof ScaffoldIdRefusedError ||
    e instanceof OpenApiLoadError ||
    e instanceof OpenApiModelError
  );
}

/**
 * `nimbus scaffold`. Everything is decided (and an OpenAPI document loaded) before the first
 * write, so a refusal leaves nothing behind.
 */
export async function runScaffold(args: string[]): Promise<void> {
  const parsed = parseScaffoldArgs(args);
  const dir = join(process.cwd(), parsed.name);
  if (existsSync(dir)) {
    throw new Error(`./${parsed.name}/ already exists`);
  }
  let plan: ScaffoldPlan;
  try {
    plan = await planScaffold(parsed, dir);
  } catch (e) {
    if (isRefusal(e)) {
      console.error(stripControlChars(e.message));
      throw new CliExit(2);
    }
    throw e;
  }
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const file of plan.files) {
    const target = join(dir, ...file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  console.log(plan.summary);
  for (const line of plan.report) console.log(line);
}
