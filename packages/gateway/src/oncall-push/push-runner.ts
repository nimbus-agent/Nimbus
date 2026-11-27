import type { Database } from "bun:sqlite";
import { renderCascadeSection } from "../agents/_lib/incident-render.ts";
import type { OncallIncident } from "../agents/_lib/oncall-types.ts";
import type { NimbusOncallPushToml } from "../config/oncall-push-toml.ts";
import type { AssembleOutcome } from "../incident/assemble.ts";
import { groupOf } from "../incident/cascade.ts";
import { readCascade } from "../incident/cascade-read.ts";
import { getByTriggerItem } from "../incident/incident-store.ts";
import { isTriggerService } from "../incident/trigger-sources.ts";
import {
  proveRecordForRetry,
  pushIncidentForItem,
  type RecordPushSkip,
  selectRecordPushCandidates,
} from "./push-record-selector.ts";
import { resolveSeveritySet, selectPushCandidates } from "./push-selector.ts";
import type { BriefOutcome, PushedBriefRow, PushStore } from "./push-store.ts";

const DAY_MS = 86_400_000;
const MAX_DETAIL = 500;

/**
 * The incident engine's `assembleNow`, injected: the push no longer dispatches the `agents.oncall` agent, it
 * pushes the record the engine assembled (Phase 10 IC3), assembling on demand when a candidate has none. The
 * engine is idempotent and single-flight per trigger item, so this joins a pass that is assembling the same item.
 */
export type PushRecords = {
  readonly assembleNow: (triggerItemId: string) => Promise<AssembleOutcome>;
};
export type PushDelivery = { readonly row: PushedBriefRow; readonly incident: OncallIncident };
/** `not_a_source`: the sync that triggered the run is not one of the `[oncall.push] sources`. */
export type PushRunSkip = "disabled" | "not_a_source" | "identity_unresolved" | "not_reconciled";
export type PushRunSummary = {
  readonly selected: number;
  readonly ok: number;
  readonly failed: number;
  readonly skipped?: PushRunSkip;
  /** Records that were NOT pushed this run, by reason (a diagnosable silent non-push). */
  readonly notPushed?: Readonly<Partial<Record<RecordPushSkip, number>>>;
};

/** A retried row; `notDelivered` names why a stored brief of a non-PagerDuty record was not pushed. */
export type PushRetryResult = PushedBriefRow & { readonly notDelivered?: string };

export class PushRetryRefusedError extends Error {
  constructor(
    readonly code: "ERR_ONCALL_PUSH_NOT_FOUND" | "ERR_ONCALL_PUSH_NOT_FAILED",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface OncallPushRunnerDeps {
  readonly db: Database;
  readonly store: PushStore;
  /** Boot-time `[oncall.push]` keys; `enabled` is live and read only through `isEnabled`. */
  readonly config: Omit<NimbusOncallPushToml, "enabled">;
  readonly isEnabled: () => boolean;
  readonly pagerdutyAliases: readonly string[];
  readonly resolveSelf: () => Promise<string | null>;
  readonly deliver: (items: readonly PushDelivery[]) => Promise<void>;
  readonly records: PushRecords;
  /** A configured service's PagerDuty service ids (read fresh), for the on-call proof of a non-PagerDuty record. */
  readonly serviceConfig: (
    serviceId: string,
  ) => { readonly pagerdutyServices: readonly string[] } | undefined;
  /**
   * The declared `depends_on` of every configured service (service id to the service ids it depends on), read
   * fresh on each call. REQUIRED, not optional: an optional dependency would silently drop the cascade (IC4).
   */
  readonly dependsOn: () => ReadonlyMap<string, readonly string[]>;
  /**
   * The record's top remediation proposal (Phase 10 IC5b, approve-from-push), from the incident engine's own
   * listing. The push stores its id and approves nothing; only `incident.remediate` can act on it. Absent, null
   * or throwing: the brief carries no proposal and the push is unaffected.
   */
  readonly topProposal?: (recordId: string) => PushedProposal | null;
  readonly now?: () => number;
}

/** What a pushed brief carries of its record's top proposal: ids and gateway-set labels, never the input. */
export type PushedProposal = {
  readonly recordId: string;
  readonly id: string;
  readonly kind: string;
  readonly toolId: string;
  readonly reversibility: string;
  /** The condition a conditionally reversible row's undo rests on (the Unleash toggle), else absent. */
  readonly reversibleIf?: string;
  readonly confidence: number | null;
  readonly expiresAtMs: number;
};

export interface OncallPushRunner {
  run(serviceId: string): Promise<PushRunSummary>;
  retry(incidentId: string): Promise<PushRetryResult>;
  /** The summary of the last completed run (counts per not-pushed reason included), for diagnosis. */
  lastRun(): PushRunSummary | null;
}

function clip(s: string): string {
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s;
}

function failed(code: string, sessionId: string | null = null): BriefOutcome {
  return { status: "failed", sessionId, failureCode: code };
}

/** The two fields the headline reads from the stored brief JSON, plus the record's id and version. */
function compatibilityJson(
  rowService: string | null,
  recordJson: string,
  id: string,
  version: number,
  cascade: PushedCascade | null,
  proposal: PushedProposal | null,
): string {
  let deployment: { title: string; startedAtMs: number; finishedAtMs: number | null } | null = null;
  try {
    const rec = JSON.parse(recordJson) as {
      change?: {
        deployment?: { title?: unknown; startedAtMs?: unknown; finishedAtMs?: unknown } | null;
      };
    };
    const d = rec.change?.deployment;
    if (
      d !== null &&
      d !== undefined &&
      typeof d.title === "string" &&
      typeof d.startedAtMs === "number"
    ) {
      deployment = {
        title: d.title,
        startedAtMs: d.startedAtMs,
        finishedAtMs: typeof d.finishedAtMs === "number" ? d.finishedAtMs : null,
      };
    }
  } catch {
    // an unreadable record reads as "no deployment"; the Markdown is still the brief
  }
  return JSON.stringify({
    binding: { nimbusServiceId: rowService },
    deployment,
    recordId: id,
    version,
    cascade,
    proposal,
  });
}

/** Where a pushed record stands in its cascade, for the compatibility JSON. */
type PushedCascade = { readonly role: "root" | "downstream"; readonly rootRecordId: string };

/** The cascade block appended to the PUSHED copy of a brief (never to the stored record), and its JSON summary. */
type CascadePart = { readonly markdown: string; readonly summary: PushedCascade | null };

const CASCADE_UNAVAILABLE =
  "## Cascade\n\n_The other open records could not be ranked this time; `nimbus incident show` has the live view._";

/**
 * The record's cascade, computed NOW from the open records and the declared `depends_on`. A record in no cluster
 * of two or more has none. A failed read degrades to a one-line gap: a cascade problem never fails a push.
 */
function cascadePart(deps: OncallPushRunnerDeps, recordId: string): CascadePart {
  try {
    const view = readCascade(deps.db, deps.dependsOn());
    const group = groupOf(view.groups, recordId);
    if (group === null) return { markdown: "", summary: null };
    const me = group.members.find((m) => m.recordId === recordId);
    if (me === undefined) return { markdown: "", summary: null };
    return {
      markdown: renderCascadeSection(group, recordId, view.info, view.truncated),
      summary: { role: me.role, rootRecordId: group.root },
    };
  } catch {
    return { markdown: CASCADE_UNAVAILABLE, summary: null };
  }
}

/** The record's top proposal, or null: a failed listing never fails a push. */
function proposalPart(deps: OncallPushRunnerDeps, recordId: string): PushedProposal | null {
  if (deps.topProposal === undefined) return null;
  try {
    return deps.topProposal(recordId);
  } catch {
    return null;
  }
}

/**
 * The block appended to the PUSHED copy of a brief when the record has an open proposal (IC5b). Every value is
 * gateway-set (the proposal kind, the row's tool id and reversibility label, the confidence, the expiry, the
 * trigger item id the owner already reads in the brief); the proposal's input is never shown here.
 */
/** The reversibility label first: never plain "reversible" for a row whose undo rests on a condition. */
function pushedLabel(p: PushedProposal): string {
  if (p.reversibility === "irreversible") return "IRREVERSIBLE";
  return p.reversibility === "reversible" && p.reversibleIf !== undefined
    ? `reversible only if ${p.reversibleIf}; otherwise IRREVERSIBLE`
    : p.reversibility;
}

export function proposalSection(incidentId: string, p: PushedProposal): string {
  const label = pushedLabel(p);
  const confidence = p.confidence === null ? "" : `, confidence ${String(p.confidence)}`;
  return [
    "## Proposed remediation",
    "",
    `[${label}] ${p.kind}: \`${p.toolId}\`${confidence} (proposal ${p.id}, open until ${new Date(p.expiresAtMs).toISOString()})`,
    "",
    `Run it: \`nimbus oncall pushed ${incidentId} --remediate\`. You approve the exact action at your terminal; this push approves nothing.`,
  ].join("\n");
}

/**
 * The brief of one trigger item: the record the engine assembled (on demand when there is none), its Markdown as
 * the stored brief and a small compatibility JSON the headline parses. Never throws: any failure is a `failed`
 * outcome, stored like any other so dedup holds and `retry` can re-assemble.
 */
async function briefFromRecord(deps: OncallPushRunnerDeps, itemId: string): Promise<BriefOutcome> {
  try {
    const out = await deps.records.assembleNow(itemId);
    if (out.outcome === "missing") return failed("assembly: the item is no longer indexed");
    const row = getByTriggerItem(deps.db, itemId);
    if (row === null) return failed("assembly: no record was stored");
    // OR-IC4-1: the block is the cascade AS OF THIS PUSH. A record pushed before its siblings exist says
    // nothing about them and is never pushed again when a later record becomes its root (one page per outage;
    // `nimbus incident show` is the live view). The stored `incident_record.markdown` is not touched.
    const cascade = cascadePart(deps, row.id);
    const proposal = proposalPart(deps, row.id);
    const parts = [row.markdown, cascade.markdown];
    if (proposal !== null) parts.push(proposalSection(itemId, proposal));
    return {
      status: "ok",
      sessionId: `incident:${row.id}:v${String(row.version)}`,
      briefMarkdown: parts.filter((x) => x !== "").join("\n\n"),
      briefJson: compatibilityJson(
        row.service,
        row.record_json,
        row.id,
        row.version,
        cascade.summary,
        proposal,
      ),
    };
  } catch (e) {
    return failed(`assembly: ${clip(e instanceof Error ? e.message : String(e))}`);
  }
}

export function createOncallPushRunner(deps: OncallPushRunnerDeps): OncallPushRunner {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<PushRunSummary> | undefined;
  let rerunRequested = false;
  const retrying = new Map<string, Promise<PushRetryResult>>();
  let lastSummary: PushRunSummary | null = null;

  async function once(): Promise<PushRunSummary> {
    if (!deps.isEnabled()) return { selected: 0, ok: 0, failed: 0, skipped: "disabled" };
    const enabledAt = deps.store.enabledAt();
    if (enabledAt === null) return { selected: 0, ok: 0, failed: 0, skipped: "not_reconciled" };
    const personId = await deps.resolveSelf();
    if (personId === null) return { selected: 0, ok: 0, failed: 0, skipped: "identity_unresolved" };
    deps.store.pruneOlderThan(now() - deps.config.retentionDays * DAY_MS);
    const severities = resolveSeveritySet(deps.config, deps.pagerdutyAliases);
    const sources = deps.config.sources;
    // PagerDuty keeps ONLY its assignment-based path; every other opted-in source is a stored record that
    // must pass the three-part proof inside `selectRecordPushCandidates` (never a broadcast).
    const pagerduty = sources.includes("pagerduty")
      ? selectPushCandidates(deps.db, {
          personId,
          severities,
          enabledAtMs: enabledAt,
          alreadyPushed: (id) => deps.store.has(id),
        })
      : [];
    const records = selectRecordPushCandidates(deps.db, {
      sources,
      severities,
      enabledAtMs: enabledAt,
      nowMs: now(),
      alreadyPushed: (id) => deps.store.has(id),
      serviceConfig: deps.serviceConfig,
    });
    const candidates = [...pagerduty, ...records.candidates];
    const items: PushDelivery[] = [];
    let ok = 0;
    try {
      for (const incident of candidates) {
        // Defensive: a duplicate candidate within one selection would make `insert` throw on the PK.
        if (deps.store.has(incident.id)) continue;
        // A live disable mid-run (a pack removed) stops the loop; the finally delivers what is stored.
        if (!deps.isEnabled()) break;
        const outcome = await briefFromRecord(deps, incident.id); // NOSONAR S9382: one assembly at a time - the has() re-check above must see every row stored before it, and a failed insert must stop the later briefs (the finally delivers the rows already stored)
        const row = deps.store.insert(incident.id, outcome, now());
        if (row.status === "ok") ok += 1;
        items.push({ row, incident });
      }
    } finally {
      // A row already inserted is never reselected (alreadyPushed) and an ok row refuses retry, so
      // an insert that throws mid-loop must not strand the rows before it undelivered.
      if (items.length > 0) await deps.deliver(items);
    }
    return {
      selected: candidates.length,
      ok,
      failed: items.length - ok,
      notPushed: records.notPushed,
    };
  }

  async function loop(): Promise<PushRunSummary> {
    try {
      let last = await once();
      while (rerunRequested) {
        rerunRequested = false;
        last = await once(); // NOSONAR S9382: single-flight rerun - the loop condition is set by run() calls landing while the previous once() ran, and runs never overlap (each dedups against the rows the last one stored)
      }
      lastSummary = last;
      return last;
    } finally {
      // Same synchronous step as the final `rerunRequested` check (and the throw path): a run()
      // landing after this sees no in-flight run and starts its own, so no request is lost.
      inFlight = undefined;
      rerunRequested = false;
    }
  }

  async function doRetry(incidentId: string): Promise<PushRetryResult> {
    const existing = deps.store.get(incidentId);
    if (existing === null)
      throw new PushRetryRefusedError(
        "ERR_ONCALL_PUSH_NOT_FOUND",
        `no pushed brief for ${incidentId}`,
      );
    if (existing.status !== "failed") {
      throw new PushRetryRefusedError(
        "ERR_ONCALL_PUSH_NOT_FAILED",
        `${incidentId} already has a brief; use nimbus oncall --incident ${incidentId}`,
      );
    }
    const outcome = await briefFromRecord(deps, incidentId);
    let row: PushedBriefRow;
    try {
      row = deps.store.applyRetry(incidentId, outcome, now());
    } catch (e) {
      // A retention prune can delete the row while the brief is being assembled; that is a
      // not-found refusal, not an internal error.
      if (deps.store.get(incidentId) === null) {
        throw new PushRetryRefusedError(
          "ERR_ONCALL_PUSH_NOT_FOUND",
          `pushed brief for ${incidentId} was removed (retention) during the retry`,
        );
      }
      throw e;
    }
    if (row.status !== "ok") return row;
    if (incidentId.startsWith("pagerduty:")) {
      // PagerDuty keeps its retry exactly as it was: deliver when the incident is still indexed.
      const incident = pushIncidentForItem(deps.db, incidentId);
      if (incident !== null) await deps.deliver([{ row, incident }]);
      return row;
    }
    // Any other source: the SAME proof as the first push, at retry time (one predicate, push-record-selector).
    const severities = resolveSeveritySet(deps.config, deps.pagerdutyAliases);
    const proof = proveRecordForRetry(deps.db, incidentId, {
      sources: deps.config.sources,
      severities,
      nowMs: now(),
      serviceConfig: deps.serviceConfig,
    });
    if (!proof.delivered) return { ...row, notDelivered: proof.reason };
    await deps.deliver([{ row, incident: proof.incident }]);
    return row;
  }

  return {
    async run(serviceId) {
      // A cheap early exit, NOT the guard: whether a record may be pushed is decided inside the selectors.
      if (!isTriggerService(serviceId) || !deps.config.sources.includes(serviceId)) {
        return { selected: 0, ok: 0, failed: 0, skipped: "not_a_source" };
      }
      if (inFlight !== undefined) {
        rerunRequested = true;
        return inFlight;
      }
      inFlight = loop();
      return inFlight;
    },

    lastRun: () => lastSummary,

    retry(incidentId) {
      // Single-flight per incident: the `failed` check and the write are separated by a brief that
      // can take PUSH_BRIEF_TIMEOUT_MS, so two concurrent retries would both pass the check, open
      // two assemblies, and race their writes. A second caller joins the attempt
      // already running instead.
      const pending = retrying.get(incidentId);
      if (pending !== undefined) return pending;
      const p = doRetry(incidentId).finally(() => retrying.delete(incidentId));
      retrying.set(incidentId, p);
      return p;
    },
  };
}
