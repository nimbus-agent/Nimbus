// packages/gateway/src/connectors/connector-writes/remote-content/drive.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import { tokenizeMarkup } from "../markup-tokens.ts";
import { foldAndStrip } from "../text-normalise.ts";
import { hasCdata, type MarkupRules, refusesMarkupInDeclarations } from "./elements.ts";
import { type DetectOptions, refusesTags, tripwire } from "./html.ts";
import { refusesCss } from "./raw-text.ts";
import { refusesPresentationUrls, refusesSvgElements, refusesXmlDeclarations } from "./svg.ts";

// ---------------------------------------------------------------------------------------------
// R11: which Drive `mimeType` values scan (owner ruling OR-B3r-2), normalised and fail closed.
// ---------------------------------------------------------------------------------------------

/** The owner's three markup types (R11 (a)). */
const DRIVE_MARKUP_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
]);
/** R11 (b): any essence naming one of these is markup. */
const MARKUP_ESSENCE = /html|svg|xml/;
/** R11 (c): a Google Apps type Drive may convert into, which might fetch remote images. */
const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";
/** R11 (d): a clean `type/subtype` token pair (lower-case only). */
const CLEAN_MIME_ESSENCE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** The essence of one form: cut at the first `;` (parameters dropped), spaces and TABs trimmed. */
function mimeEssence(form: string): string {
  const semi = form.indexOf(";");
  const essence = semi === -1 ? form : form.slice(0, semi);
  let lo = 0;
  let hi = essence.length;
  const blank = (ch: string): boolean => ch === " " || ch === "\t";
  while (lo < hi && blank(essence.charAt(lo))) lo++;
  while (hi > lo && blank(essence.charAt(hi - 1))) hi--;
  return essence.slice(lo, hi);
}

function essenceScans(essence: string): boolean {
  return (
    DRIVE_MARKUP_TYPES.has(essence) || // (a)
    MARKUP_ESSENCE.test(essence) || // (b)
    essence.startsWith(GOOGLE_APPS_PREFIX) || // (c)
    !CLEAN_MIME_ESSENCE.test(essence) // (d): empty or unclean
  );
}

/**
 * R11: whether a `gdrive_file_create` with this `mimeType` has its `content` scanned as
 * `drive-markup`. Absent (`undefined`): not scanned (the connector uses `text/plain`). Present
 * but not a string (`null` included): scanned. A string scans when the essence of its RAW
 * (lower-cased) or FOLDED (NFKC, invisible characters deleted, lower-cased) form is markup, a
 * Google Apps type, or not a clean `type/subtype` pair. Stated bound: Drive stores the type it
 * is given and nothing sniffs content, so a `text/plain` file holding HTML is not scanned.
 */
export function driveMimeTypeScans(mimeType: unknown): boolean {
  if (mimeType === undefined) return false;
  if (typeof mimeType !== "string") return true;
  const forms = [mimeType.toLowerCase(), foldAndStrip(mimeType).toLowerCase()];
  return forms.some((f) => essenceScans(mimeEssence(f)));
}

/** Drive file names that a browser or a desktop app opens as markup (coordinator ruling). */
const DRIVE_MARKUP_EXTENSIONS: readonly string[] = [
  ".html",
  ".htm",
  ".xhtml",
  ".svg",
  ".xml",
  ".mht",
  ".mhtml",
];
/** Drive file names that a Markdown app (Obsidian syncing a Drive folder) renders. */
const DRIVE_MARKDOWN_EXTENSIONS: readonly string[] = [".md"];

/** The format a Drive file's content is scanned as, when it is scanned at all. */
export type DriveContentFormat = "drive-markup" | "obsidian-markdown";

/**
 * A file name's compared forms: lower-cased, and NFKC-folded with invisible characters deleted
 * and lower-cased; each with trailing whitespace and dots dropped (Windows drops them on save,
 * so `x.html.` is saved as `x.html`).
 */
function driveNameForms(name: string): readonly string[] {
  return [name.toLowerCase(), foldAndStrip(name).toLowerCase()].map((f) => {
    let end = f.length;
    while (end > 0 && (f.charAt(end - 1) === "." || f.charAt(end - 1).trim() === "")) end--;
    return f.slice(0, end);
  });
}

/**
 * Coordinator rulings (adversarial review and final review item 4, for `driveMarkupFormats`):
 * EVERY scan a `gdrive_file_create` calls for, by its type and by its name, each run and either
 * refusing. `drive-markup` when the `mimeType` scans (R11) or the `name` ends in a markup
 * extension (`.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.mht`, `.mhtml`; case-insensitive, after
 * normalisation); `obsidian-markdown` when the `name` ends in `.md`, whatever the type says (a
 * markup type does not hide a Markdown name: a Markdown app syncing the folder renders it by its
 * name). A `name` that is present but not a string calls for both (fail closed); an absent `name`
 * decides nothing. Empty: not scanned.
 */
export function driveContentFormats(
  mimeType: unknown,
  name: unknown,
): readonly DriveContentFormat[] {
  const out = new Set<DriveContentFormat>();
  if (driveMimeTypeScans(mimeType)) out.add("drive-markup");
  if (name !== undefined && typeof name !== "string") {
    out.add("drive-markup");
    out.add("obsidian-markdown");
  } else if (typeof name === "string") {
    const forms = driveNameForms(name);
    const endsIn = (exts: readonly string[]): boolean =>
      forms.some((f) => exts.some((e) => f.endsWith(e)));
    if (endsIn(DRIVE_MARKUP_EXTENSIONS)) out.add("drive-markup");
    if (endsIn(DRIVE_MARKDOWN_EXTENSIONS)) out.add("obsidian-markdown");
  }
  return [...out];
}

/** Drive markup (R4 + R12, no `cid:`): R4's steps, then R12's, as one ordered list. */
export function driveMarkupRemote(text: string, opts: DetectOptions): boolean {
  const rules: MarkupRules = { allowCid: false, confluence: false, allowFragmentUrl: true };
  const tokens = tokenizeMarkup(text); // R4 step 1
  if (tokens === undefined) return true;
  return (
    refusesTags(tokens, text, rules) || // R4 steps 2-4
    refusesCss(tokens, text, rules) || // R4 step 5, with R12's `#` relaxation
    refusesMarkupInDeclarations(tokens) || // R4 step 6
    hasCdata(tokens) || // R4 step 7
    refusesSvgElements(tokens) || // R12 SVG elements
    refusesPresentationUrls(tokens, true) || // R12 presentation attributes, `#` relaxed
    refusesXmlDeclarations(tokens) || // R12 XML declarations
    (opts.tripwire && tripwire(text, "drive")) // R4 step 8
  );
}
