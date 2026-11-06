/**
 * B3r (plan Task 5): the remote-content rule reads each scanned row's body in the format the
 * INSTALLED connector sends it in. These pins hold the connector code those choices rest on, so a
 * connectors bump that changes how a body is sent fails CI here instead of opening a gap:
 *  (a) the Notion block append and page update `JSON.parse` the body and send `JSON.stringify`
 *      of the parsed value, so Notion receives exactly what the gateway walked (duplicate keys
 *      collapse, last wins, before either sees them: R8);
 *  (b) the Outlook draft sends `HTML` only for `contentType === "html"` (R10's format rule);
 *  (c) each Confluence write sends `representation: "storage"`, and the append sends
 *      `page.html + parsed.storageHtml` (R5: only the new fragment is scanned);
 *  (d) the Obsidian append writes `parsed.content` with no transform;
 *  (e) the Drive create uses `args.mimeType ?? "text/plain"` as both the metadata `mimeType` and
 *      the media part's `Content-Type`, and sends `args.content` unchanged (R11: unset is
 *      `text/plain`; the gateway does not sniff content).
 * Each pin has a guard that its matcher fails a mutated snippet.
 */
import { describe, expect, test } from "bun:test";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";

const SOURCES = readConnectorPackageSources(installedConnectorsPackageRoot());
const SCAN = scanWriteToolRegistrations(SOURCES);

/** The comment-free text of the one registering call for `id` in `connector`'s directory. */
function registration(id: string, connector: string): string {
  const hits = SCAN.registrations.filter(
    (r) => r.id === id && r.origin.split("/")[1] === connector,
  );
  expect(hits, id).toHaveLength(1);
  const r = hits[0];
  if (r === undefined) throw new Error("unreachable");
  const src = SOURCES.find((s) => s.rel === r.file);
  return stripComments(src?.text ?? "").slice(r.span[0], r.span[1] + 1);
}

/** The comment-free text of the source file that registers `id` (for module-level helpers). */
function registeringFile(id: string, connector: string): string {
  const r = SCAN.registrations.find((x) => x.id === id && x.origin.split("/")[1] === connector);
  return stripComments(SOURCES.find((s) => s.rel === r?.file)?.text ?? "");
}

const compact = (s: string): string => s.split(/\s+/).join(" ");

/** Source text with `#{` written for a template substitution (keeps `${` out of string literals). */
const tpl = (s: string): string => s.split("#{").join(`${"$"}{`);

// (a)
function notionSendsWhatItParsed(call: string, key: string, sent: string): boolean {
  const c = compact(call);
  return (
    c.includes(`JSON.parse(parsed.${key})`) &&
    c.includes(`JSON.stringify(${sent})`) &&
    !c.includes(`parsed.${key},`)
  );
}

// (b)
const OUTLOOK_HTML_ONLY = /\(data\.contentType \?\? "text"\) === "html" \? "HTML" : "Text"/;

// (c)
function confluenceSendsStorage(call: string): boolean {
  const c = compact(call);
  return c.includes('representation: "storage"') && c.includes("parsed.storageHtml");
}

// (d)
function obsidianWritesContentVerbatim(call: string): boolean {
  // The appended text is the optional newline prefix and the content, nothing else.
  return compact(call).includes(tpl("const final = `#{prefix}#{parsed.content}`"));
}

// (e)
function driveSendsTypeAndContent(call: string): boolean {
  const c = compact(call);
  return (
    c.includes('const mime = args.mimeType ?? "text/plain"') &&
    c.includes("mimeType: mime") &&
    c.includes("driveMultipartCreate(token, meta, args.content, mime)")
  );
}

describe("remote-content: the installed connectors send each body as the rule reads it", () => {
  test("(a) Notion block append and page update parse, then send the parsed value", () => {
    expect(
      notionSendsWhatItParsed(
        registration("notion_block_append", "notion"),
        "childrenJson",
        "{ children }",
      ),
    ).toBe(true);
    expect(
      notionSendsWhatItParsed(
        registration("notion_page_update", "notion"),
        "propertiesJson",
        "{ properties: props }",
      ),
    ).toBe(true);
  });

  test('(b) the Outlook draft sends HTML only for contentType "html"', () => {
    registration("outlook_draft_create", "outlook");
    expect(
      OUTLOOK_HTML_ONLY.test(compact(registeringFile("outlook_draft_create", "outlook"))),
    ).toBe(true);
  });

  test("(c) every Confluence write sends storage; the append sends old + new", () => {
    for (const id of [
      "confluence_page_create",
      "confluence_page_update",
      "confluence_page_append",
      "confluence_comment_add",
    ]) {
      expect(confluenceSendsStorage(registration(id, "confluence")), id).toBe(true);
    }
    expect(compact(registration("confluence_page_append", "confluence"))).toContain(
      "page.html + parsed.storageHtml",
    );
  });

  test("(d) the Obsidian append writes the content with no transform", () => {
    expect(
      obsidianWritesContentVerbatim(registration("obsidian_append_to_daily_note", "obsidian")),
    ).toBe(true);
  });

  test("(e) the Drive create sends its type (text/plain when unset) and the content as is", () => {
    expect(driveSendsTypeAndContent(registration("gdrive_file_create", "google-drive"))).toBe(true);
    // The media part's Content-Type is the same `mime`.
    expect(compact(registeringFile("gdrive_file_create", "google-drive"))).toContain(
      tpl("`Content-Type: #{mediaMime}`"),
    );
  });

  test("guard: each matcher fails a mutated snippet", () => {
    expect(
      notionSendsWhatItParsed(
        "children = JSON.parse(parsed.childrenJson); body: JSON.stringify({ children })",
        "childrenJson",
        "{ children }",
      ),
    ).toBe(true);
    // The raw string forwarded instead of the parsed value.
    expect(
      notionSendsWhatItParsed(
        tpl(
          'children = JSON.parse(parsed.childrenJson); body: `{"children":#{parsed.childrenJson}}`',
        ),
        "childrenJson",
        "{ children }",
      ),
    ).toBe(false);
    expect(
      OUTLOOK_HTML_ONLY.test('(data.contentType ?? "text") !== "text" ? "HTML" : "Text"'),
    ).toBe(false);
    expect(confluenceSendsStorage('value: parsed.storageHtml, representation: "wiki"')).toBe(false);
    expect(
      obsidianWritesContentVerbatim(tpl("const final = `#{prefix}#{render(parsed.content)}`")),
    ).toBe(false);
    expect(
      driveSendsTypeAndContent(
        'const mime = args.mimeType ?? "text/html"; mimeType: mime; driveMultipartCreate(token, meta, args.content, mime)',
      ),
    ).toBe(false);
    expect(
      driveSendsTypeAndContent(
        'const mime = args.mimeType ?? "text/plain"; mimeType: mime; driveMultipartCreate(token, meta, sniff(args.content), mime)',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// B3w (plan Task 3): the sent-mail, Teams and forge rows, and the re-checked exclusions.
// ---------------------------------------------------------------------------------------------

/** The comment-free text of a connectors-package file by package-relative path. */
function packageFile(rel: string): string {
  const src = SOURCES.find((s) => s.rel === rel);
  if (src === undefined) throw new Error(`${rel} is not in the installed connectors package`);
  return compact(stripComments(src.text));
}

// (f)
function outlookSendUsesGraphMessage(call: string): boolean {
  return compact(call).includes(
    "JSON.stringify({ message: graphMessage(data), saveToSentItems: true })",
  );
}

// (g)
function teamsSendsBodyOnly(file: string): boolean {
  const at = file.indexOf("async function postGraphMessage(");
  if (at === -1) return false;
  const fn = file.slice(at, file.indexOf("}); }", at) + 5);
  return (
    fn.includes('body: { contentType: contentType === "html" ? "html" : "text", content, }') &&
    !/attachments|hostedContents|mentions/.test(fn)
  );
}

// (h), (i)
const sends = (call: string, needle: string): boolean => compact(call).includes(needle);

// (j)
function slackSendsTextOnly(call: string): boolean {
  const c = compact(call);
  return (
    c.includes(
      "const body: Record<string, unknown> = { channel: parsed.channel, text: parsed.text, };",
    ) && !/blocks|attachments/.test(c)
  );
}
function discordSendsContentOnly(call: string): boolean {
  const c = compact(call);
  return (
    c.includes(
      'body: JSON.stringify({ content: parsed.content, allowed_mentions: { parse: ["users"] }, })',
    ) && !/embeds/.test(c)
  );
}

describe("remote-content (B3w): the installed connectors send each new body as the rule reads it", () => {
  test("(f) outlook_mail_send posts graphMessage(data) (the draft's mapping, pin (b))", () => {
    expect(outlookSendUsesGraphMessage(registration("outlook_mail_send", "outlook"))).toBe(true);
  });

  test("(g) Teams posts only { body: { contentType, content } }, and both tools pass parsed.contentType", () => {
    const file = packageFile("connectors/teams/src/tools.ts");
    expect(teamsSendsBodyOnly(file)).toBe(true);
    for (const id of ["teams_message_post", "teams_message_post_chat"]) {
      expect(compact(registration(id, "teams")), id).toContain("parsed.contentType");
    }
  });

  test("(h) GitHub and GitLab send the body (or description) as given", () => {
    expect(
      sends(
        registration("github_issue_create", "github"),
        'jsonInit("POST", { title: parsed.title, body: parsed.body })',
      ),
    ).toBe(true);
    expect(
      sends(
        registration("github_issue_comment_create", "github"),
        'jsonInit("POST", { body: parsed.body })',
      ),
    ).toBe(true);
    for (const id of ["gitlab_issue_note_create", "gitlab_mr_note_create"]) {
      expect(sends(registration(id, "gitlab"), 'jsonBody("POST", { body: parsed.body })'), id).toBe(
        true,
      );
    }
    expect(
      sends(registration("gitlab_issue_create", "gitlab"), "description: parsed.description"),
    ).toBe(true);
  });

  test("(i) Linear sends the description and the comment body as given", () => {
    for (const id of ["linear_issue_create", "linear_issue_update"]) {
      expect(
        sends(registration(id, "linear"), 'input["description"] = parsed.description'),
        id,
      ).toBe(true);
    }
    expect(sends(registration("linear_comment_create", "linear"), "body: parsed.body")).toBe(true);
  });

  test("(j) the exclusions: Slack text only, Discord content only, Jira through plainToAdf", () => {
    expect(slackSendsTextOnly(registration("slack_message_post", "slack"))).toBe(true);
    expect(discordSendsContentOnly(registration("discord_message_post", "discord"))).toBe(true);
    for (const id of ["jira_issue_create", "jira_issue_update", "jira_comment_add"]) {
      expect(compact(registration(id, "jira")), id).toContain("plainToAdf(parsed.");
    }
  });

  test("(k) the plain-text sends: Gmail, Fastmail, IMAP/ProtonMail and Apple send text/plain", () => {
    expect(packageFile("connectors/gmail/src/tools.ts")).toContain(
      '"Content-Type: text/plain; charset=UTF-8"',
    );
    expect(packageFile("connectors/fastmail/src/jmap-client.ts")).toContain(
      'bodyStructure: { type: "text/plain"',
    );
    const imap = packageFile("shared/imapflow-adapter.ts");
    expect(imap).toContain("text: input.body,");
    expect(/\bhtml\s*:/.test(imap)).toBe(false);
    expect(packageFile("connectors/apple/src/adapters.ts")).toContain(
      '"Content-Type: text/plain; charset=UTF-8"',
    );
  });

  test("guard: each B3w matcher fails a mutated snippet", () => {
    expect(
      outlookSendUsesGraphMessage(
        "JSON.stringify({ message: graphMessage(data), saveToSentItems: true })",
      ),
    ).toBe(true);
    expect(outlookSendUsesGraphMessage("JSON.stringify({ message: { body: data.body } })")).toBe(
      false,
    );
    const teams =
      'async function postGraphMessage( token, path, content, contentType = "text", ) { return graphRequest(token, path, { body: JSON.stringify({ body: { contentType: contentType === "html" ? "html" : "text", content, }, }), }); }';
    expect(teamsSendsBodyOnly(teams)).toBe(true);
    // An `attachments` key added beside the body (the review's planned red-proof).
    expect(
      teamsSendsBodyOnly(teams.split("content, },").join("content, }, attachments: [],")),
    ).toBe(false);
    expect(
      slackSendsTextOnly(
        "const body: Record<string, unknown> = { channel: parsed.channel, text: parsed.text, }; body.blocks = x;",
      ),
    ).toBe(false);
    expect(
      discordSendsContentOnly(
        'body: JSON.stringify({ content: parsed.content, allowed_mentions: { parse: ["users"] }, }) embeds',
      ),
    ).toBe(false);
    expect(
      sends(
        'jsonInit("POST", { body: render(parsed.body) })',
        'jsonInit("POST", { body: parsed.body })',
      ),
    ).toBe(false);
  });
});
