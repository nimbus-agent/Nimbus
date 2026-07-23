/**
 * Why-brief types, gateway-local.
 *
 * These deliberately do NOT live in `@nimbus-dev/sdk` yet: the published SDK
 * is 1.5.x and promoting the ninth agent is the step-2 `sdk 1.6.0` →
 * `client 0.8.0` hop (see the why-lens design spec). When that lands, these
 * move to the SDK and `findings.ts` re-exports them like the other eight.
 */
import type { AgentBriefBase } from "./findings.ts";

export type WhyLane =
  | "authorship"
  | "pull_request"
  | "ticket"
  | "discussion"
  | "driver"
  | "downstream";

export type WhyFinding = {
  lane: WhyLane;
  title: string;
  detail: string;
  url: string | null;
  occurredAt: number | null;
  entityId: string | null;
};

export type WhySubject = {
  repoRoot: string;
  filePath: string;
  lineNo: number | null;
  symbol: string | null;
};

export type WhyBrief = AgentBriefBase & {
  kind: "why";
  query: { ref: string; line: number | null };
  subject: WhySubject | null;
  findings: WhyFinding[];
};

export type WhyPeek = {
  subject: { repoRoot: string; filePath: string; lineNo: number } | null;
  author: string | null;
  authorEmail: string | null;
  commitSha: string | null;
  committedAt: number | null;
  commitSubject: string | null;
  pr: { number: number | null; title: string; url: string | null } | null;
  ticket: { key: string; title: string; url: string | null } | null;
  hasMore: boolean;
};

export type WhyInput = { ref: string; line?: number };
