import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  checkAgentToolDefinition,
  recordDoorSuspension,
  suspensionFromRow,
} from "./agent-door-definition.ts";
import { definitionSha256 } from "./definition-hash.ts";
import { type DoorApproval, getDoorApproval, upsertDoorApprovals } from "./door-approval-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { previewTemplateKeys } from "./types.ts";

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

const ROW = CONNECTOR_WRITE_ROWS.find((r) => r.toolId === "github_issue_comment_create");
if (ROW === undefined || ROW.preview === undefined) throw new Error("fixture row missing");
const TOOL = ROW.toolId;
const KEY = mcpClientToolKey("github", TOOL);
const KEYS = [...previewTemplateKeys(ROW.preview)];

function entry(description: string): unknown {
  const properties = Object.fromEntries(KEYS.map((k) => [k, { type: "string" }]));
  return {
    description,
    inputSchema: toStandardSchema({ type: "object", properties } as JsonSchemaInput),
  };
}

/** An entry whose schema declares none of the preview's keys. */
function bareEntry(description: string): unknown {
  return {
    description,
    inputSchema: toStandardSchema({ type: "object", properties: {} } as JsonSchemaInput),
  };
}

let db: Database;
let clock = 1_000;
const deps = () => ({ db, now: () => clock });

function approve(listed: Record<string, unknown>): DoorApproval {
  const sha = definitionSha256(TOOL, listed[KEY]) as string;
  upsertDoorApprovals(db, "agent", "github", [{ toolId: TOOL, definitionSha256: sha }], 500);
  return getDoorApproval(db, "agent", "github", TOOL) as DoorApproval;
}

function auditRows(): Array<{ action_type: string; action_json: string }> {
  return db
    .query("SELECT action_type, action_json FROM audit_log WHERE action_type = ?")
    .all("connector.writes.agent.suspend") as Array<{ action_type: string; action_json: string }>;
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 97);
  clock = 1_000;
});
afterEach(() => db.close());

describe("checkAgentToolDefinition", () => {
  test("ok: the listing hashes to the approved value", () => {
    const listed = { [KEY]: entry("d") };
    expect(checkAgentToolDefinition(deps(), approve(listed), listed)).toEqual({ kind: "ok" });
    expect(auditRows()).toHaveLength(0);
  });

  test("changed: marks once and audits once; a second call does neither but still reports it", () => {
    const approval = approve({ [KEY]: entry("d") });
    const changed = { [KEY]: entry("d!") };
    const first = checkAgentToolDefinition(deps(), approval, changed);
    expect(first.kind).toBe("changed");
    expect(getDoorApproval(db, "agent", "github", TOOL)?.suspendedAt).toBe(1_000);
    expect(auditRows()).toHaveLength(1);
    expect(JSON.parse(auditRows()[0]?.action_json as string)).toMatchObject({
      service: "github",
      toolId: TOOL,
    });
    clock = 2_000;
    const second = checkAgentToolDefinition(deps(), approval, changed);
    expect(second.kind).toBe("changed");
    expect(getDoorApproval(db, "agent", "github", TOOL)?.suspendedAt).toBe(1_000);
    expect(auditRows()).toHaveLength(1);
    expect(second.kind === "changed" ? second.suspension?.nowSha12 : "none").toBe(
      first.kind === "changed" ? first.suspension?.nowSha12 : "other",
    );
  });

  test("unreadable: a listed entry that cannot be hashed marks with a NULL observed hash", () => {
    const approval = approve({ [KEY]: entry("d") });
    const result = checkAgentToolDefinition(deps(), approval, {
      [KEY]: { description: "d", inputSchema: "garbage" },
    });
    expect(result.kind).toBe("unreadable");
    const row = getDoorApproval(db, "agent", "github", TOOL);
    expect(row?.suspendedAt).toBe(1_000);
    expect(row?.suspendedSha256).toBeNull();
    expect(auditRows()).toHaveLength(1);
  });

  test("unreadable: a description that is present and not a string (R-3)", () => {
    const approval = approve({ [KEY]: entry("d") });
    const listed = { [KEY]: { ...(entry("d") as object), description: 42 } };
    expect(checkAgentToolDefinition(deps(), approval, listed).kind).toBe("unreadable");
  });

  test("missing (OR-AD-14): nothing is marked and no audit row is written, and it works when it returns", () => {
    const listed = { [KEY]: entry("d") };
    const approval = approve(listed);
    expect(checkAgentToolDefinition(deps(), approval, {})).toEqual({ kind: "missing" });
    expect(getDoorApproval(db, "agent", "github", TOOL)?.suspendedAt).toBeNull();
    expect(auditRows()).toHaveLength(0);
    expect(checkAgentToolDefinition(deps(), approval, listed)).toEqual({ kind: "ok" });
  });

  test("drifted (correction 7): the hash matches but the schema lacks a key the preview names; nothing is marked", () => {
    const listed = { [KEY]: entry("d") };
    const approval = approve(listed);
    const lacking = { [KEY]: bareEntry("d") };
    upsertDoorApprovals(
      db,
      "agent",
      "github",
      [{ toolId: TOOL, definitionSha256: definitionSha256(TOOL, lacking[KEY]) as string }],
      600,
    );
    const reapproved = getDoorApproval(db, "agent", "github", TOOL) as DoorApproval;
    expect(checkAgentToolDefinition(deps(), reapproved, lacking, ROW)).toEqual({
      kind: "drifted",
    });
    expect(getDoorApproval(db, "agent", "github", TOOL)?.suspendedAt).toBeNull();
    expect(auditRows()).toHaveLength(0);
    // Without the row the drift check does not run (status has no row to compare against).
    expect(checkAgentToolDefinition(deps(), reapproved, lacking)).toEqual({ kind: "ok" });
    // An undrifted listing checked with the row is ok.
    expect(checkAgentToolDefinition(deps(), approval, listed, ROW)).toEqual({ kind: "ok" });
  });

  test("a change is reported as changed (not drifted) even when the new schema also drifted", () => {
    const approval = approve({ [KEY]: entry("d") });
    expect(
      checkAgentToolDefinition(deps(), approval, { [KEY]: bareEntry("other") }, ROW).kind,
    ).toBe("changed");
  });
});

describe("recordDoorSuspension", () => {
  test("a row re-approved with another hash during the check is not marked and not reported", () => {
    const stale = approve({ [KEY]: entry("d") });
    upsertDoorApprovals(
      db,
      "agent",
      "github",
      [{ toolId: TOOL, definitionSha256: "9".repeat(64) }],
      700,
    );
    expect(recordDoorSuspension(deps(), stale, { sha: "8".repeat(64) })).toBeUndefined();
    expect(getDoorApproval(db, "agent", "github", TOOL)?.suspendedAt).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  test("a failed audit append rolls the mark back", () => {
    const approval = approve({ [KEY]: entry("d") });
    db.run(
      "CREATE TRIGGER audit_boom BEFORE INSERT ON audit_log WHEN NEW.action_type = 'connector.writes.agent.suspend' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(() => recordDoorSuspension(deps(), approval, { sha: "8".repeat(64) })).toThrow();
    expect(getDoorApproval(db, "agent", "github", TOOL)?.suspendedAt).toBeNull();
  });

  test("suspensionFromRow reports a stored NULL hash with the fixed reason", () => {
    const approval = approve({ [KEY]: entry("d") });
    recordDoorSuspension(deps(), approval, { sha: null, reason: "x" });
    const row = getDoorApproval(db, "agent", "github", TOOL) as DoorApproval;
    expect(suspensionFromRow(row)).toMatchObject({ toolId: TOOL, nowSha12: null });
    expect(suspensionFromRow(row).reason).toContain("no longer listed");
  });
});
