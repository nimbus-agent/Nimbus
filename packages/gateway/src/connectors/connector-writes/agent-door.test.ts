import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { serviceOf } from "../../engine/service-of.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { PROPOSABLE_WRITE_TOOLS } from "../proposable-actions.ts";
import {
  AGENT_DOOR_TYPE_TIEBREAK,
  type AgentApprovableContext,
  agentApprovableRows,
  agentDoorPolicyAllows,
  agentDoorRow,
} from "./agent-door.ts";
import {
  modelWriteServices,
  OBSIDIAN_APPEND_TOOL_ID,
  offerableWritesEnabledBy,
  setModelWriteEnablement,
  writesEnabledBy,
} from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_REASONS } from "./model-offerable.ts";
import { createModelWriteToolSource, enabledAndOfferable } from "./model-write-source.ts";
import type { ConnectorWriteRow, ConnectorWriteWave } from "./types.ts";

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

function listedEntry(): unknown {
  return {
    description: "d",
    inputSchema: toStandardSchema({ type: "object", properties: {} } as JsonSchemaInput),
  };
}

function listingFor(
  service: string,
  rows: readonly ConnectorWriteRow[] = CONNECTOR_WRITE_ROWS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    if (serviceOf(r.actionType) === service)
      out[mcpClientToolKey(service, r.toolId)] = listedEntry();
  }
  return out;
}

function fullCtx(
  service: string,
  over: Partial<AgentApprovableContext> = {},
): AgentApprovableContext {
  return {
    listed: listingFor(service),
    approvedWorkdirs: ["/work"],
    approvedK8sPairs: [{ context: "c", namespace: "n" }],
    obsidianModelGrant: true,
    ...over,
  };
}

const WAVES: readonly ConnectorWriteWave[] = [2, 3, 4];
const TYPES = [...new Set(CONNECTOR_WRITE_ROWS.map((r) => r.actionType))];

describe("agentDoorRow", () => {
  test("is total: every action type in the table resolves to a row of that type", () => {
    for (const t of TYPES) expect(agentDoorRow(t)?.actionType, t).toBe(t);
  });

  test("every multi-row type has a tie-break entry, equal to the proposable routing where both exist", () => {
    const multi = TYPES.filter(
      (t) => CONNECTOR_WRITE_ROWS.filter((r) => r.actionType === t).length > 1,
    );
    expect(multi.length).toBeGreaterThan(0);
    for (const t of multi) {
      expect(Object.hasOwn(AGENT_DOOR_TYPE_TIEBREAK, t), t).toBe(true);
      expect(agentDoorRow(t)?.toolId, t).toBe(AGENT_DOOR_TYPE_TIEBREAK[t] as string);
      if (Object.hasOwn(PROPOSABLE_WRITE_TOOLS, t)) {
        expect(AGENT_DOOR_TYPE_TIEBREAK[t], t).toBe(PROPOSABLE_WRITE_TOOLS[t] as string);
      }
    }
    expect(Object.keys(AGENT_DOOR_TYPE_TIEBREAK).sort()).toEqual([...multi].sort());
  });

  test("a multi-row type with no tie-break resolves to nothing", () => {
    const a = { ...CONNECTOR_WRITE_ROWS[0], toolId: "fake_a", actionType: "fake.type" };
    const b = { ...CONNECTOR_WRITE_ROWS[0], toolId: "fake_b", actionType: "fake.type" };
    expect(agentDoorRow("fake.type", [a, b] as ConnectorWriteRow[])).toBeUndefined();
    expect(agentDoorRow("nope.nothing")).toBeUndefined();
  });

  test("slack_message_post_dm is the only model-offerable row no type routes to", () => {
    const unreachable = CONNECTOR_WRITE_ROWS.filter(
      (r) => isModelOfferableRow(r) && agentDoorRow(r.actionType) !== r,
    ).map((r) => r.toolId);
    expect(unreachable).toEqual(["slack_message_post_dm"]);
  });

  test("every proposable type routes to the tool the proposable routing table names", () => {
    for (const [type, tool] of Object.entries(PROPOSABLE_WRITE_TOOLS)) {
      const row = agentDoorRow(type);
      if (row !== undefined) expect(row.toolId, type).toBe(tool);
    }
    // And the two tables are not disjoint: the check above did compare something.
    expect(Object.keys(PROPOSABLE_WRITE_TOOLS).some((t) => agentDoorRow(t) !== undefined)).toBe(
      true,
    );
  });
});

describe("agentApprovableRows", () => {
  test("for every service and wave the approvable set is the offerable set minus the unroutable rows", () => {
    for (const service of modelWriteServices()) {
      for (const wave of WAVES) {
        const got = agentApprovableRows(service, wave, fullCtx(service))
          .filter((r) => r.state === "approvable")
          .map((r) => r.row.toolId)
          .sort();
        const want = offerableWritesEnabledBy(service, wave)
          .filter((r) => agentDoorRow(r.actionType) === r)
          .map((r) => r.toolId)
          .sort();
        expect(got, `${service}@${String(wave)}`).toEqual(want);
      }
    }
  });

  test("covers every row the enable covers, approvable or not, in table order", () => {
    const got = agentApprovableRows("github", 4, fullCtx("github")).map((r) => r.row.toolId);
    expect(got).toEqual(writesEnabledBy("github", 4).map((r) => r.toolId));
  });

  test("a Wave 4 row appears as approvable only at wave 4", () => {
    const wave4 = CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 4 && isModelOfferableRow(r));
    expect(wave4.length).toBeGreaterThan(0);
    const w4Row = wave4.find((r) => agentDoorRow(r.actionType) === r) as ConnectorWriteRow;
    const service = serviceOf(w4Row.actionType);
    const ids = (wave: ConnectorWriteWave): string[] =>
      agentApprovableRows(service, wave, fullCtx(service))
        .filter((r) => r.state === "approvable")
        .map((r) => r.row.toolId);
    expect(ids(4)).toContain(w4Row.toolId);
    expect(ids(3)).not.toContain(w4Row.toolId);
    expect(ids(2)).not.toContain(w4Row.toolId);
  });

  test("each never-offered row is not approvable with its recorded reason, the seven sends with the agent text", () => {
    for (const [toolId, reason] of Object.entries(MODEL_NEVER_OFFERED_REASONS)) {
      const row = CONNECTOR_WRITE_ROWS.find((r) => r.toolId === toolId);
      if (row === undefined) continue;
      const service = serviceOf(row.actionType);
      const got = agentApprovableRows(service, 4, fullCtx(service)).find((r) => r.row === row);
      expect(got, toolId).toEqual({ row, state: "not_approvable", reason });
    }
    const sends = Object.entries(MODEL_NEVER_OFFERED_REASONS).filter(([id]) =>
      id.endsWith("_send"),
    );
    expect(sends).toHaveLength(7);
    for (const [, reason] of sends)
      expect(reason).toContain("never offered to agents or the model");
  });

  test("a tool missing from a listing that arrived, and a listing that did not arrive", () => {
    const rows = writesEnabledBy("github", 2);
    const target = rows.find((r) => isModelOfferableRow(r)) as ConnectorWriteRow;
    const listed = listingFor("github");
    delete listed[mcpClientToolKey("github", target.toolId)];
    const missing = agentApprovableRows("github", 2, fullCtx("github", { listed })).find(
      (r) => r.row === target,
    );
    expect(missing).toMatchObject({ state: "not_approvable" });
    const none = agentApprovableRows("github", 2, fullCtx("github", { listed: undefined })).find(
      (r) => r.row === target,
    );
    expect(none).toMatchObject({ state: "not_approvable" });
    expect((none as { reason: string }).reason).not.toBe((missing as { reason: string }).reason);
  });

  test("a tool whose schema cannot be read is not approvable", () => {
    const target = writesEnabledBy("github", 2).find((r) =>
      isModelOfferableRow(r),
    ) as ConnectorWriteRow;
    const listed = {
      ...listingFor("github"),
      [mcpClientToolKey("github", target.toolId)]: { description: "d", inputSchema: "garbage" },
    };
    const got = agentApprovableRows("github", 2, fullCtx("github", { listed })).find(
      (r) => r.row === target,
    );
    expect(got).toMatchObject({ state: "not_approvable" });
  });

  test("the approvable entry carries the hash of its own listing entry", () => {
    const got = agentApprovableRows("github", 2, fullCtx("github")).find(
      (r) => r.state === "approvable",
    );
    expect(got?.state === "approvable" && /^[0-9a-f]{64}$/.test(got.definitionSha256)).toBe(true);
  });

  test("the Obsidian append follows the model-door approval (OD-4)", () => {
    const without = agentApprovableRows(
      "obsidian",
      4,
      fullCtx("obsidian", { obsidianModelGrant: false }),
    );
    const withGrant = agentApprovableRows("obsidian", 4, fullCtx("obsidian"));
    const pick = (rs: readonly { row: ConnectorWriteRow; state: string }[]) =>
      rs.find((r) => r.row.toolId === OBSIDIAN_APPEND_TOOL_ID)?.state;
    expect(pick(without)).toBe("not_approvable");
    expect(pick(withGrant)).toBe("approvable");
  });

  test("a Terraform row needs an approved directory and every Kubernetes row an approved pair", () => {
    const tf = CONNECTOR_WRITE_ROWS.find(
      (r) => r.bound?.prepare.settle === "iac-terraform" && isModelOfferableRow(r),
    );
    expect(tf).toBeDefined();
    const tfService = serviceOf((tf as ConnectorWriteRow).actionType);
    const state = (ctx: AgentApprovableContext) =>
      agentApprovableRows(tfService, 4, ctx).find((r) => r.row === tf)?.state;
    expect(state(fullCtx(tfService, { approvedWorkdirs: [] }))).toBe("not_approvable");
    expect(state(fullCtx(tfService))).toBe("approvable");
    const kube = writesEnabledBy("kubernetes", 4).filter((r) => isModelOfferableRow(r));
    expect(kube.length).toBeGreaterThan(0);
    const none = agentApprovableRows(
      "kubernetes",
      4,
      fullCtx("kubernetes", { approvedK8sPairs: [] }),
    );
    for (const k of kube)
      expect(none.find((r) => r.row === k)?.state, k.toolId).toBe("not_approvable");
  });

  test("a scope-gated write is not approvable while the credential lacks its scope", () => {
    const lacking = agentApprovableRows(
      "gmail",
      4,
      fullCtx("gmail", { grantedScopes: { gmail: "x" } }),
    );
    expect(lacking.find((r) => r.row.toolId === "gmail_thread_archive")).toMatchObject({
      state: "not_approvable",
      reason: "re-authorise Gmail to grant gmail.modify",
    });
    const held = agentApprovableRows(
      "gmail",
      4,
      fullCtx("gmail", {
        grantedScopes: { gmail: "https://www.googleapis.com/auth/gmail.modify" },
      }),
    );
    expect(held.find((r) => r.row.toolId === "gmail_thread_archive")?.state).toBe("approvable");
  });

  test("the Slack DM row is not approvable and says why", () => {
    const got = agentApprovableRows("slack", 4, fullCtx("slack")).find(
      (r) => r.row.toolId === "slack_message_post_dm",
    );
    expect(got).toMatchObject({ state: "not_approvable" });
  });
});

describe("enabledAndOfferable (the shared conditions factored out of offeredUnder)", () => {
  const inline = (
    e: { service: string; maxWave: ConnectorWriteWave } | undefined,
    row: ConnectorWriteRow,
  ): boolean =>
    e !== undefined &&
    serviceOf(row.actionType) === e.service &&
    row.wave <= e.maxWave &&
    isModelOfferableRow(row);

  test("equals the old inline formula for every row against a table of enablements", () => {
    const enablements = [
      undefined,
      { service: "github", maxWave: 2 as const },
      { service: "github", maxWave: 4 as const },
      { service: "slack", maxWave: 3 as const },
      { service: "kubernetes", maxWave: 4 as const },
    ];
    for (const e of enablements) {
      for (const r of CONNECTOR_WRITE_ROWS) expect(enabledAndOfferable(e, r)).toBe(inline(e, r));
    }
  });

  describe("the model source still adds only its own approved set", () => {
    let db: Database;
    beforeEach(() => {
      db = new Database(":memory:");
      runIndexedSchemaMigrations(db, 97);
    });
    afterEach(() => db.close());

    test("recheck is the shared conditions AND the V84 set", () => {
      const rows = writesEnabledBy("github", 4);
      const approved = rows.slice(0, 5).map((r) => r.toolId);
      setModelWriteEnablement(db, "github", 3, 1, approved);
      const source = createModelWriteToolSource({
        db,
        enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>() }) as never,
        listServerTools: () => Promise.resolve(undefined),
        toolsEpoch: () => 0,
        warn: () => {},
        approvedWorkdirs: () => ["/w"],
        approvedK8sPairs: () => [{ context: "c", namespace: "n" }],
      });
      for (const r of rows) {
        const want =
          enabledAndOfferable({ service: "github", maxWave: 3 }, r) && approved.includes(r.toolId);
        expect(source.recheck(r), r.toolId).toBe(want);
      }
    });
  });
});

describe("agentDoorPolicyAllows", () => {
  const policy = (...off: string[]) => ({ capabilitiesDisabled: new Set(off) });
  test("is false for undefined, true when neither is locked off, false when either or both are", () => {
    expect(agentDoorPolicyAllows(undefined)).toBe(false);
    expect(agentDoorPolicyAllows(policy())).toBe(true);
    expect(agentDoorPolicyAllows(policy("connector_write_model_access"))).toBe(false);
    expect(agentDoorPolicyAllows(policy("mcp_action"))).toBe(false);
    expect(agentDoorPolicyAllows(policy("connector_write_model_access", "mcp_action"))).toBe(false);
  });
});
