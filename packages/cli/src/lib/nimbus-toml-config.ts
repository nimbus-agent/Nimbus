import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type TomlKeySource = "file" | "env";

export type TomlKeyEntry = {
  readonly key: string;
  readonly value: string;
  readonly source: TomlKeySource;
  readonly envVar?: string;
};

const ENV_BY_DOTTED: Readonly<Record<string, string>> = {
  "telemetry.enabled": "NIMBUS_TELEMETRY_ENABLED",
  "telemetry.endpoint": "NIMBUS_TELEMETRY_ENDPOINT",
  "telemetry.flush_interval_seconds": "NIMBUS_TELEMETRY_FLUSH_SECONDS",
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
  const dir = dirname(path);
  // The config directory may not exist yet, and `nimbus config set` is the FIRST command
  // the install guide gives — it is documented before "Start the Gateway", which is what
  // would otherwise have created it. Without this, a brand-new machine gets a raw
  // `ENOENT: ... mkdtemp '<configDir>/.nimbus.toml.swap-XXXXXX'` from the line below,
  // which names a swap file the user never asked for and does not mention the real
  // problem. Recursive + idempotent, so the already-exists path is unchanged.
  mkdirSync(dir, { recursive: true });
  const swap = mkdtempSync(join(dir, `.${basename(path)}.swap-`));
  const tmp = join(swap, "content");
  try {
    writeFileSync(tmp, content, "utf8");
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
  } finally {
    try {
      rmdirSync(swap);
    } catch {
      /* the rename may have left the dir empty (success) or the file
         may still be inside if writeFileSync threw before rename; either
         way we don't want to throw from the cleanup path. */
    }
  }
}

export function getTomlValueFromFile(tomlPath: string, dotted: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(tomlPath, "utf8");
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT") {
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
    if (!(e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT")) {
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
