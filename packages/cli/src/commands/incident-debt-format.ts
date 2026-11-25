export const DEBT_USAGE_LINE =
  "       nimbus incident debt [--since <n>d] [--untouched <n>d] [--min-incidents <n>] [--limit <n>] [--json]";

export type DebtArgs = {
  readonly verb: "debt";
  readonly json: boolean;
  readonly since?: number;
  readonly untouched?: number;
  readonly minIncidents?: number;
  readonly limit?: number;
};

type Mutable = {
  json: boolean;
  since?: number;
  untouched?: number;
  minIncidents?: number;
  limit?: number;
};

function value(argv: readonly string[], i: number): string | undefined {
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

function days(v: string): number | undefined {
  const m = /^(\d{1,4})d$/.exec(v);
  const n = m?.[1] === undefined ? Number.NaN : Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : undefined;
}

function count(v: string, max: number): number | undefined {
  if (!/^\d{1,4}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= max ? n : undefined;
}

const PARSERS: Readonly<
  Record<string, readonly [keyof Mutable, (v: string) => number | undefined]>
> = {
  "--since": ["since", days],
  "--untouched": ["untouched", days],
  "--min-incidents": ["minIncidents", (v) => count(v, 50)],
  "--limit": ["limit", (v) => count(v, 200)],
};

/** `nimbus incident debt` flags; a duplicate, an unknown flag or an out-of-range value is a usage error. */
export function parseDebtArgs(argv: readonly string[]): DebtArgs | undefined {
  const out: Mutable = { json: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (seen.has(a)) return undefined;
    seen.add(a);
    if (a === "--json") {
      out.json = true;
      continue;
    }
    const spec = PARSERS[a];
    const v = value(argv, i);
    if (spec === undefined || v === undefined) return undefined;
    const n = spec[1](v);
    if (n === undefined) return undefined;
    (out as unknown as Record<string, number>)[spec[0]] = n;
    i += 1;
  }
  return {
    verb: "debt",
    json: out.json,
    ...(out.since === undefined ? {} : { since: out.since }),
    ...(out.untouched === undefined ? {} : { untouched: out.untouched }),
    ...(out.minIncidents === undefined ? {} : { minIncidents: out.minIncidents }),
    ...(out.limit === undefined ? {} : { limit: out.limit }),
  };
}

export interface DebtReplyLike {
  readonly status: "ok" | "none" | "no_incidents" | "no_roots";
  readonly windowDays: number;
  readonly untouchedDays: number;
  readonly minIncidents: number;
  readonly symbols: readonly {
    readonly name: string;
    readonly file: string;
    readonly root: string;
    readonly incidentCount: number;
    readonly lastTouchMs: number | null;
    readonly incidents: readonly {
      readonly id: string;
      readonly title: string;
      readonly openedAtMs: number;
    }[];
  }[];
  readonly omitted: number;
  readonly gaps: readonly {
    readonly category: string;
    readonly detail: string;
    readonly remediation?: string;
  }[];
  readonly counts: {
    readonly incidentsScanned: number;
    readonly rootsScanned: number;
    readonly filesJudged: number;
  };
}

/**
 * Text from the index or a repository (a symbol, a file name, an incident title) is attacker-influenced:
 * every control, format (bidi, zero-width) and line or paragraph separator character is dropped.
 */
export function cleanDebtText(s: string): string {
  return s
    .replace(/[\t\n\r\u2028\u2029]/g, " ")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type DebtSymbolLike = DebtReplyLike["symbols"][number];

function symbolLines(s: DebtSymbolLike): string[] {
  const touch = s.lastTouchMs === null ? "before the history read" : day(s.lastTouchMs);
  return [
    `  ${cleanDebtText(s.name)}  ${cleanDebtText(s.file)}  (${String(s.incidentCount)} incidents, last commit ${touch})`,
    `    root: ${cleanDebtText(s.root)}`,
    ...s.incidents.map(
      (i) => `    ${cleanDebtText(i.id)}  ${day(i.openedAtMs)}  ${cleanDebtText(i.title)}`,
    ),
  ];
}

/** The body for a status other than `ok`: why no symbol is listed. */
const EMPTY_DEBT_TEXT: Readonly<Record<string, string>> = {
  none: "No symbol qualifies.",
  no_incidents: "No incident record was opened in the window, so nothing can point at a file.",
};
const NO_ROOT_TEXT = "No git-aware filesystem root is configured, so there is no history to read.";

function debtBodyLines(r: DebtReplyLike): string[] {
  if (r.status !== "ok") {
    return [
      Object.hasOwn(EMPTY_DEBT_TEXT, r.status)
        ? (EMPTY_DEBT_TEXT[r.status] as string)
        : NO_ROOT_TEXT,
    ];
  }
  const lines = [
    `Code symbols in files that ${String(r.minIncidents)}+ incidents of the last ${String(r.windowDays)} days pointed at and that nobody committed to for ${String(r.untouchedDays)} days:`,
    ...r.symbols.flatMap(symbolLines),
  ];
  if (r.omitted > 0) lines.push(`  ... and ${String(r.omitted)} more (raise --limit).`);
  return lines;
}

export function formatDebt(r: DebtReplyLike): string {
  const lines = [
    ...debtBodyLines(r),
    `Scanned ${String(r.counts.incidentsScanned)} incident(s), ${String(r.counts.rootsScanned)} root(s), ${String(r.counts.filesJudged)} file(s).`,
  ];
  if (r.gaps.length > 0) {
    lines.push("", "Gaps:");
    for (const g of r.gaps) {
      const fix = g.remediation === undefined ? "" : ` ${cleanDebtText(g.remediation)}`;
      lines.push(`  - ${cleanDebtText(g.detail)}${fix}`);
    }
  }
  return lines.join("\n");
}
