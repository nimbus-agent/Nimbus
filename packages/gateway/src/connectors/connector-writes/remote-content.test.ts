import { describe, expect, test } from "bun:test";
import {
  CONFLUENCE_INERT_MACROS,
  cssLoadsRemote,
  type RemoteContentFormat,
  remoteContentIn,
  urlIsExternal,
} from "./remote-content.ts";

// Characters that must never appear literally in source: built from code points.
const TAB = String.fromCodePoint(0x09);
const LF = String.fromCodePoint(0x0a);
const VT = String.fromCodePoint(0x0b);
const NUL = String.fromCodePoint(0x00);
const ZWSP = String.fromCodePoint(0x200b);
const FULLWIDTH_COLON = String.fromCodePoint(0xff1a);
const FULLWIDTH_QUOTE = String.fromCodePoint(0xff02);

/** Refused with the tripwire on; with `structural`, also refused with the tripwire off. */
function expectRefused(format: RemoteContentFormat, text: string, structural: boolean): void {
  expect(remoteContentIn(format, text)).toBe(true);
  if (structural) expect(remoteContentIn(format, text, { tripwire: false })).toBe(true);
}

function expectAllowed(format: RemoteContentFormat, text: string): void {
  expect(remoteContentIn(format, text)).toBe(false);
}

// ---------------------------------------------------------------------------------------------
// R2: urlIsExternal (Review Focus 2)
// ---------------------------------------------------------------------------------------------

describe("urlIsExternal (plan R2)", () => {
  const external: readonly (readonly [string, string])[] = [
    ["protocol-relative //", "//h"],
    ["backslashes", "\\\\h"],
    ["slash, backslash", "/\\h"],
    ["backslash, slash", "\\/h"],
    ["a TAB between the slashes", `/${TAB}/h`],
    ["leading spaces and a NUL", ` ${NUL}//h`],
    ["upper-case scheme", "HTTPS://h"],
    ["decimal entity in the scheme", "&#104;ttps://h"],
    ["hex entity slashes", "&#x2F;&#x2F;h"],
    ["decimal entity slashes", "&#47;&#47;h"],
    ["decimal entity slashes without `;`", "&#47&#47h"],
    ["an unknown named entity (&sol;)", "&sol;&sol;h"],
    ["an unknown entity inside the scheme (&Tab;)", "ht&Tab;tps://h"],
    ["a line feed inside javascript:", `java${LF}script:alert(1)`],
    ["data:", "data:image/png;base64,AAAA"],
    ["a fullwidth colon (NFKC)", `https${FULLWIDTH_COLON}//h`],
    ["a zero-width space between the slashes", `/${ZWSP}/h`],
    ["mailto:", "mailto:x@h"],
    ["a Windows drive", "C:\\x.png"],
    ["an absolute tenant URL", "https://acme.atlassian.net/wiki/download/x.png"],
    ["a value that does not settle", "&amp;amp;amp;amp;amp;"],
  ];
  test.each(external)("external in both settings: %s", (_label, v) => {
    expect(urlIsExternal(v, { allowCid: false })).toBe(true);
    expect(urlIsExternal(v, { allowCid: true })).toBe(true);
  });

  test.each([["cid:logo"], ["CID:logo"], ["&#99;id:logo"]])(
    "%s: allowed only with allowCid (Outlook)",
    (v) => {
      expect(urlIsExternal(v, { allowCid: true })).toBe(false);
      expect(urlIsExternal(v, { allowCid: false })).toBe(true);
    },
  );

  test.each([
    ["x.png"],
    ["#a"],
    [""],
    ["/wiki/download/attachments/1/x.png"],
    ["a/b//c"],
    ["a.png?x=1&amp;y=2"],
  ])("not external: %s", (v) => {
    expect(urlIsExternal(v, { allowCid: false })).toBe(false);
    expect(urlIsExternal(v, { allowCid: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// R4 step 5: cssLoadsRemote
// ---------------------------------------------------------------------------------------------

describe("cssLoadsRemote (plan R4 step 5 and Review fix 1)", () => {
  test.each([
    ["@import", "@import 'x.css'"],
    ["a hex escape inside url", "p{background:u\\72l(x)}"],
    ["a comment inside url", "p{background:u/**/rl(x)}"],
    ["image-set", "background-image:image-set('//h' 1x)"],
    ["behavior", "behavior:url(x.htc)"],
    ["an unterminated comment", "color:red /* unterminated"],
    ["escapes forming a comment around image()", "\\2f\\2a x image('https://x') x \\2a\\2f"],
    ["escapes forming a comment opener (Review fix 1)", "color:red \\2f\\2a"],
    ["escapes forming a comment closer (Review fix 1)", "color:red \\2a\\2f"],
    ["image()", "background:image('x.png')"],
    ["-webkit-image-set()", "background:-webkit-image-set('x.png' 1x)"],
    ["cross-fade()", "background:cross-fade(a, b)"],
    ["element()", "background:element(#x)"],
    ["src()", "background:src('x')"],
    ["expression()", "width:expression(alert(1))"],
    ["upper-case URL(", "background:URL(x)"],
    ["whitespace before (", "background:url (x)"],
    [
      "a comment inside a string does not hide url",
      `content:"/*";background:url(//h);content:"*/"`,
    ],
    ["an escaped @import", "@\\69mport 'x.css'"],
    ["an entity-encoded url", "&#117;rl(x)"],
    ["an entity inside url", "u&#x72;l(x)"],
    ["an entity-encoded comment opener left open", "a&#47;&#42; b"],
    ["url(cid:)", "background:url(cid:x)"],
    ["url(#) outside Drive markup", "fill:url(#a)"],
    ["a relative url", "background:url(x.png)"],
    ["a zero-width space inside url (deleted form)", `u${ZWSP}rl(x)`],
    ["an escaped newline joining url", `ur\\${LF}l(x)`],
  ])("refused: %s", (_label, css) => {
    expect(cssLoadsRemote(css)).toBe(true);
  });

  test.each([
    ["a colour", "color:red"],
    ["a string", `content:"a"`],
    ["a closed comment", "/* note */ color:red"],
    ["an escaped letter", "font-family:\\41rial"],
    ["a word containing url without (", "--urlish:1"],
  ])("allowed: %s", (_label, css) => {
    expect(cssLoadsRemote(css)).toBe(false);
  });

  test.each([
    ["fill:url(#g)"],
    ["fill:url( '#g' )"],
    [`fill:url("#g")`],
    ["fill:url(#a); stroke:url(#b)"],
  ])("Drive markup allows a fragment url: %s", (css) => {
    expect(cssLoadsRemote(css, { allowFragmentUrl: true })).toBe(false);
    expect(cssLoadsRemote(css)).toBe(true);
  });

  test.each([
    ["every url( is checked (Review fix 3)", "filter:url(#a) url(https://x/y.svg#z)"],
    ["an external fragment", "fill:url(//h#g)"],
    ["an unterminated url", "mask:url(#m"],
    ["an unterminated quoted url", "mask:url('#m)"],
    ["an empty url", "fill:url()"],
    ["@import is never relaxed", "@import url(#x)"],
    ["image() is never relaxed", "fill:image(#x)"],
  ])("Drive markup still refuses: %s", (_label, css) => {
    expect(cssLoadsRemote(css, { allowFragmentUrl: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Shared HTML cases: Outlook HTML and Confluence storage (Review Focus 1, 2 and 3)
// ---------------------------------------------------------------------------------------------

/**
 * Tokenizer differentials (Review Focus 1). Each refused case uses a construct the R6 tripwire
 * cannot see (`<link href>`, `<base href>`, `<image href>`), so it is refused structurally, and
 * each has an allowed twin that differs only in the dangerous part.
 */
const DIFFERENTIALS: readonly (readonly [string, string, string])[] = [
  ["a `>` in a double-quoted value", `<a title="x>"><link href=//h>`, `<a title="x>"><a href=//h>`],
  ['a `"` in a single-quoted value', `<a b='"'><base href=//h>`, `<a b='"'><a href=//h>`],
  ["VT is not whitespace", `<a b=${VT}"x><link href=//h>">`, `<a b=${VT}"x><a href=//h>">`],
  [
    "a fullwidth quote is not a quote",
    `<a b=${FULLWIDTH_QUOTE}c><link href=//h>${FULLWIDTH_QUOTE}>`,
    `<a b=${FULLWIDTH_QUOTE}c><a href=//h>${FULLWIDTH_QUOTE}>`,
  ],
  ["a split tag", "<im<link href=//h>g>", "<im<a href=x>g>"],
  ["a tag inside a tag", "<a <base href=//h>>", "<a <a href=//h>>"],
  ["a tag inside a quoted value", `<a title="<base href=//h>">`, `<a title="<b>">`],
  ["`/` as a separator", "<link/href=//h>", "<a/href=//h>"],
  ["upper case", "<LINK HREF=//h>", "<A HREF=//h>"],
  ["mixed case, no attributes", "<LiNk>", "<LiNe>"],
  [
    "whitespace and newlines inside the tag",
    `<link${LF}${TAB}href${LF}=${LF}"//h">`,
    `<a${LF}${TAB}href${LF}=${LF}"//h">`,
  ],
  ["an SVG image", "<svg><image href=//h/></svg>", "<svg><a href=//h/></svg>"],
  [
    "an SVG use (xlink:href)",
    `<svg><use xlink:href="//h#x"/></svg>`,
    `<svg><use xlink:href="#x"/></svg>`,
  ],
  ["a prefixed element", "<x:iframe></x:iframe>", "<x:div></x:div>"],
  ["an invisible character in the name", `<li${ZWSP}nk href=x>`, `<li${ZWSP}ne href=x>`],
];

/** Cases refused by the same rule in Outlook HTML and Confluence storage (structural). */
const SHARED_REFUSED: readonly (readonly [string, string, string])[] = [
  ["base", "<base href=//h>", "<b>x</b>"],
  ["base with a relative href (the element rule alone)", "<base href=x/>", "<b>x</b>"],
  ["link stylesheet", "<link rel=stylesheet href=//h>", "<a rel=x href=//h>"],
  ["iframe", "<iframe src=x></iframe>", "<div>x</div>"],
  ["frame", "<frameset><frame src=x></frameset>", "<p>x</p>"],
  ["object data", "<object data=x></object>", "<span>x</span>"],
  ["embed", "<embed src=x>", "<em>x</em>"],
  ["applet", "<applet code=x></applet>", "<p>x</p>"],
  ["portal", "<portal src=x></portal>", "<p>x</p>"],
  ["fencedframe", "<fencedframe></fencedframe>", "<p></p>"],
  ["script", "<script></script>", "<p></p>"],
  [
    "meta refresh",
    `<meta http-equiv=refresh content="0;url=//h">`,
    `<meta name=x content="0;url=//h">`,
  ],
  ["img src", "<img src=//h/p.gif>", "<img src=p.gif>"],
  ["img src, decimal entity", `<img src="&#104;ttps://h">`, `<img src="&#104;.png">`],
  ["img src, &sol;", `<img src="&sol;&sol;h/x">`, `<img src="sol/x">`],
  ["table background", "<table background=//h></table>", "<table background=x.png></table>"],
  ["body background", "<body background=//h></body>", "<body></body>"],
  ["video poster", "<video poster=//h></video>", "<video poster=x.png></video>"],
  ["audio src", "<audio src=//h></audio>", "<audio src=x.mp3></audio>"],
  ["source src", "<source src=//h>", "<source src=x>"],
  ["track src", "<track src=//h>", "<track src=x>"],
  ["input type=image src", "<input type=image src=//h>", "<input type=image src=x>"],
  ["VML fill", `<v:fill src="//h"/>`, `<v:fill src="x"/>`],
  ["VML imagedata", "<v:imagedata src=//h>", "<v:imagedata src=x>"],
  ["lowsrc", "<img lowsrc=//h>", "<img alt=//h>"],
  ["dynsrc", "<img dynsrc=//h>", "<img alt=//h>"],
  ["codebase", "<x codebase=//h>", "<x title=//h>"],
  ["manifest", "<html manifest=//h></html>", "<html lang=en></html>"],
  ["icon", "<menuitem icon=//h>", "<menuitem label=x>"],
  ["a non-empty srcset", `<img srcset="a.png 1x">`, `<img srcset="">`],
  [
    "srcset hiding an external URL",
    `<img srcset="a.png 1x, //h 2x">`,
    `<img alt="a.png 1x, //h 2x">`,
  ],
  [
    "picture source srcset",
    `<picture><source srcset="a.png"></picture>`,
    "<picture><source></picture>",
  ],
  ["imagesrcset", `<x imagesrcset="a.png">`, "<x>"],
  ["ping", "<a href=x ping=//h>", "<a href=x>"],
  ["ping list hiding an external URL", `<a href=x ping="a //h">`, `<a href=x title="a //h">`],
  ["archive", `<x archive="a.jar">`, "<x>"],
  ["an event handler", `<p onclick="x">`, `<p class="x">`],
  ["an SVG feImage", "<svg><feImage href=//h/></svg>", "<svg><feImage href=#a /></svg>"],
  ["a *:href on a non-link", `<x o:href="//h">`, `<a o:href="//h">`],
  [
    "a style attribute with an escaped url",
    `<p style="background:u\\72l(//h)">`,
    `<p style="color:red">`,
  ],
  [
    "image-set in a style attribute",
    `<p style="background-image:image-set('//h' 1x)">`,
    `<p style="background:red">`,
  ],
  ["behavior in a style attribute", `<p style="behavior:url(x.htc)">`, `<p style="color:blue">`],
  ["@import in a style element", "<style>@import 'x.css'</style>", "<style>p{color:red}</style>"],
  [
    "an escaped url in a style element",
    "<style>p{background:u\\72l(x)}</style>",
    "<style>p{x:1}</style>",
  ],
  [
    "a comment-split url in a style element",
    "<style>p{background:u/**/rl(x)}</style>",
    "<style>/**/p{}</style>",
  ],
  [
    "markup-split url in a style element (XML reads text only)",
    "<style>p{background:u<i/>rl(x)}</style>",
    "<style>p{background:red}</style>",
  ],
  ["an unclosed style element", "<style>p{color:red}", "<style>p{color:red}</style>"],
  ["an unclosed title", "<title>x", "<title>x</title>"],
  ["an unclosed textarea", "<textarea>x", "<textarea>x</textarea>"],
  ["an unclosed xmp", "<xmp>x", "<xmp>x</xmp>"],
  [
    "a style element closed only by another element's end",
    "<style>p{}</p>",
    "<style>p{}</style></p>",
  ],
  ["a conditional comment", "<!--[if mso]><link href=//h><![endif]-->", "<!-- note -->"],
  [
    "a conditional comment with a cid image",
    `<!--[if mso]><img src="cid:x"><![endif]-->`,
    "<!--[if mso]> note [endif]-->",
  ],
  ["a processing instruction holding `<`", `<?x a="<img"?>`, `<?x a="img"?>`],
  ["a declaration holding `<`", "<!x <link>", "<!x link>"],
];

describe("Outlook HTML (plan R4, Review Focus 1-3)", () => {
  test.each(DIFFERENTIALS)("%s", (_label, refused, allowed) => {
    expectRefused("outlook-html", refused, true);
    expectAllowed("outlook-html", allowed);
  });

  test.each(SHARED_REFUSED)("%s", (_label, refused, allowed) => {
    expectRefused("outlook-html", refused, true);
    expectAllowed("outlook-html", allowed);
  });

  test("CDATA is refused whatever its content (R4 step 7)", () => {
    expectRefused("outlook-html", "<![CDATA[ x ><base href=//h>]]>", true);
    expectRefused("outlook-html", "<p><![CDATA[x]]></p>", true);
    expectAllowed("outlook-html", "<p>x</p>");
  });

  test("an Outlook cid image is allowed; the same in storage is not", () => {
    expectAllowed("outlook-html", `<img src="cid:logo">`);
    expectRefused("confluence-storage", `<img src="cid:logo">`, true);
  });

  test.each([
    ["plain text", "hello"],
    ["a link", `<a href="https://h">x</a>`],
    ["an area link", "<map><area href=//h></map>"],
    ["a javascript: link (links are not checked; stated)", `<a href="javascript:alert(1)">x</a>`],
    ["a protocol-relative link", "<a href=//h>x</a>"],
    ["a less-than in text", "<p>a < b</p>"],
    ["a `<b` whose attribute is `then<`", "<p>if a<b then</p>"],
    ["a plain comment", "<!-- note -->"],
    ["a colour style", `<p style="color:red">x</p>`],
    ["relative images", `<img src="x.png"><img src="#a"><img src="">`],
    [
      "a doctype (Outlook keeps R4 only)",
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN">',
    ],
    ["an empty input", ""],
  ])("allowed: %s", (_label, text) => {
    expectAllowed("outlook-html", text);
  });

  test("does not tokenize: refused", () => {
    for (const t of ["<p", `<a href="x`, "<!-- x", "<![CDATA[x", "<?x"]) {
      expectRefused("outlook-html", t, true);
    }
  });

  test("R6: the tripwire alone refuses a literal assignment in prose", () => {
    const prose = `use src="https://h/x.png" in the template`;
    expect(remoteContentIn("outlook-html", prose)).toBe(true);
    expect(remoteContentIn("outlook-html", prose, { tripwire: false })).toBe(false);
    expect(remoteContentIn("outlook-html", "write src=cid:logo")).toBe(false);
    expect(remoteContentIn("outlook-html", "see url(x) and @import")).toBe(true);
    expect(remoteContentIn("outlook-html", "background=//h")).toBe(true);
    expect(remoteContentIn("outlook-html", "poster = `https://h`")).toBe(true);
    expect(remoteContentIn("confluence-storage", "write src=cid:logo")).toBe(true);
    // The widened function names need `(` immediately (CSS does), so prose is not tripped.
    expect(remoteContentIn("outlook-html", "the image (left) and the src (folder)")).toBe(false);
    expect(remoteContentIn("outlook-html", "a cross-fade(x)")).toBe(true);
  });

  test("an input over REMOTE_SCAN_MAX_CHARS is refused", () => {
    expect(remoteContentIn("outlook-html", "a".repeat(2_000_001))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Confluence storage (Review Focus 1, 2 and 4)
// ---------------------------------------------------------------------------------------------

function macro(name: string, inner: string): string {
  return `<ac:structured-macro ac:name="${name}">${inner}</ac:structured-macro>`;
}

function param(name: string, value: string): string {
  return `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
}

describe("Confluence storage (plan R4 + R5, Review Focus 4)", () => {
  test.each(DIFFERENTIALS)("%s", (_label, refused, allowed) => {
    expectRefused("confluence-storage", refused, true);
    expectAllowed("confluence-storage", allowed);
  });

  test.each(SHARED_REFUSED)("%s", (_label, refused, allowed) => {
    expectRefused("confluence-storage", refused, true);
    expectAllowed("confluence-storage", allowed);
  });

  const STORAGE: readonly (readonly [string, string, string])[] = [
    [
      "an ri:url image",
      `<ac:image><ri:url ri:value="https://h/x.png"/></ac:image>`,
      `<ac:image><ri:attachment ri:filename="x.png"/></ac:image>`,
    ],
    [
      "an ri:url link",
      `<ac:link><ri:url ri:value="https://h"/></ac:link>`,
      `<ac:link><ri:page ri:content-title="Runbook"/></ac:link>`,
    ],
    [
      "a url element with another prefix (Review fix 4)",
      `<ac:image><res:url xmlns:res="x" res:value="x.png"/></ac:image>`,
      `<ac:image><res:page xmlns:res="x" res:value="x.png"/></ac:image>`,
    ],
    [
      "a relative ri:url (any url element)",
      `<ac:image><ri:url ri:value="x.png"/></ac:image>`,
      `<ac:image ac:alt="x.png"/>`,
    ],
    ["the iframe macro", macro("iframe", ""), macro("info", "")],
    ["the widget macro", macro("widget", ""), macro("note", "")],
    ["the html macro", macro("html", ""), macro("tip", "")],
    ["the rss macro", macro("rss", ""), macro("warning", "")],
    ["the roadmap macro", macro("roadmap", ""), macro("panel", "")],
    ["an unknown macro", macro("foo", ""), macro("expand", "")],
    ["an upper-case unknown macro", macro("IFRAME", ""), macro("INFO", "")],
    [
      "a macro without ac:name",
      "<ac:structured-macro></ac:structured-macro>",
      `<ac:structured-macro ac:name="toc"></ac:structured-macro>`,
    ],
    [
      "a duplicated ac:name (every one is checked)",
      `<ac:structured-macro ac:name="info" ac:name="iframe"></ac:structured-macro>`,
      `<ac:structured-macro ac:name="info" ac:name="note"></ac:structured-macro>`,
    ],
    [
      "an entity-spelled macro name (raw form checked too)",
      `<ac:structured-macro ac:name="&#105;nfo"></ac:structured-macro>`,
      `<ac:structured-macro ac:name="info"></ac:structured-macro>`,
    ],
    [
      "the legacy ac:macro form",
      `<ac:macro ac:name="iframe"></ac:macro>`,
      `<ac:macro ac:name="code"></ac:macro>`,
    ],
    [
      "an unclosed macro",
      `<ac:structured-macro ac:name="info">`,
      `<ac:structured-macro ac:name="info"/>`,
    ],
    [
      "a panel parameter with an external URL",
      macro("panel", param("x", "https://h")),
      macro("panel", param("x", "blue")),
    ],
    [
      "an unclosed parameter",
      macro("panel", `<ac:parameter ac:name="x">blue`),
      macro("panel", param("x", "blue")),
    ],
    [
      "a jira url parameter",
      macro("jira", param("url", "https://h/sr/jira.issueviews:searchrequest-xml/1/x.xml")),
      macro("jira", param("key", "ENG-1")),
    ],
    [
      "a relative jira baseurl (the tripwire and the URL rule cannot see it)",
      macro("jira", param("baseurl", "/browse")),
      macro("info", param("baseurl", "/browse")),
    ],
    [
      "an upper-case jira URL parameter",
      macro("jira", param("URL", "/x.xml")),
      macro("jira", param("columns", "key;summary")),
    ],
    [
      "a jira server-url parameter",
      macro("jira", param("server-url", "x")),
      macro("jira", param("server", "System JIRA")),
    ],
    [
      "a jira title that is a URL",
      macro("jira", param("title", "https://h")),
      macro("jira", param("title", "Open bugs")),
    ],
    ["an ADF extension", "<ac:adf-extension></ac:adf-extension>", "<ac:layout></ac:layout>"],
    ["an ADF node", `<ac:adf-node type="x"></ac:adf-node>`, `<ac:task-list></ac:task-list>`],
    [
      "CDATA in an info macro's plain-text body",
      macro("info", "<ac:plain-text-body><![CDATA[<base href=//h>]]></ac:plain-text-body>"),
      macro("code", "<ac:plain-text-body><![CDATA[<base href=//h>]]></ac:plain-text-body>"),
    ],
    ["CDATA bare in a paragraph", "<p><![CDATA[<base href=//h>]]></p>", "<p><![CDATA[plain]]></p>"],
    ["CDATA that does not tokenize", "<p><![CDATA[<a href=x]]></p>", "<p><![CDATA[a < b]]></p>"],
    [
      "a code body with content beside its CDATA (not the sole content)",
      macro("code", "<ac:plain-text-body>x<![CDATA[<base href=//h>]]></ac:plain-text-body>"),
      macro("code", "<ac:plain-text-body> <![CDATA[<base href=//h>]]> </ac:plain-text-body>"),
    ],
    [
      "an absolute tenant image",
      `<img src="https://acme.atlassian.net/wiki/download/x.png">`,
      `<img src="/wiki/download/attachments/1/x.png">`,
    ],
  ];

  test.each(STORAGE)("%s", (_label, refused, allowed) => {
    expectRefused("confluence-storage", refused, true);
    expectAllowed("confluence-storage", allowed);
  });

  test("CDATA nested past the depth bound is refused", () => {
    // A CDATA section cannot hold a complete one, so a nested opener never closes.
    expectRefused("confluence-storage", "<p><![CDATA[<![CDATA[x]]></p>", true);
  });

  test.each([
    ["a user link", `<ac:link><ri:user ri:account-id="1"/></ac:link>`],
    ["a space link", `<ac:link><ri:space ri:space-key="ENG"/></ac:link>`],
    ["an attachment link", `<ac:link><ri:attachment ri:filename="x.pdf"/></ac:link>`],
    ["a plain link", `<a href="https://h">x</a>`],
    [
      "an info macro with a rich-text body",
      macro("info", "<ac:rich-text-body><p>Hi</p></ac:rich-text-body>"),
    ],
    [
      "a jira macro by application link",
      macro(
        "jira",
        param("server", "System JIRA") + param("serverId", "a1b2-c3") + param("key", "ENG-1"),
      ),
    ],
    ["a jira macro with JQL", macro("jira", param("jqlQuery", "project = ENG AND status = Open"))],
    [
      "a code macro whose CDATA holds an image (exempt; the tripwire skips it)",
      macro(
        "code",
        `${param("language", "html")}<ac:plain-text-body><![CDATA[<img src="https://h">]]></ac:plain-text-body>`,
      ),
    ],
    [
      "a noformat macro whose CDATA holds a url(",
      macro(
        "noformat",
        `<ac:plain-text-body><![CDATA[p{background:url(//h)}]]></ac:plain-text-body>`,
      ),
    ],
    ["a relative image", `<img src="/wiki/download/attachments/1/x.png">`],
    ["every inert macro", [...CONFLUENCE_INERT_MACROS].map((m) => macro(m, "")).join("")],
    ["a self-closing macro", `<ac:structured-macro ac:name="toc"/>`],
  ])("allowed: %s", (_label, text) => {
    expectAllowed("confluence-storage", text);
  });

  test("the code-body exemption does not reach the tripwire of text outside it", () => {
    const body = macro("code", `<ac:plain-text-body><![CDATA[x]]></ac:plain-text-body>`);
    expect(remoteContentIn("confluence-storage", `${body}<p>src="https://h"</p>`)).toBe(true);
    expect(remoteContentIn("confluence-storage", `${body}<p>plain</p>`)).toBe(false);
  });

  test("an info macro's CDATA is scanned, a code macro's is not (red-proof fixture)", () => {
    const info = macro(
      "info",
      `<ac:plain-text-body><![CDATA[<img src=x srcset="a 1x">]]></ac:plain-text-body>`,
    );
    const code = macro(
      "code",
      `<ac:plain-text-body><![CDATA[<img src=x srcset="a 1x">]]></ac:plain-text-body>`,
    );
    expectRefused("confluence-storage", info, true);
    expectAllowed("confluence-storage", code);
  });

  test("CONFLUENCE_INERT_MACROS is exactly the 18 names of R5 (jira included)", () => {
    expect([...CONFLUENCE_INERT_MACROS].sort((a, b) => a.localeCompare(b))).toEqual(
      [
        "anchor",
        "children",
        "code",
        "details",
        "excerpt",
        "excerpt-include",
        "expand",
        "include",
        "info",
        "jira",
        "noformat",
        "note",
        "pagetree",
        "panel",
        "status",
        "tip",
        "toc",
        "warning",
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(CONFLUENCE_INERT_MACROS.size).toBe(18);
  });
});

describe("remoteContentIn: fail closed", () => {
  test("a throw inside a detector refuses", () => {
    const hostile = {
      get length(): number {
        return 1;
      },
      toLowerCase(): string {
        throw new Error("x");
      },
    };
    // A non-string reaching the detector (a caller bug) throws inside it and is refused.
    expect(remoteContentIn("outlook-html", hostile as unknown as string)).toBe(true);
  });
});

describe("edge paths (fail closed, and what stays allowed)", () => {
  const UNSETTLED = "&amp;amp;amp;amp;amp;";

  test("a value that does not settle is refused wherever it is read", () => {
    expect(cssLoadsRemote(UNSETTLED)).toBe(true);
    // The tripwire's forms do not settle either.
    expect(remoteContentIn("outlook-html", `<p>${UNSETTLED}</p>`)).toBe(true);
    expectRefused(
      "confluence-storage",
      `<ac:structured-macro ac:name="${UNSETTLED}"></ac:structured-macro>`,
      true,
    );
    expectRefused(
      "confluence-storage",
      macro("panel", `<ac:parameter ac:name="${UNSETTLED}">x</ac:parameter>`),
      true,
    );
  });

  test("CSS escapes: invalid code points decode to U+FFFD; CRLF after an escape is one space", () => {
    expect(cssLoadsRemote(String.raw`content:'\0 \d800 \110000'`)).toBe(false);
    expect(cssLoadsRemote(`background:u${String.raw`\72`}\r\nl(x)`)).toBe(true);
    expect(cssLoadsRemote(`background:u${String.raw`\72`}\tl(x)`)).toBe(true);
    // A trailing backslash contributes nothing.
    expect(cssLoadsRemote("color:red\\")).toBe(false);
  });

  test("a nested style element is matched to its own end tag", () => {
    expectAllowed("outlook-html", "<style><style>p{}</style></style>");
    expectRefused("outlook-html", "<style><style>p{}</style>p{background:url(x)}</style>", true);
  });

  test("the nested view is bounded in depth", () => {
    expectRefused("outlook-html", "<a <b <c <d <e <f>>", true);
    expectAllowed("outlook-html", "<a <b <c>>");
  });

  test("storage: macro attributes other than ac:name are ignored", () => {
    expectAllowed(
      "confluence-storage",
      `<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="x"></ac:structured-macro>`,
    );
  });

  test("storage: a plain-text body outside any macro, or with more than its CDATA, is scanned", () => {
    expectAllowed("confluence-storage", "<ac:plain-text-body><![CDATA[x]]></ac:plain-text-body>");
    expectRefused(
      "confluence-storage",
      "<ac:plain-text-body><![CDATA[<base href=x>]]></ac:plain-text-body>",
      true,
    );
    expectRefused(
      "confluence-storage",
      macro("code", "<ac:plain-text-body><![CDATA[<base href=x>]]><b/></ac:plain-text-body>"),
      true,
    );
  });

  test("storage: a parameter's CDATA counts as its text; a parameter outside a macro is checked", () => {
    expectRefused("confluence-storage", macro("panel", param("x", "<![CDATA[https://h]]>")), true);
    expectAllowed("confluence-storage", param("x", "y"));
    expectRefused("confluence-storage", param("x", "//h"), true);
    // An external parameter value: every scheme counts, so "Note: x" is refused (stated over-refusal).
    expectRefused("confluence-storage", macro("panel", param("title", "Note: x")), true);
  });

  test("storage: input that does not tokenize is refused", () => {
    expectRefused("confluence-storage", "<p", true);
  });
});
