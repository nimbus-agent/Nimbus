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

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return hash < 0 ? line : line.slice(0, hash);
}

function formatTomlScalar(value: string): string {
  const t = value.trim();
  if (t === "true" || t === "false") return t;
  if (/^-?\d+$/.test(t)) return t;
  const esc = t.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
  return `"${esc}"`;
}

// Atomic (temp file in a fresh mkdtemp'd sibling dir, then rename over the target) so a
// crash mid-write never leaves a truncated nimbus.toml. Mirrors
// `packages/cli/src/lib/nimbus-toml-config.ts`'s `writeUtf8FileAtomicReplace` exactly.
function writeUtf8FileAtomicReplace(path: string, content: string): void {
  const dir = dirname(path);
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
      /* the rename may have left the dir empty (success), or the file may still be inside
         if writeFileSync threw before rename; either way this cleanup must not throw. */
    }
  }
}

function findSectionHeaderLine(lines: readonly string[], header: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (stripComment(lines[i] ?? "").trim() === header) return i;
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
    if (t.startsWith("[") && t.endsWith("]") && t !== header) return j;
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
    const t = stripComment(lines[j] ?? "").trim();
    const eq = t.indexOf("=");
    if (eq > 0 && t.slice(0, eq).trim() === key) {
      newLines[j] = `${key} = ${formattedValue}`;
      return { lines: newLines, replaced: true };
    }
  }
  return { lines: newLines, replaced: false };
}

/**
 * Writes (inserting or replacing) one flat `key = value` line inside `sectionHeader` (e.g.
 * `"[llm.tasks]"`) of the TOML file at `tomlPath`. Creates the section — and the file/its
 * parent dir — if absent. Atomic.
 *
 * DUPLICATES, rather than imports, `packages/cli/src/lib/nimbus-toml-config.ts`'s
 * `setTomlValueInFile`: "gateway imports nothing from cli/ui" (CLAUDE.md dependency rules)
 * is a hard boundary, and `llm.use` (`ipc/llm-rpc.ts`) is a GATEWAY-side write — the
 * gateway is what owns `nimbus.toml` and what knows which routes are registered, so the
 * write has to happen from inside the running gateway process, not the CLI.
 *
 * Also DELIBERATELY NOT THE SAME SHAPE as the CLI helper: that one takes a single
 * `"section.key"` string and splits it on the FIRST dot, which is correct for the
 * single-dot keys it has ever been called with (`telemetry.enabled`, `llm.remote_model`)
 * but cannot address a nested table header like `[llm.tasks]` — splitting
 * `"llm.tasks.classification"` on the first dot yields section `"llm"` / key
 * `"tasks.classification"`, which would write `tasks.classification = "…"` under `[llm]`
 * instead of `classification = "…"` under `[llm.tasks]`, and the gateway's own
 * `parseLlmTaskPins` (`config/nimbus-toml.ts`) — which scans for a literal `[llm.tasks]`
 * header line — would never see it on reparse. Taking the header and key as separate
 * arguments here sidesteps that ambiguity instead of inheriting it.
 *
 * LINE-ENDING PRESERVING: the read side already had to be lenient (`full.split(/\r?\n/)`, since
 * a hand-edited `nimbus.toml` on Windows is plausibly CRLF), but rewriting with a hardcoded `"\n"`
 * join would silently flatten a CRLF file to LF wholesale on its first `nimbus llm use` — the
 * file still parses, but every OTHER line in it (nothing to do with this write) changes on disk,
 * which is a surprising diff for a user to find. The line ending actually present in `full` is
 * detected once and reused for every line this function joins or appends, so a CRLF file stays
 * CRLF and an LF file stays LF; a brand-new file (no `full` read, i.e. ENOENT) defaults to `"\n"`.
 */
export function setNimbusTomlSectionKey(
  tomlPath: string,
  sectionHeader: string,
  key: string,
  value: string,
): void {
  const formattedValue = formatTomlScalar(value);
  let full = "";
  try {
    full = readFileSync(tomlPath, "utf8");
  } catch (e: unknown) {
    if (!(e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT")) {
      throw e;
    }
  }
  const eol = full.includes("\r\n") ? "\r\n" : "\n";
  const lines = full.split(/\r?\n/);
  const sectionStart = findSectionHeaderLine(lines, sectionHeader);
  if (sectionStart < 0) {
    const sep = full.trim() === "" ? "" : `${eol}${eol}`;
    writeUtf8FileAtomicReplace(
      tomlPath,
      `${full.trimEnd()}${sep}${sectionHeader}${eol}${key} = ${formattedValue}${eol}`,
    );
    return;
  }
  const sectionEnd = findSectionEndLine(lines, sectionStart, sectionHeader);
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
  const body = newLines.join(eol).trimEnd();
  writeUtf8FileAtomicReplace(tomlPath, `${body}${eol}`);
}
