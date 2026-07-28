import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIGHT_OUT = "docs/assets/hero-cast-light.svg";
const DARK_OUT = "docs/assets/hero-cast-dark.svg";

interface Demo {
  readonly cast: string;
  /**
   * Playback times, one per cast event. Only needed for a cast recorded
   * WITHOUT `pacingSeconds` — the cast driver now paces at record time, so a
   * paced cast carries its own schedule and this is omitted.
   */
  readonly schedule?: ReadonlyArray<number>;
}

const DEMOS: Readonly<Record<string, Demo>> = {
  // The hero. Already paced by the driver (pacingSeconds: 3), so its recorded
  // timings are used verbatim.
  "zero-config": { cast: "docs/demos/zero-config.cast" },
  // Legacy: recorded before `pacingSeconds` existed, so every event lands
  // inside a second and needs an explicit schedule to be watchable.
  "incident-response": {
    cast: "docs/demos/incident-response.cast",
    schedule: [
      0.5, //  0: "## Investigation\n\n…rose from 120ms to 380ms…" (the big block)
      7, //  1: "Drafting incident summary for #ops..."
      12, // 2: "[consent.request] Post to Slack #ops requires consent"
      17, // 3: "Posted to #ops."
    ],
  },
};

const DEFAULT_DEMO = "zero-config";
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

function stretchCast(
  input: { header: AsciinemaHeader; events: AsciinemaEvent[] },
  schedule: ReadonlyArray<number> | undefined,
): string {
  if (schedule !== undefined && input.events.length !== schedule.length) {
    throw new Error(
      `Cast has ${input.events.length} events but the schedule has ${schedule.length} entries — update the schedule when adding/removing cast events.`,
    );
  }
  const headerLine = JSON.stringify(input.header);
  const eventLines = input.events.map((event, idx) =>
    // No schedule -> the cast was paced at record time; keep its own timings.
    JSON.stringify([schedule === undefined ? event[0] : (schedule[idx] ?? 0), event[1], event[2]]),
  );
  const lastT = schedule === undefined ? (input.events.at(-1)?.[0] ?? 0) : (schedule.at(-1) ?? 0);
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
  const requested = process.argv[2] ?? DEFAULT_DEMO;
  const demo = DEMOS[requested];
  if (demo === undefined) {
    const known = Object.keys(DEMOS).join(", ");
    throw new Error(`Unknown demo "${requested}". Known demos: ${known}`);
  }

  const cast = parseCast(demo.cast);
  const stretched = stretchCast(cast, demo.schedule);

  const workDir = mkdtempSync(join(tmpdir(), "nimbus-hero-cast-"));
  const stretchedPath = join(workDir, `${requested}.stretched.cast`);
  writeFileSync(stretchedPath, stretched, "utf8");
  try {
    render(stretchedPath, LIGHT_OUT, "#fdf6e3", "#586e75");
    render(stretchedPath, DARK_OUT, "#002b36", "#93a1a1");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log(`Rendered ${LIGHT_OUT} and ${DARK_OUT} from ${demo.cast}.`);
}

main();
