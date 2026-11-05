// packages/gateway/src/connectors/testing/remote-content-fixtures.ts
// Test fixtures for the B3r remote-content refusal on the REAL doors (plan Tasks 5-6): every
// structural bypass form of both adversarial reviews, placed in the scanned field of a real row
// (the Outlook HTML draft, a Confluence page append or comment, a Notion block append or page
// update, the Obsidian daily-note append, a Drive file create), each beside allowed cases. The
// door tests (`model-write-refusals` doors, the act door's submit and accept, the injection
// suite) run all of them; the detector unit tests live in `remote-content.test.ts`.
//
// Invisible, bidi and fullwidth characters are built from code points, never written literally.

/** One door input: the real row and the exact input the model or an MCP client proposes. */
export interface RemoteContentDoorCase {
  readonly label: string;
  readonly toolId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

const cp = (n: number): string => String.fromCodePoint(n);
const VT = cp(0x0b);
const LF = cp(0x0a);
const TAB = cp(0x09);
const ZWSP = cp(0x200b);
const FULLWIDTH_QUOTE = cp(0xff02);
const FULLWIDTH_COLON = cp(0xff1a);
const FULLWIDTH_SOLIDUS = cp(0xff0f);
const FULLWIDTH_BANG = cp(0xff01);
const BACKTICKS = "\x60\x60\x60";

function outlook(label: string, body: string): RemoteContentDoorCase {
  return {
    label: `outlook draft: ${label}`,
    toolId: "outlook_draft_create",
    input: { to: "a@x.com", subject: "S", body, contentType: "html" },
  };
}

function append(label: string, storageHtml: string): RemoteContentDoorCase {
  return {
    label: `confluence append: ${label}`,
    toolId: "confluence_page_append",
    input: { pageId: "123", storageHtml },
  };
}

function comment(label: string, storageHtml: string): RemoteContentDoorCase {
  return {
    label: `confluence comment: ${label}`,
    toolId: "confluence_comment_add",
    input: { pageId: "123", storageHtml },
  };
}

function create(label: string, storageHtml: string): RemoteContentDoorCase {
  return {
    label: `confluence create: ${label}`,
    toolId: "confluence_page_create",
    input: { spaceKey: "ENG", title: "T", storageHtml },
  };
}

function update(label: string, storageHtml: string): RemoteContentDoorCase {
  return {
    label: `confluence update: ${label}`,
    toolId: "confluence_page_update",
    input: { pageId: "123", versionNumber: 7, title: "T", storageHtml },
  };
}

function blocks(label: string, childrenJson: string): RemoteContentDoorCase {
  return {
    label: `notion block append: ${label}`,
    toolId: "notion_block_append",
    input: { parentBlockId: "ffff", childrenJson },
  };
}

function properties(label: string, propertiesJson: string): RemoteContentDoorCase {
  return {
    label: `notion page update: ${label}`,
    toolId: "notion_page_update",
    input: { pageId: "ffff", propertiesJson },
  };
}

function obsidian(label: string, content: string): RemoteContentDoorCase {
  return {
    label: `obsidian append: ${label}`,
    toolId: "obsidian_append_to_daily_note",
    input: { vault_id: "Work", content },
  };
}

function drive(
  label: string,
  content: string,
  over: Readonly<Record<string, unknown>> = { mimeType: "image/svg+xml" },
): RemoteContentDoorCase {
  return {
    label: `drive create: ${label}`,
    toolId: "gdrive_file_create",
    input: { name: "file", content, ...over },
  };
}

function macro(name: string, inner: string): string {
  return `<ac:structured-macro ac:name="${name}">${inner}</ac:structured-macro>`;
}

function param(name: string, value: string): string {
  return `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
}

function threeDeep(leaf: string): string {
  return `[{"toggle":{"rich_text":[],"children":[{"bulleted_list_item":{"rich_text":[],"children":[${leaf}]}}]}}]`;
}

const ESCAPED_URL = String.raw`p{background:u\72l(//h)}`;
const ESCAPED_IMPORT = String.raw`p{background:@\69mport "//h/x.css"}`;

/** HTML bypass forms, each refused in an Outlook HTML draft AND in Confluence storage. */
const HTML_REFUSED: ReadonlyArray<readonly [string, string]> = [
  ["a `>` in a quoted value", `<a title="x>"><link href=//h>`],
  ['a `"` in a single-quoted value', `<a b='"'><base href=//h>`],
  ["VT is not whitespace", `<a b=${VT}"x><link href=//h>">`],
  ["a fullwidth quote", `<a b=${FULLWIDTH_QUOTE}c><link href=//h>${FULLWIDTH_QUOTE}>`],
  ["a split tag", "<im<link href=//h>g>"],
  ["a tag inside a tag", "<a <base href=//h>>"],
  ["a tag inside a quoted value", `<a title="<base href=//h>">`],
  ["`/` as a separator", "<link/href=//h>"],
  ["upper case", "<LINK HREF=//h>"],
  ["mixed case", "<LiNk>"],
  ["newlines in a tag", `<link${LF}${TAB}href${LF}=${LF}"//h">`],
  ["end of input in a tag", "<p"],
  ["end of input in a comment", "<!-- x"],
  ["a base element with a relative href", "<base href=x/>"],
  ["a conditional comment", "<!--[if mso]><link href=//h><![endif]-->"],
  ["an Outlook conditional cid image", `<!--[if mso]><img src="cid:x"><![endif]-->`],
  ["a processing instruction holding `<`", `<?x a="<img"?>`],
  ["VML fill", `<v:fill src="//h"/>`],
  ["table background", "<table background=//h></table>"],
  ["video poster", "<video poster=//h></video>"],
  ["a relative srcset", `<img srcset="a.png 1x">`],
  ["srcset hiding an external URL", `<img srcset="a.png 1x, //h 2x">`],
  ["picture source srcset", `<picture><source srcset="a.png"></picture>`],
  ["an SVG image", "<svg><image href=//h/></svg>"],
  ["an SVG use", `<svg><use xlink:href="//h#x"/></svg>`],
  ["meta refresh", `<meta http-equiv=refresh content="0;url=//h">`],
  ["an iframe", "<iframe src=x></iframe>"],
  ["an object", "<object data=x></object>"],
  ["an embed", "<embed src=x>"],
  ["a script", "<script></script>"],
  ["@import in a style element", "<style>@import 'x.css'</style>"],
  ["an escaped url in a style element", String.raw`<style>p{background:u\72l(x)}</style>`],
  ["a comment-split url in a style element", "<style>p{background:u/**/rl(x)}</style>"],
  ["escapes forming a comment opener", String.raw`<p style="color:red \2f\2a">`],
  [
    "escapes forming a comment around image()",
    String.raw`<p style="\2f\2a x image('https://x') x \2a\2f">`,
  ],
  [
    "a comment in a string hiding url(",
    `<p style='content:"/*";background:url(//h);content:"*/"'>`,
  ],
  ["image-set in a style attribute", `<p style="background-image:image-set('//h' 1x)">`],
  ["behavior in a style attribute", `<p style="behavior:url(x.htc)">`],
  ["ping", "<a href=x ping=//h>x</a>"],
  ["an event handler", `<p onclick="x">`],
  ["&sol; slashes", `<img src="&sol;&sol;h/x">`],
  ["an entity in the scheme", `<img src="&#104;ttps://h">`],
  ["a line feed inside javascript:", `<img src="java${LF}script:alert(1)">`],
  ["data:", `<img src="data:image/png;base64,AAAA">`],
  ["a fullwidth colon", `<img src="https${FULLWIDTH_COLON}//h">`],
  ["a zero-width space between the slashes", `<img src="/${ZWSP}/h">`],
  ["an absolute tracking pixel", "<p>hi<img src=https://h/p.gif></p>"],
  ["an unclosed style", "<style>p{color:red}"],
  ["an unclosed title", "<title>x"],
  ["a fake </style> closer (VT), closed later", `<style>p{}</style${VT}>${ESCAPED_URL}</style>`],
  [
    "a fake </style> closer (ZWSP), closed later",
    `<style>p{}</style${ZWSP}>${ESCAPED_URL}</style>`,
  ],
  ["a fake </x:style> closer", `<style>p{}</x:style>${ESCAPED_IMPORT}</style>`],
  ["a fake </style> closer, never closed", `<style>p{}</style${VT}>${ESCAPED_URL}`],
  ["an HTML closer inside an attribute", `<style>p{}<a title="</style>">${ESCAPED_URL}</style>`],
  ["CSS only HTML's view reads", `<style><a b=x}${ESCAPED_URL}></a></style>`],
  ["nested raw-text elements", "<style><style>p{}</style></style>"],
  ["an SVG mask with an escaped url", String.raw`<svg><rect mask="u\72l(https://h/x.png)"/></svg>`],
  [
    "SMIL setting an href",
    `<svg><image href="x.png"><set attributeName="href" to="https://h/p.png"/></image></svg>`,
  ],
  ["foreignObject", "<svg><foreignObject><p>x</p></foreignObject></svg>"],
  ["a fragment url outside Drive", `<svg><rect fill="url(#g)"/></svg>`],
  ["xml:base", `<svg xml:base="https://h/"><image href="x.png"/></svg>`],
  ["17 openers in one tag", `<a title="${"<b>".repeat(17)}">`],
];

/** HTML forms allowed in an Outlook HTML draft AND in Confluence storage. */
const HTML_ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["a link", `<a href="https://h">x</a>`],
  ["a protocol-relative link", "<a href=//h>x</a>"],
  ["a less-than in text", "<p>a < b</p>"],
  ["a plain comment", "<!-- note -->"],
  ["a colour style", `<p style="color:red">x</p>`],
  ["a relative image", `<img src="/wiki/download/attachments/1/x.png">`],
  ["a closed style element", "<style>p{color:red}</style><p>x</p>"],
  ["an alt text with parentheses", `<img src="x.png" alt="Image (1)">`],
];

/** Confluence-only refused forms (R5 and the review). */
const STORAGE_REFUSED: ReadonlyArray<readonly [string, string]> = [
  ["an ri:url image", `<ac:image><ri:url ri:value="https://h/x.png"/></ac:image>`],
  ["an ri:url link", `<ac:link><ri:url ri:value="https://h"/></ac:link>`],
  ["a res:url element", `<ac:image><res:url xmlns:res="x" res:value="x.png"/></ac:image>`],
  ["the iframe macro", macro("iframe", "")],
  ["the widget macro", macro("widget", "")],
  ["the html macro", macro("html", "")],
  ["the rss macro", macro("rss", "")],
  ["the roadmap macro", macro("roadmap", "")],
  ["an unknown macro", macro("foo", "")],
  ["a macro without ac:name", "<ac:structured-macro></ac:structured-macro>"],
  ["the legacy ac:macro iframe", `<ac:macro ac:name="iframe"></ac:macro>`],
  ["a panel parameter holding a URL", macro("panel", param("x", "https://h"))],
  ["a panel title with a javascript: scheme", macro("panel", param("title", "JaVaScRiPt:x"))],
  ["a protocol-relative panel title", macro("panel", param("title", "//h"))],
  [
    "a jira url parameter",
    macro("jira", param("url", "https://h/sr/jira.issueviews:searchrequest-xml/1/x.xml")),
  ],
  ["a relative jira baseurl", macro("jira", param("baseurl", "/browse"))],
  ["an upper-case jira URL parameter", macro("jira", param("URL", "/x.xml"))],
  ["a jira title that is a URL", macro("jira", param("title", "https://h"))],
  [
    "a jira default parameter",
    macro(
      "jira",
      "<ac:default-parameter>/sr/jira.issueviews:searchrequest-xml/1/x.xml</ac:default-parameter>",
    ),
  ],
  ["an ADF extension", "<ac:adf-extension></ac:adf-extension>"],
  [
    "CDATA in an info macro's body",
    macro("info", "<ac:plain-text-body><![CDATA[<base href=//h>]]></ac:plain-text-body>"),
  ],
  ["bare CDATA holding markup", "<p><![CDATA[<base href=//h>]]></p>"],
  ["an absolute tenant image", `<img src="https://acme.atlassian.net/wiki/download/x.png">`],
  ["a cid image (no cid: in storage)", `<img src="cid:logo">`],
];

/** Confluence-only allowed forms. */
const STORAGE_ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["an attachment image", `<ac:image><ri:attachment ri:filename="x.png"/></ac:image>`],
  ["a page link", `<ac:link><ri:page ri:content-title="Runbook"/></ac:link>`],
  ["a user link", `<ac:link><ri:user ri:account-id="1"/></ac:link>`],
  [
    "an info macro with a rich-text body",
    macro("info", "<ac:rich-text-body><p>Hi</p></ac:rich-text-body>"),
  ],
  [
    "a jira macro by application link",
    macro(
      "jira",
      param("server", "System JIRA") + param("serverId", "a1b2") + param("key", "ENG-1"),
    ),
  ],
  ["a jira macro with JQL", macro("jira", param("jqlQuery", "project = ENG AND status = Open"))],
  [
    "a code macro whose CDATA holds an image (exempt)",
    macro("code", `<ac:plain-text-body><![CDATA[<img src="https://h">]]></ac:plain-text-body>`),
  ],
  ['a panel title "Note: x" (coordinator ruling)', macro("panel", param("title", "Note: x"))],
];

const NOTION_BLOCKS_REFUSED: ReadonlyArray<readonly [string, string]> = [
  ["an embed nested three deep", threeDeep(`{"type":"embed","embed":{"url":"https://h"}}`)],
  [
    "an external image three deep",
    threeDeep(`{"type":"image","image":{"type":"external","external":{"url":"https://h"}}}`),
  ],
  ["a bookmark", `[{"type":"bookmark","bookmark":{"url":"https://h"}}]`],
  ["a video with its own url", `[{"video":{"url":"https://h"}}]`],
  [
    "a callout icon.external",
    `[{"callout":{"rich_text":[],"icon":{"external":{"url":"https://h"}}}}]`,
  ],
  [
    "a link_preview mention",
    `[{"paragraph":{"rich_text":[{"type":"mention","mention":{"type":"link_preview","link_preview":{"url":"https://h"}}}]}}]`,
  ],
  ["an upper-case Embed key", `[{"Embed":{"url":"https://h"}}]`],
  ["65 levels of nesting", `${"[".repeat(65)}${"]".repeat(65)}`],
  ["not JSON", "[{"],
  ["an object given as blocks", "{}"],
];

const NOTION_BLOCKS_ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["no blocks", "[]"],
  [
    "a file_upload image",
    `[{"type":"image","image":{"type":"file_upload","file_upload":{"id":"x"}}}]`,
  ],
  [
    "a text link",
    `[{"paragraph":{"rich_text":[{"type":"text","text":{"content":"x","link":{"url":"https://h"}}}]}}]`,
  ],
];

const NOTION_PROPERTIES_REFUSED: ReadonlyArray<readonly [string, string]> = [
  [
    "an external file entry",
    `{"Files":{"files":[{"name":"x","type":"external","external":{"url":"https://h"}}]}}`,
  ],
  ["a JSON __proto__ key", `{"__proto__":{"external":{}}}`],
  ["an array given as properties", "[]"],
];

const NOTION_PROPERTIES_ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["no properties", "{}"],
  ["a url property", `{"Site":{"url":"https://h"}}`],
];

const OBSIDIAN_REFUSED: ReadonlyArray<readonly [string, string]> = [
  ["an image with no alt", "![](https://h)"],
  ["a space before the URL", "![x]( https://h)"],
  ["an angle-bracket URL", "![x](<https://h>)"],
  ["a reference image", `![x][r]${LF}[r]: https://h`],
  ["a relative image", "![x](a.png)"],
  ["a URL as an embed target", "![[https://h]]"],
  ["a colon in an embed target", "![[a:b]]"],
  ["an absolute embed target", "![[/x]]"],
  ["an unterminated embed", "![[x"],
  ["an inline img", "<img src=//h>"],
  ["an inline iframe", "<iframe src=//h></iframe>"],
  ["an inline link element", "<link href=x>"],
  ["a fullwidth bang", `${FULLWIDTH_BANG}[](https://h)`],
  ["an escaped bang (stated)", "\\![x](https://h)"],
  [
    "a mermaid click URL",
    `${BACKTICKS}mermaid${LF}graph TD${LF}click A "https://h/x"${LF}${BACKTICKS}`,
  ],
  ["an upper-case mermaid fence", `~~~MERMAID${LF}click A "//h"${LF}~~~`],
  ["an SVG mask with an escaped url", String.raw`<svg><rect mask="u\72l(https://h/x.png)"/></svg>`],
  ["a fake </style> closer", `<style>p{}</style${VT}>${ESCAPED_URL}</style>`],
];

const OBSIDIAN_ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["a note embed", "![[note]]"],
  ["a sized image embed", "![[img.png|200]]"],
  ["a link", "[link](https://h)"],
  ["an autolink", "<https://h>"],
  [
    "a mermaid diagram with labels",
    `${BACKTICKS}mermaid${LF}sequenceDiagram${LF}Alice->>Bob: Hello${LF}${BACKTICKS}`,
  ],
  ["plain text", "- standup done, see [notes](https://example.com/notes)"],
];

const DRIVE_REFUSED: ReadonlyArray<RemoteContentDoorCase> = [
  drive("an SVG image href", `<svg><image href="//h/x.png"/></svg>`),
  drive("an SVG image xlink:href", `<svg><image xlink:href="https://h/x.png"/></svg>`),
  drive("an SVG use", `<svg><use href="https://h/s.svg#i"/></svg>`),
  drive("an SVG feImage", "<svg><feImage href=//h/></svg>"),
  drive("foreignObject", "<svg><foreignObject><p>x</p></foreignObject></svg>"),
  drive("FOREIGNOBJECT", "<FOREIGNOBJECT></FOREIGNOBJECT>"),
  drive("@import in an SVG style", "<svg><style>@import url(//h/x.css);</style></svg>"),
  drive(
    "an external url in an SVG style",
    "<svg><style>rect{fill:url(https://h/p.svg#g)}</style></svg>",
  ),
  drive("an external fill", `<rect fill="url(https://h/p.svg#g)"/>`),
  drive("a quoted external filter", `<rect filter="url( '//h#f' )"/>`),
  drive("an unterminated mask url", `<rect mask="url(#m"/>`),
  drive("every url( is checked", `<rect filter="url(#a) url(https://x/y.svg#z)"/>`),
  drive("SMIL set href", `<set attributeName="href" to="//h"/>`),
  drive("SMIL animate xlink:href", `<animate attributeName="xlink:href" values="a;//h"/>`),
  drive("xml-stylesheet", `<?xml-stylesheet href="//h/x.css"?>`),
  drive("a SYSTEM doctype", `<!DOCTYPE svg SYSTEM "https://h/x.dtd">`),
  drive("a doctype internal subset", `<!DOCTYPE svg [<!ENTITY e SYSTEM "https://h">]>`),
  drive(
    "the XHTML PUBLIC doctype (owner-accepted)",
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">`,
    { mimeType: "application/xhtml+xml" },
  ),
  drive("CDATA in an SVG style", "<svg><style><![CDATA[rect{fill:red}]]></style></svg>"),
  drive("xml:base", `<svg xml:base="https://h/"><image href="x.png"/></svg>`),
  drive("TEXT/HTML with parameters", "<link rel=stylesheet href=//h>", {
    mimeType: "TEXT/HTML; charset=UTF-8",
  }),
  drive("text/html;charset=UTF-8", "<img src=//h>", { mimeType: "text/html;charset=UTF-8" }),
  drive("a ZWSP inside the type", "<img src=//h>", { mimeType: `text${ZWSP}/html` }),
  drive("a fullwidth solidus in the type", "<img src=//h>", {
    mimeType: `text${FULLWIDTH_SOLIDUS}html`,
  }),
  drive("text/xml", "<img src=//h>", { mimeType: "text/xml" }),
  drive("a Google Apps type", "<img src=//h>", {
    mimeType: "application/vnd.google-apps.document",
  }),
  drive("an empty type", "<img src=//h>", { mimeType: "" }),
  drive("a non-string type", "<img src=//h>", { mimeType: 42 }),
  drive("a .html name with a text/plain type", "<img src=//h>", {
    mimeType: "text/plain",
    name: "report.HTML",
  }),
  drive("a .svg name with no type", `<svg><image href="//h/x.png"/></svg>`, { name: "logo.svg" }),
  drive("a .html. name (trailing dot)", "<img src=//h>", { name: "report.html." }),
  drive("a .md name holding a Markdown image", "![x](https://h/p.gif)", { name: "notes.md" }),
];

const DRIVE_ALLOWED: ReadonlyArray<RemoteContentDoorCase> = [
  drive("a gradient fill", `<svg><rect fill="url(#g)"/><linearGradient id="g"/></svg>`),
  drive("an SVG link", `<svg><a href="https://h"><text>x</text></a></svg>`),
  drive("an XML declaration", `<?xml version="1.0"?><svg/>`),
  drive("a text/plain file holding HTML (not scanned)", "<img src=//h>", {
    mimeType: "text/plain",
  }),
  drive("no type and a plain name (not scanned)", "<img src=//h>", { name: "report.txt" }),
  drive("an empty HTML file", "", { mimeType: "text/html" }),
  drive("a .md name with a link", "[x](https://h)", { name: "notes.md" }),
];

/** Every structural bypass form of both reviews, in the scanned field of a real row. */
export const REMOTE_CONTENT_REFUSED_CASES: readonly RemoteContentDoorCase[] = [
  ...HTML_REFUSED.map(([l, b]) => outlook(l, b)),
  ...HTML_REFUSED.map(([l, b]) => append(l, b)),
  ...STORAGE_REFUSED.map(([l, b]) => append(l, b)),
  ...STORAGE_REFUSED.map(([l, b]) => comment(l, b)),
  ...STORAGE_REFUSED.map(([l, b]) => create(l, b)),
  ...STORAGE_REFUSED.map(([l, b]) => update(l, b)),
  ...NOTION_BLOCKS_REFUSED.map(([l, b]) => blocks(l, b)),
  ...NOTION_PROPERTIES_REFUSED.map(([l, b]) => properties(l, b)),
  ...OBSIDIAN_REFUSED.map(([l, b]) => obsidian(l, b)),
  ...DRIVE_REFUSED,
];

/** The allowed forms beside them: each reaches the owner's prompt (or is queued) as before. */
export const REMOTE_CONTENT_ALLOWED_CASES: readonly RemoteContentDoorCase[] = [
  ...HTML_ALLOWED.map(([l, b]) => outlook(l, b)),
  outlook("a cid image", `<img src="cid:logo">`),
  {
    label: "outlook draft: sent as Text, a pixel shown literally",
    toolId: "outlook_draft_create",
    input: { to: "a@x.com", subject: "S", body: "<img src=//h>", contentType: "text" },
  },
  {
    label: "outlook draft: no contentType (Text), a pixel shown literally",
    toolId: "outlook_draft_create",
    input: { to: "a@x.com", subject: "S", body: "<img src=//h>" },
  },
  ...HTML_ALLOWED.map(([l, b]) => append(l, b)),
  ...STORAGE_ALLOWED.map(([l, b]) => append(l, b)),
  ...STORAGE_ALLOWED.map(([l, b]) => comment(l, b)),
  ...STORAGE_ALLOWED.map(([l, b]) => create(l, b)),
  ...STORAGE_ALLOWED.map(([l, b]) => update(l, b)),
  ...NOTION_BLOCKS_ALLOWED.map(([l, b]) => blocks(l, b)),
  ...NOTION_PROPERTIES_ALLOWED.map(([l, b]) => properties(l, b)),
  ...OBSIDIAN_ALLOWED.map(([l, b]) => obsidian(l, b)),
  ...DRIVE_ALLOWED,
];
