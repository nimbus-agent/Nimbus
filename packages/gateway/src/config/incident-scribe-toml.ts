import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import { isTableHeader, parseBool, splitKeyValue, stripComment } from "./toml-primitives.ts";

/**
 * `[incident.scribe]` - the incident scribe (Phase 10 IC9b, incident-engine spec § 5.9). DEFAULT OFF. With
 * `enabled = true`, every new version of an incident record queues a stakeholder update draft under
 * `<dataDir>/incident-drafts/` and shows one counts-only notification; nothing is ever posted. A malformed value
 * falls back to `false`, recorded through `sectionFallbackSink` so `nimbus config explain` names it.
 */
export type NimbusIncidentScribeToml = {
  readonly enabled: boolean;
};

export const DEFAULT_INCIDENT_SCRIBE_CONFIG: NimbusIncidentScribeToml = Object.freeze({
  enabled: false,
});

export function parseNimbusTomlIncidentScribe(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusIncidentScribeToml {
  let enabled = DEFAULT_INCIDENT_SCRIBE_CONFIG.enabled;
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[incident.scribe]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined || kv.key !== "enabled") continue;
    const b = parseBool(kv.valRaw);
    if (b === undefined) {
      onFallback?.(
        `[incident.scribe].enabled must be true or false (got: ${kv.valRaw}); using false`,
      );
      enabled = false;
    } else enabled = b;
  }
  return Object.freeze({ enabled });
}

/** `[incident.scribe]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusIncidentScribeFromConfigDir(configDir: string): NimbusIncidentScribeToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_INCIDENT_SCRIBE_CONFIG;
  return parseNimbusTomlIncidentScribe(raw, sectionFallbackSink(configDir, "incident.scribe"));
}
