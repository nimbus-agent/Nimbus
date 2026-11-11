// packages/gateway/src/standing/learning-config.ts
// Builds the `LearningConfig` the workflow runner gets (Phase 10 SA5). Learning is off on a
// demo-rooted gateway (I41), when org policy locks standing approvals off, and when the policy
// cannot be read (fail closed, the accessor SA3 uses). `[standing] suggest_after` is read per pass
// through the layered config reader (static D35); a bad value falls back to the default with a warning.
import {
  DEFAULT_STANDING_CONFIG,
  loadNimbusStandingFromConfigDir,
} from "../config/standing-toml.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { LearningConfig } from "./approval-learning.ts";
import { isStandingApprovalsEnabled } from "./standing-rule-capability.ts";

export function buildLearningConfig(src: {
  readonly demo: boolean;
  readonly configDir: string;
  /** The LIVE enforced policy accessor (absent = locked off). */
  readonly enforcedPolicy?: (() => EnforcedPolicy | undefined) | undefined;
  readonly log?: LearningConfig["log"];
}): LearningConfig {
  return {
    enabled: () => {
      if (src.demo) return false;
      try {
        return isStandingApprovalsEnabled(src.enforcedPolicy?.());
      } catch {
        return false;
      }
    },
    suggestAfter: () => {
      const load = loadNimbusStandingFromConfigDir(src.configDir);
      if (load.ok) return load.config.suggestAfter;
      src.log?.(
        { event: "standing.config_invalid", error: load.error },
        "[standing] is invalid; using the default suggest_after",
      );
      return DEFAULT_STANDING_CONFIG.suggestAfter;
    },
    ...(src.log === undefined ? {} : { log: src.log }),
  };
}
