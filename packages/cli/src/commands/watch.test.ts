import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./watch.ts");
const { runWatch, runWatchList, runWatchPause, runWatchResume } = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runWatchList", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls watcher.list and prints the response", async () => {
    const ipc = createMockIpcClient([{ watchers: [{ id: "w-1" }] }]);
    await runWatchList(ipc.client);
    expect(ipc.calls[0]).toEqual({ method: "watcher.list", params: {} });
    expect(out.stdout).toContain("w-1");
  });
});

describe("runWatchPause", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when id is empty", async () => {
    const ipc = createMockIpcClient([]);
    await expect(runWatchPause(ipc.client, "")).rejects.toThrow("Usage: nimbus watch pause <id>");
  });

  it("calls watcher.pause and prints the response", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWatchPause(ipc.client, "w-1");
    expect(ipc.calls[0]).toEqual({ method: "watcher.pause", params: { id: "w-1" } });
    expect(out.stdout).toContain('"ok": true');
  });
});

describe("runWatchResume", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when id is empty", async () => {
    const ipc = createMockIpcClient([]);
    await expect(runWatchResume(ipc.client, "")).rejects.toThrow("Usage: nimbus watch resume <id>");
  });

  it("calls watcher.resume and prints the response", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWatchResume(ipc.client, "w-2");
    expect(ipc.calls[0]).toEqual({ method: "watcher.resume", params: { id: "w-2" } });
    expect(out.stdout).toContain('"ok": true');
  });
});

describe("runWatch (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runWatch(["list"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("throws on unknown subcommand", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runWatch(["bogus"])).rejects.toThrow("Usage: nimbus watch");
  });

  it("routes 'list' to watcher.list when gateway is running", async () => {
    const ipc = createMockIpcClient([{ watchers: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWatch(["list"]);
    expect(ipc.calls[0]?.method).toBe("watcher.list");
  });

  it("routes empty args to 'list'", async () => {
    const ipc = createMockIpcClient([{ watchers: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWatch([]);
    expect(ipc.calls[0]?.method).toBe("watcher.list");
  });

  it("routes 'pause <id>' through IPC", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWatch(["pause", "w-1"]);
    expect(ipc.calls[0]).toEqual({ method: "watcher.pause", params: { id: "w-1" } });
  });

  it("routes 'resume <id>' through IPC", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWatch(["resume", "w-2"]);
    expect(ipc.calls[0]).toEqual({ method: "watcher.resume", params: { id: "w-2" } });
  });
});
