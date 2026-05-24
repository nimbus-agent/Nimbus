// packages/cli/src/commands/connector.test.ts
//
// Covers the `nimbus connector` subcommand surface via the top-level
// dispatcher `runConnector(args)`. The dispatcher's `withIpc()` helper
// reads the gateway state from the mocked `lib/gateway-process.ts` and
// constructs an IPCClient — we route the IPC call through the harness's
// fixture-provided fake client.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const connectorMod = await import("./connector.ts");
const { runConnector } = connectorMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runConnector help / dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help when no subcommand is given", async () => {
    await runConnector([]);
    expect(out.stdout).toContain("nimbus connector");
    expect(out.stdout).toContain("Usage:");
  });

  it("prints help for 'help'", async () => {
    await runConnector(["help"]);
    expect(out.stdout).toContain("nimbus connector");
  });

  it("prints help for --help", async () => {
    await runConnector(["--help"]);
    expect(out.stdout).toContain("nimbus connector");
  });

  it("throws on unknown subcommand", async () => {
    await expect(runConnector(["bogus"])).rejects.toThrow("Unknown connector subcommand: bogus");
  });

  it("throws gateway-not-running for IPC-bound subcommands", async () => {
    setFixture({});
    await expect(runConnector(["list"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });
});

describe("runConnector list", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls connector.listStatus and renders a table of rows", async () => {
    const ipc = createMockIpcClient([
      [
        {
          serviceId: "github",
          status: "ok",
          lastSyncAt: null,
          nextSyncAt: null,
          intervalMs: 60_000,
          itemCount: 12,
          lastError: null,
          consecutiveFailures: 0,
          healthState: "healthy",
          healthRetryAfterMs: null,
        },
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["list"]);
    expect(ipc.calls[0]).toEqual({ method: "connector.listStatus", params: undefined });
    expect(out.stdout).toContain("SERVICE");
    expect(out.stdout).toContain("github");
    expect(out.stdout).toContain("healthy");
  });

  it("prints empty-state hint when no connectors registered", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["list"]);
    expect(out.stdout).toContain("No connectors registered yet");
  });
});

describe("runConnector status / pause / resume", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("dispatches status with the serviceId and prints JSON", async () => {
    const row = {
      serviceId: "github",
      status: "ok",
      lastSyncAt: 1700000000000,
      nextSyncAt: null,
      intervalMs: 60_000,
      itemCount: 5,
      lastError: null,
      consecutiveFailures: 0,
    };
    const ipc = createMockIpcClient([row]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["status", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.status",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain('"serviceId": "github"');
  });

  it("status with --stats sets includeStats:true", async () => {
    const ipc = createMockIpcClient([
      {
        serviceId: "github",
        status: "ok",
        lastSyncAt: null,
        nextSyncAt: null,
        intervalMs: 60_000,
        itemCount: 0,
        lastError: null,
        consecutiveFailures: 0,
        telemetry: [],
      },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["status", "github", "--stats"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.status",
      params: { serviceId: "github", includeStats: true },
    });
  });

  it("status throws when service id is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runConnector(["status"])).rejects.toThrow(
      "Usage: nimbus connector status <service>",
    );
  });

  it("dispatches pause", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["pause", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.pause",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain("Paused: github");
  });

  it("dispatches resume", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["resume", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.resume",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain("Resumed: github");
  });

  it("pause throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runConnector(["pause"])).rejects.toThrow(
      "Usage: nimbus connector pause <service>",
    );
  });
});

describe("runConnector history", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls connector.healthHistory with default limit (100)", async () => {
    const ipc = createMockIpcClient([
      [
        {
          id: 1,
          connectorId: "github",
          fromState: "healthy",
          toState: "degraded",
          reason: "rate-limited",
          occurredAtMs: 1700000000000,
        },
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["history", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.healthHistory",
      params: { serviceId: "github", limit: 100 },
    });
    expect(out.stdout).toContain('"connectorId": "github"');
    expect(out.stdout).toContain("degraded");
  });

  it("respects --limit", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["history", "github", "--limit", "25"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.healthHistory",
      params: { serviceId: "github", limit: 25 },
    });
  });

  it("history throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runConnector(["history"])).rejects.toThrow(
      "Usage: nimbus connector history <service>",
    );
  });
});

describe("runConnector sync", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("dispatches sync without --full", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["sync", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.sync",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain("Sync requested: github");
  });

  it("dispatches sync --full", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["sync", "github", "--full"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.sync",
      params: { serviceId: "github", full: true },
    });
    expect(out.stdout).toContain("(full)");
  });

  it("sync throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runConnector(["sync"])).rejects.toThrow("Usage: nimbus connector sync");
  });
});

describe("runConnector reindex", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls connector.reindex with default depth metadata_only", async () => {
    const ipc = createMockIpcClient([{ itemsAffected: 7, mode: "metadata_only" }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["reindex", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.reindex",
      params: { service: "github", depth: "metadata_only" },
    });
    expect(out.stdout).toContain("7 items affected");
  });

  it("passes --depth full", async () => {
    const ipc = createMockIpcClient([{ itemsAffected: 0, mode: "full" }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["reindex", "github", "--depth", "full"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.reindex",
      params: { service: "github", depth: "full" },
    });
  });

  it("reindex throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runConnector(["reindex"])).rejects.toThrow(
      "Usage: nimbus connector reindex <name>",
    );
  });
});

describe("runConnector remove", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("dispatches connector.remove and prints summary", async () => {
    const ipc = createMockIpcClient([
      { ok: true, itemsDeleted: 12, vaultKeysRemoved: ["github.pat"] },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["remove", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.remove",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain("Removed index rows: 12");
    expect(out.stdout).toContain("github.pat");
  });

  it("omits the vault-keys line when none were removed", async () => {
    const ipc = createMockIpcClient([{ ok: true, itemsDeleted: 0, vaultKeysRemoved: [] }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["remove", "github"]);
    expect(out.stdout).toContain("Removed index rows: 0");
    expect(out.stdout).not.toContain("Cleared vault keys:");
  });

  it("remove throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runConnector(["remove"])).rejects.toThrow("Usage: nimbus connector remove");
  });
});

describe("runConnector set-interval", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("converts a duration string and dispatches connector.setInterval", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["set-interval", "github", "5m"]);
    expect(ipc.calls[0]?.method).toBe("connector.setInterval");
    const params = ipc.calls[0]?.params as { serviceId: string; intervalMs: number };
    expect(params.serviceId).toBe("github");
    expect(params.intervalMs).toBe(5 * 60 * 1000);
    expect(out.stdout).toContain("Interval set: github → 5m");
  });

  it("throws when both args are missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runConnector(["set-interval"])).rejects.toThrow(
      "Usage: nimbus connector set-interval",
    );
  });
});

describe("runConnector auth (help / usage)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help pointer when --help is passed with no service", async () => {
    await runConnector(["auth", "--help"]);
    // Help pointer / known OAuth env help should appear somewhere in stdout.
    expect(out.stdout.length).toBeGreaterThan(0);
  });

  it("prints PAT-only help when --help is passed with a PAT-only service", async () => {
    await runConnector(["auth", "github", "--help"]);
    expect(out.stdout.length).toBeGreaterThan(0);
  });

  it("throws usage when no service is provided", async () => {
    await expect(runConnector(["auth"])).rejects.toThrow("Usage: nimbus connector auth <service>");
  });
});

describe("runConnector add", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("rejects bare 'add' without --mcp", async () => {
    await expect(runConnector(["add"])).rejects.toThrow(
      "Usage: nimbus connector add --mcp <mcp_id> <command...>",
    );
  });

  it("dispatches add --mcp <id> <command>", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["add", "--mcp", "mcp_test", "npx", "-y", "@some/mcp-server"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.addMcp",
      params: { serviceId: "mcp_test", commandLine: "npx -y @some/mcp-server" },
    });
    expect(out.stdout).toContain("Registered user MCP connector: mcp_test");
  });
});
