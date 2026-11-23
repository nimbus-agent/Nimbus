// packages/gateway/src/connectors/connector-writes/remote-content/html.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import { type MarkupToken, REMOTE_SCAN_MAX_CHARS, tokenizeMarkup } from "../markup-tokens.ts";
import { settle } from "../text-normalise.ts";
import { refusesStyleAttribute } from "./css.ts";
import {
  hasCdata,
  type MarkupRules,
  refusesAttributes,
  refusesElement,
  refusesMarkupInDeclarations,
} from "./elements.ts";
import { refusesCss } from "./raw-text.ts";
import { isAsciiLetterCode } from "./shared.ts";
import {
  presentationRefused,
  refusesPresentationUrls,
  refusesSvgElements,
  svgElementRefused,
} from "./svg.ts";

// ---------------------------------------------------------------------------------------------
// R6: the textual tripwire (defence in depth against a tokenizer/parser differential). Over the
// raw lower-cased text and its two settled forms. Stated over-refusal: prose or code that
// literally contains `src="https://...`, `url(` or `@import` is refused. The widened CSS
// function names (Review fix 1) are matched with no whitespace before `(`, as CSS requires, so
// prose such as "the image (left)" is not refused by the tripwire.
// ---------------------------------------------------------------------------------------------

// No two unbounded quantifiers are adjacent over the same characters (adversarial review): the
// optional quote and the whitespace after it are ONE optional group, so `src=` followed by a
// million spaces is read in linear time. Pinned by the timing tests.
const URL_ASSIGNMENT_TRIPWIRE_CID =
  /\b(?:src|srcset|lowsrc|dynsrc|poster|background)\s*=\s*(?:["'\x60]\s*)?(?:[\\/][\\/]|(?!cid:)[a-z][a-z0-9+.-]*:)/;
const URL_ASSIGNMENT_TRIPWIRE =
  /\b(?:src|srcset|lowsrc|dynsrc|poster|background)\s*=\s*(?:["'\x60]\s*)?(?:[\\/][\\/]|[a-z][a-z0-9+.-]*:)/;
const CSS_TRIPWIRE = /url\s*\(|@import|(?:image|image-set|cross-fade|element|src)\(/;
/** Drive markup: a `url(` whose argument starts with `#` (an SVG fragment) is not tripped. */
const CSS_TRIPWIRE_DRIVE_URL = /url\s*\((?!\s*(?:["']\s*)?#)/;
const CSS_TRIPWIRE_DRIVE_OTHER = /@import|(?:image|image-set|cross-fade|element|src)\(/;

type TripwireKind = "outlook" | "default" | "drive";

/** R6 over the three forms of `text`; an unsettled text trips it. */
export function tripwire(text: string, kind: TripwireKind): boolean {
  const deleted = settle(text, "");
  const spaced = settle(text, " ");
  if (deleted === undefined || spaced === undefined) return true;
  const assignment = kind === "outlook" ? URL_ASSIGNMENT_TRIPWIRE_CID : URL_ASSIGNMENT_TRIPWIRE;
  const css =
    kind === "drive" ? [CSS_TRIPWIRE_DRIVE_URL, CSS_TRIPWIRE_DRIVE_OTHER] : [CSS_TRIPWIRE];
  return [text.toLowerCase(), deleted, spaced].some(
    (f) => assignment.test(f) || css.some((r) => r.test(f)),
  );
}

// ---------------------------------------------------------------------------------------------
// The per-token rules of R4 steps 2-5 for one token stream.
// ---------------------------------------------------------------------------------------------

/** Deeper nested views than this are refused. */
const NESTED_VIEW_MAX_DEPTH = 4;
/** A tag whose source holds more `<` + letter than this is refused (adversarial review). */
const NESTED_VIEW_MAX_OPENERS = 16;

/** The characters all nested views of one scan may re-tokenize, in total; past it, refused. */
interface NestedBudget {
  remaining: number;
}

/** The offsets of each `<` + ASCII letter inside a tag's source (after its own `<`). */
function nestedOpeners(source: string): number[] {
  const out: number[] = [];
  for (let at = source.indexOf("<", 1); at !== -1; at = source.indexOf("<", at + 1)) {
    if (isAsciiLetterCode(source.codePointAt(at + 1) ?? -1)) out.push(at);
  }
  return out;
}

/**
 * The nested view (a tokenizer differential, Review Focus 1): a `<` + ASCII letter INSIDE a tag's
 * source (in a name, as in `<a <img src=//h>>` or `<im<link href=//h>`, or in a quoted value) is
 * where a lenient parser may start a tag this tokenizer does not. From each such `<` to the end of
 * the enclosing tag, the text is tokenized again and its start tags checked by steps 2-3 and their
 * `style` attributes. A view that does not tokenize starts no complete tag and refuses nothing.
 * Bounded (adversarial review): more than {@link NESTED_VIEW_MAX_OPENERS} openers in one tag,
 * nesting past {@link NESTED_VIEW_MAX_DEPTH}, or more than {@link REMOTE_SCAN_MAX_CHARS}
 * re-tokenized characters in one scan refuses.
 */
function refusesNestedView(
  t: Extract<MarkupToken, { kind: "start" | "end" }>,
  text: string,
  rules: MarkupRules,
  depth: number,
  budget: NestedBudget,
): boolean {
  const source = text.slice(t.start, t.end);
  const openers = nestedOpeners(source);
  if (openers.length === 0) return false;
  if (openers.length > NESTED_VIEW_MAX_OPENERS || depth >= NESTED_VIEW_MAX_DEPTH) return true;
  for (const at of openers) {
    const view = source.slice(at);
    budget.remaining -= view.length;
    if (budget.remaining < 0) return true;
    const inner = tokenizeMarkup(view);
    if (inner !== undefined && refusesTagsAt(inner, view, rules, depth + 1, budget)) return true;
  }
  return false;
}

function refusesTagsAt(
  tokens: readonly MarkupToken[],
  text: string,
  rules: MarkupRules,
  depth: number,
  budget: NestedBudget,
): boolean {
  return tokens.some((t) => {
    if (t.kind !== "start" && t.kind !== "end") return false;
    if (refusesNestedView(t, text, rules, depth, budget)) return true;
    if (t.kind !== "start") return false;
    if (refusesElement(t, rules) || refusesAttributes(t, rules)) return true;
    if (depth === 0) return false;
    return (
      refusesStyleAttribute(t, rules.allowFragmentUrl) ||
      svgElementRefused(t) ||
      presentationRefused(t, rules.allowFragmentUrl)
    );
  });
}

/** R4 steps 2-4 (and the nested view) over one token stream. */
export function refusesTags(
  tokens: readonly MarkupToken[],
  text: string,
  rules: MarkupRules,
): boolean {
  return refusesTagsAt(tokens, text, rules, 0, { remaining: REMOTE_SCAN_MAX_CHARS });
}

/** Options of a detector; `tripwire: false` is the test seam that isolates the structural rules. */
export interface DetectOptions {
  readonly tripwire: boolean;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = Object.freeze({ tripwire: true });

/** What distinguishes one HTML message format from another (B3w: Outlook and Teams). */
interface HtmlProfile {
  readonly allowCid: boolean;
  readonly tripwire: TripwireKind;
  readonly refusedExtra: ReadonlySet<string>;
}

const NO_EXTRA_ELEMENTS: ReadonlySet<string> = new Set();

/** An HTML message body (R4): the eight steps, in order, under one format's profile. */
function htmlMarkupRemote(text: string, opts: DetectOptions, profile: HtmlProfile): boolean {
  const rules: MarkupRules = {
    allowCid: profile.allowCid,
    confluence: false,
    allowFragmentUrl: false,
    refusedExtra: profile.refusedExtra,
  };
  const tokens = tokenizeMarkup(text); // step 1
  if (tokens === undefined) return true;
  return (
    refusesTags(tokens, text, rules) || // steps 2-4 (and the profile's extra elements)
    refusesSvgElements(tokens) || // SVG elements (every format)
    refusesPresentationUrls(tokens, false) || // SVG presentation attributes
    refusesCss(tokens, text, rules) || // step 5
    refusesMarkupInDeclarations(tokens) || // step 6
    hasCdata(tokens) || // step 7
    (opts.tripwire && tripwire(text, profile.tripwire)) // step 8
  );
}

/** Outlook HTML (R4, `cid:` allowed in URL attributes). */
export function outlookHtmlRemote(text: string, opts: DetectOptions): boolean {
  return htmlMarkupRemote(text, opts, {
    allowCid: true,
    tripwire: "outlook",
    refusedExtra: NO_EXTRA_ELEMENTS,
  });
}

/**
 * Teams refuses `<attachment>` (any case, any prefix) on top of R4 (B3w W5). In a Graph
 * chatMessage body, `<attachment id="X"></attachment>` binds to the `attachments[]` entry with the
 * same id, which is how cards, files and share links are carried ("the attachment's ID must be
 * the same in the body and attachments elements": "Send chatMessage in a channel or a chat",
 * https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0, retrieved
 * 2026-11-06). The connector sends no `attachments`, `hostedContents` or `mentions` (pinned by
 * `remote-content.sync.test.ts` (g)), so a valid model message never needs one, and refusing it
 * keeps cards out by two mechanisms.
 */
const TEAMS_REFUSED_ELEMENTS: ReadonlySet<string> = new Set(["attachment"]);

/**
 * Teams HTML (B3w W5): R4 in the Outlook order with NO `cid:` (Teams has no `cid:` parts) and
 * the default tripwire, plus `<attachment>`. Inline images in a chatMessage are hosted content,
 * referenced as `src="../hostedContents/<n>/$value"` with a matching `hostedContents[]` entry
 * (the same Graph reference, example 6): that relative form is allowed by R2 and names nothing,
 * because the connector sends no `hostedContents`. Whether the Teams client renders an EXTERNAL
 * `<img src>` is not established in that reference (it notes only that "the Teams client has
 * specific HTML restrictions"); an external `src` is refused either way, an absolute
 * `graph.microsoft.com` URL included (the host is not exempted, B3r R2).
 */
export function teamsHtmlRemote(text: string, opts: DetectOptions): boolean {
  return htmlMarkupRemote(text, opts, {
    allowCid: false,
    tripwire: "default",
    refusedExtra: TEAMS_REFUSED_ELEMENTS,
  });
}
