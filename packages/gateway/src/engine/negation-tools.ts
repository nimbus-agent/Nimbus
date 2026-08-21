import { createTool } from "@mastra/core/tools";

import type { LocalIndex } from "../index/local-index.ts";
import {
  runNoDownstreamIncidentQuery,
  runNotReviewedQuery,
  runNotTouchingQuery,
} from "../index/negation-query.ts";
import type { PersonRecord } from "../people/person-types.ts";
import { negationDisclosureLine, recordNegationDisclosure } from "./negation-disclosure.ts";

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function optTrimmed(q: Record<string, unknown>, k: string): string | undefined {
  const v = q[k];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

// Capped at 100, matching the sibling tool on the same agent (`fetchMoreIndexResults`,
// `engine/agent.ts:190`): these tools return raw, unprojected rows (including `metadata` and
// `body_preview`), so a higher cap would hand the model far more context than the projected
// search tools ever do for the same row count.
function optLimit(q: Record<string, unknown>): number {
  const v = q["limit"];
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(100, Math.max(1, Math.floor(v)))
    : 20;
}

/**
 * Days-back to an epoch-ms lower bound, converted at the tool boundary. The gateway has no
 * duration-string parser (`parseSinceDurationToMs` lives in `packages/cli/src/lib/parse-since.ts`
 * and B.1 explicitly refused to write a second one) and an epoch millisecond is a hostile thing
 * to ask a model to compute, so the tool surface takes `sinceDays: number` and does the one
 * subtraction itself. Omitted (or not a finite number) means "ever" — `undefined`, never `0`.
 */
function optSinceMsFromDays(q: Record<string, unknown>): number | undefined {
  const v = q["sinceDays"];
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  // A day count large enough that `sinceDays * 86_400_000` would overflow to a non-finite
  // number (e.g. `1e308`) means "ever" — which is exactly what an absent `sinceDays` already
  // means — so clamp to the largest day count the multiplication can carry without overflowing,
  // rather than let a non-finite bound flow into the query.
  const MAX_SINCE_DAYS = Number.MAX_SAFE_INTEGER / 86_400_000;
  const sinceDays = Math.max(0, Math.min(MAX_SINCE_DAYS, Math.floor(v)));
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  return Number.isFinite(sinceMs) ? sinceMs : undefined;
}

/**
 * Emit the refusal payload AND record the same sentence. Both, always: the recorded copy is what
 * the user sees regardless of the model (spec § 5.1), and the embedded copy is what keeps the
 * guarantee from degrading to silence if the request store is missing (§ 5.1.1).
 */
function refusalResult(
  tool: string,
  refusal: { message: string; remediation: string; reason: string },
): Record<string, unknown> {
  const line = negationDisclosureLine({
    kind: "refused",
    tool,
    message: refusal.message,
    remediation: refusal.remediation,
  });
  if (line !== undefined) recordNegationDisclosure(line);
  return {
    refused: true,
    // Matches `missingSubstrateRefusal` (`index/negation-predicates.ts:55`) and the MCP tool
    // descriptions, which instruct the model to check `status === "refused"`: one refusal
    // vocabulary across both surfaces, not `refused: true` on one and `status` on the other.
    status: "refused",
    reason: refusal.reason,
    message: refusal.message,
    remediation: refusal.remediation,
    disclosure: line,
    note: "Do not answer the question from ranked search instead. The data needed to verify this negation is not indexed, so a list you produce would be an artifact of the missing data rather than an answer.",
  };
}

function withExclusions(
  tool: string,
  counts: ReadonlyArray<{ label: string; n: number }>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const line = negationDisclosureLine({ kind: "excluded", tool, counts });
  if (line === undefined) return payload;
  recordNegationDisclosure(line);
  return { ...payload, disclosure: line };
}

/** `findPeopleWithoutReviews`'s row shape. Defined here rather than importing `personToJson` from
 * `ipc/people-rpc.ts`, which is module-private (not exported) — the engine must not reach into
 * `ipc/` internals. */
function personToToolRow(p: PersonRecord): {
  id: string;
  displayName: string | null;
  canonicalEmail: string | null;
} {
  return { id: p.id, displayName: p.displayName, canonicalEmail: p.canonicalEmail };
}

export function createNegationTools(deps: { localIndex: LocalIndex }) {
  const findPrsNotTouching = createTool({
    id: "findPrsNotTouching",
    description:
      "findPrsNotTouching(pathGlob, service?, limit?) — pull requests with NO indexed changed-file path matching pathGlob (a GLOB such as 'tests/**'; required). Use this, never searchLocalIndex, when the question is which PRs do NOT touch something: it proves its substrate first and refuses when PR file coverage is not indexed, because an unfetched PR is indistinguishable from one that genuinely never touched the path. Scoped to pull requests intrinsically — there is no itemType argument. service is optional; omitting it searches every indexed forge. limit is optional (default 20, max 100).",
    execute: async (inputData: unknown) => {
      const q = asRecord(inputData);
      const pathGlob = optTrimmed(q, "pathGlob");
      if (pathGlob === undefined) {
        return { error: "pathGlob is required (a GLOB pattern such as 'tests/**')" };
      }
      const service = optTrimmed(q, "service");
      const db = deps.localIndex.getDatabase();
      const outcome = runNotTouchingQuery(db, deps.localIndex, {
        pathGlob,
        types: ["pr"],
        ...(service === undefined ? {} : { services: [service] }),
        limit: optLimit(q),
      });
      if (outcome.kind === "refused") {
        return refusalResult("findPrsNotTouching", outcome.refusal);
      }
      return withExclusions(
        "findPrsNotTouching",
        [
          { label: "no file coverage indexed", n: outcome.gaps.excludedNoCoverage },
          { label: "file coverage truncated", n: outcome.gaps.excludedTruncated },
        ],
        { items: outcome.rows, gaps: outcome.gaps },
      );
    },
  });

  const findDeploymentsWithoutIncident = createTool({
    id: "findDeploymentsWithoutIncident",
    description:
      "findDeploymentsWithoutIncident(service?, limit?) — deployments with NO outgoing correlates_with edge to a downstream incident. Use this, never searchLocalIndex, when the question is which deployments had NO incident: it proves its substrate first and refuses when deployment-to-incident correlation is not indexed. The correlation window is fixed at the time the edge was written and cannot be widened per query — there is deliberately no `within` argument, because the edge timestamp is a write time, not an event time, so a query-time window cannot be reconstructed even in principle. Scoped to deployments intrinsically — there is no itemType argument. service is optional; omitting it searches every indexed service. limit is optional (default 20, max 100).",
    execute: async (inputData: unknown) => {
      const q = asRecord(inputData);
      const service = optTrimmed(q, "service");
      const db = deps.localIndex.getDatabase();
      const outcome = runNoDownstreamIncidentQuery(db, deps.localIndex, {
        types: ["deployment"],
        ...(service === undefined ? {} : { services: [service] }),
        limit: optLimit(q),
      });
      if (outcome.kind === "refused") {
        return refusalResult("findDeploymentsWithoutIncident", outcome.refusal);
      }
      return withExclusions(
        "findDeploymentsWithoutIncident",
        [{ label: "no graph entity of the required type", n: outcome.gaps.excludedNoGraphEntity }],
        { items: outcome.rows, gaps: outcome.gaps },
      );
    },
  });

  const findPeopleWithoutReviews = createTool({
    id: "findPeopleWithoutReviews",
    description:
      "findPeopleWithoutReviews(sinceDays?, limit?) — people with NO outgoing reviewed edge newer than sinceDays days ago. Use this, never searchLocalIndex, when the question is who has NOT reviewed anything: it proves its substrate first and refuses when review activity is not indexed for the window, because an un-synced person is indistinguishable from one who genuinely reviewed nothing. sinceDays is a number of days back from now (e.g. 7 for the last week); omitting it means ever. limit is optional (default 20, max 100).",
    execute: async (inputData: unknown) => {
      const q = asRecord(inputData);
      const sinceMs = optSinceMsFromDays(q);
      const db = deps.localIndex.getDatabase();
      const outcome = runNotReviewedQuery(db, {
        ...(sinceMs === undefined ? {} : { sinceMs }),
        limit: optLimit(q),
      });
      if (outcome.kind === "refused") {
        return refusalResult("findPeopleWithoutReviews", outcome.refusal);
      }
      return withExclusions(
        "findPeopleWithoutReviews",
        [{ label: "no graph entity of the required type", n: outcome.gaps.excludedNoGraphEntity }],
        { people: outcome.rows.map(personToToolRow), gaps: outcome.gaps },
      );
    },
  });

  return { findPrsNotTouching, findDeploymentsWithoutIncident, findPeopleWithoutReviews };
}
