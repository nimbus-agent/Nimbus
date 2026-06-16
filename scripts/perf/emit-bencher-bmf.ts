#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

import { toBencherBmf } from "../../packages/gateway/src/perf/bencher-bmf.ts";
import { parseLastHistoryLine } from "./history-jsonl.ts";

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

export async function runEmitBencherBmfMain(args: string[]): Promise<number> {
  const inPath = takeFlag(args, "--in");
  const outPath = takeFlag(args, "--out");
  if (inPath === undefined || outPath === undefined) {
    process.stderr.write(
      "usage: emit-bencher-bmf.ts --in <run-history.jsonl> --out <bencher.json>\n",
    );
    return 2;
  }
  try {
    const text = await Bun.file(inPath).text();
    const line = parseLastHistoryLine(text);
    const report = toBencherBmf(line);
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const count = Object.keys(report).length;
    process.stdout.write(`wrote ${count} trend surface(s) to ${outPath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runEmitBencherBmfMain(process.argv.slice(2));
}
