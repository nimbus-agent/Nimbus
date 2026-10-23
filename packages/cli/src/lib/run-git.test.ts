import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, TOOL_NOT_STARTED } from "./run-git.ts";

describe("runTool", () => {
  afterEach(() => {
    // restore any spy installed by a test
    spyOn(Bun, "spawn").mockRestore();
  });

  test("runs git and returns decoded and raw stdout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nimbus-run-git-"));
    try {
      const r = await runTool("git", ["--version"], { cwd });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("git version");
      expect(new TextDecoder().decode(r.stdoutBytes)).toBe(r.stdout);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reports a missing working directory as TOOL_NOT_STARTED", async () => {
    const cwd = join(tmpdir(), "nimbus-run-git-missing-dir-does-not-exist");
    const r = await runTool("git", ["--version"], { cwd });
    expect(r.code).toBe(TOOL_NOT_STARTED);
    expect(r.stderr).toContain("git could not be started");
  });

  test("reports a thrown non-Error value as TOOL_NOT_STARTED", async () => {
    spyOn(Bun, "spawn").mockImplementation((() => {
      throw "boom";
    }) as unknown as typeof Bun.spawn);
    const r = await runTool("gh", ["--version"], { cwd: tmpdir() });
    expect(r.code).toBe(TOOL_NOT_STARTED);
    expect(r.stderr).toBe("gh could not be started: boom");
  });
});
