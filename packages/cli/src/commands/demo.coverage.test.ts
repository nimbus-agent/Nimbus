import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient, type MockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import type { CliPlatformPaths } from "../paths.ts";

// `demo.test.ts` drives `runDemo` through injected deps, and checks the DEFAULT deps only up to
// "no demo gateway is running". This file pins what each production dep actually SENDS once one
// is: the method, the params, and which calls get the batch budget — a typo in a method name, or a
// seed that silently fell back to the 30s default, would pass every DI test. The gateway is the
// shared `cli-mocks` fixture (fake state reader and IPC client), so nothing real is read.
const { defaultDemoDeps } = await import("./demo.ts");

const DEMO_PATHS: CliPlatformPaths = {
  configDir: join("demo-root", "config"),
  dataDir: join("demo-root", "data"),
  logDir: join("demo-root", "data", "logs"),
  socketPath: FAKE_SOCKET_PATH,
  extensionsDir: join("demo-root", "data", "extensions"),
  tempDir: join("demo-root", "tmp"),
  sandboxDir: join("demo-root", "sandbox"),
  demo: true,
};

function demoGatewayAnswering(responses: readonly unknown[]): {
  ipc: MockIpcClient;
  constructions: RecordedClientConstruction[];
} {
  const ipc = createMockIpcClient(responses);
  const constructions: RecordedClientConstruction[] = [];
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    clientConstructions: constructions,
    ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
  });
  return { ipc, constructions };
}

afterEach(() => {
  clearFixture();
});

describe("defaultDemoDeps — the IPC each production dep makes against a running demo gateway", () => {
  test("seed asks demo.seed with no params, on the batch budget, and returns the summary", async () => {
    const summary = { counts: { people: 5, items: 42 }, tour: [], t0: 1000 };
    const { ipc, constructions } = demoGatewayAnswering([summary]);
    await expect(defaultDemoDeps.seed(DEMO_PATHS)).resolves.toEqual(summary);
    expect(ipc.calls).toEqual([{ method: "demo.seed", params: {} }]);
    expect(constructions).toEqual([
      { socketPath: FAKE_SOCKET_PATH, opts: { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS } },
    ]);
  });

  test("firePage asks demo.firePage with no params, on the batch budget", async () => {
    const page = { incidentId: "pagerduty:PDEMO412", push: { selected: 1, ok: 1, failed: 0 } };
    const { ipc, constructions } = demoGatewayAnswering([page]);
    await expect(defaultDemoDeps.firePage(DEMO_PATHS)).resolves.toEqual(page);
    expect(ipc.calls).toEqual([{ method: "demo.firePage", params: {} }]);
    expect(constructions[0]?.opts).toEqual({ requestTimeoutMs: BATCH_RPC_TIMEOUT_MS });
  });

  test("locality asks locality.report on the tight default budget", async () => {
    const report = { listeners: [], inventory: [], db: { path: "x", bytes: 0 }, t1: 2000 };
    const { ipc, constructions } = demoGatewayAnswering([report]);
    await expect(defaultDemoDeps.locality(DEMO_PATHS)).resolves.toEqual(report);
    expect(ipc.calls).toEqual([{ method: "locality.report", params: {} }]);
    expect(constructions[0]?.opts).toBeUndefined();
  });

  test("prove asks egress.proveWindow for exactly the since/until edges it was given", async () => {
    const proof = {
      rows: [],
      completeness: { coverage: { task: "none" }, outboundEgressEvents: 0, indeterminate: false },
      verify: { ok: true, verifiedRows: 0 },
    };
    const { ipc, constructions } = demoGatewayAnswering([proof]);
    await expect(defaultDemoDeps.prove(DEMO_PATHS, 1000, 2500)).resolves.toEqual(proof);
    expect(ipc.calls).toEqual([
      { method: "egress.proveWindow", params: { since: 1000, until: 2500 } },
    ]);
    expect(constructions[0]?.opts).toBeUndefined();
  });
});
