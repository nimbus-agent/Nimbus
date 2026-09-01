import type { ObservedNode } from "../cu-types.ts";

/**
 * The WHATWG "opaque origin" serialization. `new URL("javascript:alert(1)").origin`,
 * `new URL("data:text/html,x").origin` and `location.origin` on a `data:` document all evaluate to
 * the four-character STRING `"null"`, not the JS value `null`.
 *
 * Observed live during driver bring-up, and it is not cosmetic. `ObservedNode.hrefOrigin` and
 * `BrowserLane.currentOrigin()` are typed `string | null` and every consumer reads `null` as "there
 * is no origin here". Passing the string through instead makes two opaque origins COMPARE EQUAL:
 * `classifyBrowserAction`'s navigate branch would read a `data:` page navigating to another
 * opaque-origin URL as `observing("same-origin navigation")`, and its cross-origin link rule
 * (`hrefOrigin !== currentOrigin`) would stay silent on a `javascript:` href opened from a `data:`
 * page. Both are caught today by the scheme rule and by the gate's envelope check refusing any
 * `navigate` whose target is not a normalized `http(s)` origin — but that is two independent
 * accidents standing in for one correct value, and `cu-request-policy.ts`'s `originOf` already
 * documents the same string as fail-closed "by accident of string inequality" rather than by an
 * explicit check. Here the fix IS explicit: an opaque origin is `null`, so every downstream
 * `!== null` guard falls to its actuating branch.
 */
const OPAQUE_ORIGIN = "null";

/** Normalize an origin as the DOM reports it, collapsing the opaque `"null"` string to JS `null`. */
export function normalizeObservedOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "" || raw === OPAQUE_ORIGIN) return null;
  return raw;
}

/**
 * The DOM properties the classifier reads, computed IN THE PAGE and returned as plain data.
 *
 * Everything `classifyBrowserAction` consumes is derived here, from the live DOM, by the gateway.
 * Nothing the model said reaches this expression — that is what makes the classification structural
 * (invariant I3, transplanted; see `cu-classify.ts`).
 *
 * **`isSubmitControl` means "IS, OR IS A DESCENDANT OF, a submit control"**, resolved with
 * `closest()`. `<button type=submit><span>Pay</span></button>` is the most common submit-button
 * markup on the web and a model's selector routinely resolves to the inner `<span>`; treating that
 * as inert let a form submit with no human in the loop. Verified against a real Chrome during
 * bring-up: `#inner` (the span) reports `true`.
 *
 * **The `form` in the selector list is there to catch `el` BEING a `<form>`, not to make every
 * descendant of one a submit control**, hence the `FORM`-specific guard on the result. Taking the
 * selector literally — the shape the task brief spells out — would classify a click on any `<div>`
 * or `<label>` inside any form as actuating. That is fail-closed but so noisy it trains the owner
 * to approve reflexively, which is the fatigue failure the whole design exists to avoid; and
 * nothing is lost, because a genuinely dangerous target inside a form is still caught by
 * `inFormWithPassword`, by the `type=` rules, by the `BUTTON` rule, and by `submitsForm` + `inForm`.
 *
 * `type` is the RAW attribute (`getAttribute`, not the `.type` IDL property, which canonicalises an
 * unknown value to `"text"`); `cu-classify.ts` lowercases it itself.
 *
 * `hrefScheme`/`hrefOrigin` are resolved against `document.baseURI`, so a relative `href` yields the
 * document's own origin rather than `null` — a `null` there would read as "no href" and take the
 * permissive branch.
 *
 * Written as an IIFE returning a JSON string so the whole result crosses the CDP boundary through
 * `Runtime.evaluate`'s `returnByValue` as one primitive, with no object-handle lifecycle to leak.
 */
export const OBSERVE_EXPRESSION_FN = `(function (sel) {
  var el = document.querySelector(sel);
  if (el === null) return null;
  var submitAncestor = el.closest('button, input[type=submit], input[type=image], form');
  var isSubmit =
    submitAncestor !== null &&
    (submitAncestor.tagName !== 'FORM' || el.tagName === 'FORM');
  var form = el.closest('form');
  var hrefRaw = el.getAttribute('href');
  var scheme = null;
  var origin = null;
  if (hrefRaw !== null) {
    try {
      var u = new URL(hrefRaw, document.baseURI);
      scheme = u.protocol.replace(/:$/, '').toLowerCase();
      origin = u.origin;
    } catch (e) {
      scheme = null;
      origin = null;
    }
  }
  return {
    tagName: el.tagName,
    type: el.getAttribute('type'),
    inForm: form !== null,
    inFormWithPassword: form !== null && form.querySelector('input[type=password]') !== null,
    isSubmitControl: isSubmit,
    hrefScheme: scheme,
    hrefOrigin: origin,
    accessibleName:
      (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 200) || null,
  };
})`;

/** Build the `Runtime.evaluate` expression that observes `selector` and JSON-encodes the result. */
export function observeExpression(selector: string): string {
  // `JSON.stringify` on the selector, not string concatenation: a selector is model-supplied and
  // reaches the page as source text, so an unescaped quote would be a script-injection seam into
  // the gateway's OWN evaluation — the one place in this lane where page content and gateway code
  // share a parser.
  return `JSON.stringify((${OBSERVE_EXPRESSION_FN})(${JSON.stringify(selector)}))`;
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Parse the page-side observation into an {@link ObservedNode}, or `null`.
 *
 * A REAL guard, not an `as ObservedNode` cast, for the reason the whole file exists: this value
 * crosses a process boundary from a renderer that is executing attacker-controlled script, so it is
 * `unknown` (non-negotiable 7) no matter that the gateway wrote the expression that produced it. A
 * page can redefine `JSON.stringify`, `Element.prototype.closest` or `Object.prototype` and hand
 * back whatever shape it likes.
 *
 * FAIL-CLOSED IN THE DIRECTION THAT MATTERS: the three booleans the classifier reads
 * (`isSubmitControl`, `inForm`, `inFormWithPassword`) are `!== false` rather than `=== true`, so a
 * page that returns a missing, `null`, `0` or `"no"` value for one of them gets the ACTUATING
 * branch and a human in the loop. Only a literal `false` — which the honest expression above is the
 * only thing that produces — reaches the permissive side. `tagName` is uppercased here because
 * `cu-classify.ts` compares it against `"BUTTON"` verbatim, and a page returning `"button"` must not
 * slip past that comparison.
 */
export function parseObservedNode(raw: unknown): ObservedNode | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const tagName = o["tagName"];
  if (typeof tagName !== "string" || tagName === "") return null;
  return {
    tagName: tagName.toUpperCase(),
    type: optionalString(o["type"]),
    inForm: o["inForm"] !== false,
    inFormWithPassword: o["inFormWithPassword"] !== false,
    isSubmitControl: o["isSubmitControl"] !== false,
    hrefScheme: typeof o["hrefScheme"] === "string" ? o["hrefScheme"].toLowerCase() : null,
    hrefOrigin: normalizeObservedOrigin(o["hrefOrigin"]),
    accessibleName: optionalString(o["accessibleName"]),
  };
}

/**
 * Decode the JSON string {@link observeExpression} evaluates to.
 *
 * A malformed or non-string payload yields `null`, which the gate treats as "target node could not
 * be observed" — `classifyBrowserAction`'s actuating branch. Never throws: a page that breaks its
 * own JSON serialization must produce a consent prompt, not an unhandled rejection that the gate
 * would have to guess the meaning of.
 */
export function decodeObservation(value: unknown): ObservedNode | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return parseObservedNode(parsed);
}
