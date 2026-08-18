/**
 * Profile-aware, per-invocation persona resolution (Spine S1, W6-A2).
 *
 * TWO properties this module exists to guarantee, both load-bearing:
 *
 * 1. It reads the PROFILE-RESOLVED toml, never `nimbus.toml` directly. Almost every other
 *    `loadNimbus*FromConfigDir` in the tree hardcodes `nimbus.toml` and is therefore blind to
 *    the active profile — which for a per-profile persona would defeat the entire feature.
 * 2. It resolves PER INVOCATION and caches nothing, mirroring `synthesis-llm.ts`'s per-call
 *    provider resolution. The file can change under a long-lived Gateway, and a cached read
 *    would make an edit require a restart.
 *
 * The warn-once set is keyed on `key=value`, not on a boolean, so a user who fixes one typo
 * and introduces another still hears about the second one without restarting.
 */
import {
  DEFAULT_NIMBUS_PERSONA_TOML,
  loadNimbusPersonaFromPath,
  type NimbusPersonaToml,
  type PersonaIssue,
  resolveNimbusTomlForProfile,
} from "./nimbus-toml.ts";

export type { NimbusPersonaToml, PersonaTone, PersonaVoice } from "./nimbus-toml.ts";

/** The slice of pino's `Logger` this module needs. Structural, for DI in tests. */
export type PersonaWarnLogger = { warn: (obj: unknown, msg: string) => void };

const warnedIssues = new Set<string>();

/** Test-only: reset the warn-once memo. */
export function resetPersonaWarningsForTest(): void {
  warnedIssues.clear();
}

export function resolvePersona(configDir: string, logger?: PersonaWarnLogger): NimbusPersonaToml {
  const issues: PersonaIssue[] = [];
  const persona = loadNimbusPersonaFromPath(resolveNimbusTomlForProfile(configDir), issues);
  if (logger !== undefined) {
    for (const issue of issues) {
      const memo = `${issue.key}=${issue.value}`;
      if (warnedIssues.has(memo)) continue;
      warnedIssues.add(memo);
      const fallback = DEFAULT_NIMBUS_PERSONA_TOML[issue.key as keyof NimbusPersonaToml];
      logger.warn(
        { key: issue.key, value: issue.value },
        `[persona] ${issue.key} = "${issue.value}" is not a recognised value — ` +
          `falling back to "${fallback}"`,
      );
    }
  }
  return persona;
}
