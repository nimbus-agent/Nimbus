import type { Database } from "bun:sqlite";
import type { OncallIncident } from "../agents/_lib/oncall-types.ts";
import type { NimbusOncallPushToml } from "../config/oncall-push-toml.ts";
import type { AssembleOutcome } from "../incident/assemble.ts";
import { getByTriggerItem } from "../incident/incident-store.ts";
import { isTriggerService } from "../incident/trigger-sources.ts";
import {
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
  readonly now?: () => number;
}

export interface OncallPushRunner {
  run(serviceId: string): Promise<PushRunSummary>;
  retry(incidentId: string): Promise<PushedBriefRow>;
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
  });
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
    return {
      status: "ok",
      sessionId: `incident:${row.id}:v${String(row.version)}`,
      briefMarkdown: row.markdown,
      briefJson: compatibilityJson(row.service, row.record_json, row.id, row.version),
    };
  } catch (e) {
    return failed(`assembly: ${clip(e instanceof Error ? e.message : String(e))}`);
  }
}

export function createOncallPushRunner(deps: OncallPushRunnerDeps): OncallPushRunner {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<PushRunSummary> | undefined;
  let rerunRequested = false;
  const retrying = new Map<string, Promise<PushedBriefRow>>();
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

  async function doRetry(incidentId: string): Promise<PushedBriefRow> {
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
    const incident = pushIncidentForItem(deps.db, incidentId);
    if (row.status === "ok" && incident !== null) await deps.deliver([{ row, incident }]);
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
