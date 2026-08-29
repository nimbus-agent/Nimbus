// packages/gateway/src/egress/model-egress.ts

import type { Database } from "bun:sqlite";
import type { LlmGenerateOptions, LlmGenerateResult, LlmProvider } from "../llm/types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * Thrown when the ledger append fails. Distinct from a provider error ON PURPOSE:
 * `agents/_lib/synthesis-llm.ts` maps it back to the `egress_append_failed` outcome, which
 * travels to the user on the `briefReady` notification as `SynthesisProvenance`. Folding it
 * into `provider_error` would send someone to look at their model configuration for a
 * database problem.
 */
export class EgressAppendFailedError extends Error {
  override readonly cause: unknown;
  /**
   * Optional appender-specific diagnostic context — e.g. `egress/chatops-egress.ts` attaches which
   * post kind and (unhashed) channel id was mid-post when the append failed, so a catch far up the
   * call stack (`chatops/chatops-boot.ts`'s `handleMessage`) can log something actionable without
   * re-deriving it. Diagnostics only: never read by a gate, never required by a caller that does
   * not need it — every existing throw site omits it and stays exactly as informative as before.
   */
  readonly context?: Readonly<Record<string, unknown>>;
  constructor(cause: unknown, context?: Readonly<Record<string, unknown>>) {
    super("egress ledger append failed");
    this.name = "EgressAppendFailedError";
    this.cause = cause;
    if (context !== undefined) this.context = context;
  }
}

/**
 * The `model` class appender, and the ONLY one. Supersedes `recordSynthesisEgress`, whose
 * rationale this comment carries forward in full.
 *
 * `"model"` was already a FROZEN `EGRESS_SOURCE_TYPES` member reserved for exactly this
 * ("inference + embeddings, local or remote"). Do not add a source type.
 *
 * WHY IT WRAPS THE PROVIDER RATHER THAN LIVING AT A CALL SITE. `LlmRouter.generate()` is not
 * a chokepoint -- `briefs/brief-llm-adapter.ts` resolves a provider through
 * `selectProvider()` and calls `provider.generate()` directly, and it has a remote arm. An
 * append placed in the router method would have covered one of the two reachable remote
 * paths and left the other silent. Wrapping the provider INSTANCE covers `router.generate`,
 * `generateMarkdown`, every `selectProvider()` caller, and every caller written later,
 * without any of them cooperating. Same shape as `wrapServerSpec()` (I15 / static D10).
 *
 * WHY LOCALITY IS DERIVED HERE, NOT PASSED IN. A caller-supplied `remote` boolean is
 * unverifiable at the append site: passing `false` for a remote provider suppresses the row
 * and puts a FALSE ZERO in the ledger `nimbus prove` reports on; passing `true` for a local
 * one fabricates rows. Reading `provider.isLocal` makes both unrepresentable, so the
 * guarantee holds for a caller that never read this comment. `sync-egress.ts`'s
 * `recordSyncEgress` makes the same choice for `LOCAL_ONLY_SYNC_SERVICES`, for the same
 * reason.
 *
 * A LOCAL provider is returned UNCHANGED -- identity, not a pass-through wrapper. A local
 * generate makes no outbound request, so ledgering it would over-claim egress.
 *
 * WRAP AT `addRoute`, NEVER AT `registerRoute`. `LlmRegistry.refreshProviderMeta`
 * re-registers an existing route's provider through `registerRoute` to update its meta. That
 * provider is already wrapped, so wrapping inside `registerRoute` would wrap the wrapper and
 * every generate would append twice. Static rule D22(e) pins `registerRoute` to
 * `llm/registry.ts` so this stays true.
 *
 * DO NOT ADD A `__ledgered` MARKER to make re-wrapping idempotent. It was proposed and
 * rejected, for a reason that is not obvious:
 *
 *   - It would be read off the PROVIDER, i.e. off the very object whose egress is being
 *     recorded. Any provider -- including a future third-party or extension-supplied one --
 *     could then set `__ledgered: true` on itself and suppress its own ledger row. That is a
 *     caller-controlled false zero, the exact shape this function derives locality internally
 *     to prevent. A guard that can be satisfied by the thing it guards is not a guard.
 *   - It would make the hazard SILENT rather than impossible. Today a refactor that moved the
 *     wrap into `registerRoute` fails loudly: `audit:invariants` reports D22(e), and the
 *     "re-wrapping double-counts" test goes red. With a marker, that refactor would quietly
 *     work, and both signals would have to be deleted to keep the suite green.
 *   - Reading an undeclared property off `LlmProvider` requires `unknown` narrowing or an
 *     `any` cast; `any` is a Non-Negotiable violation.
 */
export function wrapLedgeredProvider(
  db: Database,
  provider: LlmProvider,
  modelName: string,
  now: () => number = Date.now,
): LlmProvider {
  if (provider.isLocal) {
    return provider;
  }
  // `pullModel` is `.bind`-ed rather than arrow-wrapped because it is OPTIONAL: the
  // conditional spread below needs a value to test, and arrow-wrapping an optional method
  // would need a non-null assertion. The three required members are arrow-wrapped instead,
  // which calls each on `provider` and so preserves its `this` exactly as `.bind` would.
  // The asymmetry is deliberate, not an oversight.
  const pullModel = provider.pullModel?.bind(provider);
  return {
    providerId: provider.providerId,
    isLocal: provider.isLocal,
    isAvailable: () => provider.isAvailable(),
    listModels: () => provider.listModels(),
    ...(pullModel === undefined ? {} : { pullModel }),
    generate: async (opts: LlmGenerateOptions): Promise<LlmGenerateResult> => {
      // Ledger THEN act. An append that throws aborts the call, so a window with no rows
      // means no prompt left the machine -- never that one left unrecorded.
      try {
        appendEgressEntry(db, {
          timestamp: now(),
          sourceType: "model",
          sourceId: modelName,
          destination: provider.providerId,
          method: opts.egressMethod ?? `llm.generate.${opts.task}`,
          payloadSummary: redactEgressSummary({ model: modelName, task: opts.task }),
          hitlStatus: "not_required",
          resultStatus: "authorized",
        });
      } catch (err) {
        throw new EgressAppendFailedError(err);
      }
      return provider.generate(opts);
    },
  };
}
