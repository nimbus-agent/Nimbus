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

export type ExpertBrief = {
  kind: "expert";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { topicOrFile: string };
  ranked: ExpertFinding[];
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
    typeof b["latencyMs"] === "number"
  );
}

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

export function isImpactBrief(x: unknown): x is ImpactBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "impact" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["affected"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number"
  );
}

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

export function isCatchupBrief(x: unknown): x is CatchupBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "catchup" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["sections"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number"
  );
}

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
    b["query"] !== null &&
    typeof b["query"] === "object"
  );
}

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
    b["query"] !== null &&
    typeof b["query"] === "object"
  );
}

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
    b["query"] !== null &&
    typeof b["query"] === "object"
  );
}

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
    b["query"] !== null &&
    typeof b["query"] === "object"
  );
}

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
    b["query"] !== null &&
    typeof b["query"] === "object"
  );
}
