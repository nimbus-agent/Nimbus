import {
  DEFAULT_MCP_SINK_CONFIG,
  type McpSinkConfigLoad,
  type NimbusMcpSinkToml,
} from "../config/mcp-sink-toml.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { type CaptureKind, SUBMITTABLE_KINDS } from "./capture-types.ts";

export const MCP_CAPTURE_CAPABILITY =
  "mcp_capture" as const satisfies (typeof AI_V2_CAPABILITIES)[number];

export type CaptureDisabledReason = "config" | "config_error" | "policy";

export type CaptureCapability =
  | {
      readonly enabled: true;
      readonly config: NimbusMcpSinkToml;
      readonly kinds: readonly CaptureKind[];
    }
  | {
      readonly enabled: false;
      readonly reason: CaptureDisabledReason;
      readonly config: NimbusMcpSinkToml;
      readonly kinds: readonly CaptureKind[];
    };

/**
 * Config (read at boot) + org policy (read LIVE by the caller, I22). An ABSENT policy accessor is
 * DISABLED, never enabled — the same fail-closed shape as `isUserMcpModelAccessEnabled`.
 */
export function resolveCaptureCapability(
  load: McpSinkConfigLoad,
  enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined,
): CaptureCapability {
  if (!load.ok) {
    return { enabled: false, reason: "config_error", config: DEFAULT_MCP_SINK_CONFIG, kinds: [] };
  }
  const config = load.config;
  const kinds = config.kinds.filter((k) => SUBMITTABLE_KINDS.has(k));
  if (!config.enabled) return { enabled: false, reason: "config", config, kinds };
  if (enforced === undefined || enforced.capabilitiesDisabled.has(MCP_CAPTURE_CAPABILITY)) {
    return { enabled: false, reason: "policy", config, kinds };
  }
  return { enabled: true, config, kinds };
}
