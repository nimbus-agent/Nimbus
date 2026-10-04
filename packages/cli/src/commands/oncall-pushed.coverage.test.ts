import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient, type MockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { GatewayNotRunningError } from "../lib/with-gateway-ipc.ts";

// `oncall-pushed.test.ts` drives `runOncallPushedWith` with a hand-rolled client. This file covers
// the production wrapper around it — `runOncallPushed` — over the shared `cli-mocks` gateway (a fake
// state reader and IPC client, so no real gateway.json is ever read): the round trip, the exit-code
// mapping onto `CliExit`, and that the demo flag comes from the RESOLVED paths.
const { runOncallPushed } = await import("./oncall-pushed.ts");

const capture = createStreamCapture();

const OK_BRIEF = {
  incidentId: "pagerduty:A",
  status: "ok",
  title: "P1 A",
  createdAt: 1_700_000_000_000,
  briefMarkdown: "# On-call: P1 A\n\nNext: `nimbus oncall --incident pagerduty:A`",
  failureCode: null,
};

function gatewayAnswering(responses: readonly unknown[]): MockIpcClient {
  const ipc = createMockIpcClient(responses);
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
  });
  return ipc;
}

/** The env `getCliPlatformPaths()` reads to decide the demo root; saved and restored per test. */
const DEMO_KEYS = ["NIMBUS_DEMO", "NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"] as const;
let savedEnv: Map<string, string | undefined>;

beforeEach(() => {
  savedEnv = new Map(DEMO_KEYS.map((k) => [k, process.env[k]]));
  for (const k of DEMO_KEYS) delete process.env[k];
  capture.stdoutChunks.length = 0;
  capture.stderrChunks.length = 0;
  capture.install();
});

afterEach(() => {
  capture.restore();
  clearFixture();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Runs `runOncallPushed`, returning what it threw (or `undefined`) — never letting it escape. */
async function run(argv: string[]): Promise<unknown> {
  return runOncallPushed(argv).then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("runOncallPushed — the production wrapper", () => {
  test("`list` reads pushedList over the gateway, prints one line per brief, and resolves", async () => {
    const ipc = gatewayAnswering([{ enabled: true, identity: "resolved", briefs: [OK_BRIEF] }]);
    expect(await run(["list"])).toBeUndefined();
    expect(ipc.calls).toEqual([{ method: "oncall.pushedList", params: { limit: 50 } }]);
    expect(capture.stdoutChunks.join("")).toBe(
      `${new Date(OK_BRIEF.createdAt).toISOString()}  ok      pagerduty:A  P1 A\n`,
    );
    expect(capture.stderrChunks.join("")).toBe("");
  });

  test("a named id with no brief maps the inner exit 1 onto CliExit(1)", async () => {
    const ipc = gatewayAnswering([{ brief: null }]);
    const err = await run(["pagerduty:X"]);
    expect(err).toBeInstanceOf(CliExit);
    expect((err as CliExit).code).toBe(1);
    expect(ipc.calls).toEqual([
      { method: "oncall.pushedGet", params: { incidentId: "pagerduty:X" } },
    ]);
    expect(capture.stderrChunks.join("")).toBe("No pushed brief for pagerduty:X.\n");
  });

  test("outside the demo root the brief's commands print verbatim", async () => {
    gatewayAnswering([{ brief: OK_BRIEF }]);
    expect(await run([])).toBeUndefined();
    expect(capture.stdoutChunks.join("")).toBe(`${OK_BRIEF.briefMarkdown}\n`);
  });

  test("in the demo root the brief's commands are rewritten to target the demo gateway", async () => {
    // The flag is derived from the RESOLVED paths (`paths.demo`), never read from the env by the
    // renderer — so a copy-pasted command reaches the demo gateway, not the real install.
    process.env["NIMBUS_DEMO"] = "1";
    gatewayAnswering([{ brief: OK_BRIEF }]);
    expect(await run([])).toBeUndefined();
    expect(capture.stdoutChunks.join("")).toBe(
      "# On-call: P1 A\n\nNext: `nimbus --demo oncall --incident pagerduty:A`\n",
    );
  });

  test("with no gateway running the not-running error propagates and nothing is printed", async () => {
    setFixture({});
    expect(await run(["list"])).toBeInstanceOf(GatewayNotRunningError);
    expect(capture.stdoutChunks.join("")).toBe("");
  });
});
