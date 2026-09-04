/**
 * The `[multimodal]` section (spec § 9.2, § 8).
 *
 * Standalone rather than routed through `nimbus-toml.ts`, mirroring
 * `connectors/openapi-indexer-config.ts`: four keys do not warrant a shared parser's full
 * section-table machinery. Reuses `stripComment` from the dependency-free `toml-primitives.ts`
 * so `enabled = true # on locally` reads correctly.
 *
 * DEFAULT OFF, and every failure path — absent `configDir`, absent file, absent section, absent
 * key, unreadable or malformed TOML — reads as `false`. A missing config must never read as "on".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComment } from "../config/toml-primitives.ts";

/** Loopback, so `isLoopbackBaseUrl` derives `isLocal === true` for the default (I34). */
export const DEFAULT_VLM_BASE_URL = "http://127.0.0.1:11434";

/**
 * A tag the user must have pulled themselves. Nothing here pulls a model: `isAvailable()`
 * reporting false is a refusal condition (spec § 3.4 step 4), not a trigger to download
 * gigabytes during a pass.
 */
export const DEFAULT_VLM_MODEL = "qwen2.5vl:7b";

/** Spec § 8: "a small fixed maximum (default 8) of uniformly spaced keyframes". */
export const DEFAULT_MAX_FRAMES = 8;

const MIN_FRAMES = 1;
const MAX_FRAMES_CEILING = 64;

export interface MultimodalConfig {
  readonly enabled: boolean;
  readonly vlmBaseUrl: string;
  readonly vlmModel: string;
  readonly maxFrames: number;
}

function defaults(): MultimodalConfig {
  return {
    enabled: false,
    vlmBaseUrl: DEFAULT_VLM_BASE_URL,
    vlmModel: DEFAULT_VLM_MODEL,
    maxFrames: DEFAULT_MAX_FRAMES,
  };
}

export function loadMultimodalConfig(configDir: string | undefined): MultimodalConfig {
  if (configDir === undefined) return defaults();
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return defaults();
  try {
    return parseSection(readFileSync(tomlPath, "utf8"));
  } catch {
    return defaults();
  }
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && (t.startsWith('"') || t.startsWith("'")) && t.endsWith(t[0] ?? "")) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Bare integers only — optionally signed, digits-only. Deliberately stricter than
 * `Number.parseInt`, which accepts a numeric PREFIX and silently ignores the rest
 * (`Number.parseInt("8junk", 10) === 8`). A `max_frames` value that isn't a clean integer is
 * malformed TOML, not a value to coerce — see the `undefined` handling at the call site.
 */
const INTEGER_PATTERN = /^[+-]?\d+$/;

function parseStrictInt(raw: string): number | undefined {
  const t = raw.trim();
  if (!INTEGER_PATTERN.test(t)) return undefined;
  return Number.parseInt(t, 10);
}

function clampFrames(n: number): number {
  return Math.min(MAX_FRAMES_CEILING, Math.max(MIN_FRAMES, n));
}

function parseSection(raw: string): MultimodalConfig {
  let inSection = false;
  let out = defaults();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;
    // A malformed header (`[multimodal`) never equals the section name, so it leaves `inSection`
    // false and the whole file reads as defaults — the fail-safe direction.
    if (line.startsWith("[")) {
      inSection = line === "[multimodal]";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      // Not blank, not a comment (both already stripped above), not `key = value` — malformed
      // TOML inside the section this file is supposed to be authoritative over. The previous
      // `continue` here read a line like `not valid toml` as "ignore it" and left whatever
      // `enabled = true` above it stood, in direct contradiction of this file's header contract
      // that malformed TOML reads as OFF. Fail the WHOLE load off rather than skip the one line:
      // an operator who cannot trust the file to parse should not get a half-applied result.
      return defaults();
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === "enabled") {
      const v = value.trim().toLowerCase();
      if (v === "true") out = { ...out, enabled: true };
      else if (v === "false") out = { ...out, enabled: false };
      // Neither: a malformed boolean (`enabled = maybe`) is malformed TOML, same fail-off
      // direction as the unstructured-line case above.
      else return defaults();
    } else if (key === "vlm_base_url") {
      const v = unquote(value);
      if (v !== "") out = { ...out, vlmBaseUrl: v };
    } else if (key === "vlm_model") {
      const v = unquote(value);
      if (v !== "") out = { ...out, vlmModel: v };
    } else if (key === "max_frames") {
      const n = parseStrictInt(value);
      // A non-integer value (`8junk`, `nonsense`) is malformed TOML for this key — same fail-off
      // direction, not a silent fallback to the default frame count.
      if (n === undefined) return defaults();
      out = { ...out, maxFrames: clampFrames(n) };
    }
    // An unrecognised but well-formed key (e.g. a future `vlm_prompt` this binary predates) is
    // deliberately IGNORED rather than failing the section off. Chosen over the stricter
    // alternative for forward-compatibility: a newer `nimbus.toml` written by (or shared with) a
    // newer gateway must not silently disable this default-off, privacy-sensitive capability on
    // an older binary just because it doesn't recognise one extra key. Contrast with the two
    // guards above, which reject a value this parser cannot trust at all (a non-boolean
    // `enabled`, a non-integer `max_frames`) — an unknown key carries no such ambiguity.
  }
  return out;
}
