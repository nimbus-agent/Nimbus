// packages/gateway/src/connectors/connector-writes/reversibility.ts
// Phase 10 IC5a (incident-engine spec § 5.5, D-IC-4): which connector writes can be undone through Nimbus.
// ONE table, applied to the row table by `index.ts`. The label is the DECLARED class: nothing is inferred, and
// a row with no entry is `unknown`. A `reversible` entry is accepted only if (a) the inverse row exists, (b) the
// row has a before reader, and (c) every key `fromBefore` names is a key that reader's `captures` supplies;
// `applyReversibility` throws at load otherwise (the same fail-at-load discipline as `withBefore`). Each entry
// has a proof test (`reversibility.test.ts`) that builds the inverse from a recorded reply.
import { beforeReplyJson, boolAt, stringAt } from "./before-select.ts";
import type {
  BeforeCaptures,
  ConnectorWriteRow,
  ReversibilityClass,
  ReversibilityDecl,
} from "./types.ts";

const asText = (v: unknown): string | undefined =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;

/** The history ids of an Argo CD application reply (`status.history[].id`), as integers. */
function argoHistoryIds(j: unknown): number[] {
  const h = (j as { status?: { history?: unknown } } | null)?.status?.history;
  if (!Array.isArray(h)) return [];
  return h.flatMap((e) => {
    const id = stringAt(e, ["id"]);
    return id !== undefined && /^\d{1,12}$/.test(id) ? [Number(id)] : [];
  });
}

const LD_CAPTURES: BeforeCaptures = {
  keys: ["on"],
  pick(reply) {
    const on = boolAt(beforeReplyJson(reply), ["on"]);
    if (on === undefined) throw new Error("capture: no on");
    return { on: String(on) };
  },
};

const FLAGSMITH_CAPTURES: BeforeCaptures = {
  keys: ["enabled"],
  pick(reply) {
    const enabled = boolAt(beforeReplyJson(reply), ["environment_default", "enabled"]);
    if (enabled === undefined) throw new Error("capture: no enabled");
    return { enabled: String(enabled) };
  },
};

const EC2_CAPTURES: BeforeCaptures = {
  keys: ["state"],
  pick(reply) {
    const state = stringAt(beforeReplyJson(reply), ["state"]);
    if (state === undefined) throw new Error("capture: no state");
    return { state };
  },
};

const ECS_CAPTURES: BeforeCaptures = {
  keys: ["taskDefinition"],
  pick(reply) {
    const taskDefinition = stringAt(beforeReplyJson(reply), ["taskDefinition"]);
    if (taskDefinition === undefined) throw new Error("capture: no taskDefinition");
    return { taskDefinition };
  },
};

/** How many of the newest history ids the dry run's capture keeps (well under the 512-character value cap). */
const ARGO_HISTORY_IDS_KEPT = 30;

/**
 * Whether Argo CD auto-sync is on: `spec.syncPolicy.automated` is an object whose `enabled` is not `false`. Its
 * presence turns auto-sync on; Argo CD 3.x also accepts `automated: { enabled: false }`, which keeps the settings and
 * turns it off. `{}`, `enabled: true` and `enabled: null` stay on.
 */
function argoAutoSyncOn(j: unknown): boolean {
  const automated = (j as { spec?: { syncPolicy?: { automated?: unknown } } } | null)?.spec
    ?.syncPolicy?.automated;
  if (automated === null || typeof automated !== "object" || Array.isArray(automated)) return false;
  return (automated as { enabled?: unknown }).enabled !== false;
}

/**
 * `currentHistoryId` is what the inverse needs. `autoSync` (`on`/`off`) and `historyIds` (the newest ids Argo CD
 * retains, comma-separated, newest first) are read only by the remediation dry run's prediction
 * (`dry-run-predict.ts`): Argo CD refuses a rollback while auto-sync is on, and to an id it no longer keeps.
 */
const ARGO_CAPTURES: BeforeCaptures = {
  keys: ["currentHistoryId", "autoSync", "historyIds"],
  pick(reply) {
    const j = beforeReplyJson(reply);
    const ids = argoHistoryIds(j);
    if (ids.length === 0) throw new Error("capture: no history");
    const newest = [...new Set(ids)].sort((a, b) => b - a).slice(0, ARGO_HISTORY_IDS_KEPT);
    return {
      currentHistoryId: String(newest[0]),
      autoSync: argoAutoSyncOn(j) ? "on" : "off",
      historyIds: newest.join(","),
    };
  },
};

/** An EC2 stop or start: the inverse is the other one, and only when the instance really was in the opposite state. */
function ec2Decl(inverse: string, wasState: string): ReversibilityDecl {
  return {
    class: "reversible",
    inverse,
    fromBefore: ["state"],
    invert: (input, captured) => {
      const instanceIds = asText(input["instanceIds"]);
      return captured["state"] === wasState && instanceIds !== undefined
        ? { instanceIds }
        : undefined;
    },
  };
}

export type ReversibilityEntry = {
  readonly decl: ReversibilityDecl;
  readonly captures?: BeforeCaptures;
};

const irreversible = (reason: string): ReversibilityEntry => ({
  decl: { class: "irreversible", reason },
});

const NO_UNDO = "it cannot be undone through Nimbus";

/**
 * The classification. Reversible: the six rows whose before reader supplies what the inverse needs.
 * Irreversible: a write whose effect Nimbus cannot reverse (a resolve, a merge, a delete, a trigger, an
 * invoke). Every other row is `unknown` (no entry).
 */
export const REVERSIBILITY_TABLE: Readonly<Record<string, ReversibilityEntry>> = Object.freeze({
  launchdarkly_flag_toggle: {
    captures: LD_CAPTURES,
    decl: {
      class: "reversible",
      inverse: "launchdarkly_flag_toggle",
      fromBefore: ["on"],
      invert: (input, captured) => {
        const environmentKey = asText(input["environmentKey"]);
        const projectKey = asText(input["projectKey"]);
        const flagKey = asText(input["flagKey"]);
        const before = captured["on"];
        if (
          environmentKey === undefined ||
          projectKey === undefined ||
          flagKey === undefined ||
          (before !== "true" && before !== "false") ||
          before === asText(input["on"])
        ) {
          return undefined;
        }
        return { environmentKey, projectKey, flagKey, on: before === "true" };
      },
    },
  },
  flagsmith_feature_state_set: {
    captures: FLAGSMITH_CAPTURES,
    decl: {
      class: "reversible",
      inverse: "flagsmith_feature_state_set",
      fromBefore: ["enabled"],
      invert: (input, captured) => {
        const before = captured["enabled"];
        const environmentKey = asText(input["environmentKey"]);
        const featureId = input["featureId"];
        // A call that also set a value cannot be undone: the previous value is not captured.
        if (
          input["value"] !== undefined ||
          environmentKey === undefined ||
          typeof featureId !== "number" ||
          (before !== "true" && before !== "false") ||
          before === asText(input["enabled"])
        ) {
          return undefined;
        }
        return { environmentKey, featureId, enabled: before === "true" };
      },
    },
  },
  aws_ec2_instance_stop: {
    captures: EC2_CAPTURES,
    decl: ec2Decl("aws_ec2_instance_start", "running"),
  },
  aws_ec2_instance_start: {
    captures: EC2_CAPTURES,
    decl: ec2Decl("aws_ec2_instance_stop", "stopped"),
  },
  aws_ecs_service_update: {
    captures: ECS_CAPTURES,
    decl: {
      class: "reversible",
      inverse: "aws_ecs_service_update",
      fromBefore: ["taskDefinition"],
      invert: (input, captured) => {
        const cluster = asText(input["cluster"]);
        const service = asText(input["service"]);
        const taskDefinition = captured["taskDefinition"];
        if (
          cluster === undefined ||
          service === undefined ||
          taskDefinition === undefined ||
          taskDefinition === asText(input["taskDefinition"])
        ) {
          return undefined;
        }
        return { cluster, service, taskDefinition };
      },
    },
  },
  argocd_app_rollback: {
    captures: ARGO_CAPTURES,
    decl: {
      class: "reversible",
      inverse: "argocd_app_rollback",
      fromBefore: ["currentHistoryId"],
      invert: (input, captured) => {
        const name = asText(input["name"]);
        const current = captured["currentHistoryId"];
        if (
          name === undefined ||
          current === undefined ||
          !/^\d{1,12}$/.test(current) ||
          current === asText(input["id"])
        ) {
          return undefined;
        }
        return { name, id: Number(current) };
      },
    },
  },
  pd_incident_acknowledge: irreversible(
    "a PagerDuty acknowledgement cannot be withdrawn through Nimbus",
  ),
  pd_incident_resolve: irreversible("a PagerDuty incident cannot be reopened through Nimbus"),
  pd_incident_escalate: irreversible("a PagerDuty escalation cannot be reversed through Nimbus"),
  jira_ops_alert_acknowledge: irreversible(
    "a Jira Service Management alert acknowledgement cannot be withdrawn through Nimbus",
  ),
  jira_ops_alert_close: irreversible(
    "a closed Jira Service Management alert cannot be reopened through Nimbus",
  ),
  argocd_app_sync: irreversible(
    "a sync applies the target revision; Nimbus holds no way to undo it",
  ),
  github_pr_merge: irreversible(`a merge ${NO_UNDO}`),
  gitlab_mr_merge: irreversible(`a merge ${NO_UNDO}`),
  bitbucket_pr_merge: irreversible(`a merge ${NO_UNDO}`),
  github_branch_delete: irreversible(`a deleted branch ${NO_UNDO}`),
  onedrive_item_delete: irreversible(`a delete ${NO_UNDO}`),
  outlook_calendar_delete: irreversible(`a deleted event ${NO_UNDO}`),
  apple_calendar_event_delete: irreversible(`a deleted event ${NO_UNDO}`),
  aws_lambda_invoke: irreversible("the function's own code decides what an invoke did"),
  jenkins_build_trigger: irreversible(`a started build ${NO_UNDO}`),
  gha_run_trigger: irreversible(`a started workflow run ${NO_UNDO}`),
  circleci_pipeline_trigger: irreversible(`a started pipeline ${NO_UNDO}`),
  netlify_build_trigger: irreversible(`a started build ${NO_UNDO}`),
  bitrise_build_trigger: irreversible(`a started build ${NO_UNDO}`),
  codemagic_build_trigger: irreversible(`a started build ${NO_UNDO}`),
  k8s_pod_delete: irreversible(`a deleted pod ${NO_UNDO}`),
});

/** The problems of one REVERSIBLE entry: its row needs a before reader, its inverse a row, its keys a capture. */
function reversibleEntryProblems(
  toolId: string,
  decl: Extract<ReversibilityDecl, { readonly class: "reversible" }>,
  entry: ReversibilityEntry,
  row: ConnectorWriteRow,
  byId: ReadonlyMap<string, ConnectorWriteRow>,
): string[] {
  const problems: string[] = [];
  if (row.before === undefined) {
    problems.push(`${toolId}: reversible but the row has no before reader`);
  }
  if (!byId.has(decl.inverse))
    problems.push(`${toolId}: inverse row ${decl.inverse} does not exist`);
  if (entry.captures === undefined) problems.push(`${toolId}: reversible but no captures`);
  const keys = entry.captures?.keys ?? [];
  for (const k of decl.fromBefore) {
    if (!keys.includes(k)) {
      problems.push(`${toolId}: fromBefore names ${k}, which no capture supplies`);
    }
  }
  return problems;
}

/** The problems with the table against `rows`: an empty list means every entry is consistent. */
export function checkReversibilityTable(
  rows: readonly ConnectorWriteRow[],
  table: Readonly<Record<string, ReversibilityEntry>> = REVERSIBILITY_TABLE,
): string[] {
  const byId = new Map(rows.map((r) => [r.toolId, r] as const));
  const problems: string[] = [];
  for (const [toolId, entry] of Object.entries(table)) {
    const row = byId.get(toolId);
    if (row === undefined) {
      problems.push(`${toolId}: no such write row`);
      continue;
    }
    const d = entry.decl;
    if (d.class !== "reversible") {
      if (entry.captures !== undefined) problems.push(`${toolId}: captures on an irreversible row`);
      continue;
    }
    problems.push(...reversibleEntryProblems(toolId, d, entry, row, byId));
  }
  return problems;
}

/** The rows with their declared reversibility (and the capture a reversible row's reader gains). Throws on a bad table. */
export function applyReversibility(
  rows: readonly ConnectorWriteRow[],
  table: Readonly<Record<string, ReversibilityEntry>> = REVERSIBILITY_TABLE,
): readonly ConnectorWriteRow[] {
  const problems = checkReversibilityTable(rows, table);
  if (problems.length > 0) {
    throw new Error(`connector write reversibility table: ${problems.join("; ")}`);
  }
  return rows.map((r) => {
    const entry = table[r.toolId];
    if (entry === undefined) return r;
    const before =
      entry.captures === undefined || r.before === undefined
        ? r.before
        : Object.freeze({ ...r.before, captures: entry.captures });
    return Object.freeze({
      ...r,
      ...(before === undefined ? {} : { before }),
      reversibility: entry.decl,
    });
  });
}

/** The label of a row: the declared class, or `unknown` (nothing is inferred). */
export function reversibilityClassOf(row: ConnectorWriteRow | undefined): ReversibilityClass {
  return row?.reversibility?.class ?? "unknown";
}
