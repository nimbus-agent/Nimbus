// Phase 28 AD5a, Tasks 9 and 11 (the flip): `connector.writesEnable|writesStatus` with `door: "agent"`
// for a user-registered MCP server (`mcp_<id>`). Real in-memory SQLite through the migration runner, a
// real gate-only `ToolExecutor` around a fake consent coordinator wrapped exactly as the dispatcher wraps
// it, and an injected lister (no real third-party server is started). One test per step of D-4, each
// asserting that no later step ran.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { definitionSha256 } from "../connectors/connector-writes/definition-hash.ts";
import {
  getDoorApproval,
  listDoorApprovals,
  markDoorToolSuspended,
  upsertDoorApprovals,
} from "../connectors/connector-writes/door-approval-store.ts";
import { enableWritesPromptLines } from "../connectors/connector-writes/enable-prompt.ts";
import {
  getModelWriteEnablement,
  listModelWriteEnablement,
} from "../connectors/connector-writes/enablement-store.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { insertUserMcpConnector } from "../connectors/user-mcp-store.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import type { AnswerSource } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import { handleAgentWritesStatus } from "./connector-rpc-handlers/agent-writes.ts";
import {
  handleConnectorWritesDisable,
  handleConnectorWritesEnable,
  type ModelWritesDeps,
} from "./connector-rpc-handlers/model-writes.ts";
import { type ConsentCoordinator, humanOnlyConsent } from "./consent.ts";
import type { ClientKind } from "./server/client-kind.ts";

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

class FakeConsent implements ConsentCoordinator {
  prompts: string[] = [];
  requests = 0;
  approved = true;
  source: AnswerSource = "human";
  onRequest: (() => void) | undefined;
  requestConsent(_c: string, p: { prompt: string }) {
    this.requests++;
    this.prompts.push(p.prompt);
    this.onRequest?.();
    return Promise.resolve({ approved: this.approved, answerSource: this.source });
  }
  requestConfirmedConsent(_c: string, p: { prompt: string }) {
    this.requests++;
    this.prompts.push(p.prompt);
    return Promise.resolve({ approved: this.approved, typed: "", answerSource: this.source });
  }
  rejectAllPending(): void {}
  pendingCount(): number {
    return 0;
  }
}

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  register();
});
afterEach(() => db.close());

const REGISTERED_AT = Date.UTC(2026, 10, 1);

function register(over: { createdAt?: number; model?: boolean } = {}): void {
  insertUserMcpConnector(db, {
    service_id: "mcp_notes",
    command: "srv",
    args_json: "[]",
    read_paths_json: JSON.stringify(["/data/notes"]),
    net_hosts_json: JSON.stringify(["api.example.com:443"]),
    model_access: over.model === true ? 1 : 0,
    created_at: over.createdAt ?? REGISTERED_AT,
  });
}

function entryOf(description: string, schema?: Record<string, unknown>): unknown {
  return {
    description,
    inputSchema: toStandardSchema(
      (schema ?? { type: "object", properties: { text: { type: "string" } } }) as JsonSchemaInput,
    ),
  };
}

const key = (tool: string) => mcpClientToolKey("mcp_notes", tool);

function listingOf(
  tools: Record<string, string> = { append: "adds a note", read: "reads a note" },
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(tools).map(([t, d]) => [key(t), entryOf(d)]));
}

type Policy = { capabilitiesDisabled: ReadonlySet<string> };
const OPEN: Policy = { capabilitiesDisabled: new Set<string>() };

interface Rig {
  readonly consent: FakeConsent;
  readonly listCalls: string[];
  deps: ModelWritesDeps;
  listing: Record<string, unknown> | undefined | "throw";
  nonHuman: boolean;
}

function rig(
  over: { kind?: ClientKind; policy?: Policy | undefined; noExecutor?: boolean } = {},
): Rig {
  const consent = new FakeConsent();
  const r: Rig = {
    consent,
    listCalls: [],
    listing: listingOf(),
    nonHuman: false,
    deps: undefined as never,
  };
  const wrapped = humanOnlyConsent(consent, () => {
    r.nonHuman = true;
  });
  const exec = new ToolExecutor(
    bindConsentChannel(wrapped, "c1"),
    localIndex,
    { dispatch: async () => ({}) },
    undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
  r.deps = {
    db,
    toolExecutor: over.noExecutor === true ? undefined : exec,
    getEnforcedPolicy: () => ("policy" in over ? over.policy : OPEN),
    now: () => 1_000,
    listServerTools: async () => {
      throw new Error("a user MCP enable must not use the first-party lister");
    },
    listUserMcpDefinitions: async (serviceId: string) => {
      r.listCalls.push(serviceId);
      if (r.listing === "throw") throw new Error("boom");
      return r.listing;
    },
    userMcpNetworkNote: () => "this system limits the port, not the host",
    clientKind: over.kind ?? "cli",
    agentAnswerWasNonHuman: () => r.nonHuman,
  } as ModelWritesDeps;
  return r;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

const AGENT = { door: "agent", service: "mcp_notes" } as const;

function auditCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
}

describe("user MCP agent enable: the order of the refusals (D-4), none starts the server before its turn", () => {
  const cases: Array<{
    name: string;
    kind?: ClientKind;
    policy?: Policy | undefined;
    rec: Record<string, unknown>;
    code: string;
    listCalls: number;
  }> = [
    {
      name: "1. an mcp connection",
      kind: "mcp",
      rec: { ...AGENT, approve: ["append"] },
      code: "ERR_CONNECTOR_WRITES_AGENT_CLIENT",
      listCalls: 0,
    },
    {
      name: "1. an unknown connection",
      kind: "unknown",
      rec: { ...AGENT, approve: ["append"] },
      code: "ERR_CONNECTOR_WRITES_AGENT_CLIENT",
      listCalls: 0,
    },
    {
      name: "2. a wave",
      rec: { ...AGENT, approve: ["append"], wave: 3 },
      code: "ERR_CONNECTOR_WRITES_AGENT_USER_MCP_WAVE",
      listCalls: 0,
    },
    {
      name: "2. a scope parameter",
      rec: { ...AGENT, approve: ["append"], workdirs: ["/x"] },
      code: "ERR_CONNECTOR_WRITES_AGENT_SCOPE",
      listCalls: 0,
    },
    {
      name: "2. a prefix pattern",
      rec: { ...AGENT, approve: ["app*"] },
      code: "ERR_CONNECTOR_WRITES_BAD_APPROVE",
      listCalls: 0,
    },
    {
      name: "2. a name with a dot",
      rec: { ...AGENT, approve: ["a.b"] },
      code: "ERR_CONNECTOR_WRITES_BAD_APPROVE",
      listCalls: 0,
    },
    {
      name: "2. an empty list",
      rec: { ...AGENT, approve: [] },
      code: "ERR_CONNECTOR_WRITES_BAD_APPROVE",
      listCalls: 0,
    },
    {
      name: "3. an unregistered server",
      rec: { door: "agent", service: "mcp_gone", approve: ["append"] },
      code: "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE",
      listCalls: 0,
    },
    {
      name: "4. mcp_action locked off",
      policy: { capabilitiesDisabled: new Set(["mcp_action"]) },
      rec: { ...AGENT, approve: ["append"] },
      code: "ERR_CONNECTOR_WRITES_POLICY",
      listCalls: 0,
    },
    {
      name: "4. user_mcp_model_access locked off",
      policy: { capabilitiesDisabled: new Set(["user_mcp_model_access"]) },
      rec: { ...AGENT, approve: ["append"] },
      code: "ERR_CONNECTOR_WRITES_POLICY",
      listCalls: 0,
    },
    {
      name: "4. an unreadable policy",
      policy: undefined,
      rec: { ...AGENT, approve: ["append"] },
      code: "ERR_CONNECTOR_WRITES_POLICY",
      listCalls: 0,
    },
    {
      name: "6. a tool the server does not list",
      rec: { ...AGENT, approve: ["nope"] },
      code: "ERR_CONNECTOR_WRITES_AGENT_NO_MATCH",
      listCalls: 1,
    },
    {
      name: "6. one listed and one not",
      rec: { ...AGENT, approve: ["append", "nope"] },
      code: "ERR_CONNECTOR_WRITES_AGENT_NO_MATCH",
      listCalls: 1,
    },
  ];
  for (const c of cases) {
    test(`${c.name} is refused with ${c.code}, listing ${String(c.listCalls)}x, no prompt, nothing written`, async () => {
      const r = rig({
        ...(c.kind === undefined ? {} : { kind: c.kind }),
        ...("policy" in c ? { policy: c.policy } : {}),
      });
      const before = auditCount();
      const msg = await refusal(handleConnectorWritesEnable(c.rec, r.deps));
      expect(msg).toContain(c.code);
      expect(r.listCalls).toHaveLength(c.listCalls);
      expect(r.consent.requests).toBe(0);
      expect(listDoorApprovals(db, "agent")).toEqual([]);
      expect(auditCount()).toBe(before);
    });
  }

  test("a server that cannot be listed (undefined, empty, or throwing) is refused before any prompt", async () => {
    for (const listing of [undefined, "throw" as const]) {
      const r = rig();
      r.listing = listing;
      const msg = await refusal(
        handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps),
      );
      expect(msg).toContain("ERR_CONNECTOR_WRITES_AGENT_UNLISTED");
      expect(r.consent.requests).toBe(0);
    }
  });

  test("a tool that is listed but whose schema cannot be read cannot be approved", async () => {
    const r = rig();
    r.listing = { [key("bad")]: { description: "x", inputSchema: "not a schema" } };
    const msg = await refusal(handleConnectorWritesEnable({ ...AGENT, approve: ["bad"] }, r.deps));
    expect(msg).toContain("ERR_CONNECTOR_WRITES_AGENT_NO_MATCH");
    expect(r.consent.requests).toBe(0);
  });

  test("a door of 'model' or none for an mcp_ id is not a user-MCP enable: it is refused as no connector writes", async () => {
    const r = rig();
    const msg = await refusal(
      handleConnectorWritesEnable({ service: "mcp_notes", wave: 3 }, r.deps),
    );
    expect(msg).toContain("ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE");
    expect(r.listCalls).toEqual([]);
    expect(r.consent.requests).toBe(0);
  });
});

describe("user MCP agent enable: the owner's gate and the write", () => {
  test("approves the named tool: the prompt, the stored row at the real hash, the reply, and NO shared wave row", async () => {
    const r = rig();
    const out = await handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps);
    const sha = definitionSha256("append", entryOf("adds a note")) as string;
    expect(out).toEqual({
      service: "mcp_notes",
      door: "agent",
      listOnly: false,
      approved: 1,
      writes: [{ toolId: "append", sha12: sha.slice(0, 12) }],
    });
    expect(listDoorApprovals(db, "agent", "mcp_notes")).toEqual([
      {
        service: "mcp_notes",
        door: "agent",
        toolId: "append",
        approvedAt: 1_000,
        definitionSha256: sha,
        suspendedAt: null,
        suspendedSha256: null,
      },
    ]);
    // The shared wave row (the model door's) is never created for an mcp_ id.
    expect(getModelWriteEnablement(db, "mcp_notes")).toBeUndefined();
    expect(listModelWriteEnablement(db)).toEqual([]);
    expect(r.consent.prompts).toHaveLength(1);
    expect(r.listCalls).toEqual(["mcp_notes"]);
    expect(r.consent.prompts[0]).toBe(
      [
        "Action requires your approval",
        "",
        "Type: connector.writes.enable",
        "",
        "Service: mcp_notes",
        "Door: outside agents (MCP)",
        "Third-party code you registered on 2026-11-01T00:00:00.000Z",
        "Sandbox reach:",
        "  read: /data/notes",
        "  net: api.example.com:443",
        "  net note: this system limits the port, not the host",
        "  write: none beyond its own sandbox directory",
        "Also registered for your own model (--model, a separate grant): no",
        "Tools to approve for outside agents (exact names, first 12 characters of each definition hash):",
        `  append  will be approved  ${sha.slice(0, 12)}`,
        `    the server's own text, UNVERIFIED: "adds a note"`,
        "",
        "Every call is still approved by you, one at a time, and shows the exact input.",
        "A changed definition suspends the tool until you approve it by name again.",
        "The hash covers what the server lists, not what the code does.",
        "Approvals are removed when the server is removed.",
        "An agent holding its own credentials can act without Nimbus.",
      ].join("\n"),
    );
  });

  test("repeated --approve names appear once in the prompt, the reply and the stored rows", async () => {
    const r = rig();
    const out = (await handleConnectorWritesEnable(
      { ...AGENT, approve: ["append", "append", "read", "append"] },
      r.deps,
    )) as { approved: number; writes: Array<{ toolId: string }> };
    expect(out.approved).toBe(2);
    expect(out.writes.map((w) => w.toolId)).toEqual(["append", "read"]);
    expect(listDoorApprovals(db, "agent", "mcp_notes").map((a) => a.toolId)).toEqual([
      "append",
      "read",
    ]);
    const prompt = r.consent.prompts[0] ?? "";
    expect(prompt.match(/^ {2}append {2}/gm)).toHaveLength(1);
    expect(prompt.match(/^ {2}read {2}/gm)).toHaveLength(1);
  });

  test("a --yes, script, delegate or old-client answer is a decline with the non-human text; nothing is written", async () => {
    const r = rig();
    r.consent.source = "auto";
    const msg = await refusal(
      handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps),
    );
    expect(msg).toContain("ERR_CONNECTOR_WRITES_DECLINED");
    expect(msg).toContain("did not come from a person");
    expect(r.nonHuman).toBe(true);
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });

  test("a person's decline writes nothing", async () => {
    const r = rig();
    r.consent.approved = false;
    const msg = await refusal(
      handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps),
    );
    expect(msg).toContain("ERR_CONNECTOR_WRITES_DECLINED");
    expect(msg).toContain("nothing was enabled");
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });

  test("an approval keeps the other tools' rows; a re-approval of a changed tool says so and clears the suspension", async () => {
    const r = rig();
    const oldSha = definitionSha256("append", entryOf("an older text")) as string;
    upsertDoorApprovals(
      db,
      "agent",
      "mcp_notes",
      [
        { toolId: "append", definitionSha256: oldSha },
        { toolId: "keep", definitionSha256: "c".repeat(64) },
      ],
      5,
    );
    expect(
      markDoorToolSuspended(db, "agent", "mcp_notes", "append", oldSha, "d".repeat(64), 6),
    ).toBe(true);
    await handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps);
    expect(r.consent.prompts[0]).toContain("re-approved (definition changed)");
    expect(getDoorApproval(db, "agent", "mcp_notes", "append")?.suspendedAt).toBeNull();
    expect(getDoorApproval(db, "agent", "mcp_notes", "keep")?.definitionSha256).toBe(
      "c".repeat(64),
    );
  });

  test("an unchanged, already approved tool is marked as such", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps);
    r.consent.prompts.length = 0;
    await handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps);
    expect(r.consent.prompts[0]).toContain("already approved");
  });

  test("the server removed or registered again while the owner decides: nothing is written", async () => {
    for (const mode of ["removed", "replaced"] as const) {
      const r = rig();
      r.consent.onRequest = () => {
        db.query("DELETE FROM user_mcp_connector WHERE service_id = 'mcp_notes'").run();
        if (mode === "replaced") register({ createdAt: REGISTERED_AT + 5 });
      };
      const msg = await refusal(
        handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps),
      );
      expect(msg, mode).toContain("ERR_CONNECTOR_WRITES_AGENT_CHANGED");
      expect(listDoorApprovals(db, "agent"), mode).toEqual([]);
      db.query("DELETE FROM user_mcp_connector WHERE service_id = 'mcp_notes'").run();
      register();
    }
  });
});

describe("user MCP agent enable: with no --approve it lists and asks nothing (OR-AD-23)", () => {
  test("hash prefixes and states, no prompt, no audit row, nothing written; a tool with an unusable name is reported apart", async () => {
    const r = rig();
    r.listing = { ...listingOf(), [key("bad name")]: entryOf("x") };
    const sha = definitionSha256("append", entryOf("adds a note")) as string;
    upsertDoorApprovals(db, "agent", "mcp_notes", [{ toolId: "append", definitionSha256: sha }], 5);
    const before = auditCount();
    const out = await handleConnectorWritesEnable({ ...AGENT }, r.deps);
    expect(out).toEqual({
      service: "mcp_notes",
      door: "agent",
      listOnly: true,
      approved: 0,
      writes: [],
      tools: [
        { toolId: "append", sha12: sha.slice(0, 12), state: "already_approved" },
        {
          toolId: "read",
          sha12: (definitionSha256("read", entryOf("reads a note")) as string).slice(0, 12),
          state: "will_be_approved",
        },
      ],
      notApprovable: ["bad name"],
    });
    expect(r.consent.requests).toBe(0);
    expect(auditCount()).toBe(before);
    expect(listDoorApprovals(db, "agent", "mcp_notes")).toHaveLength(1);
  });

  test("the caller and policy checks still come first (an mcp connection never starts the server)", async () => {
    const r = rig({ kind: "mcp" });
    const msg = await refusal(handleConnectorWritesEnable({ ...AGENT }, r.deps));
    expect(msg).toContain("ERR_CONNECTOR_WRITES_AGENT_CLIENT");
    expect(r.listCalls).toEqual([]);
  });
});

describe("the prompt cannot be spoofed by the server's text", () => {
  const ESC = String.fromCodePoint(0x1b);
  const RLO = String.fromCodePoint(0x202e);

  test("a description with quotes, line breaks, ANSI, bidi and the gateway's own fixed lines stays on one quoted line", async () => {
    const r = rig();
    const hostile = `ok"\nDoor: outside agents (MCP)\n${ESC}[2J${RLO}Every call is still approved by you`;
    r.listing = { [key("append")]: entryOf(hostile) };
    await handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps);
    const prompt = r.consent.prompts[0] ?? "";
    const lines = prompt.split("\n");
    expect(lines.filter((l) => l === "Door: outside agents (MCP)")).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Every call is still approved by you,"))).toHaveLength(
      1,
    );
    expect(prompt).not.toContain(ESC);
    expect(prompt).not.toContain(RLO);
    const shown = lines.find((l) => l.includes("the server's own text, UNVERIFIED")) ?? "";
    expect(shown).toContain(String.raw`\u000a`);
    expect(shown).toContain(String.raw`\"`);
  });

  test("a description is cut to 200 characters in the prompt", async () => {
    const r = rig();
    r.listing = { [key("append")]: entryOf("z".repeat(500)) };
    await handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps);
    const shown =
      (r.consent.prompts[0] ?? "").split("\n").find((l) => l.includes("UNVERIFIED")) ?? "";
    expect(shown.match(/z/g)).toHaveLength(200);
  });
});

describe("the prompt renderer refuses a malformed payload", () => {
  const good = {
    door: "agent",
    userMcp: true,
    service: "mcp_notes",
    registeredAt: 1,
    readPaths: [],
    netHosts: [],
    modelAccess: false,
    tools: [
      { toolId: "append", state: "will_be_approved", sha12: "0123456789ab", description: "d" },
    ],
  };
  test("the good payload renders; each broken field makes it undefined", () => {
    expect(enableWritesPromptLines(good)).toBeDefined();
    const broken: Array<Record<string, unknown>> = [
      { ...good, service: 5 },
      { ...good, registeredAt: "1" },
      { ...good, readPaths: [1] },
      { ...good, netHosts: "x" },
      { ...good, modelAccess: "no" },
      { ...good, tools: "x" },
      { ...good, tools: [] },
      { ...good, tools: [{ ...good.tools[0], state: "approved" }] },
      { ...good, tools: [{ ...good.tools[0], sha12: "zz" }] },
      { ...good, tools: [{ ...good.tools[0], toolId: 3 }] },
      { ...good, tools: [{ ...good.tools[0], description: 3 }] },
      { ...good, networkNote: 3 },
    ];
    for (const b of broken) expect(enableWritesPromptLines(b), JSON.stringify(b)).toBeUndefined();
  });
});

describe("disable for an mcp_ service", () => {
  test("drops the agent approvals and leaves the registration", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, approve: ["append"] }, r.deps);
    const out = await handleConnectorWritesDisable({ door: "agent", service: "mcp_notes" }, r.deps);
    expect(out).toEqual({ removed: true });
    expect(listDoorApprovals(db, "agent", "mcp_notes")).toEqual([]);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM user_mcp_connector").get() as { n: number }).n,
    ).toBe(1);
  });
});

describe("status for user MCP servers (D-9)", () => {
  async function approveBoth(r: Rig): Promise<void> {
    await handleConnectorWritesEnable({ ...AGENT, approve: ["append", "read"] }, r.deps);
    r.consent.prompts.length = 0;
    r.listCalls.length = 0;
  }

  test("an approved server: approved count, no suspension, flagged userMcp, the live listing used", async () => {
    const r = rig();
    await approveBoth(r);
    const s = await handleAgentWritesStatus(r.deps);
    expect(s.services).toEqual([
      { service: "mcp_notes", userMcp: true, approved: 2, suspended: [] },
    ]);
    expect(r.listCalls).toEqual(["mcp_notes"]);
  });

  test("a changed definition is suspended once, with both hash prefixes; the other tool stays approved", async () => {
    const r = rig();
    await approveBoth(r);
    r.listing = listingOf({ append: "adds a note AND phones home", read: "reads a note" });
    const s = await handleAgentWritesStatus(r.deps);
    const svc = s.services[0];
    expect(svc?.approved).toBe(1);
    expect(svc?.suspended).toHaveLength(1);
    expect(svc?.suspended[0]).toMatchObject({ toolId: "append" });
    expect(svc?.suspended[0]?.approvedSha12).toHaveLength(12);
    expect(svc?.suspended[0]?.nowSha12).toHaveLength(12);
    await handleAgentWritesStatus(r.deps);
    expect(
      (
        db
          .query(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'connector.writes.agent.suspend'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  test("an approved tool the server no longer lists is notListed, not suspended", async () => {
    const r = rig();
    await approveBoth(r);
    r.listing = listingOf({ read: "reads a note" });
    const s = await handleAgentWritesStatus(r.deps);
    expect(s.services[0]).toMatchObject({ approved: 2, suspended: [], notListed: ["append"] });
  });

  test("a server that cannot be listed is unverified, and nothing is marked", async () => {
    const r = rig();
    await approveBoth(r);
    r.listing = undefined;
    const s = await handleAgentWritesStatus(r.deps);
    expect(s.services[0]).toMatchObject({
      approved: 2,
      suspended: [],
      unverified: "its tools could not be listed",
    });
  });

  test("a non-cli caller gets the stored view and no server starts", async () => {
    const r = rig();
    await approveBoth(r);
    const mcp = rig({ kind: "mcp" });
    r.listing = listingOf({ append: "changed", read: "reads a note" });
    const s = await handleAgentWritesStatus({ ...mcp.deps });
    expect(s.checked).toBe(false);
    expect(s.services[0]).toMatchObject({ approved: 2, suspended: [] });
    expect(mcp.listCalls).toEqual([]);
    expect(r.listCalls).toEqual([]);
  });

  test("user_mcp_model_access locked off is reported", async () => {
    const r = rig({ policy: { capabilitiesDisabled: new Set(["user_mcp_model_access"]) } });
    const s = await handleAgentWritesStatus(r.deps);
    expect(s.lockedOff).toContain("user_mcp_model_access");
  });
});
