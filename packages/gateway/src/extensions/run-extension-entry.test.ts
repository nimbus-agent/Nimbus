import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MODULE = resolve(import.meta.dir, "run-extension-entry.ts");

async function runChild(callExpr: string): Promise<{ code: number | null; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `const { runExtensionEntry } = await import(${JSON.stringify(MODULE)}); await runExtensionEntry(${callExpr});`,
    ],
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

describe("runExtensionEntry", () => {
  test("imports an absolute entry file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-ext-entry-"));
    try {
      const marker = join(dir, "marker.txt");
      const entry = join(dir, "entry.js");
      writeFileSync(
        entry,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
      );
      const { code } = await runChild(JSON.stringify(entry));
      expect(code).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 2 on a missing path", async () => {
    const { code, stderr } = await runChild("undefined");
    expect(code).toBe(2);
    expect(stderr).toContain("nimbus-gateway:");
  });

  test("exits 2 on a relative path without importing it", async () => {
    const { code } = await runChild(JSON.stringify("./relative.js"));
    expect(code).toBe(2);
  });
});
