import { describe, expect, test } from "bun:test";
import type { MountDocument } from "./view-tree.ts";
import { elementsOf, h, mount, textOf } from "./view-tree.ts";

// A minimal stand-in for the DOM: just enough for `mount`, and it records
// every node it creates so a test can assert that nothing was parsed as HTML.
interface FakeNode {
  kind: "element" | "text";
  tag?: string;
  text?: string;
  attrs: Record<string, string>;
  children: FakeNode[];
}

function fakeDocument(): { doc: MountDocument; created: FakeNode[] } {
  const created: FakeNode[] = [];
  const element = (tag: string): FakeNode & Record<string, unknown> => {
    const node: FakeNode & Record<string, unknown> = {
      kind: "element",
      tag,
      attrs: {},
      children: [],
      setAttribute(name: string, value: string) {
        node.attrs[name] = value;
      },
      appendChild(child: FakeNode) {
        node.children.push(child);
        return child;
      },
      replaceChildren(...kids: FakeNode[]) {
        node.children = kids;
      },
    };
    return node;
  };
  const doc = {
    createElement(tag: string) {
      const node = element(tag);
      created.push(node);
      return node as unknown as Element;
    },
    createTextNode(text: string) {
      const node: FakeNode = { kind: "text", text, attrs: {}, children: [] };
      created.push(node);
      return node as unknown as Node;
    },
  };
  return { doc, created };
}

describe("view-tree", () => {
  test("textOf and elementsOf walk the whole tree", () => {
    const tree = [h("p", {}, "a", h("b", {}, "c")), "d"];
    expect(textOf(tree)).toBe("acd");
    expect(elementsOf(tree).map((e) => e.tag)).toEqual(["p", "b"]);
  });

  test("mount builds elements and text nodes, replacing the old children", () => {
    const { doc } = fakeDocument();
    const parent = doc.createElement("main") as unknown as FakeNode & Element;
    parent.children.push({ kind: "text", text: "stale", attrs: {}, children: [] });

    mount(parent, [h("div", { class: "card", id: "x" }, "hi"), "tail"], doc);

    expect(parent.children).toHaveLength(2);
    const [div, tail] = parent.children;
    expect(div?.tag).toBe("div");
    expect(div?.attrs).toEqual({ class: "card", id: "x" });
    expect(div?.children[0]).toMatchObject({ kind: "text", text: "hi" });
    expect(tail).toMatchObject({ kind: "text", text: "tail" });
  });

  test("a markup string is mounted as ONE text node, never as elements", () => {
    const { doc, created } = fakeDocument();
    const parent = doc.createElement("main");
    const payload = '<img src=x onerror="alert(1)">';

    mount(parent, [h("code", {}, payload)], doc);

    const tags = created.filter((n) => n.kind === "element").map((n) => n.tag);
    expect(tags).toEqual(["main", "code"]);
    expect(created.filter((n) => n.kind === "text").map((n) => n.text)).toEqual([payload]);
  });
});
