import type { OwnershipBrief, OwnershipTargetView } from "../ownership-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { assembleBrief } from "./_shared.ts";

function renderOwnershipCounts(t: OwnershipTargetView): string {
  if (t.ownerCount === null || t.ownersAboveFloor === null) {
    return "      (owner breakdown not recorded for this path — run `nimbus owners --refresh`)";
  }
  const floor = `${String(t.ownersAboveFloor)} of ${String(t.ownerCount)} contributor(s) clear the share floor`;
  return t.truncated === true
    ? `      (${floor}; showing top ${String(t.owners.length)})`
    : `      (${floor})`;
}

function renderOwnershipTarget(heading: string, t: OwnershipTargetView | null): string[] {
  if (t === null) return [];
  if (t.owners.length === 0) {
    // Counts recorded but nobody cleared the share floor is a different fact than
    // nothing recorded at all — a reader must not confuse the two. Gate on
    // `ownersAboveFloor` presence, matching `parseCounts` in ownership-store.ts: a
    // legacy row (written before the ownerCount/ownersAboveFloor split) has a
    // non-null `ownerCount` but a null `ownersAboveFloor`, and must report as
    // unrecorded, not assert a floor result the row never recorded.
    if (t.ownersAboveFloor === null) {
      return [
        `### ${heading} — ${t.displayPath}`,
        "",
        "_Owner breakdown not recorded for this path — run `nimbus owners --refresh`._",
        "",
      ];
    }
    if (t.ownerCount !== null && t.ownerCount > 0) {
      return [
        `### ${heading} — ${t.displayPath}`,
        "",
        "_No owners cleared the share floor._",
        renderOwnershipCounts(t),
        "",
      ];
    }
    return [`### ${heading} — ${t.displayPath}`, "", "_No owners recorded._", ""];
  }
  const rows = t.owners.map((o, i) => {
    const pct = `${(o.share * 100).toFixed(1)}%`;
    const mark = o.resolved ? "" : "  (unresolved git identity)";
    return `  ${String(i + 1)}. ${o.label.padEnd(28)} ${pct}${mark}`;
  });
  return [`### ${heading} — ${t.displayPath}`, "", ...rows, renderOwnershipCounts(t), ""];
}

export function renderOwnership(brief: OwnershipBrief, opts?: RenderOpts): string {
  const subject = brief.query.path ?? brief.query.service ?? "coverage";
  const header = `## Ownership · ${subject}`;
  const sections = [
    ...renderOwnershipTarget("Owners", brief.target),
    ...renderOwnershipTarget("Directory", brief.parentDirectory),
  ];
  const svc = brief.service === null ? [] : [`### Rolls up to service: ${brief.service.id}`, ""];
  const cov = [
    "### Coverage",
    "",
    `  roots ${String(brief.coverage.rootsCovered)}/${String(brief.coverage.rootsTotal)} · ` +
      `files ${String(brief.coverage.filesCovered)} · ` +
      `excluded ${String(brief.coverage.filesExcluded)} · ` +
      `services ${String(brief.coverage.servicesBound)}`,
  ];
  const body = [...sections, ...svc, ...cov].join("\n");
  return assembleBrief(header, [body], brief, opts);
}
