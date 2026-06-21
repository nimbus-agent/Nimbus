export type {
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
  CatchupSection,
  ConflictType,
  ExpertFinding,
  GapNote,
  ImpactFinding,
  JanitorPeerTouch,
  PreflightDownstream,
} from "@nimbus-dev/sdk";
import { createBriefGuard } from "@nimbus-dev/sdk";

export type ExpertBrief = {
  kind: "expert";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { topicOrFile: string };
  ranked: ExpertFinding[];
};

export const isExpertBrief = createBriefGuard<ExpertBrief>("expert", (b) =>
  Array.isArray(b["ranked"]),
);

export type ImpactBrief = {
  kind: "impact";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { fileOrPrUrl: string };
  startEntityId: string | null;
  affected: ImpactFinding[];
};

export const isImpactBrief = createBriefGuard<ImpactBrief>("impact", (b) =>
  Array.isArray(b["affected"]),
);

export type CatchupBrief = {
  kind: "catchup";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
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

export const isCatchupBrief = createBriefGuard<CatchupBrief>("catchup", (b) =>
  Array.isArray(b["sections"]),
);

export type GhostContextItem = {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
};

export type GhostFinding = {
  peerId: string;
  expert: string | null;
  rank: "high" | "medium" | "low" | "none";
  context: GhostContextItem[];
  suggestedContact: string;
};

// CLI-side mirror of GhostBrief in packages/gateway/src/agents/_lib/findings.ts; rank mirrors ExpertiseRank in federation/types.ts
export type GhostBrief = {
  kind: "ghost";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { file: string };
  startEntityId: string | null;
  findings: GhostFinding[];
};

export const isGhostBrief = createBriefGuard<GhostBrief>(
  "ghost",
  (b) => Array.isArray(b["findings"]),
  { requireQuery: true },
);

export type ConflictCollision = {
  peerId: string;
  who: string | null;
  service: string;
  collisionType: ConflictType;
  title: string;
  snippet: string;
  modifiedAt: number;
};

// CLI-side mirror of ConflictBrief in packages/gateway/src/agents/_lib/findings.ts
export type ConflictBrief = {
  kind: "conflict";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { file: string };
  startEntityId: string | null;
  collisions: ConflictCollision[];
};

export const isConflictBrief = createBriefGuard<ConflictBrief>(
  "conflict",
  (b) => Array.isArray(b["collisions"]),
  { requireQuery: true },
);

/** Mirror of FederatedItemLite in packages/gateway/src/agents/_lib/findings.ts (CLI cannot import gateway). */
type HuddleItem = { title: string; snippet: string; service: string; modifiedAt: number };

export type HuddleContribution = {
  peerId: string;
  who: string | null;
  prs: HuddleItem[];
  tickets: HuddleItem[];
  incidents: HuddleItem[];
};

// CLI-side mirror of HuddleBrief in packages/gateway/src/agents/_lib/findings.ts
export type HuddleBrief = {
  kind: "huddle";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { sinceMs: number };
  contributions: HuddleContribution[];
};

export const isHuddleBrief = createBriefGuard<HuddleBrief>(
  "huddle",
  (b) => Array.isArray(b["contributions"]),
  { requireQuery: true },
);

// CLI-side mirror of JanitorBrief in packages/gateway/src/agents/_lib/findings.ts
export type JanitorBrief = {
  kind: "janitor";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { resourceRef: string; idleDays: number };
  idle: boolean;
  proposalSuppressed: boolean;
  cleanupAction: string | null;
  peersClear: number;
  peersTouched: JanitorPeerTouch[];
};

export const isJanitorBrief = createBriefGuard<JanitorBrief>(
  "janitor",
  (b) => typeof b["idle"] === "boolean" && Array.isArray(b["peersTouched"]),
  { requireQuery: true },
);

// CLI-side mirror of PreflightBrief in packages/gateway/src/agents/_lib/findings.ts
export type PreflightBrief = {
  kind: "preflight";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { ref: string; namespace: string };
  downstreams: PreflightDownstream[];
  anyFailed: boolean;
  anyIncomplete: boolean;
};

export const isPreflightBrief = createBriefGuard<PreflightBrief>(
  "preflight",
  (b) =>
    Array.isArray(b["downstreams"]) &&
    typeof b["anyFailed"] === "boolean" &&
    typeof b["anyIncomplete"] === "boolean",
  { requireQuery: true },
);
