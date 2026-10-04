import type { SubTask } from "../../engine/coordinator.ts";

/**
 * A `SubTask` that runs a LOCAL function instead of calling the model.
 *
 * The `AgentCoordinator` fan-out machinery is uniform over `SubTask`, so a lane
 * that is pure local computation (a SQL read, a graph walk) still has to present
 * as one. `prompt: ""` and zero token counts are what say "this lane spent
 * nothing" — an agent's reported token usage stays truthful because these lanes
 * contribute zero rather than an estimate.
 *
 * The result is JSON round-tripped through `text` because that is the only
 * channel `SubTask.execute` offers; `decode` is its inverse.
 *
 * Every agent whose lanes are local computation builds them here. Byte-identical
 * copies of this and `decode` once lived in `agents/decisions.ts`,
 * `agents/glossary.ts` and `agents/ownership.ts`; `agents/negotiate.ts` carried a
 * copy of this under another name; and `catchup`, `expert`, `impact` and `why`
 * each carried a near-copy wrapping lanes declared `async` with nothing to await.
 * An agent written by copying any of them would have carried one more.
 */
export function subAgent(fn: () => unknown): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    // `Promise.try`, not an `async` arrow with nothing to await. It still calls `fn`
    // only when the coordinator runs the lane, and a throw from `fn` (a failed SQL
    // read) still REJECTS — which the coordinator turns into a failed-lane result —
    // instead of escaping synchronously from a function typed to return a Promise.
    execute: () => Promise.try(() => ({ text: JSON.stringify(fn()), tokensIn: 0, tokensOut: 0 })),
  };
}

/**
 * Inverse of `subAgent`'s JSON encoding, falling back rather than throwing.
 *
 * A lane that produced no text (cancelled, or a coordinator slot that never
 * ran) and a lane that produced unparseable text are treated the same way: the
 * caller's `fallback` stands in. That is deliberate — a brief renders what it
 * has and reports the gap, rather than failing the whole fan-out because one
 * lane came back empty.
 */
export function decode<T>(text: string | undefined, fallback: T): T {
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
