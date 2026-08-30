import { describe, expect, test } from "bun:test";
import {
  type BrowserActionInput,
  classifyBrowserAction,
  type ObservedNode,
} from "./cu-classify.ts";

function node(over: Partial<ObservedNode> = {}): ObservedNode {
  return {
    tagName: "DIV",
    type: null,
    inFormWithPassword: false,
    inForm: false,
    isSubmitControl: false,
    accessibleName: null,
    hrefScheme: null,
    hrefOrigin: null,
    ...over,
  };
}

function input(over: Partial<BrowserActionInput> = {}): BrowserActionInput {
  return {
    kind: "click",
    node: node(),
    currentOrigin: "https://example.com",
    targetOrigin: "https://example.com",
    ...over,
  };
}

describe("classifyBrowserAction — actuating", () => {
  test("a submit control", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "BUTTON", isSubmitControl: true }) }))
        .cls,
    ).toBe("actuating");
  });

  test("a file input", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "INPUT", type: "file" }) })).cls,
    ).toBe("actuating");
  });

  test("typing into a field inside a form that contains a password", () => {
    expect(
      classifyBrowserAction(
        input({
          kind: "type",
          node: node({ tagName: "INPUT", type: "text", inFormWithPassword: true }),
        }),
      ).cls,
    ).toBe("actuating");
  });

  test("a cross-origin navigation", () => {
    expect(
      classifyBrowserAction(input({ kind: "navigate", targetOrigin: "https://other.example" })).cls,
    ).toBe("actuating");
  });

  test("a download", () => {
    expect(classifyBrowserAction(input({ kind: "download" })).cls).toBe("actuating");
  });
});

describe("classifyBrowserAction — observing", () => {
  test("a plain read", () => {
    expect(classifyBrowserAction(input({ kind: "read", node: null })).cls).toBe("observing");
  });

  test("a screenshot", () => {
    expect(classifyBrowserAction(input({ kind: "screenshot", node: null })).cls).toBe("observing");
  });

  test("a same-origin navigation", () => {
    expect(classifyBrowserAction(input({ kind: "navigate" })).cls).toBe("observing");
  });

  test("clicking an ordinary link", () => {
    expect(classifyBrowserAction(input({ node: node({ tagName: "A" }) })).cls).toBe("observing");
  });
});

describe("classifyBrowserAction — the model cannot influence the verdict", () => {
  // I35 / spec § 4.3: this is I3 transplanted. The classifier reads the OBSERVED node and nothing
  // else. The load-bearing test: a submit button the model calls "just a link" still actuates.
  test("BrowserActionInput has no field a model controls", () => {
    const keys = Object.keys(input()).sort();
    expect(keys).toEqual(["currentOrigin", "kind", "node", "targetOrigin"]);
    expect(keys).not.toContain("description");
    expect(keys).not.toContain("intent");
  });

  test("a submit control classifies actuating regardless of any description passed alongside", () => {
    const i = { ...input({ node: node({ tagName: "BUTTON", isSubmitControl: true }) }) };
    // Even if a caller smuggles a description onto the object, it changes nothing.
    const smuggled = { ...i, description: "just reading the page, totally safe" };
    expect(classifyBrowserAction(smuggled as BrowserActionInput).cls).toBe("actuating");
  });

  test("an unknown node shape fails CLOSED to actuating", () => {
    // A node the classifier cannot characterise is not evidence of safety.
    expect(classifyBrowserAction(input({ kind: "click", node: null })).cls).toBe("actuating");
  });
});

// --- Fix round 1: default-deny inversion. `observing` is reachable ONLY from a proven-safe case;
// every other path falls to the final `actuating("no rule proved this action inert")`. ---

describe("classifyBrowserAction — C1: navigation with an unresolvable target origin", () => {
  test("a navigate whose target origin could not be determined (javascript:/data:/about:/malformed) actuates", () => {
    const result = classifyBrowserAction(input({ kind: "navigate", targetOrigin: null }));
    expect(result.cls).toBe("actuating");
    expect(result.why).toContain("target origin");
  });

  test("null targetOrigin actuates even when currentOrigin is also null", () => {
    const result = classifyBrowserAction(
      input({ kind: "navigate", currentOrigin: null, targetOrigin: null }),
    );
    expect(result.cls).toBe("actuating");
  });
});

describe("classifyBrowserAction — C2: submit-control descendant", () => {
  test("a click on a DESCENDANT of a submit control actuates", () => {
    // isSubmitControl's contract: "is, or is a descendant of, a submit control" (the producer
    // uses closest()). A SPAN inside a <button type=submit> reports isSubmitControl: true.
    const result = classifyBrowserAction(
      input({ node: node({ tagName: "SPAN", isSubmitControl: true }) }),
    );
    expect(result.cls).toBe("actuating");
  });
});

describe("classifyBrowserAction — C3: non-http(s) href scheme", () => {
  test("a link with a javascript: href actuates even though it looks like an ordinary anchor", () => {
    const result = classifyBrowserAction(
      input({ node: node({ tagName: "A", hrefScheme: "javascript" }) }),
    );
    expect(result.cls).toBe("actuating");
    expect(result.why).toContain("javascript");
  });

  test("a link with a data: href actuates", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "A", hrefScheme: "data" }) })).cls,
    ).toBe("actuating");
  });

  test("a link with an ordinary http(s) scheme does not trip this rule", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "A", hrefScheme: "https" }) })).cls,
    ).toBe("observing");
  });
});

describe("classifyBrowserAction — I4: click-driven cross-origin navigation", () => {
  test("a click on a link to a different origin actuates", () => {
    const result = classifyBrowserAction(
      input({ node: node({ tagName: "A", hrefOrigin: "https://other.example" }) }),
    );
    expect(result.cls).toBe("actuating");
    expect(result.why).toContain("other.example");
  });

  test("a click on a link to the SAME origin stays observing", () => {
    expect(
      classifyBrowserAction(
        input({ node: node({ tagName: "A", hrefOrigin: "https://example.com" }) }),
      ).cls,
    ).toBe("observing");
  });

  test("a click on a link with no href (hrefOrigin null) is unaffected by this rule", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "A", hrefOrigin: null }) })).cls,
    ).toBe("observing");
  });
});

describe("classifyBrowserAction — I5: case-insensitive type attribute", () => {
  test("an uppercase FILE type still actuates", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "INPUT", type: "FILE" }) })).cls,
    ).toBe("actuating");
  });

  test("a mixed-case File type still actuates", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "INPUT", type: "File" }) })).cls,
    ).toBe("actuating");
  });
});

describe("classifyBrowserAction — I6: independent submit-shape rule", () => {
  test("an input[type=image] actuates even when the producer did not set isSubmitControl", () => {
    expect(
      classifyBrowserAction(
        input({ node: node({ tagName: "INPUT", type: "image", isSubmitControl: false }) }),
      ).cls,
    ).toBe("actuating");
  });

  test("an input[type=submit] actuates independent of isSubmitControl", () => {
    expect(
      classifyBrowserAction(
        input({ node: node({ tagName: "INPUT", type: "submit", isSubmitControl: false }) }),
      ).cls,
    ).toBe("actuating");
  });

  test("an input[type=reset] actuates independent of isSubmitControl", () => {
    expect(
      classifyBrowserAction(
        input({ node: node({ tagName: "INPUT", type: "reset", isSubmitControl: false }) }),
      ).cls,
    ).toBe("actuating");
  });

  test("a bare BUTTON element actuates even when the producer did not set isSubmitControl", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "BUTTON", isSubmitControl: false }) }))
        .cls,
    ).toBe("actuating");
  });
});

describe("classifyBrowserAction — I7: keypress form submission (not yet reachable in the shipped surface)", () => {
  test("typing that submits its enclosing form (e.g. Enter) actuates even without a password", () => {
    const result = classifyBrowserAction(
      input({
        kind: "type",
        node: node({ tagName: "INPUT", type: "text", inForm: true }),
        submitsForm: true,
      }),
    );
    expect(result.cls).toBe("actuating");
  });

  test("submitsForm alone, outside a form, does not trip this rule", () => {
    expect(
      classifyBrowserAction(
        input({
          kind: "type",
          node: node({ tagName: "INPUT", type: "text", inForm: false }),
          submitsForm: true,
        }),
      ).cls,
    ).toBe("observing");
  });

  test("being in a form without submitsForm does not trip this rule", () => {
    expect(
      classifyBrowserAction(
        input({ kind: "type", node: node({ tagName: "INPUT", type: "text", inForm: true }) }),
      ).cls,
    ).toBe("observing");
  });
});

describe("classifyBrowserAction — I10: reason strings are load-bearing (consent prompt + ledger)", () => {
  test("each actuating branch names its own reason, not a generic fallback", () => {
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "BUTTON", isSubmitControl: true }) }))
        .why,
    ).toContain("submit control");
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "SPAN", isSubmitControl: true }) })).why,
    ).toContain("submit control");
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "INPUT", type: "file" }) })).why,
    ).toContain("file");
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "INPUT", type: "image" }) })).why,
    ).toContain("image");
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "INPUT", type: "submit" }) })).why,
    ).toContain("submit");
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "INPUT", type: "reset" }) })).why,
    ).toContain("reset");
    expect(classifyBrowserAction(input({ node: node({ tagName: "BUTTON" }) })).why).toContain(
      "button",
    );
    expect(
      classifyBrowserAction(
        input({ node: node({ tagName: "INPUT", type: "text", inFormWithPassword: true }) }),
      ).why,
    ).toContain("password");
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "A", hrefScheme: "javascript" }) })).why,
    ).toContain("javascript");
    expect(
      classifyBrowserAction(
        input({ node: node({ tagName: "A", hrefOrigin: "https://other.example" }) }),
      ).why,
    ).toContain("other.example");
    expect(
      classifyBrowserAction(
        input({
          kind: "type",
          node: node({ tagName: "INPUT", type: "text", inForm: true }),
          submitsForm: true,
        }),
      ).why,
    ).toContain("form");
    expect(classifyBrowserAction(input({ kind: "download" })).why).toContain("download");
    expect(
      classifyBrowserAction(input({ kind: "navigate", targetOrigin: "https://other.example" })).why,
    ).toContain("other.example");
    expect(classifyBrowserAction(input({ kind: "navigate", targetOrigin: null })).why).toContain(
      "target origin",
    );
    expect(classifyBrowserAction(input({ kind: "click", node: null })).why).toContain("observed");
  });

  test("an action that trips no rule falls to the explicit generic-actuating reason", () => {
    // There is deliberately no proven-safe case for a scheme this classifier has never heard of —
    // this exercises the literal final statement of the function.
    expect(
      classifyBrowserAction(input({ node: node({ tagName: "A", hrefScheme: "chrome-extension" }) }))
        .why,
    ).toBe("non-http(s) href scheme: chrome-extension");
  });

  test("observing reasons are also substantive, not blank", () => {
    expect(classifyBrowserAction(input({ kind: "read", node: null })).why).toContain("read");
    expect(classifyBrowserAction(input({ kind: "navigate" })).why).toContain("same-origin");
    expect(classifyBrowserAction(input({ node: node({ tagName: "A" }) })).why).toContain("a");
  });
});
