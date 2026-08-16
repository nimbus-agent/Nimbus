// packages/gateway/src/agents/_lib/synthesis-llm.ts

import type { Database } from "bun:sqlite";
import type { NimbusAgentsToml } from "../../config/nimbus-toml.ts";
import { recordSynthesisEgress } from "../../egress/synthesis-egress.ts";
import type { ResolvedSynthesisProvider } from "../../llm/router.ts";

export type SynthesisAttempt =
  | { ok: true; markdown: string; model: string; remote: boolean }
  | {
      ok: false;
      reason: "no_eligible_provider" | "timeout" | "egress_append_failed";
      detail?: string;
    };

export type SynthesisRunner = { run: (prompt: string) => Promise<SynthesisAttempt> };

/**
 * The minimal surface `buildSynthesisRunner` needs from `LlmRouter`. A dedicated interface —
 * not the concrete `LlmRouter` class — so a test can inject a plain object via DI rather than
 * `mock.module` (CLAUDE.md: the combined CLI/gateway run on CI Linux leaks `mock.module` state
 * between files). `LlmRouter` has private fields, so TypeScript requires a real instance to
 * satisfy that class type; a plain object can only ever satisfy a narrower interface. `LlmRouter`
 * implements both methods below and is passed as `SynthesisLlmDeps.router` in production —
 * assigning a concrete instance to this narrower type is always sound.
 */
export interface SynthesisRouter {
  resolveForSynthesis(): Promise<ResolvedSynthesisProvider | undefined>;
  generateMarkdown(prompt: string, provider: ResolvedSynthesisProvider): Promise<string>;
}

export type SynthesisLlmDeps = {
  readonly config: NimbusAgentsToml;
  readonly router: SynthesisRouter;
  readonly db: Database;
  readonly briefKind: string;
  readonly now: () => number;
};

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type RaceOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown };

/**
 * Races `promise` against a `ms`-millisecond timer. On timeout the underlying promise is NOT
 * cancelled — `LlmGenerateOptions` (`llm/types.ts:14-22`) has no `signal` field, so a timed-out
 * generation is abandoned, not aborted; the request keeps running to completion. Deliberately
 * deferred rather than fixed — see task-4-brief.md ("Known limitation, deliberately deferred").
 * A rejection from `promise` (a real provider error, not a hang) is also resolved rather than
 * left to reject the returned promise, so `run()` below can map every outcome into a
 * `SynthesisAttempt` without a bare throw escaping it.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "value", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "error", error });
      },
    );
  });
}

/**
 * Builds a per-brief synthesis runner, or `undefined` when `[agents].synthesis = "off"` — a
 * normal outcome, not an error; the caller renders deterministically instead.
 *
 * `run(prompt)`'s internal order is load-bearing (task-4-brief.md Step 3):
 *   1. Resolve the provider PER CALL, never cached — `LlmRouter.selectProvider` already probes
 *      availability on every call (`llm/router.ts:103`).
 *   2. No provider resolved → `no_eligible_provider`.
 *   3. A resolved REMOTE provider under `"local"` mode is REFUSED as `no_eligible_provider` — a
 *      normal outcome on a machine with no local model, not an error. `LlmRouter.prefersLocal()`
 *      is only a preference (its own doc comment: "falls through to `remote` when no local
 *      provider answers"), so the provider actually resolved must be inspected, never inferred
 *      from that preference.
 *   4. Under `"any"` mode ONLY: call `recordSynthesisEgress` UNCONDITIONALLY, passing the
 *      DERIVED `remote` flag (never a literal `true`). `recordSynthesisEgress` enforces the
 *      local/remote rule internally (Task 3) and appends nothing when `remote` is `false` —
 *      calling it only from a non-local branch, or passing a literal `true`, would make that
 *      internal guard inert and silently return enforcement to this call site, which is exactly
 *      the weakness Task 3's review closed. A throw here fails closed: `egress_append_failed`,
 *      and generation never happens.
 *   5. Race the provider call against `config.synthesisTimeoutMs`.
 *   6. Otherwise, `ok: true` with the markdown, model, and derived `remote` flag.
 */
export function buildSynthesisRunner(deps: SynthesisLlmDeps): SynthesisRunner | undefined {
  if (deps.config.synthesis === "off") {
    return undefined;
  }

  return {
    async run(prompt: string): Promise<SynthesisAttempt> {
      const resolved = await deps.router.resolveForSynthesis();
      if (resolved === undefined) {
        return { ok: false, reason: "no_eligible_provider" };
      }

      const remote = !resolved.isLocal;
      if (remote && deps.config.synthesis === "local") {
        return { ok: false, reason: "no_eligible_provider" };
      }

      if (deps.config.synthesis === "any") {
        try {
          recordSynthesisEgress(deps.db, {
            briefKind: deps.briefKind,
            model: resolved.modelName,
            now: deps.now(),
            remote,
          });
        } catch (err) {
          return { ok: false, reason: "egress_append_failed", detail: errorDetail(err) };
        }
      }

      const raced = await raceWithTimeout(
        deps.router.generateMarkdown(prompt, resolved),
        deps.config.synthesisTimeoutMs,
      );
      if (raced.kind === "timeout") {
        return { ok: false, reason: "timeout" };
      }
      if (raced.kind === "error") {
        return { ok: false, reason: "timeout", detail: errorDetail(raced.error) };
      }
      return { ok: true, markdown: raced.value, model: resolved.modelName, remote };
    },
  };
}
