import type { AuditExportRow } from "../../../ipc/types";

export interface AuditDisplayRow {
  readonly id: number;
  readonly tsIso: string;
  readonly service: string;
  readonly action: string;
  readonly outcome: "approved" | "rejected" | "not_required";
  readonly actor: string;
  readonly rowHash: string;
}

export function splitActionType(actionType: string): { service: string; action: string } {
  const dot = actionType.indexOf(".");
  if (dot === -1) return { service: actionType, action: actionType };
  return { service: actionType.slice(0, dot), action: actionType.slice(dot + 1) };
}

export function extractActor(actionJson: string): string {
  if (actionJson === "" || actionJson === "{}") return "";
  try {
    const parsed = JSON.parse(actionJson) as unknown;
    if (parsed !== null && typeof parsed === "object" && "actor" in parsed) {
      const actor = parsed.actor;
      if (typeof actor === "string") return actor;
    }
  } catch {
    /* ignore */
  }
  return "";
}

export function toDisplayRow(row: AuditExportRow): AuditDisplayRow {
  const { service, action } = splitActionType(row.actionType);
  return {
    id: row.id,
    tsIso: new Date(row.timestamp).toISOString(),
    service,
    action,
    outcome: row.hitlStatus,
    actor: extractActor(row.actionJson),
    rowHash: row.rowHash,
  };
}

export function csvEscape(field: string): string {
  if (field === "") return "";
  const needsQuote = /[",\r\n]/.test(field);
  const escaped = field.replaceAll('"', '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

export function rowsToCsv(rows: ReadonlyArray<AuditExportRow>): string {
  const header = "timestamp,service,actor,action,outcome,rowHash";
  const lines = rows.map((r) => {
    const d = toDisplayRow(r);
    return [d.tsIso, d.service, d.actor, d.action, d.outcome, d.rowHash].map(csvEscape).join(",");
  });
  return [header, ...lines].join("\n");
}
