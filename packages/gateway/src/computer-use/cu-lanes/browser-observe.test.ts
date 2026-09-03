import { describe, expect, test } from "bun:test";
import { classifyBrowserAction } from "../cu-classify.ts";
import {
  decodeObservation,
  normalizeObservedOrigin,
  observeExpression,
  parseObservedNode,
} from "./browser-observe.ts";

describe("normalizeObservedOrigin", () => {
  test('the WHATWG opaque origin — the STRING "null" — becomes JS null', () => {
    // `new URL("javascript:alert(1)").origin` and `location.origin` on a `data:` document both
    // evaluate to this four-character string. Passing it through makes two opaque origins COMPARE
    // EQUAL, which is what would let the classifier read a `data:` page navigating to another
    // opaque-origin URL as a same-origin navigation.
    expect(normalizeObservedOrigin("null")).toBeNull();
  });

  test("a real origin passes through unchanged", () => {
    expect(normalizeObservedOrigin("https://example.com")).toBe("https://example.com");
  });

  test("a non-string or empty value is null, never coerced", () => {
    expect(normalizeObservedOrigin(undefined)).toBeNull();
    expect(normalizeObservedOrigin(42)).toBeNull();
    expect(normalizeObservedOrigin("")).toBeNull();
  });

  test("two opaque origins do not classify as a same-origin navigation", () => {
    // The property the collapse buys, asserted through the real classifier rather than restated.
    const verdict = classifyBrowserAction({
      kind: "navigate",
      node: null,
      currentOrigin: normalizeObservedOrigin("null"),
      targetOrigin: normalizeObservedOrigin("null"),
    });
    expect(verdict.cls).toBe("actuating");
  });
});

describe("observeExpression", () => {
  test("the selector is JSON-escaped, so a quote cannot break out of the evaluated source", () => {
    // A selector is MODEL-SUPPLIED and reaches the page as source text: this is the one place in
    // the lane where page content and gateway code share a parser.
    const expr = observeExpression('a[href="x"]');
    expect(expr).toContain('"a[href=\\"x\\"]"');
    expect(expr).not.toContain('("a[href="x"]")');
  });

  test("the expression evaluates to a JSON STRING, so nothing crosses CDP as an object handle", () => {
    expect(observeExpression("#go").startsWith("JSON.stringify(")).toBe(true);
  });
});

describe("parseObservedNode — a REAL guard over renderer-supplied data", () => {
  const honest = {
    tagName: "input",
    type: "TEXT",
    inForm: false,
    inFormWithPassword: false,
    isSubmitControl: false,
    hrefScheme: null,
    hrefOrigin: null,
    accessibleName: "Search",
  };

  test("an honest observation parses, and tagName is UPPERCASED", () => {
    // `cu-classify.ts` compares `tagName` against the literal "BUTTON"; a page returning "button"
    // must not slip past that comparison.
    const n = parseObservedNode(honest);
    expect(n?.tagName).toBe("INPUT");
  });

  test("the raw `type` attribute is preserved, NOT canonicalised", () => {
    // The classifier lowercases it itself (its I5 rule); doing it here too would be fine, but
    // silently rewriting an unknown value the way the `.type` IDL property does would not.
    expect(parseObservedNode(honest)?.type).toBe("TEXT");
  });

  test.each([[null], [undefined], [42], ["str"], [[]], [{}], [{ tagName: "" }], [{ tagName: 7 }]])(
    "a shape with no usable tagName yields null: %p",
    (raw) => {
      expect(parseObservedNode(raw)).toBeNull();
    },
  );

  test.each([["isSubmitControl"], ["inForm"], ["inFormWithPassword"]])(
    "%s FAILS CLOSED — only a literal false is permissive",
    (field) => {
      // A hostile page can redefine `JSON.stringify` and hand back anything. `!== false` means a
      // missing, null, 0 or "no" value takes the ACTUATING branch and a human sees the prompt.
      for (const hostile of [undefined, null, 0, "", "no", NaN]) {
        const n = parseObservedNode({ ...honest, [field]: hostile });
        expect(n?.[field as "isSubmitControl"]).toBe(true);
      }
      expect(parseObservedNode({ ...honest, [field]: false })?.[field as "inForm"]).toBe(false);
    },
  );

  test("a hostile isSubmitControl actually reaches an ACTUATING verdict", () => {
    // The fail-closed default is only worth something if it changes the classification.
    const n = parseObservedNode({ ...honest, tagName: "SPAN", isSubmitControl: "nope" });
    const verdict = classifyBrowserAction({
      kind: "click",
      node: n,
      currentOrigin: "https://example.com",
      targetOrigin: null,
    });
    expect(verdict.cls).toBe("actuating");
  });

  test("hrefScheme is lowercased, so `JavaScript:` cannot dodge the scheme rule", () => {
    const n = parseObservedNode({ ...honest, tagName: "A", hrefScheme: "JavaScript" });
    expect(n?.hrefScheme).toBe("javascript");
    expect(
      classifyBrowserAction({
        kind: "click",
        node: n,
        currentOrigin: "https://example.com",
        targetOrigin: null,
      }).cls,
    ).toBe("actuating");
  });

  test('an opaque hrefOrigin ("null") is collapsed to null here too', () => {
    expect(parseObservedNode({ ...honest, hrefOrigin: "null" })?.hrefOrigin).toBeNull();
  });

  test("a non-string accessibleName becomes null rather than reaching the prompt as an object", () => {
    expect(
      parseObservedNode({ ...honest, accessibleName: { toString: 1 } })?.accessibleName,
    ).toBeNull();
  });
});

describe("decodeObservation", () => {
  test("decodes the JSON string the page expression produces", () => {
    const node = decodeObservation(JSON.stringify({ tagName: "BUTTON", isSubmitControl: true }));
    expect(node?.tagName).toBe("BUTTON");
    expect(node?.isSubmitControl).toBe(true);
  });

  test("a page-side null (no element matched) decodes to null", () => {
    expect(decodeObservation("null")).toBeNull();
  });

  test("malformed JSON yields null rather than throwing", () => {
    // The gate reads this null as "target node could not be observed" — the classifier's actuating
    // branch. A throw here would leave the gate guessing what the failure meant.
    expect(decodeObservation("{not json")).toBeNull();
  });

  test("a non-string value (a page that broke its own serialization) yields null", () => {
    expect(decodeObservation(undefined)).toBeNull();
    expect(decodeObservation({ tagName: "BUTTON" })).toBeNull();
  });
});
