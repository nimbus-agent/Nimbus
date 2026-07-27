/** One successful job from one run. Minutes throughout — never milliseconds. */
export interface JobObservation {
  repo: string;
  workflow: string;
  job: string;
  exec: number;
  queue: number;
  dagWait: number;
}

/** A key is `<repo> :: <workflow> :: <job>`. */
export interface KeySummary {
  key: string;
  samples: number;
  execMedian: number;
  /** p90 − median of exec: the job's own noise band. */
  execSpread: number;
  queueMedian: number;
  dagWaitMedian: number;
}

export interface BaselineEntry {
  execMedian: number;
  execSpread: number;
}

export interface LatencyBaseline {
  version: 1;
  generated_at: string;
  entries: Map<string, BaselineEntry>;
}

export type FindingKind =
  | "regression"
  | "insufficient-data"
  | "unstable"
  | "new-key"
  | "stale-baseline-entry";

export interface Finding {
  key: string;
  kind: FindingKind;
  detail: string;
}

export interface CheckResult {
  findings: Finding[];
  /** Only `regression` findings can fail the gate. */
  regressions: Finding[];
}
