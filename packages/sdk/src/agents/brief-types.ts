/** Shared agent-brief type building blocks — identical across gateway and CLI. */

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

export type AgentBriefBase = {
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
};

export type ExpertFinding = {
  personId: string;
  displayName: string;
  evidence: Evidence[];
  score: number;
  confidence: "high" | "medium" | "low";
};

export type ImpactFinding = {
  category: "service" | "pipeline" | "dashboard" | "oncall_rotation" | "downstream_repo";
  affectedItemId: string;
  affectedTitle: string;
  serviceId: string;
  hops: number;
  pathSummary: string;
};

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

export type JanitorPeerTouch = {
  peerId: string;
  who: string | null;
  lastSeenDaysAgo: number | null;
};

export type PreflightDownstream = {
  peerId: string;
  who: string | null;
  status: "pass" | "fail" | "declined" | "not_configured";
  summary: string;
};

export type ConflictType = "open_pr" | "assigned_ticket" | "recent_commit" | "open_branch";
