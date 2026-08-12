import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";

import { AgentCoordinator, type SubTask, type SubTaskResult } from "../engine/coordinator.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import { detectEmptyIndex } from "./_lib/gap-notes.ts";
import type { NegotiateBrief, NegotiateInput, NegotiateSubject } from "./_lib/negotiate-types.ts";
import { resolveSelfPerson } from "./_lib/self-person.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

const DEFAULT_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SINCE_MS = 365 * 24 * 60 * 60 * 1000;

export type NegotiateContext = {
  db: Database;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

const PERSONAL_DOCS_CONFIG_KEY = "[negotiate] personal_sources";

const UNAVAILABLE_EVIDENCE: readonly string[] = Object.freeze([
  "incidents resolved",
  "on-call shifts",
  "deploys triggered",
]);

function safeOsUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

function unresolvedIdentityGap(): GapNote {
  return {
    category: "missing_user_identity",
    detail:
      "Could not resolve the subject — no override / git email / OS username matched a known person.",
    remediation:
      "Set `[user] me_person_id` in your active profile's nimbus.toml, or run `nimbus people search <you>` to find your person id.",
  };
}

/**
 * A lane that fails degrades to a gap note, never a silent zero (spec § 4). `laneName` is
 * carried in `detail` (not just `taskIndex`) so a reader — and Task 2's red-prove test — can
 * tell which lane broke; the literal word "lane" is load-bearing for that match.
 */
function laneFailureGap(laneName: string, r: SubTaskResult): GapNote {
  return {
    category: "missing_connector",
    detail: `negotiate lane \`${laneName}\` failed${
      r.errorText === undefined ? "" : `: ${r.errorText}`
    }`,
  };
}

/**
 * Extracted from `runNegotiate` so it can be unit-tested directly against synthetic
 * `SubTaskResult[]` input: Task 1 wires this mechanism with zero real lanes (`tasks` is
 * always `[]`), so the loop body never runs end-to-end via `runNegotiate` itself, and a
 * coverage floor requires exercising it — building fake `SubTaskResult`s is the only way
 * to reach it without inventing a lane, which is Task 2's job, not Task 1's.
 */
export function reduceLaneResults(
  results: readonly SubTaskResult[],
  laneNames: readonly string[],
): GapNote[] {
  const gaps: GapNote[] = [];
  for (const r of results) {
    if (r.status !== "done" || r.text === undefined) {
      gaps.push(laneFailureGap(laneNames[r.taskIndex] ?? `#${String(r.taskIndex)}`, r));
    }
  }
  return gaps;
}

export async function runNegotiate(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<NegotiateBrief> {
  const start = performance.now();
  const sinceMs = Math.min(input.sinceMs ?? DEFAULT_SINCE_MS, MAX_SINCE_MS);
  const gaps: GapNote[] = [];

  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) gaps.push(empty);

  const subject = await resolveSubject(ctx.db, input);
  if (subject.personId === null) gaps.push(unresolvedIdentityGap());

  // Lane mechanism (spec § 4): every lane-backed field on `NegotiateBrief` must be
  // declared `… | null` and initialised to `null` before the coordinator runs, so a
  // lane that failed is distinguishable from a lane that ran and found nothing (`0`).
  // Task 1 adds no lanes — `laneNames`/`tasks` stay empty and this loop is a no-op —
  // but the mechanism is wired now because Task 2 onward depends on this shape: later
  // tasks push a `{ name, task }` pair (name into `laneNames`, task into `tasks`, same
  // index), decode `r.text` with `JSON.parse` for `status === "done"` results, and
  // merge the decoded value into the matching `NegotiateBrief` field — leaving that
  // field at `null` and pushing a `laneFailureGap` for any other status.
  const laneNames: string[] = [];
  const tasks: SubTask[] = [];
  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `negotiate:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });
  const results = await coordinator.run(tasks);
  gaps.push(...reduceLaneResults(results, laneNames));

  return {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { sinceMs },
    subject,
    sources: {
      personalDocsConfigured: false,
      personalDocsConfigKey: PERSONAL_DOCS_CONFIG_KEY,
    },
    unavailableEvidence: UNAVAILABLE_EVIDENCE,
  };
}

async function resolveSubject(db: Database, input: NegotiateInput): Promise<NegotiateSubject> {
  // Always resolve the local self id, even for an explicit `--person`: `isOther` means
  // "named someone other than the resolved local user" (see `NegotiateSubject.isOther`'s
  // docstring), which is a comparison, not a fact derivable from `--person` being present.
  const resolution = await resolveSelfPerson(db, {
    ...(input.mePersonIdOverride === undefined ? {} : { override: input.mePersonIdOverride }),
    ...(input.runGitOverride === undefined ? {} : { runGit: input.runGitOverride }),
    osUsername: input.osUsernameOverride ?? safeOsUsername(),
  });
  if (input.personId !== undefined && input.personId.length > 0) {
    return {
      personId: input.personId,
      source: "explicit",
      displayName: personDisplayNameOrNull(db, input.personId),
      isOther: input.personId !== resolution.personId,
    };
  }
  return {
    personId: resolution.personId,
    source: resolution.source,
    displayName:
      resolution.personId === null ? null : personDisplayNameOrNull(db, resolution.personId),
    isOther: false,
  };
}

function personDisplayNameOrNull(db: Database, personId: string): string | null {
  const row = db.query("SELECT display_name FROM person WHERE id = ?").get(personId) as {
    display_name: string | null;
  } | null;
  return row?.display_name ?? null;
}

export function emitNegotiateBrief(
  input: NegotiateInput,
  ctx: NegotiateContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "negotiate.briefReady",
    briefErrorMethod: "negotiate.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runNegotiate(input, ctx),
  });
}
