// packages/gateway/src/connectors/connector-writes/remote-content.ts
// The remote-content detectors of Phase 9.7 PRs B3r and B3w (owner rulings OR-B3-2, OR-B3r-1..4
// and OR-B3w-1..3): does a model-written draft, page, note, markup file, sent Outlook mail, Teams
// HTML message or GitHub, GitLab or Linear Markdown body load remote content (an external image,
// embed, frame, stylesheet, refresh or base URL) when someone opens it?
// `remoteContentIn(format, text)` returns `true` to refuse. Pure: a string in, a boolean out; no network, config or Vault.
//
// These are DETECTORS, never sanitizers: nothing here strips, rewrites or returns modified text
// (CodeQL js/incomplete-multi-character-sanitization, js/bad-tag-filter). HTML and storage are read
// through the structural tokenizer (`markup-tokens.ts`), and decisions are made on single
// extracted values (one attribute value, one CSS text, one parameter text) and on the textual
// tripwire (R6), whose patterns match no tag. A source pin (`markup-tokens.test.ts`) keeps
// `.replace(`, `RegExp(` and any regex literal containing `<` out of this file. Anything that
// does not tokenize, parse or settle is refused (fail closed).
//
// The rules (plan R2-R6), in the order each detector applies them:
//  1. The input does not tokenize: refused.
//  2. Elements (compared lower-cased, NFKC-folded with invisible characters deleted, and as the
//     local part after the last `:` of each): `base`, `link`, `iframe`, `frame`, `frameset`,
//     `object`, `embed`, `applet`, `portal`, `fencedframe`, `script`; `meta` with `http-equiv`.
//  3. Attributes on ANY element (compared the same ways): an external URL (R2) in `src`, `lowsrc`,
//     `dynsrc`, `poster`, `background`, `data`, `codebase`, `icon` or `manifest`; an external
//     `href` (`xlink:href`, any `*:href`) on any element whose local name is not `a` or `area`;
//     any non-empty `ping` or `archive` (URL lists, decided like `srcset`); any `on*` event
//     handler (script can fetch).
//  4. A non-empty `srcset` or `imagesrcset`, whatever its URLs.
//  5. CSS: a `style` attribute and the text of a `<style>` element (to its matching end tag, or
//     the end of input) that calls a loading function or `@import`s (`cssLoadsRemote`); markup
//     that ends inside an open `style`, `script`, `title`, `textarea`, `xmp`, `noembed`,
//     `noframes` or `noscript` element.
//  6. A comment, declaration or processing instruction whose text contains `<` (an Outlook
//     conditional comment is rendered by Outlook desktop).
//  7. CDATA: refused in Outlook HTML (an HTML parser ends it at the first `>`, an XML parser does
//     not); in Confluence storage it is scanned recursively (R5).
//  8. The textual tripwire (R6), over the raw, deleted-invisible and spaced-invisible forms.
// Confluence storage adds R5; Drive markup adds R12 (SVG, XHTML and XML forms). Notion JSON (R8)
// is parsed and walked, and Obsidian Markdown (R9) is the HTML scan plus a fixed `![` rule.
import { REMOTE_SCAN_MAX_CHARS } from "./markup-tokens.ts";
import { confluenceStorageRemote } from "./remote-content/confluence.ts";
import { driveMarkupRemote } from "./remote-content/drive.ts";
import { forgeMarkdownRemote } from "./remote-content/forge.ts";
import {
  DEFAULT_DETECT_OPTIONS,
  type DetectOptions,
  outlookHtmlRemote,
  teamsHtmlRemote,
} from "./remote-content/html.ts";
import { obsidianRemote } from "./remote-content/markdown.ts";
import { notionRemote } from "./remote-content/notion.ts";
import { nameFormCache } from "./remote-content/shared.ts";

export { CONFLUENCE_INERT_MACROS } from "./remote-content/confluence.ts";
export { cssLoadsRemote } from "./remote-content/css.ts";
export {
  type DriveContentFormat,
  driveContentFormats,
  driveMimeTypeScans,
} from "./remote-content/drive.ts";
export { urlIsExternal } from "./remote-content/shared.ts";

/** The body formats a scanned row's field is read as (see `REMOTE_CONTENT_SCANNED`). */
export type RemoteContentFormat =
  | "outlook-html"
  | "teams-html"
  | "confluence-storage"
  | "notion-blocks"
  | "notion-properties"
  | "obsidian-markdown"
  | "forge-markdown"
  | "drive-markup";

// ---------------------------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------------------------

/**
 * Whether `text`, written as `format`, would load remote content when opened (`true` refuses).
 * Fail closed: an input over {@link REMOTE_SCAN_MAX_CHARS}, one that does not tokenize or parse,
 * and any throw inside a detector all refuse. `opts.tripwire` is a TEST SEAM only (it isolates the
 * structural rules from R6); production callers pass two arguments.
 */
export function remoteContentIn(
  format: RemoteContentFormat,
  text: string,
  opts: DetectOptions = DEFAULT_DETECT_OPTIONS,
): boolean {
  if (text.length > REMOTE_SCAN_MAX_CHARS) return true;
  try {
    switch (format) {
      case "outlook-html":
        return outlookHtmlRemote(text, opts);
      case "teams-html":
        return teamsHtmlRemote(text, opts);
      case "confluence-storage":
        return confluenceStorageRemote(text, opts);
      case "notion-blocks":
        return notionRemote(text, "blocks");
      case "notion-properties":
        return notionRemote(text, "properties");
      case "obsidian-markdown":
        return obsidianRemote(text, opts);
      case "forge-markdown":
        return forgeMarkdownRemote(text, opts);
      case "drive-markup":
        return driveMarkupRemote(text, opts);
    }
  } catch {
    return true;
  } finally {
    nameFormCache.clear();
  }
}
