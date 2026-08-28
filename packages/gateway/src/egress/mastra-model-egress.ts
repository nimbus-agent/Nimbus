// packages/gateway/src/egress/mastra-model-egress.ts

import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

/**
 * The SECOND `model`-class appender, and the reason there are two.
 *
 * `wrapLedgeredProvider` (`model-egress.ts`) covers the ROUTE TABLE. The Mastra engine agent does
 * not use the route table: it resolves its model through `@mastra/core` and keeps its own HTTP
 * client, and that client is what makes tool-calling work. `LlmGenerateOptions` has no `tools`
 * field, so an adapter built over `LlmProvider` would silently kill the agent's tool-calling —
 * including the three negation tools, which live only on this path. The property wanted (one
 * ledger, air-gap honoured, one opt-in) is therefore achieved at the AI-SDK seam instead.
 *
 * ACCEPTED COST, stated rather than hidden: after slice 2b there are two HTTP clients for
 * Anthropic — `llm/anthropic-provider.ts` for the route table and Mastra's own for the agent. The
 * agent loop is Mastra's, so its wire is Mastra's; the route table is ours, so its wire is ours.
 * Both are ledgered, by their respective wrappers.
 *
 * Intercepts `doGenerate` / `doStream` ONLY. Everything else passes through, so Mastra keeps its
 * client, its tool-calling and its streaming.
 *
 * This file lives in `egress/` and not beside the agent because static rule D22(b) confines the
 * `appendEgressEntry` identifier to `packages/gateway/src/egress/` — the same reason
 * `wrapLedgeredProvider` lives here rather than in `llm/`.
 */
export function wrapLedgeredMastraModel<T extends object>(
  db: Database,
  inner: T,
  meta: { providerId: string; modelId: string; now?: () => number },
): T {
  const now = meta.now ?? Date.now;

  const ledger = (method: string): void => {
    // Ledger THEN act, and abort on failure — the same fail-closed order as the route-table
    // wrapper. A window with no rows means no prompt left the machine, never that one left
    // unrecorded.
    try {
      appendEgressEntry(db, {
        timestamp: now(),
        sourceType: "model",
        sourceId: meta.modelId,
        destination: meta.providerId,
        method,
        payloadSummary: redactEgressSummary({ model: meta.modelId, via: "mastra" }),
        hitlStatus: "not_required",
        resultStatus: "authorized",
      });
    } catch (err) {
      throw new EgressAppendFailedError(err);
    }
  };

  return new Proxy(inner, {
    // No `receiver` parameter: every `Reflect.get` below deliberately passes `target` instead,
    // so accepting it would only invite someone to use it. See the note further down.
    get(target, prop) {
      if (prop === "doGenerate" || prop === "doStream") {
        const method = prop === "doGenerate" ? "engine.agent.generate" : "engine.agent.stream";
        // ASYNC, so a ledger failure surfaces as a REJECTED PROMISE rather than a synchronous
        // throw. Both `doGenerate` and `doStream` are promise-returning in the AI-SDK contract,
        // and Mastra's call sites handle a rejection; a synchronous throw from what is declared
        // to return a promise escapes that handling and unwinds somewhere unexpected. It also
        // matches `wrapLedgeredProvider.generate`, so both `model`-class appenders fail the same
        // way.
        return async (...args: unknown[]) => {
          ledger(method);
          return await (Reflect.get(target, prop, target) as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
        };
      }
      // A Proxy rather than a hand-built object literal: `ModelRouterLanguageModel` carries
      // private (`#`) fields, and copying its surface field-by-field would break on the next
      // Mastra release that adds one.
      //
      // RECEIVER IS `target`, NOT `receiver`. If any public member is (or becomes) a GETTER that
      // reads a `#private` field, invoking it with the Proxy as receiver binds `this` to the
      // Proxy and throws `TypeError: Cannot read private member from an object whose class did
      // not declare it`. Verified on @mastra/core 1.61.0 that its current public surface is plain
      // data fields, so both forms work TODAY — this is insurance against a routine upstream
      // refactor, not a fix for a live break. It is also correct on its own terms: a decorator
      // has no business changing `this` for the target's own accessors.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
