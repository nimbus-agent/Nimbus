import { describe, expect, test } from "bun:test";

import { CAPTURE_TOOL_SPECS, captureToolsFor } from "./capture-tools.ts";
import type { IpcCallable } from "./client-surface.ts";
import type { AdapterDeps } from "./tool-runtime.ts";

function deps(
  impl: (method: string, params: unknown) => Promise<unknown>,
  extra: Partial<AdapterDeps> = {},
): {
  deps: AdapterDeps;
  calls: Array<[string, unknown]>;
} {
  const calls: Array<[string, unknown]> = [];
  const client: IpcCallable = {
    call: async <T>(m: string, p?: unknown) => {
      calls.push([m, p]);
      return (await impl(m, p)) as T;
    },
    disconnect: async () => {},
  };
  return { calls, deps: { getClient: async () => client, ...extra } };
}

const ENABLED = {
  enabled: true,
  kinds: ["note"],
  pending: 0,
  maxPending: 100,
  maxPerHour: 30,
  refusedSinceStart: {},
};

describe("captureToolsFor", () => {
  test("enabled + note kind → capture_note registered", async () => {
    const { deps: d } = deps(async () => ENABLED);
    expect((await captureToolsFor(d)).map((s) => s.name)).toEqual([
      "capture_note",
      "capture_status",
    ]);
  });

  test.each([
    ["disabled", async () => ({ ...ENABLED, enabled: false, kinds: [], disabledReason: "config" })],
    ["note not in kinds", async () => ({ ...ENABLED, kinds: [] })],
    ["a non-object status", async () => "nope"],
    ["a status without a kinds array", async () => ({ enabled: true })],
    [
      "an old gateway (Method not found)",
      async () => {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      },
    ],
    ["a malformed status", async () => ({ enabled: "yes" })],
  ])("%s → no capture tool", async (_n, impl) => {
    const { deps: d } = deps(impl);
    expect(await captureToolsFor(d)).toEqual([]);
  });

  test("Review Focus 3: gateway DOWN at spawn → no capture tool, and no throw", async () => {
    const d: AdapterDeps = {
      getClient: async () => {
        throw new Error("not running");
      },
    };
    expect(await captureToolsFor(d)).toEqual([]);
  });

  test("declareKind failed (agent tools disabled) → no capture tool: the gateway cannot see us as mcp", async () => {
    const { deps: d, calls } = deps(async () => ENABLED, {
      agentToolsDisabledReason: () => "old gateway",
    });
    expect(await captureToolsFor(d)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("capture_note", () => {
  const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "capture_note");

  test("is annotated as a non-destructive, non-idempotent, closed-world write", () => {
    expect(spec?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("submits kind note with the client label and returns the stored-locally text", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_1", state: "live" }));
    const res = await spec?.run(d, { title: "t", body: "b", tags: ["x"] }, () => "claude-code");
    expect(calls).toEqual([
      [
        "capture.submit",
        {
          kind: "note",
          payload: { title: "t", body: "b", tags: ["x"] },
          clientLabel: "claude-code",
        },
      ],
    ]);
    expect(res?.isError).toBeUndefined();
    expect(res?.content[0]?.text).toContain("Captured note cap_1");
    expect(res?.content[0]?.text).toContain("nimbus captures revoke cap_1");
  });

  test("forwards relatesTo and omits clientLabel when the client sent none", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_2", state: "live" }));
    await spec?.run(d, { title: "t", body: "b", relatesTo: ["github:1"] }, () => undefined);
    expect(calls).toEqual([
      [
        "capture.submit",
        { kind: "note", payload: { title: "t", body: "b", relatesTo: ["github:1"] } },
      ],
    ]);
  });

  test("a gateway reply with no id is an error result, not a fabricated success", async () => {
    const { deps: d } = deps(async () => ({ state: "live" }));
    const res = await spec?.run(d, { title: "t", body: "b" }, () => undefined);
    expect(res?.isError).toBe(true);
  });

  test("a gateway refusal surfaces as an isError result with the code", async () => {
    const { deps: d } = deps(async () => {
      throw new Error("ERR_CAPTURE_RATE_LIMITED: hourly capture cap reached");
    });
    const res = await spec?.run(d, { title: "t", body: "b" }, () => undefined);
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toContain("ERR_CAPTURE_RATE_LIMITED");
  });
});

describe("proposal tools", () => {
  const ALL = { ...ENABLED, kinds: ["note", "decision", "term", "link"] };
  const find = (n: string) => CAPTURE_TOOL_SPECS.find((s) => s.name === n);

  test("all four kinds enabled → all four tools registered", async () => {
    const { deps: d } = deps(async () => ALL);
    expect((await captureToolsFor(d)).map((s) => s.name)).toEqual([
      "capture_note",
      "propose_decision",
      "propose_term",
      "propose_link",
      "capture_status",
    ]);
  });

  test("kinds note+term → exactly capture_note and propose_term", async () => {
    const { deps: d } = deps(async () => ({ ...ALL, kinds: ["note", "term"] }));
    expect((await captureToolsFor(d)).map((s) => s.name)).toEqual([
      "capture_note",
      "propose_term",
      "capture_status",
    ]);
  });

  test("every write spec has all four annotations false; capture_status is read-only", () => {
    for (const s of CAPTURE_TOOL_SPECS.filter((x) => x.kind !== "status")) {
      expect(s.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    expect(find("capture_status")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("propose_decision sends the full payload with decidedAt as ms", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_d1", state: "proposed" }));
    const res = await find("propose_decision")?.run(
      d,
      {
        statement: "s",
        rationale: "r",
        alternatives: ["a"],
        decidedAt: "2026-10-01T00:00:00Z",
        evidence: ["github:1"],
      },
      () => "claude-code",
    );
    expect(calls).toEqual([
      [
        "capture.submit",
        {
          kind: "decision",
          payload: {
            statement: "s",
            rationale: "r",
            alternatives: ["a"],
            evidence: ["github:1"],
            decidedAt: Date.parse("2026-10-01T00:00:00Z"),
          },
          clientLabel: "claude-code",
        },
      ],
    ]);
    expect(res?.content[0]?.text).toBe(
      "Proposed decision cap_d1. It is NOT recorded yet: it appears nowhere until the owner runs `nimbus captures accept cap_d1`. Do not tell the user it has been recorded.",
    );
  });

  test("propose_decision omits absent optionals", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_d2", state: "proposed" }));
    await find("propose_decision")?.run(d, { statement: "s" }, () => undefined);
    expect(calls).toEqual([["capture.submit", { kind: "decision", payload: { statement: "s" } }]]);
  });

  test("an unparseable decidedAt is an error and never reaches the gateway", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_x" }));
    const res = await find("propose_decision")?.run(
      d,
      { statement: "s", decidedAt: "not a date" },
      () => undefined,
    );
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toContain("decidedAt must be an ISO 8601 date");
    expect(calls).toEqual([]);
  });

  test("propose_term submits kind term and says glossary term", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_t1", state: "proposed" }));
    const res = await find("propose_term")?.run(
      d,
      { term: "T", definition: "D", synonyms: ["x"] },
      () => undefined,
    );
    expect(calls).toEqual([
      [
        "capture.submit",
        { kind: "term", payload: { term: "T", definition: "D", synonyms: ["x"] } },
      ],
    ]);
    expect(res?.content[0]?.text).toMatch(
      /^Proposed glossary term cap_t1\. It is NOT recorded yet/,
    );
  });

  test("propose_link submits kind link and says link", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_l1", state: "proposed" }));
    const res = await find("propose_link")?.run(
      d,
      { fromItemId: "a", toItemId: "b", relation: "fixes", note: "n" },
      () => undefined,
    );
    expect(calls).toEqual([
      [
        "capture.submit",
        {
          kind: "link",
          payload: { fromItemId: "a", toItemId: "b", relation: "fixes", note: "n" },
        },
      ],
    ]);
    expect(res?.content[0]?.text).toMatch(/^Proposed link cap_l1\. /);
  });

  test("propose_link relation schema is the five-value enum", () => {
    const rel = find("propose_link")?.schema["relation"] as
      | { safeParse(v: unknown): { success: boolean } }
      | undefined;
    for (const r of ["relates_to", "fixes", "caused_by", "supersedes", "documents"]) {
      expect(rel?.safeParse(r).success).toBe(true);
    }
    expect(rel?.safeParse("blocks").success).toBe(false);
  });

  test("a gateway refusal on a proposal is an isError result", async () => {
    const { deps: d } = deps(async () => {
      throw new Error("ERR_CAPTURE_LINK_UNRESOLVED: nope");
    });
    const res = await find("propose_link")?.run(
      d,
      { fromItemId: "a", toItemId: "b", relation: "fixes" },
      () => undefined,
    );
    expect(res?.isError).toBe(true);
  });
});

function depsWithStatus(status: Record<string, unknown>): AdapterDeps {
  return deps(async (m) => (m === "capture.status" ? status : undefined)).deps;
}

function depsRecording(
  calls: Array<[string, unknown]>,
  answers: Record<string, unknown>,
): AdapterDeps {
  const client: IpcCallable = {
    call: async <T>(m: string, p?: unknown) => {
      calls.push([m, p]);
      return answers[m] as T;
    },
    disconnect: async () => {},
  };
  return { getClient: async () => client };
}

describe("act door tools", () => {
  test("propose_action is absent unless actionEnabled; capture_status present with any kind", async () => {
    const off = await captureToolsFor(
      depsWithStatus({ enabled: true, kinds: ["note"], actionEnabled: false }),
    );
    expect(off.map((t) => t.name)).toEqual(["capture_note", "capture_status"]);
    const on = await captureToolsFor(
      depsWithStatus({
        enabled: true,
        kinds: ["note", "action"],
        actionEnabled: true,
        proposableActionTypes: ["jira.issue.create", "slack.message.post"],
      }),
    );
    expect(on.map((t) => t.name)).toEqual(["capture_note", "propose_action", "capture_status"]);
    expect(on.find((t) => t.name === "propose_action")?.description).toContain(
      "jira.issue.create, slack.message.post",
    );
  });

  test("action in kinds but actionEnabled false (e.g. policy mcp_action) → no propose_action", async () => {
    const t = await captureToolsFor(
      depsWithStatus({ enabled: true, kinds: ["action"], actionEnabled: false }),
    );
    expect(t.map((x) => x.name)).toEqual(["capture_status"]);
  });

  test("actionEnabled with no proposable types says so", async () => {
    const t = await captureToolsFor(
      depsWithStatus({
        enabled: true,
        kinds: ["action"],
        actionEnabled: true,
        proposableActionTypes: [7],
      }),
    );
    expect(t.find((x) => x.name === "propose_action")?.description).toEndWith("(none configured).");
  });

  test("sink off: no tools at all", async () => {
    expect(await captureToolsFor(depsWithStatus({ enabled: false, kinds: [] }))).toEqual([]);
  });

  test("propose_action submits {actionType, input, summary} and says it has NOT run", async () => {
    const calls: Array<[string, unknown]> = [];
    const d = depsRecording(calls, {
      "capture.submit": { id: "cap_1", state: "proposed", expiresAt: 0 },
    });
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "propose_action");
    const out = await spec?.run(
      d,
      { actionType: "slack.message.post", input: { text: "hi" }, summary: "why" },
      () => "agent",
    );
    expect(calls[0]).toEqual([
      "capture.submit",
      {
        kind: "action",
        payload: { actionType: "slack.message.post", input: { text: "hi" }, summary: "why" },
        clientLabel: "agent",
      },
    ]);
    expect(out?.content[0]?.text).toContain("has NOT run");
    expect(out?.content[0]?.text).toContain("1970-01-01T00:00:00.000Z");
  });

  test("propose_action without an expiresAt names the TTL rather than inventing a time", async () => {
    const d = depsRecording([], { "capture.submit": { id: "cap_2", state: "proposed" } });
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "propose_action");
    const out = await spec?.run(
      d,
      { actionType: "slack.message.post", input: {}, summary: "s" },
      () => undefined,
    );
    expect(out?.content[0]?.text).toContain("expires its TTL");
  });

  test("capture_status returns the state JSON", async () => {
    const d = depsRecording([], {
      "capture.state": { kind: "action", state: "executed", outcomeRef: "https://x" },
    });
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "capture_status");
    const out = await spec?.run(d, { id: "cap_1" }, () => undefined);
    expect(JSON.parse(out?.content[0]?.text ?? "{}")).toEqual({
      kind: "action",
      state: "executed",
      outcomeRef: "https://x",
    });
  });
});
