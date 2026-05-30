export type PreflightMode = "warn" | "block" | "off";

export type Finding = {
  id: string;
  title: string;
  url?: string | null;
};

export type Check = {
  count: number;
  findings: readonly Finding[];
  gap: string | null;
};

export type Envelope = {
  service: string;
  target_ref: string;
  computed_at: string;
  verdict: "ok" | "warn";
  checks: {
    active_p1_incidents: Check;
    failing_ci_runs: Check;
    merge_conflicts: Check;
  };
};

const CHECK_LABELS: Record<string, string> = {
  active_p1_incidents: "Active P1 incidents",
  failing_ci_runs: "Failing CI runs",
  merge_conflicts: "Merge conflicts",
};

const CHECK_ORDER = ["active_p1_incidents", "failing_ci_runs", "merge_conflicts"] as const;

export function renderJobSummary(env: Envelope): string {
  const lines: string[] = [];
  lines.push(
    `### Nimbus pre-deploy preflight — ${env.service} @ \`${env.target_ref}\``,
    "",
    `**Verdict:** \`${env.verdict}\``,
    `**Computed at:** ${env.computed_at}`,
    "",
    "| Check | Count | Gap |",
    "|---|---:|---|",
  );
  for (const key of CHECK_ORDER) {
    const m = env.checks[key];
    const gap = m.gap === null ? "" : `\`${m.gap}\``;
    lines.push(`| ${CHECK_LABELS[key]} | ${m.count} | ${gap} |`);
  }
  for (const key of CHECK_ORDER) {
    const m = env.checks[key];
    if (m.findings.length === 0) continue;
    lines.push("", `<details><summary>${CHECK_LABELS[key]} (${m.count})</summary>`, "");
    for (const f of m.findings) {
      const linkPart = f.url ? ` — ${f.url}` : "";
      lines.push(`- \`${f.id}\` — ${f.title}${linkPart}`);
    }
    lines.push("</details>");
  }
  return lines.join("\n");
}

export type Annotation = {
  level: "warning" | "error";
  message: string;
  url?: string | null;
};

export function renderAnnotations(env: Envelope, mode: PreflightMode): Annotation[] {
  if (env.verdict === "ok") return [];
  const level: Annotation["level"] = mode === "block" ? "error" : "warning";
  const out: Annotation[] = [];
  for (const key of CHECK_ORDER) {
    const m = env.checks[key];
    for (const f of m.findings) {
      out.push({
        level,
        message: `[${CHECK_LABELS[key]}] ${f.title} (${f.id})`,
        url: f.url ?? null,
      });
    }
  }
  return out;
}

export function decideExitCode(args: {
  verdict: "ok" | "warn";
  mode: PreflightMode;
  unreachable: boolean;
  allowGatewayFailure: boolean;
}): 0 | 1 {
  if (args.unreachable) {
    if (args.allowGatewayFailure) return 0;
    return args.mode === "block" ? 1 : 0;
  }
  if (args.mode === "block" && args.verdict === "warn") return 1;
  return 0;
}
