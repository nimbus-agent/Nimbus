// Scenarios for the I55 tests (Phase 10 SA3): an action, a rule and the executor-side dependencies
// that all match, so a test can break EXACTLY ONE clause of the check and assert that the owner's
// prompt follows and nothing was claimed. Imported by tests only; no production file imports it.
import type { Database } from "bun:sqlite";

import type { WriteWorkflowStep } from "../../automation/workflow-steps.ts";
import { buildWriteActions } from "../../automation/workflow-write-step.ts";
import { dbRun } from "../../db/write.ts";
import type { StandingRuleDeps } from "../../engine/standing-rule-step.ts";
import type { PlannedAction } from "../../engine/types.ts";
import { getRule, insertRule } from "../../standing/standing-rule-store.ts";
import type { StandingRule } from "../../standing/standing-rule-types.ts";
import { connectorWriteRowByToolId } from "../connector-write-registry.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import {
  ARCHIVE_STEPS,
  createRule,
  freshDb,
  NOW,
  type SeededWorkflow,
  seedWorkflow,
} from "./standing-fixtures.test-helpers.ts";
import type { ConnectorWriteRow } from "./types.ts";

export type Scenario = {
  readonly db: Database;
  wf: SeededWorkflow;
  rule: StandingRule;
  action: PlannedAction;
  deps: StandingRuleDeps;
  rows: readonly ConnectorWriteRow[];
  frozenHitl: boolean;
};

export const CONST_STEPS = [
  {
    kind: "write",
    label: "archive",
    tool: "gmail_thread_archive",
    input: { threadId: { const: "T-fixed" } },
  },
] as const;

export const CALENDAR_STEPS = [
  {
    kind: "write",
    label: "invite",
    tool: "outlook_calendar_create",
    input: {
      subject: { const: "Standup" },
      startDateTime: { const: "2026-11-12T10:00:00" },
      endDateTime: { const: "2026-11-12T10:30:00" },
      timeZone: { const: "Europe/Berlin" },
    },
  },
] as const;

export function openDeps(db: Database, over: Partial<StandingRuleDeps> = {}): StandingRuleDeps {
  return { db, policyAllows: () => true, refusal: () => undefined, now: () => NOW, ...over };
}

export type ScenarioVariant = "archive" | "const" | "calendar";

/** The matching scenario: a workflow, a live rule for its write step, and the action a run builds. */
export function baseScenario(
  opts: { readonly window?: unknown; readonly variant?: ScenarioVariant } = {},
): Scenario {
  const db = freshDb();
  const variant = opts.variant ?? "archive";
  let steps: readonly unknown[] = ARCHIVE_STEPS;
  if (variant === "const") steps = CONST_STEPS;
  if (variant === "calendar") steps = CALENDAR_STEPS;
  const wf = seedWorkflow(db, steps);
  const stepName = variant === "calendar" ? "invite" : "archive";
  const rule = createRule(db, {
    step: stepName,
    ...(opts.window === undefined ? {} : { window: opts.window }),
  });
  const stepIndex = variant === "archive" ? 1 : 0;
  const [action] = buildWriteActions(wf.steps[stepIndex] as WriteWorkflowStep, {
    workflowId: wf.id,
    workflowSha256: wf.sha,
    stepIndex,
    runId: "run-1",
    trigger: "owner_cli",
    queries: new Map([["old-read-mail", { index: 0, values: ["thread-1"] }]]),
  });
  return {
    db,
    wf,
    rule,
    action: action as PlannedAction,
    deps: openDeps(db),
    rows: CONNECTOR_WRITE_ROWS,
    frozenHitl: true,
  };
}

/** The first real row matching `pick`; a fixture must not silently go empty. */
export function rowWhere(pick: (r: ConnectorWriteRow) => boolean): ConnectorWriteRow {
  const row = CONNECTOR_WRITE_ROWS.find(pick);
  if (row === undefined) throw new Error("no write row matches the fixture's predicate");
  return row;
}

/**
 * Re-aims the scenario at `row` with `input`, and inserts a rule that matches it in everything but
 * eligibility (same workflow, hash, step, type, tool, scope), so only the row itself can refuse it.
 */
export function aimAtRow(
  s: Scenario,
  row: ConnectorWriteRow,
  input: Record<string, unknown>,
): void {
  const p = s.action.provenance;
  if (p === undefined) throw new Error("scenario action has no provenance");
  const fieldSources: Record<string, "constant"> = {};
  const scope: Record<string, { const: never }> = {};
  for (const [k, v] of Object.entries(input)) {
    fieldSources[k] = "constant";
    scope[k] = { const: v as never };
  }
  s.action = {
    type: row.actionType,
    payload: { mcpToolId: row.toolId, input },
    provenance: { ...p, fieldSources },
  };
  insertRule(s.db, {
    createdAt: NOW - 1000,
    workflowId: p.workflowId,
    workflowSha256: p.workflowSha256,
    stepIndex: p.stepIndex,
    actionType: row.actionType,
    toolId: row.toolId,
    scope,
    window: undefined,
    expiresAt: NOW + 86_400_000,
    maxActions: 10,
    approvalAuditId: 1,
  });
}

/** Direct SQL on the scenario's rule: test code only (static D44(b) scans production files). */
export function setRuleColumn(s: Scenario, column: string, value: unknown): void {
  dbRun(s.db, `UPDATE standing_rule SET ${column} = ? WHERE id = ?`, [value, s.rule.id]);
}

function withProvenance(s: Scenario, over: Record<string, unknown>): void {
  const p = s.action.provenance;
  if (p === undefined) throw new Error("scenario action has no provenance");
  s.action = { ...s.action, provenance: { ...p, ...over } as never };
}

export type Breaker = { readonly name: string; readonly apply: (s: Scenario) => void };

/** One breaker per independent clause of the check (review S3-4): each leaves everything else matching. */
export const BREAKERS: readonly Breaker[] = [
  {
    name: "policy disabled",
    apply: (s) => {
      s.deps = openDeps(s.db, { policyAllows: () => false });
    },
  },
  {
    name: "policy accessor throws",
    apply: (s) => {
      s.deps = openDeps(s.db, {
        policyAllows: () => {
          throw new Error("policy unreadable");
        },
      });
    },
  },
  {
    name: "no provenance",
    apply: (s) => {
      const { provenance: _p, ...rest } = s.action;
      s.action = rest;
    },
  },
  {
    name: "a trigger the gateway does not derive",
    apply: (s) => withProvenance(s, { trigger: "owner_http" }),
  },
  {
    name: "origin is model",
    apply: (s) => {
      s.action = { ...s.action, origin: "model" };
    },
  },
  {
    name: "origin is agent",
    apply: (s) => {
      s.action = {
        ...s.action,
        origin: "agent",
        proposer: {
          door: "agent",
          captureId: "cap_breaker",
          label: null,
          labelSource: "declared",
          summary: "s",
          createdAt: 0,
          expiresAt: 1,
        },
      };
    },
  },
  {
    name: "a wave 4 row",
    apply: (s) =>
      aimAtRow(
        s,
        rowWhere((r) => r.toolId === "jenkins_build_abort" && r.wave === 4),
        { jobName: "deploy", buildNumber: 7 },
      ),
  },
  {
    name: "a bound row",
    apply: (s) =>
      aimAtRow(
        s,
        rowWhere((r) => r.bound !== undefined),
        { a: "b" },
      ),
  },
  {
    name: "a never-offered row",
    apply: (s) =>
      aimAtRow(s, connectorWriteRowByToolId("gmail_message_send") as ConnectorWriteRow, {
        a: "b",
      }),
  },
  {
    name: "HITL only by an org policy require",
    apply: (s) => {
      s.frozenHitl = false;
    },
  },
  {
    name: "mcpToolId names another row's tool",
    apply: (s) => {
      s.action = { ...s.action, payload: { ...s.action.payload, mcpToolId: "gmail_message_send" } };
    },
  },
  {
    name: "the payload carries a key besides mcpToolId and input",
    apply: (s) => {
      s.action = { ...s.action, payload: { ...s.action.payload, sneaky: true } };
    },
  },
  { name: "an input field with no source", apply: (s) => withProvenance(s, { fieldSources: {} }) },
  {
    name: "an extra input field",
    apply: (s) => {
      const payload = s.action.payload as { input: Record<string, unknown> };
      s.action = { ...s.action, payload: { ...payload, input: { ...payload.input, extra: 1 } } };
      const p = s.action.provenance;
      withProvenance(s, { fieldSources: { ...p?.fieldSources, extra: "constant" } });
    },
  },
  {
    name: "a different workflow id",
    apply: (s) => withProvenance(s, { workflowId: "another-workflow" }),
  },
  {
    name: "a different workflow hash (one edited byte of the steps)",
    apply: (s) => {
      const edited = JSON.parse(JSON.stringify(ARCHIVE_STEPS)) as Array<Record<string, unknown>>;
      (edited[0] as { query: { limit: number } }).query.limit = 199;
      const wf2 = seedWorkflow(s.db, edited);
      withProvenance(s, { workflowSha256: wf2.sha });
    },
  },
  { name: "a different step index", apply: (s) => withProvenance(s, { stepIndex: 2 }) },
  { name: "a different tool", apply: (s) => setRuleColumn(s, "tool_id", "some_other_tool") },
  { name: "a paused rule", apply: (s) => setRuleColumn(s, "paused_at", NOW - 1) },
  { name: "a revoked rule", apply: (s) => setRuleColumn(s, "revoked_at", NOW - 1) },
  {
    name: "an expired rule (now equals expires_at)",
    apply: (s) => {
      s.deps = openDeps(s.db, { now: () => s.rule.expiresAt });
    },
  },
  {
    name: "an exhausted ceiling",
    apply: (s) => setRuleColumn(s, "actions_used", s.rule.maxActions),
  },
  {
    name: "a source that differs (the rule says constant, the action a query)",
    apply: (s) =>
      setRuleColumn(s, "scope_json", JSON.stringify({ threadId: { const: "thread-1" } })),
  },
  {
    name: "a query reference to another column",
    apply: (s) =>
      setRuleColumn(s, "scope_json", JSON.stringify({ threadId: { query: 0, column: "id" } })),
  },
  {
    name: "a door refusal on the actual input",
    apply: (s) => {
      s.deps = openDeps(s.db, { refusal: () => "refused" });
    },
  },
  {
    name: "a door refusal check that throws",
    apply: (s) => {
      s.deps = openDeps(s.db, {
        refusal: () => {
          throw new Error("boom");
        },
      });
    },
  },
];

/** What a successful or refused check left in the store: the used counter and the fire count. */
export function ruleCounters(s: Scenario): { used: number; fires: number } {
  const fires = s.db.query("SELECT COUNT(*) AS n FROM standing_rule_fire").get() as { n: number };
  return { used: getRule(s.db, s.rule.id)?.actionsUsed ?? -1, fires: fires.n };
}
