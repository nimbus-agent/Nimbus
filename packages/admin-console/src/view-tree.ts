// A tiny, DOM-free view tree for the admin console.
//
// Views build `ViewNode` trees instead of HTML strings, and `mount` turns a tree
// into DOM with `createElement` + `createTextNode`. No string is ever parsed as
// HTML, so a server-supplied value cannot become markup no matter which field it
// arrives in — XSS-safety by construction rather than by remembering to escape.
// Tags and attribute names are closed unions, so neither can carry an event
// handler or a `src`/`href` either.

export type Tag =
  | "b"
  | "button"
  | "code"
  | "div"
  | "h2"
  | "h3"
  | "i"
  | "p"
  | "span"
  | "table"
  | "tbody"
  | "td"
  | "textarea"
  | "th"
  | "thead"
  | "tr";

export type AttrName = "class" | "cols" | "id" | "rows";

export type Attrs = Readonly<Partial<Record<AttrName, string>>>;

export interface ViewNode {
  readonly tag: Tag;
  readonly attrs: Attrs;
  readonly children: readonly ViewChild[];
}

/** A string child is always rendered as a text node, never as markup. */
export type ViewChild = ViewNode | string;

export function h(tag: Tag, attrs: Attrs = {}, ...children: ViewChild[]): ViewNode {
  return { tag, attrs, children };
}

/** The concatenated text content of a tree, as `Node.textContent` would read it. */
export function textOf(nodes: ViewChild | readonly ViewChild[]): string {
  const list: readonly ViewChild[] = Array.isArray(nodes) ? nodes : [nodes as ViewChild];
  return list.map((n) => (typeof n === "string" ? n : textOf(n.children))).join("");
}

/** Every element in a tree, depth-first. */
export function elementsOf(nodes: ViewChild | readonly ViewChild[]): ViewNode[] {
  const list: readonly ViewChild[] = Array.isArray(nodes) ? nodes : [nodes as ViewChild];
  const out: ViewNode[] = [];
  for (const n of list) {
    if (typeof n !== "string") {
      out.push(n, ...elementsOf(n.children));
    }
  }
  return out;
}

/** The subset of `Document` that `mount` needs, so it can be driven without a browser. */
export interface MountDocument {
  createElement(tag: string): Element;
  createTextNode(text: string): Node;
}

function build(doc: MountDocument, node: ViewChild): Node {
  if (typeof node === "string") {
    return doc.createTextNode(node);
  }
  const el = doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    el.setAttribute(name, value);
  }
  for (const child of node.children) {
    el.appendChild(build(doc, child));
  }
  return el;
}

/** Replace `parent`'s children with the DOM built from `nodes`. */
export function mount(parent: Element, nodes: readonly ViewChild[], doc: MountDocument): void {
  parent.replaceChildren(...nodes.map((n) => build(doc, n)));
}
