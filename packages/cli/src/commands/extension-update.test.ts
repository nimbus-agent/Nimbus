import { describe, expect, test } from "bun:test";

import {
  type AutoUpdateIpcCaller,
  type AvailableUpdateCli,
  runExtensionDowngradeWithCaller,
  runExtensionUpdateWithCaller,
  type UpdateApplyResultCli,
} from "./extension.ts";

function captureStreams(): { stdout: string[]; stderr: string[] } {
  return { stdout: [], stderr: [] };
}

function sampleUpdate(): AvailableUpdateCli {
  return {
    id: "com.x.a",
    displayName: "X",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    channel: "stable",
    publisherStatus: "verified",
    verificationStatus: "verified",
  };
}

describe("runExtensionUpdateWithCaller — list mode (no id)", () => {
  test("--check fires force=true and prints rows", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const caller: AutoUpdateIpcCaller = async (method, params) => {
      calls.push({ method, params });
      return [sampleUpdate()];
    };
    const captured = captureStreams();
    const code = await runExtensionUpdateWithCaller({
      args: ["--check"],
      caller,
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(0);
    expect(calls[0]?.method).toBe("extension.checkForUpdates");
    expect(calls[0]?.params).toEqual({ force: true });
    expect(captured.stdout.join("")).toMatch(/com\.x\.a.*1\.0\.0.*1\.1\.0/);
  });

  test("--json with empty list", async () => {
    const caller: AutoUpdateIpcCaller = async () => [];
    const captured = captureStreams();
    const code = await runExtensionUpdateWithCaller({
      args: ["--json"],
      caller,
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toEqual([]);
  });

  test("no flags prints empty-list message", async () => {
    const caller: AutoUpdateIpcCaller = async () => [];
    const captured = captureStreams();
    const code = await runExtensionUpdateWithCaller({
      args: [],
      caller,
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(0);
    expect(captured.stdout.join("")).toContain("No updates available");
  });
});

describe("runExtensionUpdateWithCaller — apply mode (id supplied)", () => {
  test("applies cached update; exit 0 on success", async () => {
    const caller: AutoUpdateIpcCaller = async (method) => {
      if (method === "extension.checkForUpdates") {
        return [sampleUpdate()];
      }
      return { applied: true, jobId: "abc12345" } satisfies UpdateApplyResultCli;
    };
    const captured = captureStreams();
    const code = await runExtensionUpdateWithCaller({
      args: ["com.x.a"],
      caller,
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(0);
    expect(captured.stdout.join("")).toContain("updated com.x.a to 1.1.0");
  });

  test("--json round-trips the apply result", async () => {
    const caller: AutoUpdateIpcCaller = async (method) => {
      if (method === "extension.checkForUpdates") return [sampleUpdate()];
      return { applied: true, jobId: "abc12345" } satisfies UpdateApplyResultCli;
    };
    const captured = captureStreams();
    await runExtensionUpdateWithCaller({
      args: ["com.x.a", "--json"],
      caller,
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    const parsed = JSON.parse(captured.stdout.join("")) as UpdateApplyResultCli;
    expect(parsed.applied).toBe(true);
  });

  test("exit 1 and stderr hint on publisher_key_missing", async () => {
    const caller: AutoUpdateIpcCaller = async (method) => {
      if (method === "extension.checkForUpdates") return [sampleUpdate()];
      return {
        applied: false,
        reason: "publisher_key_missing",
        hint: "run `nimbus extension sync`",
      } satisfies UpdateApplyResultCli;
    };
    const captured = captureStreams();
    const code = await runExtensionUpdateWithCaller({
      args: ["com.x.a"],
      caller,
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(1);
    expect(captured.stderr.join("")).toContain("publisher_key_missing");
    expect(captured.stderr.join("")).toMatch(/nimbus extension sync/);
  });

  test("exit 1 when no cached entry for the id", async () => {
    const caller: AutoUpdateIpcCaller = async () => [];
    const captured = captureStreams();
    const code = await runExtensionUpdateWithCaller({
      args: ["com.x.nope"],
      caller,
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(1);
    expect(captured.stderr.join("")).toMatch(/no cached update for com\.x\.nope/);
  });

  test("--to overrides the cached toVersion", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const caller: AutoUpdateIpcCaller = async (method, params) => {
      calls.push({ method, params });
      if (method === "extension.checkForUpdates") return [sampleUpdate()];
      return { applied: true } satisfies UpdateApplyResultCli;
    };
    await runExtensionUpdateWithCaller({
      args: ["com.x.a", "--to", "0.9.0"],
      caller,
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const applyCall = calls.find((c) => c.method === "extension.update");
    expect(applyCall?.params).toEqual({ id: "com.x.a", toVersion: "0.9.0" });
  });
});

describe("runExtensionDowngradeWithCaller", () => {
  test("requires --to", async () => {
    const caller: AutoUpdateIpcCaller = async () => ({ applied: false }) as UpdateApplyResultCli;
    const captured = captureStreams();
    const code = await runExtensionDowngradeWithCaller({
      args: ["com.x.a"],
      caller,
      fetchInfo: async () => ({}),
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(1);
    expect(captured.stderr.join("")).toMatch(/requires --to/);
  });

  test("calls extension.update with the supplied toVersion", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const caller: AutoUpdateIpcCaller = async (method, params) => {
      calls.push({ method, params });
      return { applied: true } satisfies UpdateApplyResultCli;
    };
    const captured = captureStreams();
    const code = await runExtensionDowngradeWithCaller({
      args: ["com.x.a", "--to", "1.0.0"],
      caller,
      fetchInfo: async () => ({}),
      writeStdout: (s) => captured.stdout.push(s),
      writeStderr: (s) => captured.stderr.push(s),
    });
    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      method: "extension.update",
      params: { id: "com.x.a", toVersion: "1.0.0" },
    });
    expect(captured.stdout.join("")).toContain("downgraded com.x.a to 1.0.0");
  });
});
