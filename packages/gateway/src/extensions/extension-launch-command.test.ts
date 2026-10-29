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

  test("the module imports nothing but the runtime layout (the eval role's graph depends on it)", async () => {
    const src = await Bun.file(join(import.meta.dir, "extension-launch-command.ts")).text();
    const specifiers = [...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["../platform/runtime-layout.ts"]);
  });
});
