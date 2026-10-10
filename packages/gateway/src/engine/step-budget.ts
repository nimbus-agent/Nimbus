/**
 * Step-budget exhaustion on the conversational agent path (`nimbus ask` / `agent.invoke`).
 *
 * The Mastra agent runs with `maxSteps = Config.conversationalAgentMaxSteps` (env
 * `NIMBUS_ASK_MAX_STEPS`, default 20). When that cap stops a turn while the model still wanted to
 * call tools, the text it returns is whatever it had produced so far — a well-formed answer that
 * may be missing the tool results it was about to fetch. Left silent, a reader cannot tell it
 * from a complete one, so the gateway discloses it DETERMINISTICALLY (never by asking the model),
 * records it on the explain record, and tells the acting IPC session via `agent.gasLimitReached`.
 */

/** What exhaustion looked like: the cap in force and how many steps the agent reported. */
export type StepBudgetExhausted = { readonly cap: number; readonly used: number };

/**
 * Payload of the unicast `agent.gasLimitReached` notification (minus `streamId`, which only the
 * IPC entry knows). `limit` is a discriminant so a later limit kind is additive; only `"steps"`
 * is emitted — coordinator depth / tool-call caps fail the call instead (`AgentLimitError`).
 */
export type GasLimitEvent = {
  readonly limit: "steps";
  readonly cap: number;
  readonly used: number;
};

/** Callback threaded from the IPC entry to the conversational turn. Absent = disclosure only. */
export type NotifyGasLimit = (event: GasLimitEvent) => void;

export const GAS_LIMIT_REACHED_NOTIFICATION = "agent.gasLimitReached";

/** The fixed disclosure appended to an exhausted turn's reply. */
export function stepBudgetExhaustedLine(cap: number): string {
  return (
    `Note: this answer stopped at the ${String(cap)}-step tool budget before the model finished; ` +
    "it may be incomplete. Raise NIMBUS_ASK_MAX_STEPS to allow more."
  );
}

/**
 * Exhausted iff the model's last step still ended in tool calls (`finishReason === "tool-calls"`)
 * AND the agent ran at least `cap` steps. Either alone is not enough: a turn that finished with
 * `"stop"` exactly at the cap completed normally, and a `"tool-calls"` finish below the cap was
 * not stopped by the budget. Inputs are `unknown` — they come from `@mastra/core`'s output object,
 * which a test double (or a future SDK version) may not populate.
 */
export function detectStepBudgetExhaustion(
  finishReason: unknown,
  steps: unknown,
  cap: number,
): StepBudgetExhausted | undefined {
  if (finishReason !== "tool-calls" || !Array.isArray(steps)) return undefined;
  if (steps.length < cap) return undefined;
  return { cap, used: steps.length };
}
