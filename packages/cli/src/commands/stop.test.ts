import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

const mod = await import("./stop.ts");
const { decideStopAction, runStop } = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("decideStopAction", () => {
  it("returns no-state when state file is undefined", () => {
    expect(decideStopAction(undefined)).toEqual({
      action: "no-state",
      reason: "no gateway state recorded",
    });
  });

  it("returns signal+pid when state present", () => {
    expect(decideStopAction({ pid: 1234 })).toEqual({ action: "signal", pid: 1234 });
  });

  it("propagates the pid faithfully (including 0 as a valid number)", () => {
    expect(decideStopAction({ pid: 0 })).toEqual({ action: "signal", pid: 0 });
  });
});

describe("runStop dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("logs the absence message when no gateway state is recorded", async () => {
    setFixture({});
    await runStop([]);
    expect(out.stdout).toContain("No gateway state found");
  });

  it("attempts to signal the recorded pid when state is present", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 2_147_483_640 } });
    await runStop([]);
    expect(out.stdout).not.toContain("No gateway state found");
  });
});
