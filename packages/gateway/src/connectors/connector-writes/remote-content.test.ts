import { describe, expect, test } from "bun:test";
import {
  CONFLUENCE_INERT_MACROS,
  cssLoadsRemote,
  driveContentFormat,
  driveMimeTypeScans,
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
const FULLWIDTH_SOLIDUS = String.fromCodePoint(0xff0f);
const FULLWIDTH_SEMICOLON = String.fromCodePoint(0xff1b);
const FULLWIDTH_BANG = String.fromCodePoint(0xff01);

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

  test("a raw-text element nested in another is refused (never needed; keeps the walk linear)", () => {
    expectRefused("outlook-html", "<style><style>p{}</style></style>", true);
    expectRefused("outlook-html", "<title><style>p{}</style></title>", true);
    expectAllowed("outlook-html", "<style>p{}</style>");
    expectAllowed("outlook-html", "<style>p{}</style><style>q{}</style>");
    expectAllowed("outlook-html", "<title>a</title><textarea>b</textarea>");
  });

  test("a fake </style> closer does not end the CSS scan (adversarial review)", () => {
    const VTAB = String.fromCodePoint(0x0b);
    const escapedUrl = String.raw`p{background:u\72l(//h)}`;
    const escapedImport = String.raw`p{background:@\69mport "//h/x.css"}`;
    for (const format of [
      "outlook-html",
      "confluence-storage",
      "obsidian-markdown",
      "drive-markup",
    ] as const) {
      // Unclosed in HTML's view: refused as an unclosed raw-text element.
      expectRefused(format, `<style>p{}</style${VTAB}>${escapedUrl}`, true);
      expectRefused(format, `<style>p{}</style${ZWSP}>${escapedUrl}`, true);
      expectRefused(format, `<style>p{}</x:style>${escapedImport}`, true);
      // Closed later: the CSS after the fake closer is scanned (the union span) and refused.
      expectRefused(format, `<style>p{}</style${VTAB}>${escapedUrl}</style>`, true);
      expectRefused(format, `<style>p{}</style${ZWSP}>${escapedUrl}</style>`, true);
      expectRefused(format, `<style>p{}</x:style>${escapedImport}</style>`, true);
      // HTML ends at a closer inside an attribute; XML reads on to its end tag.
      expectRefused(format, `<style>p{}<a title="</style>">${escapedUrl}</style>`, true);
      // CSS that only HTML's source view sees (XML reads an attribute value, not text).
      expectRefused(format, `<style><a b=x}${escapedUrl}></a></style>`, true);
      expectAllowed(format, "<style><a b=x}p{color:red}></a></style>");
      // Twins: the same structure with inert CSS.
      expectAllowed(format, `<style>p{}</style><p>${escapedUrl.slice(0, 2)}</p>`);
    }
    // A real closer, any ASCII case, with a delimiter.
    expectAllowed("outlook-html", "<style>p{}</STYLE >x");
    expectAllowed("outlook-html", "<style>p{}</style\n>x");
  });

  test("the CSS scan decodes CSS escapes before matching function names (structural path)", () => {
    expectRefused("outlook-html", String.raw`<style>p{background:\75\72\6c(x)}</style>`, true);
    expectRefused("outlook-html", String.raw`<p style="background:\75 rl(x)">`, true);
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
    // Elements inside a parameter do not count as its text (an excerpt-include page link).
    expectAllowed(
      "confluence-storage",
      macro("excerpt-include", param("", `<ac:link><ri:page ri:content-title="X"/></ac:link>`)),
    );
    expectRefused("confluence-storage", param("x", "//h"), true);
  });

  // Coordinator ruling on B3r concern 6: a parameter text is a URL only with a REAL URL scheme
  // (a scheme + `//`, or a listed scheme) or when protocol-relative.
  test.each([
    ["JaVaScRiPt:x"],
    ["javascript:alert(1)"],
    [`java${TAB}script:x`],
    ["data:text/html,x"],
    ["vbscript:x"],
    ["file:///etc/passwd"],
    ["mailto:a@h"],
    ["tel:123"],
    ["blob:x"],
    ["filesystem:x"],
    ["about:blank"],
    ["ws:h"],
    ["wss:h"],
    ["ftp:h"],
    ["http:h"],
    ["HTTPS://h"],
    ["//h"],
    ["\\\\h"],
    ["x-custom://h"],
    ["&#104;ttps://h"],
    [`https${FULLWIDTH_COLON}//h`],
    ["&sol;&sol;h"],
    ["&amp;amp;amp;amp;amp;"],
  ])("a parameter that is a URL is refused: %p", (value) => {
    expectRefused("confluence-storage", macro("panel", param("title", value)), true);
  });

  test.each([
    ["Note: x"],
    ["Warning: check the logs"],
    ["Step 1: deploy"],
    ["key:value"],
    ["x-custom:no-slashes"],
    ["a/b//c"],
    ["/browse"],
  ])("a parameter with a colon but no real URL scheme is allowed: %p", (value) => {
    expectAllowed("confluence-storage", macro("panel", param("title", value)));
  });

  test("storage: a parameter that opens inside another is refused; a self-closing one is checked", () => {
    expectRefused(
      "confluence-storage",
      macro(
        "panel",
        `<ac:parameter ac:name="x"><ac:parameter ac:name="y">a</ac:parameter></ac:parameter>`,
      ),
      true,
    );
    expectAllowed("confluence-storage", macro("panel", `<ac:parameter ac:name="x"/>`));
    expectAllowed("confluence-storage", macro("jira", `<ac:parameter ac:name="url"/>`));
  });

  test("storage: a jira default parameter is refused when non-empty (adversarial review)", () => {
    const def = (inner: string): string =>
      `<ac:structured-macro ac:name="jira">${inner}</ac:structured-macro>`;
    // The review's fixture: a relative issue-navigator URL in ac:default-parameter, which neither
    // the URL rule nor the tripwire sees.
    expectRefused(
      "confluence-storage",
      def(
        "<ac:default-parameter>/sr/jira.issueviews:searchrequest-xml/1/x.xml</ac:default-parameter>",
      ),
      true,
    );
    expectRefused(
      "confluence-storage",
      def("<ac:default-parameter>ENG-1</ac:default-parameter>"),
      true,
    );
    expectRefused(
      "confluence-storage",
      def(`<ac:parameter ac:name="">/x.xml</ac:parameter>`),
      true,
    );
    expectRefused("confluence-storage", def("<ac:parameter>/x.xml</ac:parameter>"), true);
    expectRefused(
      "confluence-storage",
      def("<x:DEFAULT-PARAMETER>/x.xml</x:DEFAULT-PARAMETER>"),
      true,
    );
    // A default parameter is also a parameter everywhere: its text gets the URL rule.
    expectRefused(
      "confluence-storage",
      macro("panel", "<ac:default-parameter>//h</ac:default-parameter>"),
      true,
    );
    // Twins.
    expectAllowed("confluence-storage", def("<ac:default-parameter></ac:default-parameter>"));
    expectAllowed("confluence-storage", def(param("key", "ENG-1")));
    expectAllowed(
      "confluence-storage",
      macro("anchor", "<ac:default-parameter>top</ac:default-parameter>"),
    );
    expectAllowed(
      "confluence-storage",
      macro("anchor", `<ac:parameter ac:name="">top</ac:parameter>`),
    );
  });

  test("SVG rules run in every markup format (adversarial review)", () => {
    const all = [
      "outlook-html",
      "confluence-storage",
      "obsidian-markdown",
      "drive-markup",
    ] as const;
    for (const format of all) {
      expectRefused(format, String.raw`<svg><rect mask="u\72l(https://h/x.png)"/></svg>`, true);
      expectRefused(
        format,
        `<svg><image href="x.png"><set attributeName="href" to="https://h/p.png"/></image></svg>`,
        true,
      );
      expectRefused(format, "<svg><foreignObject><p>x</p></foreignObject></svg>", true);
      expectRefused(format, `<svg><rect mask="image-set('x.png' 1x)"/></svg>`, true);
      // Inside a nested view too.
      expectRefused(format, String.raw`<a title="<rect fill='u\72l(//h)'/>">`, true);
      expectRefused(format, `<a title="<set attributeName='href' to='x'/>">`, true);
      // Twins.
      expectAllowed(format, `<svg><rect fill="red" mask="none"/></svg>`);
      expectAllowed(format, `<img alt="Image (1) and src (2)">`);
      expectAllowed(format, `<svg><animate attributeName="opacity" to="1"/></svg>`);
    }
    // The `#` relaxation stays Drive-only.
    expectAllowed("drive-markup", `<svg><rect fill="url(#g)"/></svg>`);
    for (const format of ["outlook-html", "confluence-storage", "obsidian-markdown"] as const) {
      expectRefused(format, `<svg><rect fill="url(#g)"/></svg>`, true);
    }
  });

  test("a non-empty xml:base (any *:base attribute) is refused (adversarial review)", () => {
    const all = [
      "outlook-html",
      "confluence-storage",
      "obsidian-markdown",
      "drive-markup",
    ] as const;
    for (const format of all) {
      expectRefused(format, `<svg xml:base="https://h/"><image href="x.png"/></svg>`, true);
      expectRefused(format, `<p xml:base="/">x</p>`, true);
      expectRefused(format, `<p BASE="a">x</p>`, true);
      expectAllowed(format, `<svg xml:base=""><image href="x.png"/></svg>`);
      expectAllowed(format, `<svg xml:lang="en"><image href="x.png"/></svg>`);
    }
  });

  test("Obsidian: a mermaid fence holding a URL is refused (coordinator ruling)", () => {
    const BT = "\x60\x60\x60";
    const fence = (open: string, body: string, close = open.slice(0, 3)): string =>
      `# Note${LF}${open}${LF}${body}${LF}${close}${LF}after`;
    const refused = [
      fence(`${BT}mermaid`, `graph TD${LF}A-->B${LF}click A "https://h/x"`),
      fence(`${BT}MERMAID`, 'graph TD; A-->B; click A href "//h"'),
      fence("~~~mermaid", 'graph TD; A[x]; click A "javascript:alert(1)"'),
      fence(`${BT}  Mermaid`, "graph TD; A[<img src='x.png'>]; B[\"data:x\"]"),
      fence(`> ${BT}mermaid`, `> click A "http://h"`, `> ${BT}`),
      // Unclosed: the body runs to the end of the note.
      `${BT}mermaid${LF}graph TD; click A "https://h"`,
      // Fullwidth spelling of the info string folds.
      fence(`${BT}${String.fromCodePoint(0xff4d)}ermaid`, 'click A "https://h"'),
      // A longer fence is closed only by a run at least as long.
      `${BT}${"\x60"}mermaid${LF}a${LF}${BT}${LF}click A "https://h"${LF}${BT}${"\x60"}`,
    ];
    for (const text of refused) expectRefused("obsidian-markdown", text, true);
    const allowed = [
      fence(`${BT}mermaid`, `graph TD${LF}A-->B${LF}B-->C: label`),
      fence(`${BT}mermaid`, `sequenceDiagram${LF}Alice->>Bob: Hello`),
      // A non-mermaid fence with a URL (a link-like string is not an image).
      fence(`${BT}js`, 'const u = "https://h";'),
      // The URL is after the mermaid fence closes.
      `${fence(`${BT}mermaid`, "graph TD; A-->B")}${LF}[link](https://h)`,
    ];
    for (const text of allowed) expectAllowed("obsidian-markdown", text);
  });

  test("Drive: the file name also decides the scan (coordinator ruling)", () => {
    const PIXEL = "<img src=//h>";
    /** How Task 5 composes the Drive row with the name rule. */
    const refused = (mimeType: unknown, name: unknown, content: string): boolean => {
      const format = driveContentFormat(mimeType, name);
      return format !== undefined && remoteContentIn(format, content, { tripwire: false });
    };
    for (const name of [
      "report.html",
      "report.HTM",
      "a.xhtml",
      "logo.SVG",
      "feed.xml",
      "page.mht",
      "page.mhtml",
      "report.html.",
      "report.html ",
      `report.ht${ZWSP}ml`,
      `report${String.fromCodePoint(0xff0e)}html`,
    ]) {
      expect(driveContentFormat("text/plain", name)).toBe("drive-markup");
      expect(driveContentFormat(undefined, name)).toBe("drive-markup");
      expect(refused("text/plain", name, PIXEL)).toBe(true);
    }
    for (const name of ["notes.md", "NOTES.MD", "notes.md."]) {
      expect(driveContentFormat(undefined, name)).toBe("obsidian-markdown");
      expect(refused("text/plain", name, "![x](https://h/p.gif)")).toBe(true);
      expect(refused("text/plain", name, "[x](https://h)")).toBe(false);
    }
    // A markup type wins over a Markdown name.
    expect(driveContentFormat("text/html", "notes.md")).toBe("drive-markup");
    // A non-string name scans as markup; an absent one decides nothing.
    expect(driveContentFormat("text/plain", 42)).toBe("drive-markup");
    expect(driveContentFormat("text/plain", null)).toBe("drive-markup");
    expect(driveContentFormat("text/plain", undefined)).toBeUndefined();
    // Not scanned: clean type and a name with no markup or Markdown extension.
    for (const name of ["report.txt", "data.csv", "html", "x.html.txt", "md", "x.mdx"]) {
      expect(driveContentFormat("text/plain", name)).toBeUndefined();
      expect(refused("text/plain", name, PIXEL)).toBe(false);
    }
  });

  test("storage: input that does not tokenize is refused", () => {
    expectRefused("confluence-storage", "<p", true);
  });
});

// ---------------------------------------------------------------------------------------------
// R8: Notion (Review Focus 5)
// ---------------------------------------------------------------------------------------------

/** A block nested three levels deep (toggle > bulleted item > `leaf`). */
function threeDeep(leaf: string): string {
  return `[{"toggle":{"rich_text":[],"children":[{"bulleted_list_item":{"rich_text":[],"children":[${leaf}]}}]}}]`;
}

/** Arrays nested `n` deep (container depth `n`). */
function nestedArrays(n: number): string {
  return `${"[".repeat(n)}${"]".repeat(n)}`;
}

describe("Notion block and property JSON (plan R8)", () => {
  const BLOCKS: readonly (readonly [string, string, string])[] = [
    [
      "an embed nested three levels deep",
      threeDeep(`{"type":"embed","embed":{"url":"https://h"}}`),
      threeDeep(`{"type":"paragraph","paragraph":{"rich_text":[]}}`),
    ],
    [
      "an external image three levels deep",
      threeDeep(`{"type":"image","image":{"type":"external","external":{"url":"https://h"}}}`),
      threeDeep(`{"type":"image","image":{"type":"file_upload","file_upload":{"id":"x"}}}`),
    ],
    [
      "a bookmark three levels deep",
      threeDeep(`{"type":"bookmark","bookmark":{"url":"https://h"}}`),
      threeDeep(`{"type":"quote","quote":{"rich_text":[]}}`),
    ],
    [
      "a video with its own url (rule c)",
      `[{"video":{"url":"https://h"}}]`,
      `[{"video":{"caption":[]}}]`,
    ],
    [
      "a custom emoji url (rule c)",
      `[{"custom_emoji":{"url":"https://h"}}]`,
      `[{"custom_emoji":{"id":"x"}}]`,
    ],
    [
      "an upper-case URL key under a media key",
      `[{"Image":{"URL":"https://h"}}]`,
      `[{"Image":{"name":"x"}}]`,
    ],
    [
      "a callout icon.external",
      `[{"callout":{"rich_text":[],"icon":{"external":{"url":"https://h"}}}}]`,
      `[{"callout":{"rich_text":[],"icon":{"emoji":"x"}}}]`,
    ],
    [
      "a link_preview mention",
      `[{"paragraph":{"rich_text":[{"type":"mention","mention":{"type":"link_preview","link_preview":{"url":"https://h"}}}]}}]`,
      `[{"paragraph":{"rich_text":[{"type":"mention","mention":{"type":"page","page":{"id":"x"}}}]}}]`,
    ],
    [
      "a link_mention key",
      `[{"link_mention":{"href":"https://h"}}]`,
      `[{"link":{"href":"https://h"}}]`,
    ],
    ["an upper-case key (Embed)", `[{"Embed":{"url":"https://h"}}]`, `[{"Divider":{}}]`],
    ["an upper-case type value (EMBED)", `[{"type":"EMBED"}]`, `[{"type":"DIVIDER"}]`],
    ["65 levels of nesting", nestedArrays(65), nestedArrays(64)],
    ["not JSON", "[{", "[{}]"],
    ["an object given as blocks", "{}", "[]"],
    ["null given as blocks", "null", "[]"],
    ["a string given as blocks", `"x"`, "[]"],
  ];

  test.each(BLOCKS)("blocks: %s", (_label, refused, allowed) => {
    expectRefused("notion-blocks", refused, true);
    expectAllowed("notion-blocks", allowed);
  });

  const PROPERTIES: readonly (readonly [string, string, string])[] = [
    [
      "an external file entry",
      `{"Files":{"files":[{"name":"x","type":"external","external":{"url":"https://h"}}]}}`,
      `{"Files":{"files":[{"name":"x","type":"file_upload","file_upload":{"id":"x"}}]}}`,
    ],
    ["a JSON __proto__ key is walked", `{"__proto__":{"external":{}}}`, `{"__proto__":{"x":{}}}`],
    ["an array given as properties", "[]", "{}"],
    ["null given as properties", "null", "{}"],
  ];

  test.each(PROPERTIES)("properties: %s", (_label, refused, allowed) => {
    expectRefused("notion-properties", refused, true);
    expectAllowed("notion-properties", allowed);
  });

  test.each([
    [
      "a text link",
      `[{"paragraph":{"rich_text":[{"type":"text","text":{"content":"x","link":{"url":"https://h"}}}]}}]`,
    ],
    ["an href", `[{"paragraph":{"rich_text":[{"href":"https://h","plain_text":"x"}]}}]`],
    [
      "a string value that names a refused key",
      `[{"paragraph":{"rich_text":[{"plain_text":"embed external"}]}}]`,
    ],
  ])("blocks allowed: %s", (_label, json) => {
    expectAllowed("notion-blocks", json);
  });

  test("a url property is allowed", () => {
    expectAllowed("notion-properties", `{"Site":{"url":"https://h"}}`);
  });

  test("the node cap: 100,000 values pass, 100,001 do not", () => {
    // The root array counts as one value.
    expectAllowed("notion-blocks", `[${Array.from({ length: 99_999 }, () => "0").join(",")}]`);
    expectRefused(
      "notion-blocks",
      `[${Array.from({ length: 100_001 }, () => "0").join(",")}]`,
      true,
    );
  });

  test("an input over REMOTE_SCAN_MAX_CHARS is refused", () => {
    expectRefused("notion-blocks", `[${" ".repeat(2_000_000)}]`, true);
  });
});

// ---------------------------------------------------------------------------------------------
// R9: Obsidian (Review Focus 5)
// ---------------------------------------------------------------------------------------------

describe("Obsidian Markdown (plan R9)", () => {
  const OBSIDIAN: readonly (readonly [string, string, string])[] = [
    ["an image with no alt", "![](https://h)", "[](https://h)"],
    ["a space before the URL", "![x]( https://h)", "[x]( https://h)"],
    ["an angle-bracket URL", "![x](<https://h>)", "[x](<https://h>)"],
    ["a reference image", `![x][r]${LF}[r]: https://h`, `[x][r]${LF}[r]: https://h`],
    ["a relative image", "![x](a.png)", "![[a.png]]"],
    ["a URL as an embed target", "![[https://h]]", "![[h]]"],
    ["a colon in an embed target", "![[a:b]]", "![[a-b]]"],
    ["an absolute embed target", "![[/x]]", "![[x]]"],
    ["a backslash embed target", "![[\\x]]", "![[x]]"],
    ["an unterminated embed", "![[x", "![[x]]"],
    ["an empty embed", "![[]]", "![[x]]"],
    ["an embed followed by a destination", "![[x]](https://h)", "![[x]] (see https://h)"],
    ["an embed followed by a reference", "![[x]][r]", "![[x]] [r]"],
    ["an inline img", "<img src=//h>", "<i>x</i>"],
    ["an inline iframe", "<iframe src=//h></iframe>", "<div>x</div>"],
    ["an inline link element (no tripwire match)", "<link href=x>", "<a href=x>x</a>"],
    ["a fullwidth bang", `${FULLWIDTH_BANG}[](https://h)`, "[](https://h)"],
    ["an entity bang", "&#33;[x](y)", "&#33; [x](y)"],
    ["an escaped bang (stated)", "\\![x](https://h)", "\\[x](https://h)"],
    [
      "an image in a fenced block (stated)",
      `\`\`\`${LF}![x](y)${LF}\`\`\``,
      `\`\`\`${LF}[x](y)${LF}\`\`\``,
    ],
    ["an inline style", "<style>p{background:url(x)}</style>", "<style>p{color:red}</style>"],
    ["markup that does not tokenize", "if a <b", "if a < b"],
    ["a cid image (no cid: in Obsidian)", `<img src="cid:x">`, `<img src="x">`],
  ];

  test.each(OBSIDIAN)("%s", (_label, refused, allowed) => {
    expectRefused("obsidian-markdown", refused, true);
    expectAllowed("obsidian-markdown", allowed);
  });

  test.each([
    ["a note embed", "![[note]]"],
    ["a sized image embed", "![[img.png|200]]"],
    ["two embeds", "![[a]] and ![[b|x]]"],
    ["a heading embed", "![[note#Heading]]"],
    ["a link", "[link](https://h)"],
    ["an autolink", "<https://h>"],
    ["a reference definition (a link)", "[r]: https://h"],
    ["plain text", "Met with the team. Next: ship it."],
  ])("allowed: %s", (_label, text) => {
    expectAllowed("obsidian-markdown", text);
  });

  test("R6: literal url( text is refused (stated over-refusal); the tripwire is (c)", () => {
    expect(remoteContentIn("obsidian-markdown", "use url(x) here")).toBe(true);
    expect(remoteContentIn("obsidian-markdown", "use url(x) here", { tripwire: false })).toBe(
      false,
    );
  });

  test("a note that does not settle is refused", () => {
    expectRefused("obsidian-markdown", "&amp;amp;amp;amp;amp;", true);
  });
});

// ---------------------------------------------------------------------------------------------
// R11 + R12: Drive markup files (Review Focus 5)
// ---------------------------------------------------------------------------------------------

/** How Task 5 composes the Drive row: scanned by type, then refused by content. */
function driveRefused(mimeType: unknown, content: string): boolean {
  return driveMimeTypeScans(mimeType) && remoteContentIn("drive-markup", content);
}

describe("Drive mimeType matching (plan R11)", () => {
  const PIXEL = "<img src=//h>";

  test.each([
    ["text/html"],
    // The essence is lower-cased; were it not, (d)'s lower-case-only pattern would still scan it.
    ["TEXT/HTML"],
    ["text/html; charset=utf-8"],
    ["text/html;charset=UTF-8"],
    [" text/html "],
    [`${TAB}text/html${TAB}`],
    // The FOLDED form is defence in depth: a non-ASCII or invisible character already fails (d)'s
    // clean-token pattern in the RAW form, so both spellings scan either way.
    [`text${ZWSP}/html`],
    [`text${FULLWIDTH_SOLIDUS}html`],
    [`text/plain${FULLWIDTH_SEMICOLON} x`],
    ["application/xhtml+xml"],
    ["image/svg+xml"],
    ["image/SVG+XML; charset=utf-8"],
    ["text/xml"],
    ["application/xml"],
    ["application/rss+xml"],
    ["text/x-html"],
    ["image/svg"],
    ["application/vnd.google-apps.document"],
    [""],
    ["text/ html"],
    ["html"],
    ["text"],
    ["a/b/c"],
  ])("scanned: %p", (mime) => {
    expect(driveMimeTypeScans(mime)).toBe(true);
    expect(driveRefused(mime, PIXEL)).toBe(true);
  });

  test.each([[42], [null], [true], [{}]])("a non-string is scanned: %p", (mime) => {
    expect(driveMimeTypeScans(mime)).toBe(true);
  });

  test.each([
    [undefined],
    ["text/plain"],
    ["TEXT/PLAIN"],
    ["text/plain; charset=utf-8"],
    ["text/csv"],
    ["text/markdown"],
    ["application/json"],
    ["image/png"],
  ])("not scanned (the same content is allowed, shown verbatim): %p", (mime) => {
    expect(driveMimeTypeScans(mime)).toBe(false);
    expect(driveRefused(mime, PIXEL)).toBe(false);
  });

  test("an empty file of a markup type is allowed", () => {
    expect(driveRefused("text/html", "")).toBe(false);
  });
});

describe("Drive SVG and XHTML (plan R12)", () => {
  const DRIVE: readonly (readonly [string, string, string])[] = [
    [
      "an SVG image href",
      `<svg><image href="//h/x.png"/></svg>`,
      `<svg><image href="x.png"/></svg>`,
    ],
    [
      "an SVG image xlink:href",
      `<svg><image xlink:href="https://h/x.png"/></svg>`,
      `<svg><image xlink:href="#x"/></svg>`,
    ],
    ["an SVG use", `<svg><use href="https://h/s.svg#i"/></svg>`, `<svg><use href="#i"/></svg>`],
    ["an SVG feImage", "<svg><feImage href=//h/></svg>", "<svg><feImage href=#i /></svg>"],
    [
      "foreignObject",
      "<svg><foreignObject><p>x</p></foreignObject></svg>",
      "<svg><g><text>x</text></g></svg>",
    ],
    ["FOREIGNOBJECT", "<FOREIGNOBJECT></FOREIGNOBJECT>", "<G></G>"],
    ["a prefixed foreignObject", "<svg:foreignObject/>", "<svg:g/>"],
    [
      "@import in an SVG style",
      "<svg><style>@import url(//h/x.css);</style></svg>",
      "<svg><style>rect{fill:red}</style></svg>",
    ],
    [
      "an external url in an SVG style",
      "<svg><style>rect{fill:url(https://h/p.svg#g)}</style></svg>",
      "<svg><style>rect{fill:url(#g)}</style></svg>",
    ],
    ["an external fill", `<rect fill="url(https://h/p.svg#g)"/>`, `<rect fill="url(#g)"/>`],
    ["a quoted external filter", `<rect filter="url( '//h#f' )"/>`, `<rect filter="url( '#f' )"/>`],
    ["an unterminated mask url", `<rect mask="url(#m"/>`, `<rect mask="url(#m)"/>`],
    [
      "every url( is checked (Review fix 3)",
      `<rect filter="url(#a) url(https://x/y.svg#z)"/>`,
      `<rect filter="url(#a) url(#b)"/>`,
    ],
    ["an image-set mask", `<rect mask="image-set('//h' 1x)"/>`, `<rect mask="url(#m)"/>`],
    [
      "an escaped url in a presentation attribute",
      `<rect fill="u\\72l(//h)"/>`,
      `<rect fill="u\\72l(#g)"/>`,
    ],
    [
      "an entity-encoded url in a presentation attribute",
      `<rect fill="&#117;rl(//h)"/>`,
      `<rect fill="&#117;rl(#g)"/>`,
    ],
    [
      "an external url in a style attribute",
      `<rect style="fill:url(//h)"/>`,
      `<rect style="fill:url(#g)"/>`,
    ],
    [
      "SMIL set href",
      `<set attributeName="href" to="//h"/>`,
      `<set attributeName="opacity" to="1"/>`,
    ],
    [
      "SMIL animate xlink:href",
      `<animate attributeName="xlink:href" values="a;//h"/>`,
      `<animate attributeName="x" values="a;//h"/>`,
    ],
    [
      "SMIL src (upper case)",
      `<animate attributeName="SRC" values="x"/>`,
      `<animate attributeName="r" values="x"/>`,
    ],
    [
      "SMIL values holding a url(",
      `<animate attributeName="fill" values="url(//h)"/>`,
      `<animate attributeName="fill" values="url(#a)"/>`,
    ],
    ["xml-stylesheet", `<?xml-stylesheet href="//h/x.css"?>`, `<?xml version="1.0"?>`],
    [
      "an upper-case XML-STYLESHEET",
      `<?XML-STYLESHEET href="x.css"?>`,
      `<?xml version="1.0" encoding="UTF-8"?>`,
    ],
    ["a SYSTEM doctype", `<!DOCTYPE svg SYSTEM "https://h/x.dtd">`, "<!DOCTYPE svg>"],
    [
      "a doctype internal subset",
      `<!DOCTYPE svg [<!ENTITY e SYSTEM "https://h">]>`,
      "<!DOCTYPE svg>",
    ],
    [
      "the XHTML PUBLIC doctype (owner-accepted over-refusal)",
      `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">`,
      "<!DOCTYPE html>",
    ],
    [
      "CDATA in an SVG style",
      "<svg><style><![CDATA[rect{fill:red}]]></style></svg>",
      "<svg><style>rect{fill:red}</style></svg>",
    ],
    ["an event handler", `<svg onload="x"></svg>`, `<svg id="x"></svg>`],
    ["an unclosed style", "<svg><style>rect{}", "<svg><style>rect{}</style>"],
    ["an HTML iframe", "<iframe src=x></iframe>", "<p>x</p>"],
    ["a cid image (no cid: in Drive)", `<img src="cid:x">`, `<img src="x">`],
  ];

  test.each(DRIVE)("%s", (_label, refused, allowed) => {
    expectRefused("drive-markup", refused, true);
    expectAllowed("drive-markup", allowed);
  });

  test.each([
    ["a gradient fill", `<svg><rect fill="url(#g)"/><linearGradient id="g"/></svg>`],
    ["a fragment fill in a style attribute", `<rect style="fill:url(#g)"/>`],
    ["an SVG link", `<svg><a href="https://h"><text>x</text></a></svg>`],
    ["an XML declaration", `<?xml version="1.0"?>`],
    [
      "SVG namespaces",
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect/></svg>`,
    ],
    [
      "an HTML page with a link",
      `<!DOCTYPE html><html><body><a href="https://h/?a=1&amp;b=2">x</a></body></html>`,
    ],
    ["a path", `<path d="M0 0 L10 10 Z"/>`],
  ])("allowed: %s", (_label, text) => {
    expectAllowed("drive-markup", text);
  });

  test("R6 (Drive): a fragment url( is not tripped, any other is", () => {
    expect(remoteContentIn("drive-markup", "fill: url( '#g' ) in prose")).toBe(false);
    expect(remoteContentIn("drive-markup", "fill: url(x) in prose")).toBe(true);
    expect(remoteContentIn("drive-markup", "fill: url(x) in prose", { tripwire: false })).toBe(
      false,
    );
    expect(remoteContentIn("drive-markup", "a url(#a) then url(x)")).toBe(true);
  });

  test("an unsettled attributeName or declaration is refused", () => {
    expectRefused("drive-markup", `<set attributeName="&amp;amp;amp;amp;amp;"/>`, true);
    expectRefused("drive-markup", "<!x &amp;amp;amp;amp;amp;>", true);
  });

  test("a non-`!`, non-`?` declaration is not an XML declaration", () => {
    expectAllowed("drive-markup", "</1>");
  });

  test("markup that does not tokenize is refused", () => {
    expectRefused("drive-markup", "<svg", true);
  });
});

// ---------------------------------------------------------------------------------------------
// Linear time (adversarial review). Bounds are generous: CI runners are slow. Each input is run
// at N and 2N; the best of three runs at 2N must stay under 4x the best at N (with a 10 ms floor,
// so timer noise on a fast machine cannot fail it). A quadratic scan doubles to ~4x and a
// catastrophic regex does not finish at all.
// ---------------------------------------------------------------------------------------------

function bestMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

function expectLinear(format: RemoteContentFormat, build: (n: number) => string, n: number): void {
  const small = build(n);
  const large = build(2 * n);
  const tSmall = bestMs(() => remoteContentIn(format, small));
  const tLarge = bestMs(() => remoteContentIn(format, large));
  expect(tLarge).toBeLessThan(1000);
  expect(tLarge).toBeLessThan(4 * Math.max(tSmall, 10));
}

describe("linear time on adversarial input", () => {
  test("`src=` + a million spaces (the URL-assignment tripwire)", () => {
    const text = `src=${" ".repeat(1_000_000)}x`;
    const t = bestMs(() => remoteContentIn("outlook-html", text));
    expect(t).toBeLessThan(1000);
    expectLinear("outlook-html", (n) => `src=${" ".repeat(n)}x`, 500_000);
    expectLinear("confluence-storage", (n) => `src=${" ".repeat(n)}x`, 500_000);
  });

  test("`url(` + a million spaces (the Drive CSS tripwire)", () => {
    const text = `url(${" ".repeat(1_000_000)}x`;
    const t = bestMs(() => remoteContentIn("drive-markup", text));
    expect(t).toBeLessThan(1000);
    expectLinear("drive-markup", (n) => `url(${" ".repeat(n)}x`, 500_000);
  });

  test("100,000 nested style elements (start and end tags paired in one pass)", () => {
    const build = (n: number): string => `${"<style>".repeat(n)}${"</style>".repeat(n)}`;
    const t = bestMs(() => remoteContentIn("outlook-html", build(100_000)));
    expect(t).toBeLessThan(1000);
    expect(remoteContentIn("outlook-html", build(100_000), { tripwire: false })).toBe(true);
    expectLinear("outlook-html", build, 50_000);
  });

  test("330,000 openers inside one attribute value (the nested-view opener cap)", () => {
    const text = `<a title="${"<b>".repeat(330_000)}">`;
    const t = bestMs(() => remoteContentIn("outlook-html", text));
    expect(t).toBeLessThan(1000);
    expect(remoteContentIn("outlook-html", text, { tripwire: false })).toBe(true);
    expectLinear("outlook-html", (n) => `<a title="${"<b>".repeat(n)}">`, 150_000);
  });

  test("the nested view: 16 openers in one tag pass, 17 do not; the character budget refuses", () => {
    expectAllowed("outlook-html", `<a title="${"<b>".repeat(16)}">`);
    expectRefused("outlook-html", `<a title="${"<b>".repeat(17)}">`, true);
    // 16 views of a 200,000-character tag re-tokenize over REMOTE_SCAN_MAX_CHARS.
    expectRefused("outlook-html", `<a title="${"<b>".repeat(16)}${"x".repeat(200_000)}">`, true);
    expectAllowed("outlook-html", `<a title="${"<b>".repeat(16)}${"x".repeat(1_000)}">`);
  });

  test("many Confluence parameters stay linear (one pass, no per-parameter search)", () => {
    const build = (n: number): string =>
      `<ac:structured-macro ac:name="panel">${'<ac:parameter ac:name="x">blue</ac:parameter>'.repeat(n)}</ac:structured-macro>`;
    expect(remoteContentIn("confluence-storage", build(3))).toBe(false);
    expectLinear("confluence-storage", build, 10_000);
    // Opened and never closed, 100,000 deep: refused at once.
    const nested = `<ac:structured-macro ac:name="panel">${'<ac:parameter ac:name="x">'.repeat(100_000)}`;
    const t = bestMs(() => remoteContentIn("confluence-storage", nested));
    expect(t).toBeLessThan(1000);
    expect(remoteContentIn("confluence-storage", nested, { tripwire: false })).toBe(true);
  });

  test("many disjoint style elements stay linear", () => {
    const build = (n: number): string => "<style>p{}</style><p>x</p>".repeat(n);
    expect(remoteContentIn("outlook-html", build(10))).toBe(false);
    expectLinear("outlook-html", build, 20_000);
  });
});
