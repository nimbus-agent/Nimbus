import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { parseScimArgs, runScim, runScimCommand, type ScimIpc } from "./scim.ts";
import { type CallRecord, captureStdout, makeQueuedCall } from "./testing/cli-test-helpers.ts";

// ---------------------------------------------------------------------------
// Parser tests (unchanged)
// ---------------------------------------------------------------------------

test("status / list-users defaults", () => {
  expect(parseScimArgs(["status"])).toEqual({ kind: "status" });
  expect(parseScimArgs(["list-users"])).toEqual({ kind: "listUsers" });
});
test("empty argv defaults to status", () => {
  expect(parseScimArgs([])).toEqual({ kind: "status" });
});
test("set-token requires a token", () => {
  expect(parseScimArgs(["set-token", "secret"])).toEqual({ kind: "setToken", token: "secret" });
  expect(() => parseScimArgs(["set-token"])).toThrow();
});
test("deprovision requires an email", () => {
  expect(parseScimArgs(["deprovision", "a@acme.com"])).toEqual({
    kind: "deprovision",
    email: "a@acme.com",
  });
  expect(() => parseScimArgs(["deprovision"])).toThrow();
});

// ---------------------------------------------------------------------------
// Fake ScimIpc helper
// ---------------------------------------------------------------------------

function makeFake(responseQueue: readonly unknown[]): { ipc: ScimIpc; calls: CallRecord[] } {
  const { call, calls } = makeQueuedCall(responseQueue);
  return { ipc: { call, disconnect: async (): Promise<void> => {} }, calls };
}

// ---------------------------------------------------------------------------
// runScimCommand dispatcher tests
// ---------------------------------------------------------------------------

describe("runScimCommand — status", () => {
  it("calls scim.status and writes JSON output", async () => {
    const fake = makeFake([{ enabled: true, userCount: 3 }]);
    const out = await captureStdout(() => runScimCommand(fake.ipc, { kind: "status" }));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ method: "scim.status", params: {} });
    expect(out).toContain("userCount");
  });
});

describe("runScimCommand — setToken", () => {
  it("calls scim.setToken with the token and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const out = await captureStdout(() =>
      runScimCommand(fake.ipc, { kind: "setToken", token: "tok-secret" }),
    );
    expect(fake.calls[0]).toEqual({
      method: "scim.setToken",
      params: { token: "tok-secret" },
    });
    expect(out).toContain("SCIM bearer token stored.");
  });
});

describe("runScimCommand — listUsers", () => {
  it("calls scim.listUsers and writes JSON output", async () => {
    const fake = makeFake([{ users: [{ email: "bob@acme.com" }] }]);
    const out = await captureStdout(() => runScimCommand(fake.ipc, { kind: "listUsers" }));
    expect(fake.calls[0]).toEqual({ method: "scim.listUsers", params: {} });
    expect(out).toContain("bob@acme.com");
  });
});

describe("runScimCommand — deprovision", () => {
  it("calls scim.deprovision with the email and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const out = await captureStdout(() =>
      runScimCommand(fake.ipc, { kind: "deprovision", email: "carol@acme.com" }),
    );
    expect(fake.calls[0]).toEqual({
      method: "scim.deprovision",
      params: { email: "carol@acme.com" },
    });
    expect(out).toContain("carol@acme.com");
  });
});

// ---------------------------------------------------------------------------
// runScim orchestration wrapper (injectable seams)
// ---------------------------------------------------------------------------

describe("runScim wrapper", () => {
  const realExit = process.exit;
  const realStderr = process.stderr.write.bind(process.stderr);
  function stubExitAndStderr(): { exitCodes: number[]; err: string[] } {
    const exitCodes: number[] = [];
    const err: string[] = [];
    process.exit = ((code?: number): never => {
      exitCodes.push(code ?? 0);
      throw new Error("__exit__");
    }) as unknown as typeof process.exit;
    process.stderr.write = ((chunk: unknown): boolean => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    return { exitCodes, err };
  }
  beforeEach(() => {
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exit = realExit;
    process.stderr.write = realStderr;
    process.exitCode = 0;
  });

  it("parse error → writes usage to stderr and exits 1", async () => {
    const { exitCodes, err } = stubExitAndStderr();
    await expect(runScim(["totally-unknown-subcommand"])).rejects.toThrow("__exit__");
    expect(exitCodes).toEqual([1]);
    expect(err.join("")).toContain("Unknown subcommand");
  });

  it("no gateway running → writes hint and exits 1", async () => {
    const { exitCodes, err } = stubExitAndStderr();
    await expect(runScim(["status"], { readState: async () => undefined })).rejects.toThrow(
      "__exit__",
    );
    expect(exitCodes).toEqual([1]);
    expect(err.join("")).toContain("Gateway is not running");
  });

  it("connects, dispatches, then disconnects on the happy path", async () => {
    const fake = makeFake([{ enabled: true }]);
    let disconnected = false;
    const ipc: ScimIpc = {
      call: fake.ipc.call,
      disconnect: async (): Promise<void> => {
        disconnected = true;
      },
    };
    await captureStdout(() =>
      runScim(["status"], {
        readState: async () => ({ socketPath: "pipe://test" }),
        connect: async () => ipc,
      }),
    );
    expect(fake.calls[0]).toEqual({ method: "scim.status", params: {} });
    expect(disconnected).toBe(true);
  });

  it("runScimCommand error → finally block still calls disconnect", async () => {
    let disconnected = false;
    const ipc: ScimIpc = {
      call: async (_method: string, _params?: unknown): Promise<never> => {
        throw new Error("IPC failure");
      },
      disconnect: async (): Promise<void> => {
        disconnected = true;
      },
    };
    await expect(
      runScim(["status"], {
        readState: async () => ({ socketPath: "pipe://test" }),
        connect: async () => ipc,
      }),
    ).rejects.toThrow("IPC failure");
    expect(disconnected).toBe(true);
  });

  it("disconnect throwing is silently suppressed by .catch(()=>{})", async () => {
    const fake = makeFake([{ enabled: true }]);
    const ipc: ScimIpc = {
      call: fake.ipc.call,
      disconnect: async (): Promise<void> => {
        throw new Error("disconnect failed");
      },
    };
    // Should NOT throw — disconnect error is swallowed
    await captureStdout(() =>
      runScim(["status"], {
        readState: async () => ({ socketPath: "pipe://test" }),
        connect: async () => ipc,
      }),
    );
    expect(fake.calls[0]).toEqual({ method: "scim.status", params: {} });
  });

  it("set-token subcommand dispatches through the full wrapper", async () => {
    const fake = makeFake([{}]);
    const ipc: ScimIpc = {
      call: fake.ipc.call,
      disconnect: async (): Promise<void> => {},
    };
    const out = await captureStdout(() =>
      runScim(["set-token", "my-bearer-token"], {
        readState: async () => ({ socketPath: "pipe://test" }),
        connect: async () => ipc,
      }),
    );
    expect(fake.calls[0]).toEqual({
      method: "scim.setToken",
      params: { token: "my-bearer-token" },
    });
    expect(out).toContain("SCIM bearer token stored.");
  });

  it("list-users subcommand dispatches through the full wrapper", async () => {
    const fake = makeFake([{ users: [] }]);
    const ipc: ScimIpc = {
      call: fake.ipc.call,
      disconnect: async (): Promise<void> => {},
    };
    const out = await captureStdout(() =>
      runScim(["list-users"], {
        readState: async () => ({ socketPath: "pipe://test" }),
        connect: async () => ipc,
      }),
    );
    expect(fake.calls[0]).toEqual({ method: "scim.listUsers", params: {} });
    expect(out).toContain("users");
  });

  it("deprovision subcommand dispatches through the full wrapper", async () => {
    const fake = makeFake([{}]);
    const ipc: ScimIpc = {
      call: fake.ipc.call,
      disconnect: async (): Promise<void> => {},
    };
    const out = await captureStdout(() =>
      runScim(["deprovision", "user@example.com"], {
        readState: async () => ({ socketPath: "pipe://test" }),
        connect: async () => ipc,
      }),
    );
    expect(fake.calls[0]).toEqual({
      method: "scim.deprovision",
      params: { email: "user@example.com" },
    });
    expect(out).toContain("user@example.com");
  });
});
