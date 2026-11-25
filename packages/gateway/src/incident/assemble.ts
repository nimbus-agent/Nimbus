import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { serviceFreshness } from "../agents/_lib/briefing-queries.ts";
import type { IncidentBrief, IncidentDataBrief } from "../agents/_lib/incident-types.ts";
import { synthesize } from "../agents/_lib/synthesize.ts";
import { CREATED_KEY } from "../index/item-history.ts";
import { loadServiceHistoryStarts } from "../index/item-history-at.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { canonicalJson } from "../util/canonical-json.ts";
import { erasureGeneration } from "./erasure-generation.ts";
import {
  type BindingBlock,
  coreOf,
  type Freshness,
  type GapNote,
  INCIDENT_ENGINE_VERSION,
  INCIDENT_SCHEMA_VERSION,
  type IncidentRecordV1,
  type RecordCounts,
  type TriggerBlock,
} from "./incident-record-types.ts";
import { type UpsertOutcome, upsertIncidentRecord } from "./incident-store.ts";
import { bindTrigger } from "./lanes/binding.ts";
import { capRecordSize, gap, oneLine } from "./lanes/caps.ts";
import { changeLane, skippedChange } from "./lanes/change.ts";
import { CHAT_SERVICES, chatLane, skippedChat } from "./lanes/chat.ts";
import { concurrentLane, skippedConcurrent } from "./lanes/concurrent.ts";
import { dataLane, pagerdutyDataLane } from "./lanes/data.ts";
import { historyLane } from "./lanes/history.ts";
import { oncallLane } from "./lanes/oncall.ts";
import { priorLane, skippedPrior } from "./lanes/prior.ts";
import { isClosedStatusWord, type TriggerFacts, triggerFacts } from "./trigger-facts.ts";
import { isTriggerPair, type TriggerService } from "./trigger-sources.ts";

/**
 * The assembler (Phase 10 IC3, design C): one trigger item in, one stored record out. Reads ONLY the local index
 * (lanes are SQL over `item`, `item_history`, the graph and `incident_record`), calls no connector, no network and
 * no model (`synthesize(brief)` has exactly one argument, so the render is deterministic), and writes only through
 * `incident-store.ts`. I57 (a), static D46(a).
 */

export class IncidentError extends Error {
  readonly code:
    | "ERR_INCIDENT_NOT_A_TRIGGER"
    | "ERR_INCIDENT_NOT_FOUND"
    | "ERR_INCIDENT_VERSION_NOT_FOUND";
  constructor(code: IncidentError["code"], message: string) {
    super(message);
    this.name = "IncidentError";
    this.code = code;
  }
}

export type AssembleDeps = {
  readonly db: Database;
  /** The `[ci.service.*]` / `[metrics.dora.*]` configs, read fresh per assembly. */
  readonly loadServiceConfigs: () => ReadonlyMap<string, ServiceConfig>;
  /** `[incident] data_schema_lookback_hours`; absent reads 24. */
  readonly dataSchemaLookbackHours?: number | undefined;
};

export type AssembleOutcome =
  | {
      readonly outcome: UpsertOutcome;
      readonly recordId: string;
      readonly version: number;
      readonly status: string;
    }
  | { readonly outcome: "missing" };

type ItemRow = {
  id: string;
  service: string;
  type: string;
  external_id: string;
  title: string;
  url: string | null;
  metadata: string | null;
};

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function assigneeCountOf(
  service: TriggerService,
  meta: Record<string, unknown> | null,
): number | null {
  if (meta === null) return null;
  if (service === "pagerduty") {
    // lane-census: scope=incident service=pagerduty
    const v = meta["assignee_emails"];
    return Array.isArray(v) ? v.length : null;
  }
  if (service === "sentry") {
    // lane-census: scope=error_issue service=sentry
    return meta["assignedTo"] === null || meta["assignedTo"] === undefined ? 0 : 1;
  }
  return null;
}

type HistoryRow = { observed_at_ms: number; new_value: string | null };

/** First observation of the item, and (for a source with no provider close time) the observed close time. */
function observedTimes(
  db: Database,
  itemId: string,
  service: TriggerService,
  needClosed: boolean,
): { firstObservedMs: number | null; closedObservedMs: number | null } {
  const created = db
    .query(
      "SELECT observed_at_ms FROM item_history WHERE item_id = ? AND key = ? ORDER BY observed_at_ms ASC, id ASC LIMIT 1",
    )
    .get(itemId, CREATED_KEY) as { observed_at_ms: number } | null;
  let closedObservedMs: number | null = null;
  if (needClosed) {
    const rows = db
      .query(
        "SELECT observed_at_ms, new_value FROM item_history WHERE item_id = ? AND key = 'status' ORDER BY observed_at_ms DESC, id DESC",
      )
      .all(itemId) as HistoryRow[];
    // The latest status change INTO a closed word (a reopened item has a later non-closed row first).
    const latest = rows[0];
    if (latest !== undefined && isClosedStatusWord(service, latest.new_value)) {
      closedObservedMs = latest.observed_at_ms;
    }
  }
  return { firstObservedMs: created === null ? null : created.observed_at_ms, closedObservedMs };
}

function triggerBlock(
  row: ItemRow,
  service: TriggerService,
  facts: TriggerFacts,
  meta: Record<string, unknown> | null,
  observed: { firstObservedMs: number | null; closedObservedMs: number | null },
): TriggerBlock {
  const closedObserved = facts.closedAtBasis === "observed" && observed.closedObservedMs !== null;
  return {
    itemId: row.id,
    service,
    type: row.type,
    providerId: oneLine(row.external_id),
    title: oneLine(row.title),
    url: row.url,
    status: facts.status,
    statusRaw: facts.statusRaw === null ? null : oneLine(facts.statusRaw, 60),
    severity: facts.severity === null ? null : oneLine(facts.severity, 60),
    severityRaw: facts.severityRaw === null ? null : oneLine(facts.severityRaw, 60),
    opened: { ms: facts.openedAtMs, basis: facts.openedAtBasis },
    closed: closedObserved
      ? { ms: observed.closedObservedMs, basis: "observed" }
      : { ms: facts.closedAtMs, basis: facts.closedAtBasis },
    firstObservedMs: observed.firstObservedMs,
    assigneeCount: assigneeCountOf(service, meta),
    slaStatus: facts.slaStatus === null ? null : oneLine(facts.slaStatus, 60),
  };
}

/** The notes every record carries: properties of the index, not of today's incident. */
function substrateGaps(): GapNote[] {
  return [
    gap(
      "missing_entity_type",
      "How an incident was resolved is absent: no connector indexes a resolution note, remediation step or post-mortem link, so a record says what was seen and when, never what was done.",
      "No action available today.",
    ),
    gap(
      "missing_entity_type",
      "The contents of a change are absent: only the diffstat (added and removed lines, changed files) is indexed, never a patch or a commit message body.",
      "Open the linked pull request to read the diff.",
    ),
  ];
}

function citedServicesOf(record: IncidentRecordV1): string[] {
  const out = new Set<string>([record.trigger.service]);
  const c = record.change;
  if (c.deployment !== null) out.add(c.deployment.provider);
  if (c.pr !== null) out.add(c.pr.service);
  if (c.ci !== null) out.add(c.ci.service);
  for (const m of record.chat.messages) out.add(m.service);
  for (const p of record.prior.incidents) out.add(p.service);
  // The on-call lane holds PagerDuty (or JSM) shift names and has no source field, so a record that lists
  // people cites PagerDuty: removing PagerDuty erases it, conservatively.
  if (record.onCall.current.length > 0 || record.onCall.next.length > 0) out.add("pagerduty");
  if (record.data !== null) {
    for (const o of record.data.orchestration) out.add(o.service);
    for (const p of record.data.prs) out.add(p.service);
    if ((record.data.dbtTests ?? []).length > 0) out.add("dbt");
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function freshnessOf(
  db: Database,
  record: IncidentRecordV1,
  nowMs: number,
  onCallStale: boolean | null,
): Freshness {
  const ids = new Set<string>([record.trigger.service]);
  if (record.binding.bound) ids.add("github");
  // The providers of the change evidence actually shown (a GitLab pull request, a Jenkins run) report their own sync time.
  const change = record.change;
  if (change.deployment !== null) ids.add(change.deployment.provider);
  if (change.pr !== null) ids.add(change.pr.service);
  if (change.ci !== null) ids.add(change.ci.service);
  const chat = serviceFreshness(db, CHAT_SERVICES);
  const connectedChat = chat.filter((c) => c.connected);
  if (record.chat.skipped === null) {
    for (const c of connectedChat) ids.add(c.id);
    if (connectedChat.length === 0) ids.add("slack");
  }
  if (record.trigger.service === "pagerduty") ids.add("pagerduty");
  const rows = serviceFreshness(
    db,
    [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  ).map((f) => ({ service: f.id, connected: f.connected, lastSyncMs: f.lastSyncMs }));
  return {
    rows,
    chatToMs: record.chat.skipped === null ? nowMs : null,
    onCallStale,
  };
}

/** SHA-256 over the canonical JSON of the factual core only (`CORE_KEYS`). */
export function recordHash(record: IncidentRecordV1): string {
  return createHash("sha256")
    .update(canonicalJson(coreOf(record)), "utf8")
    .digest("hex");
}

function countsOf(record: IncidentRecordV1): RecordCounts {
  const d = record.data;
  return {
    chat: record.chat.total,
    prior: record.prior.total,
    concurrent: record.concurrent.total,
    history: record.history.total,
    dataLineage: d === null ? 0 : d.totals.lineage,
    dataOrchestration: d === null ? 0 : d.totals.orchestration,
    dataPrs: d === null ? 0 : d.totals.prs,
  };
}

type Evidence = {
  readonly row: ItemRow;
  readonly service: TriggerService;
  readonly meta: Record<string, unknown> | null;
  readonly facts: TriggerFacts;
  readonly binding: BindingBlock;
  readonly cfg: ServiceConfig | null;
  readonly bindingGaps: readonly GapNote[];
};

function noOpenTimeGap(): GapNote {
  return gap(
    "missing_relation_emit",
    "This source records no open time, so the change, chat, prior-incident and concurrent lanes (which are anchored on it) were skipped. The first observation time is shown instead.",
  );
}

/** Lanes 2 to 5 and 7 plus history, then the record body (without the cap, the gaps or the freshness). */
function buildBody(deps: AssembleDeps, ev: Evidence, nowMs: number, trigger: TriggerBlock) {
  const { db } = deps;
  const schemaLookbackHours = deps.dataSchemaLookbackHours;
  const open = trigger.opened.ms;
  const cfg = ev.cfg;
  const gaps: GapNote[] = [...substrateGaps(), ...ev.bindingGaps];
  const starts = loadServiceHistoryStarts(db).get(trigger.service) ?? null;
  const history = historyLane(db, {
    itemId: trigger.itemId,
    openedAtMs: open,
    historyStartsMs: starts,
  });
  gaps.push(...history.gaps);

  if (open === null) gaps.push(noOpenTimeGap());
  // Lanes 2 to 5 are anchored on a bound service AND an open time; without either they are skipped, with the reason.
  const anchor = ev.cfg !== null && open !== null ? { cfg: ev.cfg, open } : null;
  const reason = ev.cfg === null ? "unbound" : "no_open_time";

  const change =
    anchor === null
      ? skippedChange(reason)
      : changeLane(db, {
          cfg: anchor.cfg,
          triggerItemId: trigger.itemId,
          triggerService: trigger.service,
          openedAtMs: anchor.open,
        });
  const chat =
    anchor === null
      ? skippedChat(reason)
      : chatLane(db, { cfg: anchor.cfg, openedAtMs: anchor.open, nowMs });
  const prior =
    anchor === null
      ? skippedPrior(reason)
      : priorLane(db, {
          service: anchor.cfg.serviceId,
          triggerItemId: trigger.itemId,
          openedAtMs: anchor.open,
        });
  const concurrent =
    open === null
      ? skippedConcurrent()
      : concurrentLane(db, {
          triggerItemId: trigger.itemId,
          boundService: cfg === null ? null : cfg.serviceId,
          openedAtMs: open,
        });
  const data =
    trigger.service === "montecarlo" || trigger.service === "bigeye"
      ? dataLane(db, { metadata: ev.meta, openedAtMs: open, nowMs, schemaLookbackHours })
      : pagerdutyDataLane(db, {
          service: trigger.service,
          cfg,
          openedAtMs: open,
          nowMs,
          schemaLookbackHours,
        });
  // lane-census: scope=incident service=pagerduty
  const pdService =
    typeof ev.meta?.["pagerduty_service_id"] === "string"
      ? (ev.meta["pagerduty_service_id"] as string)
      : null;
  const onCall = oncallLane(db, {
    nowMs,
    cfg,
    triggerService: trigger.service,
    pagerdutyServiceId: pdService,
  });

  gaps.push(
    ...change.gaps,
    ...chat.gaps,
    ...prior.gaps,
    ...concurrent.gaps,
    ...(data?.gaps ?? []),
    ...onCall.gaps,
  );
  return {
    history: history.lane,
    change: change.lane,
    chat: chat.lane,
    prior: prior.lane,
    concurrent: concurrent.lane,
    data: data === null ? null : data.lane,
    onCall: onCall.lane,
    onCallStale: onCall.stale,
    gaps,
  };
}

function loadEvidence(deps: AssembleDeps, row: ItemRow, service: TriggerService): Evidence {
  const meta = parseMeta(row.metadata);
  const facts = triggerFacts({ service, metadata: row.metadata });
  const configs = deps.loadServiceConfigs();
  const bound = bindTrigger(buildServiceIdentityResolver(configs), configs, {
    service,
    type: row.type,
    metadata: meta,
  });
  return {
    row,
    service,
    meta,
    facts,
    binding: bound.block,
    cfg: bound.config,
    bindingGaps: bound.gaps,
  };
}

/**
 * Assemble (or refresh) the record of one trigger item. Never writes outside `incident-store.ts`. If an owner
 * erasure committed while this pass was gathering or rendering, the evidence is gathered again once; a second
 * overlap reports the item as missing (the next pass retries) rather than store text that was just erased.
 */
export async function assembleOne(
  deps: AssembleDeps,
  triggerItemId: string,
  nowMs: number,
): Promise<AssembleOutcome> {
  const first = await assembleAttempt(deps, triggerItemId, nowMs);
  if (first !== "erased_meanwhile") return first;
  const second = await assembleAttempt(deps, triggerItemId, nowMs);
  return second === "erased_meanwhile" ? { outcome: "missing" } : second;
}

async function assembleAttempt(
  deps: AssembleDeps,
  triggerItemId: string,
  nowMs: number,
): Promise<AssembleOutcome | "erased_meanwhile"> {
  const generation = erasureGeneration();
  const row = deps.db
    .query("SELECT id, service, type, external_id, title, url, metadata FROM item WHERE id = ?")
    .get(triggerItemId) as ItemRow | null;
  if (row === null) return { outcome: "missing" };
  if (!isTriggerPair(row.service, row.type)) {
    throw new IncidentError(
      "ERR_INCIDENT_NOT_A_TRIGGER",
      `${row.id} is not an incident trigger item (service ${row.service}, type ${row.type}).`,
    );
  }
  const service = row.service;
  const ev = loadEvidence(deps, row, service);
  const observed = observedTimes(deps.db, row.id, service, ev.facts.closedAtBasis === "observed");
  const trigger = triggerBlock(row, service, ev.facts, ev.meta, observed);
  const body = buildBody(deps, ev, nowMs, trigger);

  const draft: IncidentRecordV1 = {
    schema: INCIDENT_SCHEMA_VERSION,
    engine: INCIDENT_ENGINE_VERSION,
    trigger,
    binding: ev.binding,
    change: body.change,
    chat: body.chat,
    prior: body.prior,
    concurrent: body.concurrent,
    data: body.data,
    onCall: body.onCall,
    history: body.history,
    gaps: body.gaps,
    counts: {
      chat: 0,
      prior: 0,
      concurrent: 0,
      history: 0,
      dataLineage: 0,
      dataOrchestration: 0,
      dataPrs: 0,
    },
    version: 0,
    assembledAtMs: nowMs,
    freshness: { rows: [], chatToMs: null, onCallStale: null },
  };
  const counted: IncidentRecordV1 = { ...draft, counts: countsOf(draft) };
  const capped = capRecordSize(counted);
  const withCutGap: IncidentRecordV1 =
    capped.cuts.length === 0
      ? capped.record
      : {
          ...capped.record,
          gaps: [
            ...capped.record.gaps,
            gap(
              "missing_entity_type",
              `This record was cut to fit its size cap: ${capped.cuts
                .map((c) => `${c.lane} ${String(c.before)} to ${String(c.after)}`)
                .join(", ")}. The full counts are kept.`,
            ),
          ],
        };
  const record: IncidentRecordV1 = {
    ...withCutGap,
    freshness: freshnessOf(deps.db, withCutGap, nowMs, body.onCallStale),
  };

  const common = {
    agentVersion: 1 as const,
    generatedAt: nowMs,
    latencyMs: 0,
    gaps: [...record.gaps],
    record,
  };
  // A record with a data lane (a Monte Carlo or Bigeye trigger) is the Data Incident Brief; every other
  // record is the general incident brief. Both are deterministic renders of the same stored record.
  const brief: IncidentBrief | IncidentDataBrief =
    record.data === null ? { kind: "incident", ...common } : { kind: "incident_data", ...common };
  // ONE argument, always: no runner, so the render is deterministic and no model is reachable from here.
  const rendered = await synthesize(brief);
  // From here to the write there is no await: nothing can erase between this check and the insert.
  if (erasureGeneration() !== generation) return "erased_meanwhile";
  const stillThere = deps.db.query("SELECT 1 AS n FROM item WHERE id = ?").get(triggerItemId);
  if (stillThere === null) return { outcome: "missing" };
  const result = upsertIncidentRecord(deps.db, {
    record,
    markdown: rendered.markdown,
    recordSha256: recordHash(record),
    citedServices: citedServicesOf(record),
    nowMs,
  });
  return result;
}
