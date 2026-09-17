import type { SweepKind } from "../config/fleet-toml.ts";
import type { AgentMethod, FLEET_ELIGIBILITY } from "../ipc/agents-rpc.ts";

/**
 * The agents a fleet brief can actually come from, DERIVED from `FLEET_ELIGIBILITY` rather than
 * restated beside it. Flipping an agent to `"eligible"` makes `FLEET_DIGEST_EXTRACTORS` fail to
 * compile until its extractor exists (spec § 4.2).
 */
export type EligibleAgentMethod = {
  [K in AgentMethod]: (typeof FLEET_ELIGIBILITY)[K] extends "eligible" ? K : never;
}[AgentMethod];

/**
 * A brief reduced to what can be compared across runs.
 *
 * Two axes, never one: `keys` are identities (appeared / resolved) and `metrics` are magnitudes
 * (moved by N). Only magnitudes can be threshold-suppressed, which is why a BOOLEAN belongs in
 * `keys` — as a metric it would be silently swallowed by `digest_min_delta >= 2` (spec § 4.1).
 */
export interface BriefSummary {
  readonly keys: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
}

/** `undefined` when the stored JSON does not match this agent's shape (spec § 4.3). */
export type FleetDigestExtractor = (findings: unknown) => BriefSummary | undefined;

/** `null` on a side means the metric was ABSENT there — never coerced to 0 (spec § 6.1). */
export interface FleetMetricDelta {
  readonly before: number | null;
  readonly after: number | null;
  readonly delta: number | null;
}

export interface FleetJobDigest {
  readonly jobId: string;
  readonly agentMethod: string;
  /** False = the job produced briefs but is no longer in config (spec § 5.1). */
  readonly configured: boolean;
  readonly status: "changed" | "unchanged" | "unchanged_within_threshold";
  readonly minDelta: number;
  readonly currentBriefId: string;
  readonly currentCreatedAt: number;
  readonly predecessorBriefId: string;
  readonly predecessorCreatedAt: number;
  /** current − predecessor. NOT the window: § 2.1 lets these differ per job. */
  readonly comparisonSpanMs: number;
  readonly metrics: Readonly<Record<string, FleetMetricDelta>>;
  /**
   * Count of metrics withheld by `digest_min_delta` on THIS job, regardless of `status` (spec § 6).
   * A metric can be suppressed even when the job also changed some other way — `status` alone
   * cannot carry that, since `changed` says nothing about what else was withheld.
   */
  readonly metricsSuppressed: number;
  readonly keysAppeared: readonly string[];
  readonly keysResolved: readonly string[];
}

/**
 * `configured` on every population, not only `FleetJobDigest`: a job that produced briefs but is no
 * longer in config (spec § 5.1) can land in ANY of these four, not only the compared-job path, and
 * the `[unconfigured]` marker is what stops a reader inferring it will run again tonight.
 */
export interface FleetDigestNotCompared {
  readonly firstObservation: readonly {
    readonly jobId: string;
    readonly briefId: string;
    readonly createdAt: number;
    readonly configured: boolean;
  }[];
  readonly notSummarizable: readonly {
    readonly jobId: string;
    readonly briefId: string;
    readonly role: "current" | "predecessor";
    readonly reason: string;
    readonly configured: boolean;
  }[];
  readonly noBriefInWindow: readonly {
    readonly jobId: string;
    readonly agent: string;
    readonly configured: boolean;
  }[];
  /**
   * The job kept its name but was pointed at a different agent, so the pair straddles two brief
   * shapes. Its OWN population, not folded into `notSummarizable`: both briefs read perfectly
   * well: what failed is the comparison, and calling that "not summarizable" would send a reader
   * looking for a corrupt row that does not exist.
   */
  readonly agentChanged: readonly {
    readonly jobId: string;
    readonly from: string;
    readonly to: string;
    readonly configured: boolean;
  }[];
}

export type FleetSweepSubjectDigest = FleetJobDigest & { readonly subjectKey: string };

export interface FleetDigestSubjectRef {
  readonly subjectKey: string;
  readonly briefId: string;
  readonly reason: string;
}

export interface FleetSweepDigest {
  readonly jobId: string;
  readonly agentMethod: string;
  /** From config; for an unconfigured sweep, the key prefix — null only if that prefix is not a kind. */
  readonly sweepKind: SweepKind | null;
  readonly configured: boolean;
  /** At the last enumeration; null when the job has never enumerated. */
  readonly subjectsTotal: number | null;
  readonly subjectsSweptInWindow: number;
  /** ceil(total / max_subjects); null when either is unknown. */
  readonly rotationRunsEstimate: number | null;
  /** rotationRunsEstimate × interval; null under the same condition. */
  readonly rotationMsEstimate: number | null;
  readonly retentionMs: number;
  readonly rotationExceedsRetention: boolean;
  readonly moved: readonly FleetSweepSubjectDigest[];
  readonly unchangedCount: number;
  /** Unchanged ONLY because digest_min_delta withheld a metric (2a § 6.3). */
  readonly unchangedWithinThresholdCount: number;
  /** Every key, code-unit sorted; Markdown truncates, JSON does not. */
  readonly firstObservationKeys: readonly string[];
  readonly notSummarizable: readonly FleetDigestSubjectRef[];
  readonly agentChanged: readonly FleetDigestSubjectRef[];
  /** Job-level: no subject of this job has a brief in the window. */
  readonly noBriefInWindow: boolean;
}

export interface FleetDigestResult {
  readonly windowMs: number;
  readonly generatedAt: number;
  readonly markdown: string;
  readonly jobs: readonly FleetJobDigest[];
  readonly notCompared: FleetDigestNotCompared;
  readonly sweeps: readonly FleetSweepDigest[];
}
