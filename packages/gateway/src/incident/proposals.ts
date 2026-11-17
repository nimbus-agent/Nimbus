import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type { RemediationCatalog } from "../connectors/connector-writes/remediation-catalog.ts";
import { canonicalJson } from "../util/canonical-json.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import type { ProposalDraft, ProposalReversibility } from "./proposal-store.ts";

/**
 * Remediation proposals for one incident record (Phase 10 IC5a, spec § 5.5). A PURE reading of the record, the
 * service configuration and the local index: no connector, no network, no model (OR-10-8), no write (the store
 * persists the result). It PROPOSES; running anything is `incident/remediation.ts` alone (static D46(c)).
 *
 * Every target comes from the record's typed ids, the owner's configuration bindings or an indexed value
 * (`argocd:application` history), never from provider text: an alert title cannot choose a tool or a target. Each
 * proposal carries its evidence (item ids and the rule), a blast radius (the services that depend on the target's
 * service through `depends_on`, the environment), the fixed dry-run line, and, for the causal kinds, a confidence
 * from fixed weights whose terms and arithmetic are printed.
 *
 * What cannot be proposed is listed with its reason (`unavailable`), never silently dropped.
 */

export const DRY_RUN_LINE = "no dry run available; the preview shows the target's current state";

/** The fixed confidence weights (sum 100). */
export const CONFIDENCE_WEIGHTS = Object.freeze({
  deploy_in_window: 40,
  deploy_env_bound: 20,
  prior_success: 25,
  recency: 15,
});

/** A record opened this recently scores the `recency` term. */
export const RECENCY_WINDOW_MS = 60 * 60 * 1000;

const MAX_ROLLBACKS = 3;
const MAX_REPEATS = 3;
const MAX_DEPENDENTS = 20;

export type ProposalKind = "rollback_deploy" | "repeat_last" | "acknowledge" | "close";

export type ConfidenceTerm = {
  readonly name: string;
  readonly weight: number;
  readonly met: boolean;
};
export type Confidence = { readonly terms: readonly ConfidenceTerm[]; readonly total: number };

export type ProposalEvidence = {
  readonly rule: string;
  /** Indexed item ids (and a prior proposal id) the proposal rests on. */
  readonly items: readonly string[];
  readonly blast: {
    readonly service: string | null;
    readonly environment: string | null;
    /** Services that depend on this one, directly or not (a bounded list). */
    readonly dependents: readonly string[];
    readonly dependentsTruncated: boolean;
  };
  readonly confidence: Confidence | null;
  readonly dryRun: string;
  /** The target the action names, for display (an application, an instance). */
  readonly target: string;
};

export type Unavailable = {
  readonly kind: "rollback_deploy" | "flag_revert";
  /** A closed code. */
  readonly code:
    | "no_deployment"
    | "argocd_not_bound"
    | "argocd_app_not_indexed"
    | "deploy_not_in_history"
    | "no_earlier_history"
    | "ecs_no_history"
    | "flag_no_history";
  readonly reason: string;
  readonly app?: string;
};

export type ServiceBindings = {
  readonly argocdApps: readonly string[];
  readonly deployEnvironments: readonly string[];
};

export type DeriveInput = {
  readonly recordId: string;
  readonly record: IncidentRecordV1;
  /** The record's service configuration, `undefined` when the service has none. */
  readonly bindings: ServiceBindings | undefined;
  /** Every configured service's declared `depends_on` (the blast radius). */
  readonly dependsOn: ReadonlyMap<string, readonly string[]>;
  readonly nowMs: number;
  /** The tool ids the engine may propose (`connectors/connector-writes/remediation-catalog.ts`, injected). */
  readonly catalog: RemediationCatalog;
  /** The declared reversibility of a write row (`unknown` for an unlisted tool). */
  readonly reversibilityOf: (toolId: string) => ProposalReversibility;
};

export type Derived = {
  readonly drafts: readonly ProposalDraft[];
  readonly unavailable: readonly Unavailable[];
};

/** `prp_` plus the first 16 hex of SHA-256 over the record, kind, tool and canonical input. */
export function proposalIdFor(
  recordId: string,
  kind: string,
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const h = createHash("sha256")
    .update(canonicalJson([recordId, kind, toolId, input]), "utf8")
    .digest("hex");
  return `prp_${h.slice(0, 16)}`;
}

const ECS_REASON =
  "ECS: the index holds no task-definition history, so the task definition before the deploy cannot be derived; run the update yourself";
const FLAG_REASON =
  "feature flag revert: the index holds a flag's current state and when it last changed, not the state before, so a revert target cannot be derived; toggle it yourself";

function blastOf(input: DeriveInput): ProposalEvidence["blast"] & { environment: string | null } {
  const service = input.record.binding.service;
  const seen = new Set<string>();
  const queue: string[] = service === null ? [] : [service];
  let truncated = false;
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const [dependent, deps] of [...input.dependsOn].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!deps.includes(cur) || seen.has(dependent) || dependent === service) continue;
      if (seen.size >= MAX_DEPENDENTS) {
        truncated = true;
        continue;
      }
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  return {
    service,
    environment: input.record.change.deployment?.environment ?? null,
    dependents: [...seen].sort(),
    dependentsTruncated: truncated,
  };
}

function evidenceOf(
  input: DeriveInput,
  rule: string,
  items: readonly string[],
  target: string,
  confidence: Confidence | null,
): ProposalEvidence {
  return { rule, items, blast: blastOf(input), confidence, dryRun: DRY_RUN_LINE, target };
}

function draftOf(
  input: DeriveInput,
  kind: ProposalKind,
  toolId: string,
  toolInput: Readonly<Record<string, unknown>>,
  evidence: ProposalEvidence,
): ProposalDraft {
  return {
    id: proposalIdFor(input.recordId, kind, toolId, toolInput),
    kind,
    toolId,
    input: toolInput,
    evidence,
    confidence: evidence.confidence === null ? null : evidence.confidence.total,
    reversibility: input.reversibilityOf(toolId),
  };
}

function confidenceOf(terms: readonly ConfidenceTerm[]): Confidence {
  return { terms, total: terms.reduce((n, t) => n + (t.met ? t.weight : 0), 0) };
}

type AppRow = { id: string; metadata: string | null };
type HistoryEntry = { id: number; revision: string };

function historyOf(metadata: string | null): HistoryEntry[] | undefined {
  if (metadata === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return undefined;
  }
  const h = (parsed as { history?: unknown } | null)?.history;
  if (!Array.isArray(h)) return undefined;
  const out: HistoryEntry[] = [];
  for (const e of h as unknown[]) {
    const r = e as { id?: unknown; revision?: unknown } | null;
    if (
      typeof r?.id === "number" &&
      Number.isInteger(r.id) &&
      r.id >= 0 &&
      typeof r.revision === "string" &&
      r.revision !== ""
    ) {
      out.push({ id: r.id, revision: r.revision });
    }
  }
  return out;
}

/** A deployment's commit and an Argo revision name the same commit: equal, or one abbreviates the other (7+ characters). */
export function sameRevision(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.startsWith(short);
}

function priorSuccess(
  db: Database,
  recordId: string,
  service: string | null,
  kind: string,
): boolean {
  if (service === null) return false;
  return (
    db
      .query(
        `SELECT 1 AS n FROM incident_proposal p JOIN incident_record r ON r.id = p.record_id
          WHERE r.service = ? AND p.kind = ? AND p.status = 'executed' AND p.record_id <> ? LIMIT 1`,
      )
      .get(service, kind, recordId) !== null
  );
}

function rollbacks(
  db: Database,
  input: DeriveInput,
  drafts: ProposalDraft[],
  unavailable: Unavailable[],
): void {
  const dep = input.record.change.deployment;
  if (dep === null) {
    unavailable.push({
      kind: "rollback_deploy",
      code: "no_deployment",
      reason: "no deployment was found before this incident, so there is nothing to roll back",
    });
    return;
  }
  const apps = input.bindings?.argocdApps ?? [];
  if (apps.length === 0) {
    unavailable.push({
      kind: "rollback_deploy",
      code: "argocd_not_bound",
      reason:
        "no Argo CD application is bound to this service ([ci.service.<id>] argocd_apps), so a rollback cannot be derived",
    });
  }
  const service = input.record.binding.service;
  const envBound = input.bindings?.deployEnvironments.includes(dep.environment) === true;
  const prior = priorSuccess(db, input.recordId, service, "rollback_deploy");
  const recent =
    input.record.trigger.opened.ms !== null &&
    input.nowMs - input.record.trigger.opened.ms <= RECENCY_WINDOW_MS;
  const confidence = confidenceOf([
    { name: "deploy_in_window", weight: CONFIDENCE_WEIGHTS.deploy_in_window, met: true },
    { name: "deploy_env_bound", weight: CONFIDENCE_WEIGHTS.deploy_env_bound, met: envBound },
    { name: "prior_success", weight: CONFIDENCE_WEIGHTS.prior_success, met: prior },
    { name: "recency", weight: CONFIDENCE_WEIGHTS.recency, met: recent },
  ]);
  for (const app of apps.slice(0, MAX_ROLLBACKS)) {
    const row = db
      .query(
        "SELECT id, metadata FROM item WHERE service = 'argocd' AND type = 'application' AND external_id = ?",
      )
      .get(app) as AppRow | null;
    if (row === null) {
      unavailable.push({
        kind: "rollback_deploy",
        code: "argocd_app_not_indexed",
        app,
        reason: `Argo CD application ${app} is not in the index`,
      });
      continue;
    }
    const history = historyOf(row.metadata);
    const entry = history?.find((e) => sameRevision(e.revision, dep.sha));
    if (history === undefined || entry === undefined) {
      unavailable.push({
        kind: "rollback_deploy",
        code: "deploy_not_in_history",
        app,
        reason: `the deployed commit is not in ${app}'s indexed deployment history`,
      });
      continue;
    }
    const earlier = history.filter((e) => e.id < entry.id).sort((a, b) => b.id - a.id)[0];
    if (earlier === undefined) {
      unavailable.push({
        kind: "rollback_deploy",
        code: "no_earlier_history",
        app,
        reason: `${app} has no deployment history entry before the one this deploy created`,
      });
      continue;
    }
    drafts.push(
      draftOf(
        input,
        "rollback_deploy",
        input.catalog.argoRollback,
        { name: app, id: earlier.id },
        evidenceOf(input, "deploy_before_open:argocd_history", [dep.id, row.id], app, confidence),
      ),
    );
  }
  unavailable.push({ kind: "rollback_deploy", code: "ecs_no_history", reason: ECS_REASON });
}

type PriorRow = { id: string; record_id: string; tool_id: string; input_json: string };

function repeats(db: Database, input: DeriveInput, drafts: ProposalDraft[]): void {
  const service = input.record.binding.service;
  if (service === null) return;
  const marks = input.catalog.repeatable.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT p.id, p.record_id, p.tool_id, p.input_json
         FROM incident_proposal p JOIN incident_record r ON r.id = p.record_id
        WHERE r.service = ? AND p.status = 'executed' AND p.record_id <> ? AND p.tool_id IN (${marks})
        ORDER BY p.updated_at_ms DESC, p.id ASC`,
    )
    .all(service, input.recordId, ...input.catalog.repeatable) as PriorRow[];
  const seen = new Set<string>();
  let n = 0;
  for (const r of rows) {
    if (n >= MAX_REPEATS) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.input_json);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const key = `${r.tool_id}\n${canonicalJson(parsed)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const recent =
      input.record.trigger.opened.ms !== null &&
      input.nowMs - input.record.trigger.opened.ms <= RECENCY_WINDOW_MS;
    const confidence = confidenceOf([
      {
        name: "deploy_in_window",
        weight: CONFIDENCE_WEIGHTS.deploy_in_window,
        met: input.record.change.deployment !== null,
      },
      {
        name: "deploy_env_bound",
        weight: CONFIDENCE_WEIGHTS.deploy_env_bound,
        met:
          input.record.change.deployment !== null &&
          input.bindings?.deployEnvironments.includes(
            input.record.change.deployment.environment,
          ) === true,
      },
      { name: "prior_success", weight: CONFIDENCE_WEIGHTS.prior_success, met: true },
      { name: "recency", weight: CONFIDENCE_WEIGHTS.recency, met: recent },
    ]);
    drafts.push(
      draftOf(
        input,
        "repeat_last",
        r.tool_id,
        parsed as Record<string, unknown>,
        evidenceOf(input, "same_service_prior_success", [r.id, r.record_id], r.tool_id, confidence),
      ),
    );
    n += 1;
  }
}

/** acknowledge and close/resolve of the trigger itself (PagerDuty incident, JSM Operations alert). */
function alertActions(input: DeriveInput, drafts: ProposalDraft[]): void {
  const t = input.record.trigger;
  if (t.status !== "open") return;
  const tools =
    t.service === "pagerduty"
      ? input.catalog.alerts.pagerduty
      : t.service === "jira"
        ? input.catalog.alerts.jira
        : undefined;
  if (tools === undefined || t.providerId === "") return;
  const target = { [tools.field]: t.providerId };
  drafts.push(
    draftOf(
      input,
      "acknowledge",
      tools.ack,
      target,
      evidenceOf(input, "trigger_open", [t.itemId], t.providerId, null),
    ),
    draftOf(
      input,
      "close",
      tools.close,
      target,
      evidenceOf(input, "trigger_open", [t.itemId], t.providerId, null),
    ),
  );
}

/** The proposals for a record, in a fixed order: rollbacks, repeats, acknowledge, close. */
export function deriveProposals(db: Database, input: DeriveInput): Derived {
  const drafts: ProposalDraft[] = [];
  const unavailable: Unavailable[] = [];
  rollbacks(db, input, drafts, unavailable);
  repeats(db, input, drafts);
  alertActions(input, drafts);
  unavailable.push({ kind: "flag_revert", code: "flag_no_history", reason: FLAG_REASON });
  // A total order even if two drafts collide on an id (the first wins).
  const byId = new Map<string, ProposalDraft>();
  for (const d of drafts) if (!byId.has(d.id)) byId.set(d.id, d);
  return { drafts: [...byId.values()], unavailable };
}
