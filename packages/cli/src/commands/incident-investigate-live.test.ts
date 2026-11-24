import { afterAll, afterEach, describe, expect, test } from "bun:test";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";

import { type IncidentIpc, runIncidentCommand, runIncidentWith } from "./incident.ts";
import { parseIncidentArgs } from "./incident-format.ts";

const REC = "inc_0123456789abcdef";

function harness(replies: Record<string, unknown>) {
  const out: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const ipc = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return method === "session.declareKind" ? {} : replies[method];
    },
  } as unknown as IncidentIpc;
  return {
    out,
    calls,
    ipc,
    sink: { out: (s: string) => out.push(s), err: () => {} },
  };
}

describe("nimbus incident investigate --live", () => {
  test("parses --live and its budget once each, and the budget only with --live", () => {
    expect(parseIncidentArgs(["investigate", REC, "--live"])).toEqual({
      verb: "investigate",
      json: false,
      id: REC,
      live: true,
    });
    expect(
      parseIncidentArgs(["investigate", "--live-budget", "20", REC, "--live", "--synthesize"]),
    ).toEqual({
      verb: "investigate",
      json: false,
      id: REC,
      live: true,
      liveBudget: 20,
      synthesize: true,
    });
    expect(parseIncidentArgs(["investigate", REC, "--live-budget", "20"])).toBeUndefined();
    expect(parseIncidentArgs(["investigate", REC, "--live", "--live"])).toBeUndefined();
    for (const bad of ["0", "61", "x", "5.5", "-1", "100"]) {
      expect(
        parseIncidentArgs(["investigate", REC, "--live", "--live-budget", bad]),
      ).toBeUndefined();
    }
    expect(parseIncidentArgs(["investigate", REC, "--live", "--live-budget"])).toBeUndefined();
    // Only investigate takes it.
    expect(parseIncidentArgs(["show", REC, "--live"])).toBeUndefined();
    expect(parseIncidentArgs(["timeline", REC, "--live"])).toBeUndefined();
  });

  test("--live calls incident.investigateLive, and nothing else reads live", async () => {
    const h = harness({
      "incident.investigateLive": { investigation: {}, markdown: "# Investigation: x\n" },
    });
    await runIncidentWith(
      h.ipc,
      { verb: "investigate", json: false, id: REC, live: true, liveBudget: 12 },
      h.sink,
      0,
    );
    expect(h.calls.map((c) => c.method)).toEqual([
      "session.declareKind",
      "incident.investigateLive",
    ]);
    expect(h.calls[1]?.params).toEqual({ id: REC, budgetSeconds: 12 });
    expect(h.out.join("")).toContain("# Investigation: x");
  });

  test("without --live the index-only method is called with no live parameter", async () => {
    const h = harness({
      "incident.investigate": { investigation: {}, markdown: "# Investigation: x\n" },
    });
    await runIncidentWith(h.ipc, { verb: "investigate", json: false, id: REC }, h.sink, 0);
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.investigate"]);
    expect(h.calls[1]?.params).toEqual({ id: REC });
  });

  test("--live --synthesize asks the synthesize method with live: true, once", async () => {
    const h = harness({
      "incident.investigateSynthesize": {
        markdown: "# Investigation: x\n",
        synthesis: { attempted: false, reason: "disabled" },
      },
    });
    await runIncidentWith(
      h.ipc,
      { verb: "investigate", json: false, id: REC, live: true, synthesize: true },
      h.sink,
      0,
    );
    expect(h.calls.map((c) => c.method)).toEqual([
      "session.declareKind",
      "incident.investigateSynthesize",
    ]);
    expect(h.calls[1]?.params).toEqual({ id: REC, live: true });
  });

  test("--json prints the reply as is", async () => {
    const reply = { investigation: { live: { status: "ok" } }, markdown: "m" };
    const h = harness({ "incident.investigateLive": reply });
    await runIncidentWith(
      h.ipc,
      { verb: "investigate", json: true, id: REC, live: true },
      h.sink,
      0,
    );
    expect(JSON.parse(h.out.join(""))).toEqual(reply);
  });
});

describe("runIncidentCommand request budget for --live", () => {
  const capture = createStreamCapture();
  afterAll(() => capture.restore());
  afterEach(() => {
    clearFixture();
    capture.restore();
    process.exitCode = 0;
  });

  test("a live read takes the long budget", async () => {
    const constructions: RecordedClientConstruction[] = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: constructions,
      ipcClient: {
        call: async () => ({}),
        connect: async () => {},
        disconnect: async () => {},
        onNotification: () => {},
      },
    });
    capture.install();
    await runIncidentCommand(["investigate", REC, "--live"]).catch(() => undefined);
    expect(constructions[0]?.opts?.requestTimeoutMs).toBe(BATCH_RPC_TIMEOUT_MS);
  });
});
