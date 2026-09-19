import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
// Real, unmocked functions — see the comment in stop-and-wait.ts for why this test (and the
// module under test) deliberately avoid the mockable `gateway-process.ts`.
import { isProcessAlive } from "./gw-state-helpers.ts";
import { StopTimeoutError, stopAndWaitForExit } from "./stop-and-wait.ts";

function fakePaths(dataDir: string): CliPlatformPaths {
  return {
    configDir: dataDir,
    dataDir,
    logDir: join(dataDir, "logs"),
    socketPath: join(dataDir, "fake.sock"),
    extensionsDir: join(dataDir, "extensions"),
    tempDir: join(dataDir, "tmp"),
  };
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-stop-and-wait-"));
  roots.push(root);
  return root;
}

describe("stopAndWaitForExit", () => {
  test("no state file present: not-running, nothing to signal", async () => {
    const dataDir = tempDataDir();
    const result = await stopAndWaitForExit(fakePaths(dataDir));
    expect(result).toBe("not-running");
  });

  test("signals a real child, waits for it to exit, and removes the state file", async () => {
    const dataDir = tempDataDir();
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    try {
      const pid = child.pid;
      await writeFile(
        join(dataDir, "gateway.json"),
        JSON.stringify({ pid, socketPath: "x" }),
        "utf8",
      );

      const result = await stopAndWaitForExit(fakePaths(dataDir), { pollMs: 20 });

      expect(result).toBe("stopped");
      expect(isProcessAlive(pid)).toBe(false);
      expect(await Bun.file(join(dataDir, "gateway.json")).exists()).toBe(false);
    } finally {
      child.kill();
    }
  });

  test("a stale state file naming a dead pid: not-running, and the stale file is removed", async () => {
    const dataDir = tempDataDir();
    const child = Bun.spawn([process.execPath, "-e", "0"]);
    await child.exited;
    const pid = child.pid;
    expect(isProcessAlive(pid)).toBe(false);
    await writeFile(
      join(dataDir, "gateway.json"),
      JSON.stringify({ pid, socketPath: "x" }),
      "utf8",
    );

    const result = await stopAndWaitForExit(fakePaths(dataDir));

    expect(result).toBe("not-running");
    expect(await Bun.file(join(dataDir, "gateway.json")).exists()).toBe(false);
  });

  test("with default options it still signals, waits and cleans up", async () => {
    const dataDir = tempDataDir();
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    try {
      const pid = child.pid;
      await writeFile(
        join(dataDir, "gateway.json"),
        JSON.stringify({ pid, socketPath: "x" }),
        "utf8",
      );

      const result = await stopAndWaitForExit(fakePaths(dataDir));

      expect(result).toBe("stopped");
      expect(isProcessAlive(pid)).toBe(false);
      expect(await Bun.file(join(dataDir, "gateway.json")).exists()).toBe(false);
    } finally {
      child.kill();
    }
  });

  // SIGTERM cannot be ignored on Windows — there is no way to construct the "process refuses to
  // die" case there, so the deadline-exceeded path is POSIX-only.
  test.skipIf(process.platform === "win32")(
    "a child that ignores SIGTERM past the deadline rejects StopTimeoutError",
    async () => {
      const dataDir = tempDataDir();
      const child = Bun.spawn([
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ]);
      try {
        const pid = child.pid;
        await writeFile(
          join(dataDir, "gateway.json"),
          JSON.stringify({ pid, socketPath: "x" }),
          "utf8",
        );
        // Give the child a moment to install its SIGTERM handler before we signal it.
        await new Promise((r) => setTimeout(r, 100));

        await expect(
          stopAndWaitForExit(fakePaths(dataDir), { deadlineMs: 1, pollMs: 5 }),
        ).rejects.toThrow(StopTimeoutError);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
