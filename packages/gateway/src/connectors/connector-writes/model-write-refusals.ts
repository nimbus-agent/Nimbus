// packages/gateway/src/connectors/connector-writes/model-write-refusals.ts
// The door's destination refusals for the model's connector writes (Phase 9.7 B, rulings F3/F4 and
// the owner's 2026-11-05 rulings OR1/OR2): the model may not post to a channel Nimbus ChatOps
// listens on, may not post a message or comment that notifies a whole channel, group or team (a
// broadcast mention), and may not write to the Nimbus knowledge base (the tribal-capture
// destination; its own gate is the only writer, I25). Pure: the ChatOps bindings and the KB config
// are passed in, and nothing here reaches the network, so a destination that cannot be PROVEN
// distinct from a configured one is refused (fail closed).
//
// `messagingDestinationRefusal` (ChatOps + broadcast) is the ONE function both the model door and
// the MCP act door call; the KB refusal is model-door-only (`modelWriteRefusal`).
//
// This module names only model-offerable write rows; the gate-confined post and KB tools stay
// named only inside their own gates (D17/D19).
import type { ChatopsPolicy } from "../../policy/types.ts";
import { FORMAT_INVISIBLE_RANGES } from "../../util/invisible-text.ts";

export const CHATOPS_CHANNEL_REFUSAL =
  "the model cannot post to a channel Nimbus ChatOps listens on";
export const KNOWLEDGE_BASE_REFUSAL =
  "the model cannot write to the Nimbus knowledge base; use the capture flow";
export const BROADCAST_MENTION_REFUSAL =
  "the model cannot post a message that notifies a whole channel, group or team; rephrase without the broadcast mention";

/** The `[tribal]` knowledge-base destinations (`config/nimbus-toml.ts` `NimbusTribalToml`). */
export interface TribalKbConfig {
  readonly notion?: { readonly databaseId: string };
  readonly confluence?: { readonly spaceKey: string; readonly parentPageId: string };
}

type Platform = "slack" | "teams";

/** Which input key names the destination of each ChatOps-platform post row. */
const CHATOPS_POST_ROWS: Readonly<Record<string, { platform: Platform; key: string }>> = {
  slack_message_post: { platform: "slack", key: "channel" },
  teams_message_post: { platform: "teams", key: "channelId" },
  teams_message_post_chat: { platform: "teams", key: "chatId" },
};

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
};

function ownLookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** A character that renders as nothing (`util/invisible-text.ts`) or a C0/C1 control. */
function isInvisibleOrControl(cp: number): boolean {
  return cp <= 0x1f || FORMAT_INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** `s` with every invisible or control character replaced by `replacement`. */
function replaceInvisible(s: string, replacement: string): string {
  let out = "";
  for (const ch of s) out += isInvisibleOrControl(ch.codePointAt(0) ?? 0) ? replacement : ch;
  return out;
}

/** NFKC (fullwidth forms fold to ASCII), then every invisible or control character deleted. */
function foldAndStrip(s: string): string {
  return replaceInvisible(s.normalize("NFKC"), "");
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
function canonicalNotionId(s: string): string {
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

const CANONICAL_PAGE_ID = /^[1-9][0-9]*$/;

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
//  1. In a loop until the text is stable (at most BROADCAST_MAX_ROUNDS rounds; still changing
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
//  - GitHub `body`: a team, `@org/team`. Bound: a bare `@name` is a user or an organisation and is
//    not caught (an organisation mention notifies no members); a team can only be named in the
//    slash form.
//  - GitLab `body`: `@all`, and any slash path `@group/sub[/...]` (a subgroup or project, never a
//    user). Bound: `@<top-level-group>` notifies every member but cannot be told from
//    `@<username>` without a lookup (they share one namespace), so it is NOT caught.
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
// exist), Linear, Notion and Confluence (no broadcast mention form in their comment APIs as this
// connector calls them).
// ---------------------------------------------------------------------------------------------

export type BroadcastService = "slack" | "teams" | "github" | "gitlab";

/** The rounds of fold + strip + decode before the text must be stable. */
const BROADCAST_MAX_ROUNDS = 4;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: String.fromCodePoint(0xa0),
};

const ENTITY = /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));?/gi;

/** One pass of HTML entity decoding; an unknown name or an invalid code point is left as is. */
function decodeEntitiesOnce(s: string): string {
  return s.replace(ENTITY, (m: string, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return ownLookup(NAMED_ENTITIES, name.toLowerCase()) ?? m;
    const cp = hex === undefined ? Number.parseInt(dec ?? "", 10) : Number.parseInt(hex, 16);
    const valid = Number.isInteger(cp) && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
    return valid ? String.fromCodePoint(cp) : m;
  });
}

/** TAB, LF, VT, FF and CR: whitespace in both forms, never deleted. */
function isLineSpace(cp: number): boolean {
  return cp >= 0x09 && cp <= 0x0d;
}

/** One round: NFKC, invisible/control characters replaced by `invisible`, one entity pass. */
function normaliseRound(s: string, invisible: string): string {
  let out = "";
  for (const ch of s.normalize("NFKC")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isLineSpace(cp)) out += " ";
    else out += isInvisibleOrControl(cp) ? invisible : ch;
  }
  return decodeEntitiesOnce(out);
}

/** The stable, collapsed, lower-cased form, or `undefined` when it does not settle (refused). */
function settle(text: string, invisible: string): string | undefined {
  let cur = text;
  for (let i = 0; i < BROADCAST_MAX_ROUNDS; i++) {
    const next = normaliseRound(cur, invisible);
    if (next === cur) return cur.replaceAll(/\s+/g, " ").toLowerCase();
    cur = next;
  }
  return undefined;
}

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
 * OR1: whether `text`, posted to `service`, carries a broadcast mention (see the table above).
 * Pure; `true` also when the text does not settle within {@link BROADCAST_MAX_ROUNDS} rounds.
 */
export function broadcastMentionIn(
  service: BroadcastService,
  text: string,
  opts: { readonly html: boolean },
): boolean {
  const forms: string[] = [];
  for (const invisible of ["", " "]) {
    const settled = settle(text, invisible);
    if (settled === undefined) return true;
    forms.push(settled);
    if (opts.html) forms.push(settled.replaceAll(/<[^>]*>/g, ""));
  }
  const rules = BROADCAST_RULES[service];
  return forms.some((f) => rules.some((re) => re.test(f)));
}

interface BroadcastScan {
  readonly service: BroadcastService;
  /** The input key holding the message or comment text. */
  readonly key: string;
  /** Whether the input marks the text as HTML. */
  readonly htmlWhen?: (input: Readonly<Record<string, unknown>>) => boolean;
}

const teamsHtml = (input: Readonly<Record<string, unknown>>): boolean =>
  input["contentType"] === "html";

/** The rows whose text the broadcast rule scans, and which field. */
const BROADCAST_SCANNED: Readonly<Record<string, BroadcastScan>> = {
  slack_message_post: { service: "slack", key: "text" },
  slack_message_post_dm: { service: "slack", key: "text" },
  teams_message_post: { service: "teams", key: "body", htmlWhen: teamsHtml },
  teams_message_post_chat: { service: "teams", key: "body", htmlWhen: teamsHtml },
  github_issue_comment_create: { service: "github", key: "body" },
  gitlab_issue_note_create: { service: "gitlab", key: "body" },
  gitlab_mr_note_create: { service: "gitlab", key: "body" },
};

/** OR1 for one row: its scanned field carries a broadcast mention (a non-string one is refused). */
function refusesBroadcast(toolId: string, input: Readonly<Record<string, unknown>>): boolean {
  const scan = ownLookup(BROADCAST_SCANNED, toolId);
  if (scan === undefined) return false;
  const text = Object.hasOwn(input, scan.key) ? input[scan.key] : undefined;
  if (typeof text !== "string") return true;
  return broadcastMentionIn(scan.service, text, { html: scan.htmlWhen?.(input) ?? false });
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
 * The ONE messaging-destination check both doors call (OR1 + OR2): the ChatOps channel first
 * (so a post to a ChatOps channel that also carries a mention reports the ChatOps reason), then
 * the broadcast mention. A fixed text that echoes nothing of the input, or `undefined`.
 */
export function messagingDestinationRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  ctx: { readonly chatops: ChatopsPolicy | undefined },
): string | undefined {
  const chatops = chatopsRefusal(toolId, input, ctx.chatops);
  if (chatops !== undefined) return chatops;
  return refusesBroadcast(toolId, input) ? BROADCAST_MENTION_REFUSAL : undefined;
}

/**
 * The fixed refusal for a MODEL write to `toolId` with `input`, or `undefined` to allow it: the
 * messaging check, then the knowledge-base check (model door only).
 */
export function modelWriteRefusal(
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  ctx: RefusalContext,
): string | undefined {
  const messaging = messagingDestinationRefusal(toolId, input, { chatops: ctx.chatops });
  if (messaging !== undefined) return messaging;
  if (ctx.kb === undefined) return undefined;
  if (refusesNotion(toolId, input, ctx.kb) || refusesConfluence(toolId, input, ctx.kb)) {
    return KNOWLEDGE_BASE_REFUSAL;
  }
  return undefined;
}
