import type { JsonRpcNotification } from "../ipc/types";

export const RUNS_PER_AGENT = 5;
export const EARLY_BUFFER_MAX = 20;
export const EARLY_BUFFER_TTL_MS = 60_000;
export const BRIEF_WAIT_DEADLINE_MS = 600_000;

export type BriefOutcome = { kind: "ready"; markdown: string } | { kind: "error"; message: string };

export type BriefRun = { sessionId: string; agent: string; requestedAt: number } & (
  | { status: "pending" }
  | { status: "ready"; markdown: string; finishedAt: number }
  | { status: "error"; message: string; finishedAt: number }
);

export type EarlyOutcome = { sessionId: string; outcome: BriefOutcome; at: number };

export type BriefRunsState = {
  runs: ReadonlyMap<string, BriefRun>;
  /** Newest-requested first. */
  byAgent: Readonly<Record<string, readonly string[]>>;
  /** Outcomes that arrived before their run was registered (the notification can beat the call). */
  early: readonly EarlyOutcome[];
};

export function emptyBriefRuns(): BriefRunsState {
  return { runs: new Map(), byAgent: {}, early: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseBriefNotification(
  n: JsonRpcNotification,
): { sessionId: string; outcome: BriefOutcome } | null {
  if (typeof n.method !== "string" || !isRecord(n.params)) return null;
  const sessionId = n.params["sessionId"];
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (n.method.endsWith(".briefReady")) {
    const brief = n.params["brief"];
    return typeof brief === "string"
      ? { sessionId, outcome: { kind: "ready", markdown: brief } }
      : null;
  }
  if (n.method.endsWith(".briefError")) {
    const error = n.params["error"];
    return typeof error === "string"
      ? { sessionId, outcome: { kind: "error", message: error } }
      : null;
  }
  return null;
}

function pruneEarly(early: readonly EarlyOutcome[], now: number): EarlyOutcome[] {
  const live = early.filter((e) => now - e.at <= EARLY_BUFFER_TTL_MS);
  return live.length > EARLY_BUFFER_MAX ? live.slice(live.length - EARLY_BUFFER_MAX) : live;
}

function finish(run: BriefRun, outcome: BriefOutcome, now: number): BriefRun {
  const base = { sessionId: run.sessionId, agent: run.agent, requestedAt: run.requestedAt };
  return outcome.kind === "ready"
    ? { ...base, status: "ready", markdown: outcome.markdown, finishedAt: now }
    : { ...base, status: "error", message: outcome.message, finishedAt: now };
}

export function registerRun(
  s: BriefRunsState,
  agent: string,
  sessionId: string,
  now: number,
): BriefRunsState {
  const early = pruneEarly(s.early, now);
  const hit = early.find((e) => e.sessionId === sessionId);
  const pending: BriefRun = { sessionId, agent, requestedAt: now, status: "pending" };
  const run = hit === undefined ? pending : finish(pending, hit.outcome, now);

  const runs = new Map(s.runs);
  runs.set(sessionId, run);
  const ids = [sessionId, ...(s.byAgent[agent] ?? []).filter((id) => id !== sessionId)];
  for (const dropped of ids.slice(RUNS_PER_AGENT)) runs.delete(dropped);
  return {
    runs,
    byAgent: { ...s.byAgent, [agent]: ids.slice(0, RUNS_PER_AGENT) },
    early: early.filter((e) => e.sessionId !== sessionId),
  };
}

export function applyOutcome(
  s: BriefRunsState,
  sessionId: string,
  outcome: BriefOutcome,
  now: number,
): BriefRunsState {
  const early = pruneEarly(s.early, now);
  const run = s.runs.get(sessionId);
  if (run === undefined) {
    // Unknown session: hold it briefly in case its run registers next; never create a run.
    if (early.some((e) => e.sessionId === sessionId)) return { ...s, early };
    return { ...s, early: pruneEarly([...early, { sessionId, outcome, at: now }], now) };
  }
  if (run.status !== "pending") return { ...s, early };
  const runs = new Map(s.runs);
  runs.set(sessionId, finish(run, outcome, now));
  return { ...s, runs, early };
}

export function latestRun(s: BriefRunsState, agent: string): BriefRun | undefined {
  const id = s.byAgent[agent]?.[0];
  return id === undefined ? undefined : s.runs.get(id);
}

export function isPastDeadline(run: BriefRun, now: number): boolean {
  return run.status === "pending" && now >= run.requestedAt + BRIEF_WAIT_DEADLINE_MS;
}
