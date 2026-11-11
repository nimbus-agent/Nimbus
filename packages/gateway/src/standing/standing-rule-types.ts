// packages/gateway/src/standing/standing-rule-types.ts
// The shapes of a standing approval rule (Phase 10 SA3, invariant I55, spec § 5.2). Pure types and
// the limits the owner's rulings fixed (OR-10-5, OR-10-6); no I/O.
import type { JsonValue } from "../automation/workflow-steps.ts";

/** One input field of the rule's write step: a constant the owner approved, or a declared-query id. */
export type ScopeEntry =
  | { readonly const: JsonValue }
  | { readonly query: number; readonly column: string };

/** Per input field of the write step. A rule can never be wider than the step it names. */
export type StandingScope = Readonly<Record<string, ScopeEntry>>;

/** OR-10-5: an optional weekday / time-of-day window; `days` are ISO weekdays (1 = Monday ... 7 = Sunday). */
export type StandingWindow = {
  readonly days: readonly number[];
  /** `HH:MM`, 24-hour, inclusive. */
  readonly from: string;
  /** `HH:MM`, 24-hour, exclusive. Always later than `from`: a window never crosses midnight. */
  readonly to: string;
  /** An IANA zone id. */
  readonly tz: string;
};

export type StandingRule = {
  readonly id: string;
  readonly createdAt: number;
  readonly workflowId: string;
  readonly workflowSha256: string;
  readonly stepIndex: number;
  readonly actionType: string;
  readonly toolId: string;
  readonly scope: StandingScope;
  readonly window: StandingWindow | undefined;
  readonly expiresAt: number;
  readonly maxActions: number;
  readonly actionsUsed: number;
  readonly pausedAt: number | undefined;
  readonly revokedAt: number | undefined;
  readonly lastFiredAt: number | undefined;
  readonly approvalAuditId: number;
};

/** What the create handler inserts, after the owner approved `standing.rule.create`. */
export type NewStandingRule = Omit<
  StandingRule,
  "id" | "actionsUsed" | "pausedAt" | "revokedAt" | "lastFiredAt"
>;

export type StandingFire = {
  readonly fireId: string;
  readonly ruleId: string;
  readonly firedAt: number;
  readonly actionType: string;
  readonly matchedScopeSha256: string;
};

/** OR-10-6: an expiry is required, at most 90 days, default 30. */
export const STANDING_DEFAULT_DAYS = 30;
export const STANDING_MAX_DAYS = 90;
/** OR-10-6: an action ceiling is required, at most 500, default 100. */
export const STANDING_DEFAULT_MAX_ACTIONS = 100;
export const STANDING_MAX_ACTIONS = 500;
export const DAY_MS = 86_400_000;

/** The state a rule is shown in. Revoked is final. */
export type StandingRuleState = "live" | "paused" | "revoked" | "expired" | "exhausted";
