// AD5a Tasks 3 and 4: the agent door's verdict and definition check for a user-MCP (`mcp_*`) type.
// Every fact is read at the call; the listing is injected (no real third-party server is started).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { type ClassifyContext, classifyActionType } from "../proposable-actions.ts";
import { deleteUserMcpConnector, insertUserMcpConnector } from "../user-mcp-store.ts";
import { type AgentDoorDeps, createAgentDoor, DEFINITION_REFUSALS } from "./agent-door-runtime.ts";
import { definitionSha256 } from "./definition-hash.ts";
import {
  getDoorApproval,
  markDoorToolSuspended,
  removeDoorApprovals,
  upsertDoorApprovals,
} from "./door-approval-store.ts";

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

let db: Database;
let policyOff: Set<string>;
let policyThrows: boolean;
let userMcpAllowed: boolean;
let modelAccess: Set<string>;
/** serviceId -> the listing the injected lister returns (`"reject"` throws, `"none"` is undefined). */
let listings: Record<string, Record<string, unknown> | "reject" | "none">;
let userListCalls: string[];
let firstPartyListCalls: string[];
let clock: number;

const classifyContext: ClassifyContext = {
  modelAccessServices: () => modelAccess,
  userMcpModelAccessAllowed: () => userMcpAllowed,
};

const REGISTERED_AT = 100;

function entry(
  description: string | null | undefined = "adds a note",
  schema: Record<string, unknown> = { type: "object", properties: { text: { type: "string" } } },
): unknown {
  return {
    ...(description === undefined ? {} : { description }),
    inputSchema: toStandardSchema(schema as JsonSchemaInput),
  };
}

/** The stripped listing a user server gives: keys `<serviceId>_<tool>`. */
function listing(serviceId: string, tools: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tools).map(([t, e]) => [mcpClientToolKey(serviceId, t), e]),
  );
}

function register(serviceId: string, opts: { model?: boolean; createdAt?: number } = {}): void {
  insertUserMcpConnector(db, {
    service_id: serviceId,
    command: "srv",
    args_json: "[]",
    read_paths_json: "[]",
    net_hosts_json: "[]",
    model_access: opts.model === true ? 1 : 0,
    created_at: opts.createdAt ?? REGISTERED_AT,
  });
  if (opts.model === true) modelAccess.add(serviceId);
}

/** Approve `tool` of `serviceId` for agents at the hash of `e` (a real definition hash). */
function approve(serviceId: string, tool: string, e: unknown = entry()): string {
  const sha = definitionSha256(tool, e) as string;
  upsertDoorApprovals(db, "agent", serviceId, [{ toolId: tool, definitionSha256: sha }], 1);
  return sha;
}

function door(over: Partial<AgentDoorDeps> = {}) {
  return createAgentDoor({
    db,
    enforcedPolicy: () => {
      if (policyThrows) throw new Error("policy unreadable");
      return { capabilitiesDisabled: policyOff } as never;
    },
    listServerTools: async (service) => {
      firstPartyListCalls.push(service);
      return undefined;
    },
    listUserMcpDefinitions: async (serviceId) => {
      userListCalls.push(serviceId);
      const l = listings[serviceId];
      if (l === "reject") throw new Error("listing failed");
      return l === undefined || l === "none" ? undefined : l;
    },
    tribalKbConfig: () => undefined,
    classifyContext,
    isServiceConfigured: async () => true,
    now: () => clock,
    ...over,
  });
}

function suspendAudits(): number {
  return (
    db
      .query(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'connector.writes.agent.suspend'",
      )
      .get() as { n: number }
  ).n;
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 97);
  policyOff = new Set();
  policyThrows = false;
  userMcpAllowed = true;
  modelAccess = new Set();
  listings = {};
  userListCalls = [];
  firstPartyListCalls = [];
  clock = 1_000;
});
afterEach(() => db.close());

describe("verdict: one test per step of D-2", () => {
  test("1. a type that names no server and tool is unknown (an ext_ id never reaches this path)", () => {
    const d = door();
    expect(d.verdict("mcp_x.")).toEqual({ kind: "unknown" });
    expect(d.verdict("mcp_x.a b")).toEqual({ kind: "unknown" });
    expect(d.verdict("mcp_x.a.b")).toEqual({ kind: "unknown" });
    // An extension: even with an approval row filed under its id, it is unknown, not approved.
    upsertDoorApprovals(
      db,
      "agent",
      "ext_x",
      [{ toolId: "tool", definitionSha256: "a".repeat(64) }],
      1,
    );
    expect(d.verdict("ext_x.tool")).toEqual({ kind: "unknown" });
  });

  test("2. an unregistered server is denied (user_mcp_not_registered), even with a leftover approval", () => {
    approve("mcp_gone", "append");
    expect(door().verdict("mcp_gone.append")).toEqual({
      kind: "denied",
      class: "user_mcp_not_registered",
    });
  });

  test("3. a suspended approval is suspended, even on a --model server (never a legacy case)", () => {
    register("mcp_x", { model: true });
    const sha = approve("mcp_x", "append");
    expect(markDoorToolSuspended(db, "agent", "mcp_x", "append", sha, "b".repeat(64), 2)).toBe(
      true,
    );
    expect(door().verdict("mcp_x.append")).toEqual({ kind: "suspended" });
  });

  test("4. an approved tool on a server registered WITHOUT --model is approved", () => {
    register("mcp_x");
    approve("mcp_x", "append");
    expect(door().verdict("mcp_x.append")).toEqual({ kind: "proposable", basis: "approved" });
  });

  test("4. approved needs user_mcp_model_access: with it off the tool is denied, not approved and not legacy", () => {
    register("mcp_x");
    approve("mcp_x", "append");
    userMcpAllowed = false;
    const v = door().verdict("mcp_x.append");
    expect(v.kind).toBe("denied");
  });

  test("4. approved needs mcp_action: with it locked off the tool is denied, not downgraded to legacy", () => {
    register("mcp_x", { model: true });
    approve("mcp_x", "append");
    policyOff.add("mcp_action");
    expect(door().verdict("mcp_x.append")).toEqual({ kind: "denied", class: "agent_policy" });
  });

  test("4. an unreadable policy fails closed", () => {
    register("mcp_x");
    approve("mcp_x", "append");
    policyThrows = true;
    expect(door().verdict("mcp_x.append").kind).toBe("denied");
  });

  test("5. an unapproved tool of a --model server is legacy_user_mcp, exactly as before", () => {
    register("mcp_x", { model: true });
    expect(door().verdict("mcp_x.append")).toEqual({
      kind: "proposable",
      basis: "legacy_user_mcp",
    });
  });

  test("6. an unapproved tool of a server without --model keeps the classifier's class; policy off keeps user_mcp_policy", () => {
    register("mcp_x");
    expect(door().verdict("mcp_x.append")).toEqual({
      kind: "denied",
      class: "user_mcp_no_model_access",
    });
    register("mcp_m", { model: true });
    userMcpAllowed = false;
    expect(door().verdict("mcp_m.append")).toEqual({ kind: "denied", class: "user_mcp_policy" });
  });

  test("the verdict never lists anything", () => {
    register("mcp_x", { model: true });
    approve("mcp_x", "append");
    const d = door();
    d.verdict("mcp_x.append");
    d.verdict("mcp_x.other");
    expect(userListCalls).toEqual([]);
    expect(firstPartyListCalls).toEqual([]);
  });
});

describe("the --model grant and the agent grant are independent (property 1)", () => {
  test("a tool approved only for the model is not approved for agents; approving one tool does not approve its sibling", () => {
    register("mcp_x", { model: true });
    approve("mcp_x", "append");
    const d = door();
    expect(d.verdict("mcp_x.append")).toEqual({ kind: "proposable", basis: "approved" });
    // The sibling has no agent approval: it is the legacy case, never `approved`.
    expect(d.verdict("mcp_x.other")).toEqual({ kind: "proposable", basis: "legacy_user_mcp" });
  });

  test("revoking --model does not revoke the agent approval, and the agent approval does not need --model", () => {
    register("mcp_y");
    approve("mcp_y", "append");
    expect(modelAccess.has("mcp_y")).toBe(false);
    expect(door().verdict("mcp_y.append")).toEqual({ kind: "proposable", basis: "approved" });
  });
});

describe("tool identity is the pair (server id, tool name) (property 2)", () => {
  test("a prefix-sharing server id cannot lend its approval: mcp_a/b_c is not mcp_a_b/c", () => {
    register("mcp_a");
    register("mcp_a_b");
    approve("mcp_a", "b_c");
    const d = door();
    expect(d.verdict("mcp_a.b_c")).toEqual({ kind: "proposable", basis: "approved" });
    expect(d.verdict("mcp_a_b.c").kind).toBe("denied");
    // Both would build the same listing key; the approval row still tells them apart.
    expect(mcpClientToolKey("mcp_a", "b_c")).toBe(mcpClientToolKey("mcp_a_b", "c"));
    expect(getDoorApproval(db, "agent", "mcp_a_b", "c")).toBeUndefined();
  });

  test("an approval filed under a first-party tool id never makes a first-party type approved, and vice versa", () => {
    register("mcp_x");
    approve("mcp_x", "github_issue_create");
    const d = door();
    expect(d.verdict("github.issue.create")).not.toEqual({ kind: "proposable", basis: "approved" });
    expect(d.verdict("mcp_x.github_issue_create")).toEqual({
      kind: "proposable",
      basis: "approved",
    });
    // And a first-party approval row never approves a user-MCP type of the same tool name.
    upsertDoorApprovals(
      db,
      "agent",
      "github",
      [{ toolId: "append", definitionSha256: "c".repeat(64) }],
      1,
    );
    expect(d.verdict("mcp_x.append").kind).toBe("denied");
  });
});

describe("every fact is read at the call", () => {
  test("registration, approval, suspension, policy and --model each change the next answer", () => {
    const d = door();
    expect(d.verdict("mcp_x.append").kind).toBe("denied");
    register("mcp_x", { model: true });
    expect(d.verdict("mcp_x.append")).toEqual({ kind: "proposable", basis: "legacy_user_mcp" });
    const sha = approve("mcp_x", "append");
    expect(d.verdict("mcp_x.append")).toEqual({ kind: "proposable", basis: "approved" });
    policyOff.add("mcp_action");
    expect(d.verdict("mcp_x.append").kind).toBe("denied");
    policyOff.delete("mcp_action");
    expect(d.verdict("mcp_x.append")).toEqual({ kind: "proposable", basis: "approved" });
    markDoorToolSuspended(db, "agent", "mcp_x", "append", sha, null, 5);
    expect(d.verdict("mcp_x.append")).toEqual({ kind: "suspended" });
    removeDoorApprovals(db, "mcp_x");
    expect(d.verdict("mcp_x.append")).toEqual({ kind: "proposable", basis: "legacy_user_mcp" });
    deleteUserMcpConnector(db, "mcp_x");
    expect(d.verdict("mcp_x.append").kind).toBe("denied");
  });
});

describe("refusal: no destination rule exists for a tool the gateway does not understand", () => {
  test("both user-MCP bases return undefined; nothing is invented", () => {
    register("mcp_x", { model: true });
    expect(door().refusal("mcp_x.append", { a: 1 }, "approved")).toBeUndefined();
    expect(door().refusal("mcp_x.append", { a: 1 }, "legacy_user_mcp")).toBeUndefined();
  });
});

describe("verifyDefinition for an mcp_* type (D-3)", () => {
  const E = entry();
  const setup = (e: unknown = E) => {
    register("mcp_x");
    approve("mcp_x", "append", e);
  };

  test("an unchanged listing is ok; the lister is asked for that server only; the first-party lister is never used", async () => {
    setup();
    listings["mcp_x"] = listing("mcp_x", { append: E });
    expect(await door().verifyDefinition("mcp_x.append")).toEqual({ ok: true });
    expect(userListCalls).toEqual(["mcp_x"]);
    expect(firstPartyListCalls).toEqual([]);
    expect(suspendAudits()).toBe(0);
  });

  test("the hash is the shared definitionSha256 of the listed entry (reuse, no second function)", async () => {
    setup();
    const stored = getDoorApproval(db, "agent", "mcp_x", "append")?.definitionSha256;
    expect(stored).toBe(definitionSha256("append", E));
  });

  test("a one-byte change of the description suspends: ERR_AGENT_TOOL_SUSPENDED, marked, ONE audit row across three observers", async () => {
    setup();
    listings["mcp_x"] = listing("mcp_x", { append: entry("adds a note.") });
    const d = door();
    for (let i = 0; i < 3; i++) {
      expect(await d.verifyDefinition("mcp_x.append")).toMatchObject({
        ok: false,
        code: "ERR_AGENT_TOOL_SUSPENDED",
      });
    }
    expect(getDoorApproval(db, "agent", "mcp_x", "append")?.suspendedAt).not.toBeNull();
    expect(suspendAudits()).toBe(1);
    // The later two never listed: a suspended approval is refused before any listing.
    expect(userListCalls).toHaveLength(1);
  });

  test("a change inside a schema keyword the offer sanitiser drops (pattern) suspends too", async () => {
    const withPattern = (p: string) =>
      entry("d", { type: "object", properties: { text: { type: "string", pattern: p } } });
    setup(withPattern("^a+$"));
    listings["mcp_x"] = listing("mcp_x", { append: withPattern("^b+$") });
    expect(await door().verifyDefinition("mcp_x.append")).toMatchObject({
      ok: false,
      code: "ERR_AGENT_TOOL_SUSPENDED",
    });
    expect(suspendAudits()).toBe(1);
  });

  test("a present description that is not a string, or an unreadable schema, is unreadable: suspended with a NULL observed hash", async () => {
    for (const bad of [
      { description: null, inputSchema: E && (E as { inputSchema: unknown }).inputSchema },
      { description: 5, inputSchema: (E as { inputSchema: unknown }).inputSchema },
      { description: "adds a note", inputSchema: 5 },
    ]) {
      db.close();
      db = new Database(":memory:");
      runIndexedSchemaMigrations(db, 97);
      setup();
      listings["mcp_x"] = listing("mcp_x", { append: bad });
      expect(await door().verifyDefinition("mcp_x.append")).toMatchObject({
        ok: false,
        code: "ERR_AGENT_TOOL_SUSPENDED",
      });
      const a = getDoorApproval(db, "agent", "mcp_x", "append");
      expect(a?.suspendedAt).not.toBeNull();
      expect(a?.suspendedSha256).toBeNull();
      expect(suspendAudits()).toBe(1);
    }
  });

  test("a tool the listing omits is missing: refused, NO mark and NO audit row", async () => {
    setup();
    listings["mcp_x"] = listing("mcp_x", { other: E });
    expect(await door().verifyDefinition("mcp_x.append")).toEqual({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_REFUSALS.notListed,
    });
    expect(getDoorApproval(db, "agent", "mcp_x", "append")?.suspendedAt).toBeNull();
    expect(suspendAudits()).toBe(0);
  });

  test("a server that cannot be listed (undefined, a throw, no lister wired) is refused with no mark and no audit row", async () => {
    setup();
    for (const mode of ["none", "reject"] as const) {
      listings["mcp_x"] = mode;
      expect(await door().verifyDefinition("mcp_x.append")).toEqual({
        ok: false,
        code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
        detail: DEFINITION_REFUSALS.unlisted,
      });
    }
    const bare = createAgentDoor({
      db,
      enforcedPolicy: () => ({ capabilitiesDisabled: policyOff }) as never,
      listServerTools: async () => undefined,
      tribalKbConfig: () => undefined,
      classifyContext,
      isServiceConfigured: async () => true,
      now: () => clock,
    });
    expect(await bare.verifyDefinition("mcp_x.append")).toMatchObject({ ok: false });
    expect(getDoorApproval(db, "agent", "mcp_x", "append")?.suspendedAt).toBeNull();
    expect(suspendAudits()).toBe(0);
  });

  test("a re-approval by name clears a suspension and the tool checks ok against the new definition", async () => {
    setup();
    const changed = entry("adds a note, now with a footer");
    listings["mcp_x"] = listing("mcp_x", { append: changed });
    expect((await door().verifyDefinition("mcp_x.append")).ok).toBe(false);
    approve("mcp_x", "append", changed);
    expect(await door().verifyDefinition("mcp_x.append")).toEqual({ ok: true });
  });

  test("an unapproved tool (the legacy case) is refused without calling any lister", async () => {
    register("mcp_x", { model: true });
    listings["mcp_x"] = listing("mcp_x", { append: E });
    expect(await door().verifyDefinition("mcp_x.append")).toEqual({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_REFUSALS.notApproved,
    });
    expect(userListCalls).toEqual([]);
  });

  test("an unregistered server, an ext_ id and a malformed type call no lister", async () => {
    approve("mcp_gone", "append");
    upsertDoorApprovals(
      db,
      "agent",
      "ext_x",
      [{ toolId: "tool", definitionSha256: "a".repeat(64) }],
      1,
    );
    const d = door();
    for (const t of ["mcp_gone.append", "ext_x.tool", "mcp_x.a b"]) {
      expect((await d.verifyDefinition(t)).ok, t).toBe(false);
    }
    expect(userListCalls).toEqual([]);
    expect(firstPartyListCalls).toEqual([]);
  });

  test("the approval is re-read after the listing: removed, suspended or re-approved meanwhile is judged as it stands", async () => {
    setup();
    let during: () => void = () => {};
    const d = door({
      listUserMcpDefinitions: async () => {
        during();
        return listing("mcp_x", { append: E });
      },
    });
    during = () => removeDoorApprovals(db, "mcp_x");
    expect(await d.verifyDefinition("mcp_x.append")).toMatchObject({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_REFUSALS.notApproved,
    });
    setup2();
    function setup2() {
      approve("mcp_x", "append");
    }
    during = () => {
      const sha = getDoorApproval(db, "agent", "mcp_x", "append")?.definitionSha256 as string;
      markDoorToolSuspended(db, "agent", "mcp_x", "append", sha, null, 3);
    };
    expect(await d.verifyDefinition("mcp_x.append")).toMatchObject({
      ok: false,
      code: "ERR_AGENT_TOOL_SUSPENDED",
    });
  });
});

describe("a proposal queued against an earlier registration is refused (R-2, property 5)", () => {
  test("proposedAt older than the server's created_at is refused before any listing; equal or newer passes", async () => {
    register("mcp_x", { createdAt: 500 });
    approve("mcp_x", "append");
    listings["mcp_x"] = listing("mcp_x", { append: entry() });
    const d = door();
    expect(await d.verifyDefinition("mcp_x.append", 499)).toMatchObject({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    });
    expect(userListCalls).toEqual([]);
    expect(await d.verifyDefinition("mcp_x.append", 500)).toEqual({ ok: true });
    expect(await d.verifyDefinition("mcp_x.append", 900)).toEqual({ ok: true });
    // A submit passes none: no comparison.
    expect(await d.verifyDefinition("mcp_x.append")).toEqual({ ok: true });
  });

  test("a registration removed while the listing was in flight refuses", async () => {
    register("mcp_x");
    approve("mcp_x", "append");
    const d = door({
      listUserMcpDefinitions: async () => {
        deleteUserMcpConnector(db, "mcp_x");
        return listing("mcp_x", { append: entry() });
      },
    });
    expect((await d.verifyDefinition("mcp_x.append")).ok).toBe(false);
  });
});

describe("the legacy window admits exactly what was admitted before, and nothing more (property 7)", () => {
  test("for an UNAPPROVED tool the verdict is the earlier classifier's answer, with the legacy basis in place of none", () => {
    for (const model of [true, false]) {
      for (const allowed of [true, false]) {
        const id = `mcp_${model ? "m" : "n"}${allowed ? "1" : "0"}`;
        register(id, { model });
        userMcpAllowed = allowed;
        const before = classifyActionType(`${id}.append`, classifyContext);
        const now = door().verdict(`${id}.append`);
        if (before.kind === "proposable") {
          expect(now, id).toEqual({ kind: "proposable", basis: "legacy_user_mcp" });
        } else {
          expect(now, id).toEqual(before);
        }
      }
    }
  });

  test("an unapproved tool is never `approved`, whatever the server, policy or listing", () => {
    register("mcp_x", { model: true });
    listings["mcp_x"] = listing("mcp_x", { append: entry() });
    expect(door().verdict("mcp_x.append")).not.toEqual({ kind: "proposable", basis: "approved" });
    expect(door().verdict("mcp_x.append")).toEqual({
      kind: "proposable",
      basis: "legacy_user_mcp",
    });
  });
});
