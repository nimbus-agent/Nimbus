import type { GapNote } from "../agents/_lib/findings.ts";
import type { TimeBasis, TriggerStatus } from "./trigger-facts.ts";
import type { TriggerService } from "./trigger-sources.ts";

/**
 * The structured incident record (Phase 10 IC3, incident-engine spec § 5.3, design E). It stores what the
 * index held when the record was assembled: ids, capped single-line titles, times with their basis, the rule
 * that matched each lane entry, counts before capping, history rows and gaps. It stores NO body, description,
 * alert detail, e-mail address, chat text beyond the capped title, or credential.
 *
 * `record_sha256` hashes the FACTUAL CORE only (`CORE_KEYS`). Volatile fields (`version`, `assembledAtMs`,
 * `freshness`) are functions of the clock or of the store, never of the evidence, and are classified by
 * `RECORD_FIELD_CLASS`, a `Record<keyof IncidentRecordV1, ...>`, so adding a field without classifying it is a
 * compile error.
 */

/** Bump when the lane logic changes: it is inside the hash, so the next refresh writes a new version. */
export const INCIDENT_ENGINE_VERSION = 2;
export const INCIDENT_SCHEMA_VERSION = 1;

export type { GapNote };

export type TimeValue = { readonly ms: number | null; readonly basis: TimeBasis };

export type TriggerBlock = {
  readonly itemId: string;
  readonly service: TriggerService;
  readonly type: string;
  /** The provider's own id (the item's `external_id`). */
  readonly providerId: string;
  readonly title: string;
  readonly url: string | null;
  readonly status: TriggerStatus;
  readonly statusRaw: string | null;
  /** The normalised severity label (Bigeye: null). */
  readonly severity: string | null;
  readonly severityRaw: string | null;
  readonly opened: TimeValue;
  readonly closed: TimeValue;
  /** The `__created` row of `item_history` (the first time the sync saw the item), when recorded. */
  readonly firstObservedMs: number | null;
  /** PagerDuty: how many assignees. Never an address. */
  readonly assigneeCount: number | null;
  readonly slaStatus: string | null;
};

export type BindingVia =
  | "pagerduty_service"
  | "nimbus_service_id"
  | "repo"
  | "jsm_alert_tag"
  | "sentry_project"
  | "data_model";

export type BindingBlock = {
  readonly bound: boolean;
  readonly service: string | null;
  readonly via: BindingVia | null;
  /** Why it is unbound (`excluded` or `unknown`), null when bound. */
  readonly unboundReason: "excluded" | "unknown" | "metadata_unreadable" | null;
};

export type DeploymentView = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly provider: string;
  readonly environment: string;
  readonly sha: string;
  readonly ref: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly conclusion: string;
  readonly minutesBeforeOpen: number;
  readonly rule: "last_deployment_before_open";
};

export type PrView = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly service: string;
  readonly mergedAtMs: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changedFiles: number | null;
  readonly rule: "graph:deployed+merged_as" | "merge_commit_sha";
};

export type CiView = {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly service: string;
  readonly conclusion: string | null;
  readonly atMs: number;
  readonly rule: "graph:built_by" | "ci_run_external_id";
};

export type ChangeLane = {
  /** Why the lane did not run (`unbound`, `no_open_time`), null when it ran. */
  readonly skipped: "unbound" | "no_open_time" | null;
  readonly deployment: DeploymentView | null;
  /** A `correlates_with` edge from the deployment to the trigger exists (corroboration, never the rule). */
  readonly graphCorrelated: boolean | null;
  readonly pr: PrView | null;
  readonly ci: CiView | null;
};

export type ChatMessageView = {
  readonly id: string;
  readonly service: string;
  readonly title: string;
  readonly url: string | null;
  readonly atMs: number;
  /** `chat_phrase:<term>` */
  readonly rule: string;
};

export type ChatLane = {
  readonly skipped: "unbound" | "no_open_time" | null;
  /** The window's lower bound (open - 24 h). Its upper bound is the assembly time: volatile, not stored. */
  readonly fromMs: number | null;
  readonly terms: readonly string[];
  readonly termsSource: "configured" | "derived" | "none";
  readonly total: number;
  readonly messages: readonly ChatMessageView[];
};

export type PriorView = {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
  readonly openedAtMs: number | null;
  readonly status: TriggerStatus;
  readonly closedAtMs: number | null;
  readonly closedBasis: TimeBasis;
  /**
   * How many remediation proposals Nimbus EXECUTED for that earlier incident (Phase 10 IC5a, engine version 2): what
   * was done, never what worked. Counted from `incident_proposal` (status `executed`), 0 when it was never acted
   * on or its record is gone.
   */
  readonly actions: number;
  readonly rule: "same_service_prior";
};

export type PriorLane = {
  readonly skipped: "unbound" | "no_open_time" | null;
  readonly total: number;
  readonly incidents: readonly PriorView[];
};

export type ConcurrentView = {
  readonly recordId: string;
  readonly triggerItemId: string;
  readonly source: string;
  readonly severity: string | null;
  readonly service: string | null;
  readonly openedAtMs: number;
  readonly rule: "concurrent_30m";
};

export type ConcurrentLane = {
  readonly skipped: "no_open_time" | null;
  readonly total: number;
  readonly records: readonly ConcurrentView[];
};

export type DataItemView = {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
  readonly atMs: number | null;
  readonly rule: "name_match" | "data:pr_title_or_branch";
};

export type DataLineageView = {
  readonly model: string;
  readonly to: string;
  readonly rule: "data:derived_from";
};

export type DataLane = {
  readonly models: readonly string[];
  readonly lineage: readonly DataLineageView[];
  readonly orchestration: readonly DataItemView[];
  readonly prs: readonly DataItemView[];
  readonly totals: {
    readonly lineage: number;
    readonly orchestration: number;
    readonly prs: number;
  };
};

export type OnCallPerson = {
  readonly userName: string | null;
  readonly scheduleName: string | null;
  readonly level: number | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly isMe: boolean;
};

export type OnCallLane = {
  readonly status: "ok" | "none_on_call" | "no_match" | "no_data" | "skipped";
  /** How the service was matched (`service_id`, `binding`, `service_name`, `schedule_or_policy`), display only. */
  readonly resolvedVia: string | null;
  readonly youAreOnCall: boolean | null;
  readonly current: readonly OnCallPerson[];
  readonly next: readonly OnCallPerson[];
  readonly rule: "on_call_now";
};

export type HistoryRowView = {
  readonly key: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly observedAtMs: number;
  readonly sourceAtMs: number | null;
};

export type HistoryLane = {
  /** When this service's history begins (V94 and its first sync after), null when unknown. */
  readonly startsMs: number | null;
  readonly total: number;
  readonly truncated: number;
  readonly rows: readonly HistoryRowView[];
};

export type RecordCounts = {
  readonly chat: number;
  readonly prior: number;
  readonly concurrent: number;
  readonly history: number;
  readonly dataLineage: number;
  readonly dataOrchestration: number;
  readonly dataPrs: number;
};

export type FreshnessRow = {
  readonly service: string;
  readonly connected: boolean;
  readonly lastSyncMs: number | null;
};

export type Freshness = {
  readonly rows: readonly FreshnessRow[];
  /** The chat window's upper bound: the assembly time. */
  readonly chatToMs: number | null;
  /** Whether any on-call source behind the lane was older than the staleness bound. */
  readonly onCallStale: boolean | null;
};

export type IncidentRecordV1 = {
  readonly schema: typeof INCIDENT_SCHEMA_VERSION;
  readonly engine: number;
  readonly trigger: TriggerBlock;
  readonly binding: BindingBlock;
  readonly change: ChangeLane;
  readonly chat: ChatLane;
  readonly prior: PriorLane;
  readonly concurrent: ConcurrentLane;
  readonly data: DataLane | null;
  readonly onCall: OnCallLane;
  readonly history: HistoryLane;
  readonly gaps: readonly GapNote[];
  readonly counts: RecordCounts;
  /** Assigned by the store inside its transaction, AFTER the hash comparison. */
  readonly version: number;
  readonly assembledAtMs: number;
  readonly freshness: Freshness;
};

export const RECORD_FIELD_CLASS: Readonly<Record<keyof IncidentRecordV1, "core" | "volatile">> =
  Object.freeze({
    schema: "core",
    engine: "core",
    trigger: "core",
    binding: "core",
    change: "core",
    chat: "core",
    prior: "core",
    concurrent: "core",
    data: "core",
    onCall: "core",
    history: "core",
    gaps: "core",
    counts: "core",
    version: "volatile",
    assembledAtMs: "volatile",
    freshness: "volatile",
  });

/** The hashed fields, an EXPLICIT list (never "everything but the volatile ones"). */
export const CORE_KEYS = [
  "schema",
  "engine",
  "trigger",
  "binding",
  "change",
  "chat",
  "prior",
  "concurrent",
  "data",
  "onCall",
  "history",
  "gaps",
  "counts",
] as const satisfies readonly (keyof IncidentRecordV1)[];

export type CoreRecord = Pick<IncidentRecordV1, (typeof CORE_KEYS)[number]>;

/** The factual core of a record: only `CORE_KEYS`, in that order. */
export function coreOf(record: IncidentRecordV1): CoreRecord {
  return {
    schema: record.schema,
    engine: record.engine,
    trigger: record.trigger,
    binding: record.binding,
    change: record.change,
    chat: record.chat,
    prior: record.prior,
    concurrent: record.concurrent,
    data: record.data,
    onCall: record.onCall,
    history: record.history,
    gaps: record.gaps,
    counts: record.counts,
  };
}

export type RecordStatus = TriggerStatus;
