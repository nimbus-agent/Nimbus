/**
 * Agent brief types and guards, re-exported from `@nimbus-dev/sdk`.
 *
 * Previously a hand-maintained mirror of gateway `agents/_lib/findings.ts`.
 * Two names the SDK spells differently are kept as aliases so existing CLI
 * imports keep resolving: `GhostContextItem` (SDK `FederatedItemLite`) and
 * `ConflictCollision` (SDK `ConflictFinding`).
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
  ConflictFinding as ConflictCollision,
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
