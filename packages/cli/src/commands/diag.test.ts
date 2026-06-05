import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const diagMod = await import("./diag.ts");
const { runDiag } = diagMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runDiag (help)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help on 'help'", async () => {
    await runDiag(["help"]);
    expect(out.stdout).toContain("nimbus diag");
  });

  it("prints help on --help and -h", async () => {
    await runDiag(["--help"]);
    expect(out.stdout).toContain("nimbus diag");
    out.reset();
    await runDiag(["-h"]);
    expect(out.stdout).toContain("nimbus diag");
  });
});

describe("runDiag (snapshot)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls diag.snapshot when no subcommand is given", async () => {
    const ipc = createMockIpcClient([{ index: { totalItems: 42 } }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDiag([]);
    expect(ipc.calls[0]).toEqual({ method: "diag.snapshot", params: {} });
    expect(out.stdout).toContain('"totalItems": 42');
  });

  it("calls diag.snapshot when --json is given", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDiag(["--json"]);
    expect(ipc.calls[0]).toEqual({ method: "diag.snapshot", params: {} });
    expect(out.stdout).toContain('"ok": true');
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runDiag([])).rejects.toThrow("Gateway is not running. Start with: nimbus start");
  });
});

describe("runDiag (slow-queries)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls diag.slowQueries with the default limit (50) and sinceMs:0 when no flags are given", async () => {
    const ipc = createMockIpcClient([{ rows: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDiag(["slow-queries"]);
    expect(ipc.calls[0]?.method).toBe("diag.slowQueries");
    const params = ipc.calls[0]?.params as { limit: number; sinceMs: number };
    expect(params.limit).toBe(50);
    expect(params.sinceMs).toBe(0);
    expect(out.stdout).toContain("[]");
  });

  it("respects --limit", async () => {
    const ipc = createMockIpcClient([{ rows: [{ q: "select 1" }] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runDiag(["slow-queries", "--limit", "10"]);
    const params = ipc.calls[0]?.params as { limit: number; sinceMs: number };
    expect(params.limit).toBe(10);
    expect(out.stdout).toContain('"q": "select 1"');
  });

  it("converts --since to a sinceMs window", async () => {
    const ipc = createMockIpcClient([{ rows: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    const before = Date.now();
    await runDiag(["slow-queries", "--since", "1h"]);
    const after = Date.now();
    const params = ipc.calls[0]?.params as { limit: number; sinceMs: number };
    const expectedMin = before - 3_600_000;
    const expectedMax = after - 3_600_000;
    expect(params.sinceMs).toBeGreaterThanOrEqual(expectedMin);
    expect(params.sinceMs).toBeLessThanOrEqual(expectedMax);
  });
});

describe("runDiag (unknown subcommand)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("rejects unknown subcommands", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runDiag(["bogus"])).rejects.toThrow("Unknown diag subcommand: bogus");
  });
});
