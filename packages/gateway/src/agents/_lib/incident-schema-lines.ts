import type { DataSchemaChangeView, DataSchemaLane } from "../../incident/incident-record-types.ts";

/**
 * The schema-change lines of the data lane (Phase 10, the warehouse schema diff). Pure: the two formatters
 * (`plain` for provider text, `utc` for a time) come from `incident-render.ts` and are passed in, which keeps
 * this file free of a cycle with it. Every column and type is provider text and goes through `plain`; the
 * words around it are ours. Nothing here says a column was dropped unless the record holds a diff between two
 * complete observations (the lane builds no other kind).
 */
export type SchemaLineFormat = {
  readonly plain: (s: string) => string;
  readonly utc: (ms: number) => string;
};

function what(c: DataSchemaChangeView, plain: (s: string) => string): string {
  const col = `\`${plain(c.column)}\``;
  const from = c.from === null ? "unknown" : plain(c.from);
  const to = c.to === null ? "unknown" : plain(c.to);
  switch (c.kind) {
    case "added":
      return `column ${col} added (${to})`;
    case "dropped":
      return `column ${col} dropped (was ${from})`;
    case "type_changed":
      return `column ${col} type ${from} -> ${to}`;
    case "nullability_changed":
      return `column ${col} ${from} -> ${to}`;
  }
}

export function schemaChangeLines(s: DataSchemaLane, fmt: SchemaLineFormat): string[] {
  const rows = s.changes.map(
    (c) =>
      `- ${fmt.utc(c.atMs)}: \`${fmt.plain(c.model)}\` (${c.via}): ${what(c, fmt.plain)} (rule: ${c.rule})`,
  );
  const more = s.total - s.changes.length;
  const head = `_Changes the warehouse syncs observed from ${fmt.utc(s.windowFromMs)} (${String(s.lookbackHours)} h before the alert) on; the time is when the sync saw the change._`;
  return more > 0 ? [head, ...rows, `_and ${String(more)} more_`] : [head, ...rows];
}
