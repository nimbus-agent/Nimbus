#!/usr/bin/env bun
// Drift detector for the exclusion registry.
//
// Reads sonar-project.properties' sonar.coverage.exclusions and verifies
// that every pattern there is "covered" by an entry in
// scripts/coverage-floor/exclusions.ts. The reverse direction (a local
// exemption with no sonar counterpart) is permitted — sonar's gate is
// looser than ours; the floor adds discipline sonar wouldn't.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isExempt } from "./exclusions.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function patternToSampleRelPaths(pattern: string): string[] {
  // Convert a glob-ish sonar exclusion to a couple of representative
  // repo-relative path samples. We just check that isExempt() returns true
  // for those samples — i.e. the local registry covers the same territory.
  //
  // We don't synthesize a full glob expander; instead, we pick canonical
  // samples for each pattern shape the project actually uses.
  const samples: string[] = [];
  // `**/index/*-v[0-9]*-sql.ts` → sample under packages/gateway/src/
  if (pattern === "**/index/*-v[0-9]*-sql.ts") {
    samples.push("packages/gateway/src/index/vec-items-1536-v30-sql.ts");
    samples.push("packages/gateway/src/index/audit-session-v24-sql.ts");
    return samples;
  }
  if (pattern === "**/perf/fixtures/synthetic-*-trace.ts") {
    samples.push("packages/gateway/src/perf/fixtures/synthetic-drive-trace.ts");
    return samples;
  }
  if (pattern === "**/perf/surfaces/**") {
    samples.push("packages/gateway/src/perf/surfaces/bench-query-latency.ts");
    return samples;
  }
  if (pattern === "packages/gateway/src/perf/**") {
    samples.push("packages/gateway/src/perf/bench-cli.ts");
    return samples;
  }
  if (pattern === "packages/gateway/src-native/**") {
    samples.push("packages/gateway/src-native/sandbox-helper/main.c");
    return samples;
  }
  if (pattern === "**/packages/mcp-connectors/*/src/server.ts") {
    samples.push("packages/mcp-connectors/snyk/src/server.ts");
    samples.push("packages/mcp-connectors/sonarqube/src/server.ts");
    return samples;
  }
  // Direct paths: treat the pattern itself as the sample.
  samples.push(pattern);
  return samples;
}

export function findParityGaps(sonarPatterns: readonly string[]): string[] {
  const gaps: string[] = [];
  for (const pattern of sonarPatterns) {
    const samples = patternToSampleRelPaths(pattern);
    const anyCovered = samples.some((s) => isExempt(s));
    if (!anyCovered) gaps.push(pattern);
  }
  return gaps;
}

// Minimal .properties extractor. Tolerates optional whitespace around the
// `=` and a leading `!`/`#`-prefixed comment line, but does NOT implement
// the full Java .properties spec (no multi-line `\` continuation, no
// unicode escapes). sonar-project.properties is project-controlled and
// single-line for sonar.coverage.exclusions; if a future edit introduces
// a continuation, this script fails CLOSED (reports the patterns it can
// see as a gap) and the maintainer fixes the parser in the same PR.
function readSonarCoverageExclusions(): string[] {
  const propsPath = resolve(REPO_ROOT, "sonar-project.properties");
  if (!existsSync(propsPath)) return [];
  const text = readFileSync(propsPath, "utf8");
  const re = /^\s*sonar\.coverage\.exclusions\s*=\s*(.*?)\s*$/;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.startsWith("#") || rawLine.startsWith("!")) continue;
    const m = re.exec(rawLine);
    if (m === null) continue;
    const value = m[1] ?? "";
    return value
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }
  return [];
}

async function main(): Promise<void> {
  const sonarPatterns = readSonarCoverageExclusions();
  if (sonarPatterns.length === 0) {
    console.log("check-exclusion-parity: sonar.coverage.exclusions is empty (no parity work)");
    process.exit(0);
  }
  const gaps = findParityGaps(sonarPatterns);
  if (gaps.length === 0) {
    console.log(`check-exclusion-parity: ok (${sonarPatterns.length} sonar patterns all covered)`);
    process.exit(0);
  }
  for (const g of gaps) {
    console.error(
      `::error file=sonar-project.properties::sonar.coverage.exclusions pattern '${g}' has no local exemption in scripts/coverage-floor/exclusions.ts`,
    );
  }
  console.error(
    `check-exclusion-parity: FAILED (${gaps.length} drift gap${gaps.length === 1 ? "" : "s"})`,
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
