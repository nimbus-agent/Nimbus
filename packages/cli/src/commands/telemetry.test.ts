import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
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
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runTelemetry(["show"]);
    expect(ipc.calls[0]).toEqual({ method: "telemetry.preview", params: {} });
    expect(out.stdout).toContain('"enabled": false');
  });
});
