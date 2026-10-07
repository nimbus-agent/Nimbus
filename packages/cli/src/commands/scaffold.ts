import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";

/** Pinned to the CLI's own `@modelcontextprotocol/sdk` dependency; a test enforces equality. */
export const SCAFFOLD_MCP_SDK_VERSION = "1.32.0";

const USAGE =
  "Usage: nimbus scaffold mcp <name>  (name: lowercase letters, digits, underscores; 1-62 chars)";
const NAME_RE = /^[a-z0-9_]{1,62}$/;

export type ScaffoldArgs = { kind: "mcp"; name: string; viaAlias: boolean };

export function parseScaffoldArgs(args: string[]): ScaffoldArgs {
  const kind = args[0]?.trim() ?? "";
  if (kind !== "mcp" && kind !== "extension") {
    throw new Error(USAGE);
  }
  const name = args[1]?.trim() ?? "";
  if (!NAME_RE.test(name)) {
    throw new Error(USAGE);
  }
  return { kind: "mcp", name, viaAlias: kind === "extension" };
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
    ? "\nOn Windows, any `--net` grant is all-or-nothing: it opens the network entirely rather than per host.\n"
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
${winNote}
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
  if (parsed.viaAlias) {
    console.log("`nimbus scaffold extension` is now `nimbus scaffold mcp <name>`.");
  }
  const files = buildScaffoldFiles(parsed.name, process.platform, dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const file of files) {
    const target = join(dir, ...file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  console.log(
    `Scaffolded MCP server at ./${parsed.name}/ — next: cd ${parsed.name} && bun install && bun test && bun run build`,
  );
}
