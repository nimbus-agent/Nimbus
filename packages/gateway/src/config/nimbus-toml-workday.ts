import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isTableHeader,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

export interface WorkdayReport {
  readonly label: string;
  readonly url: string;
  readonly keyField?: string;
  readonly fields?: string[];
}
export interface NimbusWorkdayToml {
  readonly timeOffHistoryDays: number;
  readonly reports: WorkdayReport[];
}
export const DEFAULT_NIMBUS_WORKDAY_TOML: NimbusWorkdayToml = {
  timeOffHistoryDays: 365,
  reports: [],
};

interface ReportAccum {
  label?: string;
  url?: string;
  keyField?: string;
  fields?: string[];
}

function finalizeReport(r: ReportAccum): WorkdayReport | null {
  if (r.label === undefined || r.label === "" || r.url === undefined || r.url === "") {
    return null;
  }
  return {
    label: r.label,
    url: r.url,
    ...(r.keyField === undefined || r.keyField === "" ? {} : { keyField: r.keyField }),
    // Preserve a present-but-empty `fields` (e.g. it parsed to []) so applyReportFieldPolicy
    // fails closed (emit nothing) instead of dropping to undefined and widening to the denylist.
    ...(r.fields !== undefined ? { fields: r.fields } : {}),
  };
}

function parseMainSectionKv(key: string, valRaw: string, current: number): number {
  if (key === "time_off_history_days") {
    const n = Number.parseInt(valRaw.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return current;
}

function parseReportEntryKv(key: string, valRaw: string, cur: ReportAccum): void {
  if (key === "label") cur.label = parseString(valRaw);
  else if (key === "url") cur.url = parseString(valRaw);
  else if (key === "key_field") cur.keyField = parseString(valRaw);
  else if (key === "fields") {
    try {
      cur.fields = parseStringArray(valRaw);
    } catch {
      cur.fields = [];
    }
  }
}

export function parseNimbusWorkdayToml(
  source: string,
  defaults: NimbusWorkdayToml = DEFAULT_NIMBUS_WORKDAY_TOML,
): NimbusWorkdayToml {
  let timeOffHistoryDays = defaults.timeOffHistoryDays;
  const reports: WorkdayReport[] = [];
  let section: "main" | "report" | "other" = "other";
  let cur: ReportAccum | null = null;

  const flush = (): void => {
    if (cur !== null) {
      const r = finalizeReport(cur);
      if (r !== null) reports.push(r);
      cur = null;
    }
  };

  for (const line of source.split(/\r?\n/)) {
    const t = stripComment(line).trim();
    if (t === "") continue;
    if (isTableHeader(t)) {
      flush();
      if (t === "[connectors.workday]") section = "main";
      else if (t === "[[connectors.workday.reports]]") {
        section = "report";
        cur = {};
      } else section = "other";
      continue;
    }
    const kv = splitKeyValue(t);
    if (kv === undefined) continue;
    if (section === "main") {
      timeOffHistoryDays = parseMainSectionKv(kv.key, kv.valRaw, timeOffHistoryDays);
    } else if (section === "report" && cur !== null) {
      parseReportEntryKv(kv.key, kv.valRaw, cur);
    }
  }
  flush();
  return { timeOffHistoryDays, reports };
}

export function loadNimbusWorkdayFromConfigDir(configDir: string): NimbusWorkdayToml {
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return DEFAULT_NIMBUS_WORKDAY_TOML;
  return parseNimbusWorkdayToml(readFileSync(tomlPath, "utf8"));
}
