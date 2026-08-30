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
  /** True when the node sits inside any <form>, password or not (I7: keypress submission). */
  readonly inForm: boolean;
  /**
   * True when the node IS a submit control, OR IS A DESCENDANT of one (the producer resolves this
   * with `closest()`). `<button type=submit><span>Pay</span></button>` is the most common submit
   * button markup on the web: the model's selector commonly resolves to the inner `<span>`, the
   * click bubbles, and the form submits — so "is a submit control" alone is the wrong contract.
   */
  readonly isSubmitControl: boolean;
  /**
   * Lowercased scheme of the node's href (e.g. "https", "javascript"), or null when it has no
   * href. Supplied by the producer.
   */
  readonly hrefScheme: string | null;
  /** Origin the node's href points to, or null when it has no href / the href is unparseable. */
  readonly hrefOrigin: string | null;
  /** Shown to the human in the prompt. NEVER read by the classifier. */
  readonly accessibleName: string | null;
}

export interface BrowserActionInput {
  readonly kind: "click" | "type" | "navigate" | "read" | "screenshot" | "download";
  readonly node: ObservedNode | null;
  readonly currentOrigin: string | null;
  readonly targetOrigin: string | null;
  /**
   * True when this `type` action (e.g. pressing Enter) submits its enclosing form. Absent/false by
   * default. Not reachable in the shipped surface yet — the planned `type` action uses Playwright
   * `fill()`, which never presses Enter — but the contract is fixed now, before a key-press action
   * makes it reachable (I7).
   */
  readonly submitsForm?: boolean;
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
 * DEFAULT-DENY (fix round 1): this function defaults to `actuating`. `observing` — meaning "no
 * human ever sees this action" — is reachable ONLY from an explicit, proven-safe case:
 *   - a `read`/`screenshot`, which has no target at all;
 *   - a `navigate` whose current and target origins are both known and equal;
 *   - a `click`/`type` on an observed node that fails EVERY actuating rule below.
 * Every other input — including a shape this function's authors never anticipated — falls to the
 * final `actuating("no rule proved this action inert")`. The absence of evidence that a target is
 * dangerous is not evidence that it is safe.
 */
export function classifyBrowserAction(input: BrowserActionInput): {
  readonly cls: CuActionClass;
  readonly why: string;
} {
  const actuating = (why: string) => ({ cls: "actuating" as const, why });
  const observing = (why: string) => ({ cls: "observing" as const, why });

  if (input.kind === "download") return actuating("initiates a download");

  if (input.kind === "read" || input.kind === "screenshot") {
    return observing(`${input.kind} does not actuate`);
  }

  if (input.kind === "navigate") {
    if (
      input.currentOrigin !== null &&
      input.targetOrigin !== null &&
      input.currentOrigin === input.targetOrigin
    ) {
      return observing("same-origin navigation");
    }
    // C1: a null target origin (javascript:/data:/about: or a malformed URL) is NOT evidence of
    // safety — such a navigation issues no network request, so `decideRequest` is never consulted
    // and this is the only gate a `javascript:` navigation (arbitrary script execution) ever meets.
    return actuating(
      input.targetOrigin === null
        ? "navigation target origin could not be determined"
        : `cross-origin navigation to ${input.targetOrigin}`,
    );
  }

  // input.kind is now "click" | "type".
  const n = input.node;
  if (n === null) return actuating("target node could not be observed");

  // C2: isSubmitControl means "is, or is a descendant of, a submit control".
  if (n.isSubmitControl) return actuating("submit control, or a descendant of one");

  // I5: the HTML `type` attribute is case-insensitive; lowercase once before all comparisons.
  const type = n.type === null ? null : n.type.toLowerCase();

  if (type === "file") return actuating("file upload control");

  // I6: an independent rule, even though the producer also computes `isSubmitControl` — resting
  // form-submit detection on a single page-evaluated boolean is a needless single point of
  // failure. This is the belt to that braces, not a replacement for it.
  if (type === "submit" || type === "image" || type === "reset") {
    return actuating(`input[type=${type}] is itself a submit control`);
  }
  if (n.tagName === "BUTTON") return actuating("button element is a submit control by default");

  if (n.inFormWithPassword) {
    return actuating("field inside a form containing a password input");
  }

  // C3: a non-http(s) href scheme (javascript:/data:/about:/etc.) makes an ordinary-looking <a>
  // arbitrary script execution or worse, with no human in the loop.
  if (n.hrefScheme !== null && n.hrefScheme !== "http" && n.hrefScheme !== "https") {
    return actuating(`non-http(s) href scheme: ${n.hrefScheme}`);
  }

  // I4: a click that navigates cross-origin must consult the origins too — only `kind:"navigate"`
  // did before this fix.
  if (n.hrefOrigin !== null && n.hrefOrigin !== input.currentOrigin) {
    return actuating(`link targets a different origin: ${n.hrefOrigin}`);
  }

  // I7: typing Enter into a non-password form submits it. `submitsForm` defaults to false/absent,
  // so this rule is inert until a key-press action exists in the shipped surface.
  if (input.submitsForm === true && n.inForm) {
    return actuating("submits the enclosing form");
  }

  // Re-derive the same safety condition explicitly, rather than relying on "we fell through every
  // check above" implicitly: if a future edit ever deletes one of the early returns above without
  // updating this expression, this still fails closed to the final `actuating` statement below.
  const provenInert =
    !n.isSubmitControl &&
    type !== "file" &&
    type !== "submit" &&
    type !== "image" &&
    type !== "reset" &&
    n.tagName !== "BUTTON" &&
    !n.inFormWithPassword &&
    (n.hrefScheme === null || n.hrefScheme === "http" || n.hrefScheme === "https") &&
    (n.hrefOrigin === null || n.hrefOrigin === input.currentOrigin) &&
    !(input.submitsForm === true && n.inForm);

  if (provenInert) {
    return observing(`${n.tagName.toLowerCase()} interaction with no actuating property`);
  }

  return actuating("no rule proved this action inert");
}
