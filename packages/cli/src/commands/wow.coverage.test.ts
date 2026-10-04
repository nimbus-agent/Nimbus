import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient, type MockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { defaultTourRunners } from "../lib/run-tour.ts";
import { GatewayNotRunningError } from "../lib/with-gateway-ipc.ts";
import type { ProveResult } from "./prove.ts";

// `wow.test.ts` drives `runWow` through injected deps only. This file pins the PRODUCTION wiring
// those tests replace: which IPC method each default dep calls, with which params — a typo there
// would ship a `nimbus wow` that every DI test still passes. The gateway is the shared `cli-mocks`
// fixture: its state reader and IPC client are fakes, so nothing here reads a real gateway.json.
const { defaultWowDeps, runWow } = await import("./wow.ts");

const capture = createStreamCapture();

function gatewayAnswering(responses: readonly unknown[]): MockIpcClient {
  const ipc = createMockIpcClient(responses);
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
  });
  return ipc;
}

beforeEach(() => {
  capture.stdoutChunks.length = 0;
  capture.stderrChunks.length = 0;
});

afterEach(() => {
  capture.restore();
  clearFixture();
});

describe("defaultWowDeps — the IPC each production dep makes", () => {
  test("plan asks tour.plan for exactly the requested step count", async () => {
    const plan = { steps: [], more: [], skipped: [], t0: 17 };
    const ipc = gatewayAnswering([plan]);
    await expect(defaultWowDeps.plan(4)).resolves.toEqual(plan);
    expect(ipc.calls).toEqual([{ method: "tour.plan", params: { steps: 4 } }]);
  });

  test("locality asks locality.report with no params", async () => {
    const report = { listeners: [], inventory: [], db: { path: "x", bytes: 0 }, t1: 99 };
    const ipc = gatewayAnswering([report]);
    await expect(defaultWowDeps.locality()).resolves.toEqual(report);
    expect(ipc.calls).toEqual([{ method: "locality.report", params: {} }]);
  });

  test("prove asks egress.proveWindow for the exact since/until edges it was given", async () => {
    const proof: ProveResult = {
      rows: [],
      completeness: {
        coverage: { task: "per-call" },
        outboundEgressEvents: 0,
        indeterminate: false,
      },
      verify: { ok: true, verifiedRows: 0 },
    };
    const ipc = gatewayAnswering([proof]);
    await expect(defaultWowDeps.prove(1_000, 2_500)).resolves.toEqual(proof);
    expect(ipc.calls).toEqual([
      { method: "egress.proveWindow", params: { since: 1_000, until: 2_500 } },
    ]);
  });

  test("with no gateway running, plan rejects with the not-running error rather than a call", async () => {
    setFixture({});
    await expect(defaultWowDeps.plan(3)).rejects.toBeInstanceOf(GatewayNotRunningError);
  });

  test("runners IS the shared tour runner table (the same one `nimbus demo` uses)", () => {
    expect(defaultWowDeps.runners).toBe(defaultTourRunners);
  });

  test("out writes to stdout and err to stderr, verbatim", () => {
    capture.install();
    defaultWowDeps.out("to stdout\n");
    defaultWowDeps.err("to stderr\n");
    capture.restore();
    expect(capture.stdoutChunks.join("")).toBe("to stdout\n");
    expect(capture.stderrChunks.join("")).toBe("to stderr\n");
  });
});

describe("runWow with its DEFAULT deps", () => {
  test("--help prints the usage on stdout and makes no IPC call", async () => {
    const ipc = gatewayAnswering([]);
    capture.install();
    await runWow(["--help"]);
    capture.restore();
    expect(capture.stdoutChunks.join("")).toBe(
      "Usage: nimbus wow [--steps 1..6] [--no-proof] [--json]\n",
    );
    expect(capture.stderrChunks.join("")).toBe("");
    expect(ipc.calls).toHaveLength(0);
  });

  test("an out-of-range --steps refuses on stderr with CliExit(2) before any IPC", async () => {
    const ipc = gatewayAnswering([]);
    capture.install();
    const err = await runWow(["--steps", "9"]).then(
      () => undefined,
      (e: unknown) => e,
    );
    capture.restore();
    expect(err).toBeInstanceOf(CliExit);
    expect((err as CliExit).code).toBe(2);
    expect(capture.stderrChunks.join("")).toBe(
      "--steps must be an integer in 1..6, got 9\nUsage: nimbus wow [--steps 1..6] [--no-proof] [--json]\n",
    );
    expect(capture.stdoutChunks.join("")).toBe("");
    expect(ipc.calls).toHaveLength(0);
  });

  test("an empty plan from the gateway prints the init pointer on stdout and asks nothing else", async () => {
    const ipc = gatewayAnswering([{ steps: [], more: [], skipped: [], t0: 0 }]);
    capture.install();
    await runWow(["--steps", "2"]);
    capture.restore();
    expect(ipc.calls).toEqual([{ method: "tour.plan", params: { steps: 2 } }]);
    expect(capture.stdoutChunks.join("")).toBe(
      "Nothing indexed yet — run `nimbus init` in a repo.\n",
    );
  });
});
