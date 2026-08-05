import { describe, expect, it, test } from "bun:test";
import {
  type AdapterDeps,
  buildMcpServer,
  type ConnectionEnv,
  clampLimit,
  createDeps,
  GATEWAY_DOWN_MESSAGE,
  GatewayUnavailableError,
  type IpcCallable,
  isDisconnectError,
  projectRankedItem,
  projectRankedItems,
  TOOL_SPECS,
} from "./adapter.ts";

describe("clampLimit", () => {
  it("defaults to 20 when undefined", () => {
    expect(clampLimit(undefined)).toBe(20);
  });
  it("caps at 50", () => {
    expect(clampLimit(1000)).toBe(50);
  });
  it("floors at 1", () => {
    expect(clampLimit(0)).toBe(1);
  });
  it("passes a valid value through, floored", () => {
    expect(clampLimit(7.9)).toBe(7);
  });
  it("defaults on non-finite", () => {
    expect(clampLimit(Number.NaN)).toBe(20);
  });
  it("floors a negative value to 1", () => {
    expect(clampLimit(-5)).toBe(1);
  });
});

describe("projectRankedItem", () => {
  it("keeps core fields and maps indexedType -> type", () => {
    const out = projectRankedItem({
      name: "Fix login bug",
      service: "github",
      itemType: "file",
      indexedType: "pr",
      url: "https://example/pr/1",
      score: 0.91,
      modifiedAt: 1_700_000_000_000,
    });
    expect(out).toEqual({
      name: "Fix login bug",
      service: "github",
      type: "pr",
      url: "https://example/pr/1",
      score: 0.91,
      modifiedAt: 1_700_000_000_000,
    });
  });

  it("drops the raw rawMeta blob but keeps the whitelisted slice as meta (real github PR keys)", () => {
    const out = projectRankedItem({
      name: "PR",
      service: "github",
      indexedType: "pr",
      score: 0.5,
      rawMeta: {
        state: "open",
        number: 42,
        user: "alice", // github stores the PR author under `user`, not `author`
        labels: ["bug", "p1"],
        merged: false,
        draft: false,
        secret_token: "should-not-leak",
        huge_blob: "x".repeat(10_000),
      },
    });
    expect(out["meta"]).toEqual({
      state: "open",
      number: 42,
      user: "alice",
      labels: ["bug", "p1"],
      merged: false,
      draft: false,
    });
    expect(JSON.stringify(out)).not.toContain("should-not-leak");
    expect(JSON.stringify(out)).not.toContain("huge_blob");
  });

  it("truncates an over-long whitelisted string value to META_STRING_MAX (200)", () => {
    const out = projectRankedItem({
      name: "incident",
      service: "pagerduty",
      indexedType: "incident",
      score: 0.5,
      rawMeta: { status: "y".repeat(500), severity: "high" },
    });
    const meta = out["meta"] as Record<string, unknown>;
    expect(meta["status"] as string).toHaveLength(200);
    expect(meta["severity"]).toBe("high");
  });

  it("falls back to canonicalUrl when url is absent and keeps semanticSnippet", () => {
    const out = projectRankedItem({
      name: "Doc",
      service: "drive",
      indexedType: "file",
      score: 0.3,
      canonicalUrl: "https://example/canon",
      semanticSnippet: "…matched text…",
    });
    expect(out["url"]).toBe("https://example/canon");
    expect(out["semanticSnippet"]).toBe("…matched text…");
  });

  it("omits meta when no whitelisted keys are present", () => {
    const out = projectRankedItem({
      name: "x",
      service: "s",
      indexedType: "file",
      score: 1,
      rawMeta: { mime_type: "text/plain" },
    });
    expect(out["meta"]).toBeUndefined();
  });

  it("truncates over-long strings inside a whitelisted array value (labels)", () => {
    const out = projectRankedItem({
      name: "PR",
      service: "github",
      indexedType: "pr",
      score: 0.5,
      rawMeta: { labels: ["bug", "z".repeat(500)] },
    });
    const meta = out["meta"] as Record<string, unknown>;
    const labels = meta["labels"] as string[];
    expect(labels[0]).toBe("bug");
    expect(labels[1]).toHaveLength(200);
  });

  it("drops null-valued whitelisted keys but keeps false/zero", () => {
    const out = projectRankedItem({
      name: "PR",
      service: "github",
      indexedType: "pr",
      score: 0.5,
      rawMeta: { state: null, merged: false, number: 0 },
    });
    expect(out["meta"]).toEqual({ merged: false, number: 0 });
  });
});

describe("projectRankedItems", () => {
  it("maps a valid array", () => {
    expect(
      projectRankedItems([{ name: "a", service: "s", indexedType: "pr", score: 1 }]),
    ).toHaveLength(1);
  });
  it("returns [] for undefined", () => {
    expect(projectRankedItems(undefined)).toEqual([]);
  });
  it("returns [] for a non-array object", () => {
    expect(projectRankedItems({})).toEqual([]);
  });
});

// Accepts a non-generic handler and adapts it to IpcCallable's generic `call<T>` signature.
// (A bare `async () => null` is not assignable to `<T>() => Promise<T>`, so wrap + cast here.)
function fakeClient(handler: (method: string, params?: unknown) => Promise<unknown>): IpcCallable {
  return {
    call: <T>(method: string, params?: unknown): Promise<T> =>
      handler(method, params) as Promise<T>,
    disconnect: async () => {},
  };
}

describe("isDisconnectError", () => {
  it("recognizes transport-dead messages", () => {
    expect(isDisconnectError(new Error("IPC client is not connected"))).toBe(true);
    expect(isDisconnectError(new Error("IPC connection closed"))).toBe(true);
    expect(isDisconnectError(new Error("IPC connection error"))).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isDisconnectError(new Error("Local index is not available"))).toBe(false);
    expect(isDisconnectError("nope")).toBe(false);
  });
});

describe("createDeps", () => {
  it("throws GatewayUnavailableError when no gateway state", async () => {
    const env: ConnectionEnv = {
      readState: async () => undefined,
      connect: async () => fakeClient(async () => null),
    };
    await expect(createDeps(env).getClient()).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("throws GatewayUnavailableError when connect fails", async () => {
    const env: ConnectionEnv = {
      readState: async () => ({ socketPath: "/tmp/x.sock" }),
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    await expect(createDeps(env).getClient()).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("caches the connected client across calls", async () => {
    let connects = 0;
    const env: ConnectionEnv = {
      readState: async () => ({ socketPath: "/tmp/x.sock" }),
      connect: async () => {
        connects += 1;
        return fakeClient(async () => "ok");
      },
    };
    const deps = createDeps(env);
    await deps.getClient();
    await deps.getClient();
    expect(connects).toBe(1);
  });

  it("reconnects after a dropped connection", async () => {
    let connects = 0;
    const env: ConnectionEnv = {
      readState: async () => ({ socketPath: "/tmp/x.sock" }),
      connect: async () => {
        connects += 1;
        return fakeClient(async () => {
          throw new Error("IPC connection closed");
        });
      },
    };
    const deps = createDeps(env);
    const c1 = await deps.getClient();
    await expect(c1.call("index.searchRanked", {})).rejects.toThrow("IPC connection closed");
    // The failed call invalidated the cache; the next getClient reconnects.
    await deps.getClient();
    expect(connects).toBe(2);
  });

  it("does NOT invalidate the cache on a non-disconnect application error", async () => {
    let connects = 0;
    const env: ConnectionEnv = {
      readState: async () => ({ socketPath: "/tmp/x.sock" }),
      connect: async () => {
        connects += 1;
        return fakeClient(async () => {
          throw new Error("Method not found");
        });
      },
    };
    const deps = createDeps(env);
    const c1 = await deps.getClient();
    await expect(c1.call("no.such.method", {})).rejects.toThrow("Method not found");
    const c2 = await deps.getClient();
    expect(connects).toBe(1);
    expect(c2).toBe(c1);
  });

  it("does not double-connect under concurrent getClient calls", async () => {
    let connects = 0;
    const env: ConnectionEnv = {
      readState: async () => ({ socketPath: "/tmp/x.sock" }),
      connect: async () => {
        connects += 1;
        await new Promise((r) => setTimeout(r, 10));
        return fakeClient(async () => "ok");
      },
    };
    const deps = createDeps(env);
    const [a, b] = await Promise.all([deps.getClient(), deps.getClient()]);
    expect(connects).toBe(1);
    expect(a).toBe(b);
  });
});

type RecordedCall = { method: string; params?: unknown };

function recordingDeps(opts: { result?: unknown; fail?: "down" | "drop" }): {
  deps: AdapterDeps;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: IpcCallable = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (opts.fail === "drop") {
        throw new Error("IPC connection closed");
      }
      return opts.result as T;
    },
    disconnect: async () => {},
  };
  const deps: AdapterDeps = {
    getClient: async () => {
      if (opts.fail === "down") {
        throw new GatewayUnavailableError();
      }
      return client;
    },
  };
  return { deps, calls };
}

function spec(name: string) {
  const s = TOOL_SPECS.find((t) => t.name === name);
  if (s === undefined) {
    throw new Error(`no tool spec ${name}`);
  }
  return s;
}

describe("TOOL_SPECS", () => {
  it("exposes exactly the seventeen read-only tools", () => {
    expect(TOOL_SPECS.map((t) => t.name).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        "assessImpact",
        "checkResourceUsage",
        "explainWhy",
        "findConflicts",
        "findDecisions",
        "findExpert",
        "getCatchup",
        "getConnectorStatus",
        "getDoraMetrics",
        "getGlossary",
        "getPeerContext",
        "getRecentDeployments",
        "getRecentIncidents",
        "getRecentPullRequests",
        "getTeamHuddle",
        "peekWhy",
        "searchIndex",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("searchIndex maps to index.searchRanked with clamped limit and contextChunks 0", async () => {
    const { deps, calls } = recordingDeps({
      result: [{ name: "n", service: "github", indexedType: "pr", score: 1 }],
    });
    const res = await spec("searchIndex").run(deps, {
      query: "login bug",
      service: "github",
      limit: 1000,
    });
    expect(calls[0]).toEqual({
      method: "index.searchRanked",
      params: { name: "login bug", limit: 50, semantic: true, contextChunks: 0, service: "github" },
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('"type": "pr"');
  });

  it("getRecentPullRequests browses itemType pr by recency", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("getRecentPullRequests").run(deps, {});
    expect(calls[0]).toEqual({
      method: "index.searchRanked",
      params: { name: "", limit: 20, semantic: false, contextChunks: 0, itemType: "pr" },
    });
  });

  it("getRecentIncidents and getRecentDeployments pin their itemType", async () => {
    const inc = recordingDeps({ result: [] });
    await spec("getRecentIncidents").run(inc.deps, { service: "pagerduty" });
    expect(inc.calls[0]?.params).toMatchObject({ itemType: "incident", service: "pagerduty" });

    const dep = recordingDeps({ result: [] });
    await spec("getRecentDeployments").run(dep.deps, {});
    expect(dep.calls[0]?.params).toMatchObject({ itemType: "deployment" });
  });

  it("getConnectorStatus calls connector.listStatus and passes the result through", async () => {
    const { deps, calls } = recordingDeps({ result: [{ service: "github", health: "healthy" }] });
    const res = await spec("getConnectorStatus").run(deps, {});
    expect(calls[0]?.method).toBe("connector.listStatus");
    expect(res.content[0]?.text).toContain("healthy");
  });

  it("getDoraMetrics calls metrics.dora with service and since", async () => {
    const { deps, calls } = recordingDeps({ result: { deploymentFrequency: null } });
    await spec("getDoraMetrics").run(deps, { service: "payments", since: "30d" });
    expect(calls[0]).toEqual({
      method: "metrics.dora",
      params: { service: "payments", since: "30d" },
    });
  });

  it("returns an isError result with guidance when the Gateway is down", async () => {
    const { deps } = recordingDeps({ fail: "down" });
    const res = await spec("searchIndex").run(deps, { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("nimbus start");
  });

  it("returns an isError result (not a throw) on a dropped connection", async () => {
    const { deps } = recordingDeps({ result: [], fail: "drop" });
    const res = await spec("searchIndex").run(deps, { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("nimbus start");
  });
});

describe("buildMcpServer", () => {
  it("registers all seventeen tools without throwing", () => {
    const { deps } = recordingDeps({ result: [] });
    const server = buildMcpServer(deps);
    expect(server).toBeDefined();
  });
});

// ---- Additional branch coverage ----

describe("clampLimit — Infinity arm", () => {
  it("defaults to 20 for positive Infinity (non-finite number, not NaN)", () => {
    // Number.POSITIVE_INFINITY is a real non-finite NUMBER, hitting the isFinite=false arm
    // (NaN also hits it, but this explicitly exercises the Infinity path)
    expect(Number.isFinite(Number.POSITIVE_INFINITY)).toBe(false);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(20);
  });

  it("defaults to 20 for negative Infinity", () => {
    expect(clampLimit(Number.NEGATIVE_INFINITY)).toBe(20);
  });
});

describe("projectRankedItem — missing/wrong field branches", () => {
  it("returns empty object for a non-object input (null passthrough via asRecord)", () => {
    // asRecord(null) -> {} so all field checks produce undefined -> nothing set
    const out = projectRankedItem(null);
    expect(out).toEqual({});
  });

  it("returns empty object for a primitive input", () => {
    const out = projectRankedItem("just a string");
    expect(out).toEqual({});
  });

  it("falls back to itemType when indexedType is absent", () => {
    // indexedType missing -> falls to r["itemType"] branch
    const out = projectRankedItem({ name: "x", itemType: "file", score: 0.5 });
    expect(out["type"]).toBe("file");
  });

  it("omits type entirely when neither indexedType nor itemType is a string", () => {
    const out = projectRankedItem({ name: "x", score: 0.5 });
    expect(out["type"]).toBeUndefined();
  });

  it("omits url when neither url nor canonicalUrl is a string", () => {
    const out = projectRankedItem({ name: "x", score: 0.5 });
    expect(out["url"]).toBeUndefined();
  });

  it.each(["score", "modifiedAt", "semanticSnippet"])("omits %s when absent", (field) => {
    const out = projectRankedItem({ name: "x" });
    expect(out[field]).toBeUndefined();
  });

  it("omits meta when rawMeta is null", () => {
    const out = projectRankedItem({ name: "x", rawMeta: null });
    expect(out["meta"]).toBeUndefined();
  });

  it("omits meta when rawMeta is a string (not an object)", () => {
    const out = projectRankedItem({ name: "x", rawMeta: "nope" });
    expect(out["meta"]).toBeUndefined();
  });

  it("omits meta when rawMeta is a number (not an object)", () => {
    const out = projectRankedItem({ name: "x", rawMeta: 42 });
    expect(out["meta"]).toBeUndefined();
  });

  it("passes through non-string, non-array meta values unchanged (numbers, booleans)", () => {
    // clampMetaValue: neither string nor Array -> return v as-is
    const out = projectRankedItem({
      name: "x",
      rawMeta: { number: 99, merged: true, priority: 5 },
    });
    const meta = out["meta"] as Record<string, unknown>;
    expect(meta["number"]).toBe(99);
    expect(meta["merged"]).toBe(true);
    expect(meta["priority"]).toBe(5);
  });
});

describe("runTool error branches", () => {
  it("returns isError with 'Nimbus: ...' when getClient throws a non-GatewayUnavailableError Error", async () => {
    const deps: AdapterDeps = {
      getClient: async () => {
        throw new Error("some internal failure");
      },
    };
    // Use the searchIndex tool's run which calls runTool internally
    const res = await spec("searchIndex").run(deps, { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("Nimbus: some internal failure");
  });

  it("returns isError with String(e) when getClient throws a non-Error value", async () => {
    const deps: AdapterDeps = {
      getClient: async () => {
        throw "raw string error";
      },
    };
    const res = await spec("searchIndex").run(deps, { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("Nimbus: raw string error");
  });

  it("returns isError with 'Nimbus: ...' when fn throws a non-disconnect Error", async () => {
    const client = fakeClient(async () => {
      throw new Error("Method not found");
    });
    const deps: AdapterDeps = { getClient: async () => client };
    const res = await spec("getConnectorStatus").run(deps, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("Nimbus: Method not found");
  });

  it("returns isError with String(e) when fn throws a non-Error, non-disconnect value", async () => {
    const client = fakeClient(async () => {
      throw 12345;
    });
    const deps: AdapterDeps = { getClient: async () => client };
    const res = await spec("getConnectorStatus").run(deps, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("Nimbus: 12345");
  });
});

describe("TOOL_SPECS — additional branch arms", () => {
  it("searchIndex treats semantic=false as false (not truthy default)", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("searchIndex").run(deps, { query: "test", semantic: false });
    // semantic: optBool(args, "semantic") !== false => false !== false => false
    expect(calls[0]?.params).toMatchObject({ semantic: false });
  });

  it("searchIndex defaults semantic to true when semantic is absent", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("searchIndex").run(deps, { query: "test" });
    // undefined !== false => true
    expect(calls[0]?.params).toMatchObject({ semantic: true });
  });

  it("searchIndex uses empty string when query is not a string", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    // optString(args, "query") returns undefined -> ?? ""
    await spec("searchIndex").run(deps, { query: 42 });
    expect(calls[0]?.params).toMatchObject({ name: "" });
  });

  it("searchIndex omits itemType from params when not provided", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("searchIndex").run(deps, { query: "x" });
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("itemType");
  });

  it("searchIndex includes itemType in params when provided", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("searchIndex").run(deps, { query: "x", itemType: "pr" });
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params["itemType"]).toBe("pr");
  });

  it("searchIndex omits service from params when not provided", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("searchIndex").run(deps, { query: "x" });
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("service");
  });

  it("getRecentPullRequests omits service when not provided", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("getRecentPullRequests").run(deps, {});
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("service");
  });

  it("getRecentPullRequests includes service when provided", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("getRecentPullRequests").run(deps, { service: "github" });
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params["service"]).toBe("github");
  });

  it("getDoraMetrics omits 'since' from params when not provided", async () => {
    const { deps, calls } = recordingDeps({ result: { deploymentFrequency: null } });
    await spec("getDoraMetrics").run(deps, { service: "payments" });
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("since");
    expect(params["service"]).toBe("payments");
  });

  it("getDoraMetrics falls back to empty string service when service is missing", async () => {
    const { deps, calls } = recordingDeps({ result: {} });
    // optString(args, "service") returns undefined -> ?? ""
    await spec("getDoraMetrics").run(deps, {});
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params["service"]).toBe("");
  });
});

test("peekWhy is registered and calls agents.whyPeek", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const deps = {
    getClient: async () => ({
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        return { summary: "because of PR #412" } as T;
      },
      disconnect: async (): Promise<void> => {},
    }),
  };
  const spec = TOOL_SPECS.find((s) => s.name === "peekWhy");
  expect(spec).toBeDefined();
  const out = await spec?.run(deps, { ref: "src/a.ts" });
  expect(calls[0]?.method).toBe("agents.whyPeek");
  expect(calls[0]?.params).toEqual({ ref: "src/a.ts" });
  expect(out?.isError).toBeUndefined();
  expect(out?.content[0]?.text).toContain("because of PR #412");
});

test("peekWhy reports a stopped gateway without throwing", async () => {
  const deps = {
    getClient: (): Promise<never> => Promise.reject(new GatewayUnavailableError()),
  };
  const spec = TOOL_SPECS.find((s) => s.name === "peekWhy");
  const out = await spec?.run(deps, { fileOrPrUrl: "src/a.ts" });
  expect(out?.isError).toBe(true);
  expect(out?.content[0]?.text).toBe(GATEWAY_DOWN_MESSAGE);
});

test("peekWhy sends `ref` — the key agents.whyPeek's validator actually reads", () => {
  // `requireWhyParams` reads `ref`; a `fileOrPrUrl` here is rejected -32602 on every real call.
  expect(Object.keys(spec("peekWhy").schema)).toEqual(["ref"]);
});

test("the registered tool set is the six index tools plus peekWhy plus ten agents", () => {
  expect(TOOL_SPECS).toHaveLength(17);
  const names = new Set(TOOL_SPECS.map((s) => s.name));
  expect(names.has("searchIndex")).toBe(true);
  expect(names.has("peekWhy")).toBe(true);
  expect(names.has("explainWhy")).toBe(true);
  expect(names.has("runPreflight")).toBe(false);
});

/** Drain every pending microtask, so a lazily-opened connection is fully established. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

test("a disconnect on one call fails briefs in flight on the same connection", async () => {
  let failNext = false;
  const raw = {
    onNotification(_m: string, _h: (p: unknown) => void): void {},
    async call<T>(method: string): Promise<T> {
      if (failNext && method === "connector.listStatus") {
        throw new Error("IPC connection closed");
      }
      return { sessionId: "s1" } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const deps = createDeps({
    readState: async () => ({ socketPath: "/tmp/sock" }),
    connect: async () => raw,
  });

  const inFlight = spec("explainWhy").run(deps, { ref: "x" });
  await flush();

  // A second, failing call on the same connection trips the disconnect branch.
  failNext = true;
  await spec("getConnectorStatus").run(deps, {});

  // Resolves well inside the 60 s timeout, because failAll found the WRAPPER in the WeakMap.
  // Keyed on `raw` instead, this does not fail an assertion — it hangs out the agent timeout and
  // trips the 5 s budget below. That budget IS the assertion.
  const out = await inFlight;
  expect(out.isError).toBe(true);
  expect(out.content[0]?.text).toBe(GATEWAY_DOWN_MESSAGE);
}, 5000);

test("an unexpected transport close fails a solitary brief in flight", async () => {
  let fireClose: ((err: Error) => void) | undefined;
  const raw = {
    onNotification(_m: string, _h: (p: unknown) => void): void {},
    offNotification(_m: string, _h: (p: unknown) => void): void {},
    onClose(h: (err: Error) => void): void {
      fireClose = h;
    },
    offClose(_h: (err: Error) => void): void {},
    async call<T>(): Promise<T> {
      return { sessionId: "s1" } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const deps = createDeps({
    readState: async () => ({ socketPath: "/tmp/sock" }),
    connect: async () => raw,
  });

  const inFlight = spec("explainWhy").run(deps, { ref: "x" });
  await flush();

  // No second call is made — the connection simply dies. Only onClose can observe this.
  expect(fireClose).toBeDefined();
  fireClose?.(new Error("IPC connection closed"));

  const out = await inFlight;
  expect(out.isError).toBe(true);
}, 5000);

test("a connection with no onClose still connects (guard's false arm)", async () => {
  const raw: IpcCallable = {
    async call<T>(): Promise<T> {
      return {} as T;
    },
    async disconnect(): Promise<void> {},
  };
  const deps = createDeps({
    readState: async () => ({ socketPath: "/tmp/sock" }),
    connect: async () => raw,
  });
  await expect(deps.getClient()).resolves.toBeDefined();
});
