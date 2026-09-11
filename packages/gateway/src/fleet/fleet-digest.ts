import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { summarizeBrief } from "./fleet-digest-extractors.ts";
import type {
  BriefSummary,
  FleetDigestNotCompared,
  FleetDigestResult,
  FleetJobDigest,
  FleetMetricDelta,
} from "./fleet-digest-types.ts";
import type { FleetStore } from "./fleet-store.ts";

type Compared = Pick<
  FleetJobDigest,
  "status" | "metrics" | "metricsSuppressed" | "keysAppeared" | "keysResolved"
>;

/**
 * Spec § 6.3: a change withheld by `minDelta` must not read as "nothing happened". Three outcomes,
 * not two — `unchanged_within_threshold` is what tells a reader the threshold was involved.
 */
function digestStatus(changed: boolean, metricsSuppressed: number): Compared["status"] {
  if (changed) return "changed";
  if (metricsSuppressed > 0) return "unchanged_within_threshold";
  return "unchanged";
}

/** Why a metric row shows no delta: it exists on only one side of the comparison. */
function oneSidedNote(d: FleetMetricDelta): string {
  if (d.before === null) return " (new metric)";
  if (d.after === null) return " (no longer reported)";
  return "";
}

/**
 * Pure comparison of two brief summaries into the diff fields of a `FleetJobDigest`. No I/O, no
 * database — the caller (Task 8) supplies the identity fields (job id, brief ids, timestamps).
 *
 * Four rules, each load-bearing (spec § 6):
 *  1. A key change (appeared/resolved) is NEVER suppressed by `minDelta` — it is not a magnitude.
 *  2. A metric present on only one side is reported as `{ before: null, after: null, delta: null }`
 *     on the missing side, never synthesized into a fabricated `0 -> N` jump — and it is reported
 *     regardless of `minDelta`, since there is no delta to compare against the threshold.
 *  3. A suppressed-by-threshold change must not read as "nothing happened": the status is
 *     `unchanged_within_threshold`, distinct from `unchanged`.
 *  4. `metricsSuppressed` counts every withheld metric UNCONDITIONALLY — not only when the whole
 *     job is otherwise unchanged. A job can have one metric clear the threshold (reported, and
 *     `status: "changed"`) and another withheld below it in the SAME comparison; without a count
 *     that survives the `changed` branch, the withheld metric leaves no trace anywhere in the
 *     digest — neither the markdown nor the JSON says a metric was suppressed at all.
 */
export function compareSummaries(
  before: BriefSummary,
  after: BriefSummary,
  minDelta: number,
): Compared {
  const b = new Set(before.keys);
  const a = new Set(after.keys);
  const keysAppeared = [...a].filter((k) => !b.has(k)).sort(codeUnitCompare);
  const keysResolved = [...b].filter((k) => !a.has(k)).sort(codeUnitCompare);

  const metrics: Record<string, FleetMetricDelta> = {};
  let metricsSuppressed = 0;
  const names = [...new Set([...Object.keys(before.metrics), ...Object.keys(after.metrics)])].sort(
    codeUnitCompare,
  );
  for (const name of names) {
    const bv = before.metrics[name];
    const av = after.metrics[name];
    if (bv === undefined || av === undefined) {
      // Present on one side only: an extractor gained or lost a field. Reporting `0 -> N` would
      // assert movement of exactly the current value, indistinguishable from a real jump from
      // zero, and would fire on every job the first night after any extractor changed (§ 6.1).
      // Reported unconditionally: there is no delta here for `minDelta` to bound.
      metrics[name] = { before: bv ?? null, after: av ?? null, delta: null };
      continue;
    }
    const delta = av - bv;
    if (delta === 0) continue;
    if (Math.abs(delta) < minDelta) {
      metricsSuppressed += 1;
      continue;
    }
    metrics[name] = { before: bv, after: av, delta };
  }

  const changed =
    keysAppeared.length > 0 || keysResolved.length > 0 || Object.keys(metrics).length > 0;
  return {
    // A suppressed metric must not read as "nothing happened": the status names the threshold's
    // involvement so a reader cannot mistake a hidden change for no change.
    status: digestStatus(changed, metricsSuppressed),
    metrics: Object.freeze(metrics),
    metricsSuppressed,
    keysAppeared,
    keysResolved,
  };
}

/**
 * Walks the UNION of configured jobs and jobs with a live brief in the window (spec § 5.1) — not
 * either half alone: config-only drops overnight work when a job block is deleted in the morning,
 * briefs-only drops the "configured but never ran" fact. Sorts every outcome into a job digest or
 * one of four `notCompared` populations; never drops a job silently.
 */
export function buildFleetDigest(deps: {
  store: FleetStore;
  jobs: readonly NimbusFleetJobToml[];
  windowMs: number;
  now: number;
}): FleetDigestResult {
  const windowStartMs = deps.now - deps.windowMs;
  const configured = new Map(deps.jobs.map((j) => [j.name, j]));
  const ids = [
    ...new Set([
      ...configured.keys(),
      ...deps.store.jobIdsWithBriefsInWindow({ windowStartMs, now: deps.now }),
    ]),
  ].sort(codeUnitCompare);

  const jobs: FleetJobDigest[] = [];
  // Derived from `FleetDigestNotCompared` rather than restated inline — that type is the single
  // definition of these shapes; structural checking at the return statement below catches drift
  // either way, but there is no reason to keep a second copy of it here.
  const firstObservation: FleetDigestNotCompared["firstObservation"][number][] = [];
  const notSummarizable: FleetDigestNotCompared["notSummarizable"][number][] = [];
  const noBriefInWindow: FleetDigestNotCompared["noBriefInWindow"][number][] = [];
  const agentChanged: FleetDigestNotCompared["agentChanged"][number][] = [];

  for (const jobId of ids) {
    const cfg = configured.get(jobId);
    const { current, predecessor } = deps.store.briefPairForJob({
      jobId,
      windowStartMs,
      now: deps.now,
    });
    const configuredHere = cfg !== undefined;
    if (current === undefined) {
      // Configured but no brief landed in the window at all — reported with the CONFIGURED agent
      // name, since there is no brief to read one from.
      noBriefInWindow.push({ jobId, agent: cfg?.agent ?? "unknown", configured: configuredHere });
      continue;
    }
    if (predecessor === undefined) {
      // One brief only: reporting it as "all new" would fabricate a change against a baseline
      // that never existed (spec § 5).
      firstObservation.push({
        jobId,
        briefId: current.id,
        createdAt: current.createdAt,
        configured: configuredHere,
      });
      continue;
    }
    if (current.agentMethod !== predecessor.agentMethod) {
      // Same job name, different agent — the owner repointed it. Both briefs are readable, but
      // their metric namespaces are disjoint, so comparing them would report EVERY metric as
      // one-sided and every key as churn: a wall of movement describing a config edit, not the
      // index. Refused with its own disclosure rather than diffed (spec § 5).
      //
      // Deliberately takes precedence over summarizability: this fires BEFORE either brief is
      // even passed to `summarizeBrief`, so a `current` brief that is both under the new agent
      // AND independently corrupt is absorbed into this disclosure with no separate
      // "also unreadable" signal. That is still correct — the comparison is impossible either
      // way, and "the agent changed" is the more actionable fact for a reader than "also, the
      // new brief doesn't parse".
      agentChanged.push({
        jobId,
        from: predecessor.agentMethod,
        to: current.agentMethod,
        configured: configuredHere,
      });
      continue;
    }
    const after = summarizeBrief(current.agentMethod, current.findingsJson);
    const before = summarizeBrief(predecessor.agentMethod, predecessor.findingsJson);
    if (after === undefined || before === undefined) {
      // Both sides are checked, and both reported when both fail: a reader responds differently
      // to a broken NEW brief than to a broken OLD one, so the role is part of the disclosure.
      if (after === undefined) {
        notSummarizable.push({
          jobId,
          briefId: current.id,
          role: "current",
          reason: `unreadable ${current.agentMethod} brief`,
          configured: configuredHere,
        });
      }
      if (before === undefined) {
        notSummarizable.push({
          jobId,
          briefId: predecessor.id,
          role: "predecessor",
          reason: `unreadable ${predecessor.agentMethod} brief`,
          configured: configuredHere,
        });
      }
      continue;
    }
    const minDelta = cfg?.digestMinDelta ?? 1;
    jobs.push({
      jobId,
      agentMethod: current.agentMethod,
      configured: cfg !== undefined,
      minDelta,
      currentBriefId: current.id,
      currentCreatedAt: current.createdAt,
      predecessorBriefId: predecessor.id,
      predecessorCreatedAt: predecessor.createdAt,
      // The PAIR's span, not the window — those differ per job (spec § 2.1).
      comparisonSpanMs: current.createdAt - predecessor.createdAt,
      ...compareSummaries(before, after, minDelta),
    });
  }

  const result = {
    windowMs: deps.windowMs,
    generatedAt: deps.now,
    jobs,
    notCompared: { firstObservation, notSummarizable, noBriefInWindow, agentChanged },
  };
  // One computation, two shapes. Rendering from `result` rather than from the locals is what makes
  // it impossible for `--json` and the printed digest to disagree about what moved.
  return { ...result, markdown: renderFleetDigest(result) };
}

/**
 * Hours up to two days, days beyond. The 24h boundary belongs on the HOURS side: the default
 * window is exactly 24h and "the last 1.0d" is a worse way to say "the last 24h". Whole values
 * drop the decimal, so a weekly job reads "7d" rather than "7.0d".
 */
function humanDuration(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${String(Math.round(ms / 60_000))}m`;
  if (h < 48) return Number.isInteger(h) ? `${String(h)}h` : `${h.toFixed(1)}h`;
  const d = h / 24;
  return Number.isInteger(d) ? `${String(d)}d` : `${d.toFixed(1)}d`;
}

function cell(v: number | null): string {
  return v === null ? "—" : String(v);
}

/**
 * The `[unconfigured]` marker (spec § 5.1), shared by every job section AND all four
 * `notCompared` populations — a job removed from config can land in any of them, and the marker
 * is what stops a reader inferring it will run again tonight.
 */
function unconfiguredMarker(configured: boolean): string {
  return configured ? "" : " [unconfigured]";
}

/**
 * Neutralise Markdown structure in a value that came from config or from indexed content.
 *
 * Finding keys embed titles from real items (`conflicts` keys on `…:title`), so a pipe breaks the
 * table row it lands in and a newline forges a heading or a bullet outright — a digest claiming a
 * section it does not have. Reachable by an ordinary PR title, not just by an attacker.
 *
 * Deliberately minimal: collapse the line breaks that let a value escape its row, and escape the
 * pipe that lets it escape its CELL. Not a general Markdown sanitiser — emphasis or a stray
 * backtick renders oddly at worst and cannot forge structure.
 */
function mdSafe(s: string): string {
  // BACKSLASH FIRST, then pipe — the order is the whole correctness of this function. Escaping the
  // pipe alone turns an input of `a\|b` into `a\\|b`, where Markdown reads `\\` as one literal
  // backslash and the pipe after it is LIVE, so the row breaks anyway. Escaping the escape
  // character first makes that input `a\\\|b`: a literal backslash, then an escaped pipe.
  //
  // CodeQL flagged this as "incomplete string escaping or encoding" and was right — the earlier
  // fix here escaped the delimiter but not the mechanism that escapes it, which is the classic
  // shape of this defect rather than an exotic edge case.
  //
  // STATED BOUND, and the condition that would change it. This handles STRUCTURAL forgery only —
  // a value escaping its row, its cell, or its bullet. It deliberately does NOT escape link
  // syntax, raw HTML, backticks or emphasis, because the digest's only two sinks are a terminal
  // (`sink.out`, plain text) and `--json`. In a terminal none of those render, so escaping them
  // buys nothing and costs real legibility: an ordinary PR title like `Fix [NIM-123] parser`
  // would print as `Fix \[NIM-123\] parser` for every reader, to guard a renderer that does not
  // exist.
  //
  // Revisit the moment the digest gains a sink that RENDERS Markdown — the ChatOps digest § 7 of
  // the design spec puts out of scope is the likely one. Finding keys embed titles from indexed
  // content, so `[click](http://…)` in a PR title becomes a live link the moment something
  // renders it, and that is the point at which this function needs the wider escape set.
  // Order is load-bearing. Backslash FIRST: escaping the pipe first would put a backslash into
  // the string that the backslash pass would then double, turning `\|` into `\\|` — an escaped
  // backslash followed by a LIVE pipe, which is the cell break this function exists to prevent.
  //
  // NOSONAR S7780/S7781 below: the two rules have NO common solution for this value. S7780 asks
  // for `String.raw`, which cannot express a LONE backslash at all — the backslash escapes the
  // closing backtick, so a one-character raw template does not parse. Rewriting the needle as the
  // regex `/\\/g` clears S7780 and immediately trips S7781 ("this pattern can be replaced with
  // a string"), which is how this landed here in the first place. The escaped string form below
  // is the readable one, and it is pinned by the `a BACKSLASH before a pipe does not smuggle a
  // live delimiter through the escape` test — behaviour is verified, not assumed.
  return s
    .replaceAll(/\r\n|\r|\n/g, " ")
    .replaceAll("\\", "\\\\") // NOSONAR S7780
    .replaceAll("|", "\\|"); // NOSONAR S7780
}

function metricRow(name: string, d: FleetMetricDelta): string {
  // A one-sided metric names WHY it is one-sided rather than showing a delta it does not have.
  const note = oneSidedNote(d);
  return `| ${mdSafe(name)}${note} | ${cell(d.before)} | ${cell(d.after)} | ${cell(d.delta)} |`;
}

/**
 * Renders a `FleetDigestResult` (markdown field aside — it is the argument to this function, not
 * an input to it) as plain Markdown: no ANSI colour, since both `nimbus fleet` printing to a
 * terminal (Task 11) and a future IPC/HTTP consumer read the same string.
 */
export function renderFleetDigest(d: Omit<FleetDigestResult, "markdown">): string {
  const out: string[] = ["# Fleet digest", ""];
  // The preamble qualifies EVERY count below it, so it sits above all of them rather than beside
  // one — the placement I31 requires of `negotiate`'s window clause, for the same reason.
  out.push(
    `Window: the last ${humanDuration(d.windowMs)}. Each job is compared against its own previous brief, ` +
      `which may be older than the window above; the comparison span is given per job.`,
    "",
  );

  for (const j of d.jobs) out.push(...jobSection(j));
  out.push(...notComparedSection(d.notCompared));

  return out.join("\n");
}

/** `Appeared (n):` / `Resolved (n):` and their bullets — omitted entirely when the list is empty. */
function keyChurnLines(label: string, keys: readonly string[]): string[] {
  if (keys.length === 0) return [];
  return [`${label} (${String(keys.length)}):`, ...keys.map((k) => `- ${mdSafe(k)}`), ""];
}

/** One job's `## <id>` section: header line, withheld-metric disclosure, table, key churn. */
function jobSection(j: FleetJobDigest): string[] {
  const status =
    j.status === "unchanged_within_threshold"
      ? `unchanged within threshold (digest_min_delta = ${String(j.minDelta)})`
      : j.status;
  const out: string[] = [
    `## ${mdSafe(j.jobId)}${unconfiguredMarker(j.configured)}`,
    "",
    `${mdSafe(j.agentMethod)} · compared over ${humanDuration(j.comparisonSpanMs)} · ${status}`,
    "",
  ];
  if (j.metricsSuppressed > 0) {
    // Distinct from `status`: a job reported "changed" can STILL have withheld a metric below
    // the threshold, and that must not vanish just because something else cleared the bar
    // (spec § 6). Reads alongside `unchanged_within_threshold` too, without repeating it — that
    // status names the threshold's involvement in general; this line names how many metrics and
    // the same threshold value, which the status text alone does not disclose.
    const n = j.metricsSuppressed;
    out.push(
      `${String(n)} metric${n === 1 ? "" : "s"} withheld below digest_min_delta = ${String(j.minDelta)}`,
      "",
    );
  }

  if (Object.keys(j.metrics).length > 0) {
    out.push("| metric | before | after | delta |", "| --- | --- | --- | --- |");
    // `Object.entries`, not `names[i]`: indexing a Record under noUncheckedIndexedAccess yields
    // `FleetMetricDelta | undefined` and would need a cast that hides a real absence. Sorted
    // explicitly rather than trusted from insertion order: `compareSummaries` inserts in
    // `codeUnitCompare` order today, but JS objects hoist integer-like string keys ahead of
    // insertion order, so a metric literally named `"5"` would silently defeat that guarantee.
    const entries = Object.entries(j.metrics).sort((a, b) => codeUnitCompare(a[0], b[0]));
    for (const [n, delta] of entries) out.push(metricRow(n, delta));
    out.push("");
  }
  out.push(
    ...keyChurnLines("Appeared", j.keysAppeared),
    ...keyChurnLines("Resolved", j.keysResolved),
  );
  return out;
}

/**
 * All four subsections are ALWAYS written, including as an explicit zero: a section that vanishes
 * when it has nothing to say trains a reader to stop looking for it.
 */
function notComparedSection(nc: FleetDigestNotCompared): string[] {
  return [
    "## Not compared",
    "",
    `First observation: ${String(nc.firstObservation.length)}`,
    ...nc.firstObservation.map(
      (e) =>
        `- ${mdSafe(e.jobId)}${unconfiguredMarker(e.configured)} — one brief so far, nothing to compare`,
    ),
    `Not summarizable: ${String(nc.notSummarizable.length)}`,
    ...nc.notSummarizable.map(
      (e) =>
        `- ${mdSafe(e.jobId)}${unconfiguredMarker(e.configured)} (${e.role}) — ${mdSafe(e.reason)}`,
    ),
    `No brief in window: ${String(nc.noBriefInWindow.length)}`,
    ...nc.noBriefInWindow.map(
      (e) =>
        `- ${mdSafe(e.jobId)}${unconfiguredMarker(e.configured)} (${mdSafe(e.agent)}) — configured, produced nothing`,
    ),
    `Agent changed: ${String(nc.agentChanged.length)}`,
    ...nc.agentChanged.map(
      (e) =>
        `- ${mdSafe(e.jobId)}${unconfiguredMarker(e.configured)} — ${mdSafe(e.from)} → ${mdSafe(e.to)}, not comparable`,
    ),
    "",
  ];
}
