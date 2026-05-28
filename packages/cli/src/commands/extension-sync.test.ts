import { describe, expect, test } from "bun:test";

import { runExtensionSyncWithCaller, type SyncIpcCaller, type SyncResult } from "./extension.ts";

function staticCaller(result: SyncResult): SyncIpcCaller {
  return async () => result;
}

function throwingCaller(message: string): SyncIpcCaller {
  return async () => {
    throw new Error(message);
  };
}

function captureStreams(): { stdout: string[]; stderr: string[] } {
  const out: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
  return out;
}

describe("runExtensionSync exit codes", () => {
  test("exit 0 when nothing changes", async () => {
    const captured = captureStreams();
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: staticCaller({
        publishersChecked: 1,
        publishersUnchanged: 1,
        publishersUpdated: [],
        publishersEvicted: [],
        failures: [],
      }),
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(0);
    expect(captured.stdout.join("")).toContain("publishers checked: 1");
  });

  test("exit 2 when a rotation caused re-verify failure", async () => {
    const captured = captureStreams();
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: staticCaller({
        publishersChecked: 1,
        publishersUnchanged: 0,
        publishersUpdated: [{ id: "pub-a", reverifyResult: "failed", failedExtensions: ["ext-a"] }],
        publishersEvicted: [],
        failures: [],
      }),
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(2);
  });

  test("exit 3 when air-gap error thrown by IPC", async () => {
    const captured = captureStreams();
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: throwingCaller("air-gap is enforced; nimbus extension sync refused"),
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(3);
  });

  test("exit 4 when all checked publishers failed transiently", async () => {
    const captured = captureStreams();
    const code = await runExtensionSyncWithCaller({
      args: [],
      caller: staticCaller({
        publishersChecked: 1,
        publishersUnchanged: 0,
        publishersUpdated: [],
        publishersEvicted: [],
        failures: [{ id: "pub-a", reason: "ECONNREFUSED" }],
      }),
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(4);
  });

  test("per-publisher failure framing is sync-context, not install-context", async () => {
    const captured = captureStreams();
    await runExtensionSyncWithCaller({
      args: [],
      caller: staticCaller({
        publishersChecked: 2,
        publishersUnchanged: 1,
        publishersUpdated: [],
        publishersEvicted: [],
        failures: [{ id: "pub-a", reason: "ECONNREFUSED" }],
      }),
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    const stderr = captured.stderr.join("");
    expect(stderr).toContain("publisher pub-a unreachable");
    expect(stderr).toContain("re-run `nimbus extension sync` later");
    expect(stderr).not.toContain("re-run the install");
  });

  test("--json emits raw SyncResult JSON to stdout", async () => {
    const captured = captureStreams();
    await runExtensionSyncWithCaller({
      args: ["--json"],
      caller: staticCaller({
        publishersChecked: 0,
        publishersUnchanged: 0,
        publishersUpdated: [],
        publishersEvicted: [],
        failures: [],
      }),
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    const out = JSON.parse(captured.stdout.join(""));
    expect(out).toMatchObject({ publishersChecked: 0 });
  });

  test("--dry-run flag is forwarded to caller", async () => {
    const captured = captureStreams();
    let receivedDryRun: boolean | undefined;
    await runExtensionSyncWithCaller({
      args: ["--dry-run"],
      caller: async (params) => {
        receivedDryRun = (params as { dryRun?: boolean }).dryRun;
        return {
          publishersChecked: 0,
          publishersUnchanged: 0,
          publishersUpdated: [],
          publishersEvicted: [],
          failures: [],
        };
      },
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(receivedDryRun).toBe(true);
  });
});
