import type { Database } from "bun:sqlite";

import { beforeReplyJson } from "../connectors/connector-writes/before-select.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { investigateReadActionType } from "../engine/investigate-read.ts";
import type { PlannedAction } from "../engine/types.ts";
import { mintIncidentLink } from "../incident/incident-link-mint.ts";
import type { IncidentRecordV1 } from "../incident/incident-record-types.ts";
import { getById } from "../incident/incident-store.ts";
import {
  INVESTIGATE_LEAD_CAP,
  type Investigation,
  type Lead,
  LIVE_BACKENDS,
} from "../incident/investigate.ts";
import type {
  LiveBlock,
  LiveIssueRow,
  LiveProjectOutcome,
} from "../incident/investigate-live-types.ts";
import { oneLine } from "../incident/lanes/caps.ts";
import type { MakeExecutor } from "../incident/remediation.ts";

/**
 * `nimbus incident investigate --live` (owner ruling 9, Phase 10 IC9a's open remainder; invariant I57 (a)
 * extension, static D46(h)). The ONE module that makes a live read for an investigation, and the only builder of
 * a `<service>.investigate.read` action (`engine/investigate-read.ts`). It lives OUTSIDE `incident/` on purpose:
 * incident assembly stays read-only over the index (I57 (a), static D46(a)); this module only ever runs when the
 * owner asked for it on a `cli` connection (`ipc/investigation-rpc.ts`), never from a sync, a schedule, the model,
 * an outside agent, ChatOps, the desktop or the LAN.
 *
 * Backend: SENTRY. It is the one backend that already has BOTH a read tool (`sentry_issue_list`) and a binding the
 * owner declared (`[ci.service.<id>] sentry_projects`), and the index already keeps its issues, so a live read
 * shows what the sync has not yet picked up and the current status and counts. Datadog, Grafana, New Relic and
 * CloudWatch have neither a binding nor a read tool, so they stay Gaps that say so.
 *
 * Each read is one `execute()` on the remediation executor's factory (consent only from a person on the asking
 * connection if org policy asks for one, no delegation, the audit row and the I29 egress row carrying the
 * incident link). The result is UNTRUSTED provider text: it is shape-checked, filtered to the bound projects and
 * the incident's span (the correlation), capped, single-lined, returned to the asking connection ONCE and never
 * stored in the record. A failed or timed-out read is a named Gap with a FIXED reason, never error text.
 */

export const LIVE_DEFAULT_BUDGET_MS = 15_000;
export const LIVE_MAX_PROJECTS = 5;
export const LIVE_PER_PROJECT_LIMIT = 50;
export const LIVE_ROW_CAP = 25;
const SCAN_CAP = 100;
const TITLE_MAX = 200;
const FACT_MAX = 40;
const URL_MAX = 500;
const SENTRY_TOOL = "sentry_issue_list";

export class LiveInvestigateError extends Error {
  constructor(
    readonly code: "ERR_INVESTIGATE_LIVE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "LiveInvestigateError";
  }
}

export type LiveInvestigationDeps = {
  readonly db: Database;
  /** The remediation executor factory (`gateway-main.ts` binds it; it throws until then and on a demo gateway, I41). */
  readonly makeExecutor: MakeExecutor;
  readonly now?: () => number;
};

export type LiveInvestigator = {
  /** The investigation with a `live` block, the live leads and gaps merged in. Never mutates its input. */
  run(input: {
    readonly investigation: Investigation;
    readonly clientId: string;
    readonly budgetMs?: number;
  }): Promise<Investigation>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : null;
};
const isoMs = (v: unknown): number | null => {
  const s = str(v);
  if (s === null) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};

function safeUrl(v: unknown): string | null {
  const s = str(v);
  if (s === null || s.length > URL_MAX) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? s : null;
  } catch {
    return null;
  }
}

type Span = { readonly fromMs: number; readonly toMs: number };

/** One reply element to a row, or `null` when it is not a usable issue of this project inside the span. */
function toRow(
  raw: unknown,
  project: string,
  span: Span,
  deployStartMs: number | null,
): LiveIssueRow | null {
  if (!isRecord(raw)) return null;
  const issueId = str(raw["id"]);
  const lastSeenMs = isoMs(raw["lastSeen"]);
  if (issueId === null || issueId.length > 64 || lastSeenMs === null) return null;
  // Correlation 1: the issue belongs to the project that was asked for. A reply that names another project is
  // dropped, never trusted to be "close enough".
  const slug = isRecord(raw["project"]) ? str(raw["project"]["slug"]) : null;
  if (slug !== null && slug !== project) return null;
  // Correlation 2: the issue was active inside the incident's span.
  if (lastSeenMs < span.fromMs || lastSeenMs > span.toMs) return null;
  const firstSeenMs = isoMs(raw["firstSeen"]);
  const level = str(raw["level"]);
  const status = str(raw["status"]);
  return {
    issueId,
    title: oneLine(str(raw["title"]) ?? str(raw["shortId"]) ?? issueId, TITLE_MAX),
    url: safeUrl(raw["permalink"]),
    project,
    level: level === null ? null : oneLine(level, FACT_MAX),
    status: status === null ? null : oneLine(status, FACT_MAX),
    count: num(raw["count"]),
    userCount: num(raw["userCount"]),
    firstSeenMs,
    lastSeenMs,
    newSinceDeploy: deployStartMs !== null && firstSeenMs !== null && firstSeenMs >= deployStartMs,
  };
}

type Read =
  | { readonly outcome: "read"; readonly scanned: number; readonly rows: readonly LiveIssueRow[] }
  | { readonly outcome: Exclude<LiveProjectOutcome, "read" | "skipped_budget" | "skipped_cap"> };

type Timed<T> = { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<Timed<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    const got = await Promise.race([
      p.then((value) => ({ timedOut: false as const, value })),
      clock,
    ]);
    return got;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isIssueShaped(raw: unknown): boolean {
  return isRecord(raw) && str(raw["id"]) !== null && isoMs(raw["lastSeen"]) !== null;
}

function parseReply(
  reply: unknown,
  project: string,
  span: Span,
  deployStartMs: number | null,
): Read {
  let json: unknown;
  try {
    json = beforeReplyJson(reply);
  } catch {
    return { outcome: "unreadable" };
  }
  if (!Array.isArray(json)) return { outcome: "unreadable" };
  const scan = json.slice(0, SCAN_CAP);
  // A non-empty reply with no issue-shaped element is not "nothing found": it is a reply we cannot read.
  if (scan.length > 0 && !scan.some(isIssueShaped)) return { outcome: "unreadable" };
  const rows: LiveIssueRow[] = [];
  for (const el of scan) {
    const row = toRow(el, project, span, deployStartMs);
    if (row !== null) rows.push(row);
  }
  return { outcome: "read", scanned: Math.min(json.length, SCAN_CAP), rows };
}

function deploymentStart(db: Database, recordId: string): number | null {
  const row = getById(db, recordId);
  if (row === null) return null;
  try {
    const rec = JSON.parse(row.record_json) as IncidentRecordV1;
    return rec.change.deployment?.startedAtMs ?? null;
  } catch {
    return null;
  }
}

const OUTCOME_TEXT: Readonly<Record<Exclude<LiveProjectOutcome, "read">, string>> = {
  timeout: "it did not finish inside the time budget",
  refused: "the read was refused (a policy or the gate)",
  failed: "the read failed",
  unreadable: "the reply was not a list of issues",
  skipped_budget: "the time budget was already spent",
  skipped_cap: `only the first ${String(LIVE_MAX_PROJECTS)} projects are read`,
};

function liveLeads(rows: readonly LiveIssueRow[]): Lead[] {
  return rows
    .filter((r) => r.newSinceDeploy)
    .map((r) => ({
      kind: "sentry_issue" as const,
      refId: r.issueId,
      text: "Candidate (live Sentry read): an unresolved issue first seen after the deployment started; timing only, not a proven cause.",
    }));
}

function liveGaps(block: LiveBlock, reason: string | null): { code: string; detail: string }[] {
  const gaps: { code: string; detail: string }[] = [];
  if (reason !== null) gaps.push({ code: "live_sentry_not_read", detail: reason });
  for (const p of block.projects) {
    if (p.outcome === "read") continue;
    gaps.push({
      code: `live_sentry_${p.outcome}`,
      detail: `The live Sentry read of project ${p.project} did not complete: ${OUTCOME_TEXT[p.outcome]}.`,
    });
  }
  const read = block.projects.filter((p) => p.outcome === "read");
  if (read.length > 0) {
    gaps.push({
      code: "live_sentry_unresolved_only",
      detail:
        "The live Sentry read lists unresolved issues only, active inside the incident's window; a resolved issue is not shown.",
    });
  }
  for (const p of read) {
    if (p.scanned >= LIVE_PER_PROJECT_LIMIT) {
      gaps.push({
        code: "live_sentry_page_full",
        detail: `Sentry returned its page limit of ${String(LIVE_PER_PROJECT_LIMIT)} unresolved issues for project ${p.project}; older ones may exist.`,
      });
    }
  }
  if (block.total > block.rows.length) {
    gaps.push({
      code: "live_sentry_rows_capped",
      detail: `Live Sentry issues are capped at ${String(LIVE_ROW_CAP)} rows; ${String(block.total)} matched.`,
    });
  }
  return gaps;
}

/** The other backends keep their Gap, reworded: a live read exists for Sentry only. */
function otherBackendGaps(inv: Investigation): Investigation["gaps"] {
  return inv.gaps.map((g) => {
    const b = LIVE_BACKENDS.find((x) => g.code === `live_${x.connector}`);
    if (b === undefined) return g;
    const connected = inv.freshness.find((f) => f.service === b.connector)?.connected === true;
    return {
      code: g.code,
      detail: `${b.label} are not read: no live read is built for this backend yet, and it declares no binding (${connected ? "the connector is connected" : "the connector is not connected"}).`,
    };
  });
}

function empty(budgetMs: number): LiveBlock {
  return { backend: "sentry", budgetMs, status: "not_read", projects: [], rows: [], total: 0 };
}

function merge(inv: Investigation, block: LiveBlock, reason: string | null): Investigation {
  const extra = liveGaps(block, reason);
  return {
    ...inv,
    live: block,
    leads: [...inv.leads, ...liveLeads(block.rows)].slice(0, INVESTIGATE_LEAD_CAP),
    gaps: [...otherBackendGaps(inv), ...extra],
  };
}

/** The live read's window: the record's span, up to the close time of a closed trigger, else up to now. */
function liveSpan(inv: Investigation, started: number): Span {
  const closedAt = inv.trigger.status === "closed" ? inv.trigger.closedAtMs : null;
  return {
    fromMs: inv.span.fromMs,
    toMs: closedAt ?? Math.max(inv.span.toMs, started),
  };
}

/** Adds the rows not seen yet (an issue two projects return is kept once); returns how many were new. */
function addUnseen(seen: Map<string, LiveIssueRow>, rows: readonly LiveIssueRow[]): number {
  let fresh = 0;
  for (const row of rows) {
    if (seen.has(row.issueId)) continue;
    seen.set(row.issueId, row);
    fresh += 1;
  }
  return fresh;
}

function liveStatus(reads: number, projects: number): LiveBlock["status"] {
  if (reads === 0) return "not_read";
  return reads === projects ? "ok" : "partial";
}

export function createLiveInvestigator(deps: LiveInvestigationDeps): LiveInvestigator {
  const now = deps.now ?? Date.now;
  return {
    async run({ investigation: inv, clientId, budgetMs = LIVE_DEFAULT_BUDGET_MS }) {
      const connected = inv.freshness.find((f) => f.service === "sentry")?.connected === true;
      if (inv.sentry.status !== "ok" || inv.sentry.projects.length === 0) {
        return merge(
          inv,
          empty(budgetMs),
          "No live Sentry read was made: the record's service declares no Sentry project (see the Sentry gap).",
        );
      }
      if (!connected) {
        return merge(
          inv,
          empty(budgetMs),
          "No live Sentry read was made: the Sentry connector is not connected.",
        );
      }
      const started = now();
      const deadline = started + budgetMs;
      const span = liveSpan(inv, started);
      const deployStartMs = deploymentStart(deps.db, inv.recordId);
      const link = mintIncidentLink(deps.db, inv.recordId);
      const executor = buildExecutor(deps.makeExecutor, clientId);
      const projects: LiveBlock["projects"][number][] = [];
      const seen = new Map<string, LiveIssueRow>();
      let matched = 0;
      for (const project of inv.sentry.projects.slice(LIVE_MAX_PROJECTS)) {
        projects.push({ project, outcome: "skipped_cap", scanned: 0, matched: 0 });
      }
      for (const project of inv.sentry.projects.slice(0, LIVE_MAX_PROJECTS)) {
        const remaining = deadline - now();
        if (remaining <= 0) {
          projects.push({ project, outcome: "skipped_budget", scanned: 0, matched: 0 });
          continue;
        }
        const action: PlannedAction = {
          type: investigateReadActionType("sentry"),
          payload: {
            mcpToolId: mcpClientToolKey("sentry", SENTRY_TOOL),
            input: { projectSlug: project, limit: LIVE_PER_PROJECT_LIMIT },
          },
          incident: link,
        };
        const read = await readOne(executor, action, remaining, (reply) =>
          parseReply(reply, project, span, deployStartMs),
        );
        if (read.outcome !== "read") {
          projects.push({ project, outcome: read.outcome, scanned: 0, matched: 0 });
          continue;
        }
        const fresh = addUnseen(seen, read.rows);
        matched += fresh;
        projects.push({ project, outcome: "read", scanned: read.scanned, matched: fresh });
      }
      const rows = [...seen.values()]
        .sort((a, b) => b.lastSeenMs - a.lastSeenMs || (a.issueId < b.issueId ? -1 : 1))
        .slice(0, LIVE_ROW_CAP);
      const reads = projects.filter((p) => p.outcome === "read").length;
      const block: LiveBlock = {
        backend: "sentry",
        budgetMs,
        status: liveStatus(reads, projects.length),
        projects,
        rows,
        total: matched,
      };
      return merge(inv, block, null);
    },
  };
}

function buildExecutor(make: MakeExecutor, clientId: string): ReturnType<MakeExecutor> {
  try {
    return make({ clientId, onCaptured: () => {}, onNonHuman: () => {} });
  } catch {
    throw new LiveInvestigateError(
      "ERR_INVESTIGATE_LIVE_UNAVAILABLE",
      "this gateway cannot make a live read (a demo gateway, or one still starting)",
    );
  }
}

async function readOne(
  executor: ReturnType<MakeExecutor>,
  action: PlannedAction,
  remainingMs: number,
  parse: (reply: unknown) => Read,
): Promise<Read | { readonly outcome: "timeout" }> {
  try {
    const got = await withDeadline(executor.execute(action), remainingMs);
    if (got.timedOut) return { outcome: "timeout" };
    if (got.value.status !== "ok") return { outcome: "refused" };
    return parse(got.value.result);
  } catch {
    return { outcome: "failed" };
  }
}
