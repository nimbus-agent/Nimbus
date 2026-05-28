import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SUPPORTED_TOKENS = ["YYYY", "YY", "MM", "DD", "HH", "mm"] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatDailyNoteFilename(format: string, date: Date): string {
  const replacements: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()),
    YY: String(date.getUTCFullYear() % 100).padStart(2, "0"),
    MM: pad2(date.getUTCMonth() + 1),
    DD: pad2(date.getUTCDate()),
    HH: pad2(date.getUTCHours()),
    mm: pad2(date.getUTCMinutes()),
  };
  let out = format;
  for (const tok of SUPPORTED_TOKENS) {
    out = out.replaceAll(tok, replacements[tok] ?? "");
  }
  return out;
}

export type DailyNotePath = {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly warning: string | undefined;
};

type DailyNotesConfig = { folder: string; format: string };

const DEFAULT_CONFIG: DailyNotesConfig = { folder: "", format: "YYYY-MM-DD" };

function readDailyNotesConfig(vaultRoot: string): {
  config: DailyNotesConfig;
  warning: string | undefined;
} {
  const path = join(vaultRoot, ".obsidian", "daily-notes.json");
  if (!existsSync(path)) {
    return { config: DEFAULT_CONFIG, warning: undefined };
  }
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { config: DEFAULT_CONFIG, warning: "could not read daily-notes.json" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return { config: DEFAULT_CONFIG, warning: "daily-notes.json is not an object" };
    }
    const obj = parsed as Record<string, unknown>;
    const folderRaw = obj["folder"];
    const formatRaw = obj["format"];
    const folder = typeof folderRaw === "string" ? folderRaw : "";
    const format = typeof formatRaw === "string" && formatRaw !== "" ? formatRaw : "YYYY-MM-DD";
    return { config: { folder, format }, warning: undefined };
  } catch {
    return { config: DEFAULT_CONFIG, warning: "daily-notes.json is malformed JSON" };
  }
}

export function resolveDailyNotePath(vaultRoot: string, date: Date): DailyNotePath {
  const { config, warning } = readDailyNotesConfig(vaultRoot);
  const filename = `${formatDailyNoteFilename(config.format, date)}.md`;
  const rel =
    config.folder === "" ? filename : `${config.folder.replace(/[/\\]+$/, "")}/${filename}`;
  return {
    relativePath: rel,
    absolutePath: join(vaultRoot, rel),
    warning,
  };
}
