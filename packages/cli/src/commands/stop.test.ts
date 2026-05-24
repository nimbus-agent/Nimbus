// packages/cli/src/commands/stop.test.ts
//
// Unit tests for `nimbus stop` decision logic. The dispatcher itself reads
// the gateway state file via the harness mock and signals the recorded pid;
// we test the parse + state-file decision layer here. Tests do NOT actually
// SIGTERM real processes — the harness's `process.kill` calls hit a pid we
// recorded ourselves below or a pid known to be alive (the test process),
// and the dispatcher swallows the resulting error.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
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
    // Use a pid that definitely does not exist so process.kill throws inside
    // the swallow-it try/catch — we are exercising the branch, not the kill.
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock", pid: 2_147_483_640 } });
    await runStop([]);
    // The dispatcher prints nothing to console.log on the signal path —
    // @clack/prompts spinner is mocked to a no-op in the harness — so the
    // assertion is that no "No gateway state" appeared.
    expect(out.stdout).not.toContain("No gateway state found");
  });
});
