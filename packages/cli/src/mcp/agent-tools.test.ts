import { expect, test } from "bun:test";
import { TOOL_SPECS } from "./adapter.ts";
import { AGENT_TOOL_SPECS, agentTimeoutMs, failBriefsForClient } from "./agent-tools.ts";
import type { IpcCallable } from "./client-surface.ts";
import { GatewayUnavailableError } from "./errors.ts";

/** A fake client that answers the agents.* call and then emits the matching briefReady. */
function briefClient(sessionId: string, brief: string) {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  return {
    onNotification(method: string, h: (p: unknown) => void): void {
      const l = handlers.get(method) ?? [];
      l.push(h);
      handlers.set(method, l);
    },
    async call<T>(method: string, _params?: unknown): Promise<T> {
      const agent = method.slice("agents.".length);
      queueMicrotask(() => {
        for (const h of handlers.get(`${agent}.briefReady`) ?? []) {
          h({ sessionId, brief, findings: { gaps: [] } });
        }
      });
      return { sessionId } as T;
    },
    async disconnect(): Promise<void> {},
  };
}

function specFor(name: string) {
  const s = AGENT_TOOL_SPECS.find((t) => t.name === name);
  if (s === undefined) {
    throw new Error(`no agent tool spec ${name}`);
  }
  return s;
}

test("the brief timeout defaults to 60s and honours NIMBUS_MCP_TIMEOUT_MS", () => {
  expect(agentTimeoutMs({})).toBe(60_000);
  expect(agentTimeoutMs({ NIMBUS_MCP_TIMEOUT_MS: "15000" })).toBe(15_000);
  expect(agentTimeoutMs({ NIMBUS_MCP_TIMEOUT_MS: "not-a-number" })).toBe(60_000);
  expect(agentTimeoutMs({ NIMBUS_MCP_TIMEOUT_MS: "-5" })).toBe(60_000);
});

test("agentTimeoutMs reads process.env when no env is passed", () => {
  // Exercises the default-parameter arm. NIMBUS_MCP_TIMEOUT_MS is not set in the test env, so the
  // default applies; asserting the value would couple the test to an ambient variable.
  expect(agentTimeoutMs()).toBeGreaterThan(0);
});

test("no agent tool exposes a timeout parameter to the calling model", () => {
  for (const spec of AGENT_TOOL_SPECS) {
    expect(Object.keys(spec.schema)).not.toContain("timeout");
    expect(Object.keys(spec.schema)).not.toContain("timeoutMs");
  }
});

test("all eleven async agents are registered, and preflight is not", () => {
  const names = AGENT_TOOL_SPECS.map((s) => s.name).sort();
  expect(names).toEqual(
    [
      "assessImpact",
      "checkResourceUsage",
      "explainWhy",
      "findConflicts",
      "findDecisions",
      "findExpert",
      "findOwners",
      "getCatchup",
      "getGlossary",
      "getPeerContext",
      "getTeamHuddle",
    ].sort(),
  );
  expect(names).not.toContain("runPreflight");
});

test("explainWhy returns the brief markdown as the first content block", async () => {
  const client = briefClient("s1", "## Why\n\nBecause of PR #412.");
  const deps = { getClient: async () => client };
  const out = await specFor("explainWhy").run(deps, { ref: "src/a.ts" });
  expect(out.isError).toBeUndefined();
  expect(out.content[0]?.text).toContain("Because of PR #412.");
});

test("the typed findings ride along as a second content block", async () => {
  const client = briefClient("s1", "brief");
  const deps = { getClient: async () => client };
  const out = await specFor("getCatchup").run(deps, {});
  expect(out.content).toHaveLength(2);
  expect(out.content[1]?.text).toContain("gaps");
});

test("a brief error becomes an MCP error result, never a throw", async () => {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const client = {
    onNotification(m: string, h: (p: unknown) => void): void {
      const l = handlers.get(m) ?? [];
      l.push(h);
      handlers.set(m, l);
    },
    async call<T>(_m: string, _p?: unknown): Promise<T> {
      queueMicrotask(() => {
        for (const h of handlers.get("why.briefError") ?? []) {
          h({ sessionId: "s1", error: "no index" });
        }
      });
      return { sessionId: "s1" } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const out = await specFor("explainWhy").run({ getClient: async () => client }, { ref: "x" });
  expect(out.isError).toBe(true);
  expect(out.content[0]?.text).toContain("no index");
});

test("failBriefsForClient rejects a brief in flight on that client", async () => {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const client = {
    onNotification(m: string, h: (p: unknown) => void): void {
      const l = handlers.get(m) ?? [];
      l.push(h);
      handlers.set(m, l);
    },
    async call<T>(_m: string, _p?: unknown): Promise<T> {
      return { sessionId: "s1" } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const running = specFor("explainWhy").run({ getClient: async () => client }, { ref: "x" });
  await Promise.resolve();
  failBriefsForClient(client, new Error("IPC connection closed"));
  const out = await running;
  expect(out.isError).toBe(true);
});

test("failBriefsForClient on a client with no router in flight is a no-op", () => {
  expect(() => {
    failBriefsForClient({}, new Error("IPC connection closed"));
  }).not.toThrow();
});

test("two agent calls on one client share a single router", async () => {
  const bound: string[] = [];
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  let n = 0;
  const client = {
    onNotification(m: string, h: (p: unknown) => void): void {
      bound.push(m);
      const l = handlers.get(m) ?? [];
      l.push(h);
      handlers.set(m, l);
    },
    async call<T>(method: string, _p?: unknown): Promise<T> {
      n += 1;
      const sessionId = `s${String(n)}`;
      const agent = method.slice("agents.".length);
      queueMicrotask(() => {
        for (const h of handlers.get(`${agent}.briefReady`) ?? []) {
          h({ sessionId, brief: `brief-${sessionId}`, findings: {} });
        }
      });
      return { sessionId } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const deps = { getClient: async () => client };
  const first = await specFor("explainWhy").run(deps, { ref: "x" });
  const second = await specFor("explainWhy").run(deps, { ref: "y" });
  expect(first.content[0]?.text).toBe("brief-s1");
  expect(second.content[0]?.text).toBe("brief-s2");
  // A second router would re-register the pair; one router binds `why` exactly once.
  expect(bound.filter((m) => m === "why.briefReady")).toHaveLength(1);
});

test("a transport that cannot deliver notifications is reported, not left to time out", async () => {
  // The only code path that can tell an operator the transport itself is incapable. Without it the
  // waiter never settles and the 60 s timeout blames the agent.
  const client: IpcCallable = {
    async call<T>(): Promise<T> {
      return { sessionId: "s1" } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const out = await specFor("explainWhy").run({ getClient: async () => client }, { ref: "x" });
  expect(out.isError).toBe(true);
  expect(out.content[0]?.text).toContain("cannot receive agent notifications");
});

test("a stopped gateway is reported with the start hint", async () => {
  const out = await specFor("getCatchup").run(
    { getClient: (): Promise<never> => Promise.reject(new GatewayUnavailableError()) },
    {},
  );
  expect(out.isError).toBe(true);
  expect(out.content[0]?.text).toContain("nimbus start");
});

test("a non-GatewayUnavailable connect failure is surfaced verbatim", async () => {
  const out = await specFor("getCatchup").run(
    {
      getClient: (): Promise<never> => Promise.reject(new Error("socket busy")),
    },
    {},
  );
  expect(out.isError).toBe(true);
  expect(out.content[0]?.text).toBe("Nimbus: socket busy");
});

test("a non-Error connect failure is stringified", async () => {
  const out = await specFor("getCatchup").run(
    {
      getClient: (): Promise<never> => Promise.reject("boom"),
    },
    {},
  );
  expect(out.isError).toBe(true);
  expect(out.content[0]?.text).toBe("Nimbus: boom");
});

test("an agents.* call that fails outright becomes an error result, not a throw", async () => {
  const client = {
    onNotification(_m: string, _h: (p: unknown) => void): void {},
    async call<T>(_m: string, _p?: unknown): Promise<T> {
      throw new Error("Method not found");
    },
    async disconnect(): Promise<void> {},
  };
  const out = await specFor("findExpert").run(
    { getClient: async () => client },
    { topicOrFile: "auth" },
  );
  expect(out.isError).toBe(true);
  expect(out.content[0]?.text).toBe("Nimbus: Method not found");
});

test("a transport-dead agents.* call reports the gateway-down guidance", async () => {
  const client = {
    onNotification(_m: string, _h: (p: unknown) => void): void {},
    async call<T>(_m: string, _p?: unknown): Promise<T> {
      throw new Error("IPC connection closed");
    },
    async disconnect(): Promise<void> {},
  };
  const out = await specFor("findConflicts").run(
    { getClient: async () => client },
    { file: "a.ts" },
  );
  expect(out.isError).toBe(true);
  expect(out.content[0]?.text).toContain("nimbus start");
});

test("each tool calls its own agents.* method with the declared params", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = briefClient("s1", "brief");
  const recording = {
    ...client,
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return await client.call<T>(method, params);
    },
  };
  const deps = { getClient: async () => recording };
  await specFor("assessImpact").run(deps, { fileOrPrUrl: "a.ts", depth: 3 });
  await specFor("getTeamHuddle").run(deps, { namespace: "team" });
  await specFor("checkResourceUsage").run(deps, { resourceRef: "arn:x" });
  await specFor("getPeerContext").run(deps, { file: "a.ts" });
  await specFor("getGlossary").run(deps, { term: "SLO", limit: 5 });
  await specFor("findDecisions").run(deps, { limit: 3 });
  await specFor("findOwners").run(deps, { path: "src/a.ts" });
  expect(calls).toEqual([
    { method: "agents.impact", params: { fileOrPrUrl: "a.ts", depth: 3 } },
    { method: "agents.huddle", params: { namespace: "team" } },
    { method: "agents.janitor", params: { resourceRef: "arn:x" } },
    { method: "agents.ghost", params: { file: "a.ts" } },
    { method: "agents.glossary", params: { term: "SLO", limit: 5 } },
    { method: "agents.decisions", params: { limit: 3 } },
    { method: "agents.ownership", params: { path: "src/a.ts" } },
  ]);
});

test("absent optionals are omitted and wrong-typed required args degrade to empty string", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = briefClient("s1", "brief");
  const recording = {
    ...client,
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return await client.call<T>(method, params);
    },
  };
  const deps = { getClient: async () => recording };
  // `limit` is not a number and `topicOrFile` is not a string: both degrade rather than crash.
  await specFor("findExpert").run(deps, { topicOrFile: 42, limit: "10" });
  await specFor("getGlossary").run(deps, {});
  await specFor("findOwners").run(deps, {});
  expect(calls[0]?.params).toEqual({ topicOrFile: "" });
  expect(calls[1]?.params).toEqual({});
  // toStrictEqual, not toEqual: this repo's toEqual ignores undefined-valued keys, so
  // { path: undefined } would pass here even if `build` leaked one instead of omitting it.
  expect(calls[2]?.params).toStrictEqual({});
});

// ---------------------------------------------------------------------------
// RPC parameter-contract guard
//
// THIS TABLE MIRRORS `packages/gateway/src/ipc/agents-rpc.ts` BY HAND AND MUST BE UPDATED WITH IT.
// Every entry is the exact key set the corresponding `require*Params` validator reads off the
// params object (`parseNamespaces` contributes `namespace`/`namespaces` to the file/huddle
// validators). Nothing derives it automatically: `packages/cli` may not import gateway source, and
// scanning that file as text from here would reintroduce the same coupling in a weaker form —
// it also could not follow keys read inside a shared helper, so it would fail open on refactors.
//
// The check this table buys is the one the fakes cannot make: fakes echo params back, so a tool
// whose schema names a parameter the gateway never reads passes every behavioural test and then
// gets -32602 (or, worse, is silently ignored) on every real invocation. Three of the ten tools
// shipped that way in the original brief — `explainWhy` (`fileOrPrUrl` vs `ref`), `getCatchup`
// (`since` vs `sinceMs`), `findDecisions` (a `topic` that does not exist).
// ---------------------------------------------------------------------------
const AGENTS_RPC_ACCEPTED_KEYS: ReadonlyArray<{
  readonly tool: string;
  readonly method: string;
  /** Keys the gateway validator reads. Anything else is dropped on the floor. */
  readonly accepted: readonly string[];
  /** Every schema key filled, so `build`'s full output is exercised. */
  readonly args: Record<string, unknown>;
}> = [
  {
    tool: "explainWhy",
    method: "agents.why",
    accepted: ["ref", "line"],
    args: { ref: "src/a.ts", line: 42 },
  },
  {
    tool: "getCatchup",
    method: "agents.catchup",
    accepted: ["sinceMs", "service"],
    args: { sinceMs: 86_400_000, service: "github" },
  },
  {
    tool: "findExpert",
    method: "agents.expert",
    accepted: ["topicOrFile", "limit"],
    args: { topicOrFile: "auth", limit: 5 },
  },
  {
    tool: "assessImpact",
    method: "agents.impact",
    accepted: ["fileOrPrUrl", "depth", "service"],
    args: { fileOrPrUrl: "src/a.ts", depth: 2 },
  },
  {
    tool: "findConflicts",
    method: "agents.conflicts",
    accepted: ["file", "namespace", "namespaces"],
    args: { file: "src/a.ts" },
  },
  {
    tool: "findDecisions",
    method: "agents.decisions",
    accepted: ["sinceMs", "minConfidence", "service", "explain", "limit"],
    args: {
      sinceMs: 86_400_000,
      minConfidence: 0.7,
      service: "github",
      explain: true,
      limit: 5,
    },
  },
  {
    tool: "getGlossary",
    method: "agents.glossary",
    accepted: ["term", "limit"],
    args: { term: "SLO", limit: 5 },
  },
  {
    tool: "checkResourceUsage",
    method: "agents.janitor",
    accepted: ["resourceRef", "idleDays", "cleanupAction", "allowGaps"],
    args: { resourceRef: "arn:aws:s3:::bucket" },
  },
  {
    tool: "getPeerContext",
    method: "agents.ghost",
    accepted: ["file", "namespace", "namespaces"],
    args: { file: "src/a.ts" },
  },
  {
    tool: "getTeamHuddle",
    method: "agents.huddle",
    accepted: ["sinceMs", "namespace", "namespaces"],
    args: { namespace: "team" },
  },
  {
    tool: "findOwners",
    method: "agents.ownership",
    accepted: ["path", "service"],
    args: { path: "src/a.ts", service: "github" },
  },
  {
    // The twelfth `agents.*` caller. It lives in TOOL_SPECS rather than AGENT_TOOL_SPECS, so
    // nothing else in this file can see it — and it shipped with the same `fileOrPrUrl` defect.
    // `agents.whyPeek` is validated by the very same `requireWhyParams` as `agents.why`.
    tool: "peekWhy",
    method: "agents.whyPeek",
    accepted: ["ref", "line"],
    args: { ref: "src/a.ts" },
  },
];

/** Resolve from TOOL_SPECS, which is a superset of AGENT_TOOL_SPECS and also holds `peekWhy`. */
function registeredSpec(name: string) {
  const s = TOOL_SPECS.find((t) => t.name === name);
  if (s === undefined) {
    throw new Error(`no registered tool spec ${name}`);
  }
  return s;
}

test("the contract table covers every registered agents.* caller", () => {
  expect(AGENTS_RPC_ACCEPTED_KEYS.map((r) => r.tool).sort()).toEqual(
    [...AGENT_TOOL_SPECS.map((s) => s.name), "peekWhy"].sort(),
  );
});

test("every tool's SCHEMA names only parameters its gateway validator reads", () => {
  // Static, client-free, and the check that catches the whole bug class: the model fills the
  // schema, so a schema key the validator never reads is a parameter the model can never make
  // count. `explainWhy`'s brief schema (`fileOrPrUrl`) fails here against ["ref", "line"].
  for (const row of AGENTS_RPC_ACCEPTED_KEYS) {
    const schemaKeys = Object.keys(registeredSpec(row.tool).schema);
    const unknownKeys = schemaKeys.filter((k) => !row.accepted.includes(k));
    expect({ tool: row.tool, unknownKeys }).toEqual({ tool: row.tool, unknownKeys: [] });
  }
});

test("every tool's BUILT params reach its own agents.* method with only accepted keys", async () => {
  for (const row of AGENTS_RPC_ACCEPTED_KEYS) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const inner = briefClient("s1", "brief");
    const client = {
      ...inner,
      async call<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        return await inner.call<T>(method, params);
      },
    };
    await registeredSpec(row.tool).run({ getClient: async () => client }, row.args);
    expect(calls[0]?.method).toBe(row.method);
    const sent = Object.keys(calls[0]?.params as Record<string, unknown>);
    const unknownKeys = sent.filter((k) => !row.accepted.includes(k));
    expect({ tool: row.tool, unknownKeys }).toEqual({ tool: row.tool, unknownKeys: [] });
    // `args` is hand-authored, so pin it to the schema first: a future schema key with no `args`
    // entry would otherwise slip past the reaches-the-wire assertion below unexercised.
    expect(Object.keys(row.args).sort()).toEqual(
      Object.keys(registeredSpec(row.tool).schema).sort(),
    );
    // A parameter the model can set must actually reach the wire, or it is decoration.
    expect(sent.sort()).toEqual(Object.keys(row.args).sort());
  }
});
