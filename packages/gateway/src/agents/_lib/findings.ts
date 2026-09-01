/**
 * Agent brief types and guards.
 *
 * These now live in `@nimbus-dev/sdk` so the gateway, the CLI and
 * `@nimbus-dev/client` share one definition. This module re-exports them so
 * existing gateway imports keep working unchanged.
 */
export type {
  AgentBrief,
  AgentBriefBase,
  BriefReadyPayload,
  CatchupBrief,
  CatchupItem,
  CatchupSection,
  ConflictBrief,
  ConflictFinding,
  ConflictType,
  Evidence,
  ExpertBrief,
  ExpertFinding,
  ExpertiseRank,
  FederatedItemLite,
  GapCategory,
  GapNote,
  GhostBrief,
  GhostFinding,
  HuddleBrief,
  HuddleContribution,
  ImpactBrief,
  ImpactCategory,
  ImpactFinding,
  JanitorBrief,
  JanitorPeerTouch,
  PreflightBrief,
  PreflightDownstream,
  WhyBrief,
  WhyChangeSubject,
  WhyFinding,
  WhyItemSubject,
  WhyLane,
  WhyPeek,
  WhySubject,
} from "@nimbus-dev/sdk";

export {
  isCatchupBrief,
  isConflictBrief,
  isExpertBrief,
  isGhostBrief,
  isHuddleBrief,
  isImpactBrief,
  isJanitorBrief,
  isPreflightBrief,
  isWhyBrief,
} from "@nimbus-dev/sdk";
