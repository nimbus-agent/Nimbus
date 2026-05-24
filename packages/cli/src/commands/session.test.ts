// packages/cli/src/commands/session.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const sessionMod = await import("./session.ts");
const { runSession } = sessionMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runSession", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runSession(["list"])).rejects.toThrow(
      /Gateway is not running\. Start with: nimbus start/,
    );
  });

  it("'list' calls session.list and prints sessions JSON", async () => {
    const mock = createMockIpcClient([{ sessions: [{ id: "s1" }] }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSession(["list"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "session.list", params: {} });
    expect(out.stdout).toContain('"id": "s1"');
  });

  it("no-subcommand falls through to 'list'", async () => {
    const mock = createMockIpcClient([{ sessions: [] }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSession([]);
    expect(mock.calls[0]?.method).toBe("session.list");
  });

  it("'clear' without sessionId calls session.clear with empty payload", async () => {
    const mock = createMockIpcClient([{ cleared: 0 }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSession(["clear"]);
    expect(mock.calls[0]).toEqual({ method: "session.clear", params: {} });
  });

  it("'clear <sessionId>' passes sessionId to session.clear", async () => {
    const mock = createMockIpcClient([{ cleared: 1 }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSession(["clear", "abc-123"]);
    expect(mock.calls[0]).toEqual({
      method: "session.clear",
      params: { sessionId: "abc-123" },
    });
  });

  it("'recall' calls session.recall with sessionId/query/topK", async () => {
    const mock = createMockIpcClient([{ chunks: [] }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSession(["recall", "sess-1", "hello", "world"]);
    expect(mock.calls[0]).toEqual({
      method: "session.recall",
      params: { sessionId: "sess-1", query: "hello world", topK: 8 },
    });
  });

  it("'recall' without sessionId or query throws usage", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runSession(["recall"])).rejects.toThrow(/Usage: nimbus session recall/);
    await expect(runSession(["recall", "sess-1"])).rejects.toThrow(/Usage: nimbus session recall/);
  });

  it("unknown subcommand throws usage", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runSession(["bogus"])).rejects.toThrow(/Usage: nimbus session/);
  });
});
