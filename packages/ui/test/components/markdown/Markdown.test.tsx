import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../../../src/components/markdown/Markdown";

function renderMd(text: string): HTMLElement {
  return render(<Markdown text={text} />).container;
}

describe("Markdown", () => {
  it("raw HTML renders as text, creating no element", () => {
    const c = renderMd("<b>x</b><script>y</script>");
    expect(c.querySelector("b")).toBeNull();
    expect(c.querySelector("script")).toBeNull();
    expect(c.textContent).toContain("<b>x</b>");
  });

  it("a raw HTML block renders as text", () => {
    const c = renderMd("<div onclick=alert(1)>hi</div>\n\n<img src=x onerror=alert(1)>");
    expect(c.querySelector("[onclick]")).toBeNull();
    expect(c.textContent).toContain("<div onclick=alert(1)>hi</div>");
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("a javascript: link renders as text plus URL, no anchor", () => {
    const c = renderMd("[x](javascript:alert(1))");
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("x");
    expect(c.textContent).toContain("javascript:alert(1)");
  });

  it("an http link renders text then the URL as plain text, no anchor", () => {
    const c = renderMd("[docs](https://e.x/a)");
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toBe("docs (https://e.x/a)");
  });

  it("an autolink whose text equals its URL shows it once", () => {
    const c = renderMd("<https://e.x/a>");
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent?.match(/https:\/\/e\.x\/a/g)).toHaveLength(1);
  });

  it("an image shows its alt text and loads nothing", () => {
    const c = renderMd("![chart](https://e.x/p.png)");
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain("chart");
  });

  it("entities are literal", () => {
    expect(renderMd("a & b < c").textContent).toBe("a & b < c");
    expect(renderMd("a &amp; b").textContent).toBe("a &amp; b");
  });

  it("renders headings, lists, tables, code, blockquote, hr", () => {
    const c = renderMd(
      "# H\n\n1. a\n2. b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n\n> q\n\n---",
    );
    expect(c.querySelector("h1")?.textContent).toBe("H");
    expect(c.querySelectorAll("ol > li")).toHaveLength(2);
    expect(c.querySelectorAll("table th")).toHaveLength(2);
    expect(c.querySelectorAll("table td")).toHaveLength(2);
    expect(c.querySelector("pre > code")?.textContent).toBe("code");
    expect(c.querySelector("blockquote")?.textContent).toContain("q");
    expect(c.querySelector("hr")).not.toBeNull();
  });

  it("backslash escapes render the character, not the backslash", () => {
    const c = renderMd("\\[x\\] a \\*b\\*");
    expect(c.textContent).toBe("[x] a *b*");
    expect(c.querySelector("em")).toBeNull();
  });

  it("task markers show exactly once per item, tight and loose", () => {
    for (const src of ["- [ ] a\n- [x] b", "- [ ] a\n\n- [x] b"]) {
      const c = renderMd(src);
      const items = [...c.querySelectorAll("li")].map((li) => li.textContent?.trim());
      expect(items).toEqual(["[ ] a", "[x] b"]);
      expect(c.querySelector("input")).toBeNull();
    }
  });

  it("renders inline emphasis, code and unordered lists", () => {
    const c = renderMd("**b** _i_ `x<y` ~~d~~\n\n- one\n- two");
    expect(c.querySelector("strong")?.textContent).toBe("b");
    expect(c.querySelector("em")?.textContent).toBe("i");
    expect(c.querySelector("code")?.textContent).toBe("x<y");
    expect(c.querySelector("del")?.textContent).toBe("d");
    expect(c.querySelectorAll("ul > li")).toHaveLength(2);
  });

  it("emits no anchors, images, styles or event handlers for a hostile document", () => {
    const c = renderMd(
      '[a](https://e.x) ![b](https://e.x/i.png) <a href="x" onclick="y">z</a>\n\n<iframe src=x></iframe>',
    );
    expect(c.querySelector("a, img, iframe, [style], [onclick]")).toBeNull();
  });

  it("never uses innerHTML", () => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    expect(desc?.set).toBeDefined();
    let sets = 0;
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      get: desc?.get,
      set(this: Element, v: string) {
        sets += 1;
        desc?.set?.call(this, v);
      },
    });
    try {
      render(
        <Markdown
          text={
            "# H\n\n**b** [l](https://e.x) ![i](u) <b>x</b>\n\n- a\n\n| a |\n|---|\n| 1 |\n\n```\nc\n```\n\n> q"
          }
        />,
      );
    } finally {
      Object.defineProperty(Element.prototype, "innerHTML", desc as PropertyDescriptor);
    }
    expect(sets).toBe(0);
  });
});
