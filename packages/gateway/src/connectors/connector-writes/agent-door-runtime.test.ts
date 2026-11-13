import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { serviceOf } from "../../engine/service-of.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { ActionDescription } from "../../mcp-sink/capture-types.ts";
import type { ChatopsPolicy } from "../../policy/types.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  type ClassifyContext,
  classifyActionType,
  PROPOSABLE_WRITE_TOOLS,
} from "../proposable-actions.ts";
import { AGENT_DOOR_MAIL_SEND_TOOL_IDS } from "./agent-door.ts";
import { legacyNoticeFor } from "./agent-door-legacy.ts";
import {
  type AgentDoor,
  type AgentDoorDeps,
  createAgentDoor,
  DEFINITION_REFUSALS,
} from "./agent-door-runtime.ts";
import { COMMIT_PATH_REFUSAL } from "./commit-paths.ts";
import { definitionSha256 } from "./definition-hash.ts";
import {
  getDoorApproval,
  markDoorToolSuspended,
  removeDoorApprovals,
  upsertDoorApprovals,
} from "./door-approval-store.ts";
import {
  OBSIDIAN_APPEND_TOOL_ID,
  raiseWriteEnablementWave,
  removeModelWriteEnablement,
  setModelWriteEnablement,
} from "./enablement-store.ts";
import { removeIacGrants, setIacGrants } from "./iac-grants.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { removeK8sGrants, setK8sGrants } from "./k8s-grants.ts";
import { MODEL_NEVER_OFFERED_REASONS } from "./model-offerable.ts";
import {
  BROADCAST_MENTION_REFUSAL,
  CHATOPS_CHANNEL_REFUSAL,
  GITLAB_QUICK_ACTION_REFUSAL,
  GITLAB_SCOPED_LABEL_REFUSAL,
  KNOWLEDGE_BASE_REFUSAL,
  LINEAR_ASSIGNEE_REFUSAL,
  type TribalKbConfig,
} from "./model-write-refusals.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

const ROW = (toolId: string): ConnectorWriteRow => {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
};

let db: Database;
let policyOff: Set<string>;
let policyThrows: boolean;
let chatopsPolicy: ChatopsPolicy | undefined;
let kb: TribalKbConfig | undefined;
let kbThrows: boolean;
let listings: Record<string, Record<string, unknown> | undefined | "reject">;
let listCalls: string[];
let configured: Set<string>;
let modelAccess: Set<string>;
let userMcpAllowed: boolean;

const classifyContext: ClassifyContext = {
  modelAccessServices: () => modelAccess,
  userMcpModelAccessAllowed: () => userMcpAllowed,
};

function entryFor(row: ConnectorWriteRow, description = "d"): unknown {
  const keys = row.preview === undefined ? [] : [...previewTemplateKeys(row.preview)];
  return {
    description,
    inputSchema: toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
    } as JsonSchemaInput),
  };
}

/** Every write tool of `service`, plus the reader and prepare tools its rows call. */
function fullListing(service: string, description = "d"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (serviceOf(r.actionType) !== service) continue;
    out[mcpClientToolKey(service, r.toolId)] = entryFor(r, description);
    const support = [
      r.before?.tool,
      r.before?.also?.tool,
      r.bound?.prepare.tool,
      r.bound?.prepare.settleTool,
    ];
    for (const t of support) {
      if (t !== undefined && !Object.hasOwn(out, mcpClientToolKey(service, t))) {
        out[mcpClientToolKey(service, t)] = { description: "support", inputSchema: {} };
      }
    }
  }
  return out;
}

function door(over: Partial<AgentDoorDeps> = {}): AgentDoor {
  return createAgentDoor({
    db,
    enforcedPolicy: () => {
      if (policyThrows) throw new Error("policy unreadable");
      return { capabilitiesDisabled: policyOff, chatops: chatopsPolicy } as never;
    },
    listServerTools: async (service) => {
      listCalls.push(service);
      const l = listings[service];
      if (l === "reject") throw new Error("listing failed");
      return l;
    },
    tribalKbConfig: () => {
      if (kbThrows) throw new Error("kb unreadable");
      return kb;
    },
    classifyContext,
    isServiceConfigured: async (s) => configured.has(s),
    now: () => 1_000,
    ...over,
  });
}

/** Enable the row's service to its wave and approve its tool for agents (with its real listing hash). */
function allow(toolId: string): ConnectorWriteRow {
  const row = ROW(toolId);
  const service = serviceOf(row.actionType);
  raiseWriteEnablementWave(db, service, row.wave, 1);
  const sha = definitionSha256(toolId, entryFor(row)) as string;
  upsertDoorApprovals(db, "agent", service, [{ toolId, definitionSha256: sha }], 1);
  return row;
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 97);
  policyOff = new Set();
  policyThrows = false;
  chatopsPolicy = { channels: new Map(), ownership: new Map() } as never;
  kb = undefined;
  kbThrows = false;
  listings = {};
  listCalls = [];
  configured = new Set(["github", "slack", "gitlab", "linear", "gmail", "jira", "notion", "iac"]);
  modelAccess = new Set(["mcp_x"]);
  userMcpAllowed = true;
});
afterEach(() => db.close());

describe("AGENT_DOOR_MAIL_SEND_TOOL_IDS", () => {
  test("is exactly the rows of MODEL_NEVER_OFFERED_REASONS whose reason is the mail-send one", () => {
    const derived = Object.entries(MODEL_NEVER_OFFERED_REASONS)
      .filter(([, reason]) => reason.startsWith("mail sends are never offered"))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    expect([...AGENT_DOOR_MAIL_SEND_TOOL_IDS].sort((a, b) => a.localeCompare(b))).toEqual(derived);
    expect(derived).toHaveLength(7);
  });
});

describe("verdict", () => {
  // The classifier's own answer, plus the explicit user-MCP marker the gate requires of a verdict
  // with no basis (it is added only to a proposable one).
  const userMcpVerdict = (t: string) => {
    const v = classifyActionType(t, classifyContext);
    return v.kind === "proposable" ? { ...v, userMcp: true as const } : v;
  };

  test("a user-MCP type returns what classifyActionType returns, a proposable one marked userMcp", () => {
    const d = door();
    for (const t of ["mcp_x.do_it", "mcp_y.do_it", "mcp_x.bad name", "mcp_x."]) {
      expect(d.verdict(t), t).toEqual(userMcpVerdict(t));
    }
    expect(d.verdict("mcp_x.do_it")).toEqual({ kind: "proposable", userMcp: true });
    userMcpAllowed = false;
    expect(d.verdict("mcp_x.do_it")).toEqual(userMcpVerdict("mcp_x.do_it"));
  });

  test("only an approved bound row is marked boundInput; an approved plain row and a legacy type are not", () => {
    allow("github_issue_create");
    raiseWriteEnablementWave(db, "github", 4, 1);
    allow("github_file_commit");
    const d = door();
    expect(d.verdict("github.issue.create")).toEqual({ kind: "proposable", basis: "approved" });
    expect(d.verdict("github.file.commit")).toEqual({
      kind: "proposable",
      basis: "approved",
      boundInput: true,
    });
    expect(d.verdict("slack.message.post")).toEqual({
      kind: "proposable",
      basis: "legacy_unapproved",
    });
  });

  test("an unknown type is unknown", () => {
    expect(door().verdict("nope.thing")).toEqual({ kind: "unknown" });
  });

  test("each of the 47 proposable types with an empty door table is legacy: the seven sends their own basis", () => {
    const d = door();
    const types = Object.keys(PROPOSABLE_WRITE_TOOLS);
    expect(types).toHaveLength(47);
    let sends = 0;
    for (const t of types) {
      const v = d.verdict(t);
      const isSend = AGENT_DOOR_MAIL_SEND_TOOL_IDS.has(PROPOSABLE_WRITE_TOOLS[t] as string);
      if (isSend) sends++;
      expect(v, t).toEqual({
        kind: "proposable",
        basis: isSend ? "legacy_mail_send" : "legacy_unapproved",
      });
    }
    expect(sends).toBe(7);
  });

  test("an approved, enabled type is proposable on the approved basis", () => {
    allow("github_issue_create");
    expect(door().verdict("github.issue.create")).toEqual({
      kind: "proposable",
      basis: "approved",
    });
  });

  test("a Wave 4 row is approved only with --wave 4 AND the approval by name", () => {
    const d = door();
    expect(d.verdict("github.pr.merge")).toEqual({ kind: "denied", class: "agent_not_enabled" });
    raiseWriteEnablementWave(db, "github", 3, 1);
    expect(d.verdict("github.pr.merge")).toEqual({ kind: "denied", class: "agent_wave" });
    raiseWriteEnablementWave(db, "github", 4, 1);
    expect(d.verdict("github.pr.merge")).toEqual({ kind: "denied", class: "agent_not_approved" });
    allow("github_pr_merge");
    expect(d.verdict("github.pr.merge")).toEqual({ kind: "proposable", basis: "approved" });
  });

  test("a bound row with no approval is denied; with one it is approved", () => {
    const d = door();
    expect(d.verdict("github.file.commit")).toEqual({ kind: "denied", class: "agent_not_enabled" });
    raiseWriteEnablementWave(db, "github", 4, 1);
    expect(d.verdict("github.file.commit")).toEqual({
      kind: "denied",
      class: "agent_not_approved",
    });
    allow("github_file_commit");
    expect(d.verdict("github.file.commit")).toEqual({
      kind: "proposable",
      basis: "approved",
      boundInput: true,
    });
  });

  test("a never-offered non-mail row is denied, even when its service is enabled", () => {
    raiseWriteEnablementWave(db, "iac", 4, 1);
    expect(door().verdict("iac.terraform.destroy")).toEqual({
      kind: "denied",
      class: "agent_never_offered",
    });
  });

  test("a suspended approval of one of the 47 types is suspended, not legacy; the suspended check precedes legacy", () => {
    const row = allow("github_issue_create");
    const sha = definitionSha256(row.toolId, entryFor(row)) as string;
    expect(markDoorToolSuspended(db, "agent", "github", row.toolId, sha, "9".repeat(64), 5)).toBe(
      true,
    );
    expect(door().verdict("github.issue.create")).toEqual({ kind: "suspended" });
  });

  test("a suspended approval is suspended even when its service has since been disabled", () => {
    const row = allow("github_issue_create");
    const sha = definitionSha256(row.toolId, entryFor(row)) as string;
    markDoorToolSuspended(db, "agent", "github", row.toolId, sha, null, 5);
    removeModelWriteEnablement(db, "github");
    expect(door().verdict("github.issue.create")).toEqual({ kind: "suspended" });
  });

  test("the Slack DM row is unreachable: slack.message.post resolves to the channel row", () => {
    allow("slack_message_post");
    expect(door().verdict("slack.message.post")).toEqual({ kind: "proposable", basis: "approved" });
  });

  test("OD-1 / OR-AD-15: under a connector_write_model_access lockoff an approved type of the 47 is legacy, else agent_policy", () => {
    allow("github_issue_create");
    allow("github_pr_merge");
    policyOff = new Set(["connector_write_model_access"]);
    const d = door();
    expect(d.verdict("github.issue.create")).toEqual({
      kind: "proposable",
      basis: "legacy_unapproved",
    });
    expect(d.verdict("github.pr.merge")).toEqual({ kind: "denied", class: "agent_policy" });
  });

  test("an unreadable policy refuses the approved basis (fail closed) and leaves the legacy rule alone", () => {
    allow("github_issue_create");
    allow("github_pr_merge");
    policyThrows = true;
    const d = door();
    expect(d.verdict("github.issue.create")).toEqual({
      kind: "proposable",
      basis: "legacy_unapproved",
    });
    expect(d.verdict("github.pr.merge")).toEqual({ kind: "denied", class: "agent_policy" });
  });

  test("a mcp_action lockoff: nothing is approved (the gate's own capability check refuses legacy too)", () => {
    allow("github_pr_merge");
    policyOff = new Set(["mcp_action"]);
    expect(door().verdict("github.pr.merge")).toEqual({ kind: "denied", class: "agent_policy" });
  });
});

describe("per-call re-read: each change alone flips an approved verdict on the next call, with no restart", () => {
  const approved = { kind: "proposable", basis: "approved" } as const;
  const approvedBound = { kind: "proposable", basis: "approved", boundInput: true } as const;
  test.each([
    ["the V83 row is removed", () => removeModelWriteEnablement(db, "github")],
    [
      "the shared wave is lowered below the row's",
      () => setModelWriteEnablement(db, "github", 2, 2, []),
    ],
    ["the door approval is removed", () => removeDoorApprovals(db, "github", "agent")],
    [
      "the approval is suspended",
      () =>
        markDoorToolSuspended(
          db,
          "agent",
          "github",
          "github_pr_merge",
          approvedSha("github_pr_merge"),
          null,
          3,
        ),
    ],
    ["mcp_action is locked off", () => policyOff.add("mcp_action")],
    [
      "connector_write_model_access is locked off",
      () => policyOff.add("connector_write_model_access"),
    ],
  ])("%s", (_n, change) => {
    allow("github_pr_merge");
    const d = door();
    expect(d.verdict("github.pr.merge")).toEqual(approved);
    change();
    expect(d.verdict("github.pr.merge")).not.toEqual(approved);
  });

  function approvedSha(toolId: string): string {
    return getDoorApproval(db, "agent", "github", toolId)?.definitionSha256 as string;
  }

  test("the last Terraform directory removed", () => {
    allow("iac_terraform_apply");
    setIacGrants(db, { workdirs: ["/w"], clouds: [], regions: [], net: [] }, 1);
    const d = door();
    expect(d.verdict("iac.terraform.apply")).toEqual(approvedBound);
    removeIacGrants(db);
    expect(d.verdict("iac.terraform.apply")).toEqual({ kind: "denied", class: "agent_no_scope" });
  });

  test("the last Kubernetes pair removed", () => {
    const row = ROW("k8s_manifest_apply");
    allow("k8s_manifest_apply");
    setK8sGrants(
      db,
      [{ context: "c", namespace: "n", server: "h:1", credentialForm: "token" } as never],
      1,
    );
    const d = door();
    expect(d.verdict(row.actionType)).toEqual(approvedBound);
    removeK8sGrants(db);
    expect(d.verdict(row.actionType)).toEqual({ kind: "denied", class: "agent_no_scope" });
  });

  test("the Obsidian model-door approval removed", () => {
    allow(OBSIDIAN_APPEND_TOOL_ID);
    setModelWriteEnablement(db, "obsidian", 4, 1, [OBSIDIAN_APPEND_TOOL_ID]);
    const d = door();
    expect(d.verdict(ROW(OBSIDIAN_APPEND_TOOL_ID).actionType)).toEqual(approved);
    setModelWriteEnablement(db, "obsidian", 4, 2, []);
    // Withdrawn model-door approval: no longer `approved`; one of the 47, so a legacy case (D-AD-15
    // correction 4), and not a suspension.
    expect(d.verdict(ROW(OBSIDIAN_APPEND_TOOL_ID).actionType)).toEqual({
      kind: "proposable",
      basis: "legacy_unapproved",
    });
  });
});

describe("refusal", () => {
  const refuse = (
    d: AgentDoor,
    type: string,
    input: Record<string, unknown>,
    approvedBasis = true,
  ) => d.refusal(type, input, approvedBasis ? "approved" : "legacy_unapproved");

  test("a user-MCP type (no basis) has no destination here", () => {
    expect(door().refusal("mcp_x.do_it", { a: 1 }, undefined)).toBeUndefined();
  });

  test("the approved basis runs the model door's refusals", () => {
    const d = door();
    expect(refuse(d, "slack.message.post", { channel: "C1", text: "<!here> hi" })).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
    expect(
      refuse(d, "gitlab.issue.note.create", { projectPath: "g/r", issueIid: 1, body: "/close" }),
    ).toBe(GITLAB_QUICK_ACTION_REFUSAL);
    expect(
      refuse(d, "gitlab.issue.labels.add", {
        projectPath: "g/r",
        issueIid: 7,
        labels: ["prio::high"],
      }),
    ).toBe(GITLAB_SCOPED_LABEL_REFUSAL);
    expect(
      refuse(d, "github.file.commit", {
        owner: "o",
        repo: "r",
        branch: "main",
        message: "m",
        files: [{ path: ".github/workflows/x.yml", content: "x" }],
      }),
    ).toBe(COMMIT_PATH_REFUSAL);
    expect(
      refuse(d, "github.issue.comment.create", {
        owner: "o",
        repo: "r",
        issueNumber: 1,
        body: "fine",
      }),
    ).toBeUndefined();
  });

  test("a Linear assigneeId is NOT refused on the approved basis and IS on a legacy basis", () => {
    const d = door();
    const input = { issueId: "i", assigneeId: "u" };
    expect(refuse(d, "linear.issue.update", input)).toBeUndefined();
    expect(refuse(d, "linear.issue.update", input, false)).toBe(LINEAR_ASSIGNEE_REFUSAL);
  });

  test("a legacy basis runs actDoorRefusal exactly as before: the KB target and a broadcast mention", () => {
    kb = { notion: { databaseId: "1a2b3c4d5e6f7a8b9c0d112233445566" } };
    const d = door();
    expect(
      refuse(
        d,
        "notion.page.create",
        { parentPageId: "1a2b3c4d5e6f7a8b9c0d112233445566", title: "t" },
        false,
      ),
    ).toBe(KNOWLEDGE_BASE_REFUSAL);
    expect(refuse(d, "slack.message.post", { channel: "C1", text: "<!here>" }, false)).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
  });

  test("a ChatOps channel post is refused, and a throwing policy accessor refuses a ChatOps post on both bases", () => {
    chatopsPolicy = {
      channels: new Map([["C0123ABCD", { namespace: "ns", unmapped: "refuse", notify: [] }]]),
      ownership: new Map(),
    } as never;
    const d = door();
    expect(refuse(d, "slack.message.post", { channel: "C0123ABCD", text: "hi" })).toBe(
      CHATOPS_CHANNEL_REFUSAL,
    );
    chatopsPolicy = undefined;
    policyThrows = true;
    expect(refuse(door(), "slack.message.post", { channel: "C0123ABCD", text: "hi" })).toBe(
      CHATOPS_CHANNEL_REFUSAL,
    );
    expect(refuse(door(), "slack.message.post", { channel: "C0123ABCD", text: "hi" }, false)).toBe(
      CHATOPS_CHANNEL_REFUSAL,
    );
  });

  test("a throwing KB accessor refuses a KB-capable row on both bases (the approved basis lets the gate catch it)", () => {
    kbThrows = true;
    const d = door();
    expect(() => refuse(d, "notion.page.create", { parentPageId: "ffff", title: "t" })).toThrow();
    expect(refuse(d, "notion.page.create", { parentPageId: "ffff", title: "t" }, false)).toBe(
      KNOWLEDGE_BASE_REFUSAL,
    );
  });
});

describe("verifyDefinition", () => {
  test("ok: lists the service once and the hash matches", async () => {
    allow("github_pr_merge");
    listings["github"] = fullListing("github");
    expect(await door().verifyDefinition("github.pr.merge")).toEqual({ ok: true });
    expect(listCalls).toEqual(["github"]);
  });

  test("a changed definition is ERR_AGENT_TOOL_SUSPENDED, marked once; a repeat lists nothing", async () => {
    allow("github_pr_merge");
    listings["github"] = fullListing("github", "changed by one byte");
    const d = door();
    const first = await d.verifyDefinition("github.pr.merge");
    expect(first).toMatchObject({ ok: false, code: "ERR_AGENT_TOOL_SUSPENDED" });
    expect(getDoorApproval(db, "agent", "github", "github_pr_merge")?.suspendedAt).toBe(1_000);
    const again = await d.verifyDefinition("github.pr.merge");
    expect(again).toMatchObject({ ok: false, code: "ERR_AGENT_TOOL_SUSPENDED" });
    expect(listCalls).toEqual(["github"]);
    const audits = db
      .query(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'connector.writes.agent.suspend'",
      )
      .get() as { n: number };
    expect(audits.n).toBe(1);
  });

  test("a tool the listing omits is refused, NOT suspended (OR-AD-14), and works when it returns", async () => {
    allow("github_pr_merge");
    const listing = fullListing("github");
    Reflect.deleteProperty(listing, mcpClientToolKey("github", "github_pr_merge"));
    listings["github"] = listing;
    const d = door();
    expect(await d.verifyDefinition("github.pr.merge")).toEqual({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_REFUSALS.notListed,
    });
    expect(getDoorApproval(db, "agent", "github", "github_pr_merge")?.suspendedAt).toBeNull();
    listings["github"] = fullListing("github");
    expect(await d.verifyDefinition("github.pr.merge")).toEqual({ ok: true });
  });

  test("a listing that is absent or rejects refuses and marks nothing", async () => {
    allow("github_pr_merge");
    const d = door();
    listings["github"] = undefined;
    expect(await d.verifyDefinition("github.pr.merge")).toMatchObject({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_REFUSALS.unlisted,
    });
    listings["github"] = "reject";
    expect(await d.verifyDefinition("github.pr.merge")).toMatchObject({
      detail: DEFINITION_REFUSALS.unlisted,
    });
    expect(getDoorApproval(db, "agent", "github", "github_pr_merge")?.suspendedAt).toBeNull();
  });

  test("a schema that lost a key the preview names is refused, not suspended (drift)", async () => {
    const row = allow("github_pr_merge");
    const bare = {
      description: "d",
      inputSchema: toStandardSchema({ type: "object", properties: {} } as JsonSchemaInput),
    };
    // The approved hash is of THIS bare definition, so the hash matches and only the drift remains.
    upsertDoorApprovals(
      db,
      "agent",
      "github",
      [{ toolId: row.toolId, definitionSha256: definitionSha256(row.toolId, bare) as string }],
      2,
    );
    listings["github"] = {
      ...fullListing("github"),
      [mcpClientToolKey("github", row.toolId)]: bare,
    };
    expect(await door().verifyDefinition("github.pr.merge")).toMatchObject({
      ok: false,
      detail: DEFINITION_REFUSALS.drifted,
    });
    expect(getDoorApproval(db, "agent", "github", row.toolId)?.suspendedAt).toBeNull();
  });

  test("a Wave 4 row whose reader is not listed is refused; a wave 2-3 row is not held to it", async () => {
    allow("github_pr_merge");
    allow("github_issue_create");
    const listing = fullListing("github");
    const reader = ROW("github_pr_merge").before?.tool as string;
    Reflect.deleteProperty(listing, mcpClientToolKey("github", reader));
    listings["github"] = listing;
    const d = door();
    expect(await d.verifyDefinition("github.pr.merge")).toMatchObject({
      ok: false,
      detail: DEFINITION_REFUSALS.support,
    });
    expect(await d.verifyDefinition("github.issue.create")).toEqual({ ok: true });
  });

  test("a bound row whose prepare tool is not listed is refused", async () => {
    const row = allow("github_file_commit");
    const listing = fullListing("github");
    Reflect.deleteProperty(listing, mcpClientToolKey("github", row.bound?.prepare.tool as string));
    listings["github"] = listing;
    expect(await door().verifyDefinition("github.file.commit")).toMatchObject({
      ok: false,
      detail: DEFINITION_REFUSALS.support,
    });
  });

  test("a type with no approval, and an already-suspended one, never list the connector", async () => {
    const d = door();
    expect(await d.verifyDefinition("github.pr.merge")).toMatchObject({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_REFUSALS.notApproved,
    });
    const row = allow("github_pr_merge");
    markDoorToolSuspended(db, "agent", "github", row.toolId, approvedHash(row), null, 4);
    expect(await d.verifyDefinition("github.pr.merge")).toMatchObject({
      code: "ERR_AGENT_TOOL_SUSPENDED",
    });
    expect(listCalls).toEqual([]);
  });

  function approvedHash(row: ConnectorWriteRow): string {
    return getDoorApproval(db, "agent", serviceOf(row.actionType), row.toolId)
      ?.definitionSha256 as string;
  }

  /** A door whose listing resolves only after `mutate` ran against the store (the owner acting mid-await). */
  function doorMutatingDuringListing(mutate: () => void, listing: Record<string, unknown>) {
    return createAgentDoor({
      db,
      enforcedPolicy: () => ({ capabilitiesDisabled: policyOff }) as never,
      listServerTools: async () => {
        mutate();
        return listing;
      },
      tribalKbConfig: () => undefined,
      classifyContext,
      isServiceConfigured: async () => true,
      now: () => 1_000,
    });
  }

  test("an approval re-approved with another hash during the listing is judged against the NEW hash: a listing of the old hash is changing and suspends the fresh row", async () => {
    const row = allow("github_pr_merge");
    const d = doorMutatingDuringListing(
      () =>
        upsertDoorApprovals(
          db,
          "agent",
          "github",
          [{ toolId: row.toolId, definitionSha256: "7".repeat(64) }],
          9,
        ),
      fullListing("github"),
    );
    expect(await d.verifyDefinition("github.pr.merge")).toMatchObject({
      ok: false,
      code: "ERR_AGENT_TOOL_SUSPENDED",
    });
    expect(getDoorApproval(db, "agent", "github", row.toolId)?.suspendedAt).toBe(1_000);
  });

  test("an approval re-approved during the listing with the hash the listing carries is ok", async () => {
    const row = allow("github_pr_merge");
    const listing = fullListing("github", "other");
    const newSha = definitionSha256(
      row.toolId,
      listing[mcpClientToolKey("github", row.toolId)],
    ) as string;
    const d = doorMutatingDuringListing(
      () =>
        upsertDoorApprovals(
          db,
          "agent",
          "github",
          [{ toolId: row.toolId, definitionSha256: newSha }],
          9,
        ),
      listing,
    );
    expect(await d.verifyDefinition("github.pr.merge")).toEqual({ ok: true });
  });

  test("an approval removed during the listing is refused as not approved, with no mark and no audit row", async () => {
    allow("github_pr_merge");
    const d = doorMutatingDuringListing(
      () => removeDoorApprovals(db, "github", "agent"),
      fullListing("github"),
    );
    expect(await d.verifyDefinition("github.pr.merge")).toEqual({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: DEFINITION_REFUSALS.notApproved,
    });
    const audits = db
      .query(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'connector.writes.agent.suspend'",
      )
      .get() as { n: number };
    expect(audits.n).toBe(0);
  });

  test("an approval suspended during the listing is refused as suspended even though the listing matches", async () => {
    const row = allow("github_pr_merge");
    const d = doorMutatingDuringListing(
      () => markDoorToolSuspended(db, "agent", "github", row.toolId, approvedHash(row), null, 4),
      fullListing("github"),
    );
    expect(await d.verifyDefinition("github.pr.merge")).toMatchObject({
      ok: false,
      code: "ERR_AGENT_TOOL_SUSPENDED",
      detail: DEFINITION_REFUSALS.suspended,
    });
  });
});

describe("acceptedTypes", () => {
  test("lists approved and legacy types of configured services, sorted, plus the user-MCP patterns; never a suspended or denied one", async () => {
    allow("github_pr_merge");
    const susp = allow("github_issue_create");
    markDoorToolSuspended(db, "agent", "github", susp.toolId, approvedHashOf(susp), null, 3);
    const types = await door().acceptedTypes();
    expect(types).toContain("github.pr.merge"); // approved, not legacy
    expect(types).not.toContain("github.issue.create"); // suspended
    expect(types).toContain("github.issue.comment.create"); // legacy
    expect(types).not.toContain("github.file.commit"); // denied
    expect(types).toContain("jira.issue.create"); // legacy: not enabled, but the earlier door accepted it
  });

  test("skips a service that is not configured, and includes mcp_<id>.* only while user-MCP access is allowed", async () => {
    configured.delete("github");
    const d = door();
    const types = await d.acceptedTypes();
    expect(types.some((t) => t.startsWith("github."))).toBe(false);
    expect(types).toContain("mcp_x.*");
    userMcpAllowed = false;
    expect(await d.acceptedTypes()).not.toContain("mcp_x.*");
    expect(types).toEqual([...types].sort((a, b) => a.localeCompare(b)));
  });

  test("is capped at 200 entries", async () => {
    modelAccess = new Set(
      Array.from({ length: 250 }, (_, i) => `mcp_s${String(i).padStart(3, "0")}`),
    );
    expect((await door().acceptedTypes()).length).toBe(200);
  });
});

function approvedHashOf(row: ConnectorWriteRow): string {
  return getDoorApproval(db, "agent", serviceOf(row.actionType), row.toolId)
    ?.definitionSha256 as string;
}

describe("verdict: the remaining denial classes and the scope facts", () => {
  test("a type two rows share with no tie-break is unroutable", () => {
    const base = ROW("github_issue_create");
    const a = { ...base, toolId: "fake_a", actionType: "fake.thing" };
    const b = { ...base, toolId: "fake_b", actionType: "fake.thing" };
    const d = door({ rows: [a, b] });
    expect(d.verdict("fake.thing")).toEqual({ kind: "denied", class: "agent_unroutable" });
  });

  test("an enabled row with no template is not offerable", () => {
    const { preview: _drop, ...rest } = ROW("github_issue_create");
    const bare: ConnectorWriteRow = { ...rest, toolId: "fake_bare", actionType: "fake.bare" };
    raiseWriteEnablementWave(db, "fake", 3, 1);
    expect(door({ rows: [bare] }).verdict("fake.bare")).toEqual({
      kind: "denied",
      class: "agent_not_offerable",
    });
  });

  test("a scope-gated write whose credential lacks its scope is denied no_scope; a throwing scope reader makes no claim", () => {
    allow("gmail_thread_archive");
    const lacking = door({ grantedScopes: () => ({ gmail: "x" }) });
    expect(lacking.verdict("gmail.thread.archive")).toEqual({
      kind: "denied",
      class: "agent_no_scope",
    });
    const throwing = door({
      grantedScopes: () => {
        throw new Error("vault");
      },
    });
    expect(throwing.verdict("gmail.thread.archive")).toEqual({
      kind: "proposable",
      basis: "approved",
    });
  });

  test("a grant read that throws counts as no grant (fail closed)", () => {
    allow("iac_terraform_apply");
    db.run("DROP TABLE connector_write_iac_grant");
    expect(door().verdict("iac.terraform.apply")).toEqual({
      kind: "denied",
      class: "agent_no_scope",
    });
  });
});

describe("describe (AD3a-2b)", () => {
  const suspendAudits = (): number =>
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'connector.writes.agent.suspend'",
        )
        .get() as { n: number }
    ).n;

  const byType = (rows: readonly ActionDescription[], type: string): ActionDescription => {
    const hit = rows.find((r) => r.actionType === type);
    if (hit === undefined) throw new Error(`no entry for ${type}`);
    return hit;
  };

  test("the summary lists what acceptedTypes lists plus the suspended types, with the wave, the typed-confirmation flag and the bound flag, and lists nothing", async () => {
    allow("github_pr_merge");
    allow("github_issue_create");
    const closeRow = allow("github_pr_close");
    markDoorToolSuspended(
      db,
      "agent",
      "github",
      closeRow.toolId,
      approvedHashOf(closeRow),
      null,
      4,
    );
    const d = door();
    const rows = await d.describe(undefined);
    const accepted = await d.acceptedTypes();
    expect(listCalls).toEqual([]);
    const types = rows.map((r) => r.actionType);
    for (const t of accepted) expect(types, t).toContain(t);
    expect(types).toContain("github.pr.close");
    expect(types).toEqual(types.toSorted((a, b) => a.localeCompare(b)));
    expect(byType(rows, "github.pr.merge")).toEqual({
      actionType: "github.pr.merge",
      state: "approved",
      wave: 4,
      typedConfirm: true,
      bound: false,
    });
    expect(byType(rows, "github.issue.create")).toMatchObject({
      state: "approved",
      wave: 2,
      typedConfirm: false,
    });
    expect(byType(rows, "github.pr.close")).toEqual({
      actionType: "github.pr.close",
      state: "suspended",
      reason: DEFINITION_REFUSALS.suspended,
    });
    expect(byType(rows, "slack.message.post")).toEqual({
      actionType: "slack.message.post",
      state: "legacy",
      deprecation: legacyNoticeFor("slack.message.post"),
    });
    expect(byType(rows, "mcp_x.*")).toMatchObject({ state: "undescribed" });
    // No summary entry carries a description or a schema.
    expect(JSON.stringify(rows)).not.toContain("inputSchema");
    expect(JSON.stringify(rows)).not.toContain("description");
  });

  test("a bound row is flagged bound in the summary", async () => {
    raiseWriteEnablementWave(db, "github", 4, 1);
    allow("github_file_commit");
    expect(byType(await door().describe(undefined), "github.file.commit")).toMatchObject({
      state: "approved",
      bound: true,
      typedConfirm: true,
    });
  });

  test("a detailed call returns description and schema for an approved type that passes verifyDefinition in the same call, listing its service once", async () => {
    allow("github_pr_merge");
    allow("github_issue_create");
    listings["github"] = fullListing("github");
    const d = door();
    const out = await d.describe(["github.pr.merge", "github.issue.create"]);
    expect(listCalls).toEqual(["github"]);
    expect(out.map((r) => r.state)).toEqual(["approved", "approved"]);
    for (const r of out) {
      if (r.state !== "approved") throw new Error("unreachable");
      expect(typeof r.description).toBe("string");
      expect(r.inputSchema?.["type"]).toBe("object");
      expect(await d.verifyDefinition(r.actionType)).toEqual({ ok: true });
    }
  });

  test("a changed definition is suspended with no description, no schema and no hash material; the first observer records one audit row", async () => {
    allow("github_pr_merge");
    listings["github"] = fullListing("github", "changed by one byte");
    const out = await door().describe(["github.pr.merge"]);
    expect(out).toEqual([
      {
        actionType: "github.pr.merge",
        state: "suspended",
        reason: DEFINITION_REFUSALS.suspended,
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/[0-9a-f]{12,}/);
    expect(getDoorApproval(db, "agent", "github", "github_pr_merge")?.suspendedAt).toBe(1_000);
    expect(suspendAudits()).toBe(1);
    // A second call finds it already suspended: no second row, no listing.
    listCalls.length = 0;
    expect(await door().describe(["github.pr.merge"])).toEqual(out);
    expect(listCalls).toEqual([]);
    expect(suspendAudits()).toBe(1);
  });

  test("a missing tool, a drifted schema, an unlisted connector and a missing Wave 4 reader are unavailable with the fixed text and mark nothing", async () => {
    const merge = allow("github_pr_merge");
    allow("github_issue_create");
    const d = door();
    // missing
    const missing = fullListing("github");
    Reflect.deleteProperty(missing, mcpClientToolKey("github", "github_issue_create"));
    listings["github"] = missing;
    expect(await d.describe(["github.issue.create"])).toEqual([
      {
        actionType: "github.issue.create",
        state: "unavailable",
        reason: DEFINITION_REFUSALS.notListed,
      },
    ]);
    // unlisted
    listings["github"] = undefined;
    expect(await d.describe(["github.issue.create"])).toEqual([
      {
        actionType: "github.issue.create",
        state: "unavailable",
        reason: DEFINITION_REFUSALS.unlisted,
      },
    ]);
    // missing Wave 4 reader
    const noReader = fullListing("github");
    Reflect.deleteProperty(noReader, mcpClientToolKey("github", merge.before?.tool as string));
    listings["github"] = noReader;
    expect(await d.describe(["github.pr.merge"])).toEqual([
      {
        actionType: "github.pr.merge",
        state: "unavailable",
        reason: DEFINITION_REFUSALS.support,
      },
    ]);
    // drifted
    const bare = {
      description: "d",
      inputSchema: toStandardSchema({ type: "object", properties: {} } as JsonSchemaInput),
    };
    const issue = ROW("github_issue_create");
    upsertDoorApprovals(
      db,
      "agent",
      "github",
      [{ toolId: issue.toolId, definitionSha256: definitionSha256(issue.toolId, bare) as string }],
      2,
    );
    listings["github"] = {
      ...fullListing("github"),
      [mcpClientToolKey("github", issue.toolId)]: bare,
    };
    expect(await d.describe(["github.issue.create"])).toEqual([
      {
        actionType: "github.issue.create",
        state: "unavailable",
        reason: DEFINITION_REFUSALS.drifted,
      },
    ]);
    for (const toolId of ["github_pr_merge", "github_issue_create"]) {
      expect(getDoorApproval(db, "agent", "github", toolId)?.suspendedAt).toBeNull();
    }
    expect(suspendAudits()).toBe(0);
  });

  test("a legacy type returns its deprecation line and causes no listing", async () => {
    const out = await door().describe(["slack.message.post"]);
    expect(out).toEqual([
      {
        actionType: "slack.message.post",
        state: "legacy",
        deprecation: legacyNoticeFor("slack.message.post"),
      },
    ]);
    expect(listCalls).toEqual([]);
  });

  test("a user-MCP type is undescribed and starts nothing", async () => {
    const out = await door().describe(["mcp_x.do_it"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ actionType: "mcp_x.do_it", state: "undescribed" });
    expect(listCalls).toEqual([]);
  });

  test("an unknown type is not_proposable, an unconfigured service is unavailable, and neither lists", async () => {
    allow("github_issue_create");
    configured.delete("github");
    const out = await door().describe(["nonsense.type", "github.issue.create"]);
    expect(out[0]).toEqual({
      actionType: "nonsense.type",
      state: "not_proposable",
      reason: "cannot be proposed (unknown action type)",
    });
    expect(out[1]).toEqual({
      actionType: "github.issue.create",
      state: "unavailable",
      reason: "github is not configured on this machine",
    });
    expect(listCalls).toEqual([]);
  });

  test("a type the owner has not approved names its denied class", async () => {
    const out = await door().describe(["github.pr.merge"]);
    expect(out).toEqual([
      {
        actionType: "github.pr.merge",
        state: "not_proposable",
        reason: "cannot be proposed (agent_not_enabled)",
      },
    ]);
  });

  test("a bound field is absent from the described schema even when the listing declares it", async () => {
    raiseWriteEnablementWave(db, "github", 4, 1);
    const row = ROW("github_file_commit");
    const keys = [...previewTemplateKeys(row.preview as never)];
    const entry = {
      description: "commits",
      inputSchema: toStandardSchema({
        type: "object",
        properties: {
          ...Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
          expectedHeadSha: { type: "string" },
          repo: { type: "string" },
        },
        required: ["expectedHeadSha", "repo"],
      } as JsonSchemaInput),
    };
    upsertDoorApprovals(
      db,
      "agent",
      "github",
      [{ toolId: row.toolId, definitionSha256: definitionSha256(row.toolId, entry) as string }],
      1,
    );
    listings["github"] = {
      ...fullListing("github"),
      [mcpClientToolKey("github", row.toolId)]: entry,
    };
    const [out] = await door().describe(["github.file.commit"]);
    if (out?.state !== "approved") throw new Error(JSON.stringify(out));
    expect(Object.keys(out.inputSchema?.["properties"] as object)).not.toContain("expectedHeadSha");
    expect(Object.keys(out.inputSchema?.["properties"] as object)).toContain("repo");
    expect(out.inputSchema?.["required"]).toEqual(["repo"]);
    expect(out.description).not.toContain("expectedHeadSha");
  });

  test("the Terraform directories and the Kubernetes pairs are named, a server address never is", async () => {
    raiseWriteEnablementWave(db, "iac", 4, 1);
    setIacGrants(db, { workdirs: ["/srv/infra/prod"], clouds: [], regions: [], net: [] }, 1);
    allow("iac_terraform_apply");
    listings["iac"] = fullListing("iac");
    const [out] = await door().describe(["iac.terraform.apply"]);
    if (out?.state !== "approved") throw new Error(JSON.stringify(out));
    expect(out.description).toContain("/srv/infra/prod");

    raiseWriteEnablementWave(db, "kubernetes", 4, 1);
    setK8sGrants(
      db,
      [
        {
          context: "prod-ctx",
          namespace: "payments",
          server: "10.9.8.7:6443",
          credentialForm: "token",
        },
      ],
      1,
    );
    configured.add("kubernetes");
    allow("k8s_rollout_restart");
    listings["kubernetes"] = fullListing("kubernetes");
    const [k] = await door().describe(["kubernetes.rollout.restart"]);
    if (k?.state !== "approved") throw new Error(JSON.stringify(k));
    expect(k.description).toContain("prod-ctx/payments");
    expect(JSON.stringify(k)).not.toContain("10.9.8.7");
  });
});
