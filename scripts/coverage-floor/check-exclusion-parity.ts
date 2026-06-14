#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isExempt } from "./exclusions.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function patternToSampleRelPaths(pattern: string): string[] {
  const samples: string[] = [];
  if (pattern === "**/index/*-v[0-9]*-sql.ts") {
    samples.push(
      "packages/gateway/src/index/vec-items-1536-v30-sql.ts",
      "packages/gateway/src/index/audit-session-v24-sql.ts",
    );
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
    samples.push(
      "packages/mcp-connectors/snyk/src/server.ts",
      "packages/mcp-connectors/sonarqube/src/server.ts",
    );
    return samples;
  }
  if (pattern === "**/packages/mcp-connectors/*/src/tools.ts") {
    samples.push(
      "packages/mcp-connectors/bigquery/src/tools.ts",
      "packages/mcp-connectors/athena/src/tools.ts",
    );
    return samples;
  }
  samples.push(pattern);
  return samples;
}

export function findParityGaps(sonarPatterns: readonly string[]): string[] {
  const gaps: string[] = [];
  for (const pattern of sonarPatterns) {
    const samples = patternToSampleRelPaths(pattern);
    // `/testing/` paths are exempt structurally via discoverSourceFiles (check.ts), not via isExempt.
    const anyCovered = samples.some((s) => isExempt(s) || s.includes("/testing/"));
    if (!anyCovered) gaps.push(pattern);
  }
  return gaps;
}

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
