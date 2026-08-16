// packages/gateway/src/agents/_lib/agent-synthesis-runner.ts

import type { Database } from "bun:sqlite";
import {
  DEFAULT_NIMBUS_AGENTS_TOML,
  loadNimbusAgentsFromConfigDir,
} from "../../config/nimbus-toml.ts";
import {
  buildSynthesisRunner,
  type SynthesisRouter,
  type SynthesisRunner,
} from "./synthesis-llm.ts";

const AGENTS_METHOD_PREFIX = "agents.";

/**
 * `"agents.why"` → `"why"`. The `briefKind` `buildSynthesisRunner` ledgers under
 * (`egress/synthesis-egress.ts` writes `agents.<briefKind>.synthesis`). Falls back to the method
 * verbatim for a caller that (incorrectly) hands in an unprefixed name, rather than throwing —
 * this is a labeling detail, not a security boundary.
 */
export function briefKindForMethod(method: string): string {
  return method.startsWith(AGENTS_METHOD_PREFIX)
    ? method.slice(AGENTS_METHOD_PREFIX.length)
    : method;
}

export type AgentSynthesisRunnerDeps = {
  /** `nimbus.toml`'s directory. `undefined` falls back to `DEFAULT_NIMBUS_AGENTS_TOML` (synthesis: "local"). */
  readonly configDir: string | undefined;
  readonly db: Database;
  /**
   * `undefined` when no LLM registry is wired (embedded/test callers, or a gateway boot with no
   * providers registered) — the runner is skipped entirely in that case, same as `[agents].synthesis
   * = "off"`. Production always supplies `LlmRegistry.llmRouter` here, which satisfies this
   * structurally (see `SynthesisRouter`'s doc comment).
   */
  readonly router: SynthesisRouter | undefined;
  /** The full RPC method, e.g. `"agents.why"` — both `tryDispatchAgentsRpc` and `resolveHttpAgentMethod` already produce this shape. */
  readonly method: string;
  readonly now?: () => number;
};

/**
 * The SINGLE factory both production call sites use to build `AgentsRpcContext.runner`:
 * `ipc/server/dispatchers.ts`'s `tryDispatchAgentsRpc` (the socket path) and
 * `agent-runs/agent-http-invoke.ts`'s `buildAgentHttpInvoker` (the HTTP path). Both read the SAME
 * `[agents]` config (via `configDir`) and the SAME router (`LlmRegistry.llmRouter`), so an HTTP
 * brief and a socket brief for the same method+params are byte-identical UNDER EVERY SYNTHESIS
 * MODE by construction — not because both callers happen to omit the field, which was the
 * pre-Task-6 state that left the whole synthesis feature unreachable in production.
 *
 * Returns `undefined` when there is no router to synthesize with, before ever consulting config —
 * `buildSynthesisRunner`'s own `"off"` branch handles the config-driven case once a router exists.
 */
export function buildAgentSynthesisRunner(
  deps: AgentSynthesisRunnerDeps,
): SynthesisRunner | undefined {
  if (deps.router === undefined) return undefined;
  const config =
    deps.configDir === undefined
      ? DEFAULT_NIMBUS_AGENTS_TOML
      : loadNimbusAgentsFromConfigDir(deps.configDir);
  // recordEgress is deliberately NOT overridden here: buildSynthesisRunner's default is the real
  // recordSynthesisEgress appender, and this factory must never substitute a fake one on any
  // production path (I29).
  return buildSynthesisRunner({
    config,
    router: deps.router,
    db: deps.db,
    briefKind: briefKindForMethod(deps.method),
    now: deps.now ?? (() => Date.now()),
  });
}
