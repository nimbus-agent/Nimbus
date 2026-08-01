import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const telemetryMod = await import("./telemetry.ts");
const { runTelemetry, runTelemetryDisable, runTelemetryShow } = telemetryMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runTelemetryShow", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls telemetry.preview and pretty-prints the result", async () => {
    const ipc = createMockIpcClient([{ enabled: true, counters: { items: 7 } }]);
    await runTelemetryShow(ipc.client);
    expect(ipc.calls[0]).toEqual({ method: "telemetry.preview", params: {} });
    expect(out.stdout).toContain('"enabled": true');
    expect(out.stdout).toContain('"items": 7');
  });

  it("propagates IPC errors", async () => {
    const { client } = createMockIpcClient([new Error("preview failed")]);
    await expect(runTelemetryShow(client)).rejects.toThrow("preview failed");
  });
});

describe("runTelemetryDisable", () => {
  let tmp: string;
  const writeCalls: { p: string; d: string }[] = [];

  beforeEach(() => {
    out.reset();
    writeCalls.length = 0;
    tmp = mkdtempSync(join(tmpdir(), "nimbus-cli-telemetry-"));
  });
  afterEach(() => {
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort tmp cleanup
    }
  });

  it("writes the disable marker into the data directory with a unix-ms timestamp", async () => {
    const writeFile = async (p: string, d: string): Promise<unknown> => {
      writeCalls.push({ p, d });
      return Bun.write(p, d);
    };
    const fixedNow = (): number => 1_700_000_000_123;
    await runTelemetryDisable(tmp, writeFile, fixedNow);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.p).toBe(join(tmp, ".nimbus-telemetry-disabled"));
    expect(writeCalls[0]?.d).toBe("1700000000123\n");
    const onDisk = readFileSync(join(tmp, ".nimbus-telemetry-disabled"), "utf8");
    expect(onDisk).toBe("1700000000123\n");
    expect(out.stdout).toContain("Telemetry disabled");
  });

  it("creates the data directory if missing", async () => {
    const nested = join(tmp, "newdir");
    await runTelemetryDisable(nested);
    const onDisk = readFileSync(join(nested, ".nimbus-telemetry-disabled"), "utf8");
    expect(onDisk).toMatch(/\d+\n/);
  });
});

describe("runTelemetry (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help when no subcommand is given", async () => {
    await runTelemetry([]);
    expect(out.stdout).toContain("nimbus telemetry");
    expect(out.stdout).toContain("Usage:");
  });

  it("prints help on 'help'/'--help'/'-h'", async () => {
    await runTelemetry(["help"]);
    expect(out.stdout).toContain("nimbus telemetry");
    out.reset();
    await runTelemetry(["--help"]);
    expect(out.stdout).toContain("nimbus telemetry");
    out.reset();
    await runTelemetry(["-h"]);
    expect(out.stdout).toContain("nimbus telemetry");
  });

  it("rejects unknown subcommands", async () => {
    await expect(runTelemetry(["bogus"])).rejects.toThrow("Unknown telemetry subcommand: bogus");
  });

  it("throws when gateway is not running for 'show'", async () => {
    setFixture({});
    await expect(runTelemetry(["show"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("routes 'show' through withIpc and emits the preview", async () => {
    const ipc = createMockIpcClient([{ enabled: false }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runTelemetry(["show"]);
    expect(ipc.calls[0]).toEqual({ method: "telemetry.preview", params: {} });
    expect(out.stdout).toContain('"enabled": false');
  });
});

// `runTelemetry(["disable"])` is the privacy-relevant arm: it must resolve the real
// platform data directory and write the opt-out marker WITHOUT a Gateway. The paths
// resolver is stubbed the way `paths.test.ts` does it — pin `process.platform` and
// point the platform's data-dir env var at a real temp root — so the assertion can be
// on the marker that actually lands on disk, not merely on the call returning.
describe("runTelemetry disable — dispatch writes the opt-out marker", () => {
  const MARKER = ".nimbus-telemetry-disabled";
  let tmp: string;
  let dataDir: string;
  let origPlatform: PropertyDescriptor | undefined;
  // XDG_CONFIG_HOME is pinned to a SIBLING of the data root (and NIMBUS_CONFIG_DIR
  // cleared) so configDir !== dataDir: a dispatcher that wrote the marker under the
  // config dir instead must fail this test rather than land on the same path.
  const ENV_KEYS = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "NIMBUS_CONFIG_DIR"] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    out.reset();
    // No fixture: readGatewayState() returns undefined, so ANY route through
    // withGatewayIpc would reject with "Gateway is not running".
    clearFixture();
    tmp = mkdtempSync(join(tmpdir(), "nimbus-cli-telemetry-dispatch-"));
    dataDir = join(tmp, "nimbus");
    origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env["XDG_DATA_HOME"] = tmp;
    process.env["XDG_CONFIG_HOME"] = join(tmp, "cfg");
    delete process.env["NIMBUS_CONFIG_DIR"];
  });

  afterEach(() => {
    if (origPlatform) {
      Object.defineProperty(process, "platform", origPlatform);
      origPlatform = undefined;
    }
    for (const k of ENV_KEYS) {
      const orig = savedEnv[k];
      if (orig === undefined) delete process.env[k];
      else process.env[k] = orig;
    }
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort tmp cleanup
    }
  });

  it("writes the marker into the resolved platform data dir, with no Gateway running", async () => {
    const before = Date.now();
    await runTelemetry(["disable"]);
    const after = Date.now();

    // The marker landed under getCliPlatformPaths().dataDir — proving the arm
    // resolved the real paths and delegated to runTelemetryDisable(dataDir).
    const onDisk = readFileSync(join(dataDir, MARKER), "utf8");
    expect(onDisk).toMatch(/^\d+\n$/);
    const stamp = Number.parseInt(onDisk, 10);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
    expect(out.stdout).toContain("Telemetry disabled");
  });

  it("writes no marker for a non-disable subcommand", async () => {
    await runTelemetry(["help"]);
    expect(existsSync(join(dataDir, MARKER))).toBe(false);
    expect(out.stdout).not.toContain("Telemetry disabled");
  });
});
