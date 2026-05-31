import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("cli e2e smoke", () => {
  test("command module resolves without running CLI entry", async () => {
    const mod = await import("../../src/commands/index.ts");
    expect(mod).toBeDefined();
  });

  test("CLI help exits 0", async () => {
    const cliEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", cliEntry, "help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
