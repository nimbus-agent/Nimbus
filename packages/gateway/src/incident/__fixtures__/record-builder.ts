import {
  INCIDENT_ENGINE_VERSION,
  INCIDENT_SCHEMA_VERSION,
  type IncidentRecordV1,
  type TriggerBlock,
} from "../incident-record-types.ts";

/** A minimal valid record for store, erasure and render tests. */
export function buildRecord(
  over: {
    readonly itemId?: string;
    readonly service?: TriggerBlock["service"];
    readonly type?: string;
    readonly title?: string;
    readonly status?: TriggerBlock["status"];
    readonly severity?: string | null;
    readonly openedAtMs?: number | null;
    readonly boundService?: string | null;
    readonly chatTitles?: readonly string[];
    readonly assembledAtMs?: number;
  } = {},
): IncidentRecordV1 {
  const itemId = over.itemId ?? "pagerduty:PD1";
  const service = over.service ?? "pagerduty";
  const opened = over.openedAtMs === undefined ? 1_000_000 : over.openedAtMs;
  const chat = (over.chatTitles ?? []).map((title, i) => ({
    id: `slack:m${String(i)}`,
    service: "slack",
    title,
    url: null,
    atMs: 1_000 + i,
    rule: "chat_phrase:payments",
  }));
  return {
    schema: INCIDENT_SCHEMA_VERSION,
    engine: INCIDENT_ENGINE_VERSION,
    trigger: {
      itemId,
      service,
      type: over.type ?? "incident",
      providerId: itemId.slice(itemId.indexOf(":") + 1),
      title: over.title ?? "Payments latency",
      url: null,
      status: over.status ?? "open",
      statusRaw: over.status ?? "open",
      severity: over.severity === undefined ? "p1" : over.severity,
      severityRaw: over.severity === undefined ? "P1" : over.severity,
      opened: { ms: opened, basis: opened === null ? "none" : "provider" },
      closed: { ms: null, basis: "none" },
      firstObservedMs: null,
      assigneeCount: null,
      slaStatus: null,
    },
    binding: {
      bound: (over.boundService ?? null) !== null,
      service: over.boundService ?? null,
      via:
        over.boundService === undefined || over.boundService === null ? null : "pagerduty_service",
      unboundReason:
        over.boundService === undefined || over.boundService === null ? "unknown" : null,
    },
    change: { skipped: null, deployment: null, graphCorrelated: null, pr: null, ci: null },
    chat: {
      skipped: null,
      fromMs: null,
      terms: [],
      termsSource: "none",
      total: chat.length,
      messages: chat,
    },
    prior: { skipped: null, total: 0, incidents: [] },
    concurrent: { skipped: null, total: 0, records: [] },
    data: null,
    onCall: {
      status: "skipped",
      resolvedVia: null,
      youAreOnCall: null,
      current: [],
      next: [],
      rule: "on_call_now",
    },
    history: { startsMs: null, total: 0, truncated: 0, rows: [] },
    gaps: [],
    counts: {
      chat: chat.length,
      prior: 0,
      concurrent: 0,
      history: 0,
      dataLineage: 0,
      dataOrchestration: 0,
      dataPrs: 0,
    },
    version: 0,
    assembledAtMs: over.assembledAtMs ?? 2_000_000,
    freshness: { rows: [], chatToMs: null, onCallStale: null },
  };
}
