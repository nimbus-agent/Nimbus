#!/usr/bin/env bun
/**
 * Regenerates `docs/perf/slo.md` from
 * `packages/gateway/src/perf/slo-thresholds.ts`. Run after editing
 * thresholds; CI runs `--check` to fail the build on drift.
 *
 * Layout: a header + caveat, a UX table (rows from spec § 3.2),
 * a workload table (S6/S7/S9/S10 + a single S8 collapsing row),
 * an S8 sub-table enumerating the 12 cells (D-N), and a generated-
 * doc footer. The comparator sees the flat 29-row array regardless;
 * the doc layout is purely presentational.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SLO_THRESHOLDS, type SloThreshold } from "../packages/gateway/src/perf/slo-thresholds.ts";
import { REPO_ROOT } from "./lib/root.ts";

const SLO_PATH = join(REPO_ROOT, "docs", "perf", "slo.md");

interface RowFmt {
  refMax: string;
  ghaMax: string;
  noiseFloor: string;
}

/** Render a number with single-space thousands separators (e.g. 2_000 → "2 000"). */
function fmtThousands(n: number): string {
  // Integer separators; floats and small numbers pass through .toString().
  if (!Number.isInteger(n)) return n.toString();
  if (Math.abs(n) < 1000) return n.toString();
  const sign = n < 0 ? "-" : "";
  const abs = String(Math.abs(n));
  const groups: string[] = [];
  for (let i = abs.length; i > 0; i -= 3) {
    groups.unshift(abs.slice(Math.max(0, i - 3), i));
  }
  return `${sign}${groups.join(" ")}`;
}

function fmtRefMax(t: SloThreshold): string {
  if (t.refMax === undefined) return "n/a (reference only)";
  if (t.metric === "p95_ms" || t.metric === "p50_ms" || t.metric === "first_token_ms")
    return `≤${fmtThousands(t.refMax)} ms`;
  if (t.metric === "throughput_per_sec") return `≥${fmtThousands(t.refMax)} items/sec`;
  if (t.metric === "rss_bytes_p95") return `≤${(t.refMax / (1024 * 1024)).toFixed(0)} MB`;
  if (t.metric === "tokens_per_sec") return `≥${fmtThousands(t.refMax)} tps`;
  return String(t.refMax);
}

function fmtGhaMax(t: SloThreshold): string {
  if (t.ghaMax === "skipped") return "n/a (reference only)";
  if (t.ghaMax === "tbd-c2") return "TBD — Phase 2 reference run (PR-C-2)";
  if (t.metric === "p95_ms" || t.metric === "p50_ms" || t.metric === "first_token_ms")
    return `≤${fmtThousands(t.ghaMax)} ms`;
  if (t.metric === "throughput_per_sec") return `≥${fmtThousands(t.ghaMax)} items/sec`;
  if (t.metric === "rss_bytes_p95") return `≤${(t.ghaMax / (1024 * 1024)).toFixed(0)} MB`;
  if (t.metric === "tokens_per_sec") return `≥${fmtThousands(t.ghaMax)} tps`;
  return String(t.ghaMax);
}

function fmtNoiseFloor(t: SloThreshold): string {
  switch (t.noiseFloorAbsUnit) {
    case "ms":
      return `${t.noiseFloorPct} %, ${fmtThousands(t.noiseFloorAbs)} ms`;
    case "items_per_sec":
      return `${t.noiseFloorPct} %, ${fmtThousands(t.noiseFloorAbs)} items/sec`;
    case "bytes":
      return `${t.noiseFloorPct} %, ${(t.noiseFloorAbs / (1024 * 1024)).toFixed(0)} MB`;
    case "tps":
      return `${t.noiseFloorPct} %, ${t.noiseFloorAbs} tps`;
  }
}

function fmtRow(t: SloThreshold): RowFmt {
  return { refMax: fmtRefMax(t), ghaMax: fmtGhaMax(t), noiseFloor: fmtNoiseFloor(t) };
}

const UX_IDS: ReadonlySet<string> = new Set([
  "S1",
  "S2-a",
  "S2-b",
  "S2-c",
  "S3",
  "S4",
  "S5",
  "S11-a",
  "S11-b",
]);

const WORKLOAD_NON_S8_IDS: readonly string[] = [
  "S6-drive",
  "S6-gmail",
  "S6-github",
  "S7-a",
  "S7-b",
  "S7-c",
  "S9",
  "S10",
];

const HEADER = `# Nimbus SLO Sheet

> **Status:** PR-C-1 — UX surfaces published with concrete thresholds; workload surfaces (S6, S7, S8 cells, S9, S10) are flagged \`TBD (Phase 5)\` and will be filled in once PR-C-2's M1 Air reference run lands.
>
> **Source spec:** Phase 4 perf audit design (B2), §3.

## Reference hardware caveat

These figures are measured on a **2020 M1 MacBook Air, 8 GB / 256 GB**. Performance on x64 / older hardware is measured but **not threshold-gated** for \`v0.1.0\`; see GHA matrix results in the [Performance Benchmarks workflow](https://github.com/asafgolombek/Nimbus/actions/workflows/_perf.yml) artifacts (90-day retention) for that baseline. The reference machine anchors the published SLO to a real-world worst-case "Nimbus runs on your existing laptop" profile; runs on equal-or-better hardware should meet or beat these targets.

## Threshold semantics

For every measurement entry, \`threshold\` is the maximum allowed value for the **specified percentile of a multi-run aggregate** (median-of-medians across 5 runs — see spec §4.5). Almost all UX rows use **p95**; workload rows use the natural metric for their surface (items/sec for throughput, p95 RSS for memory, etc.).

A bench fails when either:
- the measured aggregate exceeds the absolute reference or GHA threshold, **or**
- the run delta vs the most recent \`main\` history entry for the same \`runner\` exceeds the per-surface noise floor (\`max(noise_floor_pct, absolute_noise_floor / previous × 100)\`).
`;

const FOOTER = `
## What this sheet is not

- **Not a regression-tracking document.** The ongoing per-run history lives in workflow artifacts (GHA) and \`docs/perf/history.jsonl\` (reference machine).

---

*This file is generated from \`packages/gateway/src/perf/slo-thresholds.ts\`. Run \`bun scripts/regen-slo.ts\` after changing thresholds. CI runs \`bun scripts/regen-slo.ts --check\` to fail the build on drift.*
`;

const TABLE_HEADER =
  "| Surface | Metric | Reference threshold | GHA threshold | Noise floor (rel %, abs) |";
const TABLE_DIVIDER = "|---|---|---|---|---|";

function uxTable(): string {
  const rows = SLO_THRESHOLDS.filter((t) => UX_IDS.has(t.surfaceId)).map((t) => {
    const f = fmtRow(t);
    return `| ${t.surfaceId} | ${t.metric} | **${f.refMax}** | ${f.ghaMax} | ${f.noiseFloor} |`;
  });
  return ["## UX surfaces", "", TABLE_HEADER, TABLE_DIVIDER, ...rows].join("\n");
}

function workloadTable(): string {
  const rows: string[] = [];
  for (const id of WORKLOAD_NON_S8_IDS) {
    const t = SLO_THRESHOLDS.find((r) => r.surfaceId === id);
    if (t === undefined) continue;
    const f = fmtRow(t);
    rows.push(`| ${id} | ${t.metric} | ${f.refMax} | ${f.ghaMax} | ${f.noiseFloor} |`);
  }
  // Collapsed S8 row
  rows.push(
    `| S8 (12 cells, see § Workload › S8 cells below) | throughput_per_sec | TBD | TBD — Phase 5 reference run (PR-C-2) | 25 %, 5 items/sec |`,
  );
  return ["## Workload surfaces", "", TABLE_HEADER, TABLE_DIVIDER, ...rows].join("\n");
}

const S8_HEADER =
  "| Cell | Metric | Reference threshold | GHA threshold | Noise floor (rel %, abs) |";
const S8_GLOSS =
  "Cell IDs encode the parameters: `S8-l<chars>-b<batch>` where `l` = approximate text length in characters (50, 500, 5000) and `b` = batch size passed to `embedder.embed()` (1, 8, 32, 64). E.g., `S8-l500-b32` measures embedding throughput on 500-char texts in batches of 32.";
const S8_INTRO =
  "12-cell cross-product of `(length × batch)`. Each cell is its own surface ID with its own threshold (set by PR-C-2).";

function s8SubTable(): string {
  const rows = SLO_THRESHOLDS.filter((t) => t.surfaceId.startsWith("S8-")).map((t) => {
    const f = fmtRow(t);
    return `| ${t.surfaceId} | ${t.metric} | ${f.refMax} | ${f.ghaMax} | ${f.noiseFloor} |`;
  });
  return ["### S8 cells", "", S8_INTRO, "", S8_GLOSS, "", S8_HEADER, TABLE_DIVIDER, ...rows].join(
    "\n",
  );
}

export function renderSloMarkdown(): string {
  return [HEADER, uxTable(), "", workloadTable(), "", s8SubTable(), FOOTER].join("\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const generated = renderSloMarkdown();
  if (check) {
    let onDisk: string;
    try {
      onDisk = readFileSync(SLO_PATH, "utf8");
    } catch {
      process.stderr.write(
        `regen-slo: ${SLO_PATH} does not exist; run \`bun scripts/regen-slo.ts\` (without --check) first.\n`,
      );
      return 1;
    }
    if (onDisk !== generated) {
      process.stderr.write(
        `regen-slo: ${SLO_PATH} is out of date. Run \`bun scripts/regen-slo.ts\` to regenerate.\n`,
      );
      return 1;
    }
    return 0;
  }
  writeFileSync(SLO_PATH, generated, "utf8");
  process.stdout.write(`regen-slo: wrote ${SLO_PATH}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
