// Phase 28 AD3a-1: `nimbus connector writes ... --door agent` (the owner's approval list for outside
// agents). The fake `call` seam also records the call options (the person-only connection).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  type ConnectorWritesDeps,
  makeConnectorWritesCall,
  runConnectorWrites,
} from "./connector-writes-cli.ts";

function harness(reply: unknown) {
  const calls: Array<{
    method: string;
    params?: Record<string, unknown> | undefined;
    opts?: unknown;
  }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: ConnectorWritesDeps = {
    call: async (method, params, opts) => {
      calls.push({ method, params, opts });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  };
  return { deps, calls, logs, errors };
}

let savedExit: typeof process.exitCode;
beforeEach(() => {
  savedExit = process.exitCode;
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe("connector writes enable --door agent", () => {
  it("sends only service, door, wave and approve, asks for the person-only connection and prints the record", async () => {
    const h = harness({
      service: "github",
      door: "agent",
      maxWave: 4,
      approved: 2,
      writes: [
        { toolId: "github_pr_close", sha12: "0123456789ab" },
        { toolId: "github_issue_create", sha12: "ba9876543210" },
      ],
    });
    await runConnectorWrites(
      [
        "enable",
        "github",
        "--door",
        "agent",
        "--wave",
        "4",
        "--approve",
        "github_pr_*",
        "--approve",
        "github_issue_create",
      ],
      h.deps,
    );
    expect(h.calls).toEqual([
      {
        method: "connector.writesEnable",
        params: {
          service: "github",
          door: "agent",
          wave: 4,
          approve: ["github_pr_*", "github_issue_create"],
        },
        opts: { agentDoor: true },
      },
    ]);
    expect(h.logs).toEqual([
      "Approved: 2 writes approved for outside agents on github (shared wave 4).",
      "  github_pr_close  0123456789ab",
      "  github_issue_create  ba9876543210",
    ]);
    expect(process.exitCode).toBe(0);
  });

  it("omits wave and approve when not given; --door model is the model form and passes no options", async () => {
    const h = harness({ service: "github", door: "agent", maxWave: 3, approved: 0, writes: [] });
    await runConnectorWrites(["enable", "github", "--door", "agent"], h.deps);
    expect(h.calls[0]?.params).toEqual({ service: "github", door: "agent" });
    const m = harness({ service: "github", maxWave: 3, writes: 1 });
    await runConnectorWrites(["enable", "github", "--door", "model"], m.deps);
    expect(m.calls[0]?.params).toEqual({ service: "github" });
    expect(m.calls[0]?.opts).toBeUndefined();
  });

  const bad: string[][] = [
    ["enable", "github", "--door"],
    ["enable", "github", "--door", "robot"],
    ["enable", "github", "--approve", "x"],
    ["enable", "github", "--door", "model", "--approve", "x"],
    ["enable", "github", "--door", "agent", "--approve"],
    ["enable", "iac", "--door", "agent", "--workdir", "/a"],
    ["enable", "iac", "--door", "agent", "--cloud", "aws"],
    ["enable", "kubernetes", "--door", "agent", "--grant", "ns@ctx"],
    ["enable", "github", "--door", "agent", "--door", "agent"],
  ];
  for (const args of bad) {
    it(`exits 2 with usage and no RPC for ${args.join(" ")}`, async () => {
      const h = harness({});
      await runConnectorWrites(args, h.deps);
      expect(h.calls).toEqual([]);
      expect(h.errors[0]).toContain("--door agent");
      expect(process.exitCode).toBe(2);
    });
  }

  it("iac and kubernetes take --door agent without a scope", async () => {
    const h = harness({ service: "iac", door: "agent", maxWave: 4, approved: 1, writes: [] });
    await runConnectorWrites(["enable", "iac", "--door", "agent", "--wave", "4"], h.deps);
    expect(h.calls[0]?.params).toEqual({ service: "iac", door: "agent", wave: 4 });
    const k = harness({
      service: "kubernetes",
      door: "agent",
      maxWave: 4,
      approved: 1,
      writes: [],
    });
    await runConnectorWrites(["enable", "kubernetes", "--door", "agent", "--wave", "4"], k.deps);
    expect(k.calls[0]?.params).toEqual({ service: "kubernetes", door: "agent", wave: 4 });
  });

  const refusals = [
    ["ERR_CONNECTOR_WRITES_AGENT_CLIENT", "terminal"],
    ["ERR_CONNECTOR_WRITES_AGENT_SCOPE", "directory"],
    ["ERR_CONNECTOR_WRITES_AGENT_UNLISTED", "connect it first"],
    ["ERR_CONNECTOR_WRITES_AGENT_NO_MATCH", "--approve"],
    ["ERR_CONNECTOR_WRITES_AGENT_NOTHING", "nothing"],
    ["ERR_CONNECTOR_WRITES_BAD_DOOR", "--door"],
    ["ERR_CONNECTOR_WRITES_BAD_APPROVE", "--approve"],
  ] as const;
  for (const [code, text] of refusals) {
    it(`maps ${code} to one line and exit 2`, async () => {
      const h = harness(new Error(`${code}: whatever`));
      await runConnectorWrites(["enable", "github", "--door", "agent"], h.deps);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]?.toLowerCase()).toContain(text.toLowerCase());
      expect(process.exitCode).toBe(2);
    });
  }

  it("names both lockoffs when the agent door is refused by policy, and only the model one on the model door", async () => {
    const agent = harness(new Error("ERR_CONNECTOR_WRITES_POLICY: org policy"));
    await runConnectorWrites(["enable", "github", "--door", "agent"], agent.deps);
    expect(agent.errors).toHaveLength(1);
    expect(agent.errors[0]).toContain("connector_write_model_access or mcp_action");
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    const agentOff = harness(new Error("ERR_CONNECTOR_WRITES_POLICY: org policy"));
    await runConnectorWrites(["disable", "github", "--door", "agent"], agentOff.deps);
    expect(agentOff.errors[0]).toContain("connector_write_model_access or mcp_action");
    process.exitCode = 0;
    const model = harness(new Error("ERR_CONNECTOR_WRITES_POLICY: org policy"));
    await runConnectorWrites(["enable", "github"], model.deps);
    expect(model.errors).toHaveLength(1);
    expect(model.errors[0]).toContain("(connector_write_model_access)");
    expect(model.errors[0]).not.toContain("mcp_action");
    expect(process.exitCode).toBe(2);
  });

  it("says a non-person answer cannot approve", async () => {
    const h = harness(
      new Error(
        "ERR_CONNECTOR_WRITES_DECLINED: the approval did not come from a person at a terminal (--yes, a script and an old client cannot approve); nothing was enabled",
      ),
    );
    await runConnectorWrites(["enable", "github", "--door", "agent"], h.deps);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("person");
    expect(process.exitCode).toBe(2);
  });
});

describe("connector writes disable --door agent", () => {
  it("sends the door and reports; a plain disable does not send it", async () => {
    const a = harness({ removed: true });
    await runConnectorWrites(["disable", "github", "--door", "agent"], a.deps);
    expect(a.calls[0]).toEqual({
      method: "connector.writesDisable",
      params: { service: "github", door: "agent" },
      opts: undefined,
    });
    expect(a.logs).toEqual(["Agent writes disabled for github."]);
    const none = harness({ removed: false });
    await runConnectorWrites(["disable", "github", "--door", "agent"], none.deps);
    expect(none.logs).toEqual(["Agent writes were not enabled for github."]);
    const p = harness({ removed: true });
    await runConnectorWrites(["disable", "github"], p.deps);
    expect(p.calls[0]?.params).toEqual({ service: "github" });
  });

  it("exits 2 for a missing or unknown door value", async () => {
    for (const args of [
      ["disable", "github", "--door"],
      ["disable", "github", "--door", "robot"],
      ["disable", "github", "--door", "model"],
    ]) {
      const b = harness({});
      await runConnectorWrites(args, b.deps);
      expect(b.calls).toEqual([]);
      expect(process.exitCode).toBe(2);
    }
  });
});

describe("connector writes status with the agent member", () => {
  const ESC = String.fromCodePoint(0x1b);
  const status = {
    services: [
      { service: "github", enabled: true, maxWave: 3, writes: 9, offerable: 0 },
      { service: "jira", enabled: false, writes: 4, offerable: 0 },
      { service: "slack", enabled: false, writes: 2, offerable: 0 },
    ],
    policyAllows: true,
    agent: {
      policyAllows: true,
      services: [
        {
          service: "github",
          approved: 5,
          suspended: [
            {
              toolId: `github_pr${ESC}[2Jclose`,
              approvedAt: Date.UTC(2026, 10, 13),
              approvedSha12: "0123456789ab",
              nowSha12: "ba9876543210",
            },
            {
              toolId: "github_gone",
              approvedAt: Date.UTC(2026, 10, 1),
              approvedSha12: "aaaaaaaaaaaa",
              nowSha12: null,
              reason: "no longer listed",
            },
          ],
        },
        {
          service: "jira",
          approved: 1,
          suspended: [],
          unverified: "its tools could not be listed",
        },
      ],
    },
  };

  it("prints the agent lines, a suspended line with both prefixes and the date and the agent policy", async () => {
    const h = harness(status);
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toEqual([
      "github  shared wave 3  9 writes, none approved for the model",
      "  agents: 5 approved",
      "  suspended: github_pr[2Jclose definition changed since approved 2026-11-13 (approved 0123456789ab, now ba9876543210)",
      "  suspended: github_gone no longer listed since approved 2026-11-01 (approved aaaaaaaaaaaa)",
      "jira    off",
      "  agents: 1 approved (unverified: its tools could not be listed)",
      "slack   off",
      "Policy: allows",
      "Agent policy: allows",
    ]);
    expect(h.logs.join("\n")).not.toContain(ESC);
  });

  it("prints the hint while nothing is approved, and a forbidding agent policy", async () => {
    const hint =
      "To approve connector writes for outside agents, run: nimbus connector writes enable <service> --door agent";
    const h = harness({
      services: [],
      policyAllows: true,
      agent: { policyAllows: false, hint, services: [] },
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toEqual([
      hint,
      "Policy: allows",
      "Agent policy: forbids (connector_write_model_access or mcp_action)",
    ]);
  });

  it("--json prints the raw reply, agent member included", async () => {
    const h = harness(status);
    await runConnectorWrites(["status", "--json"], h.deps);
    expect(JSON.parse(h.logs.join("\n")).agent.services).toHaveLength(2);
  });
});

describe("the default call seam", () => {
  it("an agent enable declares the cli kind first and uses the person-only consent choice", async () => {
    const order: string[] = [];
    let seen: Record<string, unknown> | undefined;
    const withIpc = (async (
      fn: (c: { call: (m: string) => Promise<unknown> }) => Promise<unknown>,
      _paths: unknown,
      opts: Record<string, unknown>,
    ) => {
      seen = opts;
      return fn({
        call: async (m: string) => {
          order.push(m);
          return {};
        },
      });
    }) as never;
    const call = makeConnectorWritesCall(withIpc);
    await call("connector.writesEnable", { service: "github", door: "agent" }, { agentDoor: true });
    expect(order).toEqual(["session.declareKind", "connector.writesEnable"]);
    expect(seen?.["consent"]).toEqual({ kind: "human" });
    order.length = 0;
    await call("connector.writesEnable", { service: "github" });
    expect(order).toEqual(["connector.writesEnable"]);
    expect(seen?.["consent"]).toBeUndefined();
    order.length = 0;
    await call("connector.writesStatus", {});
    expect(order).toEqual(["connector.writesStatus"]);
  });
});

describe("AD3a-2a status additions", () => {
  const CMD = "To keep them working run: nimbus connector writes enable <service> --door agent";

  it("the model line is unchanged when something is approved for the model", async () => {
    const h = harness({
      services: [{ service: "jira", enabled: true, maxWave: 2, writes: 3, offerable: 2 }],
      policyAllows: true,
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs[0]).toBe("jira  enabled  wave 2  3 writes, 2 offerable now");
  });

  it("status declares cli first so the gateway runs the live check", async () => {
    const h = harness({ services: [], policyAllows: true });
    await runConnectorWrites(["status"], h.deps);
    expect(h.calls[0]?.opts).toEqual({ declareCli: true });
  });

  it("the default seam declares cli before a status call and not before another call", async () => {
    const order: string[] = [];
    const withIpc = (async (
      fn: (c: { call: (m: string) => Promise<unknown> }) => Promise<unknown>,
    ) =>
      fn({
        call: async (m: string) => {
          order.push(m);
          return {};
        },
      })) as never;
    const call = makeConnectorWritesCall(withIpc);
    await call("connector.writesStatus", {}, { declareCli: true });
    expect(order).toEqual(["session.declareKind", "connector.writesStatus"]);
  });

  it("an approved tool the listing omits reads 'not listed now'", async () => {
    const h = harness({
      services: [{ service: "github", enabled: true, maxWave: 3, writes: 9, offerable: 0 }],
      policyAllows: true,
      agent: {
        policyAllows: true,
        checked: true,
        legacy: null,
        services: [
          { service: "github", approved: 3, suspended: [], notListed: ["github_a", "github_b"] },
        ],
      },
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toContain("  not listed now: github_a, github_b");
  });

  it("the legacy line gives the count, the types and the command; nothing when null or zero", async () => {
    const withLegacy = harness({
      services: [],
      policyAllows: true,
      agent: {
        policyAllows: true,
        legacy: {
          sinceMs: 0,
          total: 3,
          byType: { "slack.message.post": 2, "github.issue.create": 1 },
          notice: "n",
        },
        services: [],
      },
    });
    await runConnectorWrites(["status"], withLegacy.deps);
    expect(withLegacy.logs).toContain(
      "legacy: 3 proposals in the last 30 days would be refused (github.issue.create x1, slack.message.post x2)",
    );
    expect(withLegacy.logs).toContain(CMD);
    for (const legacy of [null, { total: 0, byType: {} }]) {
      const none = harness({
        services: [],
        policyAllows: true,
        agent: { policyAllows: true, legacy, services: [] },
      });
      await runConnectorWrites(["status"], none.deps);
      expect(none.logs.join("\n")).not.toContain("legacy:");
    }
  });

  it("the policy warning names the lockoff, with control characters stripped", async () => {
    const esc = String.fromCodePoint(0x1b);
    const h = harness({
      services: [],
      policyAllows: true,
      agent: {
        policyAllows: false,
        lockedOff: ["mcp_action", `connector_write_model_access${esc}[2J`],
        services: [],
      },
    });
    await runConnectorWrites(["status"], h.deps);
    const line = h.logs.find((l) => l.startsWith("Agent policy:")) ?? "";
    expect(line).toContain("mcp_action and connector_write_model_access");
    expect(line).not.toContain(esc);
  });

  it("a status that was not re-checked says so", async () => {
    const h = harness({
      services: [],
      policyAllows: true,
      agent: { policyAllows: true, checked: false, services: [] },
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs.join("\n")).toContain("not re-checked");
  });
});
