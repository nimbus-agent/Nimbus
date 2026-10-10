import { processEnvGet } from "../platform/env-access.ts";

/**
 * The two `AgentCoordinator` caps, resolved ONCE at boot from env and `[llm]` in nimbus.toml.
 *
 * Precedence, per key: an env var that is SET and VALID (`NIMBUS_MAX_AGENT_DEPTH`,
 * `NIMBUS_MAX_TOOL_CALLS_PER_SESSION`) > `[llm] max_agent_depth` / `max_tool_calls_per_session` >
 * the default. Until 2026-10-10 the TOML keys were parsed and then read by nothing, so setting
 * them changed nothing.
 *
 * The module-level `Config` is deliberately NOT mutated: it is an `as const` env snapshot taken
 * at first import, and everything that wants the effective caps reads `getAgentLimits()` instead.
 *
 * Stated bound: `maxToolCallsPerSession` counts SUB-TASKS per coordinator (each built-in brief
 * builds its own coordinator with a fresh counter), not tool calls per conversation session.
 */
export type AgentLimits = {
  readonly maxAgentDepth: number;
  readonly maxToolCallsPerSession: number;
};

/** Raw env strings — undefined when unset. Validated by `resolveAgentLimits`, not here. */
export type AgentLimitEnv = {
  readonly maxAgentDepth?: string;
  readonly maxToolCallsPerSession?: string;
};

export const AGENT_LIMIT_DEFAULTS: AgentLimits = { maxAgentDepth: 3, maxToolCallsPerSession: 20 };

/** Same bounds `config.ts` applies to the env vars and `nimbus-toml.ts` applies to the keys. */
const BOUNDS = {
  maxAgentDepth: { min: 1, max: 10 },
  maxToolCallsPerSession: { min: 1, max: 200 },
} as const;

type LimitKey = keyof AgentLimits;

export function readAgentLimitEnv(
  get: (name: string) => string | undefined = processEnvGet,
): AgentLimitEnv {
  const depth = get("NIMBUS_MAX_AGENT_DEPTH");
  const toolCalls = get("NIMBUS_MAX_TOOL_CALLS_PER_SESSION");
  return {
    ...(depth === undefined ? {} : { maxAgentDepth: depth }),
    ...(toolCalls === undefined ? {} : { maxToolCallsPerSession: toolCalls }),
  };
}

function inBounds(key: LimitKey, n: number): boolean {
  return Number.isInteger(n) && n >= BOUNDS[key].min && n <= BOUNDS[key].max;
}

function fromEnv(key: LimitKey, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  // `parseInt`, matching `config.ts`'s existing env parse, so a value that worked before still does.
  const n = Number.parseInt(raw, 10);
  return inBounds(key, n) ? n : undefined;
}

function fromToml(key: LimitKey, value: number | undefined): number | undefined {
  return value !== undefined && inBounds(key, value) ? value : undefined;
}

export function resolveAgentLimits(input: {
  readonly env: AgentLimitEnv;
  readonly toml?: Partial<AgentLimits>;
}): AgentLimits {
  const pick = (key: LimitKey): number =>
    fromEnv(key, input.env[key]) ?? fromToml(key, input.toml?.[key]) ?? AGENT_LIMIT_DEFAULTS[key];
  return {
    maxAgentDepth: pick("maxAgentDepth"),
    maxToolCallsPerSession: pick("maxToolCallsPerSession"),
  };
}

let resolved: AgentLimits | undefined;

/** Called by `platform/assemble.ts` at boot, after the active profile's nimbus.toml is known. */
export function setAgentLimits(limits: AgentLimits): void {
  resolved = limits;
}

/**
 * The effective caps. Before boot has set them (a unit test, an embedded coordinator) this is the
 * env-or-default resolution — exactly what `Config` provided before the TOML keys went live.
 */
export function getAgentLimits(): AgentLimits {
  return resolved ?? resolveAgentLimits({ env: readAgentLimitEnv() });
}

export function resetAgentLimitsForTests(): void {
  resolved = undefined;
}
