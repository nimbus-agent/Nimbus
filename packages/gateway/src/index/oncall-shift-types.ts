/**
 * The on-call shift model (Phase 10 MB3), shared by the two writers (the PagerDuty and Jira Service
 * Management refresh steps) and the reader (`oncall-now-query.ts`). Pure: no database, no network.
 * A shift is an `item` row of this type; it is written only by those two syncables.
 */
export const ONCALL_SHIFT_ITEM_TYPE = "oncall_shift";

/** A refresh runs at most this often per source (an ATTEMPT, so a failing provider retries once per interval). */
export const ONCALL_REFRESH_INTERVAL_MS = 15 * 60_000;

/** A source whose oldest row was fetched longer ago than this is reported stale (four intervals). */
export const ONCALL_STALE_MS = 60 * 60_000;

export type OncallSource = "pagerduty" | "jsm";

/** `item.service` of the rows each source writes. */
export const ONCALL_SOURCE_SERVICE: Record<OncallSource, string> = {
  pagerduty: "pagerduty",
  jsm: "jira",
};

/** The metadata a shift row carries. Unknown values are OMITTED, never guessed. */
export interface OncallShiftMeta {
  source: OncallSource;
  user_name: string;
  user_email?: string;
  escalation_policy_id?: string;
  escalation_policy_name?: string;
  escalation_level?: number;
  schedule_id?: string;
  schedule_name?: string;
  /** Absent = since forever / unknown. JSM rows carry neither time. */
  start_ms?: number;
  /** Absent = open-ended / unknown. */
  end_ms?: number;
  service_ids: string[];
  service_names: string[];
  service_map_complete: boolean;
  is_me: boolean;
  fetched_at_ms: number;
  /** JSM only: the reader cannot tell the current shift from the next one by time. */
  shift?: "current" | "next";
}
