/**
 * Agent brief types and guards, re-exported from `@nimbus-dev/sdk`.
 *
 * Previously a hand-maintained mirror of gateway `agents/_lib/findings.ts`.
 * `GhostContextItem` is kept as an alias of the SDK's `FederatedItemLite` so
 * existing CLI imports keep resolving.
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
  FederatedItemLite as GhostContextItem,
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
} from "@nimbus-dev/sdk";
