// packages/gateway/src/connectors/connector-writes/remote-content/svg.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import type { MarkupToken } from "../markup-tokens.ts";
import { cssForms, cssUrlLoads } from "./css.ts";
import { localIn, localPart, nameIn, STYLE, type StartToken, valueForms } from "./shared.ts";

// ---------------------------------------------------------------------------------------------
// R12: SVG, XHTML and the XML forms (`drive-markup` = R4 + R12; no `cid:`). Drive content may be
// read by an HTML or an XML parser.
// ---------------------------------------------------------------------------------------------

const FOREIGN_OBJECT: ReadonlySet<string> = new Set(["foreignobject"]);
const ATTRIBUTE_NAME: ReadonlySet<string> = new Set(["attributename"]);
/** SMIL can set these at run time (`<set attributeName="href" to="//h"/>`). */
const SMIL_REFUSED_TARGETS: ReadonlySet<string> = new Set(["href", "src"]);
const EXTERNAL_IDENTIFIER = /\b(?:system|public)\b/;

/**
 * R12 SVG elements: `foreignObject` (any case, any prefix: it lays out an HTML subtree), and any
 * element whose `attributeName` (every form, local part) is `href` or `src` (SMIL `set`,
 * `animate`, `animateMotion`, `animateTransform`, `discard`; any element, fail closed).
 */
export function svgElementRefused(t: StartToken): boolean {
  if (localIn(t.name, FOREIGN_OBJECT)) return true;
  return t.attrs.some((a) => {
    if (!localIn(a.name, ATTRIBUTE_NAME)) return false;
    const forms = valueForms(a.value);
    return forms === undefined || forms.some((f) => SMIL_REFUSED_TARGETS.has(localPart(f)));
  });
}

export function refusesSvgElements(tokens: readonly MarkupToken[]): boolean {
  return tokens.some((t) => t.kind === "start" && svgElementRefused(t));
}

/**
 * A CSS function token in an attribute value: the name and `(` with nothing between, as CSS
 * requires, so prose such as `alt="Image (1)"` is not read as a call.
 */
const CSS_LOAD_FUNCTION_TOKEN = /(?:image|image-set|cross-fade|element|src|expression)\(/;
const CSS_URL_FUNCTION_TOKEN = /url\(/g;

/**
 * Whether one attribute value, read as CSS (entities and CSS escapes decoded), calls a loading
 * function, or a `url(` that loads (any `url(`, or with `allowFragmentUrl` one whose argument
 * does not start with `#`).
 */
function valueLoadsAsCss(value: string, allowFragmentUrl: boolean): boolean {
  // Only a value that can spell `(` (literally, as an entity, or as a CSS escape) can call one.
  if (!value.includes("(") && !value.includes("&") && !value.includes("\\")) return false;
  const forms = cssForms(value);
  if (forms === undefined) return true;
  return forms.some(
    (f) =>
      CSS_LOAD_FUNCTION_TOKEN.test(f) || cssUrlLoads(f, allowFragmentUrl, CSS_URL_FUNCTION_TOKEN),
  );
}

export function presentationRefused(t: StartToken, allowFragmentUrl: boolean): boolean {
  return t.attrs.some((a) => !nameIn(a.name, STYLE) && valueLoadsAsCss(a.value, allowFragmentUrl));
}

/**
 * R12 presentation attributes, in EVERY markup format since the adversarial review (an SVG
 * `<rect mask="u\72l(...)">` renders in Outlook on the web and in Obsidian too): any attribute
 * other than `style` (R4 step 5) whose value calls a CSS `url(` is refused; in Drive markup only
 * (`allowFragmentUrl`), EVERY `url(` argument must start with `#` instead (Review fix 3: `fill`,
 * `stroke`, `filter`, `mask`, `clip-path`, `marker-*`, and SMIL `values`, `to`, `from`, `by`).
 * The other loading functions (`mask` takes images) are refused outright.
 */
export function refusesPresentationUrls(
  tokens: readonly MarkupToken[],
  allowFragmentUrl: boolean,
): boolean {
  return tokens.some((t) => t.kind === "start" && presentationRefused(t, allowFragmentUrl));
}

/**
 * R12 XML declarations: a `<!DOCTYPE ...>` (any `<!` declaration) with an external identifier
 * (`SYSTEM` or `PUBLIC`; an XML parser may fetch the DTD; owner-accepted over-refusal of the
 * standard XHTML doctype), and a processing instruction naming `xml-stylesheet`. An internal
 * subset holds `<` and is refused by R4 step 6.
 */
export function refusesXmlDeclarations(tokens: readonly MarkupToken[]): boolean {
  return tokens.some((t) => {
    if (t.kind !== "declaration") return false;
    const forms = valueForms(t.text);
    if (forms === undefined) return true;
    if (t.text.startsWith("!")) return forms.some((f) => EXTERNAL_IDENTIFIER.test(f));
    return t.text.startsWith("?") && forms.some((f) => f.includes("xml-stylesheet"));
  });
}
