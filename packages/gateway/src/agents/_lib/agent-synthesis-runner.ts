// packages/gateway/src/agents/_lib/agent-synthesis-runner.ts

import type { Database } from "bun:sqlite";
import {
  DEFAULT_NIMBUS_AGENTS_TOML,
  loadNimbusAgentsFromPath,
  resolveNimbusTomlForProfile,
} from "../../config/nimbus-toml.ts";
import { resolvePersona } from "../../config/persona.ts";
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
  // A2: BOTH reads move onto the profile-resolved toml. The former
  // `loadNimbusAgentsFromConfigDir` hardcoded `nimbus.toml`, which meant `[agents] synthesis`
  // set in a profile file was silently ignored — a pre-existing bug, fixed here rather than
  // shipped alongside a profile-AWARE persona, which would have been incoherent. It also
  // means the move is BIDIRECTIONAL: `[agents]` now follows whole-file profile semantics, so
  // a key set only in the BASE `nimbus.toml` no longer applies while a profile file that
  // lacks an `[agents]` section is active. That matches `[llm]`/`[session]`. See design § 5.1.
  const tomlPath =
    deps.configDir === undefined ? undefined : resolveNimbusTomlForProfile(deps.configDir);
  const config =
    tomlPath === undefined ? DEFAULT_NIMBUS_AGENTS_TOML : loadNimbusAgentsFromPath(tomlPath);
  // No logger: this runs per brief, and warning on every brief would be noise. The single
  // warning site is the boot-time resolution in `platform/assemble.ts`.
  const persona = deps.configDir === undefined ? undefined : resolvePersona(deps.configDir);
  // recordEgress is deliberately NOT overridden here: buildSynthesisRunner's default is the real
  // recordSynthesisEgress appender, and this factory must never substitute a fake one on any
  // production path (I29).
  const inner = buildSynthesisRunner({
    config,
    router: deps.router,
    db: deps.db,
    briefKind: briefKindForMethod(deps.method),
    now: deps.now ?? (() => Date.now()),
  });
  // `exactOptionalPropertyTypes` forbids assigning `persona: undefined` to an optional
  // property — it must be OMITTED, not set to `undefined`, to satisfy `SynthesisRunner`. The
  // conditional spread achieves that; the resulting runner is behaviourally identical to
  // `{ run, persona: undefined }` since every reader (`opts.runner?.persona`) treats a missing
  // property and an `undefined` one the same.
  return inner === undefined
    ? undefined
    : { run: inner.run, ...(persona === undefined ? {} : { persona }) };
}
