// The cost defaults a role pack may set (Phase 7, slice 7; I47): `[cost] internal_envs`, `[[cost.rule]]` and
// `[[cost.report]]`. Never `[[cost.report.channel]]`: a pack never chooses where cost data goes, so a pack report
// sends nothing until the owner writes a channel in their own file and approves the workflow that posts it.
//
// Pure. The pack's cost sections are checked by the REAL cost compiler (`resolveCostConfig`) over the sections
// `checkPackFragment` already parsed, as one pack layer, so a pack can never set a rule or report that the
// owner's own file could not.

import { type NimbusCostConfig, resolveCostConfig } from "./cost-toml.ts";
import { type DocSection, mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

/** The cost array tables a pack may set. */
export const PACK_COST_ARRAY_HEADERS = ["cost.rule", "cost.report"] as const;
export type PackCostArrayHeader = (typeof PACK_COST_ARRAY_HEADERS)[number];

export function isPackCostArrayHeader(header: string): header is PackCostArrayHeader {
  return (PACK_COST_ARRAY_HEADERS as readonly string[]).includes(header);
}

/** The env names a pack's `[cost] internal_envs` may list: the cost compiler re-checks every one. */
export const PACK_COST_INTERNAL_ENVS_MAX = 32;

function isCostSection(s: DocSection): boolean {
  return (
    s.malformed === undefined &&
    (s.header === "cost" || (s.isArray && isPackCostArrayHeader(s.header ?? "")))
  );
}

function compilePackCost(sections: readonly DocSection[]): NimbusCostConfig {
  const effective = mergeLayerDocs([{ layer: { kind: "pack", id: "check", path: "" }, sections }]);
  return resolveCostConfig(effective.sections);
}

/** The problems with a pack's cost sections (`[cost]` plus its cost array blocks); empty when fine. */
export function checkPackCostSections(sections: readonly DocSection[]): readonly string[] {
  if (sections.length === 0) return [];
  const cfg = compilePackCost(sections);
  const problems: string[] = [];
  if (cfg.error !== null) problems.push(`cost: ${cfg.error}`);
  if (cfg.reportsError !== null) problems.push(`cost: ${cfg.reportsError}`);
  return problems;
}

/**
 * What a pack's cost defaults do, one row each, for the install, update and show prompts. Empty when the
 * fragment sets no cost default (or is refused, which the install refuses before any prompt). The full text is
 * printed beside it, so this is a reading aid, not the record of what was approved.
 */
export function packCostSummary(defaults: string): readonly string[] {
  const sections = parseLayerDoc({ kind: "pack", id: "show", path: "" }, defaults).sections.filter(
    isCostSection,
  );
  if (sections.length === 0) return [];
  const cfg = compilePackCost(sections);
  if (cfg.error !== null || cfg.reportsError !== null) return [];
  const rows: string[] = [];
  if (sections.some((s) => s.header === "cost")) {
    rows.push(
      `internal environments: ${cfg.internalEnvs.join(", ")} (your own [cost] internal_envs replaces them)`,
    );
  }
  if (cfg.rules.length > 0) {
    rows.push(
      `${String(cfg.rules.length)} allocation rule(s), first match wins (your own [[cost.rule]] replaces them all)`,
    );
  }
  for (const r of cfg.reports) {
    const scope = Object.entries(r.scope)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    rows.push(
      `report ${r.name}: ${scope}, per ${r.period}; it sends nothing until you add a [[cost.report.channel]] for it`,
    );
  }
  return rows;
}
