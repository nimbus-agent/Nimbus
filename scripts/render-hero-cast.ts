import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CAST_INPUT = "docs/demos/incident-response.cast";
const LIGHT_OUT = "docs/assets/hero-cast-light.svg";
const DARK_OUT = "docs/assets/hero-cast-dark.svg";

const SCHEDULE_SECONDS: ReadonlyArray<number> = [
  0.5, //  0: "## Investigation\n\n…rose from 120ms to 380ms…" (the big block)
  7.0, //  1: "Drafting incident summary for #ops..."
  12.0, // 2: "[consent.request] Post to Slack #ops requires consent"
  17.0, // 3: "Posted to #ops."
];
const TRAILING_PAD_SECONDS = 4;
interface AsciinemaHeader {
  readonly version: 2;
  readonly width: number;
  readonly height: number;
  readonly timestamp: number;
  readonly env?: Record<string, string>;
}

type AsciinemaEvent = readonly [number, "o" | "i", string];

function parseCast(path: string): { header: AsciinemaHeader; events: AsciinemaEvent[] } {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l: string) => l.length > 0);
  if (lines.length === 0) throw new Error(`${path}: empty cast`);
  const header = JSON.parse(lines[0] ?? "") as AsciinemaHeader;
  if (header.version !== 2) throw new Error(`${path}: only asciinema v2 supported`);
  const events: AsciinemaEvent[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    events.push(JSON.parse(line) as AsciinemaEvent);
  }
  return { header, events };
}

function stretchCast(input: { header: AsciinemaHeader; events: AsciinemaEvent[] }): string {
  if (input.events.length !== SCHEDULE_SECONDS.length) {
    throw new Error(
      `Cast has ${input.events.length} events but SCHEDULE_SECONDS has ${SCHEDULE_SECONDS.length} entries — update the schedule when adding/removing cast events.`,
    );
  }
  const headerLine = JSON.stringify(input.header);
  const eventLines = input.events.map((event, idx) => {
    const tSeconds = SCHEDULE_SECONDS[idx] ?? 0;
    return JSON.stringify([tSeconds, event[1], event[2]]);
  });
  const lastT = SCHEDULE_SECONDS[SCHEDULE_SECONDS.length - 1] ?? 0;
  eventLines.push(JSON.stringify([lastT + TRAILING_PAD_SECONDS, "o", ""]));
  return `${[headerLine, ...eventLines].join("\n")}\n`;
}

function render(stretchedCastPath: string, outputPath: string, bg: string, fg: string): void {
  execFileSync(
    "termsvg",
    [
      "export",
      "--output",
      outputPath,
      "--background-color",
      bg,
      "--text-color",
      fg,
      stretchedCastPath,
    ],
    { stdio: "inherit" },
  );
}

function main(): void {
  const cast = parseCast(CAST_INPUT);
  const stretched = stretchCast(cast);

  const workDir = mkdtempSync(join(tmpdir(), "nimbus-hero-cast-"));
  const stretchedPath = join(workDir, "incident-response.stretched.cast");
  writeFileSync(stretchedPath, stretched, "utf8");
  try {
    render(stretchedPath, LIGHT_OUT, "#fdf6e3", "#586e75");
    render(stretchedPath, DARK_OUT, "#002b36", "#93a1a1");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log(`Rendered ${LIGHT_OUT} and ${DARK_OUT} from ${CAST_INPUT} with stretched schedule.`);
}

main();
