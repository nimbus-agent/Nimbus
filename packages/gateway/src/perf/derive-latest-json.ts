import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { HistoryLine } from "./history-line.ts";

export interface DeriveOptions {
  historyPath: string;
  outputPath: string;
}

export class NoQualifyingLineError extends Error {
  constructor(historyPath: string, options?: ErrorOptions) {
    super(`no complete reference-m1air line found in ${historyPath}`, options);
    this.name = "NoQualifyingLineError";
  }
}

function isCompleteReferenceLine(value: unknown): value is HistoryLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["schema_version"] === 2 &&
    v["runner"] === "reference-m1air" &&
    v["incomplete"] !== true &&
    typeof v["run_id"] === "string" &&
    typeof v["timestamp"] === "string" &&
    typeof v["os_version"] === "string" &&
    typeof v["nimbus_git_sha"] === "string" &&
    typeof v["bun_version"] === "string" &&
    typeof v["surfaces"] === "object" &&
    v["surfaces"] !== null
  );
}

export function selectLatestReferenceLine(historyJsonl: string): HistoryLine {
  const lines = historyJsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const raw = line.trim();
    if (raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (isCompleteReferenceLine(parsed)) return parsed;
  }
  throw new Error("no complete reference-m1air line found");
}

export function writeLatestJson(outputPath: string, line: HistoryLine): void {
  const parent = dirname(outputPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const tmp = `${outputPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(line)}\n`, "utf8");
  renameSync(tmp, outputPath);
}

export function deriveLatestJson({ historyPath, outputPath }: DeriveOptions): void {
  if (!existsSync(historyPath)) {
    throw new Error(`history file not found: ${historyPath}`);
  }
  const contents = readFileSync(historyPath, "utf8");
  let line: HistoryLine;
  try {
    line = selectLatestReferenceLine(contents);
  } catch (e) {
    if (e instanceof Error && e.message.includes("no complete reference-m1air")) {
      throw new NoQualifyingLineError(historyPath, { cause: e });
    }
    throw e;
  }
  writeLatestJson(outputPath, line);
}

function parseArgs(argv: string[]): DeriveOptions {
  let historyPath: string | undefined;
  let outputPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--history" || a === "--output") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`flag ${a} requires a value (got ${next ?? "<end of args>"})`);
      }
      if (a === "--history") historyPath = next;
      else outputPath = next;
    }
  }
  if (!historyPath || !outputPath) {
    throw new Error("usage: bun derive-latest-json.ts --history <path> --output <path>");
  }
  return { historyPath, outputPath };
}

if (import.meta.main) {
  try {
    deriveLatestJson(parseArgs(process.argv.slice(2)));
    // biome-ignore lint/suspicious/noConsole: CLI entry point logs to stdout/stderr
    console.log("derive-latest-json: OK");
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: CLI entry point logs to stdout/stderr
    console.error(`derive-latest-json: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
