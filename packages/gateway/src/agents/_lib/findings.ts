import { createBriefGuard } from "@nimbus-dev/sdk";

import type { ExpertiseRank } from "../../federation/types.ts";

export type {
  AgentBriefBase,
  CatchupItem,
  CatchupSection,
  ConflictType,
  Evidence,
  ExpertFinding,
  GapCategory,
  GapNote,
  ImpactFinding,
  JanitorPeerTouch,
  PreflightDownstream,
} from "@nimbus-dev/sdk";

import type {
  AgentBriefBase,
  CatchupSection,
  ConflictType,
  ExpertFinding,
  ImpactFinding,
  JanitorPeerTouch,
  PreflightDownstream,
} from "@nimbus-dev/sdk";

export type ExpertBrief = AgentBriefBase & {
  kind: "expert";
  query: { topicOrFile: string };
  ranked: ExpertFinding[];
};

export type ImpactCategory =
  | "service"
  | "pipeline"
  | "dashboard"
  | "oncall_rotation"
  | "downstream_repo";

export type ImpactBrief = AgentBriefBase & {
  kind: "impact";
  query: { fileOrPrUrl: string };
  startEntityId: string | null;
  affected: ImpactFinding[];
};

export type CatchupBrief = AgentBriefBase & {
  kind: "catchup";
  query: { sinceMs: number };
  selfPersonId: string | null;
  involvement: {
    ownedServices: string[];
    activeRepos: string[];
    incidentServices: string[];
    collaboratorPersonIds: string[];
  };
  sections: CatchupSection[];
};

/** A leak-proof projection of FederatedItem (no metadata), reused by the huddle buckets. */
export type FederatedItemLite = {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
};

export type GhostFinding = {
  peerId: string;
  expert: string | null;
  rank: ExpertiseRank;
  context: FederatedItemLite[];
  suggestedContact: string;
};

export type GhostBrief = AgentBriefBase & {
  kind: "ghost";
  query: { file: string };
  startEntityId: string | null;
  findings: GhostFinding[];
};

export type ConflictFinding = {
  peerId: string;
  who: string | null;
  service: string;
  collisionType: ConflictType;
  title: string;
  snippet: string;
  modifiedAt: number;
};

export type ConflictBrief = AgentBriefBase & {
  kind: "conflict";
  query: { file: string };
  startEntityId: string | null;
  collisions: ConflictFinding[];
};

export type HuddleContribution = {
  peerId: string;
  who: string | null;
  prs: FederatedItemLite[];
  tickets: FederatedItemLite[];
  incidents: FederatedItemLite[];
};

export type HuddleBrief = AgentBriefBase & {
  kind: "huddle";
  query: { sinceMs: number };
  contributions: HuddleContribution[];
};

export type JanitorBrief = AgentBriefBase & {
  kind: "janitor";
  query: { resourceRef: string; idleDays: number };
  idle: boolean;
  proposalSuppressed: boolean;
  cleanupAction: string | null;
  peersClear: number;
  peersTouched: JanitorPeerTouch[];
};

export type PreflightBrief = AgentBriefBase & {
  kind: "preflight";
  query: { ref: string; namespace: string };
  downstreams: PreflightDownstream[];
  anyFailed: boolean;
  anyIncomplete: boolean;
};

export type AgentBrief =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief
  | JanitorBrief
  | PreflightBrief;

export type BriefReadyPayload<B extends AgentBrief> = {
  sessionId: string;
  brief: string;
  findings: B;
};

export const isExpertBrief = createBriefGuard<ExpertBrief>(
  "expert",
  (b) => Array.isArray(b["ranked"]),
  { requireQuery: true },
);

export const isImpactBrief = createBriefGuard<ImpactBrief>(
  "impact",
  (b) => Array.isArray(b["affected"]),
  { requireQuery: true },
);

export const isCatchupBrief = createBriefGuard<CatchupBrief>(
  "catchup",
  (b) => Array.isArray(b["sections"]),
  { requireQuery: true },
);

export const isGhostBrief = createBriefGuard<GhostBrief>(
  "ghost",
  (b) => Array.isArray(b["findings"]),
  { requireQuery: true },
);

export const isConflictBrief = createBriefGuard<ConflictBrief>(
  "conflict",
  (b) => Array.isArray(b["collisions"]),
  { requireQuery: true },
);

export const isHuddleBrief = createBriefGuard<HuddleBrief>(
  "huddle",
  (b) => Array.isArray(b["contributions"]),
  { requireQuery: true },
);

export const isJanitorBrief = createBriefGuard<JanitorBrief>(
  "janitor",
  (b) => typeof b["idle"] === "boolean" && Array.isArray(b["peersTouched"]),
  { requireQuery: true },
);

export const isPreflightBrief = createBriefGuard<PreflightBrief>(
  "preflight",
  (b) =>
    Array.isArray(b["downstreams"]) &&
    typeof b["anyFailed"] === "boolean" &&
    typeof b["anyIncomplete"] === "boolean",
  { requireQuery: true },
);
