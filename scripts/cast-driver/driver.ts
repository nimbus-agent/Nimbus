import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type CastChunk, writeCastBytes } from "./cast-writer.ts";
import type { EventsScript } from "./fake-gateway.ts";
import type { HarnessOpts, HarnessRun } from "./harness.ts";
import { applyNormalization } from "./normalize.ts";
import { atomicWriteFile, sha256Hex, unifiedDiff } from "./snapshot.ts";
import { parseCastScript } from "./yaml-script.ts";

export type DriverMode = "check" | "update";

export interface DriverOpts {
  readonly mode: DriverMode;
  readonly scriptPaths: ReadonlyArray<string>;
  readonly demosRoot: string;
  readonly fixturesRoot: string;
  readonly artifactsDir: string | undefined;
  readonly harness: (opts: HarnessOpts) => Promise<HarnessRun>;
}

export interface ScriptSummary {
  readonly name: string;
  readonly action: "matched" | "written" | "mismatch";
  readonly hash: string;
}

export interface DriverResult {
  readonly summaries: ReadonlyArray<ScriptSummary>;
  readonly exitCode: number;
}

const CLI_ENTRY_REL = "packages/cli/src/index.ts";

function loadEvents(fixturesRoot: string, eventsRel: string): EventsScript {
  const path = join(fixturesRoot, eventsRel);
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null)
    throw new Error(`events.json: not an object: ${path}`);
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r["steps"])) throw new Error(`events.json: "steps" must be an array: ${path}`);
  return raw as EventsScript;
}

export async function runDriver(opts: DriverOpts): Promise<DriverResult> {
  const summaries: ScriptSummary[] = [];
  let exitCode = 0;

  for (const scriptPath of opts.scriptPaths) {
    const yamlText = readFileSync(scriptPath, "utf8");
    const compiled = parseCastScript(yamlText);
    const events = loadEvents(opts.fixturesRoot, compiled.script.events);
    const cliEntry = join(process.cwd(), CLI_ENTRY_REL);

    const run = await opts.harness({ compiled, events, cliEntry });

    const allChunks: CastChunk[] = run.captures.flatMap((c) => c.capture.chunks);
    const allBytes = new TextEncoder().encode(
      run.captures.map((c) => c.capture.chunks.map((k) => k.data).join("")).join(""),
    );
    const transcript = applyNormalization(allBytes, {
      tmpDirPrefix: run.tmpDirPrefix,
      homePrefix: process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
    });
    const hash = await sha256Hex(transcript);

    const name = basename(scriptPath, ".yaml");
    const hashPath = join(opts.demosRoot, "snapshots", `${name}.hash`);
    const txtPath = join(opts.demosRoot, "snapshots", `${name}.txt`);
    const castPath = join(opts.demosRoot, `${name}.cast`);

    if (opts.mode === "update") {
      await atomicWriteFile(hashPath, `${hash}\n`);
      await atomicWriteFile(txtPath, transcript);
      const cast = writeCastBytes(allChunks);
      await atomicWriteFile(castPath, new TextDecoder().decode(cast));
      summaries.push({ name, action: "written", hash });
      continue;
    }

    let baselineHash: string | null = null;
    try {
      baselineHash = readFileSync(hashPath, "utf8").trim();
    } catch {
      baselineHash = null;
    }
    let baselineTxt: string | null = null;
    try {
      baselineTxt = readFileSync(txtPath, "utf8");
    } catch {
      baselineTxt = null;
    }

    if (baselineHash === hash) {
      summaries.push({ name, action: "matched", hash });
      continue;
    }

    summaries.push({ name, action: "mismatch", hash });
    exitCode = 1;

    if (opts.artifactsDir !== undefined) {
      await atomicWriteFile(join(opts.artifactsDir, `${name}.actual.txt`), transcript);
      const diff = unifiedDiff(baselineTxt, transcript, `${name}.txt`, `${name}.actual.txt`);
      await atomicWriteFile(join(opts.artifactsDir, `${name}.diff`), diff);
      const cast = writeCastBytes(allChunks);
      await atomicWriteFile(
        join(opts.artifactsDir, `${name}.cast`),
        new TextDecoder().decode(cast),
      );
    }
  }

  return { summaries, exitCode };
}
