// packages/cli/src/commands/index-cmd.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
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

  it("reembed without --model throws usage error", async () => {
    await expect(runIndexCmd(["reembed"])).rejects.toThrow(/--model/);
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
    // The MockIpcClient stores a handler when the code subscribes via
    // onNotification; we then trigger that handler via `emit()` inside
    // the .call() resolution so it fires after the await resolves jobId.
    const mock = createMockIpcClient([{ jobId: "job-1" }]);
    // Wire the call so once the runReembed handler subscribes + then
    // resolves the initial call, we emit progress + done synchronously
    // from a Promise microtask scheduled by the .call() trampoline.
    // Easiest: replace the inner call function so it emits before
    // resolving the jobId.
    const baseClient = mock.client as unknown as {
      call: (m: string, p: unknown) => Promise<unknown>;
    };
    const wrappedCall = async (m: string, p: unknown): Promise<unknown> => {
      const r = await baseClient.call(m, p);
      if (m === "index.reembed") {
        // Microtask: subscriptions are registered BEFORE .call() resolves
        // in the production code (see index-cmd.ts), so by the time we
        // emit here the handlers are already in place.
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
    // No progress lines under --json
    expect(out.stdout).not.toMatch(/progress: /);
    // The single trailing line should be parseable JSON with the summary.
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
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
