export type Evidence = {
  itemId: string;
  type:
    | "pr_authored"
    | "pr_reviewed"
    | "issue_opened"
    | "issue_resolved"
    | "incident_resolved"
    | "commit_authored"
    | "chat_mention"
    | "chat_post";
  serviceId: string;
  title: string;
  modifiedAt: number;
  weight: number;
};

export type GapCategory =
  | "missing_entity_type"
  | "missing_relation_emit"
  | "missing_connector"
  | "missing_user_identity"
  | "empty_index";

export type GapNote = {
  category: GapCategory;
  detail: string;
  remediation?: string;
};

export type ExpertFinding = {
  personId: string;
  displayName: string;
  evidence: Evidence[];
  score: number;
  confidence: "high" | "medium" | "low";
};

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

export type ImpactCategory =
  | "service"
  | "pipeline"
  | "dashboard"
  | "oncall_rotation"
  | "downstream_repo";

export type ImpactFinding = {
  category: ImpactCategory;
  affectedItemId: string;
  affectedTitle: string;
  serviceId: string;
  hops: number;
  pathSummary: string;
};

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

export type CatchupItem = {
  itemId: string;
  title: string;
  modifiedAt: number;
  relevanceScore: number;
  relevanceReasons: string[];
};

export type CatchupSection = {
  serviceId: string;
  totalItemsInWindow: number;
  items: CatchupItem[];
};

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
  collisionType: "open_pr" | "assigned_ticket" | "recent_commit" | "open_branch";
  title: string;
  snippet: string;
  modifiedAt: number;
};

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

export type HuddlePr = {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
};

export type HuddleTicket = {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
};

export type HuddleIncident = {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
};

export type HuddleContribution = {
  peerId: string;
  who: string | null;
  prs: HuddlePr[];
  tickets: HuddleTicket[];
  incidents: HuddleIncident[];
};

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
