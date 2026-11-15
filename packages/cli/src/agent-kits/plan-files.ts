/**
 * The agent kits' edit engine (Phase 28 AD7b). Pure: text in, text out, no file system.
 *
 * A kit changes another product's configuration in exactly two ways:
 *
 *  1. An OWNED BLOCK in a text format that has comments (`.rules`, `.toml`, `.md`, `.mdc`): the
 *     text between a begin and an end marker. The begin marker carries a hash of the body, so
 *     `nimbus agent status` can tell a block someone edited from one an older kit wrote.
 *  2. OWNED KEYS in a strict JSON file: the file is parsed, only the keys a kit owns are set, and
 *     everything else is written back as it was.
 *
 * Nothing outside a block or an owned key is ever changed, and a file this engine cannot parse is
 * refused, never rewritten.
 */
import { createHash } from "node:crypto";

/** A refusal with a fixed, owner-readable message. Nothing was changed. */
export class KitRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitRefusal";
  }
}

/** `hash`: `# ...` comments (TOML, Starlark). `html`: `<!-- ... -->` comments (Markdown). */
export type BlockStyle = "hash" | "html";

const LF = "\n";
const CRLF = "\r\n";

/** Line wrapping by a checkout or an editor is not a change: every CRLF reads as LF. */
export function normaliseNewlines(text: string): string {
  return text.replaceAll(CRLF, LF);
}

/** True when two texts differ only in their line endings, or not at all. */
export function sameText(a: string, b: string): boolean {
  return normaliseNewlines(a) === normaliseNewlines(b);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(normaliseNewlines(text), "utf8").digest("hex");
}

function wrap(style: BlockStyle, inner: string): string {
  return style === "hash" ? `# ${inner}` : `<!-- ${inner} -->`;
}

function beginMarker(kit: string, version: number, body: string, style: BlockStyle): string {
  return wrap(
    style,
    `>>> nimbus agent kit ${kit} v${String(version)} sha256:${sha256Hex(body)} >>>`,
  );
}

function endMarker(kit: string, style: BlockStyle): string {
  return wrap(style, `<<< nimbus agent kit ${kit} <<<`);
}

/** The whole block, LF line endings, no trailing newline. */
export function renderBlock(kit: string, version: number, body: string, style: BlockStyle): string {
  return [beginMarker(kit, version, body, style), body, endMarker(kit, style)].join(LF);
}

export interface FoundBlock {
  /** Offsets of the block in the (newline-normalised) text: begin marker to end marker inclusive. */
  readonly start: number;
  readonly end: number;
  readonly body: string;
  readonly version: number;
  /** False when the body no longer matches the hash its begin marker carries: edited by hand. */
  readonly hashMatches: boolean;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * This kit's block in `text` (already newline-normalised), or undefined when there is none.
 * A begin marker with no end marker, or two blocks for one kit, is a refusal: the file is not in a
 * state this engine wrote, so it is not edited.
 */
export function findBlock(text: string, kit: string, style: BlockStyle): FoundBlock | undefined {
  const begin = new RegExp(
    `^${escapeRegExp(wrap(style, `>>> nimbus agent kit ${kit} v`)).replace(/ -->$/, "")}(\\d+) sha256:([0-9a-f]{64}) >>>${style === "html" ? " -->" : ""}$`,
    "gm",
  );
  const first = begin.exec(text);
  if (first === null) return undefined;
  if (begin.exec(text) !== null) {
    throw new KitRefusal(`the file holds two Nimbus blocks for ${kit}; remove one by hand`);
  }
  const end = endMarker(kit, style);
  const bodyStart = first.index + first[0].length + 1;
  // A whole line, like the begin marker: text after it on the same line is not an end marker.
  const endRe = new RegExp(`\\n${escapeRegExp(end)}(?=\\n|$)`, "g");
  endRe.lastIndex = first.index + first[0].length;
  const endAt = endRe.exec(text)?.index ?? -1;
  if (endAt === -1) {
    throw new KitRefusal(
      `the file holds the start of a Nimbus block for ${kit} with no end; repair it by hand`,
    );
  }
  const body = endAt < bodyStart ? "" : text.slice(bodyStart, endAt);
  return {
    start: first.index,
    end: endAt + 1 + end.length,
    body,
    version: Number(first[1]),
    hashMatches: sha256Hex(body) === first[2],
  };
}

function newlineOf(text: string | null): string {
  return text?.includes(CRLF) ? CRLF : LF;
}

/**
 * `existing` with this kit's block replaced, or appended after a blank line when there is none.
 * The result keeps the file's own line ending (LF for a new file) and ends with one newline.
 */
export function upsertBlock(
  existing: string | null,
  kit: string,
  version: number,
  body: string,
  style: BlockStyle,
): string {
  const nl = newlineOf(existing);
  const block = renderBlock(kit, version, body, style);
  const text = normaliseNewlines(existing ?? "");
  const found = findBlock(text, kit, style);
  let out: string;
  if (found !== undefined) {
    out = text.slice(0, found.start) + block + text.slice(found.end);
  } else if (text.trim() === "") {
    out = block + LF;
  } else {
    out = `${text.replace(/\n*$/, "")}${LF}${LF}${block}${LF}`;
  }
  if (!out.endsWith(LF)) out += LF;
  return nl === CRLF ? out.replaceAll(LF, CRLF) : out;
}

/** `text` without this kit's block (newline-normalised): what the rest of the file says. */
export function withoutBlock(text: string, kit: string, style: BlockStyle): string {
  const flat = normaliseNewlines(text);
  const found = findBlock(flat, kit, style);
  return found === undefined ? flat : flat.slice(0, found.start) + flat.slice(found.end);
}

/** True when the file already holds this kit's block (a damaged one counts: something is there). */
export function hasBlock(text: string, kit: string, style: BlockStyle): boolean {
  try {
    return findBlock(normaliseNewlines(text), kit, style) !== undefined;
  } catch {
    return true;
  }
}

// ---- strict JSON ---------------------------------------------------------------------------------

export type JsonObject = Record<string, unknown>;

export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The file as a JSON object; an absent or empty file is `{}`. A file that is not strict JSON (a
 * comment, a trailing comma) or whose top level is not an object is REFUSED: re-serialising it
 * would drop its comments, so it is never rewritten.
 */
export function parseJsonFile(text: string | null, path: string): JsonObject {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KitRefusal(
      `${path} is not strict JSON (a comment or a trailing comma, perhaps), so Nimbus will not rewrite it; add the entry by hand`,
    );
  }
  if (!isJsonObject(parsed)) {
    throw new KitRefusal(`${path} does not hold a JSON object, so Nimbus will not rewrite it`);
  }
  return parsed;
}

/** The object at `key`, created when absent; refused when something else is there. */
export function childObject(parent: JsonObject, key: string, path: string): JsonObject {
  const v = parent[key];
  if (v === undefined) {
    const made: JsonObject = {};
    parent[key] = made;
    return made;
  }
  if (!isJsonObject(v)) {
    throw new KitRefusal(`${path}: "${key}" is not an object, so Nimbus will not change it`);
  }
  return v;
}

/** The array at `key`, created when absent; refused when something else is there. */
export function childArray(parent: JsonObject, key: string, path: string): unknown[] {
  const v = parent[key];
  if (v === undefined) {
    const made: unknown[] = [];
    parent[key] = made;
    return made;
  }
  if (!Array.isArray(v)) {
    throw new KitRefusal(`${path}: "${key}" is not a list, so Nimbus will not change it`);
  }
  return v;
}

function indentOf(text: string | null): string | number {
  const m = /\n([ \t]+)"/.exec(text ?? "");
  return m?.[1] ?? 2;
}

/**
 * The file after `mutate` ran on its parsed content. When the content comes out equal, the
 * ORIGINAL text is returned byte for byte (no reformatting of a file that needs no change);
 * otherwise it is serialised with the file's own indent and line ending and one trailing newline.
 */
export function editJsonFile(
  before: string | null,
  path: string,
  mutate: (root: JsonObject) => void,
): string {
  const root = parseJsonFile(before, path);
  const original = JSON.stringify(root);
  mutate(root);
  if (before !== null && JSON.stringify(root) === original) return before;
  const out = `${JSON.stringify(root, null, indentOf(before))}${LF}`;
  return newlineOf(before) === CRLF ? out.replaceAll(LF, CRLF) : out;
}

/** The value at `keys` in a JSON file's text, or undefined when the file or the path is not there. */
export function jsonAt(text: string, keys: readonly string[]): unknown {
  let at: unknown;
  try {
    at = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const key of keys) {
    if (!isJsonObject(at)) return undefined;
    at = at[key];
  }
  return at;
}
