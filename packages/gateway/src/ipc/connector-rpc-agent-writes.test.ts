// Phase 28 AD3a-1: `connector.writesEnable|writesDisable|writesStatus` with `door: "agent"` (the
// owner's per-door approval list for outside agents). Real in-memory SQLite through the migration
// runner, a real gate-only `ToolExecutor` around a fake consent coordinator wrapped exactly as the
// dispatcher wraps it, and a fake `listServerTools`.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { AGENT_DOOR_NOT_ENFORCED_NOTICE } from "../connectors/connector-writes/agent-door.ts";
import { definitionSha256 } from "../connectors/connector-writes/definition-hash.ts";
import {
  listDoorApprovals,
  markDoorToolSuspended,
  upsertDoorApprovals,
} from "../connectors/connector-writes/door-approval-store.ts";
import {
  getModelWriteEnablement,
  OBSIDIAN_APPEND_TOOL_ID,
  setModelWriteEnablement,
  writesEnabledBy,
} from "../connectors/connector-writes/enablement-store.ts";
import { setIacGrants } from "../connectors/connector-writes/iac-grants.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { setK8sGrants } from "../connectors/connector-writes/k8s-grants.ts";
import { createModelWriteToolSource } from "../connectors/connector-writes/model-write-source.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { dbRun } from "../db/write.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { AnswerSource } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { handleAgentWritesStatus } from "./connector-rpc-handlers/agent-writes.ts";
import {
  handleConnectorWritesDisable,
  handleConnectorWritesEnable,
  handleConnectorWritesStatus,
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
  requestConsent(_c: string, p: { prompt: string }) {
    this.requests++;
    this.prompts.push(p.prompt);
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
});
afterEach(() => db.close());

type Policy = { capabilitiesDisabled: ReadonlySet<string> };
const OPEN: Policy = { capabilitiesDisabled: new Set<string>() };

function entryOf(description: string, props: Record<string, unknown> = {}): unknown {
  return {
    description,
    inputSchema: toStandardSchema({ type: "object", properties: props } as JsonSchemaInput),
  };
}

/** A listing of every write row of `service`, each described by `describe(toolId)`. */
function listingOf(
  service: string,
  describe: (toolId: string) => string = (t) => `desc ${t}`,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (serviceOf(r.actionType) === service) {
      out[mcpClientToolKey(service, r.toolId)] = entryOf(describe(r.toolId));
    }
  }
  return out;
}

interface Rig {
  readonly consent: FakeConsent;
  readonly listCalls: string[];
  deps: ModelWritesDeps;
  listing: Record<string, unknown> | undefined;
  nonHuman: boolean;
}

function rig(
  over: {
    kind?: ClientKind;
    policy?: Policy | undefined;
    noExecutor?: boolean;
    service?: string;
  } = {},
): Rig {
  const consent = new FakeConsent();
  const r: Rig = {
    consent,
    listCalls: [],
    listing: listingOf(over.service ?? "github"),
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
    listServerTools: async (service: string) => {
      r.listCalls.push(service);
      return r.listing;
    },
    clientKind: over.kind ?? "cli",
    agentAnswerWasNonHuman: () => r.nonHuman,
  } as ModelWritesDeps;
  return r;
}

function dropTool(r: Rig, toolId: string): void {
  if (r.listing !== undefined)
    Reflect.deleteProperty(r.listing, mcpClientToolKey("github", toolId));
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

function approvedShaOf(toolId: string): string {
  const row = listDoorApprovals(db, "agent", "github").find((x) => x.toolId === toolId);
  if (row === undefined) throw new Error(`no approval for ${toolId}`);
  return row.definitionSha256;
}

function auditCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
}

const AGENT = { door: "agent" } as const;

describe("agent enable: the order of the refusals", () => {
  const cases: Array<{
    name: string;
    kind?: ClientKind;
    policy?: Policy | undefined;
    rec: Record<string, unknown>;
    code: string;
    listCalls: number;
  }> = [
    {
      name: "an mcp connection",
      kind: "mcp",
      rec: { service: "github" },
      code: "ERR_CONNECTOR_WRITES_AGENT_CLIENT",
      listCalls: 0,
    },
    {
      name: "an unknown connection",
      kind: "unknown",
      rec: { service: "github" },
      code: "ERR_CONNECTOR_WRITES_AGENT_CLIENT",
      listCalls: 0,
    },
    {
      name: "a bad wave",
      rec: { service: "github", wave: 5 },
      code: "ERR_CONNECTOR_WRITES_BAD_WAVE",
      listCalls: 0,
    },
    {
      name: "an unknown service",
      rec: { service: "nope" },
      code: "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE",
      listCalls: 0,
    },
    {
      name: "a workdir scope",
      rec: { service: "iac", workdirs: ["/x"] },
      code: "ERR_CONNECTOR_WRITES_AGENT_SCOPE",
      listCalls: 0,
    },
    {
      name: "a clouds scope",
      rec: { service: "iac", clouds: ["aws"] },
      code: "ERR_CONNECTOR_WRITES_AGENT_SCOPE",
      listCalls: 0,
    },
    {
      name: "a k8s grant scope",
      rec: { service: "kubernetes", k8sGrants: [] },
      code: "ERR_CONNECTOR_WRITES_AGENT_SCOPE",
      listCalls: 0,
    },
    {
      name: "an unreadable policy",
      policy: undefined,
      rec: { service: "github" },
      code: "ERR_CONNECTOR_WRITES_POLICY",
      listCalls: 0,
    },
    {
      name: "the model-access lockoff",
      policy: { capabilitiesDisabled: new Set(["connector_write_model_access"]) },
      rec: { service: "github" },
      code: "ERR_CONNECTOR_WRITES_POLICY",
      listCalls: 0,
    },
    {
      name: "the mcp action lockoff",
      policy: { capabilitiesDisabled: new Set(["mcp_action"]) },
      rec: { service: "github" },
      code: "ERR_CONNECTOR_WRITES_POLICY",
      listCalls: 0,
    },
    {
      name: "approve that is not a list of strings",
      rec: { service: "github", approve: [1] },
      code: "ERR_CONNECTOR_WRITES_BAD_APPROVE",
      listCalls: 0,
    },
    {
      name: "an approve pattern with a bare star",
      rec: { service: "github", approve: ["*"] },
      code: "ERR_CONNECTOR_WRITES_BAD_APPROVE",
      listCalls: 0,
    },
    {
      name: "an unknown door",
      rec: { service: "github", door: "robot" },
      code: "ERR_CONNECTOR_WRITES_BAD_DOOR",
      listCalls: 0,
    },
    {
      name: "an unlisted connector",
      rec: { service: "github" },
      code: "ERR_CONNECTOR_WRITES_AGENT_UNLISTED",
      listCalls: 1,
    },
    {
      name: "a pattern that matches nothing",
      rec: { service: "github", approve: ["zzz_*"] },
      code: "ERR_CONNECTOR_WRITES_AGENT_NO_MATCH",
      listCalls: 1,
    },
    {
      name: "nothing approvable",
      rec: { service: "github" },
      code: "ERR_CONNECTOR_WRITES_AGENT_NOTHING",
      listCalls: 1,
    },
  ];
  for (const c of cases) {
    test(`${c.name}: ${c.code}, no consent request, nothing written, ${c.listCalls} listing call(s)`, async () => {
      const r = rig({ kind: c.kind ?? "cli", ...("policy" in c ? { policy: c.policy } : {}) });
      if (c.code.endsWith("UNLISTED")) r.listing = undefined;
      if (c.code.endsWith("NOTHING")) r.listing = {};
      const msg = await refusal(handleConnectorWritesEnable({ ...AGENT, ...c.rec }, r.deps));
      expect(msg).toContain(c.code);
      expect(r.consent.requests).toBe(0);
      expect(r.listCalls).toHaveLength(c.listCalls);
      expect(listDoorApprovals(db, "agent")).toEqual([]);
      expect(
        getModelWriteEnablement(db, c.rec["service"] === "iac" ? "iac" : "github"),
      ).toBeUndefined();
      expect(auditCount()).toBe(0);
    });
  }

  test("a missing tool executor is refused before the listing", async () => {
    const r = rig({ noExecutor: true });
    expect(
      await refusal(handleConnectorWritesEnable({ ...AGENT, service: "github" }, r.deps)),
    ).toContain("requires a toolExecutor");
    expect(r.listCalls).toHaveLength(0);
  });
});

describe("agent enable: who may approve", () => {
  for (const kind of ["unknown", "mcp", "http", "chatops", "fleet", "push"] as const) {
    test(`${kind} is refused before any prompt`, async () => {
      const r = rig({ kind });
      expect(
        await refusal(handleConnectorWritesEnable({ ...AGENT, service: "github" }, r.deps)),
      ).toContain("ERR_CONNECTOR_WRITES_AGENT_CLIENT");
      expect(r.consent.requests).toBe(0);
    });
  }
  for (const kind of ["cli", "ui"] as const) {
    test(`${kind} reaches the prompt`, async () => {
      const r = rig({ kind });
      await handleConnectorWritesEnable({ ...AGENT, service: "github" }, r.deps);
      expect(r.consent.requests).toBe(1);
    });
  }
  for (const source of ["auto", "script", "unknown", "delegate", "remote", "none"] as const) {
    test(`an approval answered as ${source} writes nothing and says why`, async () => {
      const r = rig();
      r.consent.source = source;
      const msg = await refusal(
        handleConnectorWritesEnable({ ...AGENT, service: "github" }, r.deps),
      );
      expect(msg).toContain("ERR_CONNECTOR_WRITES_DECLINED");
      expect(msg).toContain("did not come from a person");
      expect(listDoorApprovals(db, "agent")).toEqual([]);
      expect(getModelWriteEnablement(db, "github")).toBeUndefined();
    });
  }
  test("a human decline writes nothing and uses the plain text", async () => {
    const r = rig();
    r.consent.approved = false;
    const msg = await refusal(handleConnectorWritesEnable({ ...AGENT, service: "github" }, r.deps));
    expect(msg).toContain("ERR_CONNECTOR_WRITES_DECLINED");
    expect(msg).not.toContain("did not come from a person");
    expect(listDoorApprovals(db, "agent")).toEqual([]);
    expect(getModelWriteEnablement(db, "github")).toBeUndefined();
  });
});

describe("agent enable: the prompt", () => {
  test("GitHub at wave 4 lists every approvable row with wave, typed confirmation, bound and the hash prefix", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 4 }, r.deps);
    const p = r.consent.prompts[0] ?? "";
    expect(p).toContain("Type: connector.writes.enable");
    expect(p).toContain("Service: github");
    expect(p).toContain("Up to wave: 4");
    expect(p).toContain("Door: outside agents (MCP)");
    expect(p).toContain(AGENT_DOOR_NOT_ENFORCED_NOTICE);
    expect(p).toContain("Each proposal still asks you, at `nimbus approvals`.");
    expect(p).toContain("An agent holding its own credentials can act without Nimbus.");
    const approved = listDoorApprovals(db, "agent", "github");
    expect(approved.length).toBeGreaterThan(5);
    const wave4 = CONNECTOR_WRITE_ROWS.filter(
      (row) => serviceOf(row.actionType) === "github" && row.wave === 4,
    );
    expect(wave4.length).toBeGreaterThan(0);
    for (const a of approved) {
      const line = p.split("\n").find((l) => l.trim().startsWith(`${a.toolId}  `));
      expect(line).toBeDefined();
      expect(line).toContain(a.definitionSha256.slice(0, 12));
      const row = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === a.toolId);
      expect(line).toContain(`wave ${row?.wave}`);
      expect(line?.includes("typed confirmation")).toBe(row?.wave === 4);
      expect(line?.includes("bound")).toBe(row?.bound !== undefined);
    }
    expect(approved.some((a) => a.toolId === "github_file_commit")).toBe(true);
    expect(p).toContain("  github_file_commit");
  });

  test("a control character in a tool id or description is escaped in the prompt", async () => {
    const r = rig();
    const evil = `github_x${String.fromCodePoint(0x1b)}[2J${String.fromCodePoint(0x202e)}`;
    const rows = [
      {
        toolId: evil,
        actionType: "github.issue.create",
        wave: 3,
        typedConfirm: false,
        bound: false,
        state: "will_be_approved",
        sha12: "0123456789ab",
      },
    ];
    const { enableWritesPromptLines } = await import(
      "../connectors/connector-writes/enable-prompt.ts"
    );
    const lines = enableWritesPromptLines({
      door: "agent",
      service: "github",
      maxWave: 3,
      writes: rows,
    });
    expect(lines).toBeDefined();
    const text = (lines ?? []).join("\n");
    expect(text).not.toContain(String.fromCodePoint(0x1b));
    expect(text).not.toContain(String.fromCodePoint(0x202e));
    expect(r.consent.requests).toBe(0);
  });

  test("a payload with door agent and a missing field renders undefined", async () => {
    const { enableWritesPromptLines } = await import(
      "../connectors/connector-writes/enable-prompt.ts"
    );
    const good = {
      toolId: "github_issue_create",
      actionType: "github.issue.create",
      wave: 3,
      typedConfirm: false,
      bound: false,
      state: "will_be_approved",
      sha12: "0123456789ab",
    };
    const ok = { door: "agent", service: "github", maxWave: 3, writes: [good] };
    expect(enableWritesPromptLines(ok)).toBeDefined();
    for (const bad of [
      { ...ok, service: undefined },
      { ...ok, maxWave: "3" },
      { ...ok, writes: "x" },
      { ...ok, writes: [{ ...good, typedConfirm: undefined }] },
      { ...ok, writes: [{ ...good, bound: "no" }] },
      { ...ok, writes: [{ ...good, state: "weird" }] },
      { ...ok, writes: [{ ...good, sha12: "xyz" }] },
      { ...ok, writes: [{ ...good, sha12: undefined }] },
      { ...ok, writes: [{ ...good, state: "not_approvable", sha12: undefined }] },
      { ...ok, writes: [{ ...good, state: "not_approvable", sha12: undefined, reason: 3 }] },
      { ...ok, writes: [null] },
      { ...ok, raisesSharedWaveFrom: "2" },
    ]) {
      expect(enableWritesPromptLines(bad as never)).toBeUndefined();
    }
    expect(
      enableWritesPromptLines({
        ...ok,
        writes: [{ ...good, state: "not_approvable", sha12: undefined, reason: "no\u0007 way" }],
      })?.join("\n"),
    ).toContain("not approvable (no");
  });

  test("the raised shared wave is stated, and so is a newly enabled one", async () => {
    const r = rig();
    setModelWriteEnablement(db, "github", 2, 5, []);
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 4 }, r.deps);
    expect(r.consent.prompts[0]).toContain(
      "This raises the shared wave for github from 2 to 4; the model is offered nothing new until you approve it by name.",
    );
    const r2 = rig({ service: "gitlab" });
    await handleConnectorWritesEnable({ ...AGENT, service: "gitlab", wave: 3 }, r2.deps);
    expect(r2.consent.prompts[0]).toContain("This enables the shared wave for gitlab at 3");
    const r3 = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r3.deps);
    expect(r3.consent.prompts[0]).not.toContain("raises the shared wave");
  });

  test("not approvable rows are shown with their reason, and already approved and re-approved states are told apart", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    // change one tool's description, and drop another from the listing
    const first = listDoorApprovals(db, "agent", "github");
    const changed = first[0]?.toolId ?? "";
    const dropped = first[1]?.toolId ?? "";
    r.listing = listingOf("github", (t) =>
      t === changed ? "a different description" : `desc ${t}`,
    );
    dropTool(r, dropped);
    r.consent.prompts.length = 0;
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    const p = r.consent.prompts[0] ?? "";
    const lineOf = (id: string) => p.split("\n").find((l) => l.trim().startsWith(`${id}  `)) ?? "";
    expect(lineOf(changed)).toContain("re-approved (definition changed)");
    expect(lineOf(dropped)).toContain("not approvable (the connector does not list this tool)");
    const unchanged = first[2]?.toolId ?? "";
    expect(lineOf(unchanged)).toContain("already approved");
    // a wave 4 row at wave 3 is not part of the list at all
    expect(p).not.toContain("github_file_commit");
  });
});

describe("agent enable: what is written", () => {
  test("one row per approvable tool with the hash of the listing shown, and the reply", async () => {
    const r = rig();
    const out = (await handleConnectorWritesEnable(
      { ...AGENT, service: "github", wave: 4 },
      r.deps,
    )) as {
      service: string;
      door: string;
      maxWave: number;
      approved: number;
      notice: string;
      writes: Array<{ toolId: string }>;
    };
    const rows = listDoorApprovals(db, "agent", "github");
    expect(out.door).toBe("agent");
    expect(out.service).toBe("github");
    expect(out.maxWave).toBe(4);
    expect(out.approved).toBe(rows.length);
    expect(out.notice).toBe(AGENT_DOOR_NOT_ENFORCED_NOTICE);
    for (const a of rows) {
      const entry = r.listing?.[mcpClientToolKey("github", a.toolId)];
      expect(a.definitionSha256).toBe(definitionSha256(a.toolId, entry) as string);
      expect(a.approvedAt).toBe(1_000);
      expect(a.suspendedAt).toBeNull();
    }
  });

  test("the V83 row is created with an empty model set, the model's set is kept byte for byte, and the wave is never lowered", async () => {
    const r = rig();
    setModelWriteEnablement(db, "github", 2, 5, ["github_issue_create", "github_pr_close"]);
    const before = db
      .query("SELECT * FROM connector_write_enablement WHERE service = 'github'")
      .get();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 4 }, r.deps);
    const after = db
      .query(
        "SELECT service, max_wave, enabled_at, approved_tool_ids FROM connector_write_enablement WHERE service = 'github'",
      )
      .get() as { max_wave: number; enabled_at: number; approved_tool_ids: string };
    expect(after.max_wave).toBe(4);
    expect(after.approved_tool_ids).toBe(
      (before as { approved_tool_ids: string }).approved_tool_ids,
    );
    expect(after.enabled_at).toBe((before as { enabled_at: number }).enabled_at);
    // lowering: a later agent enable at wave 2 keeps 4
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 2 }, r.deps);
    expect(getModelWriteEnablement(db, "github")?.maxWave).toBe(4);
    // a service with no row gets one with an empty set
    const r2 = rig({ service: "gitlab" });
    await handleConnectorWritesEnable({ ...AGENT, service: "gitlab", wave: 3 }, r2.deps);
    expect(getModelWriteEnablement(db, "gitlab")?.approvedToolIds.size).toBe(0);
    expect(getModelWriteEnablement(db, "gitlab")?.maxWave).toBe(3);
  });

  test("with approve patterns only the matching rows change and the others keep their approval time", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    const first = listDoorApprovals(db, "agent", "github");
    r.deps = { ...r.deps, now: () => 9_000 };
    await handleConnectorWritesEnable(
      { ...AGENT, service: "github", wave: 3, approve: ["github_pr_*"] },
      r.deps,
    );
    const second = listDoorApprovals(db, "agent", "github");
    expect(second.map((x) => x.toolId)).toEqual(first.map((x) => x.toolId));
    for (const a of second) {
      expect(a.approvedAt).toBe(a.toolId.startsWith("github_pr_") ? 9_000 : 1_000);
    }
    // an exact id also matches
    await handleConnectorWritesEnable(
      { ...AGENT, service: "github", wave: 3, approve: ["github_issue_create"] },
      { ...r.deps, now: () => 12_000 },
    );
    expect(
      listDoorApprovals(db, "agent", "github").find((x) => x.toolId === "github_issue_create")
        ?.approvedAt,
    ).toBe(12_000);
  });

  test("without approve the list is replaced whole: a tool no longer approvable is dropped", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    const dropped = listDoorApprovals(db, "agent", "github")[0]?.toolId ?? "";
    dropTool(r, dropped);
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    expect(listDoorApprovals(db, "agent", "github").some((x) => x.toolId === dropped)).toBe(false);
  });

  test("re-approving a suspended tool by name clears the suspension", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    const id = "github_issue_create";
    expect(
      markDoorToolSuspended(db, "agent", "github", id, approvedShaOf(id), "a".repeat(64), 5),
    ).toBe(true);
    r.listing = listingOf("github", (t) => (t === id ? "changed" : `desc ${t}`));
    await handleConnectorWritesEnable(
      { ...AGENT, service: "github", wave: 3, approve: [id] },
      r.deps,
    );
    const row = listDoorApprovals(db, "agent", "github").find((x) => x.toolId === id);
    expect(row?.suspendedAt).toBeNull();
    expect(row?.suspendedSha256).toBeNull();
    expect(row?.definitionSha256).toBe(
      definitionSha256(id, r.listing[mcpClientToolKey("github", id)]) as string,
    );
  });

  test("a failure between the two writes rolls both back (one transaction)", async () => {
    const r = rig();
    db.run(
      "CREATE TRIGGER boom BEFORE INSERT ON connector_write_door_approval BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    await expect(
      handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 4 }, r.deps),
    ).rejects.toThrow();
    expect(getModelWriteEnablement(db, "github")).toBeUndefined();
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });

  test("a decline writes nothing", async () => {
    const r = rig();
    r.consent.approved = false;
    await refusal(handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 4 }, r.deps));
    expect(getModelWriteEnablement(db, "github")).toBeUndefined();
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });
});

describe("the model is offered nothing new", () => {
  test("after an agent enable at wave 4 over a model opt-in at wave 2 the offer is the same and a wave 4 row is not rechecked true", async () => {
    const modelApproved = writesEnabledBy("github", 2)
      .filter((x) => x.wave <= 2)
      .map((x) => x.toolId);
    setModelWriteEnablement(db, "github", 2, 5, modelApproved);
    const mk = () =>
      createModelWriteToolSource({
        db,
        enforcedPolicy: () => OPEN as unknown as EnforcedPolicy,
        listServerTools: async () => undefined,
        toolsEpoch: () => 0,
        warn: () => {},
        approvedWorkdirs: () => [],
        approvedK8sPairs: () => [],
      });
    const before = mk()
      .offerableEnabledRows()
      .map((x) => x.toolId);
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 4 }, r.deps);
    const after = mk()
      .offerableEnabledRows()
      .map((x) => x.toolId);
    expect(after).toEqual(before);
    const wave4 = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === "github_file_commit");
    expect(wave4).toBeDefined();
    expect(mk().recheck(wave4 as never)).toBe(false);
  });
});

describe("agent enable: scope", () => {
  async function approvedIds(service: string): Promise<string[]> {
    const r = rig({ service });
    await handleConnectorWritesEnable({ ...AGENT, service, wave: 4 }, r.deps).catch(() => {});
    return listDoorApprovals(db, "agent", service).map((a) => a.toolId);
  }

  test("a Terraform apply is not approvable without an approved directory", async () => {
    expect(await approvedIds("iac")).not.toContain("iac_terraform_apply");
  });

  test("a Terraform apply is approvable once the owner approved a directory", async () => {
    setIacGrants(db, { workdirs: ["/work/tf"], clouds: ["aws"], regions: [], net: [] }, 1);
    expect(await approvedIds("iac")).toContain("iac_terraform_apply");
  });

  test("a Kubernetes row is approvable only with an approved (context, namespace) pair", async () => {
    expect(await approvedIds("kubernetes")).toEqual([]);
    setK8sGrants(
      db,
      [{ context: "c1", namespace: "app", server: "h:443", credentialForm: "token" }],
      1,
    );
    expect(await approvedIds("kubernetes")).toContain("k8s_deployment_scale");
  });
});

describe("agent enable: Obsidian", () => {
  test("the append is approvable only while the model-door approval exists", async () => {
    const r = rig({ service: "obsidian" });
    await handleConnectorWritesEnable({ ...AGENT, service: "obsidian", wave: 3 }, r.deps).catch(
      () => {},
    );
    const without = r.consent.prompts[0] ?? "";
    const wl =
      without.split("\n").find((l) => l.trim().startsWith(`${OBSIDIAN_APPEND_TOOL_ID}  `)) ?? "";
    expect(wl === "" || wl.includes("not approvable")).toBe(true);
    expect(
      listDoorApprovals(db, "agent", "obsidian").some((a) => a.toolId === OBSIDIAN_APPEND_TOOL_ID),
    ).toBe(false);
    setModelWriteEnablement(db, "obsidian", 3, 1, [OBSIDIAN_APPEND_TOOL_ID]);
    const r2 = rig({ service: "obsidian" });
    await handleConnectorWritesEnable({ ...AGENT, service: "obsidian", wave: 3 }, r2.deps);
    expect(
      listDoorApprovals(db, "agent", "obsidian").some((a) => a.toolId === OBSIDIAN_APPEND_TOOL_ID),
    ).toBe(true);
    // the agent approval does not widen the sandbox: no widening lines in the agent prompt
    expect(r2.consent.prompts[0]).not.toContain("sandbox WRITE");
  });
});

describe("the Slack DM row is unreachable by an agent", () => {
  test("slack_message_post_dm is not approvable and slack_message_post is", async () => {
    const r = rig({ service: "slack" });
    await handleConnectorWritesEnable({ ...AGENT, service: "slack", wave: 3 }, r.deps);
    const ids = listDoorApprovals(db, "agent", "slack").map((a) => a.toolId);
    expect(ids).toContain("slack_message_post");
    expect(ids).not.toContain("slack_message_post_dm");
  });
});

describe("disable", () => {
  test("plain disable removes the V83 row and the agent rows; both are idempotent", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    expect((await handleConnectorWritesDisable({ service: "github" }, r.deps)).removed).toBe(true);
    expect(getModelWriteEnablement(db, "github")).toBeUndefined();
    expect(listDoorApprovals(db, "agent")).toEqual([]);
    expect((await handleConnectorWritesDisable({ service: "github" }, r.deps)).removed).toBe(false);
  });

  test("door agent removes only the agent rows and leaves V83 alone", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    const before = db
      .query("SELECT * FROM connector_write_enablement WHERE service = 'github'")
      .get();
    expect(
      (await handleConnectorWritesDisable({ service: "github", door: "agent" }, r.deps)).removed,
    ).toBe(true);
    expect(listDoorApprovals(db, "agent")).toEqual([]);
    expect(
      db.query("SELECT * FROM connector_write_enablement WHERE service = 'github'").get(),
    ).toEqual(before as never);
    expect(
      (await handleConnectorWritesDisable({ service: "github", door: "agent" }, r.deps)).removed,
    ).toBe(false);
  });

  test("a plain disable of a service with only agent rows reports the removal", async () => {
    const r = rig();
    upsertDoorApprovals(
      db,
      "agent",
      "github",
      [{ toolId: "github_issue_create", definitionSha256: "b".repeat(64) }],
      1,
    );
    expect((await handleConnectorWritesDisable({ service: "github" }, r.deps)).removed).toBe(true);
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });

  test("an unknown door is refused", async () => {
    const r = rig();
    expect(
      await refusal(handleConnectorWritesDisable({ service: "github", door: "x" }, r.deps)),
    ).toContain("ERR_CONNECTOR_WRITES_BAD_DOOR");
  });
});

describe("the model path is unchanged", () => {
  test("a model enable (no door, or door model) does not read the listing and replies as before", async () => {
    const r = rig();
    const out = await handleConnectorWritesEnable({ service: "github", wave: 3 }, r.deps);
    expect(out).toEqual({
      service: "github",
      maxWave: 3,
      writes: writesEnabledBy("github", 3).length,
    });
    const out2 = await handleConnectorWritesEnable(
      { service: "github", wave: 3, door: "model" },
      r.deps,
    );
    expect(out2).toEqual(out);
    expect(r.listCalls).toEqual([]);
    expect(listDoorApprovals(db, "agent")).toEqual([]);
  });

  test("a model enable with approve is refused", async () => {
    const r = rig();
    expect(
      await refusal(handleConnectorWritesEnable({ service: "github", approve: ["x"] }, r.deps)),
    ).toContain("ERR_CONNECTOR_WRITES_BAD_APPROVE");
  });
});

describe("agent status", () => {
  async function approved(): Promise<Rig> {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    r.listCalls.length = 0;
    return r;
  }

  test("no approvals: the notice, the exact command, no service, no listing", async () => {
    const r = rig();
    const s = await handleAgentWritesStatus(r.deps);
    expect(s.services).toEqual([]);
    expect(s.notice).toBe(AGENT_DOOR_NOT_ENFORCED_NOTICE);
    expect(s.hint).toContain("nimbus connector writes enable <service> --door agent");
    expect(s.policyAllows).toBe(true);
    expect(r.listCalls).toEqual([]);
  });

  test("an unchanged tool is counted and not suspended; only services with approvals are listed", async () => {
    const r = await approved();
    const total = listDoorApprovals(db, "agent", "github").length;
    const base = auditCount();
    const s = await handleAgentWritesStatus(r.deps);
    expect(r.listCalls).toEqual(["github"]);
    expect(s.hint).toBeUndefined();
    expect(s.services).toEqual([{ service: "github", approved: total, suspended: [] }]);
    expect(auditCount()).toBe(base);
  });

  test("a changed description suspends the tool, with both prefixes, one audit row, sticky", async () => {
    const r = await approved();
    const id = "github_issue_create";
    const approvedSha = listDoorApprovals(db, "agent", "github").find((x) => x.toolId === id)
      ?.definitionSha256 as string;
    const base = auditCount();
    r.listing = listingOf("github", (t) => (t === id ? "changed by one byte!" : `desc ${t}`));
    const s = await handleAgentWritesStatus(r.deps);
    const changedSha = definitionSha256(id, r.listing[mcpClientToolKey("github", id)]) as string;
    const svc = s.services[0];
    expect(svc?.suspended).toEqual([
      {
        toolId: id,
        approvedAt: 1_000,
        approvedSha12: approvedSha.slice(0, 12),
        nowSha12: changedSha.slice(0, 12),
      },
    ]);
    const row = listDoorApprovals(db, "agent", "github").find((x) => x.toolId === id);
    expect(row?.suspendedAt).not.toBeNull();
    expect(row?.suspendedSha256).toBe(changedSha);
    expect(auditCount()).toBe(base + 1);
    const audit = db
      .query("SELECT action_type, hitl_status, action_json FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { action_type: string; hitl_status: string; action_json: string };
    expect(audit.action_type).toBe("connector.writes.agent.suspend");
    expect(audit.hitl_status).toBe("not_required");
    expect(JSON.parse(audit.action_json)).toEqual({
      service: "github",
      toolId: id,
      approvedSha12: approvedSha.slice(0, 12),
      nowSha12: changedSha.slice(0, 12),
    });
    // a second status writes no second audit row
    await handleAgentWritesStatus(r.deps);
    expect(auditCount()).toBe(base + 1);
    // restoring the description does not un-suspend (sticky)
    r.listing = listingOf("github");
    const again = await handleAgentWritesStatus(r.deps);
    expect(again.services[0]?.suspended.map((x) => x.toolId)).toEqual([id]);
    expect(again.services[0]?.suspended[0]?.nowSha12).toBe(changedSha.slice(0, 12));
    expect(auditCount()).toBe(base + 1);
  });

  test("a tool dropped from a listing that arrives is suspended with a null hash and reported no longer listed", async () => {
    const r = await approved();
    const id = "github_issue_create";
    dropTool(r, id);
    const s = await handleAgentWritesStatus(r.deps);
    const sus = s.services[0]?.suspended.find((x) => x.toolId === id);
    expect(sus?.nowSha12).toBeNull();
    expect(sus?.reason).toBe("no longer listed");
    const row = listDoorApprovals(db, "agent", "github").find((x) => x.toolId === id);
    expect(row?.suspendedAt).not.toBeNull();
    expect(row?.suspendedSha256).toBeNull();
  });

  test("a tool whose schema becomes unreadable is suspended the same way", async () => {
    const r = await approved();
    const id = "github_issue_create";
    (r.listing ?? {})[mcpClientToolKey("github", id)] = { description: "d", inputSchema: 42 };
    const s = await handleAgentWritesStatus(r.deps);
    const sus = s.services[0]?.suspended.find((x) => x.toolId === id);
    expect(sus?.nowSha12).toBeNull();
    expect(sus?.reason).toBe("its input schema can no longer be read");
  });

  test("a service whose listing is undefined is unverified and nothing is marked", async () => {
    const r = await approved();
    r.listing = undefined;
    const base = auditCount();
    const s = await handleAgentWritesStatus(r.deps);
    expect(s.services[0]?.unverified).toBe("its tools could not be listed");
    expect(s.services[0]?.suspended).toEqual([]);
    expect(listDoorApprovals(db, "agent", "github").every((x) => x.suspendedAt === null)).toBe(
      true,
    );
    expect(auditCount()).toBe(base);
  });

  test("a tool re-approved while the listing is awaited is not marked suspended from the old snapshot", async () => {
    const r = await approved();
    const id = "github_issue_create";
    const base = auditCount();
    // The listing the old approval disagrees with; the owner re-approves against it during the await.
    const changed = listingOf("github", (t) => (t === id ? "changed by one byte!" : `desc ${t}`));
    const newSha = definitionSha256(id, changed[mcpClientToolKey("github", id)]) as string;
    r.deps = {
      ...r.deps,
      listServerTools: async () => {
        upsertDoorApprovals(
          db,
          "agent",
          "github",
          [{ toolId: id, definitionSha256: newSha }],
          2_000,
        );
        return changed;
      },
    };
    const s = await handleAgentWritesStatus(r.deps);
    const row = listDoorApprovals(db, "agent", "github").find((x) => x.toolId === id);
    expect(row?.definitionSha256).toBe(newSha);
    expect(row?.suspendedAt).toBeNull();
    expect(s.services[0]?.suspended.map((x) => x.toolId)).not.toContain(id);
    expect(auditCount()).toBe(base);
  });

  test("a failing audit append leaves the tool unsuspended, and a later status marks it and writes the row", async () => {
    const r = await approved();
    const id = "github_issue_create";
    r.listing = listingOf("github", (t) => (t === id ? "changed by one byte!" : `desc ${t}`));
    const base = auditCount();
    db.run(
      "CREATE TRIGGER audit_boom BEFORE INSERT ON audit_log WHEN NEW.action_type = 'connector.writes.agent.suspend' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    await expect(handleAgentWritesStatus(r.deps)).rejects.toThrow();
    const row = () => listDoorApprovals(db, "agent", "github").find((x) => x.toolId === id);
    expect(row()?.suspendedAt).toBeNull();
    expect(auditCount()).toBe(base);
    db.run("DROP TRIGGER audit_boom");
    const s = await handleAgentWritesStatus(r.deps);
    expect(row()?.suspendedAt).not.toBeNull();
    expect(s.services[0]?.suspended.map((x) => x.toolId)).toEqual([id]);
    expect(auditCount()).toBe(base + 1);
  });

  test("a listing that rejects makes that service unverified and the next service is still checked", async () => {
    const r = await approved();
    await handleConnectorWritesEnable(
      { ...AGENT, service: "slack", wave: 3 },
      {
        ...r.deps,
        listServerTools: async () => listingOf("slack"),
      },
    );
    const slackId = listDoorApprovals(db, "agent", "slack")[0]?.toolId as string;
    const base = auditCount();
    const listed: string[] = [];
    r.deps = {
      ...r.deps,
      listServerTools: async (service: string) => {
        listed.push(service);
        if (service === "github") throw new Error("connector down");
        return listingOf("slack", (t) => (t === slackId ? "changed by one byte!" : `desc ${t}`));
      },
    };
    const s = await handleAgentWritesStatus(r.deps);
    expect(listed).toEqual(["github", "slack"]);
    const gh = s.services.find((x) => x.service === "github");
    expect(gh?.unverified).toBe("its tools could not be listed");
    expect(gh?.suspended).toEqual([]);
    expect(listDoorApprovals(db, "agent", "github").every((x) => x.suspendedAt === null)).toBe(
      true,
    );
    const sl = s.services.find((x) => x.service === "slack");
    expect(sl?.suspended.map((x) => x.toolId)).toEqual([slackId]);
    expect(auditCount()).toBe(base + 1);
  });

  test("every reply carries the notice and the policy; services and policyAllows of the model part are untouched", async () => {
    const r = await approved();
    const s = await handleAgentWritesStatus(r.deps);
    expect(s.notice).toBe(AGENT_DOOR_NOT_ENFORCED_NOTICE);
    const locked = rig({ policy: { capabilitiesDisabled: new Set(["mcp_action"]) } });
    expect((await handleAgentWritesStatus(locked.deps)).policyAllows).toBe(false);
    const model = handleConnectorWritesStatus(r.deps);
    expect(model.policyAllows).toBe(true);
    expect(Object.keys(model).sort()).toEqual(["policyAllows", "services"]);
  });

  test("a marked tool is reported from the stored columns without a second observation", async () => {
    const r = await approved();
    dbRun(db, "UPDATE connector_write_enablement SET max_wave = max_wave WHERE 0", []);
    markDoorToolSuspended(
      db,
      "agent",
      "github",
      "github_issue_create",
      approvedShaOf("github_issue_create"),
      "c".repeat(64),
      50,
    );
    const base = auditCount();
    const s = await handleAgentWritesStatus(r.deps);
    expect(s.services[0]?.suspended[0]?.nowSha12).toBe("c".repeat(12));
    expect(auditCount()).toBe(base);
  });
});

describe("the not-enforced notice (removed by AD3a-2 on purpose)", () => {
  test("the enable prompt, the enable reply and status all carry the one constant", async () => {
    const r = rig();
    const reply = (await handleConnectorWritesEnable(
      { ...AGENT, service: "github", wave: 3 },
      r.deps,
    )) as { notice: string };
    const status = await handleAgentWritesStatus(r.deps);
    expect(AGENT_DOOR_NOT_ENFORCED_NOTICE).toContain("takes effect in a later release");
    expect(r.consent.prompts[0]).toContain(AGENT_DOOR_NOT_ENFORCED_NOTICE);
    expect(reply.notice).toBe(AGENT_DOOR_NOT_ENFORCED_NOTICE);
    expect(status.notice).toBe(AGENT_DOOR_NOT_ENFORCED_NOTICE);
  });
});

describe("connector.writesStatus through the RPC", () => {
  test("the model's two members are exactly what handleConnectorWritesStatus returns, plus an agent member", async () => {
    const r = rig();
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    const { dispatchConnectorRpc } = await import("./connector-rpc.ts");
    const { createMockVault } = await import("../vault/mock.ts");
    const hit = await dispatchConnectorRpc({
      method: "connector.writesStatus",
      params: {},
      vault: createMockVault(),
      localIndex,
      openUrl: async () => {},
      syncScheduler: undefined,
      getEnforcedPolicy: () => OPEN as never,
    });
    expect(hit.kind).toBe("hit");
    const value = (hit as { value: Record<string, unknown> }).value;
    const model = handleConnectorWritesStatus(r.deps);
    // (the RPC also reads the Gmail credential's scopes, so compare a service that does not depend on them)
    const only = (v: unknown) =>
      (v as Array<{ service: string }>).find((x) => x.service === "github");
    expect(only(value["services"])).toEqual(only(model.services) as never);
    expect(value["policyAllows"]).toBe(model.policyAllows);
    const agent = value["agent"] as { services: Array<{ unverified?: string }> };
    // no mesh in this call, so the listing cannot be made: unverified, nothing marked
    expect(agent.services[0]?.unverified).toBe("its tools could not be listed");
  });
});

describe("agent enable: the credential's scopes and a restricted row table", () => {
  test("a scope-gated write is not approvable while the credential lacks the scope", async () => {
    const r = rig({ service: "gmail" });
    r.deps = {
      ...r.deps,
      grantedScopes: { gmail: "https://www.googleapis.com/auth/gmail.readonly" },
    };
    await handleConnectorWritesEnable({ ...AGENT, service: "gmail", wave: 2 }, r.deps).catch(
      () => {},
    );
    expect(
      listDoorApprovals(db, "agent", "gmail").some((a) => a.toolId === "gmail_thread_archive"),
    ).toBe(false);
    r.deps = {
      ...r.deps,
      grantedScopes: { gmail: "https://www.googleapis.com/auth/gmail.modify" },
    };
    await handleConnectorWritesEnable({ ...AGENT, service: "gmail", wave: 2 }, r.deps);
    expect(
      listDoorApprovals(db, "agent", "gmail").some((a) => a.toolId === "gmail_thread_archive"),
    ).toBe(true);
  });

  test("the row-table seam restricts both the service check and the rows", async () => {
    const only = CONNECTOR_WRITE_ROWS.filter((x) => x.toolId === "github_issue_create");
    const r = rig();
    r.deps = { ...r.deps, rows: only };
    await handleConnectorWritesEnable({ ...AGENT, service: "github", wave: 3 }, r.deps);
    expect(listDoorApprovals(db, "agent", "github").map((a) => a.toolId)).toEqual([
      "github_issue_create",
    ]);
    expect(
      await refusal(handleConnectorWritesEnable({ ...AGENT, service: "gitlab" }, r.deps)),
    ).toContain("ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE");
  });

  test("without a listing function the connector counts as not listed", async () => {
    const r = rig();
    const { listServerTools: _drop, ...rest } = r.deps;
    expect(
      await refusal(handleConnectorWritesEnable({ ...AGENT, service: "github" }, rest as never)),
    ).toContain("ERR_CONNECTOR_WRITES_AGENT_UNLISTED");
  });
});
