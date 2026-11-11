import { stripControlChars } from "../lib/strip-control-chars.ts";

/**
 * Pure helpers for `nimbus briefing` and the `nimbus doctor` briefing check. The CLI cannot import the
 * gateway's types (IPC-only rule), so the shapes below are local structural stand-ins; a field the gateway
 * might omit is optional and read defensively. Text that came from the index is passed through
 * `stripControlChars` by the caller before it reaches the terminal.
 */

export type BriefingMode = "latest" | "now" | "list" | "status";

export interface BriefingArgs {
  readonly mode: BriefingMode;
  readonly json: boolean;
  readonly limit?: number;
}

export const BRIEFING_USAGE = "Usage: nimbus briefing [now | list [--limit <n>] | status] [--json]";

export function parseBriefingArgs(argv: readonly string[]): BriefingArgs | undefined {
  let json = false;
  let mode: BriefingMode | undefined;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--json") {
      json = true;
    } else if ((a === "now" || a === "list" || a === "status") && mode === undefined) {
      mode = a;
    } else if (a === "--limit" && mode === "list" && limit === undefined) {
      i += 1;
      const n = Number(argv[i]);
      if (!Number.isInteger(n) || n < 1 || n > 100) return undefined;
      limit = n;
    } else {
      return undefined;
    }
  }
  return { mode: mode ?? "latest", json, ...(limit === undefined ? {} : { limit }) };
}

export interface RunSummaryLike {
  readonly id: string;
  readonly firedAt: number;
  readonly firedBy: string;
  readonly status: string;
  readonly headline: string;
  readonly errorMsg?: string | null;
}

export interface RunViewLike extends RunSummaryLike {
  readonly markdown: string | null;
}

export interface BriefingStatusLike {
  readonly enabled: boolean;
  readonly schedule: string;
  readonly tz: string;
  readonly sections: readonly string[];
  readonly retentionDays: number;
  readonly nextFireMs: number | null;
  readonly lastRun: RunSummaryLike | null;
  readonly deadlines: {
    readonly enabled: boolean;
    readonly leadHours: number;
    readonly quietHours: number;
    readonly lastScanMs: number | null;
    readonly lastCandidateCount: number | null;
    readonly lastNoticeCount: number | null;
  };
  readonly sources: ReadonlyArray<{
    readonly section: string;
    readonly services: ReadonlyArray<{ readonly id: string; readonly connected: boolean }>;
  }>;
  readonly toastDelivers: boolean;
  readonly demo: boolean;
}

const clean = (s: string): string => stripControlChars(s);

/** `YYYY-MM-DD HH:mm` in `zone` (the machine's zone when absent). */
export function localTime(ms: number, zone?: string): string {
  const f = new Intl.DateTimeFormat("sv-SE", {
    ...(zone === undefined ? {} : { timeZone: zone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return f.format(new Date(ms));
}

export function runFooter(run: RunSummaryLike, zone?: string): string {
  return `fired ${localTime(run.firedAt, zone)} - ${clean(run.firedBy)}`;
}

export function listLine(run: RunSummaryLike, zone?: string): string {
  const reason = run.status === "skipped" ? ` (${clean(run.headline)})` : "";
  const headline = run.status === "skipped" ? "" : ` ${clean(run.headline)}`;
  return `${clean(run.id).slice(0, 8)} ${localTime(run.firedAt, zone)} ${clean(run.firedBy)} ${clean(run.status)}${headline}${reason}`;
}

/** Sections with no connected service at all. */
export function unconnectedSections(s: BriefingStatusLike): string[] {
  return s.sources.filter((x) => !x.services.some((v) => v.connected)).map((x) => x.section);
}

export function statusLines(s: BriefingStatusLike): string[] {
  const out: string[] = [];
  out.push(`Briefing: ${s.enabled ? "on" : "off"}${s.demo ? " (demo)" : ""}`);
  out.push(`Schedule: ${clean(s.schedule)} (${clean(s.tz)})`);
  out.push(
    s.nextFireMs === null
      ? "Next: none"
      : `Next: ${localTime(s.nextFireMs, s.tz)} (${clean(s.tz)})`,
  );
  out.push(`Sections: ${s.sections.map(clean).join(", ")}`);
  out.push(`Keeps runs for ${String(s.retentionDays)} days`);
  out.push(
    s.lastRun === null
      ? "Last run: none"
      : `Last run: ${localTime(s.lastRun.firedAt, s.tz)} ${clean(s.lastRun.firedBy)} ${clean(s.lastRun.status)}`,
  );
  const d = s.deadlines;
  out.push(
    d.enabled
      ? `Deadline notices: on (within ${String(d.leadHours)} h, quiet for ${String(d.quietHours)} h)`
      : "Deadline notices: off",
  );
  if (d.enabled) {
    out.push(
      d.lastScanMs === null
        ? "Last deadline scan: none yet"
        : `Last deadline scan: ${localTime(d.lastScanMs, s.tz)}, ${String(d.lastCandidateCount ?? 0)} candidates, ${String(d.lastNoticeCount ?? 0)} notified`,
    );
  }
  for (const src of s.sources) {
    const parts = src.services.map(
      (v) => `${clean(v.id)} ${v.connected ? "connected" : "not connected"}`,
    );
    out.push(`  ${clean(src.section)}: ${parts.join(", ")}`);
  }
  out.push(
    s.toastDelivers
      ? "Toast: will show"
      : "Toast: will not show (notifications are off or unavailable; nimbus doctor says why)",
  );
  return out;
}

/** The `nimbus doctor` lines for the briefing; `exit` is 1 when any line is a warning. */
export function doctorBriefingLines(
  s: BriefingStatusLike,
  zone?: string,
): { lines: string[]; exit: number } {
  if (!s.enabled && !s.deadlines.enabled) return { lines: [], exit: 0 };
  const lines: string[] = [];
  let exit = 0;
  if (s.enabled) {
    const missing = unconnectedSections(s);
    if (missing.length > 0) {
      lines.push(
        `[warn] Morning briefing: enabled but no source is connected for: ${missing.map(clean).join(", ")}`,
      );
      exit = 1;
    }
    const last = s.lastRun;
    if (last !== null && last.status === "failed" && last.firedBy === "schedule") {
      lines.push(
        `[warn] Morning briefing: the last scheduled briefing failed (${clean(last.errorMsg ?? "no error recorded")})`,
      );
      exit = 1;
    }
  }
  if (!s.toastDelivers) {
    lines.push(
      "[info] Morning briefing: notifications will not show (the briefing is still stored; read it with `nimbus briefing`)",
    );
  }
  if (exit === 0 && s.toastDelivers) {
    const next =
      s.nextFireMs === null
        ? "deadline notices only"
        : `next ${localTime(s.nextFireMs, zone ?? s.tz)}`;
    lines.push(`[ok] Morning briefing: ${next}`);
  }
  return { lines, exit };
}
