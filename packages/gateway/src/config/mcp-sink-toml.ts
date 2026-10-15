import { existsSync, readFileSync } from "node:fs";

import {
  CAPTURE_KINDS,
  type CaptureKind,
  DEFAULT_CAPTURE_KINDS,
  isCaptureKind,
} from "../mcp-sink/capture-types.ts";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/** `[mcp_sink]` — the MCP capture sink (spec 2026-10-11 § 8.1). DEFAULT OFF. */
export type NimbusMcpSinkToml = {
  readonly enabled: boolean;
  readonly kinds: readonly CaptureKind[];
  readonly maxPerHour: number;
  readonly maxPending: number;
  /** How long a proposed action may wait for the owner (spec § 5). */
  readonly actionTtlHours: number;
  /** Unexpired proposed actions allowed at once; separate from `maxPending`. */
  readonly actionMaxPending: number;
};

export const DEFAULT_MCP_SINK_CONFIG: NimbusMcpSinkToml = Object.freeze({
  enabled: false,
  kinds: Object.freeze([...DEFAULT_CAPTURE_KINDS]),
  maxPerHour: 30,
  maxPending: 100,
  actionTtlHours: 24,
  actionMaxPending: 10,
});

export class McpSinkConfigError extends Error {}

export type McpSinkConfigLoad =
  | { readonly ok: true; readonly config: NimbusMcpSinkToml }
  | { readonly ok: false; readonly error: string };

type Draft = { -readonly [K in keyof NimbusMcpSinkToml]: NimbusMcpSinkToml[K] };

function boundedInt(key: string, valRaw: string, min: number, max: number): number {
  const n = parseIntDec(valRaw);
  if (n === undefined || n < min || n > max) {
    throw new McpSinkConfigError(
      `[mcp_sink].${key} must be an integer ${String(min)}..${String(max)} (got: ${valRaw})`,
    );
  }
  return n;
}

function parseKinds(valRaw: string): CaptureKind[] {
  let list: string[];
  try {
    list = parseStringArray(valRaw);
  } catch {
    throw new McpSinkConfigError(`[mcp_sink].kinds must be an array of strings (got: ${valRaw})`);
  }
  if (list.length === 0) throw new McpSinkConfigError("[mcp_sink].kinds must not be empty");
  const out: CaptureKind[] = [];
  for (const k of list) {
    if (!isCaptureKind(k)) {
      throw new McpSinkConfigError(
        `[mcp_sink].kinds: unknown kind ${JSON.stringify(k)} (allowed: ${CAPTURE_KINDS.join(", ")})`,
      );
    }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

function applyKey(out: Draft, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b === undefined) {
        throw new McpSinkConfigError(`[mcp_sink].enabled must be true or false (got: ${valRaw})`);
      }
      out.enabled = b;
      return;
    }
    case "kinds":
      out.kinds = Object.freeze(parseKinds(valRaw));
      return;
    case "max_per_hour":
      out.maxPerHour = boundedInt("max_per_hour", valRaw, 1, 1000);
      return;
    case "max_pending":
      out.maxPending = boundedInt("max_pending", valRaw, 1, 10_000);
      return;
    case "action_ttl_hours":
      out.actionTtlHours = boundedInt("action_ttl_hours", valRaw, 1, 168);
      return;
    case "action_max_pending":
      out.actionMaxPending = boundedInt("action_max_pending", valRaw, 1, 100);
      return;
    default:
      return;
  }
}

/** Parse `[mcp_sink]`. Throws `McpSinkConfigError` on any out-of-range value — never clamps. */
export function parseNimbusTomlMcpSink(source: string): NimbusMcpSinkToml {
  const out: Draft = { ...DEFAULT_MCP_SINK_CONFIG };
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[mcp_sink]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) applyKey(out, kv.key, kv.valRaw);
  }
  return Object.freeze(out);
}

/** Load from disk. A bad file is a VALUE (`ok: false`), so the gateway boots with the sink off. */
export function loadNimbusMcpSinkFromPath(tomlPath: string): McpSinkConfigLoad {
  const raw = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  try {
    return { ok: true, config: parseNimbusTomlMcpSink(raw) };
  } catch (e) {
    if (e instanceof McpSinkConfigError) return { ok: false, error: e.message };
    throw e;
  }
}
