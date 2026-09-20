import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./start.ts");
const {
  decideStartAction,
  printDemoSeedHintIfUnseeded,
  printOnboardingHintIfNoConnectors,
  runStart,
  wantsNoWizard,
} = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("wantsNoWizard", () => {
  it("returns true when --no-wizard is present", () => {
    expect(wantsNoWizard(["--no-wizard"])).toBe(true);
  });
  it("returns true when --no-wizard is one of many args", () => {
    expect(wantsNoWizard(["a", "--no-wizard", "b"])).toBe(true);
  });
  it("returns false when absent", () => {
    expect(wantsNoWizard([])).toBe(false);
  });
  it("returns false on similar but different flags", () => {
    expect(wantsNoWizard(["--no-wiz"])).toBe(false);
  });
});

describe("decideStartAction", () => {
  it("returns start-fresh when no existing state", () => {
    expect(decideStartAction(undefined, false, false)).toEqual({
      action: "start-fresh",
      reason: "no existing state",
    });
  });

  it("returns reuse when state present, pid alive, and reachable", () => {
    expect(decideStartAction({ pid: 4242, socketPath: FAKE_SOCKET_PATH }, true, true)).toEqual({
      action: "reuse",
      pid: 4242,
      reason: "gateway already running",
    });
  });

  it("returns abort-stale-clear when pid alive but socket unreachable", () => {
    expect(decideStartAction({ pid: 7777, socketPath: FAKE_SOCKET_PATH }, true, false)).toEqual({
      action: "abort-stale-clear",
      pid: 7777,
      reason: "stale state, will clear and restart",
    });
  });

  it("returns abort-stale-clear when state present but pid dead", () => {
    expect(decideStartAction({ pid: 8888, socketPath: FAKE_SOCKET_PATH }, false, false)).toEqual({
      action: "abort-stale-clear",
      pid: 8888,
      reason: "stale state, will clear and restart",
    });
  });
});

describe("printOnboardingHintIfNoConnectors", () => {
  let dir: string;

  beforeEach(() => {
    out.reset();
    dir = mkdtempSync(join(tmpdir(), "nimbus-start-onboarding-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("non-demo: prints the real-install connect-a-service steps", async () => {
    const { client } = createMockIpcClient([[]]);
    await printOnboardingHintIfNoConnectors(client, join(dir, "marker"));
    expect(out.stdout).toContain("nimbus connector auth github");
    expect(out.stdout).toContain("nimbus connector sync github");
    expect(out.stdout).toContain("nimbus connector detect");
    expect(out.stdout.indexOf("nimbus connector detect")).toBeLessThan(
      out.stdout.indexOf("nimbus connector auth github"),
    );
    expect(out.stdout).toContain("nimbus doctor");
    expect(out.stdout).not.toContain("nimbus demo");
  });

  it("prints nothing when connectors are already registered", async () => {
    const { client } = createMockIpcClient([[{ serviceId: "github" }]]);
    await printOnboardingHintIfNoConnectors(client, join(dir, "marker"));
    expect(out.stdout).toBe("");
  });
});

describe("printDemoSeedHintIfUnseeded", () => {
  // Keyed on the demo SEED marker, not connectors: a seeded demo index still has zero connector
  // rows (the seeder writes items directly), and `nimbus demo` starts with `--no-wizard`, so the
  // onboarding marker is never written either — keyed on those, a seeded demo was told to seed.
  let dir: string;

  beforeEach(() => {
    out.reset();
    dir = mkdtempSync(join(tmpdir(), "nimbus-start-demo-seed-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("unseeded demo root: prints only the seed hint — connector auth/sync are refused in the demo", () => {
    printDemoSeedHintIfUnseeded(dir);
    expect(out.stdout).toContain("Seed the synthetic org with: nimbus demo");
    expect(out.stdout).not.toContain("nimbus connector auth");
    expect(out.stdout).not.toContain("nimbus connector sync");
  });

  it("seeded demo root (demo-seed.json present): prints nothing", () => {
    writeFileSync(
      join(dir, "demo-seed.json"),
      JSON.stringify({ corpus: "acme", version: 1, seededAtMs: Date.now() }),
      "utf8",
    );
    printDemoSeedHintIfUnseeded(dir);
    expect(out.stdout).toBe("");
  });
});

describe("runStart dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("returns early with 'already running' when state is live and socket reachable", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 1234 },
      processAlive: true,
    });
    await runStart([]);
    expect(out.stdout).toContain("Gateway already running");
    expect(out.stdout).toContain("1234");
  });
});

describe("waitForGatewayReady", () => {
  // The gateway binds its socket BEFORE it writes gateway.json (gateway-main.ts). Every other
  // command reads that file first and reports "Gateway is not running" when it is absent, so a
  // start that returns on a reachable socket alone lets `nimbus start && nimbus <cmd>` fail.
  function deps(over: Partial<Parameters<typeof mod.waitForGatewayReady>[4]> = {}) {
    let t = 0;
    return {
      isAlive: () => true,
      probe: async () => true,
      statePid: async (): Promise<number | undefined> => 42,
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
      ...over,
    };
  }

  it("is not ready while the socket answers but the state file is still absent", async () => {
    let reads = 0;
    const ready = await mod.waitForGatewayReady(
      "sock",
      42,
      10_000,
      undefined,
      deps({
        statePid: async () => {
          reads += 1;
          return reads < 3 ? undefined : 42;
        },
      }),
    );
    expect(ready).toBe(true);
    expect(reads).toBe(3);
  });

  it("is not ready on a state file left by a DIFFERENT gateway process", async () => {
    const ready = await mod.waitForGatewayReady(
      "sock",
      42,
      1_000,
      undefined,
      deps({
        statePid: async () => 7,
      }),
    );
    expect(ready).toBe(false);
  });

  it("is not ready while the state file is written but the socket does not answer", async () => {
    const ready = await mod.waitForGatewayReady(
      "sock",
      42,
      1_000,
      undefined,
      deps({
        probe: async () => false,
      }),
    );
    expect(ready).toBe(false);
  });

  it("gives up at once when the spawned process has died", async () => {
    let probes = 0;
    const ready = await mod.waitForGatewayReady(
      "sock",
      42,
      10_000,
      undefined,
      deps({
        isAlive: () => false,
        probe: async () => {
          probes += 1;
          return true;
        },
      }),
    );
    expect(ready).toBe(false);
    expect(probes).toBe(0);
  });
});
