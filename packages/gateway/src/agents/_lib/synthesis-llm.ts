// packages/gateway/src/agents/_lib/synthesis-llm.ts

import type { Database } from "bun:sqlite";
import { redactAuditPayload } from "../../audit/format-audit-payload.ts";
import type { NimbusAgentsToml } from "../../config/nimbus-toml.ts";
import type { NimbusPersonaToml } from "../../config/persona.ts";
import { recordSynthesisEgress } from "../../egress/synthesis-egress.ts";
import type { ResolvedSynthesisProvider } from "../../llm/router.ts";
import type { ProviderId } from "../../llm/types.ts";

export type SynthesisAttempt =
  | { ok: true; markdown: string; model: string; remote: boolean }
  | {
      ok: false;
      reason: "no_eligible_provider" | "timeout" | "egress_append_failed" | "provider_error";
      detail?: string;
    };

export type SynthesisRunner = {
  run: (prompt: string) => Promise<SynthesisAttempt>;
  /**
   * Resolved persona (A2). Rides the RUNNER rather than `SynthesizeOpts` because
   * `buildAgentSynthesisRunner` is already the single factory both production brief paths
   * share — so a socket brief and an HTTP brief get the same persona by construction, and
   * `emit-brief.ts` plus every agent call site stay untouched.
   */
  readonly persona?: NimbusPersonaToml;
};

/**
 * The minimal surface `buildSynthesisRunner` needs from `LlmRouter` — a STRUCTURAL SUBSET of it,
 * extracted for DI, not a redundant duplicate: a test needs to inject a plain object rather than
 * `mock.module` (CLAUDE.md: the combined CLI/gateway run on CI Linux leaks `mock.module` state
 * between files), and `LlmRouter` has private fields, so TypeScript requires a REAL instance to
 * satisfy that class type — a plain object can only ever satisfy a narrower interface like this
 * one. `LlmRouter` implements both methods below and is passed as `SynthesisLlmDeps.router` in
 * production; assigning a concrete instance to this narrower type is always sound (see the
 * compile-time proof of that in `synthesis-llm.test.ts`). Do not delete this as "redundant with
 * `LlmRouter`" — it is the only reason the tests in this file can avoid `mock.module` at all.
 */
export interface SynthesisRouter {
  resolveForSynthesis(preferLocal?: boolean): Promise<ResolvedSynthesisProvider | undefined>;
  generateMarkdown(prompt: string, provider: ResolvedSynthesisProvider): Promise<string>;
}

/**
 * The exact call shape of `recordSynthesisEgress`. Extracted as a named type — rather than
 * `typeof recordSynthesisEgress` inline at every use — purely so `SynthesisLlmDeps.recordEgress`
 * reads self-documenting.
 */
export type SynthesisEgressRecorder = (
  db: Database,
  args: {
    readonly briefKind: string;
    readonly provider: {
      readonly providerId: ProviderId;
      readonly modelName: string;
      readonly isLocal: boolean;
    };
    readonly now: number;
  },
) => void;

export type SynthesisLlmDeps = {
  readonly config: NimbusAgentsToml;
  readonly router: SynthesisRouter;
  readonly db: Database;
  readonly briefKind: string;
  readonly now: () => number;
  /**
   * Injectable seam over `recordSynthesisEgress`, defaulting to the real one. Test-visibility
   * only — production callers never set this, the appender is still the same chokepoint, and D22
   * (b) is unaffected: this file still never names `appendEgressEntry`. It exists so a test can
   * assert the recorder was actually CALLED (with which `remote` value) rather than only
   * inferring that from row counts on a fake db — a call moved into `if (remote)` and a call made
   * unconditionally are BYTE-IDENTICAL by row count alone when `remote` is `false`, since the
   * real appender already no-ops on `remote: false`; observing the call itself is the only way to
   * catch that regression.
   */
  readonly recordEgress?: SynthesisEgressRecorder;
};

/** Cap for a redacted error `detail` — generous for a diagnostic message, not a payload dump. */
const DETAIL_MAX_BYTES = 500;

/**
 * Redacts a thrown error's message before it can reach `SynthesisAttempt.detail`. `detail` is
 * NOT internal-only: Task 5's `SynthesisProvenance` carries it out on the `briefReady`
 * notification, so a raw `err.message` — which can embed a provider's auth header, an API key
 * echoed back in an error body, or similar — must never reach it unredacted. Reuses the shipped
 * `redactAuditPayload` (strips gh*_/sk-/Bearer/JWT/AWS-shaped token families) rather than a
 * bespoke scrubber, so this detail stays covered by the same property tests that already assert
 * 1:1 token-family coverage (`audit/format-audit-payload.test.ts`). Used for BOTH failure
 * branches below (`egress_append_failed`, `provider_error`) so their redaction never drifts.
 *
 * Exported for `synthesize.ts`, which catches a REJECTING runner and needs the identical
 * redaction on the `detail` it reports. Sharing this function is the point: a second scrubber
 * there would be one more thing to keep in step with the token families this one already covers.
 */
export function redactedErrorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactAuditPayload(message, DETAIL_MAX_BYTES);
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
 *   4. Call `recordSynthesisEgress` (or the injected `recordEgress` test double) UNCONDITIONALLY
 *      for EVERY mode that reaches this point — `"local"` and `"allow-remote"` alike, `"off"`
 *      already excluded at build time — handing over the RESOLVED PROVIDER, never a `remote`
 *      boolean computed here. `recordSynthesisEgress` re-derives locality from `provider.isLocal`
 *      and appends nothing for a local one; because it decides from the provider rather than from
 *      a verdict this site supplies, no call site can suppress a row (a false zero in the ledger
 *      `nimbus prove` reports on) or fabricate one for a local generate. Calling it only from a
 *      non-local branch would make that internal guard inert and silently return enforcement to
 *      this call site, which is exactly the weakness Task 3's review closed. Calling it under
 *      `"local"` too (where a remote provider would already have been refused above) is
 *      deliberate, not redundant: it means a future third `SynthesisMode` cannot silently bypass
 *      the appender by failing to be spelled out in a mode check — the appender, not this call
 *      site, decides what gets ledgered. A throw here fails closed: `egress_append_failed`, and
 *      generation never happens.
 *   5. Race the provider call against `config.synthesisTimeoutMs`. The timer elapsing first is
 *      `timeout`; the provider call REJECTING first (network failure, auth rejection, a
 *      malformed response, ...) is the distinct `provider_error` — see the inline comment where
 *      they are told apart for why they are never merged.
 *   6. Otherwise, `ok: true` with the markdown, model, and derived `remote` flag.
 */
export function buildSynthesisRunner(deps: SynthesisLlmDeps): SynthesisRunner | undefined {
  if (deps.config.synthesis === "off") {
    return undefined;
  }
  const recordEgress = deps.recordEgress ?? recordSynthesisEgress;

  return {
    async run(prompt: string): Promise<SynthesisAttempt> {
      // preferLocal: true — independent of `[llm].prefer_local`, same precedent as
      // `briefs/brief-llm-adapter.ts`'s `createBriefLlm(router, preferLocal)`. Without this, a
      // stock `[llm] prefer_local = false` install with a remote provider registered would make
      // `resolveForSynthesis()` resolve remote-first even with a healthy local provider, and
      // `"local"` mode would then refuse the whole attempt as `no_eligible_provider` — not because
      // no local provider answered, but because a remote one was picked ahead of it.
      const resolved = await deps.router.resolveForSynthesis(true);
      if (resolved === undefined) {
        return { ok: false, reason: "no_eligible_provider" };
      }

      const remote = !resolved.isLocal;
      if (remote && deps.config.synthesis === "local") {
        return { ok: false, reason: "no_eligible_provider" };
      }

      // Called for EVERY mode reaching this point ("local" and "allow-remote" alike — "off"
      // already returned undefined above), not only "allow-remote": the appender decides what
      // gets ledgered, this call site never re-implements that rule. See Step 4 in the doc
      // comment above. `resolved` is handed over WHOLE rather than as a `remote` boolean this
      // site derived — the appender re-derives locality from `provider.isLocal` so a caller
      // cannot suppress or fabricate a `model` row by miscomputing it.
      try {
        recordEgress(deps.db, {
          briefKind: deps.briefKind,
          provider: resolved,
          now: deps.now(),
        });
      } catch (err) {
        return { ok: false, reason: "egress_append_failed", detail: redactedErrorDetail(err) };
      }

      // Deliberately `generateMarkdown(prompt, resolved)` — the EXACT provider `resolveForSynthesis`
      // already resolved and classified above — never `LlmRouter.generate()`. `generate()` routes
      // through `fitPromptOrFallback`, whose private `findFallbackRoute` method (`llm/router.ts` —
      // cited by name, not a line number, since this exact comment's own line-number citation
      // already drifted once) can reach a REMOTE provider on context overflow with NO egress row
      // appended and NO `[agents] synthesis` mode check — exactly the two guarantees this function
      // exists to enforce (the `remote` flag ledgered above, and `"local"` refusing a non-local
      // `resolved` before this line is ever reached). Do not "unify" these two call paths — that
      // would reopen an unledgered, mode-blind remote egress path this file was written to close.
      const raced = await raceWithTimeout(
        deps.router.generateMarkdown(prompt, resolved),
        deps.config.synthesisTimeoutMs,
      );
      // `timeout` and `provider_error` are kept as SEPARATE reasons, not merged into one bucket,
      // because `detail` travels to the user on `briefReady` (Task 5's `SynthesisProvenance`):
      // "timeout" means, and only means, the race against `synthesisTimeoutMs` elapsed first —
      // sending someone to look at their timeout setting for a provider auth failure or a
      // malformed response would be a false diagnosis. `provider_error` means the provider call
      // itself REJECTED (network failure, auth rejection, context-window overflow, ...); it did
      // not time out. Do not fold these back into one reason.
      if (raced.kind === "timeout") {
        return { ok: false, reason: "timeout" };
      }
      if (raced.kind === "error") {
        return { ok: false, reason: "provider_error", detail: redactedErrorDetail(raced.error) };
      }
      return { ok: true, markdown: raced.value, model: resolved.modelName, remote };
    },
  };
}
