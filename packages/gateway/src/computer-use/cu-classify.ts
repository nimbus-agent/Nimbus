import type { CuActionClass } from "./cu-types.ts";

/**
 * What the GATEWAY observed about the target node, derived from the DOM via CDP.
 *
 * Every field here is a fact the gateway computed. There is deliberately no field carrying the
 * model's description, intent, or rationale — see the header on `classifyBrowserAction`.
 */
export interface ObservedNode {
  readonly tagName: string;
  readonly type: string | null;
  /** True when the node sits inside a <form> that contains an <input type="password">. */
  readonly inFormWithPassword: boolean;
  /** <button type=submit>, <input type=submit>, or a form submission. */
  readonly isSubmitControl: boolean;
  /** Shown to the human in the prompt. NEVER read by the classifier. */
  readonly accessibleName: string | null;
}

export interface BrowserActionInput {
  readonly kind: "click" | "type" | "navigate" | "read" | "screenshot" | "download";
  readonly node: ObservedNode | null;
  readonly currentOrigin: string | null;
  readonly targetOrigin: string | null;
}

/**
 * Derive the HITL class from the OBSERVED target (I35, spec § 4.3).
 *
 * This is invariant I3 transplanted from the executor. I3: the HITL gate consults `action.type`
 * only, never `payload.mcpToolId` — gate on a property the gateway controls, never on one the
 * caller supplies. Here: the classifier reads `BrowserActionInput`, every field of which the
 * gateway derived from the DOM, and the model's natural-language description is NOT a parameter.
 * It is rendered in the consent prompt for the human's benefit and reaches no decision.
 *
 * A design where the model can say "this is just a read" and be believed has no gate at all.
 *
 * FAIL-CLOSED on an uncharacterisable node: a click with no observed node classifies `actuating`,
 * because the absence of evidence about a target is not evidence that the target is safe.
 */
export function classifyBrowserAction(input: BrowserActionInput): {
  readonly cls: CuActionClass;
  readonly why: string;
} {
  const actuating = (why: string) => ({ cls: "actuating" as const, why });

  if (input.kind === "download") return actuating("initiates a download");
  if (input.kind === "read" || input.kind === "screenshot") {
    return { cls: "observing", why: `${input.kind} does not actuate` };
  }
  if (input.kind === "navigate") {
    return input.targetOrigin !== null && input.targetOrigin !== input.currentOrigin
      ? actuating(`cross-origin navigation to ${input.targetOrigin}`)
      : { cls: "observing", why: "same-origin navigation" };
  }

  const n = input.node;
  if (n === null) return actuating("target node could not be observed");
  if (n.isSubmitControl) return actuating("submit control");
  if (n.type === "file") return actuating("file upload control");
  if (n.inFormWithPassword) return actuating("field inside a form containing a password input");
  return {
    cls: "observing",
    why: `${n.tagName.toLowerCase()} interaction with no actuating property`,
  };
}
