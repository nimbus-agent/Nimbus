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
    for (const s of CAPTURE_TOOL_SPECS.filter(
      (x) => x.kind !== "status" && x.kind !== "describe",
    )) {
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

  test("capture_status says the gateway answers only for captures submitted on this connection", () => {
    const d = find("capture_status")?.description ?? "";
    expect(d).toContain("answers only for captures submitted on this connection");
    expect(d).not.toContain("ANY capture id");
    expect(d).not.toContain("does not check who submitted it");
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
    expect(on.map((t) => t.name)).toEqual([
      "capture_note",
      "propose_action",
      "describe_actions",
      "capture_status",
    ]);
    // The type list moved to describe_actions: propose_action's text carries no list (AD3a-2b).
    const proposeText = on.find((t) => t.name === "propose_action")?.description ?? "";
    expect(proposeText).not.toContain("jira.issue.create");
    expect(proposeText).not.toContain("slack.message.post");
  });

  test("action in kinds but actionEnabled false (e.g. policy mcp_action) → no propose_action", async () => {
    const t = await captureToolsFor(
      depsWithStatus({ enabled: true, kinds: ["action"], actionEnabled: false }),
    );
    expect(t.map((x) => x.name)).toEqual(["capture_status"]);
  });

  test("actionEnabled registers propose_action and describe_actions whatever the status lists (AD3a-2b)", async () => {
    const t = await captureToolsFor(
      depsWithStatus({
        enabled: true,
        kinds: ["action"],
        actionEnabled: true,
        proposableActionTypes: [7],
      }),
    );
    expect(t.map((x) => x.name)).toEqual(["propose_action", "describe_actions", "capture_status"]);
    expect(t.find((x) => x.name === "propose_action")?.description).not.toContain(
      "(none configured)",
    );
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
    // The owner approves an action in one step with `nimbus approvals <id>` (agent door AD2).
    expect(out?.content[0]?.text).toContain("`nimbus approvals cap_1`");
    expect(out?.content[0]?.text).not.toContain("captures accept");
  });

  test("the propose_action description names nimbus approvals, not captures accept", () => {
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "propose_action");
    expect(spec?.description).toContain("`nimbus approvals <id>`");
    expect(spec?.description).not.toContain("captures accept");
  });

  test("the propose_action description points to describe_actions and appends no type list (AD3a-2b)", async () => {
    const t = await captureToolsFor(
      depsWithStatus({
        enabled: true,
        kinds: ["action"],
        actionEnabled: true,
        proposableActionTypes: ["github.pr.merge", "slack.message.post"],
      }),
    );
    const d = t.find((x) => x.name === "propose_action")?.description ?? "";
    expect(d).not.toContain("send an email");
    expect(d).toContain("describe_actions");
    expect(d).toContain("approved for outside agents");
    expect(d).toContain("Deprecated");
    expect(d).toContain("only a fixed code");
    expect(d).not.toContain("github.pr.merge");
    expect(d).not.toContain("Accepted action types on this machine");
    expect(d).toEndWith(".");
  });

  test("capture_status says a rejected action may carry a code (AD3a-2a)", () => {
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "capture_status");
    expect(spec?.description).toContain("errorCode");
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

describe("describe_actions (AD3a-2b)", () => {
  const spec = () => CAPTURE_TOOL_SPECS.find((s) => s.name === "describe_actions");

  test("is registered only with the act door and is read-only", async () => {
    expect(spec()?.kind).toBe("describe");
    expect(spec()?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    const off = await captureToolsFor(
      depsWithStatus({ enabled: true, kinds: ["note", "action"], actionEnabled: false }),
    );
    expect(off.map((t) => t.name)).not.toContain("describe_actions");
  });

  test("with no arguments it sends an empty object, and actionTypes is passed through untouched", async () => {
    const calls: Array<[string, unknown]> = [];
    const d = depsRecording(calls, { "capture.describe": { actions: [], truncated: false } });
    await spec()?.run(d, {}, () => "agent");
    await spec()?.run(d, { actionTypes: ["github.pr.merge", "x".repeat(300)] }, () => "agent");
    expect(calls).toEqual([
      ["capture.describe", {}],
      ["capture.describe", { actionTypes: ["github.pr.merge", "x".repeat(300)] }],
    ]);
  });

  test("the result is one text block holding the reply's JSON, not wrapped in an I11 envelope", async () => {
    const reply = {
      actions: [{ actionType: "github.pr.merge", state: "approved", wave: 4 }],
      truncated: false,
    };
    const d = depsRecording([], { "capture.describe": reply });
    const out = await spec()?.run(d, {}, () => undefined);
    expect(out?.content).toHaveLength(1);
    expect(out?.content[0]?.type).toBe("text");
    expect(JSON.parse(out?.content[0]?.text ?? "null")).toEqual(reply);
    expect(out?.content[0]?.text).not.toContain("<tool_output");
    expect(out).not.toHaveProperty("structuredContent");
  });

  test("a gateway refusal is an isError result carrying the code", async () => {
    const { deps: d } = deps(async () => {
      throw new Error("ERR_CAPTURE_RATE_LIMITED: too many describe attempts this hour");
    });
    const out = await spec()?.run(d, {}, () => undefined);
    expect(out?.isError).toBe(true);
    expect(out?.content[0]?.text).toContain("ERR_CAPTURE_RATE_LIMITED");
  });

  test("its description says what the reply holds and what describing can do", () => {
    const d = spec()?.description ?? "";
    expect(d).toContain("actionTypes");
    expect(d).toContain("input schema");
    expect(d).toContain("start");
    expect(d).toContain("registered");
    // It must not claim to be free of effects: describing can start a connector and record a suspension.
    expect(d).not.toContain("Read only");
    expect(d).toContain("proposes and dispatches nothing");
    expect(d).toContain("suspended");
    // It says no reason for not_proposable, and claims nothing about registration status.
    expect(d).toContain("does not say why");
  });

  test("readOnlyHint matches capture_status and means proposes-and-dispatches-nothing", () => {
    const status = CAPTURE_TOOL_SPECS.find((s) => s.name === "capture_status");
    expect(status?.annotations.readOnlyHint).toBe(true);
    expect(spec()?.annotations.readOnlyHint).toBe(true);
  });
});

describe("propose_action deprecation line (AD3a-2a)", () => {
  test("a legacy reply's deprecation is printed after the NOT-run sentence, control characters stripped", async () => {
    const esc = String.fromCodePoint(0x1b);
    const d = depsRecording([], {
      "capture.submit": {
        id: "cap_9",
        state: "proposed",
        expiresAt: 0,
        legacy: true,
        deprecation: `Deprecated: x${esc}[2J accepted for now`,
      },
    });
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "propose_action");
    const out = await spec?.run(d, { actionType: "a.b", input: {}, summary: "s" }, () => undefined);
    const text = out?.content[0]?.text ?? "";
    expect(text.indexOf("Deprecated: x")).toBeGreaterThan(text.indexOf("has NOT run"));
    expect(text).not.toContain(esc);
  });

  test("an approved proposal's result is unchanged", async () => {
    const d = depsRecording([], {
      "capture.submit": { id: "cap_9", state: "proposed", expiresAt: 0 },
    });
    const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "propose_action");
    const out = await spec?.run(d, { actionType: "a.b", input: {}, summary: "s" }, () => undefined);
    expect(out?.content[0]?.text).not.toContain("Deprecated");
  });
});
