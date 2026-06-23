import { basename } from "node:path";
import yaml from "js-yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const H1_RE = /^#\s+(\S.*)$/m;
// Content excludes `[` (as well as `]`/newline) so the engine fails fast instead of
// re-scanning `[`-heavy input from every position — keeps matching linear (S8786). A valid
// Obsidian wikilink target never contains a bare `[`.
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;
const DAILY_NOTE_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;

export type ParsedNote = {
  readonly relPath: string;
  readonly title: string;
  readonly body: string;
  readonly frontmatter: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly wikilinks: readonly string[];
  readonly dailyNoteDate: string | undefined;
};

function extractFrontmatterAndBody(source: string): { fm: Record<string, unknown>; body: string } {
  const m = FRONTMATTER_RE.exec(source);
  if (m === null) {
    return { fm: {}, body: source };
  }
  const yamlSrc = m[1] ?? "";
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlSrc);
  } catch {
    parsed = null;
  }
  const fm =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { fm, body: source.slice(m[0].length) };
}

function extractTitle(body: string, relPath: string): string {
  const h1 = H1_RE.exec(body);
  if (h1 !== null) {
    const trimmed = h1[1]?.trim();
    if (trimmed !== undefined && trimmed !== "") {
      return trimmed;
    }
  }
  return basename(relPath).replace(/\.md$/i, "");
}

function extractTags(fm: Record<string, unknown>): readonly string[] {
  const raw = fm["tags"];
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string");
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return [raw];
  }
  return [];
}

function extractAliases(fm: Record<string, unknown>): readonly string[] {
  const raw = fm["aliases"];
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string");
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return [raw];
  }
  return [];
}

function extractWikilinks(body: string): readonly string[] {
  const out: string[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const inner = match[1] ?? "";
    const noAlias = inner.split("|")[0] ?? "";
    const target = noAlias.split("#")[0]?.trim() ?? "";
    if (target !== "") {
      out.push(target);
    }
  }
  return out;
}

function extractDailyNoteDate(relPath: string): string | undefined {
  const m = DAILY_NOTE_RE.exec(basename(relPath));
  if (m === null) {
    return undefined;
  }
  const [, y, mo, d] = m;
  if (y === undefined || mo === undefined || d === undefined) {
    return undefined;
  }
  const month = Number.parseInt(mo, 10);
  const day = Number.parseInt(d, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  return `${y}-${mo}-${d}`;
}

export function parseNote(relPath: string, source: string): ParsedNote {
  const { fm, body } = extractFrontmatterAndBody(source);
  return {
    relPath: relPath.replaceAll("\\", "/"),
    title: extractTitle(body, relPath),
    body,
    frontmatter: fm,
    tags: extractTags(fm),
    aliases: extractAliases(fm),
    wikilinks: extractWikilinks(body),
    dailyNoteDate: extractDailyNoteDate(relPath),
  };
}

export function resolveWikilinks(
  targets: readonly string[],
  byFilenameLower: ReadonlyMap<string, { id: string; title: string }>,
  byTitleLower: ReadonlyMap<string, string>,
): { resolved: readonly string[]; unresolved: readonly string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const t of targets) {
    const lc = t.toLowerCase();
    const byFn = byFilenameLower.get(lc) ?? byFilenameLower.get(`${lc}.md`);
    if (byFn !== undefined) {
      resolved.push(byFn.id);
      continue;
    }
    const byTitle = byTitleLower.get(lc);
    if (byTitle !== undefined) {
      resolved.push(byTitle);
      continue;
    }
    unresolved.push(t);
  }
  return { resolved, unresolved };
}
