import { describe, expect, test } from "bun:test";
import { tagStrippedForms } from "./tag-strip.ts";

describe("tagStrippedForms", () => {
  test("keeps every pass of both tokenisations until the text settles", () => {
    expect(tagStrippedForms("a<b>c")).toEqual(["ac", "ac"]);
    expect(tagStrippedForms("plain")).toEqual([]);
  });

  test("a tag split by another tag is seen whole on a later pass", () => {
    expect(tagStrippedForms("<a<b>>x")).toContain("x");
  });

  test("the greedy tokenisation takes `<x<y>` as one tag, the innermost only `<y>`", () => {
    expect(tagStrippedForms("<x<y>z")).toEqual(["<xz", "z"]);
  });

  test("an unclosed `<` is kept and never loops", () => {
    expect(tagStrippedForms("a<b")).toEqual([]);
    expect(tagStrippedForms("a<b<c>d")).toEqual(["a<bd", "ad"]);
  });

  test("agrees with the regular expressions the two scans stand for", () => {
    const samples = ["<<a>>", "a<b>c<d", "<>", "x<<y>z>w", "<a><b>", "<a<b<c>>>"];
    for (const text of samples) {
      const forms = tagStrippedForms(text);
      let innermost = text;
      const expected: string[] = [];
      for (;;) {
        const next = innermost.replace(/<[^<>]*>/g, "");
        if (next === innermost) break;
        expected.push(next);
        innermost = next;
      }
      let greedy = text;
      for (;;) {
        const next = greedy.replace(/<[^>]*>/g, "");
        if (next === greedy) break;
        expected.push(next);
        greedy = next;
      }
      expect(forms).toEqual(expected);
    }
  });
});
