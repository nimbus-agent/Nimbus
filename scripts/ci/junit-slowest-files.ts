#!/usr/bin/env bun
// scripts/ci/junit-slowest-files.ts — the slowest test FILES in a `bun test` JUnit report, as a
// Markdown table for `$GITHUB_STEP_SUMMARY`.
//
// The windows-2025 PR leg spends ~21 of its ~31 minutes in ONE `bun test` process, and until now
// nothing recorded where inside that run the time went. This turns the JUnit file the run already
// writes into a ranked list, so speeding the leg up can start from data rather than guesses.
//
// Reads only the TOP-LEVEL `<testsuite>` elements — Bun emits one per file and nests one per
// `describe` inside it, so summing every level would count each test two or more times.
//
// Stated bound: a file's `time` is what Bun attributes to that file's tests. Module load and
// top-level code are not guaranteed to be in it, so the column total can be less than the step's
// wall clock; the summary prints both so the gap is visible rather than implied away.
//
// Usage: bun scripts/ci/junit-slowest-files.ts <junit.xml> [--top=N] [--title=<text>]

export interface FileTiming {
  readonly file: string;
  readonly seconds: number;
  readonly tests: number;
}

const ATTR = /([\w:-]+)="([^"]*)"/g;
const TAG = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>/g;

function attrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const [, key, value] = m;
    if (key !== undefined && value !== undefined) out.set(key, value);
  }
  return out;
}

/** Per-file timings from the depth-1 `<testsuite>` elements of a JUnit document. */
export function fileTimings(xml: string): FileTiming[] {
  const out: FileTiming[] = [];
  let depth = 0;
  for (const m of xml.matchAll(TAG)) {
    if (m[0].startsWith("</")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const selfClosing = m[2] === "/";
    if (depth === 0) {
      const a = attrs(m[1] ?? "");
      const file = a.get("file") ?? a.get("name");
      const seconds = Number(a.get("time"));
      if (file !== undefined && Number.isFinite(seconds)) {
        out.push({ file, seconds, tests: Number(a.get("tests") ?? 0) || 0 });
      }
    }
    if (!selfClosing) depth += 1;
  }
  return out;
}

/** Total wall time the root `<testsuites>` element reports, if any. */
export function reportedTotalSeconds(xml: string): number | undefined {
  const root = /<testsuites\b([^>]*)>/.exec(xml);
  if (root === null) return undefined;
  const t = Number(attrs(root[1] ?? "").get("time"));
  return Number.isFinite(t) ? t : undefined;
}

export function renderSummary(
  timings: readonly FileTiming[],
  opts: {
    readonly top: number;
    readonly title: string;
    readonly totalSeconds?: number | undefined;
  },
): string {
  const sorted = [...timings].sort((a, b) => b.seconds - a.seconds);
  const sum = sorted.reduce((acc, t) => acc + t.seconds, 0);
  const shown = sorted.slice(0, opts.top);
  const shownSum = shown.reduce((acc, t) => acc + t.seconds, 0);
  const pct = (s: number): string => (sum > 0 ? `${((100 * s) / sum).toFixed(1)}%` : "—");

  const lines = [`### ${opts.title}`, ""];
  const wall =
    opts.totalSeconds === undefined
      ? ""
      : ` · run total reported by Bun: ${opts.totalSeconds.toFixed(0)} s`;
  lines.push(
    `${sorted.length} files · per-file sum ${sum.toFixed(0)} s${wall} · top ${shown.length} = ${pct(shownSum)} of the sum`,
    "",
    "| # | File | Seconds | Share | Tests |",
    "| ---: | --- | ---: | ---: | ---: |",
  );
  shown.forEach((t, i) => {
    lines.push(
      `| ${i + 1} | \`${t.file}\` | ${t.seconds.toFixed(1)} | ${pct(t.seconds)} | ${t.tests} |`,
    );
  });
  return `${lines.join("\n")}\n`;
}

async function main(argv: readonly string[]): Promise<number> {
  const path = argv.find((a) => !a.startsWith("--"));
  const top = Number(argv.find((a) => a.startsWith("--top="))?.slice("--top=".length) ?? 30);
  const title =
    argv.find((a) => a.startsWith("--title="))?.slice("--title=".length) ?? "Slowest test files";
  if (path === undefined) {
    console.error("usage: junit-slowest-files.ts <junit.xml> [--top=N] [--title=<text>]");
    return 2;
  }
  const file = Bun.file(path);
  if (!(await file.exists())) {
    // A killed or crashed run writes no report. Say so in the summary instead of failing a
    // diagnostics-only step.
    console.log(
      `### ${title}\n\nNo JUnit report at \`${path}\` — the run was killed or crashed before Bun wrote it.\n`,
    );
    return 0;
  }
  const xml = await file.text();
  console.log(
    renderSummary(fileTimings(xml), {
      top: Number.isInteger(top) && top > 0 ? top : 30,
      title,
      totalSeconds: reportedTotalSeconds(xml),
    }),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
