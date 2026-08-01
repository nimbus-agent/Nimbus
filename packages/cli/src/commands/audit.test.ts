import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  fakePath,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
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
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
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

  it("renders '—' when actionJson parses to a JSON array (not an object)", async () => {
    const { client } = createMockIpcClient([
      [
        {
          id: 1,
          actionType: "file.read",
          hitlStatus: "approved",
          actionJson: '["a","b"]',
          timestamp: 1700000000000,
        },
      ],
    ]);
    await runAuditList(client, 10);
    expect(out.stdout).toContain("file.read");
    expect(out.stdout).toContain("—");
  });

  it("renders an empty table when the rows list is empty", async () => {
    const { client, calls } = createMockIpcClient([[]]);
    await runAuditList(client, 5);
    expect(calls[0]).toEqual({ method: "audit.list", params: { limit: 5 } });
    expect(out.stdout).toContain("Timestamp");
    expect(out.stdout).toContain("-".repeat(72));
  });
});

describe("runAuditVerify", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
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

  it("uses 'unknown' as fallback reason when reason is omitted", async () => {
    const { client } = createMockIpcClient([{ ok: false, verifiedRows: 2, firstBreakAtId: 3 }]);
    await runAuditVerify(client, false);
    expect(out.stdout).toContain("[FAIL]");
    expect(out.stdout).toContain("unknown");
    expect(process.exitCode).toBe(1);
  });
});

describe("runAuditExport", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
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
    const outPath = fakePath("out.json");
    await runAuditExport(client, outPath, writeFile);
    expect(calls[0]).toEqual({ method: "audit.exportAll", params: {} });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(outPath);
    expect(writes[0]?.data).toContain('"id": 1');
    expect(out.stdout).toContain(`wrote 2 audit rows to ${outPath}`);
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
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runAudit(["export"])).rejects.toThrow("Usage: nimbus audit export --output");
  });

  it("dispatches 'verify' through withIpc", async () => {
    const ipc = createMockIpcClient([{ ok: true, verifiedRows: 3 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runAudit(["verify"]);
    expect(ipc.calls[0]?.method).toBe("audit.verify");
  });

  it("dispatches the bare list path through withIpc with the default limit (50)", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runAudit([]);
    expect(ipc.calls[0]).toEqual({ method: "audit.list", params: { limit: 50 } });
  });

  // A usable --limit is passed through; anything non-finite or non-positive falls back to 50.
  it.each([
    ["a valid value is respected", "7", 7],
    ["an invalid (non-finite) value falls back to 50", "abc", 50],
    ["zero falls back to 50", "0", 50],
  ])("--limit in the bare list path: %s", async (_label, raw, limit) => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runAudit(["--limit", raw]);
    expect(ipc.calls[0]).toEqual({ method: "audit.list", params: { limit } });
  });

  it("throws the gateway-not-running error from the verify branch", async () => {
    setFixture({});
    await expect(runAudit(["verify"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("passes --full flag through to runAuditVerify", async () => {
    const ipc = createMockIpcClient([{ ok: true, verifiedRows: 1 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    process.exitCode = 0;
    await runAudit(["verify", "--full"]);
    expect(ipc.calls[0]).toEqual({ method: "audit.verify", params: { full: true } });
    process.exitCode = 0;
  });

  it("rejects 'export' with an empty --output value", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runAudit(["export", "--output", ""])).rejects.toThrow(
      "Usage: nimbus audit export --output",
    );
  });

  it("dispatches 'export' with a valid --output path through withIpc", async () => {
    const writes: { path: string; data: string }[] = [];
    const ipc = createMockIpcClient([[{ id: 10 }]]);
    const outPath = fakePath("export.json");
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    // Patch Bun.write via the injected writeFile — but the outer runAudit uses Bun.write directly.
    // We test the dispatcher wiring by verifying the IPC call was made and output logged.
    // Override Bun.write for this test to avoid actual file I/O.
    const origWrite = Bun.write.bind(Bun);
    (Bun as { write: unknown }).write = async (p: unknown, data: unknown): Promise<number> => {
      writes.push({ path: String(p), data: String(data) });
      return 0;
    };
    try {
      await runAudit(["export", "--output", outPath]);
    } finally {
      (Bun as { write: unknown }).write = origWrite;
    }
    expect(ipc.calls[0]).toEqual({ method: "audit.exportAll", params: {} });
    expect(writes[0]?.path).toBe(outPath);
    expect(out.stdout).toContain(`wrote 1 audit rows to ${outPath}`);
  });
});

describe("nimbus audit --json", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
  });
  afterEach(() => {
    clearFixture();
  });

  type AuditJsonRow = {
    id: number;
    actionType: string;
    hitlStatus: string;
    actionJson: string;
    timestamp: number;
  };

  /** Parses the whole of stdout — proves the table header never reached stdout. */
  function parseStdout(): AuditJsonRow[] {
    return JSON.parse(out.stdout) as AuditJsonRow[];
  }

  it("emits the audit.list rows as a parseable array with no table on stdout", async () => {
    const { client } = createMockIpcClient([
      [
        {
          id: 1,
          actionType: "file.delete",
          hitlStatus: "rejected",
          actionJson: '{"hitlRejectReason":"user-cancelled"}',
          timestamp: 1_700_000_000_000,
        },
      ],
    ]);
    await runAuditList(client, 25, { json: true });

    const rows = parseStdout();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.actionType).toBe("file.delete");
    expect(rows[0]?.hitlStatus).toBe("rejected");
    expect(rows[0]?.timestamp).toBe(1_700_000_000_000);
    // actionJson stays the stored string, malformed payloads included.
    expect(rows[0]?.actionJson).toBe('{"hitlRejectReason":"user-cancelled"}');
    expect(out.stdout).not.toContain("Timestamp");
  });

  it("keeps malformed actionJson verbatim instead of dropping the row", async () => {
    const { client } = createMockIpcClient([
      [
        {
          id: 2,
          actionType: "file.move",
          hitlStatus: "approved",
          actionJson: "not-json",
          timestamp: 1_700_000_000_001,
        },
      ],
    ]);
    await runAuditList(client, 50, { json: true });

    expect(parseStdout()[0]?.actionJson).toBe("not-json");
  });

  it("is routed from the bare dispatcher path, honouring --limit alongside --json", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runAudit(["--limit", "7", "--json"]);

    expect(ipc.calls[0]).toEqual({ method: "audit.list", params: { limit: 7 } });
    expect(parseStdout()).toEqual([]);
  });
});
