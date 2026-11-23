// packages/gateway/src/connectors/connector-writes/remote-content/forge.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import { tokenizeMarkup } from "../markup-tokens.ts";
import { settle } from "../text-normalise.ts";
import { type DetectOptions, tripwire } from "./html.ts";
import { diagramFenceLoadsRemote, markdownHtmlRemote, markdownImageRemote } from "./markdown.ts";

// ---------------------------------------------------------------------------------------------
// B3w W6-W9 and W12: forge Markdown (GitHub, GitLab and Linear issues, comments and notes).
//
// Sources (retrieved 2026-11-06):
//  - GitHub renders `mermaid`, `geojson`, `topojson` and `stl` fences ("Creating diagrams",
//    https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams).
//  - GitLab renders `mermaid` and `plantuml` fences, and Kroki diagrams once an admin enables
//    Kroki ("GitLab Flavored Markdown", https://docs.gitlab.com/user/markdown/; "Kroki",
//    https://docs.gitlab.com/administration/integration/kroki/, which lists Bytefield, D2, DBML,
//    Ditaa, Erd, GraphViz, Nomnoml, PlantUML (C4 included), Structurizr, Svgbob, UMlet, Vega,
//    Vega-Lite and WaveDrom). The fence names below are those, Kroki's own lower-case type names
//    for the other formats Kroki serves, and `puml` and `kroki` (fail closed).
//  - GitLab `::include{file=...}` must start a line; external URLs need the admin setting
//    `wiki_asciidoc_allow_uri_includes`; the page names Markdown files and wiki pages, not
//    comments (GitLab Markdown, "Includes"). Refused on every surface anyway (fail closed).
//  - GitHub serves images through Camo, "an anonymous URL proxy for each file which hides your
//    browser details and related information" ("About anonymized URLs",
//    https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls);
//    the origin still learns when the image was first fetched, and a URL unique to one comment
//    tells which was read. GitLab loads external images directly unless an admin set up the
//    asset proxy: without it "the external server [can] log the IP address of the user"
//    ("Proxying assets", https://docs.gitlab.com/security/asset_proxy/). One rule refuses both.
//  - Linear's GraphQL guide describes an issue description as "markdown" and renders Markdown in
//    comments ("Getting started", https://linear.app/developers/graphql); whether Linear proxies
//    external images is not established there. Refused either way (owner ruling OR-B3w-2).
//
// The rules, in order (`forgeMarkdownRemote`): (a) the Markdown-HTML scan (R9 (a)); (b) EVERY `![`
// in the raw and both settled forms, with no vault-embed exemption (W6 (b), W8: the destination
// of a Markdown image cannot be found without a CommonMark parser, so `![](/uploads/x.png)` is
// refused while a relative raw-HTML `<img src="/uploads/x.png">` is allowed by R2); (c) a diagram
// fence holding a URL; (d) a GitLab `::include` line; (e) the tripwire. Code fences and code
// spans are NOT exempt (owner ruling OR-B3w-3, I53 bound (34)).
// ---------------------------------------------------------------------------------------------

/** The fence languages GitHub and GitLab render as diagrams, maps or models (sources above). */
const FORGE_DIAGRAM_FENCES: ReadonlySet<string> = new Set([
  "mermaid",
  "geojson",
  "topojson",
  "stl",
  "plantuml",
  "puml",
  "c4plantuml",
  "kroki",
  "bytefield",
  "d2",
  "dbml",
  "ditaa",
  "erd",
  "graphviz",
  "dot",
  "nomnoml",
  "structurizr",
  "svgbob",
  "umlet",
  "vega",
  "vega-lite",
  "vegalite",
  "wavedrom",
  "blockdiag",
  "seqdiag",
  "actdiag",
  "nwdiag",
  "packetdiag",
  "rackdiag",
  "bpmn",
  "excalidraw",
  "pikchr",
  "symbolator",
  "tikz",
  "wireviz",
]);

/** Whether a line begins, after spaces, TABs and blockquote `>` markers, with `::include`. */
function startsWithInclude(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === ">")) i++;
  return line.startsWith("::include", i);
}

/**
 * W6 (d): a GitLab `::include` line, in the raw form and both settled forms (line breaks kept),
 * after any blockquote markers (B3w review fix 2). An unsettled text refuses (review fix 6).
 */
function gitlabIncludeIn(text: string): boolean {
  const deleted = settle(text, "", true);
  const spaced = settle(text, " ", true);
  if (deleted === undefined || spaced === undefined) return true;
  return [text.toLowerCase(), deleted, spaced].some((form) =>
    form.split("\n").some(startsWithInclude),
  );
}

/** Forge Markdown (W6): the five rules, in order. */
export function forgeMarkdownRemote(text: string, opts: DetectOptions): boolean {
  const tokens = tokenizeMarkup(text); // (a) step 1
  if (tokens === undefined) return true;
  return (
    markdownHtmlRemote(tokens, text) || // (a) the Markdown-HTML scan
    markdownImageRemote(text, { vaultEmbeds: false }) || // (b) every Markdown image
    diagramFenceLoadsRemote(text, FORGE_DIAGRAM_FENCES) || // (c) diagram fences holding a URL
    gitlabIncludeIn(text) || // (d) GitLab includes
    (opts.tripwire && tripwire(text, "default")) // (e) the tripwire
  );
}
