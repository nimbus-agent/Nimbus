import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type InvokeArgs = { method: string; params: unknown };

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(cmd: string, args?: InvokeArgs) => Promise<unknown>>(),
  listenMock:
    vi.fn<(event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import {
  __resetIpcClientForTests,
  createIpcClient,
  isSensitiveKeyName,
  type NimbusIpcClient,
  redactSensitiveSubstrings,
} from "../../src/ipc/client";
import { JsonRpcError, MethodNotAllowedError } from "../../src/ipc/types";

beforeEach(() => {
  __resetIpcClientForTests();
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => {});
});

afterEach(() => {
  __resetIpcClientForTests();
});

describe("isSensitiveKeyName", () => {
  it.each([
    "apiToken",
    "API_KEY",
    "clientSecret",
    "app_password",
    "credentials",
    "bearer",
    "Authorization",
  ])("flags %s as sensitive", (name) => {
    expect(isSensitiveKeyName(name)).toBe(true);
  });

  it.each(["service", "intervalMs", "depth", "name", ""])(
    "does not flag %s as sensitive",
    (name) => {
      expect(isSensitiveKeyName(name)).toBe(false);
    },
  );
});

describe("createIpcClient — singleton", () => {
  it("returns the same instance until the test reset hook clears it", () => {
    const first = createIpcClient();
    expect(createIpcClient()).toBe(first);
    __resetIpcClientForTests();
    expect(createIpcClient()).not.toBe(first);
  });
});

describe("parseError — residual branches", () => {
  it("names the method 'unknown' when the not-allowed error carries no method suffix", async () => {
    invokeMock.mockRejectedValueOnce("ERR_METHOD_NOT_ALLOWED");
    const err = await createIpcClient()
      .call("vault.get")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MethodNotAllowedError);
    expect((err as MethodNotAllowedError).method).toBe("unknown");
  });

  it("keeps the method name from a suffixed not-allowed error", async () => {
    invokeMock.mockRejectedValueOnce("ERR_METHOD_NOT_ALLOWED:vault.get");
    const err = await createIpcClient()
      .call("vault.get")
      .catch((e: unknown) => e);
    expect((err as MethodNotAllowedError).method).toBe("vault.get");
  });

  it("carries the JSON-RPC payload code through to JsonRpcError", async () => {
    invokeMock.mockRejectedValueOnce(JSON.stringify({ code: -32602, message: "bad params" }));
    const err = await createIpcClient()
      .call("audit.list")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect((err as JsonRpcError).payload.code).toBe(-32602);
    expect((err as JsonRpcError).message).toBe("bad params");
  });

  it("does not treat a JSON payload with a non-numeric code as a JSON-RPC error", async () => {
    invokeMock.mockRejectedValueOnce(JSON.stringify({ code: "E1", message: "x" }));
    const err = await createIpcClient()
      .call("audit.list")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(JsonRpcError);
    expect((err as Error).message).toBe('{"code":"E1","message":"x"}');
  });

  it("does not treat a JSON payload without a string message as a JSON-RPC error", async () => {
    invokeMock.mockRejectedValueOnce(JSON.stringify({ code: -32000 }));
    const err = await createIpcClient()
      .call("audit.list")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(JsonRpcError);
    expect((err as Error).message).toBe('{"code":-32000}');
  });

  it("serialises a rejection that is neither a string nor an Error into the message", async () => {
    invokeMock.mockRejectedValueOnce({ code: 42 });
    const err = await createIpcClient()
      .call("audit.list")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(JsonRpcError);
    expect((err as Error).message).toBe('{"code":42}');
  });
});

describe("redactSensitiveSubstrings", () => {
  it.each([
    [
      "a generic key=value pair",
      "auth failed: api_key=x retry",
      "auth failed: api_key=[REDACTED] retry",
    ],
    [
      'a generic key: "value" pair with spacing',
      'login error: password : "hunter2" (attempt 2)',
      "login error: password=[REDACTED] (attempt 2)",
    ],
    [
      "every occurrence of a forbidden key, in any case",
      "Passphrase=one then PASSPHRASE: two",
      "passphrase=[REDACTED] then passphrase=[REDACTED]",
    ],
    [
      "a JSON-quoted forbidden key whose value has spaces",
      '{"recoverySeed":"one two three"}',
      '{"recoverySeed":"[REDACTED]"}',
    ],
    [
      "every JSON-quoted occurrence of a forbidden key, in any case",
      '{"Mnemonic":"a b","mnemonic":"c d"}',
      '{"mnemonic":"[REDACTED]","mnemonic":"[REDACTED]"}',
    ],
    [
      "a JSON-quoted generic key with spacing around the colon",
      '{"apiToken" : "ghp_abc"}',
      '{"apiToken":"[REDACTED]"}',
    ],
  ])("redacts %s", (_label, input, expected) => {
    expect(redactSensitiveSubstrings(input)).toBe(expected);
  });

  it("leaves a message without sensitive keys untouched", () => {
    const plain = "connector github: sync failed after 3 attempts (code=E_TIMEOUT)";
    expect(redactSensitiveSubstrings(plain)).toBe(plain);
  });
});

describe("subscribe", () => {
  it("listens on gateway://notification and forwards the bare payload", async () => {
    let registered: ((e: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementationOnce(async (_event, handler) => {
      registered = handler;
      return unlisten;
    });
    const handler = vi.fn();

    const stop = await createIpcClient().subscribe(handler);

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0]?.[0]).toBe("gateway://notification");
    const notification = { method: "audit.entryAppended", params: { id: 7 } };
    registered?.({ payload: notification });
    expect(handler).toHaveBeenCalledWith(notification);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("onConnectionState", () => {
  it("listens on gateway://connection-state and forwards the bare payload", async () => {
    let registered: ((e: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementationOnce(async (_event, handler) => {
      registered = handler;
      return unlisten;
    });
    const handler = vi.fn();

    const stop = await createIpcClient().onConnectionState(handler);

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0]?.[0]).toBe("gateway://connection-state");
    registered?.({ payload: "connected" });
    expect(handler).toHaveBeenCalledWith("connected");
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("connectorListStatus", () => {
  it("calls connector.listStatus and returns the array verbatim", async () => {
    const rows = [{ name: "github", health: "healthy" }];
    invokeMock.mockResolvedValueOnce(rows);
    const res = await createIpcClient().connectorListStatus();
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", {
      method: "connector.listStatus",
      params: {},
    });
    expect(res).toEqual(rows);
  });

  it("rejects a non-array response", async () => {
    invokeMock.mockResolvedValueOnce({ connectors: [] });
    await expect(createIpcClient().connectorListStatus()).rejects.toThrow(
      "connector.listStatus: expected array",
    );
  });
});

describe("indexMetrics", () => {
  it("calls index.metrics and returns the object verbatim", async () => {
    const metrics = { itemsTotal: 7, embeddingCoveragePct: 50, queryP95Ms: 3, indexSizeBytes: 9 };
    invokeMock.mockResolvedValueOnce(metrics);
    const res = await createIpcClient().indexMetrics();
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", { method: "index.metrics", params: {} });
    expect(res).toEqual(metrics);
  });

  it.each([
    ["a string", "oops"],
    ["null", null],
  ])("rejects %s", async (_label, value) => {
    invokeMock.mockResolvedValueOnce(value);
    await expect(createIpcClient().indexMetrics()).rejects.toThrow(
      "index.metrics: expected object",
    );
  });
});

describe("auditList", () => {
  it("defaults the limit to 25 and returns the array", async () => {
    const rows = [{ id: 1 }];
    invokeMock.mockResolvedValueOnce(rows);
    const res = await createIpcClient().auditList();
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", {
      method: "audit.list",
      params: { limit: 25 },
    });
    expect(res).toEqual(rows);
  });

  it("forwards an explicit limit", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await createIpcClient().auditList(500);
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", {
      method: "audit.list",
      params: { limit: 500 },
    });
  });
});

describe("consentRespond", () => {
  it("responds over RPC first, then tells the bridge the request is resolved", async () => {
    invokeMock.mockResolvedValue(undefined);
    await createIpcClient().consentRespond("req-1", true);
    expect(invokeMock.mock.calls).toEqual([
      ["rpc_call", { method: "consent.respond", params: { requestId: "req-1", approved: true } }],
      ["hitl_resolved", { requestId: "req-1", approved: true }],
    ]);
  });

  it("does not signal hitl_resolved when the RPC response fails", async () => {
    invokeMock.mockRejectedValueOnce("ERR_GATEWAY_OFFLINE");
    await expect(createIpcClient().consentRespond("req-2", false)).rejects.toThrow(
      "Gateway is not connected",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe("rpc_call");
  });
});

describe("connectorSetConfig — partial patches", () => {
  it.each([
    ["intervalMs", { intervalMs: 5000 }],
    ["depth", { depth: "full" as const }],
  ])("sends only %s when that is the only field set", async (_field, patch) => {
    invokeMock.mockResolvedValueOnce({
      service: "jira",
      intervalMs: null,
      depth: null,
      enabled: null,
    });
    await createIpcClient().connectorSetConfig("jira", patch);
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", {
      method: "connector.setConfig",
      params: { service: "jira", ...patch },
    });
    const sent = invokeMock.mock.calls[0]?.[1]?.params as Record<string, unknown>;
    expect(Object.keys(sent).sort((a, b) => a.localeCompare(b))).toEqual(
      ["service", ...Object.keys(patch)].sort((a, b) => a.localeCompare(b)),
    );
  });
});

// Every object-returning wrapper guards with `typeof res !== "object" || res === null`.
// Both arms are exercised: a string trips the first operand, `null` the second.
type ObjectWrapperCase = readonly [string, (c: NimbusIpcClient) => Promise<unknown>, string];
const OBJECT_WRAPPERS: readonly ObjectWrapperCase[] = [
  ["profile.list", (c) => c.profileList(), "profile.list: expected object"],
  ["telemetry.getStatus", (c) => c.telemetryGetStatus(), "telemetry.getStatus: expected object"],
  ["llm.listModels", (c) => c.llmListModels(), "llm.listModels: expected object"],
  ["llm.getStatus", (c) => c.llmGetStatus(), "llm.getStatus: expected object"],
  ["llm.getRouterStatus", (c) => c.llmGetRouterStatus(), "llm.getRouterStatus: expected object"],
  ["audit.getSummary", (c) => c.auditGetSummary(), "audit.getSummary: expected object"],
  ["audit.verify", (c) => c.auditVerify(), "audit.verify: expected object"],
  ["updater.getStatus", (c) => c.updaterGetStatus(), "updater.getStatus: expected object"],
  ["updater.checkNow", (c) => c.updaterCheckNow(), "updater.checkNow: expected object"],
  ["updater.applyUpdate", (c) => c.updaterApplyUpdate(), "updater.applyUpdate: expected object"],
  ["updater.rollback", (c) => c.updaterRollback(), "updater.rollback: expected object"],
  ["diag.getVersion", (c) => c.diagGetVersion(), "diag.getVersion: expected object"],
  ["watcher.list", (c) => c.watcherList(), "watcher.list: expected object"],
  [
    "watcher.listCandidateRelations",
    (c) => c.watcherListCandidateRelations(),
    "watcher.listCandidateRelations: expected object",
  ],
  [
    "watcher.validateCondition",
    (c) => c.watcherValidateCondition("{}", 0),
    "watcher.validateCondition: expected object",
  ],
  ["extension.list", (c) => c.extensionList(), "extension.list: expected object"],
  ["workflow.list", (c) => c.workflowList(), "workflow.list: expected object"],
];

describe("object-returning wrappers reject non-object responses", () => {
  for (const [method, run, message] of OBJECT_WRAPPERS) {
    it(`${method} rejects a string response`, async () => {
      invokeMock.mockResolvedValueOnce("not-an-object");
      await expect(run(createIpcClient())).rejects.toThrow(message);
      expect(invokeMock.mock.calls[0]?.[1]?.method).toBe(method);
    });

    it(`${method} rejects a null response`, async () => {
      invokeMock.mockResolvedValueOnce(null);
      await expect(run(createIpcClient())).rejects.toThrow(message);
    });

    it(`${method} passes an object response through unchanged`, async () => {
      const payload = { marker: method };
      invokeMock.mockResolvedValueOnce(payload);
      await expect(run(createIpcClient())).resolves.toBe(payload);
    });
  }
});

describe("watcher.listCandidateRelations", () => {
  it("calls the method with empty params and returns the object", async () => {
    const fixture = { relations: [{ relation: "owns", label: "owns" }] };
    invokeMock.mockResolvedValueOnce(fixture);
    const res = await createIpcClient().watcherListCandidateRelations();
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", {
      method: "watcher.listCandidateRelations",
      params: {},
    });
    expect(res).toEqual(fixture);
  });
});

describe("watcher.validateCondition", () => {
  it("forwards the predicate JSON and window start", async () => {
    invokeMock.mockResolvedValueOnce({ matchCount: 4 });
    const res = await createIpcClient().watcherValidateCondition('{"relation":"owns"}', 1234);
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", {
      method: "watcher.validateCondition",
      params: { graphPredicateJson: '{"relation":"owns"}', sinceMs: 1234 },
    });
    expect(res).toEqual({ matchCount: 4 });
  });
});

describe("watcher.listHistory", () => {
  it("forwards watcherId + limit and returns the events envelope", async () => {
    const fixture = { events: [{ firedAt: 1, conditionSnapshot: "{}", actionOutcome: "ok" }] };
    invokeMock.mockResolvedValueOnce(fixture);
    const res = await createIpcClient().watcherListHistory("w-9", 20);
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", {
      method: "watcher.listHistory",
      params: { watcherId: "w-9", limit: 20 },
    });
    expect(res).toEqual(fixture);
  });

  it.each([
    ["a string", "bad"],
    ["null", null],
    ["an object without events", { rows: [] }],
    ["events that is not an array", { events: "nope" }],
  ])("rejects %s", async (_label, value) => {
    invokeMock.mockResolvedValueOnce(value);
    await expect(createIpcClient().watcherListHistory("w-9", 20)).rejects.toThrow(
      "watcher.listHistory: expected { events: [] }",
    );
  });
});

describe("workflow.listRuns", () => {
  it("forwards workflowName + limit and returns the runs envelope", async () => {
    const fixture = { runs: [{ runId: "r1", status: "done" }] };
    invokeMock.mockResolvedValueOnce(fixture);
    const res = await createIpcClient().workflowListRuns("Deploy", 10);
    expect(invokeMock).toHaveBeenCalledWith("rpc_call", {
      method: "workflow.listRuns",
      params: { workflowName: "Deploy", limit: 10 },
    });
    expect(res).toEqual(fixture);
  });

  it.each([
    ["a string", "bad"],
    ["null", null],
    ["an object without runs", { events: [] }],
    ["runs that is not an array", { runs: {} }],
  ])("rejects %s", async (_label, value) => {
    invokeMock.mockResolvedValueOnce(value);
    await expect(createIpcClient().workflowListRuns("Deploy", 10)).rejects.toThrow(
      "workflow.listRuns: expected { runs: [] }",
    );
  });
});

describe("data.getExportPreflight — numeric lastExportAt", () => {
  it("accepts a numeric lastExportAt", async () => {
    const fixture = { lastExportAt: 1_700_000_000_000, estimatedSizeBytes: 10, itemCount: 2 };
    invokeMock.mockResolvedValueOnce(fixture);
    await expect(createIpcClient().dataGetExportPreflight()).resolves.toEqual(fixture);
  });

  it.each([
    [
      "a lastExportAt that is neither null nor a number",
      { lastExportAt: "yesterday", estimatedSizeBytes: 10, itemCount: 2 },
    ],
    ["an array, even though arrays are objects", []],
  ])("rejects %s", async (_label, response) => {
    invokeMock.mockResolvedValueOnce(response);
    await expect(createIpcClient().dataGetExportPreflight()).rejects.toThrow(
      "IPC response for data.getExportPreflight has unexpected shape",
    );
  });
});

// Every data.* wrapper validates the reply before a wizard renders it. Each invalid reply below
// breaks exactly ONE field of an otherwise well-formed reply, so every individual check must hold.
interface ShapeGuardCase {
  readonly method: string;
  readonly run: (c: NimbusIpcClient) => Promise<unknown>;
  readonly valid: Record<string, unknown>;
  readonly invalid: ReadonlyArray<readonly [string, unknown]>;
}

const DELETE_PREFLIGHT = { service: "github", itemCount: 12, embeddingCount: 3, vaultKeyCount: 1 };
const EXPORTED = {
  outputPath: "/mock-output/nimbus.tar.gz",
  recoverySeed: "one two three",
  recoverySeedGenerated: true,
  itemsExported: 5,
};
const IMPORTED = { credentialsRestored: 2, oauthEntriesFlagged: 0 };
const DELETED_PREFLIGHT = { service: "github", itemsToDelete: 4, vaultEntriesToDelete: 1 };
const DELETED = { deleted: true, preflight: DELETED_PREFLIGHT };

const SHAPE_GUARDS: readonly ShapeGuardCase[] = [
  {
    method: "data.getExportPreflight",
    run: (c) => c.dataGetExportPreflight(),
    valid: { lastExportAt: null, estimatedSizeBytes: 10, itemCount: 2 },
    invalid: [
      ["estimatedSizeBytes", { lastExportAt: null, estimatedSizeBytes: "10", itemCount: 2 }],
      ["itemCount", { lastExportAt: null, estimatedSizeBytes: 10 }],
    ],
  },
  {
    method: "data.getDeletePreflight",
    run: (c) => c.dataGetDeletePreflight({ service: "github" }),
    valid: DELETE_PREFLIGHT,
    invalid: [
      ["service", { ...DELETE_PREFLIGHT, service: 42 }],
      ["itemCount", { ...DELETE_PREFLIGHT, itemCount: "12" }],
      ["embeddingCount", { ...DELETE_PREFLIGHT, embeddingCount: null }],
      ["vaultKeyCount", { ...DELETE_PREFLIGHT, vaultKeyCount: undefined }],
    ],
  },
  {
    method: "data.export",
    run: (c) =>
      c.dataExport({ output: "/mock-output/nimbus.tar.gz", passphrase: "pw", includeIndex: true }),
    valid: EXPORTED,
    invalid: [
      ["outputPath", { ...EXPORTED, outputPath: null }],
      ["recoverySeed", { ...EXPORTED, recoverySeed: 7 }],
      ["recoverySeedGenerated", { ...EXPORTED, recoverySeedGenerated: "true" }],
      ["itemsExported", { ...EXPORTED, itemsExported: "5" }],
    ],
  },
  {
    method: "data.import",
    run: (c) => c.dataImport({ bundlePath: "/mock-input/nimbus.tar.gz", passphrase: "pw" }),
    valid: IMPORTED,
    invalid: [
      ["credentialsRestored", { ...IMPORTED, credentialsRestored: "2" }],
      ["oauthEntriesFlagged", { credentialsRestored: 2 }],
    ],
  },
  {
    method: "data.delete",
    run: (c) => c.dataDelete({ service: "github", dryRun: false }),
    valid: DELETED,
    invalid: [
      ["deleted", { ...DELETED, deleted: "true" }],
      ["preflight (null)", { ...DELETED, preflight: null }],
      ["preflight (array)", { ...DELETED, preflight: [] }],
      ["preflight.service", { ...DELETED, preflight: { ...DELETED_PREFLIGHT, service: 1 } }],
      [
        "preflight.itemsToDelete",
        { ...DELETED, preflight: { ...DELETED_PREFLIGHT, itemsToDelete: "4" } },
      ],
      [
        "preflight.vaultEntriesToDelete",
        { ...DELETED, preflight: { ...DELETED_PREFLIGHT, vaultEntriesToDelete: null } },
      ],
    ],
  },
];

describe("data.* response shape guards", () => {
  for (const { method, run, valid, invalid } of SHAPE_GUARDS) {
    it(`${method} passes a well-formed reply through unchanged`, async () => {
      invokeMock.mockResolvedValueOnce(valid);
      await expect(run(createIpcClient())).resolves.toBe(valid);
      expect(invokeMock.mock.calls[0]?.[1]?.method).toBe(method);
    });

    it.each(invalid)(`${method} rejects a reply with a malformed %s`, async (_field, reply) => {
      invokeMock.mockResolvedValueOnce(reply);
      await expect(run(createIpcClient())).rejects.toThrow(
        `IPC response for ${method} has unexpected shape`,
      );
    });
  }
});

describe("data.import — auth parameters", () => {
  it.each([
    ["a passphrase", { bundlePath: "/mock-input/nimbus.tar.gz", passphrase: "pw" }],
    ["a recovery seed", { bundlePath: "/mock-input/nimbus.tar.gz", recoverySeed: "one two three" }],
  ])("sends the bundle path and only %s", async (_label, args) => {
    invokeMock.mockResolvedValueOnce(IMPORTED);
    await createIpcClient().dataImport(args);
    const sent = invokeMock.mock.calls[0]?.[1]?.params as Record<string, unknown>;
    expect(sent).toEqual(args);
    expect(Object.keys(sent).sort((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(args).sort((a, b) => a.localeCompare(b)),
    );
  });
});
