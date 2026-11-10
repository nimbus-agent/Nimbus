// packages/gateway/src/connectors/connector-writes/model-write-refusals.ts
// The door's destination refusals for the model's connector writes (Phase 9.7 B, rulings F3/F4 and
// the owner's 2026-11-05 rulings OR1/OR2): the model may not post to a channel Nimbus ChatOps
// listens on, may not post a message or comment that notifies a whole channel, group or team (a
// broadcast mention), and may not write to the Nimbus knowledge base (the tribal-capture
// destination; its own gate is the only writer, I25). Pure: the ChatOps bindings and the KB config
// are passed in, and nothing here reaches the network, so a destination that cannot be PROVEN
// distinct from a configured one is refused (fail closed).
//
// `messagingDestinationRefusal` (ChatOps, broadcast mentions, GitLab quick actions and, since B2,
// GitLab scoped labels; it covers issue titles, bodies and descriptions too; since B3r remote
// content in drafts, pages, notes and Drive markup files, and since B3w in sent Outlook mail,
// Teams HTML and GitHub, GitLab and Linear Markdown; since B4a also the calendar event-time
// and iCloud event-text checks) is the ONE function
// both the model door and the MCP act door call. The KB-target refusal (`knowledgeBaseRefusal`,
// one module-private implementation) runs on both doors too since B3 (owner ruling OR-B3-1), and
// covers every page row: Notion page create, update, block append and comment; Confluence page
// create, update, append and comment. The act door's Linear reassignment rule is act-door-only
// (`actDoorRefusal`, which runs the messaging check first).
//
// KB-target bounds (stated): a Confluence create in the KB space with no parent is not refused
// (the parent alone decides); a comment on, or a Notion page created under, a page INSIDE the KB is
// not refused by this rule (owner ruling OR-B3-3 names updates and appends only, which the KB-child
// guard covers; a grandchild only where that guard says so).
//
// Mentions in page bodies (B3, plan R6): NOT scanned, so `BROADCAST_SCANNED` names no Notion or
// Confluence row. Neither API has a whole-channel mention form as these connectors call them:
// Notion rich-text mentions name one user, page, database, date, link preview or template
// (https://developers.notion.com/reference/rich-text, the mention object; a `people` property
// names users), and a Confluence storage mention is `<ac:link><ri:user .../></ac:link>`, one user
// each (https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html). Each named
// user is notified and is visible verbatim in the preview. Plain `@all` / `@here` text in a page is
// inert. Also stated: a Confluence create or update notifies the page's and space's watchers as
// any edit does (the connector sends no `minorEdit`), and Notion notifies a page's followers.
//
// This module names only model-offerable write rows; the gate-confined post and KB tools stay
// named only inside their own gates (D17/D19).
import type { ChatopsPolicy } from "../../policy/types.ts";
import { commitModelRefusal } from "./commit-paths.ts";
import { deployModelRefusal } from "./deploy-refusals.ts";
import { iacModelRefusal } from "./iac-limits.ts";
import { k8sModelRefusal } from "./k8s-manifest.ts";
import {
  driveContentFormats,
  type RemoteContentFormat,
  remoteContentIn,
} from "./remote-content.ts";
import { foldAndStrip, settle } from "./text-normalise.ts";
import type { TribalKbConfig } from "./types.ts";

export const CHATOPS_CHANNEL_REFUSAL =
  "the model cannot post to a channel Nimbus ChatOps listens on";
export const KNOWLEDGE_BASE_REFUSAL =
  "the model cannot write to the Nimbus knowledge base; use the capture flow";
/**
 * OR-B3-3 (R11): an update or append to a page whose parent is the KB destination. The model door
 * enforces it with the four page readers' KB-child guard (`knowledge.ts`), from the page's
 * current parent read at call time; fixed, echoes nothing.
 */
export const KNOWLEDGE_BASE_CHILD_REFUSAL =
  "the model cannot change a page in the Nimbus knowledge base; use the capture flow";
export const BROADCAST_MENTION_REFUSAL =
  "the model cannot post a message that notifies a whole channel, group or team; rephrase without the broadcast mention";
/**
 * OR-B2-3: a Linear `assigneeId` on update replaces the one assignee, so the model may set it only
 * while the issue is unassigned. The model door enforces it with the `linear_issue_update` row's
 * before-state guard (`tickets.ts`, proven unassigned at call time); fixed, echoes nothing.
 */
export const LINEAR_ASSIGNEE_REFUSAL =
  "the model can assign a Linear issue only while it is unassigned; ask the owner to reassign it";
export const GITLAB_QUICK_ACTION_REFUSAL =
  "GitLab quick actions (lines starting with /) are not allowed in model-written GitLab text; rephrase without them";
export const GITLAB_SCOPED_LABEL_REFUSAL =
  "the model cannot add a GitLab scoped label (key::value): it replaces the label with the same key; ask the owner to add it";

// `TribalKbConfig` lives in `./types.ts` (a before-state guard reads it, B3); re-exported here so
// existing importers are unchanged.
export type { TribalKbConfig } from "./types.ts";

type Platform = "slack" | "teams";

/** Which input key names the destination of each ChatOps-platform post row. */
const CHATOPS_POST_ROWS: Readonly<Record<string, { platform: Platform; key: string }>> = {
  slack_message_post: { platform: "slack", key: "channel" },
  teams_message_post: { platform: "teams", key: "channelId" },
  teams_message_post_chat: { platform: "teams", key: "chatId" },
};

/** The Linear update row: on the act door its `assigneeId` is refused (`actDoorRefusal`). */
const LINEAR_ISSUE_UPDATE_ROW = "linear_issue_update";

/** The Slack DM row: its destination is `user_ids`, never a channel (see `refusesSlackDm`). */
const SLACK_DM_ROW = "slack_message_post_dm";

/** Which input keys of each Notion / Confluence row can name a KB page or database. */
const NOTION_KB_KEYS: Readonly<Record<string, readonly string[]>> = {
  notion_page_create: ["parentPageId"],
  notion_page_update: ["pageId"],
  notion_block_append: ["parentBlockId"],
  notion_comment_create: ["pageId"],
};
const CONFLUENCE_KB_KEYS: Readonly<Record<string, readonly string[]>> = {
  confluence_page_create: ["parentPageId"],
  confluence_page_update: ["pageId"],
  confluence_comment_add: ["pageId"],
  confluence_page_append: ["pageId"],
};

function ownLookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * A destination as ChatOps would key it: folded (NFKC, invisible and control characters
 * removed), trimmed, percent-decoded and folded again, one leading `#` removed, and (for a Teams
 * conversation) the `;messageid=…` suffix dropped. `undefined` when it does not decode. Case is
 * kept here so the id-shape tests below can tell an id from a name.
 */
function canonicalDestination(raw: string): string | undefined {
  let s = foldAndStrip(raw).trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    return undefined;
  }
  s = foldAndStrip(s).trim();
  if (s.startsWith("#")) s = s.slice(1).trim();
  const semi = s.indexOf(";");
  if (semi !== -1) s = s.slice(0, semi);
  return s;
}

/** A Slack conversation id (`C…`, `G…`, `D…`, upper-case); a channel NAME is lower-case. */
function isSlackId(s: string): boolean {
  return /^[CGD][A-Z0-9]+$/.test(s);
}

/** A Teams thread id as the Graph API and the Bot Framework both spell it (`19:…`). */
function isTeamsThreadId(s: string): boolean {
  return /^19:\S+$/.test(s);
}

/** The platform a configured ChatOps entry belongs to, or `undefined` when its shape cannot say. */
function platformOf(entry: string): Platform | undefined {
  if (isSlackId(entry)) return "slack";
  if (isTeamsThreadId(entry) || /^[a-z0-9]+:/i.test(entry)) return "teams";
  return undefined;
}

/** Every channel the ChatOps policy binds (listened on) or posts notifications to, canonical. */
function chatopsEntries(chatops: ChatopsPolicy): string[] {
  const out: string[] = [];
  const add = (raw: string): void => {
    const c = canonicalDestination(raw);
    out.push(c ?? raw);
  };
  for (const [channelId, binding] of chatops.channels) {
    add(channelId);
    for (const n of binding.notify) add(n);
  }
  return out;
}

/**
 * F3: whether a model post to `rawDestination` on `platform` must be refused. Refused when it
 * matches (case-insensitively, after canonicalisation) a configured entry, and also whenever it
 * cannot be proven NOT to be one: ChatOps has an entry for this platform (or one whose platform its
 * shape cannot tell) and the destination is not an id this gateway can compare without a network
 * call (a Slack channel NAME, an undecodable value, a non-string), or an entry is a name that a
 * Slack id might resolve to.
 */
/** The configured ChatOps entries that may belong to `platform` (its own, or shape-unknown). */
function entriesFor(chatops: ChatopsPolicy, platform: Platform): string[] {
  return chatopsEntries(chatops).filter((e) => {
    const p = platformOf(e);
    return p === undefined || p === platform;
  });
}

function refusesChatopsPost(
  chatops: ChatopsPolicy,
  platform: Platform,
  rawDestination: unknown,
): boolean {
  const relevant = entriesFor(chatops, platform);
  if (relevant.length === 0) return false;
  if (typeof rawDestination !== "string") return true;
  const dest = canonicalDestination(rawDestination);
  if (dest === undefined || dest === "") return true;
  const lowered = dest.toLowerCase();
  if (relevant.some((e) => e.toLowerCase() === lowered)) return true;
  // An entry whose platform its shape cannot tell may be a channel NAME the destination id
  // resolves to, and a Teams entry that is not a `19:` thread (a personal `a:` conversation) has
  // no Graph spelling to compare; telling either apart needs the network.
  const unmappable = (e: string): boolean => {
    const p = platformOf(e);
    return p === undefined || (p === "teams" && !isTeamsThreadId(e));
  };
  if (relevant.some(unmappable)) return true;
  return platform === "slack" ? !isSlackId(dest) : !isTeamsThreadId(dest);
}

/**
 * F3 (Slack DM): a DM to the ChatOps bot is a ChatOps destination. Telling the bot apart from the
 * `user_ids` would need the bot's own user id, which this gateway learns only from Slack (no
 * ChatOps config or boot state holds it offline), so EVERY model DM is refused while ChatOps has a
 * Slack entry (or one whose platform its shape cannot tell). Without one, the DM is allowed.
 */
function refusesSlackDm(chatops: ChatopsPolicy): boolean {
  return entriesFor(chatops, "slack").length > 0;
}

/** Notion ids compare lower-case without hyphens; a value CONTAINING the id (a URL) matches too. */
export function canonicalNotionId(s: string): string {
  return s.trim().toLowerCase().replaceAll("-", "");
}

/** F4 (Notion): any KB-capable key naming the KB database (a non-string value is refused). */
function refusesNotion(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  kb: TribalKbConfig,
): boolean {
  const keys = ownLookup(NOTION_KB_KEYS, toolId);
  const db = kb.notion?.databaseId;
  if (keys === undefined || db === undefined) return false;
  const target = canonicalNotionId(db);
  if (target === "") return false;
  return keys.some((k) => {
    const v = input[k];
    if (v === undefined) return false;
    return typeof v !== "string" || canonicalNotionId(v).includes(target);
  });
}

const CANONICAL_PAGE_ID = /^[1-9]\d*$/;

/** F4 (Confluence): a KB-capable key naming the KB parent page, compared as trimmed strings. */
function refusesConfluence(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  kb: TribalKbConfig,
): boolean {
  const keys = ownLookup(CONFLUENCE_KB_KEYS, toolId);
  const parent = kb.confluence?.parentPageId.trim();
  if (keys === undefined || parent === undefined || parent === "") return false;
  return keys.some((k) => {
    const v = input[k];
    if (v === undefined) return false;
    // A page create in the KB space under the KB parent is covered: the parent alone decides.
    // A value that is not a canonical page id ("0"+id, a URL) cannot be proven distinct: refused.
    if (typeof v !== "string") return true;
    const t = v.trim();
    return !CANONICAL_PAGE_ID.test(t) || t === parent;
  });
}

export interface RefusalContext {
  /** The ChatOps bindings of the LIVE enforced policy; `undefined` means "cannot tell". */
  readonly chatops: ChatopsPolicy | undefined;
  readonly kb: TribalKbConfig | undefined;
}

/** Whether `toolId` is a ChatOps-platform post row (its refusal text is the ChatOps one). */
export function isChatopsDestinationRow(toolId: string): boolean {
  return toolId === SLACK_DM_ROW || ownLookup(CHATOPS_POST_ROWS, toolId) !== undefined;
}

/**
 * Whether `toolId` is a Notion or Confluence row whose input can name a knowledge-base page or
 * database (it is checked by the F4 refusal). Read-only; the completeness test reads it so a new
 * model-offerable Notion/Confluence row cannot be offered without coverage.
 */
export function isKnowledgeBaseCapableRow(toolId: string): boolean {
  return (
    ownLookup(NOTION_KB_KEYS, toolId) !== undefined ||
    ownLookup(CONFLUENCE_KB_KEYS, toolId) !== undefined
  );
}

// ---------------------------------------------------------------------------------------------
// OR1: broadcast mentions. A post or comment whose text would notify a whole channel, group or
// team is refused. Matching runs on a NORMALISED copy (never on what is sent or shown):
//
//  1. In a loop until the text is stable (at most NORMALISE_MAX_ROUNDS rounds; still changing
//     after that is refused, fail closed): Unicode NFKC (fullwidth `@ ! < &` fold to ASCII), then
//     every FORMAT_INVISIBLE_RANGES character and C0/C1 control removed, then ONE pass of HTML
//     entity decoding (`&lt; &gt; &amp; &quot; &apos; &nbsp;`, decimal `&#NN;`, hex `&#xNN;`, the
//     `;` optional). The order is per round, and the loop repeats it, so an entity spelled with a
//     fullwidth ampersand or with an invisible character inside it still decodes.
//  2. Whitespace runs collapse to one space; the text is lower-cased.
//
// Removing an invisible character can JOIN two words (`@all` + U+200B + `x` reads `@allx`), which
// would hide a mention a platform ends at that character, so the whole pass runs twice: once with
// those characters deleted and once with each replaced by a space. Either form matching refuses.
// TAB, LF, CR, VT and FF are whitespace in both forms. An `html` body is matched a third time with
// its tags removed. Decoding, folding and the extra forms can only ADD matches (fail closed).
//
// Scanned per row (a non-string value in the scanned field is refused):
//  - Slack `text`: any `<!` special token except `<!date^...>` (`<!channel>`, `<!here>`,
//    `<!everyone>`, `<!subteam^ID>` and their `|label` forms), and the plain words `@channel`,
//    `@here`, `@everyone` (the connector sends no `link_names`, so plain words should not notify;
//    refusing them costs nothing and does not depend on a Slack default). Allowed: `<@U123>`,
//    `<#C123>`, `@alice`.
//  - GitHub: a team, `@org/team`, in a comment `body` and (B2) an issue create's `title` and
//    optional `body`. Bound: a bare `@name` is a user or an organisation and is not caught (an
//    organisation mention notifies no members); a team can only be named in the slash form.
//  - GitLab: `@all`, and any slash path `@group/sub[/...]` (a subgroup or project, never a user),
//    in a note `body` and (B2) an issue create's `title` and optional `description`. Bound:
//    `@<top-level-group>` notifies every member but cannot be told from `@<username>` without a
//    lookup (they share one namespace), so it is NOT caught.
//  - Titles are scanned although a platform may not notify from a title (fail closed; a refused
//    model can rephrase). A required key absent or non-string is refused; an OPTIONAL key absent,
//    `undefined` or `null` is skipped, and present but non-string is refused.
//  - Teams `body`: any `<at` tag (`<at>`, `<at id=...>`, `<at/>`), plus the plain words
//    `@channel`, `@team`, `@everyone`. The 0.4.0 tool takes no `mentions` array, and Graph
//    notifies only for an `<at id>` that has a `mentions` entry, so no Teams broadcast is
//    reachable through it today; this is defence in depth. Bound: a connector version that adds a
//    `mentions` input changes the schema the template is checked against, and this rule must be
//    revisited then.
//  - Code spans are scanned too (fail closed): GitHub and GitLab do not notify inside backticks,
//    but telling code apart needs a markdown parser, and a refused model can rephrase.
// Not scanned: Discord (the connector sends `allowed_mentions: { parse: ["users"] }`, pinned by
// `discord-mentions.sync.test.ts`), Jira (plain text in one ADF text node: no mention node can
// exist; B2's issue create and update send their description the same way), Linear (comments and,
// B2, issue create/update: user mentions only), Notion and Confluence (no broadcast mention form
// in their comment APIs as this connector calls them), and every label, assignee, state and
// transition field (no free text a platform parses for mentions).
//
// Notification bounds of the B2 issue writes (stated, not refused): an assignee add notifies each
// named user, at most 10 per GitHub call and 20 per GitLab call (usernames, or on create user
// ids), one on Linear; GitHub and GitLab accept only users as assignees, so a group or team cannot
// be assigned; each is named in the preview. A GitLab label can have subscribers, who are notified
// when it is applied; who subscribes cannot be known without a lookup, so it is not refused, and
// the preview names each label. GitHub has no label subscription; a GitHub label that does not
// exist is created in the repository (the preview's field label says so).
// ---------------------------------------------------------------------------------------------

export type BroadcastService = "slack" | "teams" | "github" | "gitlab";

// The normalisation (`settle`, `foldAndStrip`, the entity decoder, NORMALISE_MAX_ROUNDS) lives in
// `text-normalise.ts` since B3r; it is unchanged.

// A plain-word mention ends where the name does: a name may contain `.` but never ends in one
// (GitLab's own reference pattern), so `@all.` at the end of a sentence still means `@all`, while
// `@all.x`, `@allison` and `a@here.com` name something else. Hence `(?!\.*[a-z0-9_-])`, not a
// lookahead that stops at the first `.`.
const SLACK_SPECIAL = /<!(?!date\^)/;
const SLACK_WORDS = /@(?:channel|here|everyone)(?!\.*[a-z0-9_-])/;
const GITHUB_TEAM = /@[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+/;
const GITLAB_ALL = /@all(?!\.*[a-z0-9_-])/;
const GITLAB_PATH = /@[a-z0-9_][a-z0-9_.-]*\/[a-z0-9_.-]+/;
const TEAMS_AT_TAG = /<at[\s>/]/;
const TEAMS_WORDS = /@(?:channel|team|everyone)(?!\.*[a-z0-9_-])/;

const BROADCAST_RULES: Readonly<Record<BroadcastService, readonly RegExp[]>> = {
  slack: [SLACK_SPECIAL, SLACK_WORDS],
  github: [GITHUB_TEAM],
  gitlab: [GITLAB_ALL, GITLAB_PATH],
  teams: [TEAMS_AT_TAG, TEAMS_WORDS],
};

/**
 * The tag-stripped forms a broadcast scan also matches (never rendered or sent anywhere). Each
 * `tag` pattern is applied until the text stops changing and every pass is kept, so a tag split
 * by another tag is seen whole before a later pass removes it. Two tokenisations: innermost-first
 * (`<[^<>]*>`) and greedy (`<[^>]*>`, where `<x<y>` is one tag).
 *
 * The B3r remote-content detectors do NOT reuse this: a strip-and-match form is the shape of an
 * incomplete sanitizer (a tag rebuilt by a strip passes it), so they read the tokens of the
 * structural tokenizer (`markup-tokens.ts`) instead. Here it only ADDS matching forms.
 */
const TAG_STRIPPERS: ReadonlyArray<(text: string) => string> = [
  (text) => stripTags(text, true),
  (text) => stripTags(text, false),
];

/**
 * Removes every `<...>` run left to right, in one linear pass (the equivalent regular expressions,
 * `/<[^<>]*>/g` and `/<[^>]*>/g`, rescan to the end of the text from every `<` that has no `>`).
 * `innermost`: the run holds no `<` (`<x<y>` removes only `<y>`); otherwise it runs to the first `>`.
 */
function stripTags(text: string, innermost: boolean): string {
  let out = "";
  let from = 0;
  let at = text.indexOf("<");
  while (at !== -1) {
    let close = -1;
    let stop = at + 1;
    if (innermost) {
      while (stop < text.length && text[stop] !== "<" && text[stop] !== ">") stop++;
      if (text[stop] === ">") close = stop;
    } else {
      close = text.indexOf(">", at + 1);
      if (close === -1) break;
    }
    if (close === -1) {
      // No run starts at `at`; the next candidate is the `<` that stopped the scan.
      at = text[stop] === "<" ? stop : -1;
      continue;
    }
    out += text.slice(from, at);
    from = close + 1;
    at = text.indexOf("<", from);
  }
  return out + text.slice(from);
}

function tagStrippedForms(text: string): string[] {
  const out: string[] = [];
  for (const strip of TAG_STRIPPERS) {
    let prev = text;
    for (;;) {
      const next = strip(prev);
      if (next === prev) break;
      out.push(next);
      prev = next;
    }
  }
  return out;
}

/**
 * OR1: whether `text`, posted to `service`, carries a broadcast mention (see the table above).
 * Pure; `true` also when the text does not settle within `NORMALISE_MAX_ROUNDS` rounds
 * (`text-normalise.ts`).
 */
export function broadcastMentionIn(
  service: BroadcastService,
  text: string,
  opts: { readonly html: boolean },
): boolean {
  // The text as sent, too: NFKC can turn a name-ending character (a fullwidth letter) into a
  // name character, so `@all` + U+FF58 folds to `@allx` while a parser may still read `@all`.
  const forms: string[] = [text.toLowerCase()];
  for (const invisible of ["", " "]) {
    const settled = settle(text, invisible);
    if (settled === undefined) return true;
    forms.push(settled);
    if (opts.html) forms.push(...tagStrippedForms(settled));
  }
  const rules = BROADCAST_RULES[service];
  return forms.some((f) => rules.some((re) => re.test(f)));
}

/** One scanned input key; `required: false` skips it when absent, `undefined` or `null`. */
interface ScannedKey {
  readonly key: string;
  readonly required: boolean;
}

const REQUIRED = (key: string): ScannedKey => ({ key, required: true });
const OPTIONAL = (key: string): ScannedKey => ({ key, required: false });

/**
 * Whether any of `keys` must be refused: a string value `refuses` matches, a required key that is
 * missing or not a string, or an optional key present with a non-string value.
 */
function refusesKeys(
  input: Readonly<Record<string, unknown>>,
  keys: readonly ScannedKey[],
  refuses: (text: string) => boolean,
): boolean {
  return keys.some((k) => {
    const v = Object.hasOwn(input, k.key) ? input[k.key] : undefined;
    if (typeof v === "string") return refuses(v);
    return k.required || (v !== undefined && v !== null);
  });
}

interface BroadcastScan {
  readonly service: BroadcastService;
  /** The input keys holding the message, comment or issue text. */
  readonly keys: readonly ScannedKey[];
  /** Whether the input marks the text as HTML. */
  readonly htmlWhen?: (input: Readonly<Record<string, unknown>>) => boolean;
}

/**
 * B3w W4: whether a body is HTML, read from the row's own `contentType`: `true` unless it is
 * absent or exactly `"text"` (fail closed: `"HTML"`, `null`, `42` or `""` all count as HTML).
 * Used by the broadcast scan's Teams rows (which then also match the tag-stripped forms) and by
 * the remote-content formats of the Outlook draft and send and both Teams posts.
 */
function htmlUnlessText(input: Readonly<Record<string, unknown>>): boolean {
  const contentType = Object.hasOwn(input, "contentType") ? input["contentType"] : undefined;
  return contentType !== undefined && contentType !== "text";
}

/**
 * The rows whose text the broadcast rule scans, and which fields: the messaging posts, the issue,
 * pull request and merge request comments and creates (titles included) and, since C2, the pull
 * request and merge request updates.
 */
const BROADCAST_SCANNED: Readonly<Record<string, BroadcastScan>> = {
  slack_message_post: { service: "slack", keys: [REQUIRED("text")] },
  slack_message_post_dm: { service: "slack", keys: [REQUIRED("text")] },
  teams_message_post: { service: "teams", keys: [REQUIRED("body")], htmlWhen: htmlUnlessText },
  teams_message_post_chat: { service: "teams", keys: [REQUIRED("body")], htmlWhen: htmlUnlessText },
  github_issue_comment_create: { service: "github", keys: [REQUIRED("body")] },
  gitlab_issue_note_create: { service: "gitlab", keys: [REQUIRED("body")] },
  gitlab_mr_note_create: { service: "gitlab", keys: [REQUIRED("body")] },
  // B2: the issue creates (title always, the body or description when set).
  github_issue_create: { service: "github", keys: [REQUIRED("title"), OPTIONAL("body")] },
  gitlab_issue_create: { service: "gitlab", keys: [REQUIRED("title"), OPTIONAL("description")] },
  // C2: the pull request and merge request creates (title required) and updates (every key
  // optional: an update may leave the title or the text alone). Branch names and refs are not
  // scanned: a ref cannot notify.
  github_pr_create: { service: "github", keys: [REQUIRED("title"), OPTIONAL("body")] },
  github_pr_update: { service: "github", keys: [OPTIONAL("title"), OPTIONAL("body")] },
  gitlab_mr_create: { service: "gitlab", keys: [REQUIRED("title"), OPTIONAL("description")] },
  gitlab_mr_update: { service: "gitlab", keys: [OPTIONAL("title"), OPTIONAL("description")] },
};

/**
 * The input keys the broadcast rule scans for `toolId` (empty for a row it does not scan).
 * Read-only; the completeness tripwire reads it so a new GitHub or GitLab text field cannot be
 * offered unscanned.
 */
export function scannedTextKeys(toolId: string): readonly string[] {
  return ownLookup(BROADCAST_SCANNED, toolId)?.keys.map((k) => k.key) ?? [];
}

/** OR1 for one row: a scanned field carries a broadcast mention (a non-string one is refused). */
function refusesBroadcast(toolId: string, input: Readonly<Record<string, unknown>>): boolean {
  const scan = ownLookup(BROADCAST_SCANNED, toolId);
  if (scan === undefined) return false;
  const html = scan.htmlWhen?.(input) ?? false;
  return refusesKeys(input, scan.keys, (text) => broadcastMentionIn(scan.service, text, { html }));
}

// ---------------------------------------------------------------------------------------------
// GitLab quick actions (coordinator ruling 2026-11-05, recorded for the owner): GitLab runs
// `/close`, `/merge`, `/approve`, `/assign @x` and the rest from a note body and from an issue's
// description at create, so model-written GitLab text could change the issue or merge request's
// state. Scanned (ruling R-QA, 2026-11-05): a note `body`, an issue create's `description` and (C2) a
// merge request create's or update's `description`, the fields GitLab parses for quick actions; NOT the title, which GitLab does not parse (a title such
// as `/api is down` is allowed). A scanned field is refused when any line of it, normalised as for
// broadcast mentions but keeping its line breaks (both the deleted and the spaced form), begins
// with optional whitespace, then `/`, then a letter. A fenced code block does NOT exempt it (fail
// closed). `and/or` or a URL mid-line is not a quick action.
// ---------------------------------------------------------------------------------------------

const QUICK_ACTION_LINE = /^\s*\/[a-z]/;

/** Whether a GitLab note body carries a quick-action line (or does not settle: refused). */
export function gitlabQuickActionIn(text: string): boolean {
  for (const invisible of ["", " "]) {
    const settled = settle(text, invisible, true);
    if (settled === undefined) return true;
    if (settled.split("\n").some((line) => QUICK_ACTION_LINE.test(line))) return true;
  }
  return false;
}

/** The GitLab rows whose text GitLab parses for quick actions, and which fields. */
const GITLAB_QUICK_ACTION_ROWS: Readonly<Record<string, readonly ScannedKey[]>> = {
  gitlab_issue_note_create: [REQUIRED("body")],
  gitlab_mr_note_create: [REQUIRED("body")],
  gitlab_issue_create: [OPTIONAL("description")],
  // C2: GitLab parses a merge request description for quick actions at create and at edit.
  gitlab_mr_create: [OPTIONAL("description")],
  gitlab_mr_update: [OPTIONAL("description")],
};

/** The input keys the quick-action rule scans for `toolId` (read-only, for its tripwire). */
export function quickActionTextKeys(toolId: string): readonly string[] {
  return ownLookup(GITLAB_QUICK_ACTION_ROWS, toolId)?.map((k) => k.key) ?? [];
}

/** GitLab text that runs a quick action (a non-string scanned value is refused). */
function refusesGitlabQuickAction(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): boolean {
  const keys = ownLookup(GITLAB_QUICK_ACTION_ROWS, toolId);
  if (keys === undefined) return false;
  return refusesKeys(input, keys, gitlabQuickActionIn);
}

// ---------------------------------------------------------------------------------------------
// GitLab scoped labels (owner ruling OR-B2-2): applying `key::value` REMOVES the issue's existing
// label with the same key, so "add" would not be add-only. A label is refused when its text,
// normalised as for broadcast mentions (NFKC folds the fullwidth colon U+FF1A to `:`; both the
// deleted and the spaced invisible forms), contains `::`. Checked on `gitlab_issue_labels_add` and
// `gitlab_issue_create` `labels`; a present value that is not an array of strings is refused, an
// unset optional one skipped. Both doors (it runs inside `messagingDestinationRefusal`).
// ---------------------------------------------------------------------------------------------

/** Whether one GitLab label is (or normalises to) a scoped label, or does not settle. */
export function gitlabScopedLabelIn(label: string): boolean {
  if (label.includes("::")) return true;
  for (const invisible of ["", " "]) {
    const settled = settle(label, invisible);
    if (settled === undefined || settled.includes("::")) return true;
  }
  return false;
}

/** The GitLab rows whose `labels` the scoped-label rule checks. */
const GITLAB_LABEL_ROWS: Readonly<Record<string, ScannedKey>> = {
  gitlab_issue_labels_add: REQUIRED("labels"),
  gitlab_issue_create: OPTIONAL("labels"),
};

/** The input key the scoped-label rule checks for `toolId` (read-only, for its tripwire). */
export function scopedLabelKeys(toolId: string): readonly string[] {
  const k = ownLookup(GITLAB_LABEL_ROWS, toolId);
  return k === undefined ? [] : [k.key];
}

/** A GitLab label list carrying a scoped label, or one that is not an array of strings. */
function refusesGitlabScopedLabel(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): boolean {
  const k = ownLookup(GITLAB_LABEL_ROWS, toolId);
  if (k === undefined) return false;
  const v = Object.hasOwn(input, k.key) ? input[k.key] : undefined;
  if (!k.required && (v === undefined || v === null)) return false;
  if (!Array.isArray(v)) return true;
  return (v as unknown[]).some((l) => typeof l !== "string" || gitlabScopedLabelIn(l));
}

// ---------------------------------------------------------------------------------------------
// Calendar event creates (B4a, plan R6 and review fix 1; owner ruling OR-B4-6): fail closed on what
// the preview cannot show honestly. Both doors (it runs inside `messagingDestinationRefusal`).
//
//  - Times. An Outlook `startDateTime` / `endDateTime` must be a string `YYYY-MM-DDTHH:MM[:SS[.f]]`
//    (at most 7 fraction digits) with NO offset and no `Z`, so the preview's `Time zone` line (the
//    `timeZone` input, "UTC" when unset) is the only zone and is the one Graph applies. An iCloud
//    `start` / `end` must be `YYYYMMDDTHHMMSSZ` (UTC): the connector emits `DTSTART`/`DTEND`
//    verbatim, a floating time is each attendee's own local time (no one zone to show), and 0.4.0
//    emits a date-only value without `VALUE=DATE` (malformed iCalendar). So all-day and floating
//    iCloud events cannot be created by the model or over MCP (stated). The patterns are ASCII
//    only (`\d` without the `u` flag matches 0-9 alone; fullwidth digits are refused) and anchored
//    without the `m` flag, so no line break or control character passes.
//  - iCloud text. The connector emits `UID` verbatim and its `escapeText` leaves a bare CR, so a
//    `summary`, `description`, `location`, `calendar` or `uid` carrying a C0 control (CR, LF and
//    TAB included), DEL or a C1 control could add an `ATTENDEE:` line the owner reads as part of a
//    field (a hidden invitee): refused. `uid` must also match `^[A-Za-z0-9._@-]{1,200}$`. Each
//    `attendees` entry (one `ATTENDEE:mailto:` line each) is refused when it is not a string, is
//    empty, or holds any whitespace or such a control; a present `attendees` that is not an array
//    is refused. A present key with a non-string value (`null` included: it is a change, not
//    "unset") is refused. These checks REJECT; nothing is stripped or rewritten.
//  - Attendee count and outside domains: not bounded (owner ruling OR-B4-2); every attendee is
//    shown in full. A non-control character such as U+202E reaches the prompt escaped by the
//    preview's sanitiser.
// Order: the time checks first, then the text checks. Both texts are fixed and echo nothing.
// ---------------------------------------------------------------------------------------------

export const CALENDAR_TIME_REFUSAL =
  "the model must give an event time in the stated form so its time zone is shown: Outlook YYYY-MM-DDTHH:MM[:SS] with timeZone, iCloud YYYYMMDDTHHMMSSZ (UTC)";
export const CALENDAR_TEXT_REFUSAL =
  "an iCloud event's title, description, location, calendar, id or attendees cannot contain a line break or control character, and an attendee cannot contain a space";

const OUTLOOK_CALENDAR_ROW = "outlook_calendar_create";
const APPLE_CALENDAR_ROW = "apple_calendar_event_create";

// The shapes capture year, month, day, hour, minute and (optional for Outlook) second, so the
// value is also checked to be a real calendar date and clock time (`isRealDateTime`).
const OUTLOOK_EVENT_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?$/;
const APPLE_EVENT_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Whether the captured parts name a real date and time: month 1-12, a day that exists in that
 * month and year (leap years included), hour 0-23, minute and second 0-59. The date is built with
 * `setUTCFullYear`, never `Date.UTC`, which maps years 0-99 to 1900-1999.
 */
function isRealDateTime(m: RegExpExecArray): boolean {
  // An absent group (Outlook's optional seconds) reads as 0.
  const part = (i: number): number => Number(m[i] ?? "0");
  if (part(4) > 23 || part(5) > 59 || part(6) > 59) return false;
  const [y, mo, d] = [part(1), part(2), part(3)];
  // A month outside 1-12 or a day the month does not have rolls over to another date, so the
  // round trip below refuses it.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const APPLE_UID = /^[A-Za-z0-9._@-]{1,200}$/;

/** The time keys of each calendar row and the one form each must take. */
const CALENDAR_TIME_KEYS: Readonly<Record<string, { keys: readonly string[]; form: RegExp }>> = {
  [OUTLOOK_CALENDAR_ROW]: { keys: ["startDateTime", "endDateTime"], form: OUTLOOK_EVENT_TIME },
  [APPLE_CALENDAR_ROW]: { keys: ["start", "end"], form: APPLE_EVENT_TIME },
};

/** The iCloud text keys whose value is emitted into the VEVENT. */
const APPLE_CALENDAR_TEXT_KEYS: readonly string[] = [
  "summary",
  "description",
  "location",
  "calendar",
  "uid",
];

/**
 * Whether `value`, as the calendar row `toolId`'s time key `key`, is in the one form that shows
 * its zone (a string matching that row's pattern) and names a real date and time. `false` for a
 * key that is not a time key of a calendar row, so a caller can never read "explicit" for an
 * unknown input.
 */
export function calendarTimeIsExplicit(toolId: string, key: string, value: unknown): boolean {
  const spec = ownLookup(CALENDAR_TIME_KEYS, toolId);
  if (!spec?.keys.includes(key)) return false;
  if (typeof value !== "string") return false;
  const m = spec.form.exec(value);
  return m !== null && isRealDateTime(m);
}

/** A C0 control (U+0000-U+001F, so CR, LF and TAB too), DEL or a C1 control (U+0080-U+009F). */
function hasControl(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

/** One iCloud attendee entry: a non-empty string with no whitespace and no control character. */
function appleAttendeeRefused(entry: unknown): boolean {
  return typeof entry !== "string" || entry === "" || /\s/.test(entry) || hasControl(entry);
}

/** The iCloud text and attendee checks: `true` refuses. */
function appleCalendarTextRefused(input: Readonly<Record<string, unknown>>): boolean {
  const own = (k: string): unknown => (Object.hasOwn(input, k) ? input[k] : undefined);
  for (const k of APPLE_CALENDAR_TEXT_KEYS) {
    const v = own(k);
    if (v === undefined) continue;
    if (typeof v !== "string" || hasControl(v)) return true;
    if (k === "uid" && !APPLE_UID.test(v)) return true;
  }
  const attendees = own("attendees");
  if (attendees === undefined) return false;
  if (!Array.isArray(attendees)) return true;
  return (attendees as unknown[]).some(appleAttendeeRefused);
}

/** R6: the calendar refusal for one row (`undefined` for every other row, or when allowed). */
function calendarRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const spec = ownLookup(CALENDAR_TIME_KEYS, toolId);
  if (spec === undefined) return undefined;
  const timesShown = spec.keys.every((k) =>
    calendarTimeIsExplicit(toolId, k, Object.hasOwn(input, k) ? input[k] : undefined),
  );
  if (!timesShown) return CALENDAR_TIME_REFUSAL;
  if (toolId === APPLE_CALENDAR_ROW && appleCalendarTextRefused(input)) {
    return CALENDAR_TEXT_REFUSAL;
  }
  return undefined;
}

// Null optional fields on the B4a rows (coordinator rulings 2026-11-05): an optional input key
// that is present but `null` is refused on both doors. The preview renders `null` as the field's
// unset default (`UTC`, `(not set: no one is invited)`, `(not set: the root of My Drive)`, ...)
// while the connector's schema rejects `null`, so the preview would claim what will not happen.
// The keys are the optional (`whenUnset`) schema keys of each row; the text names the key (from
// this table, never from the input) and echoes no value. Runs before the calendar checks, so a
// null iCloud field reports this text rather than the iCloud text refusal.

/** The fixed refusal for a present-but-null optional field `key` (a schema key, never a value). */
export function nullOptionalFieldRefusal(key: string): string {
  return `the field \`${key}\` cannot be null; omit it or give a value`;
}

/** The optional input keys of each B4a row, the Flagsmith state set (C3) and three D3b rows, whose `null` the doors refuse. */
const NULL_REFUSED_OPTIONAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  [OUTLOOK_CALENDAR_ROW]: ["timeZone", "attendees", "body"],
  [APPLE_CALENDAR_ROW]: ["calendar", "attendees", "location", "description", "uid"],
  gdrive_file_create: ["mimeType", "parentId", "content"],
  flagsmith_feature_state_set: ["value"],
  // D3b: the optional keys of the deploy and mobile-release rows.
  vercel_deployment_redeploy: ["withLatestCommit"],
  netlify_build_trigger: ["branch", "production", "clearCache"],
  firebase_app_distribution_distribute: ["groupAliases", "testerEmails"],
};

/** The optional keys whose `null` is refused for `toolId` (read-only, for its drift test). */
export function nullRefusedOptionalKeys(toolId: string): readonly string[] {
  return ownLookup(NULL_REFUSED_OPTIONAL_KEYS, toolId) ?? [];
}

/** The null-field check (`undefined` for every other row, or when no listed key is null). */
function nullOptionalFieldCheck(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const key = nullRefusedOptionalKeys(toolId).find(
    (k) => Object.hasOwn(input, k) && input[k] === null,
  );
  return key === undefined ? undefined : nullOptionalFieldRefusal(key);
}

// ---------------------------------------------------------------------------------------------
// Remote content in model-written bodies (Phase 9.7 PRs B3r and B3w; owner rulings OR-B3-2,
// OR-B3r-1..4 and OR-B3w-1..3, and the coordinator's rulings on the reviews). A body that would
// load remote content when someone opens it (an external image, embed, frame, stylesheet,
// refresh or base URL) is refused on both doors with one fixed text that echoes nothing. Plain
// links stay allowed and are shown verbatim. The detectors are structural scans
// (`remote-content.ts`: a markup tokenizer, `JSON.parse` and a walk, a fixed `![` rule); they
// never strip or rewrite. Anything that does not tokenize, parse or settle is refused, and a
// throw inside the rule refuses too (fail closed, on the act door as well).
//
// Scanned rows and fields (derived from the 0.5.0 connector source; pinned by
// `remote-content.sync.test.ts`):
//  - `outlook_draft_create` `body`, as Outlook HTML when `contentType` is present and not exactly
//    `"text"` (the connector sends `HTML` only for `"html"`; anything else present scans, fail
//    closed);
//  - `confluence_page_create`, `_update`, `_append` and `confluence_comment_add` `storageHtml`;
//  - `notion_block_append` `childrenJson` and `notion_page_update` `propertiesJson`;
//  - `obsidian_append_to_daily_note` `content` (Markdown, Mermaid fences included);
//  - `gdrive_file_create` `content` (OPTIONAL: unset or `""` makes an empty file and is not
//    scanned), when its `mimeType` is markup or its `name` ends in a markup extension
//    (`driveContentFormats`), and as Markdown for a `.md` name, whatever its type;
//  - (B3w) `outlook_mail_send` `body`, as Outlook HTML on the same rule as the draft (the model is
//    never offered sends, owner ruling OR-B3w-1; the act door scans its proposals);
//  - (B3w) `teams_message_post` and `teams_message_post_chat` `body`, as Teams HTML unless
//    `contentType` is absent or exactly `"text"`;
//  - (B3w) forge Markdown: `github_issue_comment_create` `body`, `github_issue_create` `body`
//    (optional), `gitlab_issue_note_create` and `gitlab_mr_note_create` `body`,
//    `gitlab_issue_create` `description` (optional), (C2) `github_pr_create` and `github_pr_update`
//    `body` and `gitlab_mr_create` and `gitlab_mr_update` `description` (all optional), and Linear's `linear_comment_create` `body`
//    and `linear_issue_create` / `linear_issue_update` `description` (optional).
// Not scanned (re-checked against 0.5.0): the Gmail, Fastmail, IMAP, ProtonMail and iCloud sends
// (text/plain), `gmail_draft_send` (a draft id only), Slack (the connector sends `text` only, no
// blocks; mrkdwn has no inline image), Discord (`content` only, no embeds), Jira (one plain ADF
// text node), plain-text bodies (Gmail and iCloud drafts, an Outlook draft or send sent as Text,
// every calendar body), titles and recipients, the Notion page create and comment text, a Drive
// file of a clean non-markup type and name, and before-state replies (never sent). The owner's own doors (ChatOps,
// tribal, workflows, `nimbus connector call`) do not run this rule (stated: OR-B3-2 names
// model-written content).
// ---------------------------------------------------------------------------------------------

export const REMOTE_CONTENT_REFUSAL =
  "the model cannot write a message, email, comment, draft, page, note or file that loads remote content (an external image, embed, frame or stylesheet) when it is opened; use a plain link instead";

/**
 * One scanned row: the field holding the body, and every format it is read as (none: not
 * scanned). The body is refused when ANY of them refuses.
 */
interface RemoteContentScan {
  readonly key: ScannedKey;
  readonly formats: (input: Readonly<Record<string, unknown>>) => readonly RemoteContentFormat[];
}

function own(input: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(input, key) ? input[key] : undefined;
}

/**
 * Rows 1, 10, 11 and 12: `format` unless `contentType` is absent or exactly `"text"` (W4; the
 * connectors send HTML only for `"html"`, so anything else present scans, fail closed).
 */
function htmlFormatsUnlessText(
  format: "outlook-html" | "teams-html",
): (input: Readonly<Record<string, unknown>>) => readonly RemoteContentFormat[] {
  return (input) => (htmlUnlessText(input) ? [format] : []);
}

/**
 * Row 9: the Drive create, by `mimeType` (R11) AND by `name` extension (coordinator rulings): every
 * scan either calls for, so a markup type does not hide a `.md` name.
 */
export function driveMarkupFormats(
  input: Readonly<Record<string, unknown>>,
): readonly RemoteContentFormat[] {
  return driveContentFormats(own(input, "mimeType"), own(input, "name"));
}

const always = (format: RemoteContentFormat) => (): readonly RemoteContentFormat[] => [format];

/** The rows whose body the remote-content rule scans, the field and its format. */
const REMOTE_CONTENT_SCANNED: Readonly<Record<string, RemoteContentScan>> = {
  outlook_draft_create: { key: REQUIRED("body"), formats: htmlFormatsUnlessText("outlook-html") },
  confluence_page_create: { key: REQUIRED("storageHtml"), formats: always("confluence-storage") },
  confluence_page_update: { key: REQUIRED("storageHtml"), formats: always("confluence-storage") },
  confluence_page_append: { key: REQUIRED("storageHtml"), formats: always("confluence-storage") },
  confluence_comment_add: { key: REQUIRED("storageHtml"), formats: always("confluence-storage") },
  notion_block_append: { key: REQUIRED("childrenJson"), formats: always("notion-blocks") },
  notion_page_update: { key: REQUIRED("propertiesJson"), formats: always("notion-properties") },
  obsidian_append_to_daily_note: { key: REQUIRED("content"), formats: always("obsidian-markdown") },
  gdrive_file_create: { key: OPTIONAL("content"), formats: driveMarkupFormats },
  // B3w (owner ruling OR-B3r-3): sent Outlook mail, Teams HTML, and GitHub, GitLab and (owner
  // ruling OR-B3w-2) Linear Markdown.
  outlook_mail_send: { key: REQUIRED("body"), formats: htmlFormatsUnlessText("outlook-html") },
  teams_message_post: { key: REQUIRED("body"), formats: htmlFormatsUnlessText("teams-html") },
  teams_message_post_chat: { key: REQUIRED("body"), formats: htmlFormatsUnlessText("teams-html") },
  github_issue_comment_create: { key: REQUIRED("body"), formats: always("forge-markdown") },
  github_issue_create: { key: OPTIONAL("body"), formats: always("forge-markdown") },
  gitlab_issue_note_create: { key: REQUIRED("body"), formats: always("forge-markdown") },
  gitlab_mr_note_create: { key: REQUIRED("body"), formats: always("forge-markdown") },
  gitlab_issue_create: { key: OPTIONAL("description"), formats: always("forge-markdown") },
  // C2: pull request body and merge request description (titles are plain text, not scanned).
  github_pr_create: { key: OPTIONAL("body"), formats: always("forge-markdown") },
  github_pr_update: { key: OPTIONAL("body"), formats: always("forge-markdown") },
  gitlab_mr_create: { key: OPTIONAL("description"), formats: always("forge-markdown") },
  gitlab_mr_update: { key: OPTIONAL("description"), formats: always("forge-markdown") },
  linear_comment_create: { key: REQUIRED("body"), formats: always("forge-markdown") },
  linear_issue_create: { key: OPTIONAL("description"), formats: always("forge-markdown") },
  linear_issue_update: { key: OPTIONAL("description"), formats: always("forge-markdown") },
};

/** The rows the remote-content rule scans (read-only, for its completeness tripwire). */
export function remoteContentScannedRows(): readonly string[] {
  return Object.keys(REMOTE_CONTENT_SCANNED);
}

/** The input key the remote-content rule scans for `toolId` (read-only, for its tripwire). */
export function remoteContentScannedKeys(toolId: string): readonly string[] {
  const scan = ownLookup(REMOTE_CONTENT_SCANNED, toolId);
  return scan === undefined ? [] : [scan.key.key];
}

/**
 * The remote-content check for one row: {@link REMOTE_CONTENT_REFUSAL} or `undefined`. A required
 * key absent or not a string is refused; an optional key absent, `undefined` or `null` is skipped
 * (`null` is then refused by the null-field check) and `""` is skipped (an empty file). Any throw
 * (a hostile getter, a detector bug) refuses.
 */
function remoteContentRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const scan = ownLookup(REMOTE_CONTENT_SCANNED, toolId);
  if (scan === undefined) return undefined;
  try {
    const formats = scan.formats(input);
    if (formats.length === 0) return undefined;
    const refused = refusesKeys(
      input,
      [scan.key],
      (text) =>
        !(text === "" && !scan.key.required) &&
        formats.some((format) => remoteContentIn(format, text)),
    );
    return refused ? REMOTE_CONTENT_REFUSAL : undefined;
  } catch {
    return REMOTE_CONTENT_REFUSAL;
  }
}

/** F3: the ChatOps-channel check for a ChatOps-platform row; `undefined` for any other row. */
function chatopsRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  chatops: ChatopsPolicy | undefined,
): string | undefined {
  if (toolId === SLACK_DM_ROW) {
    if (chatops === undefined) return CHATOPS_CHANNEL_REFUSAL;
    return refusesSlackDm(chatops) ? CHATOPS_CHANNEL_REFUSAL : undefined;
  }
  const post = ownLookup(CHATOPS_POST_ROWS, toolId);
  if (post === undefined) return undefined;
  // No readable policy: the ChatOps channels cannot be ruled out.
  if (chatops === undefined) return CHATOPS_CHANNEL_REFUSAL;
  const dest = Object.hasOwn(input, post.key) ? input[post.key] : undefined;
  return refusesChatopsPost(chatops, post.platform, dest) ? CHATOPS_CHANNEL_REFUSAL : undefined;
}

/**
 * The ONE messaging-destination check both doors call (OR1 + OR2, and B2's OR-B2-2): the ChatOps
 * channel first (so a post to a ChatOps channel that also carries a mention reports the ChatOps
 * reason), then the broadcast mention, then a GitLab quick action, then a GitLab scoped label,
 * then (B3r, B3w) remote content in a draft, page, note, markup file, sent Outlook mail, Teams
 * HTML message, or GitHub, GitLab or Linear Markdown body, then (B4a) the null
 * optional-field check of the calendar and Drive creates, then the calendar checks (time before
 * text). It covers message and comment text, (B2) issue titles, bodies and descriptions, (B3r)
 * the bodies of drafts, pages, notes and Drive markup files, (B3w) sent Outlook mail, Teams HTML
 * and forge Markdown, and (B4a) calendar event times,
 * iCloud event text and attendees, and null optional fields. A fixed text that echoes nothing of
 * the input, or `undefined`.
 */
export function messagingDestinationRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  ctx: { readonly chatops: ChatopsPolicy | undefined },
): string | undefined {
  const chatops = chatopsRefusal(toolId, input, ctx.chatops);
  if (chatops !== undefined) return chatops;
  if (refusesBroadcast(toolId, input)) return BROADCAST_MENTION_REFUSAL;
  if (refusesGitlabQuickAction(toolId, input)) return GITLAB_QUICK_ACTION_REFUSAL;
  if (refusesGitlabScopedLabel(toolId, input)) return GITLAB_SCOPED_LABEL_REFUSAL;
  const remote = remoteContentRefusal(toolId, input);
  if (remote !== undefined) return remote;
  return nullOptionalFieldCheck(toolId, input) ?? calendarRefusal(toolId, input);
}

/**
 * OR-B3-3 on the act door (R12): it runs no before-read, so it cannot tell a KB child from any
 * other page; while a KB destination is configured for that service (or the config is
 * unreadable), these update and append rows are refused over MCP (fail closed). Fixed text.
 */
export const ACT_DOOR_KB_CHILD_REFUSAL =
  "an MCP proposal cannot update or append to a Notion or Confluence page while a Nimbus knowledge base is configured there: the act door cannot check whether the page is in it";

/** The page update/append rows the act door refuses while their service's KB is configured. */
const NOTION_KB_CHILD_ROWS: ReadonlySet<string> = new Set([
  "notion_page_update",
  "notion_block_append",
]);
const CONFLUENCE_KB_CHILD_ROWS: ReadonlySet<string> = new Set([
  "confluence_page_update",
  "confluence_page_append",
]);

/** What the act door's refusal reads: the ChatOps bindings and the KB destinations. */
export interface ActDoorRefusalContext {
  readonly chatops: ChatopsPolicy | undefined;
  readonly kb: TribalKbConfig | undefined;
  /** The KB config could not be read: every KB-capable row is refused (fail closed). */
  readonly kbUnreadable: boolean;
}

/** OR-B2-3 on the act door: a Linear update that sets `assigneeId` (anything but `undefined`). */
function linearAssigneeRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (toolId !== LINEAR_ISSUE_UPDATE_ROW) return undefined;
  const assignee = Object.hasOwn(input, "assigneeId") ? input["assigneeId"] : undefined;
  return assignee === undefined ? undefined : LINEAR_ASSIGNEE_REFUSAL;
}

/** R12: a page update or append while its service's KB destination is configured. */
function actDoorKbChildRefusal(toolId: string, kb: TribalKbConfig | undefined): string | undefined {
  const notion = NOTION_KB_CHILD_ROWS.has(toolId) && kb?.notion !== undefined;
  const confluence = CONFLUENCE_KB_CHILD_ROWS.has(toolId) && kb?.confluence !== undefined;
  return notion || confluence ? ACT_DOOR_KB_CHILD_REFUSAL : undefined;
}

/**
 * The MCP act door's ONE refusal (`ipc/capture-rpc.ts` `createActionDestinationRefusal`), in
 * order: the messaging check; the Linear reassignment rule (OR-B2-3: the act door runs no
 * before-read (B0b), so it cannot prove a Linear issue unassigned, and a `linear_issue_update`
 * that sets `assigneeId`, `null` included, is refused); the KB-target check the model door also
 * runs (OR-B3-1; an unreadable KB config refuses every KB-capable row); then the KB-child rule
 * (R12). The model door does NOT call this: there the readers' guards decide from the current
 * state.
 */
export function actDoorRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  ctx: ActDoorRefusalContext,
): string | undefined {
  const messaging = messagingDestinationRefusal(toolId, input, { chatops: ctx.chatops });
  if (messaging !== undefined) return messaging;
  const linear = linearAssigneeRefusal(toolId, input);
  if (linear !== undefined) return linear;
  if (ctx.kbUnreadable) {
    return isKnowledgeBaseCapableRow(toolId) ? KNOWLEDGE_BASE_REFUSAL : undefined;
  }
  return knowledgeBaseRefusal(toolId, input, ctx.kb) ?? actDoorKbChildRefusal(toolId, ctx.kb);
}

/**
 * F4 / I25: the KB-target refusal, the ONE implementation both doors call
 * (`modelWriteRefusal`, `actDoorRefusal`): {@link KNOWLEDGE_BASE_REFUSAL} when a KB-capable key of
 * `toolId` names (or cannot be proven distinct from) the configured KB destination; `undefined`
 * when no KB is configured.
 */
function knowledgeBaseRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  kb: TribalKbConfig | undefined,
): string | undefined {
  if (kb === undefined) return undefined;
  if (refusesNotion(toolId, input, kb) || refusesConfluence(toolId, input, kb)) {
    return KNOWLEDGE_BASE_REFUSAL;
  }
  return undefined;
}

/**
 * The fixed refusal for a MODEL write to `toolId` with `input`, or `undefined` to allow it: the
 * messaging check, then the knowledge-base target check. (A page update or append under the KB is
 * refused later, by its reader's KB-child guard, from the page's current parent.)
 */
export function modelWriteRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  ctx: RefusalContext,
): string | undefined {
  const messaging = messagingDestinationRefusal(toolId, input, { chatops: ctx.chatops });
  if (messaging !== undefined) return messaging;
  // D1c (owner ruling 1): a commit touching a CI, workflow, hook or review-rule file, or carrying
  // credential-looking text. MODEL door only: the owner's own doors are not restricted, and the
  // act door never proposes a commit.
  const commit = commitModelRefusal(toolId, input);
  if (commit !== undefined) return commit;
  // D2: a CloudFormation deploy asking for an IAM capability. MODEL door only.
  const iac = iacModelRefusal(toolId, input);
  if (iac !== undefined) return iac;
  // D3a (OR-D3-6): RBAC kinds and privileged or host-access settings in a model-written manifest.
  // MODEL door only.
  if (toolId === "k8s_manifest_apply") {
    const k8s = k8sModelRefusal(input);
    if (k8s !== undefined) return k8s;
  }
  // D3b (OR-D3-1..3): a Netlify build with neither or both of branch and production, and a
  // Firebase distribute to tester emails. MODEL door only.
  const deploy = deployModelRefusal(toolId, input);
  if (deploy !== undefined) return deploy;
  return knowledgeBaseRefusal(toolId, input, ctx.kb);
}
