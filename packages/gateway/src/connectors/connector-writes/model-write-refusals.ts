// packages/gateway/src/connectors/connector-writes/model-write-refusals.ts
// The door's destination refusals for the model's connector writes (Phase 9.7 B, rulings F3/F4):
// the model may not post to a channel Nimbus ChatOps listens on, and may not write to the Nimbus
// knowledge base (the tribal-capture destination; its own gate is the only writer, I25). Pure: the
// ChatOps bindings and the KB config are passed in, and nothing here reaches the network, so a
// destination that cannot be PROVEN distinct from a configured one is refused (fail closed).
//
// This module names only model-offerable write rows; the gate-confined post and KB tools stay
// named only inside their own gates (D17/D19).
import type { ChatopsPolicy } from "../../policy/types.ts";

export const CHATOPS_CHANNEL_REFUSAL =
  "the model cannot post to a channel Nimbus ChatOps listens on";
export const KNOWLEDGE_BASE_REFUSAL =
  "the model cannot write to the Nimbus knowledge base; use the capture flow";

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

/**
 * A destination as ChatOps would key it: trimmed, percent-decoded, one leading `#` removed, and
 * (for a Teams conversation) the `;messageid=…` suffix dropped. `undefined` when it does not
 * decode. Case is kept here so the id-shape tests below can tell an id from a name.
 */
function canonicalDestination(raw: string): string | undefined {
  let s = raw.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    return undefined;
  }
  s = s.trim();
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
function refusesChatopsPost(
  chatops: ChatopsPolicy,
  platform: Platform,
  rawDestination: unknown,
): boolean {
  const entries = chatopsEntries(chatops);
  const relevant = entries.filter((e) => {
    const p = platformOf(e);
    return p === undefined || p === platform;
  });
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

/** Notion ids compare lower-case without hyphens; a value CONTAINING the id (a URL) matches too. */
function canonicalNotionId(s: string): string {
  return s.trim().toLowerCase().replaceAll("-", "");
}

/** F4 (Notion): any KB-capable key naming the KB database (a non-string value is refused). */
function refusesNotion(
  toolId: string,
  input: Record<string, unknown>,
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

/** F4 (Confluence): a KB-capable key naming the KB parent page, compared as trimmed strings. */
function refusesConfluence(
  toolId: string,
  input: Record<string, unknown>,
  kb: TribalKbConfig,
): boolean {
  const keys = ownLookup(CONFLUENCE_KB_KEYS, toolId);
  const parent = kb.confluence?.parentPageId.trim();
  if (keys === undefined || parent === undefined || parent === "") return false;
  return keys.some((k) => {
    const v = input[k];
    if (v === undefined) return false;
    // A page create in the KB space under the KB parent is covered: the parent alone decides.
    return typeof v !== "string" || v.trim() === parent;
  });
}

export interface RefusalContext {
  /** The ChatOps bindings of the LIVE enforced policy; `undefined` means "cannot tell". */
  readonly chatops: ChatopsPolicy | undefined;
  readonly kb: TribalKbConfig | undefined;
}

/** The fixed refusal for a model write to `toolId` with `input`, or `undefined` to allow it. */
export function modelWriteRefusal(
  toolId: string,
  input: Record<string, unknown>,
  ctx: RefusalContext,
): string | undefined {
  const post = ownLookup(CHATOPS_POST_ROWS, toolId);
  if (post !== undefined) {
    // No readable policy: the ChatOps channels cannot be ruled out.
    if (ctx.chatops === undefined) return CHATOPS_CHANNEL_REFUSAL;
    return refusesChatopsPost(ctx.chatops, post.platform, input[post.key])
      ? CHATOPS_CHANNEL_REFUSAL
      : undefined;
  }
  if (ctx.kb === undefined) return undefined;
  if (refusesNotion(toolId, input, ctx.kb) || refusesConfluence(toolId, input, ctx.kb)) {
    return KNOWLEDGE_BASE_REFUSAL;
  }
  return undefined;
}
