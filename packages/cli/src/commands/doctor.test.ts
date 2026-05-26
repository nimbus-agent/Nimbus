// packages/cli/src/commands/doctor.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

// Doctor's pure helpers are dependency-free, but importing `./doctor.ts`
// pulls in `gateway-process.ts` (transitively used by `runDoctor`).
// We import via the shared CLI test harness so the gateway-process /
// ipc-client mocks are installed before doctor.ts evaluates.
import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const doctorMod = await import("./doctor.ts");
const {
  doctorPrintConfigValidation,
  doctorPrintHealthFromSnapshot,
  doctorPrintIndexFromSnapshot,
  healthStateMark,
  runDoctor,
  worstHealthSeverity,
} = doctorMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("worstHealthSeverity", () => {
  it("returns 'ok' for an empty list", () => {
    expect(worstHealthSeverity([])).toBe("ok");
  });

  it("returns 'ok' when every state is healthy", () => {
    expect(
      worstHealthSeverity([
        { connectorId: "a", state: "healthy" },
        { connectorId: "b", state: "paused" },
      ]),
    ).toBe("ok");
  });

  it("returns 'warn' for degraded or rate_limited", () => {
    expect(worstHealthSeverity([{ state: "degraded" }])).toBe("warn");
    expect(worstHealthSeverity([{ state: "rate_limited" }])).toBe("warn");
  });

  it("escalates to 'fail' when error or unauthenticated is present", () => {
    expect(worstHealthSeverity([{ state: "degraded" }, { state: "error" }])).toBe("fail");
    expect(worstHealthSeverity([{ state: "unauthenticated" }])).toBe("fail");
  });
});

describe("healthStateMark", () => {
  it.each([
    ["healthy", "[ok]"],
    ["paused", "[ok]"],
    ["error", "[fail]"],
    ["unauthenticated", "[fail]"],
    ["degraded", "[warn]"],
    ["rate_limited", "[warn]"],
    ["unknown", "[warn]"],
  ])("maps state '%s' to '%s'", (state, expected) => {
    expect(healthStateMark(state)).toBe(expected);
  });
});

describe("doctorPrintConfigValidation", () => {
  beforeEach(() => {
    out.reset();
  });

  it("returns 0 and prints '[ok]' when no errors and no warnings", () => {
    const code = doctorPrintConfigValidation({ ok: true, errors: [], warnings: [] });
    expect(code).toBe(0);
    expect(out.stdout).toContain("[ok] Config: valid.");
  });

  it("returns 1 and prints warnings when ok is true with warnings", () => {
    const code = doctorPrintConfigValidation({
      ok: true,
      errors: [],
      warnings: ["llm.remote_model is unset"],
    });
    expect(code).toBe(1);
    expect(out.stdout).toContain("[warn] Config: llm.remote_model is unset");
  });

  it("returns 2 and prints errors when ok is false", () => {
    const code = doctorPrintConfigValidation({
      ok: false,
      errors: ["bad section"],
      warnings: [],
    });
    expect(code).toBe(2);
    expect(out.stdout).toContain("[fail] Config: bad section");
  });
});

describe("doctorPrintIndexFromSnapshot", () => {
  beforeEach(() => {
    out.reset();
  });

  it("returns 1 and warns when totalItems is 0 or missing", () => {
    expect(doctorPrintIndexFromSnapshot({ index: { totalItems: 0 } })).toBe(1);
    expect(out.stdout).toContain("[warn] Index: zero items");
  });

  it("returns 0 and prints the count when totalItems is positive", () => {
    expect(doctorPrintIndexFromSnapshot({ index: { totalItems: 1234 } })).toBe(0);
    expect(out.stdout).toContain("[ok] Index: 1234 items.");
  });
});

describe("doctorPrintHealthFromSnapshot", () => {
  beforeEach(() => {
    out.reset();
  });

  it("returns 1 and warns when no connectors are present", () => {
    expect(doctorPrintHealthFromSnapshot({ connectorHealth: [] })).toBe(1);
    expect(out.stdout).toContain("[warn] Connectors: none registered.");
  });

  it("returns 0 when all connectors are healthy", () => {
    const code = doctorPrintHealthFromSnapshot({
      connectorHealth: [
        { connectorId: "github", state: "healthy" },
        { connectorId: "linear", state: "paused" },
      ],
    });
    expect(code).toBe(0);
    expect(out.stdout).toContain("Connector health:");
    expect(out.stdout).toContain("github");
  });

  it("returns 1 when any connector is in a warn/fail state", () => {
    const code = doctorPrintHealthFromSnapshot({
      connectorHealth: [{ connectorId: "github", state: "error" }],
    });
    expect(code).toBe(1);
    expect(out.stdout).toContain("[fail]");
  });
});

describe("runDoctor dispatcher (4 fixture permutations)", () => {
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    out.reset();
    origExitCode = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = origExitCode;
    clearFixture();
  });

  it("no gateway state -> prints not-running and exits 2", async () => {
    setFixture({});
    await runDoctor([]);
    expect(out.stdout).toContain("[fail] Gateway: not running");
    expect(process.exitCode).toBe(2);
  });

  it("stale pid -> prints stale-state and exits 2", async () => {
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock", pid: 999999 },
      processAlive: false,
    });
    await runDoctor([]);
    expect(out.stdout).toContain("[fail] Gateway: stale state");
    expect(process.exitCode).toBe(2);
  });

  it("live gateway + IPC ok -> prints gateway/config/index/health lines", async () => {
    const mock = createMockIpcClient([
      { uptime: 5000 },
      { ok: true, errors: [], warnings: [] },
      { index: { totalItems: 10 }, connectorHealth: [{ connectorId: "github", state: "healthy" }] },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock", pid: 1 },
      processAlive: true,
      ipcClient: mock.client,
    });
    await runDoctor([]);
    expect(out.stdout).toContain("[ok] Gateway: IPC OK");
    expect(out.stdout).toContain("[ok] Config: valid.");
    expect(out.stdout).toContain("[ok] Index: 10 items.");
    expect(out.stdout).toContain("github: healthy");
    // exitCode is not asserted here: the Linux secret-tool vault branch can
    // legitimately set it to 2 on CI, which is orthogonal to this path.
  });

  it("live gateway + IPC throws -> prints IPC-failed and exits 2", async () => {
    const mock = createMockIpcClient([new Error("connection refused")]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock", pid: 1 },
      processAlive: true,
      ipcClient: mock.client,
    });
    await runDoctor([]);
    expect(out.stdout).toContain("[fail] Gateway: IPC failed");
    expect(process.exitCode).toBe(2);
  });
});
