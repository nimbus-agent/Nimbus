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
    isSubmitControl: false,
    accessibleName: null,
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
