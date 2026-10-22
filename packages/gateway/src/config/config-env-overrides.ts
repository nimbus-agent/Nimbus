// Environment variables that override a value a config loader would otherwise read from the
// layered files. `config explain` uses this table to name the true winning source. Each
// `effective` mirrors the loader's own condition, so a value the loader ignores is never
// reported as an override.

import { notificationsDisabledByEnv } from "./notifications-toml.ts";

export type EnvOverride = {
  readonly envVar: string;
  readonly path: string;
  /** The TOML-formatted value the loader applies, or `undefined` when it ignores `raw`. */
  readonly effective: (raw: string) => string | undefined;
};

export const CONFIG_ENV_OVERRIDES: readonly EnvOverride[] = [
  {
    envVar: "NIMBUS_UPDATER_URL",
    path: "updater.url",
    effective: (raw) => (raw === "" ? undefined : JSON.stringify(raw)),
  },
  {
    envVar: "NIMBUS_UPDATER_DISABLE",
    path: "updater.enabled",
    effective: (raw) => (raw === "1" ? "false" : undefined),
  },
  {
    envVar: "NIMBUS_LAN_PORT",
    path: "lan.port",
    effective: (raw) => {
      if (raw === "") return undefined;
      const n = Number.parseInt(raw, 10);
      return Number.isNaN(n) ? undefined : String(n);
    },
  },
  {
    envVar: "NIMBUS_TELEMETRY_ENABLED",
    path: "telemetry.enabled",
    effective: (raw) => {
      const v = raw.trim().toLowerCase();
      if (v === "1" || v === "true") return "true";
      if (v === "0" || v === "false") return "false";
      return undefined;
    },
  },
  {
    envVar: "NIMBUS_TELEMETRY_ENDPOINT",
    path: "telemetry.endpoint",
    effective: (raw) => {
      const v = raw.trim();
      return v === "" ? undefined : JSON.stringify(v);
    },
  },
  {
    envVar: "NIMBUS_TELEMETRY_FLUSH_SECONDS",
    path: "telemetry.flush_interval_seconds",
    effective: (raw) => {
      const v = raw.trim();
      if (v === "") return undefined;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      return String(Math.min(86_400, Math.max(60, n)));
    },
  },
  {
    envVar: "NIMBUS_NOTIFICATIONS",
    path: "notifications.enabled",
    effective: (raw) => (notificationsDisabledByEnv(() => raw) ? "false" : undefined),
  },
  // The agent caps: `engine/agent-limits.ts` lets a set, in-bounds env value beat the `[llm]` key.
  {
    envVar: "NIMBUS_MAX_AGENT_DEPTH",
    path: "llm.max_agent_depth",
    effective: (raw) => boundedIntEnv(raw, 1, 10),
  },
  {
    envVar: "NIMBUS_MAX_TOOL_CALLS_PER_SESSION",
    path: "llm.max_tool_calls_per_session",
    effective: (raw) => boundedIntEnv(raw, 1, 200),
  },
  // `config.ts` `parseEmbeddingsEnabled`: "0"/"false" turns embeddings off whatever the key says.
  {
    envVar: "NIMBUS_EMBEDDINGS",
    path: "embedding.enabled",
    effective: (raw) => (raw === "0" || raw === "false" ? "false" : undefined),
  },
];

/** `agent-limits.ts`'s env parse: blank is unset, `parseInt`, and an integer within bounds. */
function boundedIntEnv(raw: string, min: number, max: number): string | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= min && n <= max ? String(n) : undefined;
}

const POLICY_CONSTRAINED_PATHS: ReadonlySet<string> = new Set([
  "audit.tool_call_log_retention_days",
  "fleet.retention_days",
  "code_execution.enabled",
  "computer_use.enabled",
  "tool_generation.enabled",
  "multimodal.enabled",
  "fleet.enabled",
  "mcp_sink.enabled",
]);

/** True for keys a signed org policy can tighten (the layered value is then only a request). */
export function isPolicyConstrainedPath(path: string): boolean {
  return (
    POLICY_CONSTRAINED_PATHS.has(path) ||
    path.startsWith("hitl.quorum.") ||
    path.startsWith("connectors.")
  );
}
