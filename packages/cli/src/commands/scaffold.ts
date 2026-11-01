import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import {
  assertCanonicalExtensionId,
  assertPublishableExtensionId,
  assertSafeExtensionId,
  deriveExtensionServiceId,
  PUBLISHER_ID_RE,
  RegistryError,
} from "@nimbus-dev/registry-format";
import { CliExit } from "../lib/cli-exit.ts";

/** Pinned to the CLI's own `@modelcontextprotocol/sdk` dependency; a test enforces equality. */
export const SCAFFOLD_MCP_SDK_VERSION = "1.32.0";

const USAGE =
  "Usage: nimbus scaffold mcp <name>  (name: lowercase letters, digits, underscores; 1-62 chars)\n       nimbus scaffold extension <name> [--publisher <id>]";
const EXTENSION_USAGE =
  "Usage: nimbus scaffold extension <name> [--publisher <id>]  (name: lowercase letters, digits, underscores, starting with a letter or digit; 1-62 chars)";
const NAME_RE = /^[a-z0-9_]{1,62}$/;
// A published id segment may not start with `_` (GitHub Pages' Jekyll drops it).
const EXTENSION_NAME_RE = /^[a-z0-9][a-z0-9_]{0,61}$/;
const MAX_PUBLISHER_ID_LENGTH = 64;

export type ScaffoldArgs =
  | { kind: "mcp"; name: string }
  | { kind: "extension"; name: string; publisher?: string };

function parseExtensionArgs(args: string[]): ScaffoldArgs {
  const name = args[1]?.trim() ?? "";
  if (!EXTENSION_NAME_RE.test(name)) {
    throw new Error(EXTENSION_USAGE);
  }
  const rest = args.slice(2);
  if (rest.length === 0) {
    return { kind: "extension", name };
  }
  if (rest.length !== 2 || rest[0] !== "--publisher") {
    throw new Error(EXTENSION_USAGE);
  }
  const publisher = rest[1]?.trim() ?? "";
  // A trailing `.` or `.lock` is a git ref component git refuses (`publish/<id>/<version>`).
  if (
    publisher.length > MAX_PUBLISHER_ID_LENGTH ||
    !PUBLISHER_ID_RE.test(publisher) ||
    publisher.endsWith(".") ||
    publisher.endsWith(".lock")
  ) {
    throw new Error(
      `--publisher must match [a-z0-9][a-z0-9._-]*, not ending in '.' or '.lock' (max ${String(MAX_PUBLISHER_ID_LENGTH)} chars)`,
    );
  }
  return { kind: "extension", name, publisher };
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

export type ScaffoldFile = { readonly path: readonly string[]; readonly content: string };

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

const SERVER_TEST_TS = `import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./server.ts";

async function connected(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("__NAME__", () => {
  test("lists the echo tool", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");
  });
  test("echoes its input", async () => {
    const client = await connected();
    const out = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
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
    { path: ["src", "server.test.ts"], content: SERVER_TEST_TS.replaceAll("__NAME__", name) },
    { path: ["README.md"], content: buildReadme(name, platform, absDir) },
    { path: [".gitignore"], content: "node_modules/\ndist/\n" },
  ];
}

/** The extension's tools live apart from its entry so a test can import them without starting stdio. */
const EXT_TOOLS_TS = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
`;

/**
 * The entry. It connects when imported — the gateway's extension runtime \`import()\`s the built
 * bundle, so an \`import.meta.main\` guard would be false there and the server would never start.
 */
const EXT_SERVER_TS = `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./tools.ts";

await createServer().connect(new StdioServerTransport());
`;

function buildExtensionReadme(name: string, id: string, publisher: string | undefined): string {
  const namespaceNote =
    publisher === undefined
      ? `\nThe manifest id is \`${id}\`. The public registry requires a namespaced id
(\`<publisher>/<name>\`): re-run \`nimbus scaffold extension ${name} --publisher <id>\` or edit
\`nimbus.extension.json\` before publishing there.\n`
      : "";
  return `# ${id}

A minimal Nimbus extension: an MCP server with one \`echo\` tool, installed and run by the Gateway.
${namespaceNote}
## Install and test

\`\`\`
bun install
bun test
\`\`\`

## Build

\`\`\`
bun run build
\`\`\`

This writes \`dist/index.js\`, one self-contained JavaScript file. The Gateway imports it as it is
and runs it with no \`node_modules\`, so everything it needs must be inside that bundle.

## Publish

\`\`\`
nimbus extension keygen
nimbus extension sign .
nimbus extension publish . --registry-repo nimbus-agent/extensions
\`\`\`

\`nimbus extension keygen\` prints your public key. \`nimbus extension sign .\` records it as
\`publisher.key\` in the manifest${publisher === undefined ? " (add a publisher object with your id first)" : ""} and signs the manifest.

The published package is exactly \`nimbus.extension.json\`, everything under \`dist/\`, and
\`README.md\` and \`LICENSE\` when present. \`src/\`, tests and \`node_modules/\` are never included.
`;
}

/** An extension id the scaffold refuses; `runScaffold` turns it into exit code 2. */
export class ScaffoldIdRefusedError extends Error {}

/**
 * The extension id, refusing one the gateway could not give a service id. \`deriveExtensionServiceId\`
 * is the rule itself (\`ext_\` plus 1-62 characters), so scaffold cannot disagree with install.
 */
export function resolveExtensionId(name: string, publisher: string | undefined): string {
  const id = publisher === undefined ? name : `${publisher}/${name}`;
  assertSafeExtensionId(id);
  assertCanonicalExtensionId(id);
  // Backstop: the parser's name/publisher rules already produce only publishable ids.
  assertPublishableExtensionId(id);
  try {
    deriveExtensionServiceId(id);
  } catch (e) {
    if (e instanceof RegistryError) {
      throw new ScaffoldIdRefusedError(
        `extension id "${id}" is too long: its service id (ext_ + the id) may have at most 62 characters after "ext_"`,
      );
    }
    throw e;
  }
  return id;
}

export function buildExtensionScaffoldFiles(
  name: string,
  publisher: string | undefined,
  _platform: NodeJS.Platform,
  _absDir: string,
): readonly ScaffoldFile[] {
  const id = resolveExtensionId(name, publisher);
  const manifest = {
    id,
    version: "0.1.0",
    name,
    entry: "dist/index.js",
    permissions: { network: [], filesystem: { read: [], write: [] } },
    updateChannel: "stable",
    ...(publisher === undefined ? {} : { publisher: { id: publisher } }),
  };
  const pkg = {
    name: `nimbus-ext-${name}`,
    private: true,
    type: "module",
    scripts: {
      start: "bun src/server.ts",
      test: "bun test",
      build: "bun build src/server.ts --target=bun --outfile dist/index.js",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": SCAFFOLD_MCP_SDK_VERSION,
      zod: "^4.6.5",
    },
  };
  return [
    { path: ["nimbus.extension.json"], content: `${JSON.stringify(manifest, undefined, 2)}\n` },
    { path: ["package.json"], content: `${JSON.stringify(pkg, undefined, 2)}\n` },
    { path: ["src", "server.ts"], content: EXT_SERVER_TS },
    { path: ["src", "tools.ts"], content: EXT_TOOLS_TS.replaceAll("__NAME__", name) },
    {
      path: ["src", "tools.test.ts"],
      content: SERVER_TEST_TS.replaceAll("./server.ts", "./tools.ts").replaceAll("__NAME__", name),
    },
    { path: ["README.md"], content: buildExtensionReadme(name, id, publisher) },
    { path: [".gitignore"], content: "node_modules/\ndist/\n" },
  ];
}

/**
 * `nimbus scaffold`. Synchronous — a usage or filesystem error thrown here reaches the CLI's
 * error path exactly as a rejection would.
 */
export function runScaffold(args: string[]): void {
  const parsed = parseScaffoldArgs(args);
  const dir = join(process.cwd(), parsed.name);
  if (existsSync(dir)) {
    throw new Error(`./${parsed.name}/ already exists`);
  }
  let files: readonly ScaffoldFile[];
  try {
    files =
      parsed.kind === "extension"
        ? buildExtensionScaffoldFiles(parsed.name, parsed.publisher, process.platform, dir)
        : buildScaffoldFiles(parsed.name, process.platform, dir);
  } catch (e) {
    if (e instanceof ScaffoldIdRefusedError) {
      console.error(e.message);
      throw new CliExit(2);
    }
    throw e;
  }
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const file of files) {
    const target = join(dir, ...file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  console.log(
    parsed.kind === "extension"
      ? `Scaffolded extension at ./${parsed.name}/ — next: cd ${parsed.name} && bun install && bun test && bun run build`
      : `Scaffolded MCP server at ./${parsed.name}/ — next: cd ${parsed.name} && bun install && bun test && bun run build`,
  );
}
