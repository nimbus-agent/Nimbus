import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

const mod = await import("./start.ts");
const { decideStartAction, runStart, wantsNoWizard } = mod;

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
