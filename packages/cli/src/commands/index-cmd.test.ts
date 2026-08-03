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

  it("buffers and still renders a progress notification that arrives BEFORE the RPC response assigns jobId (no drop, no hang)", async () => {
    const mock = createMockIpcClient([{ jobId: "job-race" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      if (m === "index.reembed") {
        // Emitted BEFORE the base call resolves: at this instant the client has not yet
        // learned jobId. The old (buggy) client dropped this silently; a correct client
        // buffers it and renders it once jobId is known.
        mock.emit("index.reembedProgress", {
          jobId: "job-race",
          done: 1,
          total: 4,
          skipped: 0,
        });
        mock.emit("index.reembedDone", {
          jobId: "job-race",
          succeeded: 4,
          skipped: 0,
          durationMs: 5,
        });
      }
      return baseClient.call(m, p);
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
    expect(out.stdout).toMatch(/progress: 1\/4/);
    expect(out.stdout).toMatch(/Reembedded 4 item/);
  }, 2000);
});

describe("nimbus index rebody — argument parsing", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("help mentions the rebody subcommand", async () => {
    await runIndexCmd(["help"]);
    expect(out.stdout).toContain("nimbus index rebody");
  });

  it("without --dry-run / --yes prints planned action and returns without an IPC call", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          return { jobId: "unexpected" };
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await runIndexCmd(["rebody", "--service", "notion"]);
    expect(out.stdout).toMatch(/Planned rebody/);
    expect(out.stdout).toMatch(/service = notion/);
    expect(out.stdout).toMatch(/--yes/);
    expect(calls).toHaveLength(0);
  });

  it("planned-action output includes --type and --limit when provided", async () => {
    await runIndexCmd(["rebody", "--type", "page", "--limit", "5"]);
    expect(out.stdout).toContain("type    = page");
    expect(out.stdout).toContain("limit   = 5");
  });

  it("rejects a non-numeric --limit before any IPC call, without swallowing the error", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          return { jobId: "unexpected" };
        },
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    await expect(runIndexCmd(["rebody", "--limit", "nope", "--dry-run"])).rejects.toThrow(
      /--limit must be a positive integer/,
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects a zero/negative --limit before any IPC call", async () => {
    await expect(runIndexCmd(["rebody", "--limit", "0", "--dry-run"])).rejects.toThrow(
      /--limit must be a positive integer/,
    );
    await expect(runIndexCmd(["rebody", "--limit", "-3", "--dry-run"])).rejects.toThrow(
      /--limit must be a positive integer/,
    );
  });

  it("rejects a non-integer --limit", async () => {
    await expect(runIndexCmd(["rebody", "--limit", "2.5", "--dry-run"])).rejects.toThrow(
      /--limit must be a positive integer/,
    );
  });
});

describe("nimbus index rebody — IPC flow (--dry-run)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runIndexCmd(["rebody", "--dry-run"])).rejects.toThrow(/Gateway is not running/);
  });

  it("prints pending counts, cannotImprove, and the re-walk caveat", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-dry" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.rebody") {
        setTimeout(() => {
          mock.emit("index.rebodyDone", {
            jobId: "job-rebody-dry",
            durationMs: 5,
            dryRun: true,
            pending: { notion: 4210, slack: 122 },
            cannotImprove: ["notion"],
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
    await runIndexCmd(["rebody", "--dry-run"]);
    expect(mock.calls[0]).toEqual({
      method: "index.rebody",
      params: { dryRun: true },
    });
    expect(out.stdout).toMatch(/pending bodies: notion 4210, slack 122/);
    expect(out.stdout).toMatch(/cannot improve: notion/);
    expect(out.stdout).toMatch(/re-walk the ENTIRE/);
  });

  it("prints 'none' when nothing is pending on a dry run", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-empty" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.rebody") {
        setTimeout(() => {
          mock.emit("index.rebodyDone", {
            jobId: "job-rebody-empty",
            durationMs: 1,
            dryRun: true,
            pending: {},
            cannotImprove: [],
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
    await runIndexCmd(["rebody", "--dry-run"]);
    expect(out.stdout).toMatch(/pending bodies: none\./);
    expect(out.stdout).not.toMatch(/cannot improve:/);
  });

  it("includes optional service/type/limit filters in the IPC params on a dry run", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-filters" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.rebody") {
        setTimeout(() => {
          mock.emit("index.rebodyDone", {
            jobId: "job-rebody-filters",
            durationMs: 1,
            dryRun: true,
            pending: {},
            cannotImprove: [],
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
      "rebody",
      "--service",
      "notion",
      "--type",
      "page",
      "--limit",
      "3",
      "--dry-run",
    ]);
    expect(mock.calls[0]).toEqual({
      method: "index.rebody",
      params: { dryRun: true, service: "notion", type: "page", limit: 3 },
    });
  });

  it("rejects when index.rebodyError fires", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-err" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.rebody") {
        setTimeout(() => {
          mock.emit("index.rebodyError", {
            jobId: "job-rebody-err",
            code: -32602,
            message: "params.limit must be a positive finite number when provided",
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
    await expect(runIndexCmd(["rebody", "--dry-run"])).rejects.toThrow(
      /params\.limit must be a positive finite number/,
    );
  });

  it("rejects when the initial index.rebody call throws", async () => {
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
    await expect(runIndexCmd(["rebody", "--dry-run"])).rejects.toThrow(/network down/);
  });

  it("--json suppresses progress/text lines and emits one JSON line at done", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-json" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.rebody") {
        setTimeout(() => {
          mock.emit("index.rebodyDone", {
            jobId: "job-rebody-json",
            durationMs: 2,
            dryRun: true,
            pending: { slack: 1 },
            cannotImprove: [],
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
    await runIndexCmd(["rebody", "--dry-run", "--json"]);
    expect(out.stdout).not.toMatch(/pending bodies:/);
    const trimmed = out.stdout.trim().split("\n").pop() ?? "";
    expect(JSON.parse(trimmed)).toEqual({
      jobId: "job-rebody-json",
      durationMs: 2,
      dryRun: true,
      pending: { slack: 1 },
      cannotImprove: [],
    });
  });
});

describe("nimbus index rebody — IPC flow (--yes, real run)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("streams progress and prints the before/after pending transition + warnings", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-real" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.rebody") {
        setTimeout(() => {
          mock.emit("index.rebodyProgress", {
            jobId: "job-rebody-real",
            done: 1,
            total: 2,
            service: "github",
          });
          mock.emit("index.rebodyDone", {
            jobId: "job-rebody-real",
            durationMs: 100,
            dryRun: false,
            targeted: ["github", "notion"],
            succeeded: 1,
            failed: 1,
            failedServices: ["notion"],
            warnings: [
              "notion: forceSync failed, but its watermark was already cleared — the next " +
                "scheduled sync will perform the same re-walk automatically, unprompted.",
            ],
            cannotImprove: ["notion"],
            pendingBefore: { github: 10, notion: 4210 },
            pendingAfter: { github: 0, notion: 4210 },
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
    await runIndexCmd(["rebody", "--yes"]);
    expect(mock.calls[0]).toEqual({
      method: "index.rebody",
      params: { dryRun: false },
    });
    expect(out.stdout).toMatch(/progress: 1\/2 \(github\)/);
    expect(out.stdout).toMatch(/github: 10 -> 0/);
    expect(out.stdout).toMatch(/notion: 4210 -> 4210/);
    expect(out.stdout).toMatch(/cannot improve: notion/);
    expect(out.stdout).toMatch(/targeted 2 service\(s\); succeeded 1; failed 1/);
    expect(out.stderr).toMatch(/WARN: notion: forceSync failed/);
  });

  it("prints 'none' when both pendingBefore and pendingAfter are empty", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-real-empty" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.rebody") {
        setTimeout(() => {
          mock.emit("index.rebodyDone", {
            jobId: "job-rebody-real-empty",
            durationMs: 1,
            dryRun: false,
            targeted: [],
            succeeded: 0,
            failed: 0,
            failedServices: [],
            warnings: [],
            cannotImprove: [],
            pendingBefore: {},
            pendingAfter: {},
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
    await runIndexCmd(["rebody", "--yes"]);
    expect(out.stdout).toMatch(/pending bodies: none\./);
    expect(out.stdout).toMatch(/targeted 0 service\(s\); succeeded 0; failed 0/);
    expect(out.stderr).not.toMatch(/WARN/);
  });

  it("includes optional service/type/limit filters in the real-run IPC params", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-real-filters" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.rebody") {
        setTimeout(() => {
          mock.emit("index.rebodyDone", {
            jobId: "job-rebody-real-filters",
            durationMs: 1,
            dryRun: false,
            targeted: ["slack"],
            succeeded: 1,
            failed: 0,
            failedServices: [],
            warnings: [],
            cannotImprove: [],
            pendingBefore: { slack: 5 },
            pendingAfter: { slack: 5 },
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
    await runIndexCmd(["rebody", "--service", "slack", "--limit", "1", "--yes"]);
    expect(mock.calls[0]).toEqual({
      method: "index.rebody",
      params: { dryRun: false, service: "slack", limit: 1 },
    });
  });

  it("rejects when the initial index.rebody call throws on a real run", async () => {
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
    await expect(runIndexCmd(["rebody", "--yes"])).rejects.toThrow(/network down/);
  });

  it("buffers and still renders a progress notification that arrives BEFORE the RPC response assigns jobId (no drop, no hang)", async () => {
    const mock = createMockIpcClient([{ jobId: "job-rebody-race" }]);
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      if (m === "index.rebody") {
        // Emitted BEFORE the base call resolves — jobId is not yet known client-side. The old
        // (buggy) streamRebody dropped this silently (`jobId === undefined` at delivery time);
        // a correct client buffers it and renders it once jobId is known. Without the fix this
        // also leaves the returned promise unresolved (index.rebodyDone would be dropped too),
        // so this test times out rather than merely failing an assertion on a regression.
        mock.emit("index.rebodyProgress", {
          jobId: "job-rebody-race",
          done: 1,
          total: 3,
          service: "slack",
        });
        mock.emit("index.rebodyDone", {
          jobId: "job-rebody-race",
          durationMs: 5,
          dryRun: false,
          targeted: ["slack"],
          succeeded: 1,
          failed: 0,
          failedServices: [],
          warnings: [],
          cannotImprove: [],
          pendingBefore: { slack: 1 },
          pendingAfter: { slack: 0 },
        });
      }
      return baseClient.call(m, p);
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
    await runIndexCmd(["rebody", "--yes"]);
    expect(out.stdout).toMatch(/progress: 1\/3 \(slack\)/);
    expect(out.stdout).toMatch(/slack: 1 -> 0/);
  }, 2000);
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
