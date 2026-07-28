import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type DriverMode, MAX_DIFF_LINES, runDriver } from "./driver.ts";
import { runHarness } from "./harness.ts";

function parseArgs(argv: ReadonlyArray<string>): {
  mode: DriverMode;
  artifactsDir: string | undefined;
} {
  let mode: DriverMode = "check";
  let artifactsDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") mode = "check";
    else if (a === "--update-snapshots") mode = "update";
    else if (a?.startsWith("--artifacts-dir=")) artifactsDir = a.slice("--artifacts-dir=".length);
    else if (a === "--artifacts-dir") {
      const next = argv[i + 1];
      if (next !== undefined) {
        artifactsDir = next;
        i += 1;
      }
    }
  }
  return { mode, artifactsDir };
}

async function main(): Promise<void> {
  const { mode, artifactsDir } = parseArgs(process.argv.slice(2));
  const scriptsDir = join(process.cwd(), "docs/demos/scripts");
  const scriptPaths = readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => join(scriptsDir, f))
    .sort();

  if (scriptPaths.length === 0) {
    console.error("no scripts found in docs/demos/scripts/");
    process.exit(0);
  }

  const result = await runDriver({
    mode,
    scriptPaths,
    demosRoot: join(process.cwd(), "docs/demos"),
    fixturesRoot: join(process.cwd(), "scripts/cast-driver/fixtures"),
    artifactsDir,
    harness: runHarness,
  });

  for (const summary of result.summaries) {
    if (summary.action === "written") {
      console.log(`${summary.name}: updated (hash=${summary.hash.slice(0, 12)})`);
    } else if (summary.action === "matched") {
      console.log(`${summary.name}: OK (hash=${summary.hash.slice(0, 12)})`);
    } else {
      console.error(`${summary.name}: DRIFT (hash=${summary.hash.slice(0, 12)})`);
      // Print the diff, not just the hash. A hash tells a reader THAT the
      // transcript changed and nothing about WHAT changed, which makes a
      // platform-specific drift undiagnosable by anyone without that platform.
      if (summary.diff === "") {
        // Hash differs while the transcript text matches byte-for-byte: the
        // committed .hash is stale relative to its own .txt, not a content
        // change. Saying so beats printing DRIFT and nothing else.
        console.error(
          `  transcript text is IDENTICAL to the committed .txt — the committed .hash is stale; re-run \`bun run record-casts\``,
        );
      } else if (summary.diff !== undefined) {
        const lines = summary.diff.split("\n");
        const shown = lines.slice(0, MAX_DIFF_LINES).join("\n");
        console.error(shown);
        if (lines.length > MAX_DIFF_LINES) {
          console.error(
            `… ${lines.length - MAX_DIFF_LINES} more diff line(s) — re-run with --artifacts-dir <dir> for the full text`,
          );
        }
      }
    }
  }

  process.exit(result.exitCode);
}

void main();
