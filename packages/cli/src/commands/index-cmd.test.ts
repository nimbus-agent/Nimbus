import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const indexMod = await import("./index-cmd.ts");
const { runIndexCmd } = indexMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("nimbus index — top-level dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("help prints usage", async () => {
    await runIndexCmd(["help"]);
    expect(out.stdout).toContain("nimbus index reembed");
  });

  it("--help prints usage", async () => {
    await runIndexCmd(["--help"]);
    expect(out.stdout).toContain("nimbus index reembed");
  });

  it("no args prints usage", async () => {
    await runIndexCmd([]);
    expect(out.stdout).toContain("nimbus index reembed");
  });

  it("unknown subcommand throws", async () => {
    await expect(runIndexCmd(["bogus"])).rejects.toThrow(/Unknown index subcommand/);
  });

  it("help mentions index add", async () => {
    await runIndexCmd(["help"]);
    expect(out.stdout).toContain("nimbus index add");
  });

  it("reembed without --model throws usage error", async () => {
    await expect(runIndexCmd(["reembed"])).rejects.toThrow(/--model/);
  });

  it("help mentions the regraph subcommand", async () => {
    await runIndexCmd(["help"]);
    expect(out.stdout).toContain("nimbus index regraph");
  });

  it("reembed without --yes / --dry-run prints planned action and returns", async () => {
    await runIndexCmd(["reembed", "--model", "Xenova/all-MiniLM-L6-v2"]);
    expect(out.stdout).toMatch(/Planned reembed/);
    expect(out.stdout).toMatch(/--yes/);
  });

  it("planned-action output includes optional flags when provided", async () => {
    await runIndexCmd([
      "reembed",
      "--model",
      "openai:text-embedding-3-small",
      "--item-type",
      "slack:message",
      "--service",
      "slack",
      "--limit",
      "100",
      "--batch-size",
      "16",
    ]);
    expect(out.stdout).toContain("openai:text-embedding-3-small");
    expect(out.stdout).toContain("slack:message");
    expect(out.stdout).toContain("slack");
    expect(out.stdout).toContain("100");
    expect(out.stdout).toContain("16");
  });
});

describe("nimbus index add — IPC flow", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws usage error when no path is given", async () => {
    await expect(runIndexCmd(["add"])).rejects.toThrow(/Usage: nimbus index add/);
  });

  it("throws usage error when the arg looks like a flag", async () => {
    await expect(runIndexCmd(["add", "--bogus"])).rejects.toThrow(/Usage: nimbus index add/);
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runIndexCmd(["add", "."])).rejects.toThrow(/Gateway is not running/);
  });

  it("calls filesystem.ensureRoot with the resolved path and reports registration", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          return { path: "/abs/repo", added: true };
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runIndexCmd(["add", "some/repo"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("filesystem.ensureRoot");
    const params = calls[0]?.params as { path: string };
    expect(typeof params.path).toBe("string");
    // resolved to an absolute path before the call
    expect(params.path).not.toBe("some/repo");
    expect(out.stdout).toMatch(/Registered blame root: \/abs\/repo/);
  });

  it("reports 'Already registered' when added is false", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async () => ({ path: "/abs/repo", added: false }),
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runIndexCmd(["add", "some/repo"]);
    expect(out.stdout).toMatch(/Already registered: \/abs\/repo/);
  });
});

describe("nimbus index reembed — IPC flow (--yes)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(
      runIndexCmd(["reembed", "--model", "Xenova/all-MiniLM-L6-v2", "--yes"]),
    ).rejects.toThrow(/Gateway is not running/);
  });

  it("issues index.reembed and resolves on index.reembedDone", async () => {
    const mock = createMockIpcClient([{ jobId: "job-1" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.reembed") {
        setTimeout(() => {
          mock.emit("index.reembedProgress", {
            jobId: "job-1",
            done: 5,
            total: 10,
            skipped: 0,
          });
          mock.emit("index.reembedDone", {
            jobId: "job-1",
            succeeded: 9,
            skipped: 1,
            durationMs: 100,
          });
        }, 0);
      }
      return r;
    };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: wrappedCall,
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (e: string, h: (params: unknown) => void): void => {
          (
            mock.client as unknown as {
              onNotification: (e: string, h: (params: unknown) => void) => void;
            }
          ).onNotification(e, h);
        },
      },
    });
    await runIndexCmd(["reembed", "--model", "Xenova/all-MiniLM-L6-v2", "--yes"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "index.reembed",
      params: { model: "Xenova/all-MiniLM-L6-v2", dryRun: false },
    });
    expect(out.stdout).toMatch(/progress: 5\/10/);
    expect(out.stdout).toMatch(/Reembedded 9 item/);
    expect(out.stdout).toMatch(/skipped 1/);
  });

  it("includes optional itemType/service/limit/batchSize in the IPC params", async () => {
    const mock = createMockIpcClient([{ jobId: "job-2" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.reembed") {
        setTimeout(() => {
          mock.emit("index.reembedDone", {
            jobId: "job-2",
            succeeded: 0,
            skipped: 0,
            durationMs: 1,
          });
        }, 0);
      }
      return r;
    };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: wrappedCall,
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (e: string, h: (params: unknown) => void): void => {
          (
            mock.client as unknown as {
              onNotification: (e: string, h: (params: unknown) => void) => void;
            }
          ).onNotification(e, h);
        },
      },
    });
    await runIndexCmd([
      "reembed",
      "--model",
      "openai:text-embedding-3-small",
      "--item-type",
      "slack:message",
      "--service",
      "slack",
      "--limit",
      "50",
      "--batch-size",
      "16",
      "--yes",
    ]);
    expect(mock.calls[0]).toEqual({
      method: "index.reembed",
      params: {
        model: "openai:text-embedding-3-small",
        dryRun: false,
        itemType: "slack:message",
        service: "slack",
        limit: 50,
        batchSize: 16,
      },
    });
  });

  it("--dry-run path emits done with dryRun:true + prints the planned-count line", async () => {
    const mock = createMockIpcClient([{ jobId: "job-dry" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.reembed") {
        setTimeout(() => {
          mock.emit("index.reembedDone", {
            jobId: "job-dry",
            succeeded: 0,
            skipped: 0,
            durationMs: 0,
            dryRun: true,
            planned: 42,
          });
        }, 0);
      }
      return r;
    };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: wrappedCall,
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (e: string, h: (params: unknown) => void): void => {
          (
            mock.client as unknown as {
              onNotification: (e: string, h: (params: unknown) => void) => void;
            }
          ).onNotification(e, h);
        },
      },
    });
    await runIndexCmd(["reembed", "--model", "Xenova/all-MiniLM-L6-v2", "--dry-run"]);
    expect(mock.calls[0]?.params).toMatchObject({ dryRun: true });
    expect(out.stdout).toMatch(/Dry run: 42 item/);
  });

  it("--json suppresses progress lines and emits one JSON line at done", async () => {
    const mock = createMockIpcClient([{ jobId: "job-json" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.reembed") {
        setTimeout(() => {
          mock.emit("index.reembedProgress", {
            jobId: "job-json",
            done: 1,
            total: 3,
            skipped: 0,
          });
          mock.emit("index.reembedDone", {
            jobId: "job-json",
            succeeded: 3,
            skipped: 0,
            durationMs: 10,
          });
        }, 0);
      }
      return r;
    };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: wrappedCall,
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (e: string, h: (params: unknown) => void): void => {
          (
            mock.client as unknown as {
              onNotification: (e: string, h: (params: unknown) => void) => void;
            }
          ).onNotification(e, h);
        },
      },
    });
    await runIndexCmd(["reembed", "--model", "Xenova/all-MiniLM-L6-v2", "--yes", "--json"]);
    expect(out.stdout).not.toMatch(/progress: /);
    const trimmed = out.stdout.trim().split("\n").pop() ?? "";
    expect(JSON.parse(trimmed)).toEqual({
      jobId: "job-json",
      succeeded: 3,
      skipped: 0,
      durationMs: 10,
    });
  });

  it("rejects when index.reembedError fires", async () => {
    const mock = createMockIpcClient([{ jobId: "job-err" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.reembed") {
        setTimeout(() => {
          mock.emit("index.reembedError", {
            jobId: "job-err",
            code: 1,
            message: "openai.api_key missing",
          });
        }, 0);
      }
      return r;
    };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: wrappedCall,
        connect: async () => {},
        disconnect: async () => {},
        onNotification: (e: string, h: (params: unknown) => void): void => {
          (
            mock.client as unknown as {
              onNotification: (e: string, h: (params: unknown) => void) => void;
            }
          ).onNotification(e, h);
        },
      },
    });
    await expect(
      runIndexCmd(["reembed", "--model", "openai:text-embedding-3-small", "--yes"]),
    ).rejects.toThrow(/openai\.api_key missing/);
  });

  it("rejects when the initial index.reembed call throws", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async () => {
          throw new Error("network down");
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await expect(
      runIndexCmd(["reembed", "--model", "Xenova/all-MiniLM-L6-v2", "--yes"]),
    ).rejects.toThrow(/network down/);
  });
});

describe("nimbus index regraph — IPC flow", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runIndexCmd(["regraph"])).rejects.toThrow(/Gateway is not running/);
  });

  it("calls index.regraph with null params and prints the summary line", async () => {
    const mock = createMockIpcClient([{ scanned: 10, graphed: 8, skipped: 0 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: mock.client.call.bind(mock.client),
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runIndexCmd(["regraph"]);
    expect(mock.calls).toEqual([{ method: "index.regraph", params: null }]);
    expect(out.stdout).toMatch(/regraph: scanned 10, graphed 8, skipped 0/);
    expect(out.stderr).not.toMatch(/WARN/);
  });

  it("--json prints a single JSON line", async () => {
    const mock = createMockIpcClient([{ scanned: 3, graphed: 3, skipped: 0 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: mock.client.call.bind(mock.client),
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runIndexCmd(["regraph", "--json"]);
    expect(JSON.parse(out.stdout.trim())).toEqual({ scanned: 3, graphed: 3, skipped: 0 });
  });

  it("prints a WARN line to stderr when skipped > 0", async () => {
    const mock = createMockIpcClient([{ scanned: 5, graphed: 3, skipped: 2 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: mock.client.call.bind(mock.client),
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runIndexCmd(["regraph"]);
    expect(out.stderr).toMatch(/WARN: 2 item\(s\) failed to graph/);
  });

  it("rejects when the index.regraph call throws", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async () => {
          throw new Error("network down");
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await expect(runIndexCmd(["regraph"])).rejects.toThrow(/network down/);
  });
});
