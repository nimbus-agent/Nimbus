/**
 * The plain `nimbus scaffold extension` files, apart from `scaffold.ts` so the `--from-openapi`
 * generator can build on them without an import cycle.
 */
import {
  assertCanonicalExtensionId,
  assertPublishableExtensionId,
  assertSafeExtensionId,
  deriveExtensionServiceId,
  RegistryError,
} from "@nimbus-dev/registry-format";

/** Pinned to the CLI's own `@modelcontextprotocol/sdk` dependency; a test enforces equality. */
export const SCAFFOLD_MCP_SDK_VERSION = "1.32.0";

export type ScaffoldFile = { readonly path: readonly string[]; readonly content: string };

/** The in-memory MCP test both scaffolds write (the extension's with `./tools.ts`). */
export const SCAFFOLD_SERVER_TEST_TS = `import { describe, expect, test } from "bun:test";
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

/** The README note an un-namespaced id gets; empty with a publisher. Shared with `--from-openapi`. */
export function extensionNamespaceNote(
  name: string,
  id: string,
  publisher: string | undefined,
): string {
  return publisher === undefined
    ? `\nThe manifest id is \`${id}\`. The public registry requires a namespaced id
(\`<publisher>/<name>\`): re-run \`nimbus scaffold extension ${name} --publisher <id>\` or edit
\`nimbus.extension.json\` before publishing there.\n`
    : "";
}

function buildExtensionReadme(name: string, id: string, publisher: string | undefined): string {
  return `# ${id}

A minimal Nimbus extension: an MCP server with one \`echo\` tool, installed and run by the Gateway.
${extensionNamespaceNote(name, id, publisher)}
${extensionReadmeSteps(publisher)}`;
}

/** Install, build and publish: the README tail shared with `--from-openapi`. */
export function extensionReadmeSteps(publisher: string | undefined): string {
  return `## Install and test

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
      content: SCAFFOLD_SERVER_TEST_TS.replaceAll("./server.ts", "./tools.ts").replaceAll(
        "__NAME__",
        name,
      ),
    },
    { path: ["README.md"], content: buildExtensionReadme(name, id, publisher) },
    { path: [".gitignore"], content: "node_modules/\ndist/\n" },
  ];
}
