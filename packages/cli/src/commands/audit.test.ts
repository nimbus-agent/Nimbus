// packages/cli/src/commands/audit.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const auditMod = await import("./audit.ts");
const { runAudit, runAuditExport, runAuditList, runAuditVerify } = auditMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runAuditList", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls audit.list with the given limit and prints rows", async () => {
    const { client, calls } = createMockIpcClient([
      [
        {
          id: 1,
          actionType: "file.delete",
          hitlStatus: "rejected",
          actionJson: '{"hitlRejectReason":"user-cancelled"}',
          timestamp: 1700000000000,
        },
      ],
    ]);
    await runAuditList(client, 25);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "audit.list", params: { limit: 25 } });
    expect(out.stdout).toContain("Timestamp");
    expect(out.stdout).toContain("file.delete");
    expect(out.stdout).toContain("rejected");
    expect(out.stdout).toContain("user-cancelled");
  });

  it("renders '—' when actionJson has no hitlRejectReason", async () => {
    const { client } = createMockIpcClient([
      [
        {
          id: 1,
          actionType: "file.move",
          hitlStatus: "approved",
          actionJson: '{"foo":"bar"}',
          timestamp: 1700000000000,
        },
      ],
    ]);
    await runAuditList(client, 10);
    expect(out.stdout).toContain("file.move");
    expect(out.stdout).toContain("—");
  });

  it("survives malformed actionJson without throwing", async () => {
    const { client } = createMockIpcClient([
      [
        {
          id: 1,
          actionType: "x",
          hitlStatus: "approved",
          actionJson: "{not-json",
          timestamp: 1700000000000,
        },
      ],
    ]);
    await runAuditList(client, 10);
    expect(out.stdout).toContain("x");
  });
});

describe("runAuditVerify", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("prints success and sets exit code 0 when ok", async () => {
    const { client, calls } = createMockIpcClient([{ ok: true, verifiedRows: 42 }]);
    await runAuditVerify(client, false);
    expect(calls[0]).toEqual({ method: "audit.verify", params: { full: false } });
    expect(out.stdout).toContain("[ok]");
    expect(out.stdout).toContain("42 rows verified");
    expect(process.exitCode).toBe(0);
  });

  it("passes full:true through", async () => {
    const { client, calls } = createMockIpcClient([{ ok: true, verifiedRows: 0 }]);
    await runAuditVerify(client, true);
    expect(calls[0]).toEqual({ method: "audit.verify", params: { full: true } });
  });

  it("prints chain break and sets exit code 1 when ok is false", async () => {
    const { client } = createMockIpcClient([
      { ok: false, verifiedRows: 5, firstBreakAtId: 6, reason: "blake3 mismatch" },
    ]);
    await runAuditVerify(client, false);
    expect(out.stdout).toContain("[FAIL]");
    expect(out.stdout).toContain("chain break at row 6");
    expect(out.stdout).toContain("blake3 mismatch");
    expect(process.exitCode).toBe(1);
  });
});

describe("runAuditExport", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls audit.exportAll and writes the JSON via the injected writer", async () => {
    const writes: { path: string; data: string }[] = [];
    const writeFile = async (p: string, data: string): Promise<void> => {
      writes.push({ path: p, data });
    };
    const { client, calls } = createMockIpcClient([[{ id: 1 }, { id: 2 }]]);
    await runAuditExport(client, "/tmp/out.json", writeFile);
    expect(calls[0]).toEqual({ method: "audit.exportAll", params: {} });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/tmp/out.json");
    expect(writes[0]?.data).toContain('"id": 1');
    expect(out.stdout).toContain("wrote 2 audit rows to /tmp/out.json");
  });
});

describe("runAudit (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("rejects 'export' without --output", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runAudit(["export"])).rejects.toThrow("Usage: nimbus audit export --output");
  });

  it("dispatches 'verify' through withIpc", async () => {
    const ipc = createMockIpcClient([{ ok: true, verifiedRows: 3 }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runAudit(["verify"]);
    expect(ipc.calls[0]?.method).toBe("audit.verify");
  });

  it("dispatches the bare list path through withIpc with the default limit (50)", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runAudit([]);
    expect(ipc.calls[0]).toEqual({ method: "audit.list", params: { limit: 50 } });
  });

  it("respects --limit in the bare list path", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runAudit(["--limit", "7"]);
    expect(ipc.calls[0]).toEqual({ method: "audit.list", params: { limit: 7 } });
  });

  it("throws the gateway-not-running error from the verify branch", async () => {
    setFixture({});
    await expect(runAudit(["verify"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });
});
