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

export function isExpertBrief(x: unknown): x is ExpertBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "expert" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["ranked"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isImpactBrief(x: unknown): x is ImpactBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "impact" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["affected"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isCatchupBrief(x: unknown): x is CatchupBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "catchup" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["sections"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isGhostBrief(x: unknown): x is GhostBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "ghost" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["findings"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isConflictBrief(x: unknown): x is ConflictBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "conflict" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["collisions"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isHuddleBrief(x: unknown): x is HuddleBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "huddle" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["contributions"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isJanitorBrief(x: unknown): x is JanitorBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "janitor" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    typeof b["idle"] === "boolean" &&
    Array.isArray(b["peersTouched"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isPreflightBrief(x: unknown): x is PreflightBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "preflight" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["downstreams"]) &&
    typeof b["anyFailed"] === "boolean" &&
    typeof b["anyIncomplete"] === "boolean" &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}
