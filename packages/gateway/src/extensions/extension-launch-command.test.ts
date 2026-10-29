import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RuntimeLayout } from "../platform/runtime-layout.ts";
import { extensionEntryCommand } from "./extension-launch-command.ts";

const DEV: RuntimeLayout = {
  execPath: join(process.cwd(), "bun.exe"),
  moduleDir: join(process.cwd(), "packages", "gateway", "src", "platform"),
  gatewayEntry: join(process.cwd(), "packages", "gateway", "src", "index.ts"),
};
const COMPILED: RuntimeLayout = {
  execPath: join(process.cwd(), "nimbus-gateway.exe"),
  moduleDir: "/$bunfs/root",
  gatewayEntry: "/$bunfs/root/index.ts",
};
const ENTRY = join(process.cwd(), "stage", "dist", "index.js");

describe("extensionEntryCommand", () => {
  test("a compiled binary runs its own __nimbus-extension role with the entry", () => {
    expect(extensionEntryCommand(ENTRY, COMPILED)).toEqual({
      command: COMPILED.execPath,
      args: ["__nimbus-extension", ENTRY],
    });
  });

  test("a dev tree runs the role inline: hardening flags, -e code, then the entry as its one argument", () => {
    const { command, args } = extensionEntryCommand(ENTRY, DEV);
    expect(command).toBe(DEV.execPath);
    expect(args.slice(0, 3)).toEqual(["--no-env-file", "--no-install", "-e"]);
    expect(args.at(-1)).toBe(ENTRY);
    expect(args).toHaveLength(5);
    // Fully static: the entry is never interpolated into the code, which carries no backslash.
    const code = args[3] ?? "";
    expect(code).not.toContain(ENTRY);
    expect(code).not.toContain("\\");
  });

  test("defaults to the live runtime layout", () => {
    const { command } = extensionEntryCommand(ENTRY, undefined);
    expect(command).toBe(process.execPath);
  });

  /**
   * Every module the source loads at runtime — a value import, a bare `import "x"`, a re-export,
   * `import("x")` and `require("x")` — read by Bun's own scanner, so code quoted inside a string
   * (this module carries the dev-tree launcher as text) is not mistaken for an import.
   */
  function moduleSpecifiers(src: string): string[] {
    return new Bun.Transpiler({ loader: "ts" }).scanImports(src).map((i) => i.path);
  }

  test("the specifier scan sees every runtime import form, and none quoted in a string", () => {
    expect(
      moduleSpecifiers(
        [
          'import { a } from "./a.ts";',
          "a();",
          'import "./c.ts";',
          'const d = await import("./d.ts");',
          'const e = require("./e.ts");',
          'export { f } from "./f.ts";',
          "const quoted = 'await import(\"./g.ts\")';",
        ].join("\n"),
      ),
    ).toEqual(["./a.ts", "./c.ts", "./d.ts", "./e.ts", "./f.ts"]);
  });

  test("the module imports nothing but the runtime layout (the eval role's graph depends on it)", async () => {
    const src = await Bun.file(join(import.meta.dir, "extension-launch-command.ts")).text();
    expect(moduleSpecifiers(src)).toEqual(["../platform/runtime-layout.ts"]);
  });
});
