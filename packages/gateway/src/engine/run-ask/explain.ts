import { resolvePersona } from "../../config/persona.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import { getExplainToolCalls } from "../agent-request-context.ts";
import type { AskExplainRecorder } from "../ask-explain-recorder.ts";
import type {
  AskExplainRecord,
  BaseExplainRecord,
  LocalCandidate,
  PrimaryRetrieval,
} from "../ask-explain-types.ts";
import type { ContextTruncation } from "../context-truncation-disclosure.ts";
import type { PlanResult } from "../planner.ts";
import type { StepBudgetExhausted } from "../step-budget.ts";
import type { DiscardedTailEntry } from "./candidate-pool.ts";
import type { LocalIndexedContext } from "./local-context.ts";
import { runAskLog } from "./log.ts";

/**
 * The `RunAskParams` fields the explain record reads. Structural, so `RunAskParams` is assignable and
 * this module never imports `run-ask.ts` back.
 */
export type ExplainParams = {
  readonly input: string;
  readonly clientId: string;
  readonly paths: Pick<PlatformPaths, "configDir">;
  readonly explainRecorder?: AskExplainRecorder | undefined;
};

/**
 * The retrieval trace of a local pool built for this turn (spec §4.2) — the payload of the
 * `local_context` route, and of `agent_tools`'s `localContextAlsoGiven` on a local-router
 * fallback. One shape for both, built by {@link localContextExplainFields}.
 */
export type LocalContextExplain = {
  readonly searchTerms: string;
  readonly primaryRetrieval: PrimaryRetrieval;
  readonly fallbackTermFired?: string;
  readonly truncation: ContextTruncation;
  readonly pool: readonly LocalCandidate[];
  readonly discardedTail: readonly DiscardedTailEntry[];
};

/**
 * What a route contributes to the explain record beyond the shared `BaseExplainRecord` fields
 * (spec §4.2). One MUTABLE field on {@link ExplainPartial}, filled in as the turn progresses —
 * never a per-arm closure, the same rule I35's gate learned: state a single exit point must
 * write belongs in ONE place, or it is two places for it to go missing.
 */
export type ExplainRoute =
  | { readonly kind: "empty_index" }
  | ({ readonly kind: "local_context" } & LocalContextExplain)
  | {
      readonly kind: "agent_tools";
      /**
       * Set only on the local-router fallback path (spec §4.2 follow-up): `promptWithContext` is
       * built ONCE, above the router-vs-agent fork, so a local pool built for this turn was
       * genuinely handed to the agent on fallback, not silently dropped. Absent means none was
       * built, never that it was lost.
       */
      readonly localContextAlsoGiven?: LocalContextExplain;
    }
  | { readonly kind: "plan_dispatch"; readonly plan: string };

/**
 * The single mutable record `runAsk` threads through `runAskInner` and every helper it calls,
 * filled in as the turn progresses so `runAsk`'s `finally`-shaped wrapper can build an
 * {@link AskExplainRecord} on EITHER exit path — success or throw (spec §4.2) — from whatever got
 * captured before the throw. `stage` is read only on the failure path; the successful route
 * variants carry no stage at all.
 */
export type ExplainPartial = {
  stage: "classification" | "retrieval" | "model" | "dispatch";
  classifier?: BaseExplainRecord["classifier"];
  modelRoute?: BaseExplainRecord["modelRoute"];
  fallbackFromLocalRouter?: { readonly error: string };
  stepBudgetExhausted?: StepBudgetExhausted;
  route?: ExplainRoute;
};

/**
 * The explain route a conversational turn reports (spec §4.2).
 *
 * `toolless` means the LOCAL ROUTER answered this turn with no fallback — the same signal
 * `appendDeterministicDisclosures` uses to decide the negation-tools-unavailable line. Only
 * then does the route report the indexed-context retrieval trace Task 4 built AS THE PRIMARY
 * route payload; a fallback to the Mastra agent (or an agent turn that never had local context
 * to begin with) is reported as `agent_tools`, with `fallbackFromLocalRouter` carrying the
 * local-router failure alongside it (spec §4.2) — the two are not mutually exclusive.
 *
 * A fallback turn does NOT lose the local pool, though: `promptWithContext` is built ONCE,
 * above the router-vs-agent fork in `run-conversational-agent.ts`, and `runTurn` hands that
 * SAME `promptArg` to the agent on fallback — so a pool built for this turn genuinely reached
 * the model's prompt even when the route is `agent_tools`. `localContextAlsoGiven` carries it
 * there, additively, only when one was actually built (`shouldBuildLocalContext` is false on
 * the pure agent route, so a non-fallback `agent_tools` turn never sets this).
 */
export function conversationalExplainRoute(
  toolless: boolean,
  localContext: LocalIndexedContext | undefined,
): ExplainRoute {
  if (localContext === undefined) {
    return { kind: "agent_tools" };
  }
  const fields = localContextExplainFields(localContext);
  return toolless
    ? { kind: "local_context", ...fields }
    : { kind: "agent_tools", localContextAlsoGiven: fields };
}

/**
 * {@link LocalContextExplain} for a built pool. ONE builder for both places the trace lands —
 * the `local_context` route and `agent_tools`'s `localContextAlsoGiven` — so the two cannot drift.
 */
function localContextExplainFields(localContext: LocalIndexedContext): LocalContextExplain {
  return {
    searchTerms: localContext.explain.searchTerms,
    primaryRetrieval: localContext.explain.primaryRetrieval,
    ...(localContext.explain.fallbackTermFired === undefined
      ? {}
      : { fallbackTermFired: localContext.explain.fallbackTermFired }),
    truncation: localContext.truncation,
    pool: localContext.explain.pool,
    discardedTail: localContext.explain.discardedTail,
  };
}

/** A one-line, human-readable summary of a resolved plan for the explain record (spec §4.2). */
export function describePlan(plan: PlanResult): string {
  return plan.kind === "reply"
    ? `reply: ${plan.text}`
    : `actions: ${plan.actions.map((a) => a.type).join(", ")}`;
}

const CLASSIFIER_NOT_CALLED_DEFAULT: BaseExplainRecord["classifier"] = {
  called: false,
  reason: "classification did not run before this ask concluded",
};

function describeExplainError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Assembles the {@link AskExplainRecord} `runAsk`'s wrapper records on EVERY exit path (spec
 * §4.2). `error === undefined` is success; anything else is the "failed" route, reporting
 * whatever stage `partial.stage` had most recently advanced to before the throw. Persona is
 * resolved fresh here (matching `resolvePersona`'s own per-invocation, no-cache contract) rather
 * than threaded through `partial`, so every route — including ones that never touch the
 * conversational path at all — gets one.
 */
function buildExplainRecord(
  p: ExplainParams,
  partial: ExplainPartial,
  startedAt: number,
  error: unknown,
): AskExplainRecord {
  const base = {
    askedAt: startedAt,
    durationMs: Date.now() - startedAt,
    question: p.input,
    source: p.clientId === "chatops" ? ("chatops" as const) : ("local" as const),
    persona: (() => {
      const persona = resolvePersona(p.paths.configDir);
      return `${persona.tone}/${persona.voice}`;
    })(),
    classifier: partial.classifier ?? CLASSIFIER_NOT_CALLED_DEFAULT,
    ...(partial.modelRoute === undefined ? {} : { modelRoute: partial.modelRoute }),
    ...(partial.fallbackFromLocalRouter === undefined
      ? {}
      : { fallbackFromLocalRouter: partial.fallbackFromLocalRouter }),
    ...(partial.stepBudgetExhausted === undefined
      ? {}
      : { stepBudgetExhausted: partial.stepBudgetExhausted }),
  };

  if (error !== undefined) {
    // `partial.route` is only ever `plan_dispatch`-shaped when the throw happened at (or after)
    // the "dispatch" stage — carry the plan along so a dispatch-stage failure doesn't discard the
    // one piece of context ("what was being attempted") a connector/executor error needs.
    const plan =
      partial.stage === "dispatch" && partial.route?.kind === "plan_dispatch"
        ? partial.route.plan
        : undefined;
    return {
      ...base,
      route: "failed",
      stage: partial.stage,
      error: describeExplainError(error),
      ...(plan === undefined ? {} : { plan }),
    };
  }

  // Absent only if a future route forgets to set it before returning — default to `agent_tools`
  // with no tool calls rather than throw a second, confusing error out of the recording path
  // itself (recording must never break the user's answer, which by now has already succeeded).
  const route = partial.route ?? { kind: "agent_tools" as const };
  switch (route.kind) {
    case "empty_index":
      return { ...base, route: "empty_index" };
    case "local_context":
      return {
        ...base,
        route: "local_context",
        searchTerms: route.searchTerms,
        primaryRetrieval: route.primaryRetrieval,
        ...(route.fallbackTermFired === undefined
          ? {}
          : { fallbackTermFired: route.fallbackTermFired }),
        truncation: route.truncation,
        pool: route.pool,
        discardedTail: route.discardedTail,
      };
    case "agent_tools":
      // Task 5's collector, drained here: the four `runAsk` call sites (the three
      // `ipc/server/inline-handlers.ts` sites and the ChatOps one `gateway-main.ts` wraps
      // explicitly) already run inside `agentRequestContext.run(...)`, so a store exists by the
      // time this drains it. `?? []` covers a caller outside any such context (a bare unit test):
      // no store means no calls to report, not an error.
      return {
        ...base,
        route: "agent_tools",
        toolCalls: [...(getExplainToolCalls() ?? [])],
        ...(route.localContextAlsoGiven === undefined
          ? {}
          : { localContextAlsoGiven: route.localContextAlsoGiven }),
      };
    case "plan_dispatch":
      return { ...base, route: "plan_dispatch", plan: route.plan };
  }
}

/**
 * `runAsk` records exactly one {@link AskExplainRecord} per call, on EVERY exit path — success or
 * throw (spec §4.2). A caller that only recorded on success would leave `explain last` showing
 * the PREVIOUS successful ask at the moment the user most needs the truth, so the whole body runs
 * inside `runAskInner`, which mutates one `ExplainPartial` as the turn progresses, and this
 * wrapper builds the record from whatever got captured — complete on success, partial on throw —
 * without changing what the caller receives or throws either way. `p.explainRecorder` is
 * optional: absent, nothing is recorded and this wrapper costs one object allocation.
 */
/**
 * The ONE place both `runAsk` exit paths go through to record — deliberately, so the "recording
 * must never affect the answer" guarantee lives in a single spot rather than two call sites that
 * must each remember it (the same lesson Task 5 learned the hard way over `recordExplainToolCall`,
 * where `redactAuditPayload` was evaluated as an argument OUTSIDE its own try/catch: on the
 * success arm it sat after the guard and a throw discarded an already-computed successful result;
 * on the error arm it replaced the original error). Both `buildExplainRecord` AND `.record()` run
 * INSIDE the try, so a future field added to `buildExplainRecord` that reads something throwable
 * cannot reintroduce this by construction — there is no unguarded call site left to reintroduce it
 * at. A failure here is swallowed (logged, best-effort): a diagnostic about what happened to an
 * ask must never change what the caller receives or throws.
 */
export function recordExplainSafely(
  p: ExplainParams,
  partial: ExplainPartial,
  startedAt: number,
  error: unknown,
): void {
  if (p.explainRecorder === undefined) {
    return;
  }
  try {
    p.explainRecorder.record(buildExplainRecord(p, partial, startedAt, error));
  } catch (e) {
    runAskLog.warn(
      { err: e },
      "failed to build/record an ask-explain entry; the answer itself is unaffected",
    );
  }
}
