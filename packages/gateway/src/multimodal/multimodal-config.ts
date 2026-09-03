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

function clampFrames(raw: string, fallback: number): number {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
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
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === "enabled") {
      const v = value.trim().toLowerCase();
      if (v === "true") out = { ...out, enabled: true };
      else if (v === "false") out = { ...out, enabled: false };
    } else if (key === "vlm_base_url") {
      const v = unquote(value);
      if (v !== "") out = { ...out, vlmBaseUrl: v };
    } else if (key === "vlm_model") {
      const v = unquote(value);
      if (v !== "") out = { ...out, vlmModel: v };
    } else if (key === "max_frames") {
      out = { ...out, maxFrames: clampFrames(value, out.maxFrames) };
    }
  }
  return out;
}
