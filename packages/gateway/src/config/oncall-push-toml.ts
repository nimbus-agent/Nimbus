/**
 * `[oncall.push]` — the on-call pushed brief (spec 2026-10-02-oncall-pushed-brief-design.md § 2.8).
 * DEFAULT OFF. `chatops_namespace` names the namespace whose policy `notify` channels receive the
 * pushed headline (the ChatOps sink, `oncall-push/push-sinks.ts`); `""` posts nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

export type NimbusOncallPushToml = {
  readonly enabled: boolean;
  readonly severities: readonly string[];
  readonly chatopsNamespace: string;
  readonly retentionDays: number;
};

export const DEFAULT_ONCALL_PUSH_CONFIG: NimbusOncallPushToml = Object.freeze({
  enabled: false,
  severities: Object.freeze([]) as readonly string[],
  chatopsNamespace: "",
  retentionDays: 90,
});

function lowerDeduped(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const lower = v.trim().toLowerCase();
    if (lower === "" || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/** The parsed config while its section is still being read. */
type OncallPushDraft = { -readonly [K in keyof NimbusOncallPushToml]: NimbusOncallPushToml[K] };

/** One `[oncall.push]` entry. A malformed value is ignored, so the value already in effect stands. */
function applyOncallPushKey(out: OncallPushDraft, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "severities":
      // parseStringArray THROWS on a non-array value (`severities = "P1"`) and on a multi-line
      // array, which this line-based parser sees as a bare `[`. This loader runs during gateway
      // assembly, so an unparseable value is ignored — like `enabled` and `retention_days` —
      // rather than aborting boot over an optional, default-off section.
      try {
        out.severities = lowerDeduped(parseStringArray(valRaw));
      } catch {
        // keep the value in effect (the default, unless an earlier line set one)
      }
      break;
    case "chatops_namespace":
      out.chatopsNamespace = parseString(valRaw).trim();
      break;
    case "retention_days": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 1) out.retentionDays = n;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusTomlOncallPush(source: string): NimbusOncallPushToml {
  const out: OncallPushDraft = { ...DEFAULT_ONCALL_PUSH_CONFIG };
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[oncall.push]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) applyOncallPushKey(out, kv.key, kv.valRaw);
  }
  return out;
}

export function loadNimbusOncallPushFromPath(tomlPath: string): NimbusOncallPushToml {
  if (!existsSync(tomlPath)) return DEFAULT_ONCALL_PUSH_CONFIG;
  return parseNimbusTomlOncallPush(readFileSync(tomlPath, "utf8"));
}
