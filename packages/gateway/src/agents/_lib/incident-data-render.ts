import type { DataLane } from "../../incident/incident-record-types.ts";
import {
  changeLines,
  concurrentLines,
  dbtTestLine,
  historyLines,
  plain,
  renderIncidentFreshness,
  section,
  serviceLines,
  summaryLines,
  utcLabel,
} from "./incident-render.ts";
import type { IncidentDataBrief } from "./incident-types.ts";
import { hardenedTitleLink, type RenderOpts, renderGaps } from "./render.ts";

/**
 * The deterministic render of the Data Incident Brief (the incident engine, the Phase 10 row "Automatic
 * incident assembly", data-platform alerts). It renders the SAME stored record as `renderIncident`, in a
 * data-first order: what is monitored, what it is built from, the jobs that share its name and the changes
 * merged in the day before, then the service, the candidate changes, concurrent incidents and the recorded
 * state changes. No model anywhere in it (OR-10-8, I57 (a)); zone-free (every time UTC), so it is
 * byte-identical across machines. Every provider-supplied string goes through `hardenedTitleLink` or
 * `hardenedPlain`; the fixed text is ours.
 *
 * What the index does NOT hold (DAG-run logs, warehouse schema changes) is never invented
 * here: the record lists each as a gap, and the reserved `## Gaps` block (I31) carries them to the reader.
 * The orchestration and pull-request entries are matches by NAME (a model's last identifier segment as a whole
 * token), never lineage, and the text says so.
 */

export const INCIDENT_DATA_NAME_MATCH_NOTE =
  "_Jobs and changes are listed by name match (the model's last name segment as a whole word), not by lineage._";

function modelLines(d: DataLane): string[] {
  return d.models.length === 0
    ? ["_No monitored table._"]
    : d.models.map((m) => `- \`${plain(m)}\``);
}

function lineageLines(d: DataLane): string[] {
  if (d.lineage.length === 0) return ["_No upstream model recorded for the monitored table._"];
  const rows = d.lineage.map(
    (l) => `- \`${plain(l.model)}\` is built from \`${plain(l.to)}\` (rule: ${l.rule})`,
  );
  const more = d.totals.lineage - d.lineage.length;
  return more > 0 ? [...rows, `_and ${String(more)} more_`] : rows;
}

function orchestrationLines(d: DataLane): string[] {
  if (d.orchestration.length === 0) return ["_No orchestration job matched by name._"];
  const rows = d.orchestration.map(
    (o) => `- ${hardenedTitleLink(o.title, o.url)} - ${plain(o.service)} (rule: ${o.rule})`,
  );
  const more = d.totals.orchestration - d.orchestration.length;
  return more > 0
    ? [...rows, `_and ${String(more)} more_`, INCIDENT_DATA_NAME_MATCH_NOTE]
    : [...rows, INCIDENT_DATA_NAME_MATCH_NOTE];
}

function dbtLines(d: DataLane): string[] {
  const tests = d.dbtTests ?? [];
  const total = d.totals.dbtTests ?? tests.length;
  if (total === 0) return ["_No failing or warning dbt test found for these models._"];
  const rows = tests.map(dbtTestLine);
  const more = total - tests.length;
  return more > 0 ? [...rows, `_and ${String(more)} more_`] : rows;
}

function mergedLines(d: DataLane): string[] {
  if (d.prs.length === 0)
    return ["_No change merged in the 24 hours before the alert matched by name._"];
  const rows = d.prs.map(
    (p) =>
      `- ${hardenedTitleLink(p.title, p.url)}${p.atMs === null ? "" : `, merged ${utcLabel(p.atMs)}`} (rule: ${p.rule})`,
  );
  const more = d.totals.prs - d.prs.length;
  return more > 0 ? [...rows, `_and ${String(more)} more_`] : rows;
}

export function renderIncidentData(brief: IncidentDataBrief, opts?: RenderOpts): string {
  const r = brief.record;
  const header = `# Data incident ${hardenedTitleLink(r.trigger.title, r.trigger.url)}`;
  const dataSections =
    r.data === null
      ? [section("Monitored models", ["_No data lane was recorded for this trigger._"])]
      : [
          section("Monitored models", modelLines(r.data)),
          section("Built from", lineageLines(r.data)),
          section("Jobs by name", orchestrationLines(r.data)),
          section("dbt tests", dbtLines(r.data)),
          section("Merged before the alert", mergedLines(r.data)),
        ];
  const body = [
    section("Summary", summaryLines(r.trigger)),
    ...dataSections,
    section("Service", serviceLines(r)),
    section("Change", changeLines(r.change)),
    section("Concurrent", concurrentLines(r.concurrent)),
    section("History", historyLines(r.history)),
  ];
  const withheld = opts?.omitReserved === true;
  const gaps = withheld ? "" : renderGaps(brief.gaps).trim();
  const freshness = withheld ? "" : renderIncidentFreshness(r.freshness);
  return [header, ...body, gaps, freshness].filter((s) => s !== "").join("\n\n");
}
