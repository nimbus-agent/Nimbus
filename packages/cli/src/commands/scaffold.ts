import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_MANIFEST_FILENAME = "nimbus.extension.json";

export type ScaffoldArgs = { kind: "extension"; id: string };

export function parseScaffoldArgs(args: string[]): ScaffoldArgs {
  const kind = args[0]?.trim() ?? "";
  if (kind !== "extension") {
    throw new Error("Usage: nimbus scaffold extension <id>");
  }
  const id = args[1]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus scaffold extension <id>");
  }
  return { kind: "extension", id };
}

export type ScaffoldFile = { readonly path: readonly string[]; readonly content: string };

export function buildScaffoldFiles(id: string): readonly ScaffoldFile[] {
  const manifest = {
    id,
    displayName: id,
    version: "0.0.1",
    description: "Scaffolded Nimbus extension",
    author: "local",
    entrypoint: "dist/index.js",
    runtime: "bun" as const,
    permissions: ["read" as const],
    hitlRequired: [] as const,
    minNimbusVersion: "0.1.0",
  };
  const pkg = {
    name: `nimbus-extension-${id.replaceAll(/[^a-z0-9-]/gi, "-")}`,
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  };
  return [
    {
      path: [EXTENSION_MANIFEST_FILENAME],
      content: `${JSON.stringify(manifest, undefined, 2)}\n`,
    },
    {
      path: ["dist", "index.js"],
      content: "// Nimbus extension entry (MCP server wiring goes here)\nexport default {};\n",
    },
    {
      path: ["package.json"],
      content: `${JSON.stringify(pkg, undefined, 2)}\n`,
    },
    {
      path: ["smoke.test.ts"],
      content: `import { describe, expect, test } from "bun:test";

describe("extension smoke", () => {
  test("loads", () => {
    expect(1).toBe(1);
  });
});
`,
    },
  ];
}

export async function runScaffold(args: string[]): Promise<void> {
  const parsed = parseScaffoldArgs(args);
  const id = parsed.id;
  const dir = join(process.cwd(), id);
  mkdirSync(join(dir, "dist"), { recursive: true });

  for (const file of buildScaffoldFiles(id)) {
    writeFileSync(join(dir, ...file.path), file.content, "utf8");
  }
  console.log(`Scaffolded extension at ./${id}/ (${EXTENSION_MANIFEST_FILENAME})`);
}
