import { afterEach, describe, expect, test } from "bun:test";

import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

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
    sourceRegistry: "main",
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

  test("exit 1 and stderr hint on publisher_key_conflict", async () => {
    const caller: AutoUpdateIpcCaller = async (method) => {
      if (method === "extension.checkForUpdates") return [sampleUpdate()];
      return {
        applied: false,
        reason: "publisher_key_conflict",
        hint: "registry main names a different publisher key than the one this gateway trusts; the update is not applied",
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
    expect(captured.stderr.join("")).toContain("publisher_key_conflict");
    expect(captured.stderr.join("")).toContain(
      "hint: registry main names a different publisher key",
    );
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

  test("--accept-publisher-key is passed to extension.update", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const caller: AutoUpdateIpcCaller = async (method, params) => {
      calls.push({ method, params });
      if (method === "extension.checkForUpdates") return [sampleUpdate()];
      return { applied: true } satisfies UpdateApplyResultCli;
    };
    await runExtensionUpdateWithCaller({
      args: ["com.x.a", "--accept-publisher-key", "b".repeat(32)],
      caller,
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(calls.find((c) => c.method === "extension.update")?.params).toMatchObject({
      id: "com.x.a",
      acceptPublisherKey: "b".repeat(32),
    });
  });
});

describe("runExtensionDowngradeWithCaller", () => {
  test("requires --to", async () => {
    const caller: AutoUpdateIpcCaller = async () => ({ applied: false });
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

const REQ = {
  connector: "github",
  state: "not_connected",
  owner: { kind: "bundled" },
  fix: ["nimbus connector auth github"],
  requiredBy: ["com.x.dep"],
  interactive: true,
};

function applyCaller(
  update: AvailableUpdateCli,
  result: UpdateApplyResultCli,
): AutoUpdateIpcCaller {
  return async (method) => (method === "extension.checkForUpdates" ? [update] : result);
}

async function applyWith(
  result: UpdateApplyResultCli,
  extra: Partial<Parameters<typeof runExtensionUpdateWithCaller>[0]> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const c = captureStreams();
  const code = await runExtensionUpdateWithCaller({
    args: ["com.x.a"],
    caller: applyCaller(sampleUpdate(), result),
    writeStdout: (s) => c.stdout.push(s),
    writeStderr: (s) => c.stderr.push(s),
    ...extra,
  });
  return { stdout: c.stdout.join(""), stderr: c.stderr.join(""), code };
}

describe("extension update — what it adds", () => {
  test("the list shows `adds <ids>` and the conflict reason", async () => {
    const rows: AvailableUpdateCli[] = [
      { ...sampleUpdate(), addedPackages: [{ id: "com.dep" }, { id: "com.dep2" }] },
      { ...sampleUpdate(), id: "com.x.b", conflicts: [{ reason: "dep needs registry zed" }] },
    ];
    const c = captureStreams();
    await runExtensionUpdateWithCaller({
      args: ["--check"],
      caller: async () => rows,
      writeStdout: (s) => c.stdout.push(s),
      writeStderr: (s) => c.stderr.push(s),
    });
    const text = c.stdout.join("");
    expect(text).toContain("adds com.dep, com.dep2");
    expect(text).toContain("dep needs registry zed");
  });

  test("apply prints the + line, then Nothing runs, then Needs", async () => {
    const r = await applyWith({
      applied: true,
      addedPackages: [{ id: "com.x.dep", version: "1.2.0", registry: "main", kind: "extension" }],
      connectorRequirements: [REQ],
    });
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("updated com.x.a to 1.1.0");
    expect(lines[1]).toBe("  + com.x.dep@1.2.0 from registry main (installed as a dependency)");
    expect(lines[2]).toBe("Nothing runs until you approve it: nimbus extension approve com.x.dep");
    expect(lines[3]).toBe("Needs:");
  });

  test("a starter-pack member is never offered for approval", async () => {
    const r = await applyWith({
      applied: true,
      addedPackages: [
        { id: "com.x.pack2", version: "1.0.0", registry: "main", kind: "starter-pack" },
      ],
    });
    expect(r.stdout).toContain("+ com.x.pack2@1.0.0");
    expect(r.stdout).not.toContain("Nothing runs");
  });

  describe("the walk", () => {
    const origOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const origIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const restore = (
      s: NodeJS.ReadStream | NodeJS.WriteStream,
      d: PropertyDescriptor | undefined,
    ): void => {
      if (d === undefined) delete (s as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(s, "isTTY", d);
    };
    afterEach(() => {
      restore(process.stdout, origOut);
      restore(process.stdin, origIn);
    });
    const setTty = (v: boolean): void => {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: v });
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: v });
    };
    const result: UpdateApplyResultCli = {
      applied: true,
      addedPackages: [
        { id: "com.x.dep", version: "1.2.0", registry: "main", kind: "extension" },
        { id: "com.x.pk", version: "1.0.0", registry: "main", kind: "starter-pack" },
      ],
    };

    test("an attended apply walks approvals for code packages only", async () => {
      setTty(true);
      const fresh: Array<ReturnType<typeof createMockIpcClient>> = [];
      await applyWith(result, {
        walk: {
          socketPath: "/sock",
          makeClient: () => {
            const m = createMockIpcClient([
              { id: "x", serviceId: "ext_x", treeDigest: "ab".repeat(32), changed: true },
            ]);
            fresh.push(m);
            return m.client;
          },
          confirm: async () => true,
        },
      });
      expect(fresh.flatMap((m) => m.calls.map((c) => c.params))).toEqual([
        { id: "com.x.dep", modelAccess: false },
      ]);
    });

    test("an unattended apply (--yes) prints the commands and walks nothing", async () => {
      setTty(true);
      let made = 0;
      const r = await applyWith(result, {
        args: ["com.x.a", "--yes"],
        walk: {
          socketPath: "/sock",
          makeClient: () => {
            made += 1;
            return createMockIpcClient([]).client;
          },
          confirm: async () => true,
        },
      });
      expect(made).toBe(0);
      expect(r.stdout).toContain("nimbus extension approve com.x.dep");
    });
  });
});

describe("extension downgrade — orphans", () => {
  test("prints the Kept line on stderr; stdout is as today", async () => {
    const c = captureStreams();
    const code = await runExtensionDowngradeWithCaller({
      args: ["com.x.a", "--to", "1.0.0"],
      caller: async () => ({ applied: true, orphanedDependencies: ["com.a", "com.b"] }),
      fetchInfo: async () => ({}),
      writeStdout: (s) => c.stdout.push(s),
      writeStderr: (s) => c.stderr.push(s),
    });
    expect(code).toBe(0);
    expect(c.stdout.join("")).toBe("downgraded com.x.a to 1.0.0\n");
    expect(c.stderr.join("")).toBe(
      "Kept com.a, com.b, no longer needed by com.x.a; remove them with: nimbus extension remove com.a && nimbus extension remove com.b\n",
    );
  });
});
