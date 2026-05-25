import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export type TomlKeySource = "file" | "env";

export type TomlKeyEntry = {
  readonly key: string;
  readonly value: string;
  readonly source: TomlKeySource;
  readonly envVar?: string;
};

/** Known env overrides for `nimbus config list`. */
const ENV_BY_DOTTED: Readonly<Record<string, string>> = {
  "telemetry.enabled": "NIMBUS_TELEMETRY_ENABLED",
  "telemetry.endpoint": "NIMBUS_TELEMETRY_ENDPOINT",
  "telemetry.flush_interval_seconds": "NIMBUS_TELEMETRY_FLUSH_SECONDS",
  "llm.remote_model": "NIMBUS_AGENT_MODEL",
  "llm.classifier_model": "NIMBUS_CLASSIFIER_MODEL",
};

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  if (hash < 0) {
    return line;
  }
  return line.slice(0, hash);
}

function parseSectionKey(source: string, section: string, key: string): string | undefined {
  const lines = source.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = trimmed === `[${section}]`;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const k = trimmed.slice(0, eq).trim();
    if (k !== key) {
      continue;
    }
    return trimmed.slice(eq + 1).trim();
  }
  return undefined;
}

function writeUtf8FileAtomicReplace(path: string, content: string): void {
  // SECURITY: the tmp file is created via `openSync(tmp, "wx")` which
  // passes O_EXCL — the call fails with EEXIST rather than following a
  // pre-existing symlink. Combined with the randomUUID suffix, the
  // probability of collision is negligible; on the off chance EEXIST
  // does fire (or an attacker pre-creates a same-name symlink), retry
  // with a fresh UUID up to 8 times.
  //
  // Note: this `tmp` path is in the destination file's own directory
  // (`${path}.<uuid>.tmp`), NOT `os.tmpdir()`. Same-volume rename
  // guarantees atomic replace. CodeQL's js/file-system-race rule
  // heuristically flags any `.tmp`-suffixed filename as an OS-temp-dir
  // candidate; the `lgtm` comment below is a documented exception that
  // matches the same pattern used in updater.ts:321-322.
  let tmp = "";
  let attempts = 0;
  for (;;) {
    tmp = `${path}.${randomUUID()}.tmp`;
    try {
      // openSync with "wx" is the canonical O_EXCL form CodeQL recognises.
      const fd = openSync(tmp, "wx"); // lgtm[js/file-system-race]
      try {
        writeFileSync(fd, content, "utf8"); // lgtm[js/file-system-race]
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e: unknown) {
      if (
        e !== null &&
        typeof e === "object" &&
        "code" in e &&
        (e as { code: unknown }).code === "EEXIST" &&
        attempts < 8
      ) {
        attempts += 1;
        continue;
      }
      throw e;
    }
  }
  try {
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    renameSync(tmp, path);
  }
}

export function getTomlValueFromFile(tomlPath: string, dotted: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(tomlPath, "utf8");
  } catch (e: unknown) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw e;
  }
  const dot = dotted.indexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  const section = dotted.slice(0, dot);
  const key = dotted.slice(dot + 1);
  return parseSectionKey(raw, section, key);
}

function findSectionHeaderLine(lines: readonly string[], header: string): number {
  for (let i = 0; i < lines.length; i++) {
    const t = stripComment(lines[i] ?? "").trim();
    if (t === header) {
      return i;
    }
  }
  return -1;
}

function findSectionEndLine(
  lines: readonly string[],
  sectionStart: number,
  header: string,
): number {
  for (let j = sectionStart + 1; j < lines.length; j++) {
    const t = stripComment(lines[j] ?? "").trim();
    if (t.startsWith("[") && t.endsWith("]") && t !== header) {
      return j;
    }
  }
  return lines.length;
}

function tryReplaceKeyInSection(
  lines: readonly string[],
  sectionStart: number,
  sectionEnd: number,
  key: string,
  formattedValue: string,
): { lines: string[]; replaced: boolean } {
  const newLines = [...lines];
  for (let j = sectionStart + 1; j < sectionEnd; j++) {
    const rawLine = lines[j] ?? "";
    const t = stripComment(rawLine).trim();
    const eq = t.indexOf("=");
    if (eq > 0 && t.slice(0, eq).trim() === key) {
      newLines[j] = `${key} = ${formattedValue}`;
      return { lines: newLines, replaced: true };
    }
  }
  return { lines: newLines, replaced: false };
}

function writeNewSectionToToml(
  tomlPath: string,
  full: string,
  header: string,
  key: string,
  formattedValue: string,
): void {
  const sep = full.trim() === "" ? "" : "\n\n";
  writeUtf8FileAtomicReplace(
    tomlPath,
    `${full.trimEnd()}${sep}${header}\n${key} = ${formattedValue}\n`,
  );
}

export function setTomlValueInFile(tomlPath: string, dotted: string, value: string): void {
  const dot = dotted.indexOf(".");
  if (dot <= 0) {
    throw new Error(`Invalid key (expected section.name): ${dotted}`);
  }
  const section = dotted.slice(0, dot);
  const key = dotted.slice(dot + 1);
  const formattedValue = formatTomlValue(value);
  let full = "";
  try {
    full = readFileSync(tomlPath, "utf8");
  } catch (e: unknown) {
    if (
      !(
        e !== null &&
        typeof e === "object" &&
        "code" in e &&
        (e as { code: unknown }).code === "ENOENT"
      )
    ) {
      throw e;
    }
  }
  const lines = full.split(/\r?\n/);
  const header = `[${section}]`;
  const sectionStart = findSectionHeaderLine(lines, header);
  if (sectionStart < 0) {
    writeNewSectionToToml(tomlPath, full, header, key, formattedValue);
    return;
  }
  const sectionEnd = findSectionEndLine(lines, sectionStart, header);
  const { lines: newLines, replaced } = tryReplaceKeyInSection(
    lines,
    sectionStart,
    sectionEnd,
    key,
    formattedValue,
  );
  if (!replaced) {
    newLines.splice(sectionEnd, 0, `${key} = ${formattedValue}`);
  }
  const body = newLines.join("\n").trimEnd();
  writeUtf8FileAtomicReplace(tomlPath, `${body}\n`);
}

function formatTomlValue(value: string): string {
  const t = value.trim();
  if (t === "true" || t === "false") {
    return t;
  }
  if (/^-?\d+$/.test(t)) {
    return t;
  }
  const esc = t.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
  return `"${esc}"`;
}

export function listTomlKeysWithEnv(tomlPath: string): TomlKeyEntry[] {
  const out: TomlKeyEntry[] = [];
  for (const [dotted, envVar] of Object.entries(ENV_BY_DOTTED)) {
    const fromEnv = process.env[envVar]?.trim();
    if (fromEnv !== undefined && fromEnv !== "") {
      out.push({ key: dotted, value: fromEnv, source: "env", envVar });
      continue;
    }
    const fromFile = getTomlValueFromFile(tomlPath, dotted);
    if (fromFile !== undefined) {
      out.push({ key: dotted, value: fromFile, source: "file" });
    }
  }
  return out;
}
