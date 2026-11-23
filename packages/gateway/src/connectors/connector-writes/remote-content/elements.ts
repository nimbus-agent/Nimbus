// packages/gateway/src/connectors/connector-writes/remote-content/elements.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import type { MarkupToken } from "../markup-tokens.ts";
import { foldAndStrip } from "../text-normalise.ts";
import {
  localForms,
  localIn,
  nameIn,
  rawUrlForm,
  type StartToken,
  urlIsExternal,
} from "./shared.ts";

// ---------------------------------------------------------------------------------------------
// R4 step 2: elements refused whatever their attributes.
// ---------------------------------------------------------------------------------------------

const REFUSED_ELEMENTS: ReadonlySet<string> = new Set([
  "base",
  "link",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "script",
]);

/** Confluence's own link element, whose local name is `link` (R3: always allowed in storage). */
const CONFLUENCE_LINK_ELEMENT = "ac:link";

export interface MarkupRules {
  /** Outlook HTML: an `<img src="cid:...">` names an inline part (R3). */
  readonly allowCid: boolean;
  /** Confluence storage: `<ac:link>` is a plain link, not a `<link>`. */
  readonly confluence: boolean;
  /** Drive markup (R12): a CSS `url(` whose argument starts with `#` is allowed. */
  readonly allowFragmentUrl: boolean;
  /**
   * Elements a format refuses beyond R4 step 2 (B3w: Teams `<attachment>`), compared the same
   * three ways. Checked inside `refusesElement`, so every nested view applies it too.
   */
  readonly refusedExtra?: ReadonlySet<string>;
}

function isConfluenceLink(t: StartToken): boolean {
  return (
    t.name.toLowerCase() === CONFLUENCE_LINK_ELEMENT &&
    foldAndStrip(t.name).toLowerCase() === CONFLUENCE_LINK_ELEMENT
  );
}

export function refusesElement(t: StartToken, rules: MarkupRules): boolean {
  if (nameIn(t.name, REFUSED_ELEMENTS) && !(rules.confluence && isConfluenceLink(t))) return true;
  if (rules.refusedExtra !== undefined && nameIn(t.name, rules.refusedExtra)) return true;
  return nameIn(t.name, META) && t.attrs.some((a) => nameIn(a.name, HTTP_EQUIV));
}

const META: ReadonlySet<string> = new Set(["meta"]);
const HTTP_EQUIV: ReadonlySet<string> = new Set(["http-equiv"]);

// ---------------------------------------------------------------------------------------------
// R4 steps 3 and 4: URL-bearing attributes.
// ---------------------------------------------------------------------------------------------

const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "src",
  "lowsrc",
  "dynsrc",
  "poster",
  "background",
  "data",
  "codebase",
  "manifest",
  "icon",
]);
const HREF: ReadonlySet<string> = new Set(["href"]);
const BASE_ATTRIBUTE: ReadonlySet<string> = new Set(["base"]);
const LINK_ELEMENTS: ReadonlySet<string> = new Set(["a", "area"]);
/** URL lists (and `srcset` candidate lists): refused when non-empty, whatever the URLs. */
const URL_LIST_ATTRIBUTES: ReadonlySet<string> = new Set([
  "srcset",
  "imagesrcset",
  "ping",
  "archive",
]);

/** Whether the element is a plain link: every local form is `a` or `area`. */
function isLinkElement(t: StartToken): boolean {
  return localForms(t.name).every((l) => LINK_ELEMENTS.has(l));
}

/** An `on*` event-handler attribute in any of its name forms. */
function isEventHandler(name: string): boolean {
  return localForms(name).some((l) => l.startsWith("on"));
}

export function refusesAttributes(t: StartToken, rules: MarkupRules): boolean {
  const link = isLinkElement(t);
  const opts = { allowCid: rules.allowCid };
  return t.attrs.some((a) => {
    if (isEventHandler(a.name)) return true;
    // `xml:base` (any attribute whose local name is `base`) re-roots every relative URL in its
    // subtree, so a relative `src` would load from it: refused when non-empty (adversarial review).
    if (localIn(a.name, BASE_ATTRIBUTE)) return rawUrlForm(a.value) !== "";
    if (nameIn(a.name, URL_LIST_ATTRIBUTES)) return rawUrlForm(a.value) !== "";
    if (nameIn(a.name, URL_ATTRIBUTES) && urlIsExternal(a.value, opts)) return true;
    return !link && nameIn(a.name, HREF) && urlIsExternal(a.value, opts);
  });
}

// ---------------------------------------------------------------------------------------------
// R4 steps 6 and 7: comments, declarations, processing instructions and CDATA.
// ---------------------------------------------------------------------------------------------

export function refusesMarkupInDeclarations(tokens: readonly MarkupToken[]): boolean {
  return tokens.some(
    (t) => (t.kind === "comment" || t.kind === "declaration") && t.text.includes("<"),
  );
}

export function hasCdata(tokens: readonly MarkupToken[]): boolean {
  return tokens.some((t) => t.kind === "cdata");
}
